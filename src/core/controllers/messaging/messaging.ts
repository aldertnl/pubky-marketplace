import { z } from 'zod';
import { CommerceApplication } from '@/application/commerce/commerce';
import { MESSAGING_SYNC_MAX_COUNTERPARTIES, MessagingApplication } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { NEXUS_USER_IDS_MAX_LIMIT } from '@/config/nexus';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { parseDmConversationId } from '@/libs/messaging/dm-contracts';
import type { Pubky } from '@/models/models.types';
import { buildUserCompositeId } from '@/models/stream/user/userStream.helper';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';

/**
 * Controller for end-to-end-encrypted messaging: marketplace listing
 * conversations AND general direct messages over the same per-counterparty
 * Encrypted Links (the marketplace sandbox's plaintext transport stays on
 * `CommerceController`). Manages the messaging store — the application layer
 * never touches stores.
 */
export class MessagingController {
  private constructor() {}

  /**
   * Starts the "enable encrypted messaging" Ring flow. On approval the public
   * fact (the enabled pubky, never the session handle) mirrors into the
   * messaging store so dependent surfaces refetch. Flows are single-use;
   * retries must call this again.
   */
  static async beginMessagingEnable() {
    const ownerPubky = this.getCurrentUserPubky();
    const flow = await MessagingApplication.beginEnableFlow(ownerPubky);
    return {
      authorizationUrl: flow.authorizationUrl,
      awaitEnabled: async () => {
        const enabled = await flow.awaitEnabled();
        useMessagingStore.getState().setMessagingEnabled(enabled.pubky);
        return enabled;
      },
      cancel: flow.cancel,
    };
  }

  static async getMessagingStatus() {
    return await MessagingApplication.getStatus(this.getCurrentUserPubky());
  }

  /** Sign-out teardown: drops the session, link handles, and the store fact. */
  static clearMessagingSession(): void {
    MessagingApplication.clearMessagingSession();
    useMessagingStore.getState().clearMessagingEnabled();
  }

  static async isCounterpartyEnrolled(counterpartyPubky: unknown): Promise<boolean> {
    return await MessagingApplication.isCounterpartyEnrolled(CommerceRecordNormalizer.pubky(counterpartyPubky));
  }

  /**
   * Opens the encrypted conversation for a listing between the signed-in user
   * and a counterparty. The conversation id is the same aggregate reference
   * the sandbox transport uses (`conversation:{seller}_{buyer}_{listingId}`).
   */
  static async openConversation(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown) {
    const { ownerPubky, counterpartyPubky, conversationId, listingRef } = this.resolveConversation(
      sellerPubky,
      buyerPubky,
      listingId,
    );
    const state = await MessagingApplication.openConversation(
      ownerPubky,
      counterpartyPubky,
      conversationId,
      listingRef,
    );
    return { state, conversationId, counterpartyPubky };
  }

  static async pollConversation(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown) {
    const { ownerPubky, counterpartyPubky } = this.resolveConversation(sellerPubky, buyerPubky, listingId);
    return await MessagingApplication.pollConversation(ownerPubky, counterpartyPubky);
  }

  static async sendMessage(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown, body: string) {
    const { ownerPubky, counterpartyPubky, conversationId, listingRef } = this.resolveConversation(
      sellerPubky,
      buyerPubky,
      listingId,
    );
    return await MessagingApplication.sendMessage(ownerPubky, counterpartyPubky, {
      conversationId,
      listingRef,
      body,
    });
  }

  /**
   * Queue-aware listing-chat send: delivers directly when the link is ready,
   * otherwise queues the message device-locally (validated against the same
   * byte ceiling) for automatic delivery. The result distinguishes the two —
   * the UI never labels a queued message sent.
   */
  static async sendOrQueueMessage(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown, body: string) {
    const { ownerPubky, counterpartyPubky, conversationId, listingRef } = this.resolveConversation(
      sellerPubky,
      buyerPubky,
      listingId,
    );
    return await MessagingApplication.sendOrQueueMessage(ownerPubky, counterpartyPubky, {
      conversationId,
      listingRef,
      body,
    });
  }

  /** Opens (or resumes) the general DM conversation with a counterparty. */
  static async openDmConversation(counterpartyPubky: unknown) {
    const ownerPubky = this.getCurrentUserPubky();
    const counterparty = CommerceRecordNormalizer.pubky(counterpartyPubky);
    const state = await MessagingApplication.openDmConversation(ownerPubky, counterparty);
    return { state, counterpartyPubky: counterparty };
  }

