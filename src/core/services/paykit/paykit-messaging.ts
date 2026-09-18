// Type-only imports are erased at compile time; the WASM module itself is only ever
// loaded through the dynamic import in loadPaykitWasm(), never at module scope, so this
// file stays safe to pull into server-rendered module graphs (same rule as the Locks SDK).
import type { EncryptedLinkHandle, LinkHandshakeHandle, PubkyClient, SessionHandle } from 'paykit-wasm';
import {
  buildChatMessage,
  decodeChatMessage,
  type MarketplaceChatMessage,
  PAYKIT_MESSAGING_CAPABILITY,
  PAYKIT_MESSAGING_RECEIVER_PATH,
} from '@/libs/commerce/messaging-contracts';
import { isAppError } from '@/libs/error/error';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import {
  buildDmConversationId,
  buildDmMessage,
  decodeDmMessage,
  type PubkyAppDmMessage,
} from '@/libs/messaging/dm-contracts';
import { getTestnet } from '@/libs/runtime-config/runtime-config';
import { LocalMessagingService } from '@/services/local/messaging/messaging';

type PaykitWasmModule = typeof import('paykit-wasm');

let wasmModulePromise: Promise<PaykitWasmModule> | null = null;
let moduleOverrideForTests: PaykitWasmModule | null = null;

/**
 * Loads and initializes the vendored paykit-wasm binding exactly once. The dynamic
 * import keeps the ~1.5 MB WASM binary out of every server-rendered and initial-client
 * module graph; it is only fetched when a messaging operation actually runs in the
 * browser. Mirrors the Locks SDK loading pattern (locks.ts).
 */
async function loadPaykitWasm(): Promise<PaykitWasmModule> {
  if (moduleOverrideForTests) return moduleOverrideForTests;
  wasmModulePromise ??= (async () => {
    const sdk = await import('paykit-wasm');
    await sdk.default();
    return sdk;
  })();
  try {
    return await wasmModulePromise;
  } catch (error) {
    // A failed WASM fetch/instantiation must stay retryable on the next call.
    wasmModulePromise = null;
    throw error;
  }
}

/**
 * Test seam: unit tests initialize the REAL vendored module from file bytes
 * (jsdom cannot fetch the .wasm asset) — or a purpose-built fake for
 * orchestration-logic tests — and inject it here. Never used in production.
 */
export function setPaykitWasmModuleForTests(wasmModule: PaykitWasmModule | null): void {
  moduleOverrideForTests = wasmModule;
  wasmModulePromise = null;
}

/** Marker facts for a counterparty who has enabled encrypted messaging. */
export type CounterpartyMessagingMarker = {
  receiverPath: string;
  noisePublicKey: string;
};

export type MessagingEnableFlow = {
  authorizationUrl: string;
  awaitEnabled: () => Promise<MessagingEnabledInfo>;
  cancel: () => void;
};

export type MessagingEnabledInfo = {
  pubky: string;
  receiverPath: string;
  noisePublicKey: string;
};

/**
 * The truthful conversation transport states, empirically grounded in the
 * binding's semantics:
 *
 * - `not-enrolled`: the counterparty has published no receiver marker — no
 *   handshake can even start, and the UI must say so, never fake delivery.
 * - `handshaking`: a Noise XX handshake is queued on the homeservers. XX
 *   needs BOTH parties: the initiator writes message 1 and then CANNOT send
 *   application messages until the counterparty's runtime reads it and
 *   answers (messages 2/3 alternate). So `role: 'initiator'` means "waiting
 *   for the counterparty to open their messages"; `role: 'responder'` means
 *   an inbound handshake is being answered and completion needs the
 *   initiator to come back online for the final round.
 * - `ready`: the link is established; sends/receives are live.
 */
export type MessagingLinkState =
  | { status: 'not-enrolled' }
  | { status: 'handshaking'; role: 'initiator' | 'responder' }
  | { status: 'ready' };

/** Probe-only result: `none` means no local state and no inbound handshake — nothing was started. */
export type MessagingProbeState = MessagingLinkState | { status: 'none' };

/**
 * One inbound message after kind routing, flattened to the persisted row's
 * vocabulary: `kind: 'listing'` came in as `marketplace.chat_message.v0` (its
 * own `conversation_id`/`listing_ref` from the envelope), `kind: 'dm'` came in
 * as `pubky_app.dm.v0` (conversation identity derived from the counterparty).
 */
export type ReceivedMessage = {
  kind: 'listing' | 'dm';
  event_id: string;
  conversation_id: string;
  listing_ref: string | null;
  sent_at: number;
  body: string;
  counterpartyPubky: string;
};

type ActiveSession = { handle: SessionHandle; pubky: string };
type ActiveHandshake = { handle: LinkHandshakeHandle; role: 'initiator' | 'responder' };

/**
 * `localStorage` key for the persisted messaging-session metadata. The
 * stored value is the binding's `exportSession()` string — base64 public
 * `SessionInfo` (pubky, capabilities), NO secrets. The actual credential is
 * the homeserver's HTTP-only session cookie, which the BROWSER holds and
 * attaches (`credentials: include`); this app can neither read nor persist
 * it. Storage contract mirrors the marketplace transaction session
 * (`marketplace-session.ts`): `localStorage` (survives tabs and restarts —
 * the cookie, which the browser shares across tabs, is the real credential),
 * account-scoped validation on restore, cleared on sign-out/account switch.
 * A restore the homeserver rejects falls through to cookie resume, and only
 * when that also fails does the UI surface the honest reconnect state.
 */
