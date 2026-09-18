import { CommerceApplication, type CommerceCheckoutFulfillmentInput } from '@/application/commerce/commerce';
import { TagKind } from '@/application/tag/tag.types';
import {
  COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS,
  getCommerceAdapterMode,
  isTransactionalCommerceMode,
} from '@/config/commerce';
import { IMAGE_MAX_UPLOAD_SIZE } from '@/config/images';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import type { ShipFromAddress, ShippingParcel } from '@/libs/commerce/shipping';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import type { CommerceIndexedReview, CommerceListingProjectionModelSchema } from '@/models/commerce/commerce.schema';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { MarketplaceNotificationNormalizer } from '@/pipes/marketplaceNotification/marketplaceNotification.normalizer';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';
import type { MarketplaceSessionEndedEvent, MarketplaceSessionInfo } from '@/services/marketplace/marketplace-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import type { CommerceConditionFilter, CommerceSaleFormatFilter, CommerceSort } from '@/stores/commerce/commerce.types';
import { useNotificationStore } from '@/stores/notification/notification.store';

export class CommerceController {
  private constructor() {}

  private static sessionEndedUnbind: (() => void) | null = null;

  /**
   * Subscribe once at app coordinator start. Every `clearSession` then nulls
   * the store — including gateway paths that never return through command
   * wrappers. Idempotent.
   */
  static bindMarketplaceSessionStore(): void {
    if (this.sessionEndedUnbind) return;
    this.sessionEndedUnbind = CommerceApplication.onMarketplaceSessionEnded((event) => {
      this.onMarketplaceSessionEnded(event);
    });
  }

  static unbindMarketplaceSessionStore(): void {
    this.sessionEndedUnbind?.();
    this.sessionEndedUnbind = null;
  }

  static async getShop(ownerPubky: unknown) {
    return await CommerceApplication.getShop(CommerceRecordNormalizer.pubky(ownerPubky));
  }

  static async getAllShops() {
    return await CommerceApplication.getAllShops();
  }

  static async fetchShop(ownerPubky: unknown) {
    return await CommerceApplication.fetchShop(CommerceRecordNormalizer.pubky(ownerPubky));
  }

  static async getOrFetchShop(ownerPubky: unknown) {
    return await CommerceApplication.getOrFetchShop(CommerceRecordNormalizer.pubky(ownerPubky));
  }

  static async getListing(ownerPubky: unknown, listingId: unknown) {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.getListing(`${owner}:${id}`);
  }

  static async fetchListing(ownerPubky: unknown, listingId: unknown) {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.fetchListing(owner, id);
  }

  static async getOrFetchListing(ownerPubky: unknown, listingId: unknown) {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.getOrFetchListing(owner, id);
  }

