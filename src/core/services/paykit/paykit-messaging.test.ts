// Orchestration tests for PaykitMessagingService: session lifecycle, receiver
// provisioning + marker publish, the link-establishment state machine
// (initiate / inbound adoption / restore), send/receive persistence mapping
// and ordering, and size enforcement.
//
// The wasm binding is replaced here by a purpose-built fake injected through
// the service's test seam, so these tests exercise the SERVICE's logic (state
// transitions, persistence, argument mapping) — the cryptography itself is
// proven with the real compiled artifact in paykit-messaging.realcrypto.test.ts
// and scripts/paykit-wasm-smoke.mjs, and the homeserver flows by the binding's
// browser e2e at the pinned commit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { resetMessagingKeyringForTests } from '@/libs/crypto/messaging-keyring';
import { WRAP_IV_BYTES, WRAP_VERSION_AES_GCM_256 } from '@/libs/crypto/secret-wrapping';
import { CommerceMessagingLinkModel, CommerceMessagingMessageModel } from '@/models/messaging/messaging.models';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingReceiverModel,
} from '@/models/messaging/messaging.models';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { asOpaque } from '@/test-utils/type-assertions';
import { PaykitMessagingService, setPaykitWasmModuleForTests } from './paykit-messaging';

const OWNER = 'a'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(COUNTERPARTY, OWNER, LISTING_ID);
const LISTING_REF = buildMarketplaceListingAggregateId(COUNTERPARTY, LISTING_ID);

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/libs/runtime-config/runtime-config', async () => {
  const actual = await vi.importActual<typeof import('@/libs/runtime-config/runtime-config')>(
    '@/libs/runtime-config/runtime-config',
  );
  return { ...actual, getTestnet: () => true };
});

/**
 * In-memory stand-in for the wasm binding with recorded calls. Handshakes are
 * scripted per test through `world`:
 * - `world.markers` — who has published a receiver marker.
 * - `world.inboundFrom` — counterparties with a queued inbound handshake
 *   (an accept-probe makes progress: its snapshot changes on advance).
 * - `world.advanceScript` — outcomes for successive initiator advances.
 */
