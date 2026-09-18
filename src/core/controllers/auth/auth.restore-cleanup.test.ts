import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTE_SYNC_CURSOR_STORAGE_PREFIX } from '@/config/mute-sync';
import { AuthController } from '@/controllers/auth/auth';
import { withAuthFinalizationLock } from '@/controllers/auth/auth-finalization-lock';
import { db } from '@/database/franky/franky';
import { PUBLIC_CACHE_TABLES } from '@/database/franky/franky.helpers';
import {
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from '@/libs/crypto/messaging-keyring';
import * as vibeSessionAutoRestore from '@/libs/vibe-session/auto-restore';
import * as vibeSessionConfig from '@/libs/vibe-session/config';
import * as vibeSessionFragment from '@/libs/vibe-session/fragment';
import type { Pubky } from '@/models/models.types';
import { ROUTE_GUARD_RETURN_TO_STORAGE_KEY } from '@/providers/RouteGuardProvider/RouteGuardProvider.returnPath';
import { MARKETPLACE_SESSION_STORAGE_KEY } from '@/services/marketplace/marketplace-session';
import { MESSAGING_SESSION_STORAGE_KEY } from '@/services/paykit/paykit-messaging';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useOnboardingStore } from '@/stores/onboarding/onboarding.store';
import { ONBOARDING_PERSIST_KEY } from '@/stores/persistedKeys';
import { mockSession } from '@/test-utils/pubky';

const BRIDGE_ORIGIN = 'https://pubky.app';
const PERSISTED_PUBKY = '5a1diz4pghi47ywdfyfzpit5f3bdomzt4pugpbmq4rngdd4iub4y' as Pubky;

const EXPECTED_PUBLIC_CACHE_TABLES = [
  'user_counts',
  'user_details',
  'user_ttl',
  'post_counts',
  'post_details',
  'post_relationships',
  'post_ttl',
  'file_details',
  'tag_streams',
  'commerce_shops',
  'commerce_listings',
  'commerce_catalog_entries',
  'commerce_listing_projections',
] as const;

const EXPECTED_PRIVATE_TABLES = [
  'user_relationships',
  'user_tags',
  'user_connections',
  'notifications',
  'post_tags',
  'post_streams',
  'unread_post_streams',
  'user_streams',
  'bookmarks',
  'commerce_listing_drafts',
  'commerce_sync_jobs',
  'commerce_reviews',
  'commerce_review_responses',
  'commerce_favorites',
  'commerce_shop_follows',
  'commerce_cart_items',
  'commerce_locks_correlations',
  'commerce_watch_snapshots',
  'commerce_watch_tombstones',
  'commerce_watch_alerts',
  'commerce_saved_searches',
  'commerce_activity_checkpoints',
  'commerce_delivery_addresses',
  'commerce_shipping_presets',
  'commerce_messaging_receivers',
  'commerce_messaging_links',
  'commerce_messaging_conversations',
  'commerce_messaging_messages',
  'commerce_messaging_outbox',
  'marketplace_tags',
  'hot_tags',
  'feeds',
  'moderation',
] as const;

const sorted = (values: Iterable<string>) => [...values].sort();

async function seedEveryTable(): Promise<void> {
  for (const table of db.tables) {
    expect(table.schema.primKey.keyPath).toBe('id');
    await db.table<{ id: string }>(table.name).put({ id: `restore-cleanup:${table.name}` });
  }
}

async function expectTableCounts(tableNames: readonly string[], expectedCount: number): Promise<void> {
  await Promise.all(
    tableNames.map(async (tableName) => {
      expect(await db.table(tableName).count(), tableName).toBe(expectedCount);
    }),
  );
}

async function expectTableCountsAtLeast(tableNames: readonly string[], minCount: number): Promise<void> {
  await Promise.all(
    tableNames.map(async (tableName) => {
      expect(await db.table(tableName).count(), tableName).toBeGreaterThanOrEqual(minCount);
    }),
  );
}