export const MESSAGING_SESSION_STORAGE_KEY = 'pubky.messaging.session.v1';

/**
 * End-to-end-encrypted messaging over Paykit Encrypted Links (vendored
 * paykit-wasm binding). One link per counterparty pair carries BOTH message
 * kinds — marketplace listing conversations (`marketplace.chat_message.v0`)
 * and general direct messages (`pubky_app.dm.v0`); the kind on the wire
 * decides which conversation an inbound message lands in.
 *
 * This service is deliberately independent of the commerce adapter mode: it
 * needs only a signed-in user, a browser environment for the WASM binding,
 * and the homeserver. Marketplace-contextual SURFACES gate themselves on the
 * commerce mode (the sandbox keeps its own labeled plaintext transport for
 * listing chat); general DMs never do.
 *
 * Key facts the rest of the app relies on:
 *
 * - The homeserver session normally comes from the app's OWN sign-in: the
 *   sign-in grant (`/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw`)
 *   already covers the Paykit tree, and the credential is the HTTP-only
 *   homeserver cookie the BROWSER holds from that sign-in. The binding's
 *   `resumeSessionFromCookie` rebuilds a session handle from that cookie
 *   with ZERO additional signer approvals ({@link restorePersistedSession}
 *   resume order: in-memory session → persisted `exportSession` metadata →
 *   cookie resume → only then the interactive flow). The Pubky identity
 *   secret never enters this runtime, and this code persists only
 *   secret-free session metadata to `localStorage`
 *   ({@link MESSAGING_SESSION_STORAGE_KEY}) so later loads take the fast
 *   path. The interactive Ring approval ({@link beginEnableFlow}) remains
 *   ONLY for legacy sessions whose sign-in predates the combined grant
 *   (cookie resume rejects with `SessionResumeScopeMissing`) or whose
 *   cookie the homeserver no longer accepts.
 * - Link crypto uses a receiver-scoped Noise key generated here and persisted
 *   in account-scoped IndexedDB (`commerce_messaging_receivers`); the secret
 *   and every link snapshot are encrypted at rest by `LocalMessagingService`
 *   (AES-GCM-256 under the non-extractable keyring key, AAD-bound to their
 *   table row — see `src/libs/crypto/`), so this service only ever handles
 *   them unwrapped in memory. The multi-device backup-key decision stays an
 *   open product decision: wrapped rows remain device-local.
 * - The binding rejects overlapping operations per link ("operation in
 *   flight"), so every public operation is serialized per counterparty.
 * - Received messages are persisted BEFORE the advanced link snapshot — the
 *   read checkpoint moves past returned messages, so the reversed order
 *   would lose them on a crash.
 */
export class PaykitMessagingService {
  private constructor() {}

  private static session: ActiveSession | null = null;
  private static restoreInFlight: { pubky: string; done: Promise<boolean> } | null = null;
  private static client: PubkyClient | null = null;
  private static links = new Map<string, EncryptedLinkHandle>();
  private static handshakes = new Map<string, ActiveHandshake>();
  private static queues = new Map<string, Promise<unknown>>();

  /**
   * Starts the interactive enable flow: a fresh `pubkyauth://` URL for the
   * `/pub/paykit/:rw` grant to show on the user's signer, and a lazy
   * `awaitEnabled` that — once approved — verifies the approving identity,
   * provisions (or reuses) the receiver Noise key, and publishes the receiver
   * marker that makes this user discoverable for encrypted messaging.
   *
   * This flow is the LAST resort in the resume order: it is only reached for
   * sign-ins that predate the combined grant (no `/pub/paykit/` scope in the
   * session cookie) or whose cookie the homeserver no longer accepts —
   * current sign-ins resume silently via {@link restorePersistedSession}.
   *
   * `cancel` detaches the flow: the binding exposes no abort for a pending
   * approval, so a later approval on a detached flow is dropped (its session
   * handle is freed unused).
   */
  static async beginEnableFlow(expectedPubky: string): Promise<MessagingEnableFlow> {
    const wasmModule = await loadPaykitWasm();
    const client = this.getClient(wasmModule);
    const flow = client.startAuthFlow(PAYKIT_MESSAGING_CAPABILITY);
    let detached = false;
    return {
      authorizationUrl: flow.authorizationUrl(),
      cancel: () => {
        detached = true;
      },
      awaitEnabled: async () => {
        const handle = (await flow.awaitApproval()) as SessionHandle;
        if (detached) {
          handle.free();
          throw Err.client(ClientErrorCode.BAD_REQUEST, 'The messaging enable flow was cancelled.', {
            service: ErrorService.Paykit,
            operation: 'awaitEnabled',
          });
        }
        const pubky = handle.pubky();
        if (pubky !== expectedPubky) {
          handle.free();
          throw Err.auth(
            AuthErrorCode.INVALID_TOKEN,
            'The signer approved with a different identity than the signed-in user.',
            { service: ErrorService.Paykit, operation: 'awaitEnabled' },
          );
        }
        const enabled = await this.provisionReceiver(wasmModule, handle, pubky);
        this.setSession({ handle, pubky });
        return enabled;
      },
    };
  }

  /** True while a Ring-approved messaging session for this pubky is held in memory. */
  static hasActiveSession(pubky: string): boolean {
    return this.session?.pubky === pubky;
  }

