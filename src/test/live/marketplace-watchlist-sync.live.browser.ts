// LIVE cross-device PRIVATE watchlist sync proof against the REAL staging
// homeserver. One identity (A) acts as two devices in sequence — sign-up on
// "device 1", a wiped IndexedDB plus a fresh sign-in simulating "device 2"
// and later "device 3" — while a SECOND identity (B) proves the privacy
// boundary: reads and listings of A's `/priv/` watchlist document are refused
// by the homeserver (the decision memo's probe pattern, re-run through the
// app's own service layer). Nothing is mocked: real `@synonymdev/pubky` WASM
// client, real public pkarr relays, real staging reads/writes, real
// IndexedDB, and the real production sync path
// (`CommerceController.syncWatchlist` → merge → `/priv` PUT).
//
// Signup-helper identities hold root `/:rw` capabilities, so `/priv` access
// is granted; the legacy-session (`needs_reauth`) half of the behavior is
// covered by unit tests because a machine cannot honestly approve a
// narrow-scope Pubky Ring flow.
//
// The staging homeserver requires SINGLE-USE signup tokens; see
// vitest.watchlist.staging.config.ts for how to pass them and how to re-run
// with saved identity secrets if tokens were already consumed.

import { Keypair } from '@synonymdev/pubky';
import { beforeAll, describe, expect, it } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { db } from '@/database/franky/franky';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

// Injected by vitest.watchlist.staging.config.ts `define` at build time.
declare const __STAGING_SIGNUP_TOKEN_A__: string;
declare const __STAGING_SIGNUP_TOKEN_B__: string;
declare const __STAGING_SECRET_A__: string;
declare const __STAGING_SECRET_B__: string;

const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const PUBLIC_PKARR_RELAY = 'https://pkarr.pubky.app';

function randomIdentitySecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface StagingIdentity {
  pubky: string;
  secret: Uint8Array;
}

/**
 * Signs up with a single-use staging token via the app's own signup path, or
 * — when a saved identity secret is provided — signs back in instead. The
 * resulting session is installed into the app's auth store, exactly where the
 * real app keeps it, so the sync path resolves the owned `/priv` session the
 * way production code does. Secrets are logged because these are throwaway
 * staging test identities and a failed partial run must stay recoverable.
 */
async function signInAs(label: string, savedSecretHex: string, signupToken: string): Promise<StagingIdentity> {
  const secret = savedSecretHex ? hexToBytes(savedSecretHex) : randomIdentitySecret();
  const keypair = Keypair.fromSecret(secret);
  const pubky = keypair.publicKey.z32();

  if (savedSecretHex) {
    const result = await HomeserverService.signIn({ keypair });
    if (!result) throw new Error(`Sign-in for ${label} requested a retry after republish; re-run the suite.`);
    useAuthStore.getState().setCurrentUserPubky(pubky);
    useAuthStore.getState().setSession(result.session);
    console.info(`[watchlist-live] ${label}: signed back in as ${pubky}`);
    return { pubky, secret };
  }

  if (!signupToken) {
    throw new Error(
      `Missing credentials for ${label}: pass MARKETPLACE_STAGING_SIGNUP_TOKEN_${label} (single-use signup token) ` +
        `or MARKETPLACE_STAGING_SECRET_${label} (identity secret hex from a previous run).`,
    );
  }

  console.info(`[watchlist-live] ${label}: identity secret (save for re-runs): ${bytesToHex(secret)}`);
  const { session } = await HomeserverService.signUp({ keypair, signupToken });
  useAuthStore.getState().setCurrentUserPubky(pubky);
  useAuthStore.getState().setSession(session);
  console.info(`[watchlist-live] ${label}: signed up as ${pubky}`);
  return { pubky, secret };
}

/** Wipes the shared IndexedDB and detaches the session — a fresh device. */
async function becomeFreshDevice(): Promise<void> {
  await db.delete();
  await db.open();
  useAuthStore.getState().setSession(null);
  useAuthStore.getState().setCurrentUserPubky(null);
  useCommerceStore.getState().reset();
}