  static async getListingsBySeller(sellerPubky: unknown) {
    return await CommerceApplication.getListingsBySeller(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  static async getOrFetchListingsBySeller(sellerPubky: unknown) {
    return await CommerceApplication.getOrFetchListingsBySeller(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  static async refreshListingsBySeller(sellerPubky: unknown): Promise<void> {
    await CommerceApplication.refreshListingsBySeller(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  static async cacheMarketplaceListingProjection(projection: CommerceListingProjectionModelSchema): Promise<void> {
    await CommerceApplication.cacheMarketplaceListingProjection(projection);
  }

  /**
   * Reads locally cached community tags for a listing (viewer write-through included).
   */
  static async getListingTags(sellerPubky: unknown, listingId: unknown) {
    const seller = CommerceRecordNormalizer.pubky(sellerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.getMarketplaceTags(TagKind.LISTING, `${seller}:${id}`);
  }

  /**
   * Fetches community tags for a listing from the marketplace Nexus, merging
   * into the local cache. Returns [] without faking when the tag endpoint is
   * not deployed yet (404).
   */
  static async fetchListingTags(sellerPubky: unknown, listingId: unknown, viewerId?: string) {
    const seller = CommerceRecordNormalizer.pubky(sellerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.fetchMarketplaceTags({
      kind: TagKind.LISTING,
      taggedId: `${seller}:${id}`,
      viewerId,
    });
  }

  /** Reads locally cached community tags for a shop (viewer write-through included). */
  static async getShopTags(ownerPubky: unknown) {
    return await CommerceApplication.getMarketplaceTags(TagKind.SHOP, CommerceRecordNormalizer.pubky(ownerPubky));
  }

  /**
   * Fetches community tags for a shop from the marketplace Nexus, merging into
   * the local cache. Returns [] without faking when the tag endpoint is not
   * deployed yet (404).
   */
  static async fetchShopTags(ownerPubky: unknown, viewerId?: string) {
    return await CommerceApplication.fetchMarketplaceTags({
      kind: TagKind.SHOP,
      taggedId: CommerceRecordNormalizer.pubky(ownerPubky),
      viewerId,
    });
  }

  static async getListingsByCategory(categoryId: unknown) {
    return await CommerceApplication.getListingsByCategory(CommerceRecordNormalizer.entityId(categoryId));
  }

  static async getAllListings() {
    return await CommerceApplication.getAllListings();
  }

  static async getAllCatalogEntries() {
    return await CommerceApplication.getAllCatalogEntries();
  }

  static async getCatalogEntriesBySeller(sellerPubky: unknown) {
    return await CommerceApplication.getCatalogEntriesBySeller(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  /**
   * Refreshes the catalog cache from the Nexus marketplace index.
   *
   * Maps the catalog filter state onto what Nexus can evaluate server-side:
   * sale format (when not 'all'), condition (only when exactly one is
   * selected — Nexus accepts a single condition), and the ending-soon sort
   * (served by the auction end-time stream, `sorting=ends_at`). Everything
   * else (text query, hierarchical category prefix, minor-unit price range,
   * the remaining sorts) stays client-side in `filterMarketplaceCatalog`, so
   * server-side filters only narrow what gets fetched, never what renders.
   */
  static async fetchCatalogListings(filters: {
    saleFormat: CommerceSaleFormatFilter;
    conditions: CommerceConditionFilter[];
    sort: CommerceSort;
    countryCode?: string | null;
  }): Promise<void> {
    await CommerceApplication.fetchCatalogListings({
      ...(filters.saleFormat !== 'all' && filters.saleFormat !== 'drops' ? { saleFormat: filters.saleFormat } : {}),
      ...(filters.conditions.length === 1 ? { condition: filters.conditions[0] } : {}),
      ...(filters.sort === 'ending_soon' ? { endingSoonest: true } : {}),
      ...(filters.countryCode ? { country: filters.countryCode } : {}),
    });
  }

  static async fetchSellerCatalogListings(sellerPubky: unknown): Promise<void> {
    await CommerceApplication.fetchSellerCatalogListings(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  /**
   * Refreshes the catalog cache with listings from followed sellers for the
   * home-feed shelf. See `CommerceApplication.fetchFollowedSellerCatalogListings`
   * for the request-count bounds.
   */
  static async fetchFollowedSellerListings(followedPubkys: unknown): Promise<void> {
    await CommerceApplication.fetchFollowedSellerCatalogListings(CommerceRecordNormalizer.pubkyList(followedPubkys));
  }

  static async initializeSandboxCatalog(): Promise<boolean> {
    return await CommerceApplication.initializeSandboxCatalog();
  }

  /**
   * Starts the interactive session-connect flow for the durable Marketplace
   * Transaction Service. The returned `awaitSession` resolves once the user
   * approves on their signer and the AuthToken is exchanged for a bearer
   * session; on success the session's public facts (never the token) are
   * mirrored into the commerce store so every durable-mode surface refetches.
   * `cancel` frees the underlying auth flow. Flows are single-use — a retry
   * after failure or cancellation must call this again for a fresh flow.
   */
  static beginMarketplaceSessionConnect() {
    const flow = CommerceApplication.beginMarketplaceSessionFlow();
    return {
      authorizationUrl: flow.authorizationUrl,
      awaitSession: async () => {
        const session = await flow.awaitSession();
        this.writeMarketplaceSessionStore(session);
        return session;
      },
      cancel: flow.cancel,
    };
  }

  static hasFullHomeserverGrant(): boolean {
    return CommerceApplication.currentHomeserverGrantIsFull();
  }

  /**
   * Drops the service bearer and the store's public session facts together.
   */
  static clearMarketplaceSession(): void {
    CommerceApplication.clearMarketplaceSession();
    this.clearMarketplaceSessionStore();
  }

  /** True while getActiveSession still considers the bearer inside its margin. */
  static hasActiveMarketplaceSession(): boolean {
    return CommerceApplication.hasActiveMarketplaceSession();
  }

  static async executeMarketplaceCommand(input: unknown) {
    return await CommerceApplication.executeMarketplaceCommand(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.marketplaceCommand(input),
    );
  }

  /**
   * The seller's standing amount-band consent (ratified D2). `null` means
   * the backend has no attestation support (sandbox) and the opt-in must not
   * be rendered at all.
   */
  static async getMarketplaceBandConsent(sellerPubky: unknown) {
    return await CommerceApplication.getMarketplaceBandConsent(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.pubky(sellerPubky),
    );
  }

  /** The current user's own published review row for one order, or null. */
  static async getOwnMarketplaceReview(orderId: unknown) {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'An order id is required.', {
        service: ErrorService.Marketplace,
        operation: 'getOwnMarketplaceReview',
      });
    }
    return await CommerceApplication.getOwnMarketplaceReview(this.getCurrentUserPubky(), orderId);
  }

  /**
   * Publishes the current user's review record (with its embedded purchase
   * attestation) to their homeserver after a successful review command.
   * Returns null when the command result carried no attestation.
   */
  static async publishOwnMarketplaceReview(order: MarketplaceOrder, result: Record<string, unknown>) {
    return await CommerceApplication.commitPublishOwnReview({
      actorPubky: this.getCurrentUserPubky(),
      order,
      result,
    });
  }

  /** Retries own-review records whose homeserver publication never landed. */
  static async resumeOwnReviewPublications() {
    return await CommerceApplication.resumeOwnReviewPublications(this.getCurrentUserPubky());
  }

  /**
   * Publishes the portable order receipt for every eligible paid order to
   * the current user's own homeserver (credible exit for orders) and mirrors
   * the outcome into the commerce store, so the orders surface shows the
   * honest "reconnect to save it" state under a narrow session grant instead
   * of a silent skip. Missing publications self-heal on the next orders load.
   */
  static async publishOrderReceipts(orders: MarketplaceOrder[]): Promise<void> {
    const status = await CommerceApplication.publishOrderReceipts(this.getCurrentUserPubky(), orders);
    useCommerceStore.getState().setReceiptsPublicationStatus(status === 'skipped' ? 'idle' : status);
  }

  // --- Drops (ADR 0026) ---

  /** Canonical seller-signed drop record from the homeserver. */
  static async fetchDrop(ownerPubky: string, dropId: string) {
    return await CommerceApplication.fetchDrop(ownerPubky, dropId);
  }

  /** The current user's published drop ids, listed from their homeserver. */
  static async listOwnDropIds() {
    return await CommerceApplication.listOwnDropIds(this.getCurrentUserPubky());
  }

  /** Authoritative public drop state from the transaction service. */
  static async getPublicDrop(sellerPubky: string, dropId: string) {
    return await CommerceApplication.getPublicDrop(sellerPubky, dropId);
  }

  /** The current seller's full-detail drop read (mission control). */
  static async getOwnDrop(dropId: string) {
    const pubky = this.getCurrentUserPubky();
    return await CommerceApplication.getSellerDrop(pubky, pubky, dropId);
  }

  /** The current buyer's per-drop allowance (ready check). */
  static async getDropReadyCheck(sellerPubky: string, dropId: string) {
    return await CommerceApplication.getDropReadyCheck(this.getCurrentUserPubky(), sellerPubky, dropId);
  }

  /** Convergent drop registration from the seller's homeserver record. */
  static async syncDropRegistration(sellerPubky: string, dropId: string) {
    return await CommerceApplication.syncDropRegistration(this.getCurrentUserPubky(), sellerPubky, dropId);
  }

  /** Publishes the seller-signed drop record (specs-validated) to the homeserver. */
  static async publishDrop(record: unknown) {
    return await CommerceApplication.commitPublishDrop(CommerceRecordNormalizer.drop(record));
  }

  /** Seller kill switch: announced/live → ended_cancelled (CAS). */
  static async cancelDrop(dropId: string, expectedRevision: number) {
    return await CommerceApplication.cancelDrop(this.getCurrentUserPubky(), dropId, expectedRevision);
  }

  /** Returns an ENDED drop's listings to ordinary open sale (CAS). */
  static async releaseDropListings(dropId: string, expectedRevision: number) {
    return await CommerceApplication.releaseDropListings(this.getCurrentUserPubky(), dropId, expectedRevision);
  }

  /**
   * Self-heal: registers an own listing with the transaction service when it
   * has no aggregate there (published before durable-mode registration
   * existed, or while registration failed). Idempotent.
   */
  static async ensureListingRegistered(record: unknown) {
    return await CommerceApplication.ensureListingRegistered(CommerceRecordNormalizer.listing(record));
  }

  /**
   * Buyer-side heal (durable modes only): asks the transaction service to
   * fetch the canonical seller-signed record from the homeserver and
   * register the listing from it. Any signed-in user may trigger it — the
   * seller is not required.
   */
  static async syncListingRegistration(sellerPubky: unknown, listingId: unknown) {
    return await CommerceApplication.syncListingRegistration(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.pubky(sellerPubky),
      CommerceRecordNormalizer.entityId(listingId),
    );
  }

  // --- Seller-configurable payment methods (durable service only) ----------

  /** A seller's publicly visible payment rails (bitcoin/stripe/paypal). */
  static async getSellerPaymentConfig(sellerPubky: unknown) {
    return await CommerceApplication.getSellerPaymentConfig(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  /** The current user's own stored payment configuration, or null. */
  static async getMyPaymentConfig() {
    return await CommerceApplication.getMyPaymentConfig(this.getCurrentUserPubky());
  }

  /** Saves the current user's own payment configuration. */
  static async putMyPaymentConfig(input: {
    bitcoinEnabled: boolean;
    stripePaymentLink: string | null;
    stripeRestrictedKey?: string;
    paypalMerchantEmail: string | null;
  }) {
    return await CommerceApplication.putMyPaymentConfig(this.getCurrentUserPubky(), input);
  }

  /** Buyer's one-shot payment-method binding for an order. */
  static async bindPaymentMethod(orderId: string, method: PaymentMethodKind) {
    return await CommerceApplication.bindPaymentMethod(this.getCurrentUserPubky(), orderId, method);
  }

  /** Asks the service to verify a Stripe payment with the seller's restricted key. */
  static async verifyStripePayment(orderId: string) {
    return await CommerceApplication.verifyStripePayment(this.getCurrentUserPubky(), orderId);
  }

  /** Buyer's PayPal payment report (attestation, never advances payment). */
  static async markFiatPaid(orderId: string, transactionRef?: string) {
    return await CommerceApplication.markFiatPaid(this.getCurrentUserPubky(), orderId, transactionRef);
  }

  /** The seller's own Shippo shipping configuration (token is write-only). */
  static async getMyShippingConfig() {
    return await CommerceApplication.getMyShippingConfig(this.getCurrentUserPubky());
  }

  static async putMyShippingConfig(input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null }) {
    return await CommerceApplication.putMyShippingConfig(this.getCurrentUserPubky(), input);
  }

  /** Real Shippo rates for a paid order's delivery address (seller only). */
  static async quoteShippingRates(orderId: string, parcel: ShippingParcel) {
    return await CommerceApplication.quoteShippingRates(this.getCurrentUserPubky(), orderId, parcel);
  }

  /** Purchases the selected rate on the seller's own Shippo account (real money). */
  static async purchaseShippingLabel(orderId: string, rateId: string) {
    return await CommerceApplication.purchaseShippingLabel(this.getCurrentUserPubky(), orderId, rateId);
  }

  static async getShippingLabel(orderId: string) {
    return await CommerceApplication.getShippingLabel(this.getCurrentUserPubky(), orderId);
  }

  /** Seller's PayPal receipt confirmation — this is what pays the order. */
  static async confirmFiatReceived(orderId: string) {
    return await CommerceApplication.confirmFiatReceived(this.getCurrentUserPubky(), orderId);
  }

  /** Manual watch-only xpub claim flow against paykit-server. */
  static beginPaykitClaimFlow(accountXpub: string) {
    return CommerceApplication.beginPaykitClaimFlow(accountXpub);
  }

  /** Whether the current user already has a claimed watch-only account. */
  static async isOwnPaykitAccountClaimed() {
    return await CommerceApplication.isPaykitAccountClaimed(this.getCurrentUserPubky());
  }

  /**
   * A seller's public reputation overview (`rated` / `new_seller` /
   * `unavailable`) for rating headers. Network-only: reputation is index
   * data, never cached as a record.
   */
  static async fetchSellerReputation(sellerPubky: unknown) {
    return await CommerceApplication.fetchSellerReputationOverview(CommerceRecordNormalizer.pubky(sellerPubky));
  }

  /** A page of indexed reviews about a seller, with joined responses. */
  static async fetchSellerReviews(sellerPubky: unknown, page: { skip?: number; limit?: number } = {}) {
    return await CommerceApplication.fetchSellerReviews(CommerceRecordNormalizer.pubky(sellerPubky), page);
  }

  /** A page of indexed buyer reviews of one listing, with joined responses. */
  static async fetchListingReviews(
    sellerPubky: unknown,
    listingId: unknown,
    page: { skip?: number; limit?: number } = {},
  ) {
    return await CommerceApplication.fetchListingReviews(
      CommerceRecordNormalizer.pubky(sellerPubky),
      CommerceRecordNormalizer.entityId(listingId),
      page,
    );
  }

  /** The current user's own published review rows, newest update first (local-first). */
  static async getOwnMarketplaceReviews() {
    return await CommerceApplication.getOwnReviews(this.getCurrentUserPubky());
  }

  /** The current user's own response row for one review, or null. */
  static async getOwnMarketplaceReviewResponse(reviewId: unknown) {
    return await CommerceApplication.getOwnReviewResponse(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(reviewId),
    );
  }

  /**
   * Publishes (or revises) the current user's response to a review they are
   * the subject of — a homeserver record on the user's OWN homeserver
   * (subject-only, one revisable response per review; there is no service
   * command for responses).
   */
  static async publishMarketplaceReviewResponse(input: {
    review: CommerceIndexedReview;
    text: string;
    priorRevision?: number | null;
    priorCreatedAt?: string | null;
  }) {
    return await CommerceApplication.commitPublishReviewResponse({
      actorPubky: this.getCurrentUserPubky(),
      ...input,
    });
  }

  /** Retries own review-response records whose homeserver publication never landed. */
  static async resumeOwnReviewResponsePublications() {
    return await CommerceApplication.resumeOwnReviewResponsePublications(this.getCurrentUserPubky());
  }

  static async getMarketplaceListingProjection(ownerPubky: unknown, listingId: unknown) {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    // Nullable on purpose: the sandbox serves this projection to signed-out
    // visitors, while the durable transport requires the signed-in pubky to
    // bind its bearer session and degrades with session guidance otherwise.
    return await CommerceApplication.getMarketplaceListingProjection(
      useAuthStore.getState().currentUserPubky,
      buildMarketplaceListingAggregateId(owner, id),
    );
  }

  /** The auction's visible-price bid history (durable service, signed-in). */
  static async getMarketplaceListingBids(ownerPubky: unknown, listingId: unknown) {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    return await CommerceApplication.getMarketplaceListingBids(
      useAuthStore.getState().currentUserPubky,
      buildMarketplaceListingAggregateId(owner, id),
    );
  }

  static async getMarketplaceConversations() {
    return await CommerceApplication.getMarketplaceConversations(this.getCurrentUserPubky());
  }

  static async getMarketplaceOffers() {
    return await CommerceApplication.getMarketplaceOffers(this.getCurrentUserPubky());
  }

  static async getMarketplaceNotifications() {
    return await CommerceApplication.getMarketplaceNotifications(this.getCurrentUserPubky());
  }

  static async getMarketplaceNotificationPreferences() {
    return await CommerceApplication.getMarketplaceNotificationPreferences(this.getCurrentUserPubky());
  }

  /**
   * Marketplace notifications shaped for the app's general notification
   * surface: normalized to the redacted feed shape (type, actor, aggregate
   * reference, timestamp, deep link — ADR-0019 §8 allows nothing more), with
   * `isUnread` honest per adapter mode. Returns [] when signed out or when
   * the mode has no transactional backend, so the shared surface renders
   * exactly what it renders today for those sessions.
   */
  static async getMarketplaceFeedNotifications() {
    const adapterMode = getCommerceAdapterMode();
    if (!isTransactionalCommerceMode(adapterMode) || !useAuthStore.getState().currentUserPubky) {
      return [];
    }
    const notifications = await CommerceApplication.getMarketplaceNotifications(this.getCurrentUserPubky());
    return notifications.map((notification) =>
      MarketplaceNotificationNormalizer.toFeedNotification(notification, adapterMode),
    );
  }

  /**
   * Recounts unread marketplace notifications into the notification store so
   * the app-wide badge (header/footer avatar) includes commerce activity.
   *
   * Only the sandbox stores read state (`readAt` + `notification.mark_read`),
   * so only sandbox rows can contribute: in `transaction-service` mode the
   * durable service delivers immutable outbox rows the user could never mark
   * read, and a badge count that can never be cleared is a count the user
   * cannot act on — it stays 0 there (and in the modes with no backend at
   * all) without even fetching. Signed-out sessions also clear to 0.
   */
  static async refreshMarketplaceNotificationBadge(): Promise<void> {
    const notificationStore = useNotificationStore.getState();
    if (getCommerceAdapterMode() !== 'sandbox' || !useAuthStore.getState().currentUserPubky) {
      notificationStore.setMarketplaceUnread(0);
      return;
    }
    const notifications = await CommerceApplication.getMarketplaceNotifications(this.getCurrentUserPubky());
    notificationStore.setMarketplaceUnread(notifications.filter(({ readAt }) => !readAt).length);
  }

  /**
   * Marks every unread marketplace notification read, mirroring what opening
   * the general notifications page does for social notifications. Sandbox
   * only: the durable service has no `notification.mark_read` command
   * (delivered notifications are immutable outbox rows), so in
   * `transaction-service` mode this is a no-op instead of a fake write — the
   * badge there is already 0 because durable rows never count as unread.
   *
   * The store's marketplace badge is cleared only after every mark-read
   * command succeeds, so a failed write never hides notifications the
   * backend still reports unread (same rule as the social `markAllAsRead`).
   */
  static async markAllMarketplaceNotificationsRead(): Promise<void> {
    if (getCommerceAdapterMode() !== 'sandbox' || !useAuthStore.getState().currentUserPubky) return;
    const notifications = await CommerceApplication.getMarketplaceNotifications(this.getCurrentUserPubky());
    const unread = notifications.filter(({ readAt }) => !readAt);
    if (unread.length === 0) {
      useNotificationStore.getState().setMarketplaceUnread(0);
      return;
    }
    const results = await Promise.all(
      unread.map((notification) =>
        this.executeMarketplaceCommand({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId: `notification:${notification.id}`,
          expectedRevision: notification.revision,
          issuedAt: new Date().toISOString(),
          kind: 'notification.mark_read',
          payload: { notificationId: notification.id },
        }),
      ),
    );
    if (results.every((result) => result.ok)) {
      useNotificationStore.getState().setMarketplaceUnread(0);
    }
  }

  static async getMarketplaceOrders() {
    return await CommerceApplication.getMarketplaceOrders(this.getCurrentUserPubky());
  }

  static async getMarketplacePayment(paymentId: unknown) {
    return await CommerceApplication.getMarketplacePayment(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(paymentId),
    );
  }

  static async getMarketplaceReceipt(receiptId: unknown) {
    return await CommerceApplication.getMarketplaceReceipt(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(receiptId),
    );
  }

  static async getMarketplaceOrder(orderId: unknown) {
    return await CommerceApplication.getMarketplaceOrder(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(orderId),
    );
  }

  // --- Local pickup (Wave 7 safe subset, local pickup design PART A) ------
  //
  // Pickup details are restricted personal data: nothing below writes them
  // to a store or to Dexie. The buyer's reveal and the seller's owner-read
  // copy are returned to the caller and held in memory only (§A1).

  /** The deployment's `pickup_available` capability (§A7) — false unless the durable service reports pickup on. */
  static async fetchPickupAvailable(): Promise<boolean> {
    return await CommerceApplication.fetchPickupAvailable();
  }

  /**
   * The current buyer's per-line pickup-details reveal for one of their
   * paid orders (§A3). Memory only: re-fetch on each view, never persist.
   */
  static async fetchPickupReveal(orderId: unknown) {
    return await CommerceApplication.fetchPickupReveal(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(orderId),
    );
  }

  /** The current seller's own pickup details for one of their listings, plus the surviving version counter (§A4). */
  static async fetchSellerPickupDetails(listingId: unknown) {
    const pubky = this.getCurrentUserPubky();
    const aggregateId = buildMarketplaceListingAggregateId(pubky, CommerceRecordNormalizer.entityId(listingId));
    return await CommerceApplication.fetchSellerPickupDetails(pubky, aggregateId);
  }

  /**
   * `pickup_details.set` on one of the current seller's listings (§A7):
   * whole-payload sealed upsert, CAS on `expectedVersion` against the
   * per-listing version counter (0 when no details exist yet).
   */
  static async commitSetPickupDetails(listingId: unknown, input: { expectedVersion: unknown; details: unknown }) {
    const pubky = this.getCurrentUserPubky();
    return await CommerceApplication.commitSetPickupDetails(pubky, {
      sellerPubky: pubky,
      listingId: CommerceRecordNormalizer.entityId(listingId),
      expectedVersion: this.pickupDetailsVersion(input?.expectedVersion),
      details: CommerceRecordNormalizer.pickupDetails(input?.details),
    });
  }

  /** `pickup_details.clear` on one of the current seller's listings (§A3/§A7). */
  static async commitClearPickupDetails(listingId: unknown, expectedVersion: unknown) {
    const pubky = this.getCurrentUserPubky();
    return await CommerceApplication.commitClearPickupDetails(pubky, {
      sellerPubky: pubky,
      listingId: CommerceRecordNormalizer.entityId(listingId),
      expectedVersion: this.pickupDetailsVersion(expectedVersion),
    });
  }

  /** `fulfillment.mark_ready` (§A6): the current seller arms a paid pickup order for handover. */
  static async commitMarkReady(orderId: unknown, expectedRevision: unknown) {
    return await CommerceApplication.commitMarkReady(this.getCurrentUserPubky(), {
      orderId: CommerceRecordNormalizer.entityId(orderId),
      expectedRevision: this.pickupOrderRevision(expectedRevision),
    });
  }

  /** `fulfillment.confirm_pickup` (§A6): either party confirms the handover on a paid/ready pickup order. */
  static async commitConfirmPickup(orderId: unknown, expectedRevision: unknown) {
    return await CommerceApplication.commitConfirmPickup(this.getCurrentUserPubky(), {
      orderId: CommerceRecordNormalizer.entityId(orderId),
      expectedRevision: this.pickupOrderRevision(expectedRevision),
    });
  }

  /**
   * `checkout.create` with the per-(seller, fulfillment) group choices of
   * §A2: each group's choice is validated against what its listings publish
   * and assigned to every line; a pickup-only checkout sends no delivery
   * address.
   */
  static async commitCreateMarketplaceCheckout(input: CommerceCheckoutFulfillmentInput) {
    return await CommerceApplication.commitCreateMarketplaceCheckout(this.getCurrentUserPubky(), input);
  }

  /** The pickup-details CAS version: a non-negative safe integer (0 when no details exist yet). */
  private static pickupDetailsVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'A non-negative pickup details version is required.', {
        service: ErrorService.Marketplace,
        operation: 'pickupDetailsVersion',
      });
    }
    return value;
  }

  /** An order revision for a pickup handover command: a positive safe integer. */
  private static pickupOrderRevision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'A positive order revision is required.', {
        service: ErrorService.Marketplace,
        operation: 'pickupOrderRevision',
      });
    }
    return value;
  }

  static async uploadMarketplaceAttachment(recipientPubky: unknown, file: File) {
    const recipient = CommerceRecordNormalizer.pubky(recipientPubky);
    if (
      !(file instanceof File) ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size === 0 ||
      file.size > IMAGE_MAX_UPLOAD_SIZE
    ) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Message attachment is missing, unsafe, or too large.', {
        service: ErrorService.Local,
        operation: 'uploadMarketplaceAttachment',
        context: { mimeType: file?.type, byteSize: file?.size ?? 0 },
      });
    }
    return await CommerceApplication.uploadMarketplaceAttachment(this.getCurrentUserPubky(), recipient, file);
  }

  static async fetchMarketplaceAttachment(attachmentId: unknown) {
    return await CommerceApplication.fetchMarketplaceAttachment(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(attachmentId),
    );
  }

  static async submitLocksPaykitProof({
    creatorPubky,
    bundleId,
    lockResource,
    criterionId,
  }: {
    creatorPubky: unknown;
    bundleId: unknown;
    lockResource: unknown;
    criterionId: unknown;
  }) {
    return await CommerceApplication.submitLocksPaykitProof({
      creatorPubky: CommerceRecordNormalizer.pubky(creatorPubky),
      readerPubky: this.getCurrentUserPubky(),
      bundleId: CommerceRecordNormalizer.entityId(bundleId),
      lockResource: CommerceRecordNormalizer.lockResource(lockResource),
      criterionId: CommerceRecordNormalizer.entityId(criterionId),
    });
  }

  /**
   * Starts (or retries) the real Locks/Paykit payment for one of the current
   * user's orders. The order, payment, and digital lock come from projections
   * and records already validated at their own boundaries; the buyer identity
   * is always the signed-in user.
   */
  static async beginMarketplaceLocksPayment({
    order,
    payment,
    digitalLock,
  }: {
    order: MarketplaceOrder;
    payment: MarketplacePayment;
    digitalLock: CommerceDigitalLock;
  }) {
    return await CommerceApplication.beginMarketplaceLocksPayment({
      buyerPubky: this.getCurrentUserPubky(),
      order,
      payment,
      digitalLock,
    });
  }

  static async getMarketplaceLocksCorrelation(paymentId: unknown) {
    return await CommerceApplication.getMarketplaceLocksCorrelation(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(paymentId),
    );
  }

  static async unlockMarketplaceLocksContent(paymentId: unknown) {
    return await CommerceApplication.unlockMarketplaceLocksContent(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(paymentId),
    );
  }

  static async createLocksFrontendSession(code: unknown, state: unknown) {
    if (
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > 4_096 ||
      typeof state !== 'string' ||
      state.length === 0 ||
      state.length > 256
    ) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Locks connect completion is invalid.', {
        service: ErrorService.Local,
        operation: 'createLocksFrontendSession',
      });
    }
    return await CommerceApplication.createLocksFrontendSession(code, state);
  }

  static async lookupLocksVerification(creatorPubky: unknown, bundleId: unknown) {
    return await CommerceApplication.lookupLocksVerification(
      CommerceRecordNormalizer.pubky(creatorPubky),
      CommerceRecordNormalizer.entityId(bundleId),
    );
  }

  static async issueLocksAccessCredential(creatorPubky: unknown, bundleId: unknown) {
    return await CommerceApplication.issueLocksAccessCredential(
      CommerceRecordNormalizer.pubky(creatorPubky),
      CommerceRecordNormalizer.entityId(bundleId),
    );
  }

  static async fetchLocksGuardedContent(relativePath: unknown, credential: unknown) {
    if (
      typeof relativePath !== 'string' ||
      relativePath
        .split('/')
        .filter(Boolean)
        .some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment)) ||
      typeof credential !== 'string' ||
      credential.length === 0 ||
      credential.length > 4_096
    ) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Locks content request is invalid.', {
        service: ErrorService.Local,
        operation: 'fetchLocksGuardedContent',
      });
    }
    return await CommerceApplication.fetchLocksGuardedContent(relativePath, credential);
  }

  static getPaykitSetupUrl(returnTo: unknown, state: unknown): string {
    const parsedReturnTo = typeof returnTo === 'string' ? URL.parse(returnTo) : null;
    if (!parsedReturnTo || !['http:', 'https:'].includes(parsedReturnTo.protocol)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Paykit setup return URL is invalid.', {
        service: ErrorService.Local,
        operation: 'getPaykitSetupUrl',
      });
    }
    return CommerceApplication.getPaykitSetupUrl(parsedReturnTo.toString(), CommerceRecordNormalizer.entityId(state));
  }

  static async getIndicativeBtcRate() {
    return await CommerceApplication.getIndicativeBtcRate();
  }

  static async getListingDrafts() {
    return await CommerceApplication.getListingDrafts(this.getCurrentUserPubky());
  }

  static async commitUpdateListingDraft(listingId: unknown, form: unknown): Promise<void> {
    await CommerceApplication.commitUpdateListingDraft(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(listingId),
      CommerceRecordNormalizer.jsonValue(form),
    );
  }

  static async commitDeleteListingDraft(listingId: unknown): Promise<void> {
    await CommerceApplication.commitDeleteListingDraft(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(listingId),
    );
  }

  static async isFavorite(listingCompositeId: unknown): Promise<boolean> {
    return await CommerceApplication.isFavorite(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.listingCompositeId(listingCompositeId),
    );
  }

  static async getCartItems() {
    return await CommerceApplication.getCartItems(this.getCurrentUserPubky());
  }

  static async commitUpsertCartItem(listingCompositeId: unknown, variantId: unknown, quantity: unknown): Promise<void> {
    const parsedQuantity =
      typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity > 0 ? quantity : Number.NaN;
    await CommerceApplication.commitUpsertCartItem(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.listingCompositeId(listingCompositeId),
      CommerceRecordNormalizer.entityId(variantId),
      parsedQuantity,
    );
  }

  static async commitDeleteCartItem(listingCompositeId: unknown, variantId: unknown): Promise<void> {
    await CommerceApplication.commitDeleteCartItem(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.listingCompositeId(listingCompositeId),
      CommerceRecordNormalizer.entityId(variantId),
    );
  }

  static async commitClearCart(): Promise<void> {
    await CommerceApplication.commitClearCart(this.getCurrentUserPubky());
  }

  static async getDeliveryAddresses() {
    return await CommerceApplication.getDeliveryAddresses(this.getCurrentUserPubky());
  }

  static async commitUpsertDeliveryAddress(addressId: unknown, input: unknown): Promise<void> {
    await CommerceApplication.commitUpsertDeliveryAddress(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(addressId),
      CommerceRecordNormalizer.deliveryAddressInput(input),
    );
  }

  static async commitDeleteDeliveryAddress(addressId: unknown): Promise<void> {
    await CommerceApplication.commitDeleteDeliveryAddress(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(addressId),
    );
  }

  static async commitSetDefaultDeliveryAddress(addressId: unknown): Promise<void> {
    await CommerceApplication.commitSetDefaultDeliveryAddress(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(addressId),
    );
  }

  static async commitMarkDeliveryAddressUsed(addressId: unknown): Promise<void> {
    await CommerceApplication.commitMarkDeliveryAddressUsed(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(addressId),
    );
  }

  static async getShippingPresets() {
    return await CommerceApplication.getShippingPresets(this.getCurrentUserPubky());
  }

  static async commitUpsertShippingPreset(presetId: unknown, input: unknown): Promise<void> {
    await CommerceApplication.commitUpsertShippingPreset(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(presetId),
      CommerceRecordNormalizer.shippingPresetInput(input),
    );
  }

  static async commitDeleteShippingPreset(presetId: unknown): Promise<void> {
    await CommerceApplication.commitDeleteShippingPreset(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(presetId),
    );
  }

  static async getFavorites() {
    return await CommerceApplication.getFavorites(this.getCurrentUserPubky());
  }

  static async commitCreateFavorite(listingCompositeId: unknown): Promise<void> {
    await CommerceApplication.commitCreateFavorite(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.listingCompositeId(listingCompositeId),
    );
    // Local write already landed (local-first); the private-document push
    // runs behind it and reports its outcome through the sync status store.
    void this.syncWatchlist();
  }

  static async commitDeleteFavorite(listingCompositeId: unknown): Promise<void> {
    await CommerceApplication.commitDeleteFavorite(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.listingCompositeId(listingCompositeId),
    );
    void this.syncWatchlist();
  }

  /**
   * Runs one cross-device watchlist sync round (pull, merge, push) and
   * mirrors the outcome into the commerce store for UI surfaces. Safe to call
   * opportunistically: signed-out/sandbox rounds are skipped and leave the
   * status at `idle`, and overlapping calls share one round-trip.
   */
  static async syncWatchlist(): Promise<void> {
    const currentUserPubky = useAuthStore.getState().currentUserPubky;
    if (!currentUserPubky) {
      useCommerceStore.getState().setWatchlistSyncStatus('idle');
      return;
    }
    const status = await CommerceApplication.syncWatchlist(currentUserPubky);
    useCommerceStore.getState().setWatchlistSyncStatus(status === 'skipped' ? 'idle' : status);
  }

  /**
   * Runs one bounded watchlist detection pass for the signed-in user (see
   * `CommerceApplication.runWatchlistDetection`). Returns without doing
   * anything when signed out or when no marketplace surface exists.
   */
  static async runWatchlistDetection(): Promise<{ alertCount: number }> {
    if (!useAuthStore.getState().currentUserPubky) return { alertCount: 0 };
    return await CommerceApplication.runWatchlistDetection(this.getCurrentUserPubky());
  }

  static async getWatchAlerts() {
    if (!useAuthStore.getState().currentUserPubky) return [];
    return await CommerceApplication.getWatchAlerts(this.getCurrentUserPubky());
  }

  static async getWatchSnapshots() {
    if (!useAuthStore.getState().currentUserPubky) return [];
    return await CommerceApplication.getWatchSnapshots(this.getCurrentUserPubky());
  }

  /**
   * Marks the signed-in user's device-local watch alerts seen. Unlike the
   * durable service's notifications, these rows live only in this browser,
   * so their read state is real and honest to clear.
   */
  static async markWatchAlertsSeen(): Promise<void> {
    if (!useAuthStore.getState().currentUserPubky) return;
    await CommerceApplication.markWatchAlertsSeen(this.getCurrentUserPubky());
  }

  /**
   * The signed-in user's device-local activity read checkpoint (ms epoch;
   * `0` when signed out or never visited). Service notifications created
   * after it count as new on the marketplace Activity badge.
   */
  static async getActivityReadCheckpoint(): Promise<number> {
    if (!useAuthStore.getState().currentUserPubky) return 0;
    return await CommerceApplication.getActivityReadCheckpoint(this.getCurrentUserPubky());
  }

  /**
   * Advances the signed-in user's device-local activity read checkpoint to
   * now. Deliberately NOT service-side read state — the durable service has
   * none — it only records that THIS device showed an activity surface, the
   * same doctrine as the Messages read checkpoint.
   */
  static async markActivityRead(): Promise<void> {
    if (!useAuthStore.getState().currentUserPubky) return;
    await CommerceApplication.markActivityRead(this.getCurrentUserPubky());
  }

  static async getSavedSearches() {
    if (!useAuthStore.getState().currentUserPubky) return [];
    return await CommerceApplication.getSavedSearches(this.getCurrentUserPubky());
  }

  static async commitCreateSavedSearch(name: unknown, params: unknown, initialWatermarkUpdatedAt: unknown) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (trimmedName.length === 0 || trimmedName.length > COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        `A saved search needs a name of 1–${COMMERCE_SAVED_SEARCH_NAME_MAX_CHARS} characters.`,
        {
          service: ErrorService.Local,
          operation: 'commitCreateSavedSearch',
        },
      );
    }
    const watermark =
      typeof initialWatermarkUpdatedAt === 'number' &&
      Number.isSafeInteger(initialWatermarkUpdatedAt) &&
      initialWatermarkUpdatedAt >= 0
        ? initialWatermarkUpdatedAt
        : Number.NaN;
    if (Number.isNaN(watermark)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Saved search watermark must be a timestamp.', {
        service: ErrorService.Local,
        operation: 'commitCreateSavedSearch',
      });
    }
    await CommerceApplication.commitCreateSavedSearch(
      this.getCurrentUserPubky(),
      trimmedName,
      CommerceRecordNormalizer.savedSearchParams(params),
      watermark,
    );
  }

  static async commitDeleteSavedSearch(id: unknown): Promise<void> {
    await CommerceApplication.commitDeleteSavedSearch(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(id),
    );
  }

  static async recordSavedSearchCheck(
    id: unknown,
    result: { newCount: number; latestMatchUpdatedAt: number; checkedAt: number },
  ): Promise<void> {
    const values = [result.newCount, result.latestMatchUpdatedAt, result.checkedAt];
    if (!values.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Saved search check result is invalid.', {
        service: ErrorService.Local,
        operation: 'recordSavedSearchCheck',
      });
    }
    await CommerceApplication.recordSavedSearchCheck(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.entityId(id),
      result,
    );
  }

  static async acknowledgeSavedSearch(id: unknown): Promise<void> {
    await CommerceApplication.acknowledgeSavedSearch(this.getCurrentUserPubky(), CommerceRecordNormalizer.entityId(id));
  }

  static async isShopFollowed(sellerPubky: unknown): Promise<boolean> {
    return await CommerceApplication.isShopFollowed(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.pubky(sellerPubky),
    );
  }

  static async getShopFollows() {
    return await CommerceApplication.getShopFollows(this.getCurrentUserPubky());
  }

  static async commitCreateShopFollow(sellerPubky: unknown): Promise<void> {
    const ownerPubky = this.getCurrentUserPubky();
    const seller = CommerceRecordNormalizer.pubky(sellerPubky);
    if (ownerPubky === seller) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'A seller cannot follow their own shop.', {
        service: ErrorService.Local,
        operation: 'commitCreateShopFollow',
      });
    }
    await CommerceApplication.commitCreateShopFollow(ownerPubky, seller);
  }

  static async commitDeleteShopFollow(sellerPubky: unknown): Promise<void> {
    await CommerceApplication.commitDeleteShopFollow(
      this.getCurrentUserPubky(),
      CommerceRecordNormalizer.pubky(sellerPubky),
    );
  }

  static async commitUpsertShop(input: unknown): Promise<void> {
    const record = CommerceRecordNormalizer.shop(input);
    this.assertCurrentUserOwns(record.ownerPubky);
    await this.withPending(`shop:${record.ownerPubky}`, () => CommerceApplication.commitUpsertShop(record));
  }

  static async commitUpsertListing(input: unknown): Promise<{ registered: boolean }> {
    const record = CommerceRecordNormalizer.listing(input);
    this.assertCurrentUserOwns(record.ownerPubky);
    return await this.withPending(`${record.ownerPubky}:${record.listingId}`, () =>
      CommerceApplication.commitUpsertListing(record),
    );
  }

  static async commitDeleteListing(ownerPubky: unknown, listingId: unknown): Promise<void> {
    const owner = CommerceRecordNormalizer.pubky(ownerPubky);
    const id = CommerceRecordNormalizer.entityId(listingId);
    this.assertCurrentUserOwns(owner);
    await this.withPending(`${owner}:${id}`, () => CommerceApplication.commitDeleteListing(owner, id));
  }

  static async commitCreateMedia(mediaId: unknown, bytes: Uint8Array): Promise<string> {
    const id = CommerceRecordNormalizer.entityId(mediaId);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_UPLOAD_SIZE) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Marketplace media bytes are missing or too large.', {
        service: ErrorService.Local,
        operation: 'commitCreateMedia',
        context: { byteLength: bytes?.byteLength ?? 0 },
      });
    }
    return await CommerceApplication.commitCreateMedia(this.getCurrentUserPubky(), id, bytes);
  }

  static async getMarketplaceMediaOwnerHomeserver(ownerPubky: unknown): Promise<string | null> {
    return await CommerceApplication.getMarketplaceMediaOwnerHomeserver(CommerceRecordNormalizer.pubky(ownerPubky));
  }

  static async fetchMarketplaceMedia(uri: string): Promise<Blob> {
    return await CommerceApplication.fetchMarketplaceMedia(uri);
  }

  private static assertCurrentUserOwns(ownerPubky: string): void {
    const currentUserPubky = this.getCurrentUserPubky();
    if (currentUserPubky !== ownerPubky) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Commerce record owner must match the signed-in user.', {
        service: ErrorService.Local,
        operation: 'assertCurrentUserOwns',
        context: { ownerMatches: false },
      });
    }
  }

  /**
   * Invariant: ending a marketplace session (local TTL via getActiveSession,
   * 401/SESSION_EXPIRED from the transport, or sign-out) always nulls the
   * zustand copy here — the controller owns the store; the service never does.
   * Last write wins by `issuedAt`: a connect that finishes after a clear keeps
   * the new session and must never resurrect the cleared one.
   */
  private static onMarketplaceSessionEnded(event: MarketplaceSessionEndedEvent): void {
    const current = useCommerceStore.getState().marketplaceSession;
    if (!current) return;
    if (Date.parse(current.issuedAt) > Date.parse(event.issuedAt)) return;
    this.clearMarketplaceSessionStore();
  }

  /**
   * Mirrors public session facts into the commerce store. Last write wins by
   * `issuedAt` so a restore or a late connect cannot overwrite a newer session.
   * Auth restore and `beginMarketplaceSessionConnect` both go through here.
   */
  static writeMarketplaceSessionStore(session: MarketplaceSessionInfo): void {
    const current = useCommerceStore.getState().marketplaceSession;
    if (current && Date.parse(current.issuedAt) > Date.parse(session.issuedAt)) return;
    useCommerceStore.getState().setMarketplaceSession(session);
  }

  private static clearMarketplaceSessionStore(): void {
    useCommerceStore.getState().setMarketplaceSession(null);
  }

  private static getCurrentUserPubky(): string {
    return useAuthStore.getState().selectCurrentUserPubky();
  }

  private static async withPending<T>(entityId: string, operation: () => Promise<T>): Promise<T> {
    const store = useCommerceStore.getState();
    store.setEntityPending(entityId, true);
    try {
      return await operation();
    } finally {
      useCommerceStore.getState().setEntityPending(entityId, false);
    }
  }
}