  /**
   * Attempts to silently resume the messaging session, in strict order:
   *
   * 1. in-memory session (already live in this tab),
   * 2. persisted `exportSession` metadata + the browser's HTTP-only cookie
   *    via the binding's `restoreSession` (revalidates against the
   *    homeserver),
   * 3. cookie-ONLY resume via the binding's `resumeSessionFromCookie` — the
   *    zero-approval path: the app's sign-in grant already covers
   *    `/pub/paykit/:rw`, so the sign-in cookie alone is sufficient. On
   *    success the session is persisted via `exportSession` exactly like
   *    the approval path, so subsequent loads take path 2.
   *
   * Only when ALL of these fail does the UI show the interactive enable
   * flow — which is now reachable ONLY by legacy sessions without the
   * paykit scope or cookies the homeserver rejects. Every successful resume
   * also ensures the receiver key + marker are provisioned, so messaging
   * surfaces go straight to ready after sign-in. Never throws for "no
   * session"; concurrent callers share one in-flight resume.
   */
  static async restorePersistedSession(expectedPubky: string): Promise<boolean> {
    if (this.hasActiveSession(expectedPubky)) {
      await this.ensureReceiverProvisioned(expectedPubky);
      return true;
    }
    if (this.restoreInFlight?.pubky === expectedPubky) return await this.restoreInFlight.done;
    const done = this.resumeSessionSilently(expectedPubky);
    this.restoreInFlight = { pubky: expectedPubky, done };
    try {
      return await done;
    } finally {
      this.restoreInFlight = null;
    }
  }

  /** Paths 2 and 3 of the resume order, plus receiver provisioning on success. */
  private static async resumeSessionSilently(expectedPubky: string): Promise<boolean> {
    const resumed =
      (await this.restoreSessionFromStorage(expectedPubky)) || (await this.resumeSessionFromCookie(expectedPubky));
    if (resumed) await this.ensureReceiverProvisioned(expectedPubky);
    return resumed;
  }

  /**
   * The zero-approval resume: rebuilds the session handle purely from the
   * browser's existing homeserver cookie (set by the app's sign-in, whose
   * grant covers `/pub/paykit/:rw`). The binding revalidates against the
   * homeserver and verifies both the identity and the paykit scope, so a
   * `true` here is a fully working messaging session with no signer
   * involvement. Typed failures are deliberate no-session outcomes:
   * `SessionResumeScopeMissing` means the sign-in predates the combined
   * grant (the ONLY population that still sees the enable dialog);
   * `SessionResumeUnauthorized` means the homeserver holds no valid session
   * behind the browser's cookies. Both fall through to the honest
   * reconnect/enable state.
   */
  private static async resumeSessionFromCookie(expectedPubky: string): Promise<boolean> {
    try {
      const wasmModule = await loadPaykitWasm();
      const client = this.getClient(wasmModule);
      const handle = (await client.resumeSessionFromCookie(expectedPubky)) as SessionHandle;
      if (handle.pubky() !== expectedPubky) {
        // Defensive: the binding already rejects this as SessionResumePubkyMismatch.
        closeQuietly(() => handle.free());
        return false;
      }
      // Persist like the approval path so subsequent loads take the
      // restoreSession fast path instead of re-running cookie resume.
      this.setSession({ handle, pubky: expectedPubky });
      Logger.info('Resumed the encrypted messaging session from the sign-in cookie (no signer approval)', {
        pubky: expectedPubky,
      });
      return true;
    } catch (error) {
      if (isErrorNamed(error, 'SessionResumeScopeMissing')) {
        Logger.info('The sign-in session predates the combined paykit grant; messaging needs a one-time approval', {
          pubky: expectedPubky,
        });
      } else {
        Logger.info('Could not resume the messaging session from the sign-in cookie', { error });
      }
      return false;
    }
  }

  /**
   * Ensures the resumed session is usable for RECEIVING, not just holding a
   * session: on the cookie-resume path there was never an enable flow, so
   * the receiver Noise key and the published marker may not exist yet. Runs
   * the same idempotent {@link provisionReceiver} the approval path runs; a
   * transient publish failure is logged and retried on the next status
   * poll (this method is on every resume path) instead of failing the
   * session.
   */
  private static async ensureReceiverProvisioned(pubky: string): Promise<void> {
    if (this.session?.pubky !== pubky) return;
    const receiver = await LocalMessagingService.getReceiver(pubky);
    if (receiver?.marker_published) return;
    try {
      const wasmModule = await loadPaykitWasm();
      await this.provisionReceiver(wasmModule, this.session.handle, pubky);
      Logger.info('Provisioned the messaging receiver automatically for the resumed session', { pubky });
    } catch (error) {
      Logger.warn('Could not provision the messaging receiver for the resumed session; will retry on the next poll', {
        error,
      });
    }
  }

  private static async restoreSessionFromStorage(expectedPubky: string): Promise<boolean> {
    const raw = this.readSessionStorage();
    if (raw === null) return false;
    let stored: { pubky?: unknown; exported?: unknown } | null;
    try {
      stored = JSON.parse(raw) as { pubky?: unknown; exported?: unknown };
    } catch {
      stored = null;
    }
    if (!stored || typeof stored.pubky !== 'string' || typeof stored.exported !== 'string') {
      this.removePersistedSession();
      return false;
    }
    if (stored.pubky !== expectedPubky) {
      // Another account's blob: drop it so it can never outlive its owner's tab session.
      this.removePersistedSession();
      return false;
    }
    try {
      const wasmModule = await loadPaykitWasm();
      const client = this.getClient(wasmModule);
      const handle = (await client.restoreSession(stored.exported)) as SessionHandle;
      if (handle.pubky() !== expectedPubky) {
        closeQuietly(() => handle.free());
        this.removePersistedSession();
        return false;
      }
      this.setSession({ handle, pubky: expectedPubky });
      Logger.info('Restored the encrypted messaging session after reload', { pubky: expectedPubky });
      return true;
    } catch (error) {
      // The homeserver rejected the cookie (expired/revoked) or the restore
      // failed in transit; either way the persisted metadata is useless now.
      // Cookie resume still runs next — a fresh sign-in may hold a new cookie.
      Logger.info('Could not restore the persisted messaging session from its exported metadata', { error });
      this.removePersistedSession();
      return false;
    }
  }