/** Signs back in as the same identity from an empty device and pulls the watchlist. */
async function signBackInAndSync(label: string, identity: StagingIdentity): Promise<void> {
  await becomeFreshDevice();
  const keypair = Keypair.fromSecret(identity.secret);
  const result = await HomeserverService.signIn({ keypair });
  if (!result) throw new Error(`${label}: sign-in requested a retry after republish; re-run the suite.`);
  useAuthStore.getState().setCurrentUserPubky(identity.pubky);
  useAuthStore.getState().setSession(result.session);
  await CommerceController.syncWatchlist();
  expect(useCommerceStore.getState().watchlistSyncStatus).toBe('synced');
}

type ProbeOutcome = { refused: false; leaked: unknown } | { refused: true; error: unknown };

/**
 * Asserts a probe was REFUSED as an authentication/authorization denial and
 * returns the verbatim refusal for the proof log. A 401 surfaces through the
 * app's error layer as an auth-category `SESSION_EXPIRED` AppError (no
 * numeric status in context); a 403 keeps `context.statusCode`. Both count —
 * anything else (success above all) is a privacy violation and fails loudly.
 */
function expectRefusal(label: string, outcome: ProbeOutcome): string {
  if (!outcome.refused) {
    throw new Error(`PRIVACY VIOLATION: ${label} succeeded for another identity: ${JSON.stringify(outcome.leaked)}`);
  }
  const error = outcome.error as {
    category?: string;
    code?: string;
    message?: string;
    context?: { statusCode?: number };
  };
  const statusCode = error?.context?.statusCode;
  const isAuthRefusal = error?.category === 'auth' || statusCode === 401 || statusCode === 403;
  if (!isAuthRefusal) throw outcome.error;
  return `category=${error.category} code=${error.code} statusCode=${statusCode ?? 'n/a'} message=${error.message}`;
}