function createFakeWorld() {
  const world = {
    markers: new Map<string, { receiverPath: string; noisePublicKey: string }>(),
    inboundFrom: new Set<string>(),
    advanceScript: [] as ('pending' | 'complete')[],
    calls: [] as string[],
    lastPublishedMarker: null as null | { path: string; noisePublicKey: string; capabilities: boolean[] },
    links: [] as FakeLink[],
    nextApprovalPubky: OWNER,
    // Scripted `restoreSession` behavior: reject (cookie expired/revoked at
    // the homeserver) or resolve with the pubky embedded in the export blob.
    restoreRejects: false,
    restoredPubkyOverride: null as string | null,
    // Scripted `resumeSessionFromCookie` behavior. Default 'unauthorized':
    // the browser holds no homeserver cookie for the requested pubky (the
    // binding's SessionResumeUnauthorized), which mirrors the signed-out
    // baseline every pre-existing test assumes.
    cookieResume: 'unauthorized' as 'success' | 'unauthorized' | 'scope-missing',
    cookieResumePubkyOverride: null as string | null,
    // Scripted marker-publish failures (consumed one per publish attempt).
    publishMarkerFailures: 0,
  };

  let keyCounter = 0;

  class FakeSessionHandle {
    constructor(private readonly owner: string) {}
    pubky() {
      return this.owner;
    }
    // Mirrors the binding: secret-free metadata identifying the session owner.
    exportSession() {
      return `exported-session:${this.owner}`;
    }
    free() {}
  }

  class FakeLink {
    sent: string[] = [];
    inboundQueue: { version: number; kind: string; rawJson: string }[] = [];
    snapshotCounter = 0;
    constructor(public readonly counterparty: string) {
      world.links.push(this);
    }
    async sendPrivateApplicationMessageJson(rawJson: string) {
      if (new TextEncoder().encode(rawJson).byteLength > 1000) throw new Error('exceeds max Noise message size');
      this.sent.push(rawJson);
      world.calls.push('link.send');
    }
    async receivePrivateApplicationMessages() {
      world.calls.push('link.receive');
      const drained = [...this.inboundQueue];
      this.inboundQueue = [];
      return drained;
    }
    snapshot() {
      this.snapshotCounter += 1;
      return new Uint8Array([76, this.snapshotCounter]);
    }
    async close() {}
    free() {}
  }

  class FakeHandshake {
    private advanced = 0;
    constructor(
      private readonly role: 'initiator' | 'responder',
      private readonly counterparty: string,
    ) {}
    async advance() {
      world.calls.push(`handshake.advance:${this.role}`);
      if (this.role === 'responder') {
        // An accept-probe only progresses when an inbound handshake exists.
        if (!world.inboundFrom.has(this.counterparty)) return { status: 'pending' };
        this.advanced += 1;
        return { status: 'pending' };
      }
      const outcome = world.advanceScript.shift() ?? 'pending';
      if (outcome === 'complete') return { status: 'complete', link: new FakeLink(this.counterparty) };
      return { status: 'pending' };
    }
    snapshot() {
      // Progress must be visible in snapshot bytes (the service's probe
      // detector compares them).
      return new Uint8Array([72, this.role === 'initiator' ? 1 : 2, this.advanced]);
    }
    setMaxRecoveryAttempts() {}
    free() {}
  }

  class FakePubkyClient {
    static testnet() {
      return new FakePubkyClient();
    }
    startAuthFlow(capabilities: string) {
      world.calls.push(`startAuthFlow:${capabilities}`);
      return {
        authorizationUrl: () => `pubkyauth://signin?caps=${capabilities}&secret=fake`,
        awaitApproval: async () => new FakeSessionHandle(world.nextApprovalPubky),
      };
    }
    async restoreSession(exported: string) {
      world.calls.push('restoreSession');
      if (world.restoreRejects) throw new Error('session restore failed: RequestExpired');
      const owner = world.restoredPubkyOverride ?? exported.replace('exported-session:', '');
      return new FakeSessionHandle(owner);
    }
    // Mirrors the binding: typed rejections carry a stable Error.name.
    async resumeSessionFromCookie(pubky: string) {
      world.calls.push('resumeSessionFromCookie');
      if (world.cookieResume === 'unauthorized') {
        const error = new Error('cookie resume failed: no valid session behind the browser cookies');
        error.name = 'SessionResumeUnauthorized';
        throw error;
      }
      if (world.cookieResume === 'scope-missing') {
        const error = new Error('cookie resume failed: session scope does not grant /pub/paykit/ read+write');
        error.name = 'SessionResumeScopeMissing';
        throw error;
      }
      return new FakeSessionHandle(world.cookieResumePubkyOverride ?? pubky);
    }
  }

  const fakeModule = {
    PubkyClient: FakePubkyClient,
    generateNoiseSecretKey: () => {
      keyCounter += 1;
      return new Uint8Array(32).fill(keyCounter);
    },
    noisePublicKeyFromSecret: (secret: Uint8Array) => `${'n'.repeat(50)}${String(secret[0]).padStart(2, '0')}`,
    publishReceiverMarker: async (
      _session: unknown,
      path: string,
      noisePublicKey: string,
      ...capabilities: boolean[]
    ) => {
      world.calls.push('publishReceiverMarker');
      if (world.publishMarkerFailures > 0) {
        world.publishMarkerFailures -= 1;
        throw new Error('marker publish failed (scripted transient homeserver error)');
      }
      world.lastPublishedMarker = { path, noisePublicKey, capabilities };
    },
    getReceiverMarker: async (_client: unknown, ownerPubky: string) => {
      world.calls.push(`getReceiverMarker:${ownerPubky.slice(0, 4)}`);
      return world.markers.get(ownerPubky);
    },
    removeReceiverMarker: async () => {},
    initiateEncryptedLink: (...args: unknown[]) => {
      world.calls.push('initiateEncryptedLink');
      const counterparty = args[2] as string;
      return new FakeHandshake('initiator', counterparty);
    },
    acceptEncryptedLink: (...args: unknown[]) => {
      world.calls.push('acceptEncryptedLink');
      const counterparty = args[2] as string;
      return new FakeHandshake('responder', counterparty);
    },
    restoreEncryptedLink: async (...args: unknown[]) => {
      world.calls.push('restoreEncryptedLink');
      const counterparty = args[2] as string;
      return new FakeLink(counterparty);
    },
    restoreEncryptedLinkHandshake: async (...args: unknown[]) => {
      world.calls.push('restoreEncryptedLinkHandshake');
      const counterparty = args[2] as string;
      return new FakeHandshake('initiator', counterparty);
    },
    clearEncryptedLinkOutbox: async () => {
      world.calls.push('clearEncryptedLinkOutbox');
      return 0;
    },
    maxNoiseMessageLen: () => 1000,
    noiseTagLen: () => 16,
  };

  return { world, module: asOpaque<typeof import('paykit-wasm')>(fakeModule) };
}