  /**
   * Live-test seam: runs the REAL receiver provisioning and marker publish
   * for a session obtained through the binding's dev/test signup helpers
   * (`signupWithSecret` against an ephemeral local testnet) instead of the
   * Ring approval. Everything downstream — markers, links, crypto,
   * persistence — is the production path; only the interactive signer leg is
   * swapped, exactly as the binding's own e2e does. Never called in
   * production code.
   */
  static async enableWithSessionForTests(handle: SessionHandle): Promise<MessagingEnabledInfo> {
    const wasmModule = await loadPaykitWasm();
    const pubky = handle.pubky();
    const enabled = await this.provisionReceiver(wasmModule, handle, pubky);
    this.setSession({ handle, pubky });
    return enabled;
  }

  /** Facts about local provisioning (no network): has a receiver key + published marker. */
  static async isReceiverProvisioned(pubky: string): Promise<boolean> {
    const receiver = await LocalMessagingService.getReceiver(pubky);
    return Boolean(receiver?.marker_published);
  }

  /**
   * Drops the in-memory session, the persisted session metadata, and every
   * live link/handshake handle. Sign-out and account-switch teardown.
   */
  static clearSession(): void {
    this.removePersistedSession();
    for (const link of this.links.values()) closeQuietly(() => void link.close());
    for (const handshake of this.handshakes.values()) closeQuietly(() => handshake.handle.free());
    this.links.clear();
    this.handshakes.clear();
    this.queues.clear();
    if (this.session) closeQuietly(() => this.session?.handle.free());
    this.session = null;
    // The client is stateless config; dropping it costs one lazy re-create
    // and keeps a test-injected module from leaking a stale client.
    this.client = null;
  }

  /**
   * Whether a counterparty can receive encrypted messages at all: they must
   * have published a receiver marker (i.e. enabled messaging themselves).
   * Public read — needs no session.
   */
  static async getCounterpartyMarker(counterpartyPubky: string): Promise<CounterpartyMessagingMarker | null> {
    const wasmModule = await loadPaykitWasm();
    const client = this.getClient(wasmModule);
    const marker = (await wasmModule.getReceiverMarker(client, counterpartyPubky, PAYKIT_MESSAGING_RECEIVER_PATH)) as
      | { receiverPath: string; noisePublicKey: string }
      | undefined;
    if (!marker) return null;
    return { receiverPath: marker.receiverPath, noisePublicKey: marker.noisePublicKey };
  }