  /** One poll step for the DM surface: advance handshake + receive on the shared link. */
  static async pollDmConversation(counterpartyPubky: unknown) {
    const ownerPubky = this.getCurrentUserPubky();
    return await MessagingApplication.pollConversation(ownerPubky, CommerceRecordNormalizer.pubky(counterpartyPubky));
  }

  static async sendDmMessage(counterpartyPubky: unknown, body: string) {
    const ownerPubky = this.getCurrentUserPubky();
    return await MessagingApplication.sendDmMessage(
      ownerPubky,
      CommerceRecordNormalizer.pubky(counterpartyPubky),
      body,
    );
  }

  /** Queue-aware DM send — same contract as {@link sendOrQueueMessage}. */
  static async sendOrQueueDmMessage(counterpartyPubky: unknown, body: string) {
    const ownerPubky = this.getCurrentUserPubky();
    return await MessagingApplication.sendOrQueueDmMessage(
      ownerPubky,
      CommerceRecordNormalizer.pubky(counterpartyPubky),
      body,
    );
  }

  static async getConversationMessages(conversationId: unknown) {
    return await MessagingApplication.getConversationMessages(
      this.getCurrentUserPubky(),
      this.normalizeConversationId(conversationId),
    );
  }

  /** Device-locally queued (not yet sent) messages of one conversation, oldest first. */
  static async getQueuedConversationMessages(conversationId: unknown) {
    return await MessagingApplication.getQueuedMessagesForConversation(
      this.getCurrentUserPubky(),
      this.normalizeConversationId(conversationId),
    );
  }

  /** Deletes one of the signed-in user's queued messages while it is still queued. */
  static async cancelQueuedMessage(id: unknown): Promise<void> {
    await MessagingApplication.cancelQueuedMessage(this.getCurrentUserPubky(), this.normalizeOutboxId(id));
  }

  static async getConversations() {
    return await MessagingApplication.getConversations(this.getCurrentUserPubky());
  }

  /**
   * Moves a conversation's device-local read checkpoint to now and refreshes
   * the unread fact in the store. Called by conversation surfaces while they
   * are actually showing messages.
   */
  static async markConversationRead(conversationId: unknown): Promise<void> {
    const ownerPubky = this.getCurrentUserPubky();
    await MessagingApplication.markConversationRead(ownerPubky, this.normalizeConversationId(conversationId));
    await this.refreshUnreadCount();
  }

  /**
   * Recomputes the device-local unread conversation count and mirrors it into
   * the messaging store (the header/footer badges subscribe there). Honest by
   * construction: only messages already persisted on this device count.
   */
  static async refreshUnreadCount(): Promise<number> {
    const ownerPubky = useAuthStore.getState().currentUserPubky;
    if (!ownerPubky) {
      useMessagingStore.getState().setUnreadConversations(0);
      return 0;
    }
    const count = await MessagingApplication.getUnreadConversationCount(ownerPubky);
    useMessagingStore.getState().setUnreadConversations(count);
    return count;
  }