describe('marketplace cross-device PRIVATE watchlist sync — live proof on STAGING (public network)', () => {
  beforeAll(async () => {
    const response = await fetch(`${PUBLIC_PKARR_RELAY}/${STAGING_HOMESERVER_PUBKY}`);
    if (!response.ok) {
      throw new Error(
        `The public pkarr relay ${PUBLIC_PKARR_RELAY} did not serve the staging homeserver record ` +
          `(status ${response.status}). This live proof needs the public staging network to be reachable.`,
      );
    }
  });

  it('syncs watches and unwatches across devices of one identity, and refuses another identity at the wire', async () => {
    // ── Device 1 of identity A ─────────────────────────────────────────────
    const owner = await signInAs('A', __STAGING_SECRET_A__, __STAGING_SIGNUP_TOKEN_A__);
    const watchlistUrl = CommerceRecordNormalizer.watchlistUri(owner.pubky);

    // Signup sessions carry root capabilities, so the session-fact gate must
    // report `capable` — the same detection the UI banner keys off.
    const session = useAuthStore.getState().selectSession();
    console.info(`[watchlist-live] A device 1: session capabilities: ${JSON.stringify(session?.info?.capabilities)}`);
    expect(CommerceApplication.getWatchlistSyncCapability()).toBe('capable');

    // Watch a listing through the real toggle path. The listing key only has
    // to be a valid spec key (52-char z-base-32 seller + entity id); the
    // watchlist document never dereferences it.
    const seller = Keypair.fromSecret(randomIdentitySecret()).publicKey.z32();
    const compositeListingId = `${seller}:watch_proof_boots_01`;
    await CommerceController.commitCreateFavorite(compositeListingId);
    await CommerceController.syncWatchlist();
    expect(useCommerceStore.getState().watchlistSyncStatus).toBe('synced');

    // The private document is REALLY on the staging homeserver: raw owned read.
    const rawAfterWatch = (await CommerceHomeserverService.fetchJson(watchlistUrl)) as {
      recordType: string;
      revision: number;
      items: Array<{ listingOwnerPubky: string; listingId: string }>;
      tombstones: unknown[];
    };
    expect(rawAfterWatch.recordType).toBe('watchlist');
    // Key-scoped assertions throughout: re-runs with a saved identity secret
    // legitimately find entries from earlier runs merged into the document.
    expect(rawAfterWatch.items).toContainEqual(
      expect.objectContaining({ listingOwnerPubky: seller, listingId: 'watch_proof_boots_01' }),
    );
    console.info(
      `[watchlist-live] A device 1: private document live at ${watchlistUrl} ` +
        `(revision ${rawAfterWatch.revision}, ${rawAfterWatch.items.length} item)`,
    );

    // ── Device 2 of identity A: empty cache, same identity ────────────────
    await signBackInAndSync('A device 2', owner);
    expect(await CommerceController.isFavorite(compositeListingId)).toBe(true);
    console.info('[watchlist-live] A device 2: pulled the watch from the private document into an empty device');

    // Unwatch on device 2 — the removal must become a mergeable tombstone.
    await CommerceController.commitDeleteFavorite(compositeListingId);
    await CommerceController.syncWatchlist();
    expect(useCommerceStore.getState().watchlistSyncStatus).toBe('synced');

    const rawAfterUnwatch = (await CommerceHomeserverService.fetchJson(watchlistUrl)) as {
      revision: number;
      items: Array<{ listingOwnerPubky: string; listingId: string }>;
      tombstones: Array<{ listingOwnerPubky: string; listingId: string }>;
    };
    expect(rawAfterUnwatch.items).not.toContainEqual(
      expect.objectContaining({ listingOwnerPubky: seller, listingId: 'watch_proof_boots_01' }),
    );
    expect(rawAfterUnwatch.tombstones).toContainEqual(
      expect.objectContaining({ listingOwnerPubky: seller, listingId: 'watch_proof_boots_01' }),
    );
    expect(rawAfterUnwatch.revision).toBeGreaterThan(rawAfterWatch.revision);
    console.info(`[watchlist-live] A device 2: unwatch pushed as tombstone (revision ${rawAfterUnwatch.revision})`);

    // ── Device 3 of identity A: the tombstone must win over nothing-local ──
    await signBackInAndSync('A device 3', owner);
    expect(await CommerceController.isFavorite(compositeListingId)).toBe(false);
    const tombstones = await LocalCommerceService.getWatchTombstones(owner.pubky);
    expect(tombstones).toContainEqual(expect.objectContaining({ listing_id: compositeListingId }));
    console.info('[watchlist-live] A device 3: unwatch propagated — item absent, tombstone present');

    // ── Privacy probe: identity B against A's private document ────────────
    // Invalidate A's session cookie server-side first, so the browser jar
    // cannot smuggle A's authentication into B's probe (the in-process
    // cookie-jar trap the decision memo documents).
    const deviceThreeSession = useAuthStore.getState().selectSession();
    if (deviceThreeSession) await HomeserverService.logout({ session: deviceThreeSession });
    await becomeFreshDevice();

    const stranger = await signInAs('B', __STAGING_SECRET_B__, __STAGING_SIGNUP_TOKEN_B__);
    expect(stranger.pubky).not.toBe(owner.pubky);

    const readOutcome: ProbeOutcome = await CommerceHomeserverService.fetchJson(watchlistUrl).then(
      (leaked) => ({ refused: false as const, leaked }),
      (error) => ({ refused: true as const, error }),
    );
    const readRefusal = expectRefusal("read of A's watchlist document", readOutcome);
    console.info(`[watchlist-live] B: READ refused — ${readRefusal}`);

    const listOutcome: ProbeOutcome = await HomeserverService.list({
      baseDirectory: `pubky://${owner.pubky}/priv/pubky.app/marketplace/v1/`,
    }).then(
      (leaked) => ({ refused: false as const, leaked }),
      (error) => ({ refused: true as const, error }),
    );
    const listRefusal = expectRefusal("listing of A's /priv directory", listOutcome);
    console.info(`[watchlist-live] B: LIST refused — ${listRefusal}`);
    expect(readOutcome.refused).toBe(true);
    expect(listOutcome.refused).toBe(true);
  });
});