  /**
   * Brings the Encrypted Link toward `counterpartyPubky` as far as one poll
   * step allows and reports the truthful state. Serialized per counterparty.
   */
  static async ensureLink(ownerPubky: string, counterpartyPubky: string): Promise<MessagingLinkState> {
    return await this.withQueue(counterpartyPubky, async () => {
      const state = await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true);
      // `allowInitiate` guarantees the probe-only 'none' branch is unreachable.
      return state as MessagingLinkState;
    });
  }

  /**
   * Advances existing state and answers queued inbound handshakes for one
   * counterparty WITHOUT ever initiating a new handshake — the inbox sync
   * path. The binding exposes no way to enumerate unknown inbound initiators,
   * so probing is limited to counterparties this account already knows
   * (existing conversations/links plus marketplace order/offer participants).
   */
  static async probeCounterparty(ownerPubky: string, counterpartyPubky: string): Promise<MessagingProbeState> {
    return await this.withQueue(counterpartyPubky, () => this.ensureLinkLocked(ownerPubky, counterpartyPubky, false));
  }

  /**
   * Sends one marketplace chat message over an established link. Enforces the
   * 1000-byte serialized ceiling before the crypto layer would reject it
   * anyway. On success the message row is persisted (direction `sent`) and
   * THEN the advanced link snapshot; a failure leaves no message row behind —
   * the UI keeps the draft and shows the real error.
   *
   * `eventId` is normally minted here; the outbox flush passes the queued
   * row's UUID instead, so a crash between a successful send and the row
   * delete replays idempotently (receivers and local history dedupe by
   * `event_id`) rather than double-delivering.
   */
  static async sendChatMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string; eventId?: string },
  ): Promise<MarketplaceChatMessage> {
    return await this.withQueue(counterpartyPubky, async () => {
      const link = await this.requireReadyLink(ownerPubky, counterpartyPubky, 'sendChatMessage');
      const { message, json } = buildChatMessage({
        eventId: input.eventId ?? crypto.randomUUID(),
        conversationId: input.conversationId,
        listingRef: input.listingRef,
        sentAt: Date.now(),
        body: input.body,
      });
      await link.sendPrivateApplicationMessageJson(json);
      await this.persistSentMessage(ownerPubky, counterpartyPubky, link, {
        kind: 'listing',
        eventId: message.event_id,
        conversationId: message.conversation_id,
        listingRef: message.listing_ref,
        sentAt: message.sent_at,
        body: message.body,
      });
      return message;
    });
  }

  /**
   * Sends one general direct message over the same established link the
   * marketplace kinds ride. The DM conversation identity IS the counterparty
   * pubky (`dm:{counterparty}`); same ceiling, same persistence ordering, and
   * a failed send leaves no row behind. `eventId` follows the same outbox
   * contract as {@link sendChatMessage}.
   */
  static async sendDmMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { body: string; eventId?: string },
  ): Promise<PubkyAppDmMessage> {
    return await this.withQueue(counterpartyPubky, async () => {
      const link = await this.requireReadyLink(ownerPubky, counterpartyPubky, 'sendDmMessage');
      const { message, json } = buildDmMessage({
        eventId: input.eventId ?? crypto.randomUUID(),
        sentAt: Date.now(),
        body: input.body,
      });
      await link.sendPrivateApplicationMessageJson(json);
      await this.persistSentMessage(ownerPubky, counterpartyPubky, link, {
        kind: 'dm',
        eventId: message.event_id,
        conversationId: buildDmConversationId(counterpartyPubky),
        listingRef: null,
        sentAt: message.sent_at,
        body: message.body,
      });
      return message;
    });
  }

  /**
   * Receives pending inbound messages on an established link and routes them
   * by kind: `marketplace.chat_message.v0` lands in its envelope's listing
   * conversation, `pubky_app.dm.v0` lands in the counterparty's DM
   * conversation. BOTH kinds are always persisted in one drain — the
   * binding's read checkpoint advances past everything returned, so a kind
   * skipped here would be lost. Unknown kinds are skipped (legal on a shared
   * link). Message rows and conversation rows are persisted BEFORE the
   * advanced snapshot.
   */
  static async receiveMessages(ownerPubky: string, counterpartyPubky: string): Promise<ReceivedMessage[]> {
    return await this.withQueue(counterpartyPubky, async () => {
      const link = this.links.get(this.linkKey(ownerPubky, counterpartyPubky));
      if (!link) return [];
      const inbound = (await link.receivePrivateApplicationMessages()) as { rawJson: string }[];
      const received: ReceivedMessage[] = [];
      const now = Date.now();
      for (const item of inbound) {
        const routed = this.routeInboundMessage(item.rawJson, counterpartyPubky);
        if (!routed) continue;
        await LocalMessagingService.upsertMessage(routed.event_id, {
          owner_id: ownerPubky,
          conversation_id: routed.conversation_id,
          listing_ref: routed.listing_ref,
          counterparty_pubky: counterpartyPubky,
          direction: 'received',
          body: routed.body,
          sent_at: routed.sent_at,
          recorded_at: now,
        });
        await LocalMessagingService.touchConversation({
          owner_id: ownerPubky,
          conversation_id: routed.conversation_id,
          kind: routed.kind,
          listing_ref: routed.listing_ref,
          counterparty_pubky: counterpartyPubky,
          last_message_at: now,
          updated_at: now,
        });
        received.push(routed);
      }
      if (inbound.length > 0) {
        await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, link);
      }
      return received;
    });
  }

  /** Decodes one inbound payload into its conversation routing, or `null` for unknown kinds. */
  private static routeInboundMessage(rawJson: string, counterpartyPubky: string): ReceivedMessage | null {
    const chat = decodeChatMessage(rawJson);
    if (chat) {
      return {
        kind: 'listing',
        event_id: chat.event_id,
        conversation_id: chat.conversation_id,
        listing_ref: chat.listing_ref,
        sent_at: chat.sent_at,
        body: chat.body,
        counterpartyPubky,
      };
    }
    const dm = decodeDmMessage(rawJson);
    if (dm) {
      return {
        kind: 'dm',
        event_id: dm.event_id,
        conversation_id: buildDmConversationId(counterpartyPubky),
        listing_ref: null,
        sent_at: dm.sent_at,
        body: dm.body,
        counterpartyPubky,
      };
    }
    return null;
  }

  /** Advances the link if needed and returns the ready handle, or throws the honest state. */
  private static async requireReadyLink(
    ownerPubky: string,
    counterpartyPubky: string,
    operation: string,
  ): Promise<EncryptedLinkHandle> {
    const state = await this.ensureLinkLocked(ownerPubky, counterpartyPubky, true);
    if (state.status !== 'ready') {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'The encrypted link is not established yet.', {
        service: ErrorService.Paykit,
        operation,
        context: { linkStatus: state.status },
      });
    }
    const link = this.links.get(this.linkKey(ownerPubky, counterpartyPubky));
    if (!link) {
      throw Err.server(ServerErrorCode.UNKNOWN_ERROR, 'The encrypted link handle is missing.', {
        service: ErrorService.Paykit,
        operation,
      });
    }
    return link;
  }

  /** Persists a sent message row + conversation touch, THEN the advanced snapshot. */
  private static async persistSentMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    link: EncryptedLinkHandle,
    sent: {
      kind: 'listing' | 'dm';
      eventId: string;
      conversationId: string;
      listingRef: string | null;
      sentAt: number;
      body: string;
    },
  ): Promise<void> {
    const now = Date.now();
    await LocalMessagingService.upsertMessage(sent.eventId, {
      owner_id: ownerPubky,
      conversation_id: sent.conversationId,
      listing_ref: sent.listingRef,
      counterparty_pubky: counterpartyPubky,
      direction: 'sent',
      body: sent.body,
      sent_at: sent.sentAt,
      recorded_at: now,
    });
    await LocalMessagingService.touchConversation({
      owner_id: ownerPubky,
      conversation_id: sent.conversationId,
      kind: sent.kind,
      listing_ref: sent.listingRef,
      counterparty_pubky: counterpartyPubky,
      last_message_at: now,
      updated_at: now,
    });
    await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, link);
  }

  // --- internals -----------------------------------------------------------

  private static async ensureLinkLocked(
    ownerPubky: string,
    counterpartyPubky: string,
    allowInitiate: boolean,
  ): Promise<MessagingProbeState> {
    const wasmModule = await loadPaykitWasm();
    const session = await this.requireSessionOrRestore(ownerPubky);
    const key = this.linkKey(ownerPubky, counterpartyPubky);

    if (this.links.has(key)) return { status: 'ready' };

    const active = this.handshakes.get(key);
    if (active) {
      return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, active);
    }

    const stored = await LocalMessagingService.getLink(ownerPubky, counterpartyPubky);
    const receiver = await this.requireReceiver(ownerPubky);

    if (stored?.status === 'established') {
      const link = (await wasmModule.restoreEncryptedLink(
        session.handle,
        receiver.noise_secret,
        counterpartyPubky,
        stored.local_receiver_path,
        stored.remote_receiver_path,
        this.getClient(wasmModule),
        stored.snapshot,
      )) as EncryptedLinkHandle;
      this.links.set(key, link);
      return { status: 'ready' };
    }

    if (stored?.status === 'handshaking') {
      // A counterparty that rotated its Noise key (reinstall, new device,
      // cleared site data) can never finish a handshake snapshot bound to the
      // old key — advance() would report `pending` forever. Detect the
      // rotation against the freshly published marker and discard the
      // unrecoverable state so discovery below starts over.
      const currentMarker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
      if (currentMarker && currentMarker.noisePublicKey !== stored.remote_noise_public_key) {
        Logger.warn('Counterparty rotated its messaging key mid-handshake; discarding the stale handshake state');
        await LocalMessagingService.deleteLink(ownerPubky, counterpartyPubky);
        await wasmModule.clearEncryptedLinkOutbox(
          session.handle,
          receiver.noise_secret,
          counterpartyPubky,
          stored.remote_noise_public_key,
          stored.local_receiver_path,
          stored.remote_receiver_path,
        );
        return await this.discoverAndStart(
          wasmModule,
          session,
          receiver,
          ownerPubky,
          counterpartyPubky,
          currentMarker,
          allowInitiate,
        );
      }
      try {
        const handle = (await wasmModule.restoreEncryptedLinkHandshake(
          session.handle,
          receiver.noise_secret,
          counterpartyPubky,
          stored.local_receiver_path,
          stored.remote_receiver_path,
          this.getClient(wasmModule),
          stored.snapshot,
        )) as LinkHandshakeHandle;
        const handshake: ActiveHandshake = { handle, role: stored.role };
        this.handshakes.set(key, handshake);
        return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, handshake);
      } catch (error) {
        // An unrecoverable mid-handshake snapshot must not wedge the pair
        // forever: drop the row and our stale outbox slots so the next poll
        // starts a fresh handshake (the documented recovery path).
        Logger.warn('Failed to restore a mid-handshake snapshot; clearing state for a fresh handshake', { error });
        await LocalMessagingService.deleteLink(ownerPubky, counterpartyPubky);
        await wasmModule.clearEncryptedLinkOutbox(
          session.handle,
          receiver.noise_secret,
          counterpartyPubky,
          stored.remote_noise_public_key,
          stored.local_receiver_path,
          stored.remote_receiver_path,
        );
        return { status: 'handshaking', role: stored.role };
      }
    }

    // No local state at all: discover the counterparty, prefer answering an
    // inbound handshake if one is queued, otherwise initiate our own.
    const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
    if (!marker) return allowInitiate ? { status: 'not-enrolled' } : { status: 'none' };

    return await this.discoverAndStart(
      wasmModule,
      session,
      receiver,
      ownerPubky,
      counterpartyPubky,
      marker,
      allowInitiate,
    );
  }

  /**
   * Fresh-start branch shared by first contact and post-rotation recovery:
   * answers a queued inbound handshake if one exists, otherwise initiates.
   */
  private static async discoverAndStart(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    receiver: { noise_secret: Uint8Array; receiver_path: string },
    ownerPubky: string,
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
    allowInitiate: boolean,
  ): Promise<MessagingProbeState> {
    const inbound = await this.probeInboundHandshake(wasmModule, session, receiver, counterpartyPubky, marker);
    if (inbound) {
      return await this.adoptHandshakeProgress(ownerPubky, counterpartyPubky, marker, receiver.receiver_path, inbound);
    }

    if (!allowInitiate) return { status: 'none' };

    const handle = wasmModule.initiateEncryptedLink(
      session.handle,
      receiver.noise_secret,
      counterpartyPubky,
      marker.noisePublicKey,
      receiver.receiver_path,
      marker.receiverPath,
      this.getClient(wasmModule),
    );
    const handshake: ActiveHandshake = { handle, role: 'initiator' };
    this.handshakes.set(this.linkKey(ownerPubky, counterpartyPubky), handshake);
    await LocalMessagingService.upsertLink({
      owner_id: ownerPubky,
      counterparty_pubky: counterpartyPubky,
      role: 'initiator',
      status: 'handshaking',
      local_receiver_path: receiver.receiver_path,
      remote_receiver_path: marker.receiverPath,
      remote_noise_public_key: marker.noisePublicKey,
      snapshot: handle.snapshot(),
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return await this.advanceHandshake(wasmModule, ownerPubky, counterpartyPubky, handshake);
  }

  /**
   * One handshake step. On `pending`, persists the advanced snapshot so a
   * reload resumes instead of restarting. On error the in-memory handshake is
   * consumed (paykit-lib ownership model); the persisted snapshot restores it
   * on the next poll. When our own initiated handshake stalls, the
   * lexicographically smaller pubky additionally probes for a CROSSED inbound
   * handshake (both sides initiated at once) and switches to answering it —
   * the deterministic tiebreak that keeps exactly one side switching.
   */
  private static async advanceHandshake(
    wasmModule: PaykitWasmModule,
    ownerPubky: string,
    counterpartyPubky: string,
    handshake: ActiveHandshake,
  ): Promise<MessagingLinkState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    let result: { status: string; link?: EncryptedLinkHandle };
    try {
      result = (await handshake.handle.advance()) as { status: string; link?: EncryptedLinkHandle };
    } catch (error) {
      this.handshakes.delete(key);
      Logger.warn('Encrypted link handshake step failed; will restore from the persisted snapshot', { error });
      return { status: 'handshaking', role: handshake.role };
    }

    if (result.status === 'complete' && result.link) {
      this.handshakes.delete(key);
      this.links.set(key, result.link);
      await this.persistLinkSnapshot(ownerPubky, counterpartyPubky, result.link);
      return { status: 'ready' };
    }

    await this.persistHandshakeSnapshot(ownerPubky, counterpartyPubky, handshake);

    if (handshake.role === 'initiator' && ownerPubky < counterpartyPubky) {
      const session = this.requireSession(ownerPubky);
      const receiver = await this.requireReceiver(ownerPubky);
      const marker = await this.getCounterpartyMarkerWith(wasmModule, counterpartyPubky);
      if (marker) {
        const inbound = await this.probeInboundHandshake(wasmModule, session, receiver, counterpartyPubky, marker);
        if (inbound) {
          closeQuietly(() => handshake.handle.free());
          this.handshakes.delete(key);
          return await this.adoptHandshakeProgress(
            ownerPubky,
            counterpartyPubky,
            marker,
            receiver.receiver_path,
            inbound,
          );
        }
      }
    }

    return { status: 'handshaking', role: handshake.role };
  }

  /**
   * Answers a possibly-queued inbound handshake: creates responder state and
   * advances once. The binding reports `pending` both for "nothing inbound"
   * and "read message 1, wrote message 2", so progress is detected by
   * comparing snapshots — identical bytes mean nothing was read and the
   * probe state is discarded.
   */
  private static async probeInboundHandshake(
    wasmModule: PaykitWasmModule,
    session: ActiveSession,
    receiver: { noise_secret: Uint8Array; receiver_path: string },
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
  ): Promise<{ handshake?: ActiveHandshake; link?: EncryptedLinkHandle } | null> {
    const handle = wasmModule.acceptEncryptedLink(
      session.handle,
      receiver.noise_secret,
      counterpartyPubky,
      marker.noisePublicKey,
      receiver.receiver_path,
      marker.receiverPath,
      this.getClient(wasmModule),
    );
    const before = handle.snapshot();
    let result: { status: string; link?: EncryptedLinkHandle };
    try {
      result = (await handle.advance()) as { status: string; link?: EncryptedLinkHandle };
    } catch {
      // A failed probe step is not an inbound handshake; the consumed probe
      // state was never persisted, so there is nothing to recover.
      return null;
    }
    if (result.status === 'complete' && result.link) {
      return { link: result.link };
    }
    const after = handle.snapshot();
    if (bytesEqual(before, after)) {
      closeQuietly(() => handle.free());
      return null;
    }
    return { handshake: { handle, role: 'responder' } };
  }

  /** Persists whichever stage the adopted inbound handshake reached. */
  private static async adoptHandshakeProgress(
    ownerPubky: string,
    counterpartyPubky: string,
    marker: CounterpartyMessagingMarker,
    localReceiverPath: string,
    inbound: { handshake?: ActiveHandshake; link?: EncryptedLinkHandle },
  ): Promise<MessagingLinkState> {
    const key = this.linkKey(ownerPubky, counterpartyPubky);
    const now = Date.now();
    if (inbound.link) {
      this.links.set(key, inbound.link);
      await LocalMessagingService.upsertLink({
        owner_id: ownerPubky,
        counterparty_pubky: counterpartyPubky,
        role: 'responder',
        status: 'established',
        local_receiver_path: localReceiverPath,
        remote_receiver_path: marker.receiverPath,
        remote_noise_public_key: marker.noisePublicKey,
        snapshot: inbound.link.snapshot(),
        created_at: now,
        updated_at: now,
      });
      return { status: 'ready' };
    }
    if (inbound.handshake) {
      this.handshakes.set(key, inbound.handshake);
      await LocalMessagingService.upsertLink({
        owner_id: ownerPubky,
        counterparty_pubky: counterpartyPubky,
        role: 'responder',
        status: 'handshaking',
        local_receiver_path: localReceiverPath,
        remote_receiver_path: marker.receiverPath,
        remote_noise_public_key: marker.noisePublicKey,
        snapshot: inbound.handshake.handle.snapshot(),
        created_at: now,
        updated_at: now,
      });
      return { status: 'handshaking', role: 'responder' };
    }
    return { status: 'handshaking', role: 'responder' };
  }

  private static async persistLinkSnapshot(
    ownerPubky: string,
    counterpartyPubky: string,
    link: EncryptedLinkHandle,
  ): Promise<void> {
    await LocalMessagingService.updateLinkSnapshot(
      ownerPubky,
      counterpartyPubky,
      link.snapshot(),
      'established',
      Date.now(),
    );
  }

  private static async persistHandshakeSnapshot(
    ownerPubky: string,
    counterpartyPubky: string,
    handshake: ActiveHandshake,
  ): Promise<void> {
    await LocalMessagingService.updateLinkSnapshot(
      ownerPubky,
      counterpartyPubky,
      handshake.handle.snapshot(),
      'handshaking',
      Date.now(),
    );
  }

  private static async provisionReceiver(
    wasmModule: PaykitWasmModule,
    session: SessionHandle,
    pubky: string,
  ): Promise<MessagingEnabledInfo> {
    const now = Date.now();
    let receiver = await LocalMessagingService.getReceiver(pubky);
    if (!receiver) {
      const noiseSecret = wasmModule.generateNoiseSecretKey();
      receiver = {
        id: pubky,
        noise_secret: noiseSecret,
        noise_public_key: wasmModule.noisePublicKeyFromSecret(noiseSecret),
        receiver_path: PAYKIT_MESSAGING_RECEIVER_PATH,
        marker_published: false,
        created_at: now,
        updated_at: now,
      };
      await LocalMessagingService.upsertReceiver(receiver);
    }
    // Republishing is idempotent and heals a marker removed elsewhere. A
    // messaging-only receiver advertises exactly the Encrypted Link
    // capability (`privatePayments`) and none of the payment capabilities.
    await wasmModule.publishReceiverMarker(
      session,
      receiver.receiver_path,
      receiver.noise_public_key,
      true,
      false,
      false,
      false,
    );
    await LocalMessagingService.upsertReceiver({ ...receiver, marker_published: true, updated_at: Date.now() });
    return { pubky, receiverPath: receiver.receiver_path, noisePublicKey: receiver.noise_public_key };
  }

  private static async getCounterpartyMarkerWith(
    wasmModule: PaykitWasmModule,
    counterpartyPubky: string,
  ): Promise<CounterpartyMessagingMarker | null> {
    const marker = (await wasmModule.getReceiverMarker(
      this.getClient(wasmModule),
      counterpartyPubky,
      PAYKIT_MESSAGING_RECEIVER_PATH,
    )) as { receiverPath: string; noisePublicKey: string } | undefined;
    return marker ? { receiverPath: marker.receiverPath, noisePublicKey: marker.noisePublicKey } : null;
  }

  private static requireSession(ownerPubky: string): ActiveSession {
    if (!this.session || this.session.pubky !== ownerPubky) {
      throw Err.auth(AuthErrorCode.SESSION_EXPIRED, 'No active messaging session. Reconnect with your signer.', {
        service: ErrorService.Paykit,
        operation: 'requireSession',
      });
    }
    return this.session;
  }

  /** Like {@link requireSession}, but first tries the silent reload restore. */
  private static async requireSessionOrRestore(ownerPubky: string): Promise<ActiveSession> {
    if (!this.hasActiveSession(ownerPubky)) {
      await this.restorePersistedSession(ownerPubky);
    }
    return this.requireSession(ownerPubky);
  }

  private static async requireReceiver(ownerPubky: string) {
    const receiver = await LocalMessagingService.getReceiver(ownerPubky);
    if (!receiver) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Messaging is not provisioned on this device.', {
        service: ErrorService.Paykit,
        operation: 'requireReceiver',
      });
    }
    return receiver;
  }

  private static setSession(session: ActiveSession): void {
    if (this.session && this.session.pubky !== session.pubky) this.clearSession();
    else if (this.session) closeQuietly(() => this.session?.handle.free());
    this.session = session;
    this.writePersistedSession(session);
  }

  // localStorage access is wrapped because browsers can refuse it; a
  // session that cannot persist is still a working in-memory session, so
  // persistence failures only log (same posture as the marketplace session).
  private static writePersistedSession(session: ActiveSession): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        MESSAGING_SESSION_STORAGE_KEY,
        JSON.stringify({ pubky: session.pubky, exported: session.handle.exportSession() }),
      );
    } catch {
      Logger.warn('Could not persist the messaging session metadata; reconnect will be needed after a reload.');
    }
  }

  private static removePersistedSession(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(MESSAGING_SESSION_STORAGE_KEY);
    } catch {
      // Removal failing means storage is unavailable, so nothing persisted either.
    }
  }

  private static readSessionStorage(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private static getClient(wasmModule: PaykitWasmModule): PubkyClient {
    this.client ??= getTestnet() ? wasmModule.PubkyClient.testnet() : new wasmModule.PubkyClient();
    return this.client;
  }

  /**
   * Serializes operations per counterparty: the binding rejects overlapping
   * operations on one link, and interleaved persistence would break the
   * messages-before-snapshot ordering.
   */
  private static async withQueue<T>(counterpartyPubky: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(counterpartyPubky) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(
      counterpartyPubky,
      next.catch(() => undefined),
    );
    return await next;
  }

  private static linkKey(ownerPubky: string, counterpartyPubky: string): string {
    return `${ownerPubky}:${counterpartyPubky}`;
  }
}

/**
 * The binding's typed rejections carry a stable machine-readable code in
 * `Error.name` (`SessionResumeUnauthorized` / `SessionResumePubkyMismatch` /
 * `SessionResumeScopeMissing`); everything else is untyped and treated as
 * transient.
 */
function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function closeQuietly(dispose: () => void): void {
  try {
    dispose();
  } catch (error) {
    if (isAppError(error)) throw error;
    // wasm handles throw if already consumed/freed; that is fine on teardown.
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