const WRAPPING_PROBE_PLAINTEXT = 'restore-cleanup-wrapping-probe';

async function seedWrappingKeyProbe(): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await getOrCreateWrappingKey();
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    new TextEncoder().encode(WRAPPING_PROBE_PLAINTEXT),
  );
  return { iv, ciphertext };
}

async function expectWrappingKeyProbeSurvives({
  iv,
  ciphertext,
}: {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}) {
  // Reload from IndexedDB (drop the in-memory cache): if the keyring store was
  // deleted, a FRESH key is generated here and the decrypt fails closed.
  dropCachedWrappingKeyForTests();
  const reloadedKey = await getOrCreateWrappingKey();
  const roundTrip = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reloadedKey, ciphertext);
  expect(new TextDecoder().decode(roundTrip)).toBe(WRAPPING_PROBE_PLAINTEXT);
}

/**
 * A fake `navigator.locks` that actually queues exclusive requests — one
 * promise tail PER LOCK NAME, like the platform (nested requests on a
 * different name, e.g. the messaging keyring's own lock, must not deadlock).
 */
function installQueuingFakeLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn((...args: unknown[]) => {
    const name = args[0];
    const callback = args.find((arg): arg is () => Promise<unknown> => typeof arg === 'function');
    if (typeof name !== 'string' || !callback) {
      return Promise.reject(new Error('navigator.locks.request called without a name/callback'));
    }
    const run = (tails.get(name) ?? Promise.resolve()).then(() => callback());
    tails.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return request;
}

async function runRealBridgeTimeoutRestore(currentUserPubky: Pubky | null) {
  useAuthStore.setState({
    session: null,
    sessionExport: null,
    currentUserPubky,
    hasProfile: currentUserPubky ? true : null,
    hasHydrated: true,
    isRestoringSession: false,
    sessionRestoreDeferred: false,
  });

  vi.useFakeTimers();
  const restorePromise = AuthController.restorePersistedSession();
  vi.advanceTimersByTime(15_000);
  vi.useRealTimers();
  return await restorePromise;
}

describe('AuthController restore cleanup with the real bridge and database', () => {
  beforeEach(() => {
    AuthController.resetCleanupLocalStateGuard();
    useAuthStore.getState().reset();
    vi.spyOn(vibeSessionConfig, 'getVibeSessionBridgeOrigin').mockReturnValue(BRIDGE_ORIGIN);
    vi.spyOn(vibeSessionConfig, 'getVibeId').mockReturnValue('marketplace-grid-test');
    vi.spyOn(vibeSessionFragment, 'takeFragmentSessionExport').mockReturnValue(null);
    vi.spyOn(vibeSessionAutoRestore, 'isVibeSessionAutoRestoreSuppressed').mockReturnValue(false);
  });

  afterEach(async () => {
    vi.useRealTimers();
    useAuthStore.getState().reset();
    useOnboardingStore.getState().reset();
    await resetMessagingKeyringForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Reflect.deleteProperty(navigator, 'locks');
    vi.restoreAllMocks();
  });

  it('classifies all 46 stores and clears private data after a no-identity bridge timeout', async () => {
    const expectedTables = [...EXPECTED_PUBLIC_CACHE_TABLES, ...EXPECTED_PRIVATE_TABLES];
    expect(db.tables).toHaveLength(46);
    expect(sorted(db.tables.map((table) => table.name))).toEqual(sorted(expectedTables));
    expect(sorted(PUBLIC_CACHE_TABLES)).toEqual(sorted(EXPECTED_PUBLIC_CACHE_TABLES));
    await seedEveryTable();
    const createElementSpy = vi.spyOn(document, 'createElement');
    // Non-Dexie account residue the no-identity path must also clear: the live
    // marketplace bearer, the messaging session metadata, onboarding secrets,
    // a stored route-return path, and mute-sync stream cursors.
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, '{"token":"dead-bearer"}');
    window.localStorage.setItem(MESSAGING_SESSION_STORAGE_KEY, '{"pubky":"dead-messaging"}');
    useOnboardingStore.getState().setSecrets({ secretKey: 'dead-secret-key', mnemonic: 'dead mnemonic' });
    window.sessionStorage.setItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY, '/settings');
    window.sessionStorage.setItem(`${MUTE_SYNC_CURSOR_STORAGE_PREFIX}homeserver`, '42');
    expect(window.localStorage.getItem(ONBOARDING_PERSIST_KEY)).not.toBeNull();

    await expect(runRealBridgeTimeoutRestore(null)).resolves.toEqual({ status: 'signed-out' });

    expect(createElementSpy).toHaveBeenCalledWith('iframe');
    await expectTableCounts(EXPECTED_PRIVATE_TABLES, 0);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ONBOARDING_PERSIST_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(ROUTE_GUARD_RETURN_TO_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(`${MUTE_SYNC_CURSOR_STORAGE_PREFIX}homeserver`)).toBeNull();
  });

  it('still clears every store after a bridge timeout with persisted identity provenance', async () => {
    await seedEveryTable();

    await expect(runRealBridgeTimeoutRestore(PERSISTED_PUBKY)).resolves.toEqual({ status: 'signed-out' });

    await expectTableCounts([...EXPECTED_PUBLIC_CACHE_TABLES, ...EXPECTED_PRIVATE_TABLES], 0);
  });

  it('keeps private rows and the wrapping key when this tab signs in during the bridge window', async () => {
    await seedEveryTable();
    const probe = await seedWrappingKeyProbe();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: null,
      hasProfile: null,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    // setTimeout-only fakes: the bridge timeout is timer-driven, but the
    // fake-indexeddb event loop (setImmediate) must stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const restorePromise = AuthController.restorePersistedSession();
    // A QR sign-in completes on THIS tab while the bridge restore is still
    // waiting: the identity lands on the live store (and the persist blob)
    // before the bridge times out.
    useAuthStore.setState({ sessionExport: 'same-tab-session-export', currentUserPubky: PERSISTED_PUBKY });

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(restorePromise).resolves.toEqual({ status: 'signed-out' });

    await expectTableCounts(EXPECTED_PRIVATE_TABLES, 1);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    await expectWrappingKeyProbeSurvives(probe);
  });

  it('does not wipe a concurrent tab sign-in when the bridge times out (cross-tab serialization)', async () => {
    installQueuingFakeLocks();
    await seedEveryTable();

    useAuthStore.setState({
      session: null,
      sessionExport: null,
      currentUserPubky: null,
      hasProfile: null,
      hasHydrated: true,
      isRestoringSession: false,
      sessionRestoreDeferred: false,
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Tab B: a visitor with no identity; captures the empty snapshot and its
    // bridge restore starts waiting (15 s).
    const tabBRestore = AuthController.restorePersistedSession();

    // Tab A: acquires the finalization lock and signs in — identity +
    // a private row + the messaging wrapping key, the same writes the real
    // sign-in path persists under the lock.
    const probe = await withAuthFinalizationLock(async () => {
      useAuthStore.getState().init({
        session: mockSession({ export: () => 'tab-a-session-export' }),
        currentUserPubky: PERSISTED_PUBKY,
        hasProfile: true,
      });
      await db.table('bookmarks').put({ id: 'tab-a:bookmark' });
      return await seedWrappingKeyProbe();
    });

    // Tab B's bridge times out; B enters the lock, re-reads identity, and
    // must NOT clear tab A's rows or key.
    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(tabBRestore).resolves.toEqual({ status: 'signed-out' });

    expect(await db.table('bookmarks').get('tab-a:bookmark')).toBeDefined();
    await expectTableCountsAtLeast(EXPECTED_PRIVATE_TABLES, 1);
    await expectTableCounts(EXPECTED_PUBLIC_CACHE_TABLES, 1);
    await expectWrappingKeyProbeSurvives(probe);
  });
});