async function enableMessaging(world: ReturnType<typeof createFakeWorld>['world']) {
  world.nextApprovalPubky = OWNER;
  const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
  return await flow.awaitEnabled();
}

describe('PaykitMessagingService', () => {
  let world: ReturnType<typeof createFakeWorld>['world'];

  beforeEach(async () => {
    const fake = createFakeWorld();
    world = fake.world;
    setPaykitWasmModuleForTests(fake.module);
    config.mode = 'transaction-service';
    PaykitMessagingService.clearSession();
    await Promise.all([
      CommerceMessagingReceiverModel.clear(),
      CommerceMessagingLinkModel.clear(),
      CommerceMessagingConversationModel.clear(),
      CommerceMessagingMessageModel.clear(),
    ]);
  });

  afterEach(() => {
    PaykitMessagingService.clearSession();
    setPaykitWasmModuleForTests(null);
    vi.restoreAllMocks();
  });

  describe('session lifecycle and receiver provisioning', () => {
    it('is independent of the commerce adapter mode (general DMs never gate on commerce)', async () => {
      config.mode = 'sandbox';
      const enabled = await enableMessaging(world);
      expect(enabled.pubky).toBe(OWNER);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('asks Ring for the paykit capability plus the app scope and publishes a messaging-only marker', async () => {
      const enabled = await enableMessaging(world);

      // Both scopes on purpose: the homeserver holds one session cookie per
      // user, so the messaging session must also carry the app's write scope
      // or approving it breaks every pubky.app write (see messaging-contracts).
      expect(world.calls).toContain('startAuthFlow:/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw');
      expect(enabled.pubky).toBe(OWNER);
      expect(enabled.receiverPath).toBe('marketplace/wallet');
      expect(world.lastPublishedMarker).toEqual({
        path: 'marketplace/wallet',
        noisePublicKey: enabled.noisePublicKey,
        // privatePayments (the Encrypted Link capability) only — never the payment capabilities.
        capabilities: [true, false, false, false],
      });
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);

      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect(receiver?.noise_secret).toHaveLength(32);
      expect(receiver?.marker_published).toBe(true);
    });

    it('rejects an approval from a different identity than the signed-in user', async () => {
      world.nextApprovalPubky = COUNTERPARTY;
      const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
      await expect(flow.awaitEnabled()).rejects.toThrow(/different identity/);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
    });

    it('drops a cancelled flow even if the signer approves later', async () => {
      const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
      flow.cancel();
      await expect(flow.awaitEnabled()).rejects.toThrow(/cancelled/);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
    });

    it('reuses the persisted receiver key on re-enable (fresh key would orphan every link)', async () => {
      await enableMessaging(world);
      const first = await LocalMessagingService.getReceiver(OWNER);
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const second = await LocalMessagingService.getReceiver(OWNER);
      expect(second?.noise_secret).toEqual(first?.noise_secret);
    });

    it('requires a session for link operations and clears it on teardown', async () => {
      await enableMessaging(world);
      PaykitMessagingService.clearSession();
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });
  });

  describe('link establishment state machine', () => {
    beforeEach(async () => {
      await enableMessaging(world);
    });

    it('reports not-enrolled when the counterparty has no marker, and starts nothing', async () => {
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'not-enrolled' });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
    });

    it('initiates toward an enrolled counterparty and persists the handshaking row', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('initiateEncryptedLink');
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row).toMatchObject({
        role: 'initiator',
        status: 'handshaking',
        remote_noise_public_key: 'p'.repeat(52),
        local_receiver_path: 'marketplace/wallet',
        remote_receiver_path: 'marketplace/wallet',
      });
    });

    it('completes the handshake on a later poll and flips the row to established', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      world.advanceScript.push('complete');
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'ready' });
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row?.status).toBe('established');
    });

    it('adopts a queued inbound handshake instead of initiating (responder role)', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.inboundFrom.add(COUNTERPARTY);

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'responder' });
      expect(world.calls).toContain('acceptEncryptedLink');
      expect(world.calls).not.toContain('initiateEncryptedLink');
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row?.role).toBe('responder');
    });

    it('probeCounterparty never initiates: no state plus no inbound stays none', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.probeCounterparty(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'none' });
      expect(world.calls).toContain('acceptEncryptedLink');
      expect(world.calls).not.toContain('initiateEncryptedLink');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
    });

    it('resumes a mid-handshake snapshot after a reload when the counterparty key is unchanged', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Simulate a reload mid-handshake: in-memory handles die, the Dexie row survives.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('restoreEncryptedLinkHandshake');
      expect(world.calls).not.toContain('clearEncryptedLinkOutbox');
    });

    it('discards a mid-handshake snapshot bound to a rotated counterparty key and starts over', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // The counterparty reinstalls and publishes a marker with a NEW key; the
      // persisted snapshot can never complete against it (advance() would
      // report pending forever).
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'q'.repeat(52) });
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).not.toContain('restoreEncryptedLinkHandshake');
      expect(world.calls).toContain('clearEncryptedLinkOutbox');
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row?.remote_noise_public_key).toBe('q'.repeat(52));
    });

    it('restores an established link from the persisted snapshot after a reload', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Simulate a reload: in-memory handles die, Dexie rows survive.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'ready' });
      expect(world.calls).toContain('restoreEncryptedLink');
    });
  });

  describe('send/receive mapping and persistence ordering', () => {
    beforeEach(async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
    });

    it('sends a valid envelope and persists the sent row plus a fresh snapshot', async () => {
      const message = await PaykitMessagingService.sendChatMessage(OWNER, COUNTERPARTY, {
        conversationId: CONVERSATION_ID,
        listingRef: LISTING_REF,
        body: 'Is this still available?',
      });

      const link = world.links.at(-1)!;
      expect(link.sent).toHaveLength(1);
      expect(JSON.parse(link.sent[0])).toMatchObject({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        body: 'Is this still available?',
      });
      expect(typeof JSON.parse(link.sent[0]).sent_at).toBe('number');

      const rows = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'sent',
        body: 'Is this still available?',
        id: `${OWNER}:${message.event_id}`,
      });

      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].counterparty_pubky).toBe(COUNTERPARTY);
    });

    it('rejects an oversize body before anything reaches the link, keeping no row', async () => {
      await expect(
        PaykitMessagingService.sendChatMessage(OWNER, COUNTERPARTY, {
          conversationId: CONVERSATION_ID,
          listingRef: LISTING_REF,
          body: 'a'.repeat(2000),
        }),
      ).rejects.toThrow(/too long/);
      expect(world.links.at(-1)!.sent).toHaveLength(0);
      await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toHaveLength(0);
    });

    it('persists received chat messages, skips foreign kinds, and dedupes replays by event id', async () => {
      const eventId = crypto.randomUUID();
      const rawJson = JSON.stringify({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        event_id: eventId,
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        sent_at: '2026-08-21T10:00:00.000Z',
        body: 'hello from the counterparty',
      });
      const foreign = JSON.stringify({ version: 1, kind: 'paykit.payment_request.v0', amount: 1 });
      const link = world.links.at(-1)!;
      link.inboundQueue.push(
        { version: 1, kind: 'marketplace.chat_message.v0', rawJson },
        { version: 1, kind: 'paykit.payment_request.v0', rawJson: foreign },
      );

      const received = await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY);
      expect(received).toHaveLength(1);
      expect(received[0].body).toBe('hello from the counterparty');
      expect(received[0].sent_at).toBe(Date.parse('2026-08-21T10:00:00.000Z'));

      // Replay the same event (expected after a snapshot restore): no duplicate.
      link.inboundQueue.push({ version: 1, kind: 'marketplace.chat_message.v0', rawJson });
      await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY);

      const rows = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ direction: 'received', id: `${OWNER}:${eventId}` });
    });

    it('persists received messages BEFORE the advanced link snapshot', async () => {
      const order: string[] = [];
      const upsertSpy = vi.spyOn(LocalMessagingService, 'upsertMessage');
      const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');
      upsertSpy.mockImplementation(async () => {
        order.push('message');
      });
      snapshotSpy.mockImplementation(async () => {
        order.push('snapshot');
      });

      world.links.at(-1)!.inboundQueue.push({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        rawJson: JSON.stringify({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          event_id: crypto.randomUUID(),
          conversation_id: CONVERSATION_ID,
          listing_ref: LISTING_REF,
          sent_at: '2026-08-21T10:00:00.000Z',
          body: 'ordering matters',
        }),
      });

      await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY);
      expect(order).toEqual(['message', 'snapshot']);
    });

    it('sends a DM with the pubky_app.dm.v0 kind into the counterparty-keyed conversation', async () => {
      const message = await PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'hi — direct' });

      const link = world.links.at(-1)!;
      expect(link.sent).toHaveLength(1);
      expect(JSON.parse(link.sent[0])).toMatchObject({
        version: 1,
        kind: 'pubky_app.dm.v0',
        body: 'hi — direct',
      });
      expect(typeof JSON.parse(link.sent[0]).sent_at).toBe('number');
      expect(JSON.parse(link.sent[0])).not.toHaveProperty('listing_ref');

      const rows = await LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'sent',
        listing_ref: null,
        id: `${OWNER}:${message.event_id}`,
      });
      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations.find((row) => row.conversation_id === `dm:${COUNTERPARTY}`)).toMatchObject({
        kind: 'dm',
        listing_ref: null,
      });
    });

    it('routes one inbound drain into BOTH conversations by kind (shared link)', async () => {
      const link = world.links.at(-1)!;
      const chatRaw = JSON.stringify({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        event_id: crypto.randomUUID(),
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        sent_at: '2026-08-21T10:00:00.000Z',
        body: 'about the listing',
      });
      const dmRaw = JSON.stringify({
        version: 1,
        kind: 'pubky_app.dm.v0',
        event_id: crypto.randomUUID(),
        sent_at: '2026-08-21T10:00:01.000Z',
        body: 'and a personal note',
      });
      link.inboundQueue.push(
        { version: 1, kind: 'marketplace.chat_message.v0', rawJson: chatRaw },
        { version: 1, kind: 'pubky_app.dm.v0', rawJson: dmRaw },
      );

      const received = await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY);

      expect(received.map((entry) => entry.kind)).toEqual(['listing', 'dm']);
      await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toHaveLength(1);
      await expect(LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`)).resolves.toHaveLength(1);
      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations.map((row) => row.kind).sort()).toEqual(['dm', 'listing']);
    });
  });

  describe('session persistence across reloads', () => {
    const storedValue = () => window.localStorage.getItem('pubky.messaging.session.v1');

    // A reload keeps localStorage and the browser cookie jar but wipes all
    // in-memory wasm state. clearSession() deliberately wipes BOTH, so the
    // simulation re-seeds storage after dropping memory.
    const simulateReload = () => {
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      if (persisted !== null) window.localStorage.setItem('pubky.messaging.session.v1', persisted);
    };

    it('persists secret-free session metadata on enable', async () => {
      await enableMessaging(world);
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
    });

    it('restores the session silently after a reload, and link operations work without re-enable', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      simulateReload();
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(world.calls).toContain('restoreSession');
      // The restored session drives link operations directly.
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
    });

    it('link operations self-restore after a reload without an explicit restore call', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      simulateReload();

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('drops another account\u2019s persisted blob without a restore attempt, then falls through to cookie resume', async () => {
      await enableMessaging(world);
      simulateReload();
      window.localStorage.setItem(
        'pubky.messaging.session.v1',
        JSON.stringify({ pubky: COUNTERPARTY, exported: `exported-session:${COUNTERPARTY}` }),
      );

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(storedValue()).toBeNull();
      // The foreign blob is never sent to the homeserver; the only network
      // attempt is the cookie resume for the CURRENT account (unauthorized here).
      expect(world.calls).not.toContain('restoreSession');
      expect(world.calls).toContain('resumeSessionFromCookie');
    });

    it('drops a malformed persisted blob', async () => {
      window.localStorage.setItem('pubky.messaging.session.v1', 'not json');
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('clears the blob and reports false when the homeserver rejects the restore (expired cookie)', async () => {
      await enableMessaging(world);
      simulateReload();
      world.restoreRejects = true;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
      // The surfaces now show the honest reconnect state.
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });

    it('rejects a restored session whose identity does not match the expected account', async () => {
      await enableMessaging(world);
      simulateReload();
      world.restoredPubkyOverride = COUNTERPARTY;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('sign-out clears BOTH the in-memory session and the persisted metadata', async () => {
      await enableMessaging(world);
      expect(storedValue()).not.toBeNull();
      PaykitMessagingService.clearSession();
      expect(storedValue()).toBeNull();
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
    });
  });

  describe('zero-approval cookie resume', () => {
    const storedValue = () => window.localStorage.getItem('pubky.messaging.session.v1');

    it('follows the resume order: an in-memory session short-circuits both restore paths', async () => {
      await enableMessaging(world);
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).not.toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('follows the resume order: a valid persisted restore wins and cookie resume is never attempted', async () => {
      await enableMessaging(world);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.cookieResume = 'success';
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('resumes purely from the sign-in cookie with ZERO signer approvals and provisions the receiver', async () => {
      // Fresh account state: no enable flow ever ran, no persisted blob, no
      // receiver key — exactly a first visit after signing in with the
      // combined grant.
      world.cookieResume = 'success';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(world.calls).toContain('resumeSessionFromCookie');
      expect(world.calls).not.toContain('startAuthFlow');
      // Persisted like the approval path, so the next load takes the
      // restoreSession fast path.
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
      // Receiver key + marker provisioned automatically on first use.
      expect(world.calls).toContain('publishReceiverMarker');
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect(receiver?.noise_secret).toHaveLength(32);
    });

    it('after a cookie resume, the next load restores from the persisted metadata without re-running cookie resume', async () => {
      world.cookieResume = 'success';
      await PaykitMessagingService.restorePersistedSession(OWNER);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('falls through to cookie resume when the persisted restore is rejected (expired metadata, fresh sign-in cookie)', async () => {
      await enableMessaging(world);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.restoreRejects = true;
      world.cookieResume = 'success';
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      const restoreIndex = world.calls.indexOf('restoreSession');
      const cookieIndex = world.calls.indexOf('resumeSessionFromCookie');
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      expect(cookieIndex).toBeGreaterThan(restoreIndex);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
    });

    it('reports the honest enable state for a legacy session without the paykit scope (SessionResumeScopeMissing)', async () => {
      world.cookieResume = 'scope-missing';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
      expect(world.calls).not.toContain('publishReceiverMarker');
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });

    it('reports no session when the homeserver holds nothing behind the cookies (SessionResumeUnauthorized)', async () => {
      world.cookieResume = 'unauthorized';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(world.calls).toContain('resumeSessionFromCookie');
    });

    it('rejects a cookie-resumed session whose identity does not match the expected account', async () => {
      world.cookieResume = 'success';
      world.cookieResumePubkyOverride = COUNTERPARTY;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(PaykitMessagingService.hasActiveSession(COUNTERPARTY)).toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('link operations self-resume from the cookie alone (messages ready straight after sign-in)', async () => {
      world.cookieResume = 'success';
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).not.toContain('startAuthFlow');
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('keeps the session when receiver provisioning fails transiently and retries on the next status poll', async () => {
      world.cookieResume = 'success';
      world.publishMarkerFailures = 1;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(false);

      // Next poll (the scripted failure is consumed): provisioning heals
      // without any signer involvement, reusing the already-generated key.
      const before = await LocalMessagingService.getReceiver(OWNER);
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);
      const after = await LocalMessagingService.getReceiver(OWNER);
      expect(after?.noise_secret).toEqual(before?.noise_secret);
    });
  });

  describe('at-rest wrapping of key material', () => {
    it('stores the receiver Noise secret WRAPPED — never plaintext — and unwraps it on read', async () => {
      const enabled = await enableMessaging(world);

      // The fake binding's first generated secret is deterministic (fill(1)).
      const raw = await CommerceMessagingReceiverModel.findById(OWNER);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(raw?.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
      expect([...(raw?.noise_secret ?? [])]).not.toEqual([...new Uint8Array(32).fill(1)]);

      // The service read unwraps transparently.
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect([...(receiver?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(1)]);
      expect(receiver?.noise_public_key).toBe(enabled.noisePublicKey);
    });

    it('stores link snapshots WRAPPED — never plaintext — and unwraps them on read', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // The fake handshake's initial snapshot is [72, 1, 0].
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect([...(raw?.snapshot ?? [])]).not.toEqual([72, 1, 0]);

      const link = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect([...(link?.snapshot ?? [])]).toEqual([72, 1, 0]);
    });

    it('treats the receiver as lost when the wrapping key is gone, and re-enable re-provisions it', async () => {
      await enableMessaging(world);
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.not.toBeNull();

      // The wrapping key is lost (profile wiped without the database): the
      // stored receiver ciphertext can never authenticate again.
      await resetMessagingKeyringForTests();
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toBeNull();
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(false);

      // The existing re-enable affordance: provisioning generates a FRESH
      // receiver secret (the fake's second key, fill(2)), stored wrapped under
      // the newly generated wrapping key, and republishes the marker.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect([...(receiver?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(2)]);
      expect(receiver?.marker_published).toBe(true);
      const raw = await CommerceMessagingReceiverModel.findById(OWNER);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(raw?.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
    });

    it('treats a tampered link snapshot as lost and starts a fresh handshake instead of restoring', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Tamper with the stored (wrapped) snapshot bytes directly at the model layer.
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      const tampered = new Uint8Array(raw!.snapshot);
      tampered[tampered.byteLength - 1] ^= 0xff;
      await CommerceMessagingLinkModel.upsert({ ...raw!, snapshot: tampered });

      // Reload: the link row reads as LOST, so discovery starts over instead
      // of feeding corrupt bytes to the binding.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('restoreEncryptedLink');
    });
  });
});
