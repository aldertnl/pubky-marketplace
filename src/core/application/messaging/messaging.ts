import { buildChatMessage, type MarketplaceChatMessage } from '@/libs/commerce/messaging-contracts';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { getErrorMessage } from '@/libs/error/error.utils';
import {
  buildDmConversationId,
  buildDmMessage,
  parseDmConversationId,
  type PubkyAppDmMessage,
} from '@/libs/messaging/dm-contracts';
import type {
  CommerceMessagingConversationModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import {
  type MessagingEnableFlow,
  type MessagingLinkState,
  PaykitMessagingService,
  type ReceivedMessage,
} from '@/services/paykit/paykit-messaging';

export type MessagingStatus = {
  /**
   * A `/pub/paykit/:rw` homeserver session is live — resumed from the
   * sign-in cookie with zero approvals for current sign-ins, or from a Ring
   * approval for legacy sessions (restores across tabs/reloads).
   */
  sessionActive: boolean;
  /** A receiver Noise key exists on this device and its marker was published. */
  receiverProvisioned: boolean;
};

export type MessagingConversationSummary = CommerceMessagingConversationModelSchema & {
  lastMessage: CommerceMessagingMessageModelSchema | null;
  /**
   * The newest device-locally QUEUED (not yet sent) message for this
   * conversation, or `null`. Inbox previews use it to say "Queued: …" when
   * the newest item awaits delivery, instead of pretending it was sent.
   */
  lastQueued: CommerceMessagingOutboxModelSchema | null;
};

/**
 * The truthful result of a queue-aware send. `delivered: true` means the
 * binding actually sent the message over the ready link — exactly the old
 * direct-send path. `delivered: false` means NOTHING was sent: the message
 * was validated against the same byte ceiling as a live send and persisted
 * as a device-local outbox row that flushes automatically once the link is
 * ready. The UI must never render a queued row as sent.
 */
export type MessagingSendOutcome<TMessage> =
  | { delivered: true; message: TMessage }
  | { delivered: false; queued: CommerceMessagingOutboxModelSchema };

/** One bounded outbox flush pass: how many rows were actually sent, how many remain queued. */
export type MessagingOutboxFlushResult = {
  delivered: number;
  remaining: number;
};

/**
 * Application layer for end-to-end-encrypted messaging — marketplace listing
 * conversations AND general direct messages, over the same per-counterparty
 * Paykit Encrypted Links. Orchestrates the link service (network, crypto,
 * snapshot persistence) and the device-local history reads the UI renders
 * from. Message bodies never leave this layer toward logs, telemetry, or
 * projections. Deliberately independent of the commerce adapter mode —
 * marketplace-contextual surfaces gate themselves.
 */
export class MessagingApplication {
  private constructor() {}

  /**
   * Starts the interactive "enable encrypted messaging" flow: a Ring approval
   * for the `/pub/paykit/:rw` grant, then receiver provisioning and marker
   * publish. Last resort only: current sign-ins carry the combined grant and
   * resume with ZERO approvals via {@link getStatus} (cookie resume inside
   * `restorePersistedSession`); this flow is reached only by legacy sessions
   * without the paykit scope or cookies the homeserver rejects.
   */
  static async beginEnableFlow(ownerPubky: string): Promise<MessagingEnableFlow> {
    return await PaykitMessagingService.beginEnableFlow(ownerPubky);
  }

  static async getStatus(ownerPubky: string): Promise<MessagingStatus> {
    // Restore-before-report: the session resumes silently — persisted
    // metadata first, then purely from the sign-in cookie (the sign-in
    // grant covers /pub/paykit/:rw), each validated against the homeserver,
    // with receiver provisioning ensured on success — so surfaces never
    // show the enable/reconnect card while a valid session is actually
    // recoverable without a signer.
    return {
      sessionActive: await PaykitMessagingService.restorePersistedSession(ownerPubky),
      receiverProvisioned: await PaykitMessagingService.isReceiverProvisioned(ownerPubky),
    };
  }

  /** Sign-out teardown: drops the in-memory session and all live link handles. */
  static clearMessagingSession(): void {
    PaykitMessagingService.clearSession();
  }

  /** True when the counterparty has published a messaging receiver marker. */
  static async isCounterpartyEnrolled(counterpartyPubky: string): Promise<boolean> {
    return (await PaykitMessagingService.getCounterpartyMarker(counterpartyPubky)) !== null;
  }

  /**
   * Opens (or resumes) a marketplace listing conversation with a
   * counterparty: records the conversation row so inboxes list it even while
   * the handshake is queued, and drives the Encrypted Link one step forward.
   */
  static async openConversation(
    ownerPubky: string,
    counterpartyPubky: string,
    conversationId: string,
    listingRef: string,
  ): Promise<MessagingLinkState> {
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status !== 'not-enrolled') {
      await LocalMessagingService.touchConversation({
        owner_id: ownerPubky,
        conversation_id: conversationId,
        kind: 'listing',
        listing_ref: listingRef,
        counterparty_pubky: counterpartyPubky,
        last_message_at: null,
        updated_at: Date.now(),
      });
    }
    // Opening a conversation can be the first moment the link is READY on
    // this device (e.g. the counterparty answered while it was closed) —
    // deliver anything queued right away.
    if (state.status === 'ready') {
      await this.flushOutbox(ownerPubky, counterpartyPubky);
    }
    return state;
  }

  /**
   * Opens (or resumes) the general DM conversation with a counterparty. Same
   * link machinery as listing conversations; the conversation identity is the
   * counterparty pubky itself.
   */
  static async openDmConversation(ownerPubky: string, counterpartyPubky: string): Promise<MessagingLinkState> {
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status !== 'not-enrolled') {
      await LocalMessagingService.touchConversation({
        owner_id: ownerPubky,
        conversation_id: buildDmConversationId(counterpartyPubky),
        kind: 'dm',
        listing_ref: null,
        counterparty_pubky: counterpartyPubky,
        last_message_at: null,
        updated_at: Date.now(),
      });
    }
    // Same flush-on-open rule as listing conversations — the shared link
    // carries both kinds, so any queued row can deliver the moment it's ready.
    if (state.status === 'ready') {
      await this.flushOutbox(ownerPubky, counterpartyPubky);
    }
    return state;
  }

  /**
   * One bounded poll step for an open conversation with this counterparty:
   * advance the handshake if still queued, and — once the link is ready —
   * flush any device-locally queued messages (this poll is the moment the
   * link can have JUST become ready), then receive pending messages.
   * Kind-agnostic by construction — the shared link drains BOTH message
   * kinds and each is persisted into its own conversation. Callers own
   * scheduling (poll only while the surface is mounted and visible).
   */
  static async pollConversation(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<{ state: MessagingLinkState; received: ReceivedMessage[]; flushed: number }> {
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status !== 'ready') return { state, received: [], flushed: 0 };
    const { delivered } = await this.flushOutbox(ownerPubky, counterpartyPubky);
    const received = await PaykitMessagingService.receiveMessages(ownerPubky, counterpartyPubky);
    return { state, received, flushed: delivered };
  }

  static async sendMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string },
  ): Promise<MarketplaceChatMessage> {
    return await PaykitMessagingService.sendChatMessage(ownerPubky, counterpartyPubky, input);
  }

  static async sendDmMessage(ownerPubky: string, counterpartyPubky: string, body: string): Promise<PubkyAppDmMessage> {
    return await PaykitMessagingService.sendDmMessage(ownerPubky, counterpartyPubky, { body });
  }

  /**
   * Queue-aware send for a listing conversation. If the Encrypted Link is
   * ready, the message is sent directly — exactly like {@link sendMessage} —
   * and the result says `delivered: true`. Otherwise the body is validated
   * against the SAME serialized byte ceiling a live send enforces and
   * persisted as a device-local outbox row (`delivered: false`), which
   * flushes automatically the moment the link becomes ready. A message is
   * never reported sent unless the binding actually sent it.
   */
  static async sendOrQueueMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input: { conversationId: string; listingRef: string; body: string },
  ): Promise<MessagingSendOutcome<MarketplaceChatMessage>> {
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status === 'ready') {
      // Older queued rows must deliver FIRST or the thread order would lie.
      // If the flush stalls on a failure, this message queues behind them.
      const { remaining } = await this.flushOutbox(ownerPubky, counterpartyPubky);
      if (remaining === 0) {
        return { delivered: true, message: await this.sendMessage(ownerPubky, counterpartyPubky, input) };
      }
    }
    return {
      delivered: false,
      queued: await this.enqueueMessage(ownerPubky, counterpartyPubky, { ...input, kind: 'chat' }),
    };
  }

  /** Queue-aware DM send — same contract as {@link sendOrQueueMessage}. */
  static async sendOrQueueDmMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    body: string,
  ): Promise<MessagingSendOutcome<PubkyAppDmMessage>> {
    const state = await PaykitMessagingService.ensureLink(ownerPubky, counterpartyPubky);
    if (state.status === 'ready') {
      const { remaining } = await this.flushOutbox(ownerPubky, counterpartyPubky);
      if (remaining === 0) {
        return { delivered: true, message: await this.sendDmMessage(ownerPubky, counterpartyPubky, body) };
      }
    }
    return {
      delivered: false,
      queued: await this.enqueueMessage(ownerPubky, counterpartyPubky, {
        kind: 'dm',
        conversationId: null,
        listingRef: null,
        body,
      }),
    };
  }

  /**
   * Validates a message against the live-send byte ceiling and persists it
   * as an outbox row. The queue-time UUID doubles as the flush-time envelope
   * `event_id`, and the envelope's fixed-width fields (UUID, Unix-ms timestamp)
   * make this validation byte-exact for the eventual send — an oversized
   * body is rejected HERE with the same typed error a live send throws.
   */
  private static async enqueueMessage(
    ownerPubky: string,
    counterpartyPubky: string,
    input:
      | { kind: 'chat'; conversationId: string; listingRef: string; body: string }
      | {
          kind: 'dm';
          conversationId: null;
          listingRef: null;
          body: string;
        },
  ): Promise<CommerceMessagingOutboxModelSchema> {
    const id = crypto.randomUUID();
    const sentAtProbe = Date.now();
    const { message } =
      input.kind === 'chat'
        ? buildChatMessage({
            eventId: id,
            conversationId: input.conversationId,
            listingRef: input.listingRef,
            sentAt: sentAtProbe,
            body: input.body,
          })
        : buildDmMessage({ eventId: id, sentAt: sentAtProbe, body: input.body });
    // `queued_at` IS the flush order, so it must be strictly increasing per
    // (owner, counterparty) — two sends inside one millisecond would
    // otherwise tie and flush in arbitrary order.
    const existing = await LocalMessagingService.getQueuedMessages(ownerPubky, counterpartyPubky);
    const lastQueuedAt = existing.at(-1)?.queued_at ?? 0;
    const row: CommerceMessagingOutboxModelSchema = {
      id,
      owner_pubky: ownerPubky,
      counterparty_pubky: counterpartyPubky,
      kind: input.kind,
      conversation_id: input.conversationId,
      listing_ref: input.listingRef,
      // The trimmed body from the validated envelope — what a flush will send.
      body: message.body,
      queued_at: Math.max(Date.now(), lastQueuedAt + 1),
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
    };
    await LocalMessagingService.enqueueOutboxMessage(row);
    return row;
  }

  /** In-flight flush per `${owner}:${counterparty}`, so overlapping triggers share one pass and never double-send. */
  private static outboxFlushInFlight = new Map<string, Promise<MessagingOutboxFlushResult>>();

  /**
   * Delivers this counterparty's queued messages IN QUEUE ORDER over the
   * ready link, through the same real send methods a live send uses. Each
   * row is deleted only AFTER its send succeeded; the first failure records
   * `last_error`/`attempts` on the failing row and STOPS the pass, so order
   * is preserved and the next flush resumes from that row. Bounded (one pass
   * over the rows present at start) and reentrancy-safe (concurrent callers
   * share the in-flight pass).
   */
  static async flushOutbox(ownerPubky: string, counterpartyPubky: string): Promise<MessagingOutboxFlushResult> {
    const key = `${ownerPubky}:${counterpartyPubky}`;
    const inFlight = this.outboxFlushInFlight.get(key);
    if (inFlight) return await inFlight;
    const run = this.runOutboxFlush(ownerPubky, counterpartyPubky).finally(() => {
      this.outboxFlushInFlight.delete(key);
    });
    this.outboxFlushInFlight.set(key, run);
    return await run;
  }

  private static async runOutboxFlush(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<MessagingOutboxFlushResult> {
    const rows = await LocalMessagingService.getQueuedMessages(ownerPubky, counterpartyPubky);
    let delivered = 0;
    for (const row of rows) {
      try {
        if (row.kind === 'chat' && row.conversation_id !== null && row.listing_ref !== null) {
          await PaykitMessagingService.sendChatMessage(ownerPubky, counterpartyPubky, {
            conversationId: row.conversation_id,
            listingRef: row.listing_ref,
            body: row.body,
            eventId: row.id,
          });
        } else if (row.kind === 'dm') {
          await PaykitMessagingService.sendDmMessage(ownerPubky, counterpartyPubky, {
            body: row.body,
            eventId: row.id,
          });
        } else {
          // A chat row without its conversation references cannot be sent and
          // enqueueMessage never writes one; treat it as a failed attempt so
          // it stays visible (and cancellable) instead of vanishing silently.
          throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Queued message is missing its conversation.', {
            service: ErrorService.Local,
            operation: 'runOutboxFlush',
          });
        }
        await LocalMessagingService.deleteOutboxMessage(ownerPubky, row.id);
        delivered += 1;
      } catch (error) {
        await LocalMessagingService.recordOutboxFailure(ownerPubky, row.id, getErrorMessage(error), Date.now());
        return { delivered, remaining: rows.length - delivered };
      }
    }
    return { delivered, remaining: 0 };
  }

  /**
   * Deletes one queued message — possible only while it is still queued (a
   * row that already flushed no longer exists, so the delete is a no-op and
   * the message stays honestly sent).
   */
  static async cancelQueuedMessage(ownerPubky: string, id: string): Promise<void> {
    await LocalMessagingService.deleteOutboxMessage(ownerPubky, id);
  }

  /**
   * The device-locally queued (not yet sent) messages belonging to one
   * conversation, oldest first — what the conversation hooks merge after the
   * sent/received history.
   */
  static async getQueuedMessagesForConversation(
    ownerPubky: string,
    conversationId: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    const dm = parseDmConversationId(conversationId);
    if (dm) {
      const rows = await LocalMessagingService.getQueuedMessages(ownerPubky, dm.counterpartyPubky);
      return rows.filter((row) => row.kind === 'dm');
    }
    const rows = await LocalMessagingService.getQueuedMessagesByOwner(ownerPubky);
    return rows.filter((row) => row.kind === 'chat' && row.conversation_id === conversationId);
  }

  /** Moves the device-local read checkpoint of one conversation to now. */
  static async markConversationRead(ownerPubky: string, conversationId: string): Promise<void> {
    await LocalMessagingService.markConversationRead(ownerPubky, conversationId, Date.now());
  }

  /**
   * Honest device-local unread badge input: conversations with at least one
   * received-and-persisted message newer than the read checkpoint. Local
   * reads only — this never claims knowledge of undelivered mail.
   */
  static async getUnreadConversationCount(ownerPubky: string): Promise<number> {
    return await LocalMessagingService.countUnreadConversations(ownerPubky);
  }

  static async getConversationMessages(
    ownerPubky: string,
    conversationId: string,
  ): Promise<CommerceMessagingMessageModelSchema[]> {
    return await LocalMessagingService.getMessages(ownerPubky, conversationId);
  }

  static async getConversations(ownerPubky: string): Promise<MessagingConversationSummary[]> {
    const conversations = await LocalMessagingService.getConversationsByOwner(ownerPubky);
    const queued = await LocalMessagingService.getQueuedMessagesByOwner(ownerPubky);
    return await Promise.all(
      conversations.map(async (conversation) => {
        const messages = await LocalMessagingService.getMessages(ownerPubky, conversation.conversation_id);
        const queuedHere = queued.filter((row) =>
          row.kind === 'dm'
            ? buildDmConversationId(row.counterparty_pubky) === conversation.conversation_id
            : row.conversation_id === conversation.conversation_id,
        );
        return { ...conversation, lastMessage: messages.at(-1) ?? null, lastQueued: queuedHere.at(-1) ?? null };
      }),
    );
  }

  /**
   * Inbox sync: advances pending handshakes, answers queued inbound
   * handshakes, and receives messages for a bounded set of counterparties —
   * WITHOUT initiating anything. The binding cannot enumerate unknown inbound
   * initiators (no such API), so discovery is limited to counterparties this
   * account can NAME: existing conversations/links first (they always fit the
   * bound before new candidates), then the caller-supplied naming set —
   * marketplace order/offer participants plus the user's follows and
   * followers. A total stranger outside that set stays invisible until they
   * enter it; the UI discloses this instead of pretending otherwise.
   */
  static async syncCounterparties(ownerPubky: string, candidatePubkys: string[]): Promise<void> {
    // Insertion order is the probe priority: local messaging state (live or
    // pending conversations) must never be crowded out by fresh candidates.
    const known = new Set<string>();
    for (const link of await LocalMessagingService.getLinksByOwner(ownerPubky)) {
      known.add(link.counterparty_pubky);
    }
    for (const conversation of await LocalMessagingService.getConversationsByOwner(ownerPubky)) {
      known.add(conversation.counterparty_pubky);
    }
    for (const candidate of candidatePubkys) {
      known.add(candidate);
    }
    known.delete(ownerPubky);
    // Sequential on purpose: each probe is a couple of homeserver reads, and
    // parallel fan-out against one homeserver session buys nothing but load.
    for (const counterparty of [...known].slice(0, MESSAGING_SYNC_MAX_COUNTERPARTIES)) {
      const state = await PaykitMessagingService.probeCounterparty(ownerPubky, counterparty);
      if (state.status === 'ready') {
        // The probe may have JUST completed the handshake — deliver anything
        // queued toward this counterparty before draining inbound messages.
        await this.flushOutbox(ownerPubky, counterparty);
        await PaykitMessagingService.receiveMessages(ownerPubky, counterparty);
      }
    }
  }
}

/** Upper bound on counterparties probed per inbox sync pass. */
export const MESSAGING_SYNC_MAX_COUNTERPARTIES = 25;