  /**
   * One bounded inbox sync pass. The responder can only answer handshakes
   * from counterparties it can NAME (the binding cannot enumerate inbound
   * handshakes from strangers), so the naming set is assembled here:
   *
   * 1. Everyone with existing local messaging state (added inside the
   *    application layer, always first within the probe bound).
   * 2. Marketplace order/offer participants — only when a durable commerce
   *    mode is configured; general DMs never depend on the commerce adapter.
   * 3. The user's follows and followers (Nexus-fed user streams) — the v1
   *    answer to the stranger problem: someone in your graph can reach you,
   *    a total stranger's invitation stays invisible until they enter it.
   *
   * Any source failing to read degrades to the remaining sources instead of
   * failing the sync. Ends by refreshing the device-local unread fact.
   */
  static async syncInbox(): Promise<void> {
    const ownerPubky = this.getCurrentUserPubky();
    const candidates = new Set<string>();
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      for (const pubky of await this.getMarketplaceCounterpartyCandidates(ownerPubky)) {
        candidates.add(pubky);
      }
    }
    for (const pubky of await this.getFollowGraphCandidates(ownerPubky)) {
      candidates.add(pubky);
    }
    candidates.delete(ownerPubky);
    await MessagingApplication.syncCounterparties(ownerPubky, [...candidates]);
    await this.refreshUnreadCount();
  }

  /** Buyer/seller pubkys from the user's durable orders and offers; failures degrade to empty. */
  private static async getMarketplaceCounterpartyCandidates(ownerPubky: string): Promise<string[]> {
    const candidates = new Set<string>();
    const [orders, offers] = await Promise.allSettled([
      CommerceApplication.getMarketplaceOrders(ownerPubky),
      CommerceApplication.getMarketplaceOffers(ownerPubky),
    ]);
    if (orders.status === 'fulfilled') {
      for (const order of orders.value) {
        candidates.add(order.buyerPubky);
        candidates.add(order.sellerPubky);
      }
    } else {
      Logger.warn('Inbox sync could not read marketplace orders for counterparty candidates', {
        error: orders.reason,
      });
    }
    if (offers.status === 'fulfilled') {
      for (const offer of offers.value) {
        candidates.add(offer.buyerPubky);
        candidates.add(offer.sellerPubky);
      }
    } else {
      Logger.warn('Inbox sync could not read marketplace offers for counterparty candidates', {
        error: offers.reason,
      });
    }
    return [...candidates];
  }

  /**
   * The user's follows and followers from the app's existing Nexus-fed user
   * streams (cache-first, one bounded page each — the sync pass itself is
   * capped at {@link MESSAGING_SYNC_MAX_COUNTERPARTIES} probes, so deeper
   * pagination would buy nothing). Failures degrade to empty.
   */
  private static async getFollowGraphCandidates(ownerPubky: string): Promise<string[]> {
    const candidates = new Set<string>();
    const slices = await Promise.allSettled(
      (['following', 'followers'] as const).map((reach) =>
        UserStreamApplication.getOrFetchStreamSlice({
          streamId: buildUserCompositeId({ userId: ownerPubky as Pubky, reach }),
          skip: 0,
          // The user-ids stream rejects limits above its own cap (20 on the
          // deployed Nexus) with a 400, which silently degraded this whole
          // source to empty and made follower-initiated messages undiscoverable.
          limit: Math.min(MESSAGING_SYNC_MAX_COUNTERPARTIES, NEXUS_USER_IDS_MAX_LIMIT),
          viewerId: ownerPubky as Pubky,
          allowPartialCache: true,
        }),
      ),
    );
    slices.forEach((slice, index) => {
      if (slice.status === 'fulfilled') {
        for (const pubky of slice.value.nextPageIds) {
          candidates.add(pubky);
        }
      } else {
        Logger.warn('Inbox sync could not read the follow graph for counterparty candidates', {
          error: slice.reason,
          context: { reach: index === 0 ? 'following' : 'followers' },
        });
      }
    });
    return [...candidates];
  }

  /**
   * A conversation id is a LOCAL Dexie key, not a path-safe commerce entity
   * id (both shapes contain a colon): the marketplace aggregate
   * `conversation:{seller}_{buyer}_{listingId}` or the DM key
   * `dm:{counterpartyPubky}`. Anything else is rejected.
   */
  private static normalizeConversationId(input: unknown): string {
    if (typeof input === 'string' && (parseConversationAggregateId(input) || parseDmConversationId(input))) {
      return input;
    }
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid messaging conversation id.', {
      service: ErrorService.Local,
      operation: 'normalizeConversationId',
    });
  }

  /** Outbox row ids are queue-time UUIDs (see the outbox schema). */
  private static normalizeOutboxId(input: unknown): string {
    if (typeof input === 'string' && z.uuid().safeParse(input).success) return input;
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid queued message id.', {
      service: ErrorService.Local,
      operation: 'normalizeOutboxId',
    });
  }

  private static resolveConversation(sellerPubky: unknown, buyerPubky: unknown, listingId: unknown) {
    const seller = CommerceRecordNormalizer.pubky(sellerPubky);
    const buyer = CommerceRecordNormalizer.pubky(buyerPubky);
    const listing = CommerceRecordNormalizer.entityId(listingId);
    const ownerPubky = this.getCurrentUserPubky();
    const counterpartyPubky = ownerPubky === seller ? buyer : seller;
    return {
      ownerPubky,
      counterpartyPubky,
      conversationId: buildMarketplaceConversationAggregateId(seller, buyer, listing),
      listingRef: buildMarketplaceListingAggregateId(seller, listing),
    };
  }

  private static getCurrentUserPubky(): string {
    return useAuthStore.getState().selectCurrentUserPubky();
  }
}
