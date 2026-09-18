import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { TagKind } from '@/application/tag/tag.types';
import {
  COMMERCE_SAVED_SEARCH_MAX_PER_OWNER,
  COMMERCE_WATCH_CHECK_MAX_ITEMS,
  COMMERCE_WATCH_ENDING_SOON_THRESHOLD_MS,
  getCommerceAdapterMode,
  getMarketplaceUrl,
  isDurableCommerceMode,
  isTransactionalCommerceMode,
  MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES,
} from '@/config/commerce';
import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import {
  extractReviewAttestation,
  verifyOwnDropEdition,
  verifyOwnOrderReceipt,
  verifyOwnReviewAttestation,
} from '@/libs/commerce/attestation';
import { lockPolicyCreator, toBareLockResource } from '@/libs/commerce/locks-payment';
import {
  type CommerceDigitalLock,
  type CommerceDropRecord,
  commerceListingFulfillmentMethods,
  type CommerceListingRecord,
  commerceListingShippingMinor,
  commerceReviewRecordSchema,
  type CommerceShopRecord,
  type CommerceWatchlistRecord,
} from '@/libs/commerce/marketplace-records';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import {
  type MarketplaceCheckoutFulfillmentLine,
  type MarketplaceFulfillmentMethod,
  type MarketplacePickupDetails,
  type MarketplacePickupReveal,
  type MarketplaceSellerPickupDetails,
  pickupRefusalFailureMessage,
  resolveCheckoutFulfillment,
} from '@/libs/commerce/pickup';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import type { ShipFromAddress, ShippingParcel } from '@/libs/commerce/shipping';
import {
  buildMarketplaceCheckoutAggregateId,
  buildMarketplaceDropAggregateId,
  buildMarketplaceListingAggregateId,
  buildMarketplaceOrderAggregateId,
  buildMarketplacePaymentAggregateId,
  classifyMarketplacePickupCommandRefusal,
  type CreateMarketplaceCheckoutCommand,
  type MarketplaceCommand,
  type MarketplaceCommandResponse,
} from '@/libs/commerce/transaction-commands';
import type { CommerceJsonValue } from '@/libs/commerce/transaction-contracts';
import { ClientErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { hasHttpStatus, isAppError, isNotFound } from '@/libs/error/error.utils';
import { HttpStatusCode } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import type {
  CommerceCatalogEntryModelSchema,
  CommerceIndexedReview,
  CommerceListingModelSchema,
  CommerceListingProjectionModelSchema,
  CommerceReputationSummary,
  CommerceReviewModelSchema,
  CommerceReviewResponseModelSchema,
  CommerceSavedSearchModelSchema,
  CommerceSavedSearchParams,
  CommerceSyncJobModelSchema,
  CommerceWatchAlertModelSchema,
  CommerceWatchSnapshotModelSchema,
} from '@/models/commerce/commerce.schema';
import { selectFollowedSellersToRefresh } from '@/pipes/commerce/commerce.discovery';
import {
  type CommerceDeliveryAddressInput,
  CommerceRecordNormalizer,
  type CommerceShippingPresetInput,
} from '@/pipes/commerce/commerce.normalizer';
import {
  emptyWatchlistState,
  localRowsToWatchlistState,
  mergeWatchlistStates,
  watchlistRecordToState,
  watchlistStatesEqual,
  watchlistStateToRecordBody,
} from '@/pipes/commerce/commerce.watchlist';
import {
  detectWatchAlerts,
  type WatchIndexObservation,
  type WatchObservation,
  type WatchProjectionObservation,
} from '@/pipes/marketplaceWatch/marketplaceWatch.detector';
import { MarketplaceMediaService } from '@/services/commerce/marketplace-media';
import { ExchangerateService } from '@/services/exchangerate/exchangerate';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService, PRIVATE_APP_DATA_PATH } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import {
  buildMarketplaceTagRowId,
  LocalMarketplaceTagService,
  type MarketplaceTagKind,
} from '@/services/local/tag/marketplace/tag.marketplace';
import { LocksGatewayService } from '@/services/locks/locks';
import {
  MarketplaceGatewayService,
  type MarketplaceOrder,
  type MarketplacePayment,
} from '@/services/marketplace/marketplace';
import { MarketplacePaykitClaimService } from '@/services/marketplace/marketplace-paykit-claim';
import {
  type MarketplaceSessionEndedEvent,
  MarketplaceSessionService,
} from '@/services/marketplace/marketplace-session';
import { NexusMarketplaceService } from '@/services/nexus/marketplace/marketplace';
import type {
  NexusListingCondition,
  NexusListingDetails,
  NexusListingSaleFormat,
} from '@/services/nexus/marketplace/marketplace.types';
import type { NexusTag } from '@/services/nexus/nexus.types';

/**
 * The `review` view inside a successful review command result (camelCased
 * by the wire boundary) — exactly the fields record publication needs.
 */
const reviewResultSchema = z
  .object({
    reviewerPubky: z.string().length(52),
    reviewerRole: z.enum(['buyer', 'seller']),
    subjectPubky: z.string().length(52),
    rating: z.number().int().min(1).max(5),
    text: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

export interface CommerceCatalogStreamFilters {
  saleFormat?: NexusListingSaleFormat;
  condition?: NexusListingCondition;
  /**
   * Ask Nexus for auctions ordered by soonest auction end
   * (`sorting=ends_at&order=ascending`) instead of the indexing timeline.
   * That stream contains only auction listings by definition.
   */
  endingSoonest?: boolean;
  /** Seller-declared item location: ISO-3166-1 alpha-2 country code. */
  country?: string;
}

/**
 * The three honest states a rating header can be in: `rated` (the index
 * holds reviews), `new_seller` (a reputation-aware index confirmed zero
 * reviews — the explicit cold-start state, ratified in the design's §10.3),
 * or `unavailable` (no reputation-aware index reachable — render nothing,
 * never a fabricated state).
 */
/**
 * Whether the current session can use private cross-device watchlist sync,
 * decided from `session.info.capabilities` (facts), never by probing for 403s.
 */
export type CommerceWatchlistSyncCapability = 'capable' | 'needs_reauth' | 'no_session';

/**
 * Outcome of one watchlist sync round. `skipped` covers sandbox mode and
 * signed-out/restoring states; `needs_reauth` is the honest "this session's
 * grant cannot touch /priv" state (from capability facts OR an actual 401/403).
 */
export type CommerceWatchlistSyncStatus = 'synced' | 'needs_reauth' | 'skipped' | 'error';

/**
 * Outcome of one portable order-receipt publication pass, mirrored by the
 * controller into the commerce store for UI surfaces. Same honesty contract
 * as the watchlist sync status: capability is decided from session facts,
 * and a refused private read/write reports `needs_reauth` — nothing
 * silently no-ops. `unavailable` covers the cases re-approval cannot fix:
 * this deployment issued no attestation, or a transient failure left a
 * receipt unpublished (it retries on the next orders-surface load).
 * `skipped` covers non-durable modes and signed-out/restoring states.
 */
export type CommerceReceiptPublicationStatus = 'published' | 'needs_reauth' | 'unavailable' | 'skipped';

export type CommerceSellerReputationOverview =
  | { status: 'rated'; summary: CommerceReputationSummary }
  | { status: 'new_seller' }
  | { status: 'unavailable' };

/**
 * One checkout line as the fulfillment plumbing needs it (local pickup §A2):
 * the projection facts plus the seller identity and the listing's published
 * methods, so the buyer's per-(seller, fulfillment) group choice can be
 * validated and assigned before submit.
 */
export type CommerceCheckoutLineInput = MarketplaceCheckoutFulfillmentLine & {
  expectedRevision: number;
  quantity: number;
  variantId?: string;
  variantOptions?: { name: string; value: string }[];
};

/**
 * A checkout submission with per-group fulfillment choices. A seller group
 * with no recorded choice ships (the default); a pickup-only checkout sends
 * NO delivery address (§A2).
 */
export type CommerceCheckoutFulfillmentInput = {
  lines: CommerceCheckoutLineInput[];
  fulfillmentChoiceBySeller?: Readonly<Record<string, MarketplaceFulfillmentMethod | undefined>>;
  deliveryAddress?: CreateMarketplaceCheckoutCommand['payload']['deliveryAddress'];
};

/** A review-list page, or the honest signal that no review index serves this deployment. */
export type CommerceIndexedReviewsResult =
  | { status: 'ok'; reviews: CommerceIndexedReview[] }
  | { status: 'unavailable' };

type CommerceListingWithProjection = CommerceListingModelSchema & {
  purchasableQuantity: number | null;
};

function applyInventoryProjection(
  listing: CommerceListingModelSchema,
  projection: CommerceListingProjectionModelSchema | null | undefined,
): CommerceListingWithProjection {
  const recordQuantity = listing.record.variants
    .filter(({ enabled }) => enabled)
    .reduce((total, variant) => total + variant.quantity, 0);
  if (!projection || projection.listing_revision !== listing.revision) {
    return { ...listing, purchasableQuantity: null };
  }
  return {
    ...listing,
    purchasableQuantity: Math.min(recordQuantity, projection.available_quantity),
  };
}

const SELLER_REFRESH_MAX_PAGES = 100;

export class CommerceApplication {
  private constructor() {}

  private static sellerListingsRefreshInFlight = new Map<string, Promise<void>>();

  static async getShop(ownerPubky: string) {
    return await LocalCommerceService.getShop(ownerPubky);
  }

  static async getAllShops() {
    return await LocalCommerceService.getAllShops();
  }

  static async fetchShop(ownerPubky: string): Promise<CommerceShopRecord> {
    const url = CommerceRecordNormalizer.shopUri(ownerPubky);
    return CommerceRecordNormalizer.shop(await CommerceHomeserverService.fetchJson(url));
  }

  static async getOrFetchShop(ownerPubky: string): Promise<CommerceShopRecord> {
    const local = await LocalCommerceService.getShop(ownerPubky);
    if (local) return local.record;

    const record = await this.fetchShop(ownerPubky);
    await LocalCommerceService.upsertShop(record, 'synced');
    return record;
  }

  static async getListing(compositeListingId: string) {
    const listing = await LocalCommerceService.getListing(compositeListingId);
    if (!listing) return listing;
    const projection = await LocalCommerceService.getListingProjection(compositeListingId);
    return applyInventoryProjection(listing, projection);
  }

  /**
   * Reads the locally cached community tag aggregate for a marketplace target.
   *
   * @param kind - `TagKind.LISTING` or `TagKind.SHOP`
   * @param taggedId - Composite `seller:listingId` for listings, owner pubky for shops
   * @returns The cached NexusTag[] aggregate (viewer's own write-through included)
   */
  static async getMarketplaceTags(kind: MarketplaceTagKind, taggedId: string): Promise<NexusTag[]> {
    return await LocalMarketplaceTagService.read(buildMarketplaceTagRowId(kind, taggedId));
  }

  /**
   * Fetches the community tag aggregate for a marketplace target from the
   * marketplace Nexus and merges it into the local cache.
   *
   * Honest degradation: the tag endpoints only exist once the marketplace
   * Nexus deploys tag aggregation. A 404 means "aggregation not available",
   * so this returns an empty array WITHOUT touching the local cache — the
   * viewer's own locally written tags keep rendering, and nothing fake is
   * shown. Any other error propagates.
   *
   * @param params.kind - `TagKind.LISTING` or `TagKind.SHOP`
   * @param params.taggedId - Composite `seller:listingId` for listings, owner pubky for shops
   * @param params.viewerId - Viewer pubky for relationship data, if signed in
   * @param params.skip - Number of tags to skip (pagination)
   * @param params.limit - Maximum number of tags to return
   * @returns Tags returned by Nexus; empty when the endpoint is not deployed (404)
   */
  static async fetchMarketplaceTags({
    kind,
    taggedId,
    viewerId,
    skip,
    limit,
  }: {
    kind: MarketplaceTagKind;
    taggedId: string;
    viewerId?: string;
    skip?: number;
    limit?: number;
  }): Promise<NexusTag[]> {
    let nexusTags: NexusTag[];
    try {
      if (kind === TagKind.LISTING) {
        const [sellerId, listingId] = taggedId.split(':');
        nexusTags = await NexusMarketplaceService.fetchListingTags({
          seller_id: sellerId,
          listing_id: listingId,
          skip_tags: skip,
          limit_tags: limit,
          viewer_id: viewerId,
        });
      } else {
        nexusTags = await NexusMarketplaceService.fetchShopTags({
          seller_id: taggedId,
          skip_tags: skip,
          limit_tags: limit,
          viewer_id: viewerId,
        });
      }
    } catch (error) {
      if (isAppError(error) && isNotFound(error)) {
        return [];
      }
      throw error;
    }

    if (nexusTags.length > 0) {
      await LocalMarketplaceTagService.mergeTags({
        taggedId: buildMarketplaceTagRowId(kind, taggedId),
        tags: nexusTags,
        viewerId: viewerId ?? null,
      });
    }

    return nexusTags;
  }

  static async getListingsBySeller(sellerPubky: string) {
    const listings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    return await Promise.all(
      listings.map(async (listing) =>
        applyInventoryProjection(listing, await LocalCommerceService.getListingProjection(listing.id)),
      ),
    );
  }

  static async cacheMarketplaceListingProjection(projection: CommerceListingProjectionModelSchema): Promise<void> {
    await LocalCommerceService.cacheListingProjection(projection);
  }

  static async getOrFetchListingsBySeller(sellerPubky: string) {
    const listings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    if (listings.length > 0) return listings;

    await this.fetchSellerCatalogListings(sellerPubky);
    const entries = await LocalCommerceService.getCatalogEntriesBySeller(sellerPubky);
    await Promise.all(entries.map((entry) => this.getOrFetchListing(sellerPubky, entry.listing_id)));
    return await LocalCommerceService.getListingsBySeller(sellerPubky);
  }

  /**
   * Refreshes one seller's discovery stream, then hydrates only records that
   * are absent locally or newer than the canonical record already cached.
   * Nexus remains discovery/revision data; the homeserver remains canonical.
   *
   * Concurrent dashboard mounts for the same seller share one bounded pass.
   * Missing entries from the stream are intentionally retained locally:
   * discovery is not the seller's durable inventory authority.
   */
  static async refreshListingsBySeller(sellerPubky: string): Promise<void> {
    // Sandbox catalogs are seeded locally and stay self-contained (same
    // invariant as fetchCatalogListings / fetchSellerCatalogListings):
    // sandbox mode never reads from Nexus, so the refresh is a no-op and
    // the cached rows keep rendering.
    if (getCommerceAdapterMode() === 'sandbox') return;

    const inFlight = this.sellerListingsRefreshInFlight.get(sellerPubky);
    if (inFlight) {
      await inFlight;
      return;
    }

    const refresh = this.runSellerListingsRefresh(sellerPubky);
    this.sellerListingsRefreshInFlight.set(sellerPubky, refresh);
    try {
      await refresh;
    } finally {
      if (this.sellerListingsRefreshInFlight.get(sellerPubky) === refresh) {
        this.sellerListingsRefreshInFlight.delete(sellerPubky);
      }
    }
  }

  private static async runSellerListingsRefresh(sellerPubky: string): Promise<void> {
    const entries = await this.collectSellerCatalogEntries(sellerPubky, { strictIdentity: true, paginate: true });
    const localListings = await LocalCommerceService.getListingsBySeller(sellerPubky);
    const localListingsById = new Map(localListings.map((listing) => [listing.listing_id, listing]));
    const recordsToCommit: CommerceListingRecord[] = [];

    for (const entry of entries) {
      const local = localListingsById.get(entry.listing_id);
      if (local && local.revision >= entry.revision) continue;
      const record = await this.fetchListing(sellerPubky, entry.listing_id);
      if (record.revision < entry.revision) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Canonical listing revision is older than the Nexus discovery revision.',
          {
            service: ErrorService.Marketplace,
            operation: 'refreshListingsBySeller',
            context: { canonicalRevision: record.revision, indexedRevision: entry.revision },
          },
        );
      }
      recordsToCommit.push(record);
    }

    await LocalCommerceService.commitSellerCatalogRefresh(entries, recordsToCommit);
  }

  static async getListingsByCategory(categoryId: string) {
    return await LocalCommerceService.getListingsByCategory(categoryId);
  }

  static async getAllListings() {
    return await LocalCommerceService.getAllListings();
  }

  static async getListingDrafts(ownerPubky: string) {
    return await LocalCommerceService.getDraftsByOwner(ownerPubky);
  }

  static async commitUpdateListingDraft(ownerPubky: string, listingId: string, form: CommerceJsonValue): Promise<void> {
    await LocalCommerceService.upsertDraft({
      ownerId: ownerPubky,
      listingId,
      data: { ownerPubky, listingId, form },
      now: Date.now(),
    });
  }

  static async commitDeleteListingDraft(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.deleteDraft(`${ownerPubky}:${listingId}`);
  }

  static async initializeSandboxCatalog(): Promise<boolean> {
    if (getCommerceAdapterMode() !== 'sandbox') return false;
    const catalog = createCommerceSandboxCatalog();
    const seeded = await LocalCommerceService.seedSandboxCatalog(catalog);
    await Promise.allSettled(catalog.listings.map((listing) => this.registerListing(listing)));
    return seeded;
  }

  static async executeMarketplaceCommand(actorPubky: string, command: MarketplaceCommand) {
    await this.assertSellerAuthorityRoutable(command);
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  // ---------------------------------------------------------------------
  // Local pickup (Wave 7 safe subset, local pickup design PART A)
  //
  // Pickup details are restricted personal data. This layer NEVER writes
  // them to Dexie, a store, or any persistence: the buyer's revealed copy
  // is memory-only and re-fetched from the reveal read on each view (§A1),
  // and the seller's owner-read copy is returned to the caller, which holds
  // it in memory. The only writes are the service commands themselves.
  // ---------------------------------------------------------------------

  /**
   * The client-side deployment boundary for pickup commands (§A8): the
   * sandbox deployment stores and reveals no pickup details, so the commands
   * are refused before any bytes leave the client — the same refusal the
   * durable service answers on sandbox-payments deployments, in the same
   * shape: CONFLICT with the typed `pickup_unavailable` refusal.
   */
  private static assertPickupDeployment(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.CONFLICT, 'Pickup is unavailable on this deployment.', {
        service: ErrorService.Marketplace,
        operation,
        context: { refusal: 'pickup_unavailable' },
      });
    }
  }

  /**
   * Command refusals come back in the response envelope (`ok:false`), not as
   * thrown errors, so the typed pickup refusals (§A3/§A6/§A7) would never
   * reach a caller that branches on `context.refusal` — the entitled reads
   * already throw that shape. Re-throw a classified pickup refusal as the
   * same CONFLICT + `context.refusal` error the reads produce; unclassified
   * failures (revision conflicts, validation) keep the envelope for the
   * caller to handle.
   */
  private static throwIfPickupCommandRefusal(operation: string, response: MarketplaceCommandResponse): void {
    if (response.ok) return;
    const refusal = classifyMarketplacePickupCommandRefusal(response);
    if (!refusal) return;
    throw Err.client(ClientErrorCode.CONFLICT, pickupRefusalFailureMessage(refusal), {
      service: ErrorService.Marketplace,
      operation,
      context: { refusal },
    });
  }

  /**
   * The deployment's `pickup_available` capability (§A7), read from the
   * service's /health surface: false in every non-durable mode and whenever
   * the sealing key is absent or sandbox payments are enabled. 7.2b gates
   * every pickup affordance on this.
   */
  static async fetchPickupAvailable(): Promise<boolean> {
    return await MarketplaceGatewayService.getPickupAvailability();
  }

  /**
   * The paying buyer's per-line pickup-details reveal (§A3): the pinned
   * snapshot recorded at payment, straight from the service's entitled read.
   * The returned details stay IN MEMORY ONLY — they are written to no Dexie
   * table, no store, and no cache, and must be re-fetched on each view.
   */
  static async fetchPickupReveal(actorPubky: string, orderId: string): Promise<MarketplacePickupReveal> {
    return await MarketplaceGatewayService.getOrderPickupDetails(actorPubky, orderId);
  }

  /**
   * The seller's owner read of their own current pickup details plus the
   * surviving version counter (§A4): the input the next
   * `pickup_details.set` compare-and-swaps against.
   */
  static async fetchSellerPickupDetails(
    actorPubky: string,
    listingAggregateId: string,
  ): Promise<MarketplaceSellerPickupDetails> {
    return await MarketplaceGatewayService.getListingPickupDetails(actorPubky, listingAggregateId);
  }

  /**
   * `pickup_details.set` (§A7): sealed whole-payload upsert of a listing's
   * pickup details. `expectedVersion` CASes against the per-listing version
   * counter (0 when no details exist yet); a stale value gets the standard
   * 409 REVISION_CONFLICT refetch-and-retry treatment. The envelope's
   * `expectedRevision` is always 0 — the CAS rides the payload.
   */
  static async commitSetPickupDetails(
    actorPubky: string,
    input: {
      sellerPubky: string;
      listingId: string;
      expectedVersion: number;
      details: MarketplacePickupDetails;
    },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitSetPickupDetails');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'pickup_details.set',
      payload: { expectedVersion: input.expectedVersion, details: input.details },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitSetPickupDetails', response);
    return response;
  }

  /**
   * `pickup_details.clear` (§A3/§A7): removes the listing's pickup details.
   * The service retains only versions pinned by a paid, non-terminal order;
   * the version counter survives, so the next set continues the sequence.
   */
  static async commitClearPickupDetails(
    actorPubky: string,
    input: {
      sellerPubky: string;
      listingId: string;
      expectedVersion: number;
    },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitClearPickupDetails');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(input.sellerPubky, input.listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'pickup_details.clear',
      payload: { expectedVersion: input.expectedVersion },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitClearPickupDetails', response);
    return response;
  }

  /**
   * `fulfillment.mark_ready` (§A6): the seller arms a paid pickup order for
   * handover (`paid` → `ready_for_pickup`). `expectedRevision` is the
   * order's current revision.
   */
  static async commitMarkReady(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitMarkReady');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'fulfillment.mark_ready',
      payload: { orderId: input.orderId },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitMarkReady', response);
    return response;
  }

  /**
   * `fulfillment.confirm_pickup` (§A6): either party confirms the handover
   * (`paid`/`ready_for_pickup` → `delivered`). A seller-actor confirm is
   * refused service-side while a post-payment terms change is unresolved.
   */
  static async commitConfirmPickup(
    actorPubky: string,
    input: { orderId: string; expectedRevision: number },
  ): Promise<MarketplaceCommandResponse> {
    this.assertPickupDeployment('commitConfirmPickup');
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceOrderAggregateId(input.orderId),
      expectedRevision: input.expectedRevision,
      issuedAt: new Date().toISOString(),
      kind: 'fulfillment.confirm_pickup',
      payload: { orderId: input.orderId },
    });
    const response = await this.executeMarketplaceCommand(actorPubky, command);
    this.throwIfPickupCommandRefusal('commitConfirmPickup', response);
    return response;
  }

  /**
   * `checkout.create` with the Wave 7 fulfillment plumbing (§A2): the
   * buyer's per-(seller, fulfillment) group choice is assigned to every
   * line of the group and validated against what each line's listing
   * publishes — a disallowed choice is refused locally with a typed
   * validation error, never silently rewritten to shipping. The delivery
   * address rule is enforced by the command schema (required when any group
   * ships; forbidden on pickup-only checkouts).
   */
  static async commitCreateMarketplaceCheckout(
    actorPubky: string,
    input: CommerceCheckoutFulfillmentInput,
  ): Promise<MarketplaceCommandResponse> {
    const plan = resolveCheckoutFulfillment(input.lines, input.fulfillmentChoiceBySeller ?? {});
    if (!plan.ok) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'A checkout group chooses a fulfillment its listing does not publish.',
        {
          service: ErrorService.Marketplace,
          operation: 'commitCreateMarketplaceCheckout',
          context: {
            sellerPubky: plan.sellerPubky,
            fulfillment: plan.fulfillment,
            listingAggregateId: plan.listingAggregateId,
          },
        },
      );
    }
    const commandId = crypto.randomUUID();
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId,
      aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create',
      payload: {
        lines: input.lines.map((line, index) => ({
          listingAggregateId: line.listingAggregateId,
          expectedRevision: line.expectedRevision,
          quantity: line.quantity,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.variantOptions && line.variantOptions.length > 0 ? { variantOptions: line.variantOptions } : {}),
          fulfillment: plan.lineFulfillments[index],
        })),
        ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
        guaranteePolicyVersion: 1 as const,
      },
    });
    return await this.executeMarketplaceCommand(actorPubky, command);
  }

  /**
   * The multi-operator mismatch guard (docs/ecommerce/multi-operator.md,
   * increment 1). A seller's shop record may declare the transaction-service
   * authority it sells through (`shop.transactionService`, specs
   * `0.6.2-marketplace.7`). This client cannot route to arbitrary services
   * yet, so when a listing-aggregate command targets a seller whose declared
   * authority is a DIFFERENT origin than this deployment's configured
   * service, the command is refused with an honest message — instead of
   * silently registering the seller's listing into an authority they never
   * declared.
   *
   * Deliberately fail-open on absence: no shop record, no declared field, an
   * unreadable homeserver, or a sandbox deployment all keep today's
   * behavior. The declaration is the seller's routing statement, not a
   * security boundary — the transaction service authenticates actors itself.
   */
  private static async assertSellerAuthorityRoutable(command: MarketplaceCommand): Promise<void> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return;
    const aggregateId = typeof command.aggregateId === 'string' ? command.aggregateId : '';
    if (!aggregateId.startsWith('listing:')) return;
    const sellerPubky = aggregateId.slice('listing:'.length, 'listing:'.length + 52);
    if (sellerPubky.length !== 52) return;

    let declared: string | undefined;
    try {
      declared = (await this.getOrFetchShop(sellerPubky)).transactionService;
    } catch {
      return;
    }
    if (!declared) return;

    const configured = getMarketplaceUrl();
    let declaredOrigin: string;
    let configuredOrigin: string;
    try {
      declaredOrigin = new URL(declared).origin;
      configuredOrigin = new URL(configured).origin;
    } catch {
      return;
    }
    if (declaredOrigin === configuredOrigin) return;

    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      `This seller sells through a different marketplace service (${declaredOrigin}). This deployment routes commerce to ${configuredOrigin} and cannot transact with their shop yet.`,
      {
        service: ErrorService.Marketplace,
        operation: 'assertSellerAuthorityRoutable',
        context: { sellerPubky, declaredOrigin, configuredOrigin, kind: command.kind },
      },
    );
  }

  /**
   * Starts the interactive Marketplace Transaction Service session flow:
   * returns the `pubkyauth://` authorization URL to hand to the user's signer
   * (QR or deeplink) plus a lazy `awaitSession` that resolves once the signer
   * approves and the AuthToken is exchanged for a bearer session. AuthTokens
   * are single-use, so every retry must come back through here for a fresh
   * flow. Durable modes only; the service fails closed otherwise.
   */
  static beginMarketplaceSessionFlow() {
    return MarketplaceSessionService.beginSessionFlow();
  }

  static currentHomeserverGrantIsFull(): boolean {
    return HomeserverService.currentSessionHasFullGrant();
  }

  /**
   * Restores the account-scoped marketplace session persisted in
   * `localStorage`, returning its public facts (never the token) or null
   * when nothing valid is persisted for this account.
   */
  static restoreMarketplaceSession(pubky: string) {
    return MarketplaceSessionService.restorePersistedSession(pubky);
  }

  /**
   * Drops the Marketplace Transaction Service session from memory and from
   * `localStorage`. Part of the sign-out teardown: the bearer token must not
   * survive the user it was minted for (this is the single cleanup point).
   * The published-receipt memo backs the user-visible `published` status, so
   * it is cleared here too — session teardown matches the store reset, and a
   * later account re-reads its receipts instead of trusting a prior session.
   */
  static clearMarketplaceSession(): void {
    MarketplaceSessionService.clearSession('cleared');
    this.publishedReceiptUrls.clear();
  }

  /**
   * Controllers subscribe here so a transport-side `clearSession` (TTL, 401,
   * sign-out) can null the zustand copy without the service touching stores.
   */
  static onMarketplaceSessionEnded(listener: (event: MarketplaceSessionEndedEvent) => void): () => void {
    return MarketplaceSessionService.onSessionEnded(listener);
  }

  /**
   * True while `MarketplaceSessionService.getActiveSession()` still holds a
   * token inside the expiry margin. Callers must not duplicate that TTL rule.
   */
  static hasActiveMarketplaceSession(): boolean {
    return MarketplaceSessionService.getActiveSession() !== null;
  }

  static async getMarketplaceListingProjection(actorPubky: string | null, aggregateId: string) {
    return await MarketplaceGatewayService.getListing(actorPubky, aggregateId);
  }

  static async getMarketplaceListingBids(actorPubky: string | null, aggregateId: string) {
    return await MarketplaceGatewayService.getListingBids(actorPubky, aggregateId);
  }

  static async getMarketplaceConversations(actorPubky: string) {
    return await MarketplaceGatewayService.getConversations(actorPubky);
  }

  static async getMarketplaceOffers(actorPubky: string) {
    return await MarketplaceGatewayService.getOffers(actorPubky);
  }

  static async getMarketplaceNotifications(actorPubky: string) {
    return await MarketplaceGatewayService.getNotifications(actorPubky);
  }

  static async getMarketplaceNotificationPreferences(actorPubky: string) {
    return await MarketplaceGatewayService.getNotificationPreferences(actorPubky);
  }

  static async getMarketplaceOrders(actorPubky: string) {
    return await MarketplaceGatewayService.getOrders(actorPubky);
  }

  static async getMarketplacePayment(actorPubky: string, paymentId: string) {
    return await MarketplaceGatewayService.getPayment(actorPubky, paymentId);
  }

  // --- Seller-configurable payment methods (durable service only) ----------

  static async getSellerPaymentConfig(sellerPubky: string) {
    return await MarketplaceGatewayService.getSellerPaymentConfig(sellerPubky);
  }

  static async getMyPaymentConfig(actorPubky: string) {
    return await MarketplaceGatewayService.getMyPaymentConfig(actorPubky);
  }

  static async putMyPaymentConfig(
    actorPubky: string,
    input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string | null;
      stripeRestrictedKey?: string;
      paypalMerchantEmail: string | null;
    },
  ) {
    return await MarketplaceGatewayService.putMyPaymentConfig(actorPubky, input);
  }

  static async bindPaymentMethod(actorPubky: string, orderId: string, method: PaymentMethodKind) {
    return await MarketplaceGatewayService.bindPaymentMethod(actorPubky, orderId, method);
  }

  static async verifyStripePayment(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.verifyStripePayment(actorPubky, orderId);
  }

  static async markFiatPaid(actorPubky: string, orderId: string, transactionRef?: string) {
    return await MarketplaceGatewayService.markFiatPaid(actorPubky, orderId, transactionRef);
  }

  static async getMyShippingConfig(actorPubky: string) {
    return await MarketplaceGatewayService.getMyShippingConfig(actorPubky);
  }

  static async putMyShippingConfig(
    actorPubky: string,
    input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null },
  ) {
    return await MarketplaceGatewayService.putMyShippingConfig(actorPubky, input);
  }

  static async quoteShippingRates(actorPubky: string, orderId: string, parcel: ShippingParcel) {
    return await MarketplaceGatewayService.quoteShippingRates(actorPubky, orderId, parcel);
  }

  static async purchaseShippingLabel(actorPubky: string, orderId: string, rateId: string) {
    return await MarketplaceGatewayService.purchaseShippingLabel(actorPubky, orderId, rateId);
  }

  static async getShippingLabel(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.getShippingLabel(actorPubky, orderId);
  }

  static async confirmFiatReceived(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.confirmFiatReceived(actorPubky, orderId);
  }

  /**
   * Manual watch-only account claim against paykit-server — the same
   * registration Bitkit performs, driven by a pasted xpub plus a
   * claim-scoped signer approval. The identity secret never enters the app.
   */
  static beginPaykitClaimFlow(accountXpub: string) {
    return MarketplacePaykitClaimService.beginClaimFlow(accountXpub);
  }

  static async isPaykitAccountClaimed(pubky: string) {
    return await MarketplacePaykitClaimService.isAccountClaimed(pubky);
  }

  static async getMarketplaceReceipt(actorPubky: string, receiptId: string) {
    return await MarketplaceGatewayService.getReceipt(actorPubky, receiptId);
  }

  static async getMarketplaceOrder(actorPubky: string, orderId: string) {
    return await MarketplaceGatewayService.getOrder(actorPubky, orderId);
  }

  static async uploadMarketplaceAttachment(actorPubky: string, recipientPubky: string, file: File) {
    return await MarketplaceGatewayService.uploadAttachment(actorPubky, recipientPubky, file);
  }

  static async fetchMarketplaceAttachment(actorPubky: string, attachmentId: string) {
    return await MarketplaceGatewayService.fetchAttachment(actorPubky, attachmentId);
  }

  static async submitLocksPaykitProof(params: {
    creatorPubky: string;
    readerPubky: string;
    bundleId: string;
    lockResource: string;
    criterionId: string;
  }) {
    return await LocksGatewayService.submitPaykitProof(params);
  }

  /**
   * The buyer's side of a real Locks/Paykit payment (`locks-paykit` mode):
   *
   * 1. Generate (or reuse a persisted, not-yet-registered) bundle id and
   *    submit the proof bundle to the Lock Server, which requests the real
   *    Paykit invoice and delivers the private Payment Request to the buyer's
   *    wallet.
   * 2. Register the correlation with the transaction service via
   *    `payment.register_locks`, sourcing `expected_revision` from the fresh
   *    payment projection the caller just read.
   *
   * This NEVER advances the payment: registration flips the payment to the
   * `locks` adapter and the service's worker independently verifies the Locks
   * lifecycle before confirming (ADR-0019 §7). Returns the raw command
   * response so callers can apply the standard revision-conflict handling
   * (refetch and retry). The correlation — including the bearer bundle id —
   * is persisted in the buyer's account-scoped database so the flow survives
   * a reload and the purchased content stays unlockable.
   */
  static async beginMarketplaceLocksPayment({
    buyerPubky,
    order,
    payment,
    digitalLock,
  }: {
    buyerPubky: string;
    order: MarketplaceOrder;
    payment: MarketplacePayment;
    digitalLock: CommerceDigitalLock;
  }): Promise<MarketplaceCommandResponse> {
    if (getCommerceAdapterMode() !== 'locks-paykit') {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Real Locks/Paykit payments are not enabled in this deployment.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }
    const creator = lockPolicyCreator(digitalLock.policyUri);
    const bareLockResource = toBareLockResource(digitalLock.policyUri);
    if (!creator || !bareLockResource) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The listing carries an invalid Locks policy URI.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }
    if (creator !== order.sellerPubky) {
      // The service enforces this too; refusing here keeps a mismatched lock
      // from ever producing an upstream lifecycle.
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'The lock creator is not this order\u2019s seller.', {
        service: ErrorService.Locks,
        operation: 'beginMarketplaceLocksPayment',
      });
    }

    const existing = await LocalCommerceService.getLocksCorrelation(buyerPubky, payment.id);
    let bundleId = existing?.bundle_id;
    if (!existing) {
      bundleId = await LocksGatewayService.generateBundleId();
      await LocksGatewayService.submitPaykitProof({
        creatorPubky: creator,
        readerPubky: buyerPubky,
        bundleId,
        lockResource: digitalLock.policyUri,
        criterionId: digitalLock.criterionId,
      });
      // Persist BEFORE registration: the bundle id is the buyer's only handle
      // on the upstream lifecycle, so losing it between the two steps would
      // orphan the payment request.
      await LocalCommerceService.upsertLocksCorrelation({
        owner_id: buyerPubky,
        payment_id: payment.id,
        order_id: order.id,
        seller_pubky: creator,
        bundle_id: bundleId,
        policy_uri: digitalLock.policyUri,
        criterion_id: digitalLock.criterionId,
        content_path: digitalLock.contentPath,
        resource_hash: digitalLock.resourceHash,
        window_expires_at: null,
        registered: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    const response = await MarketplaceGatewayService.execute(buyerPubky, {
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplacePaymentAggregateId(payment.id),
      expectedRevision: payment.revision,
      issuedAt: new Date().toISOString(),
      kind: 'payment.register_locks',
      payload: { paymentId: payment.id, bundleId: bundleId!, pubkyLockResource: bareLockResource },
    });
    if (response.ok) {
      const verification = (response.result as { verification?: { windowExpiresAt?: string } }).verification;
      await LocalCommerceService.markLocksCorrelationRegistered(
        buyerPubky,
        payment.id,
        verification?.windowExpiresAt ?? null,
        Date.now(),
      );
    }
    return response;
  }

  static async getMarketplaceLocksCorrelation(buyerPubky: string, paymentId: string) {
    return await LocalCommerceService.getLocksCorrelation(buyerPubky, paymentId);
  }

  /**
   * Redeems a confirmed Locks payment for the purchased digital content:
   * issues the short-lived access credential from the persisted bundle id,
   * reads the guarded bytes through the Lock Server proxy, and verifies their
   * BLAKE3 hash against the hash the seller published in the listing record.
   * A hash mismatch is a content-integrity failure and throws — the bytes are
   * never returned as if they were the purchased content.
   */
  static async unlockMarketplaceLocksContent(
    buyerPubky: string,
    paymentId: string,
  ): Promise<{ bytes: Uint8Array; contentPath: string }> {
    const correlation = await LocalCommerceService.getLocksCorrelation(buyerPubky, paymentId);
    if (!correlation) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'No Locks correlation is stored for this payment.', {
        service: ErrorService.Locks,
        operation: 'unlockMarketplaceLocksContent',
      });
    }
    const credential = await LocksGatewayService.issueAccessCredential(correlation.seller_pubky, correlation.bundle_id);
    const blob = await LocksGatewayService.fetchGuardedContent(correlation.content_path, credential.credential);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = bytesToHex(blake3(bytes));
    if (digest !== correlation.resource_hash) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'The delivered content does not match the listed hash.', {
        service: ErrorService.Locks,
        operation: 'unlockMarketplaceLocksContent',
        context: { contentPath: correlation.content_path },
      });
    }
    return { bytes, contentPath: correlation.content_path };
  }

  /**
   * Exchanges a Lock Server legacy-connect completion (`code`/`state` on the
   * return URL) for a creator frontend session — the seller-setup "connected"
   * proof. The bearer token stays with the caller, in memory.
   */
  static async createLocksFrontendSession(code: string, state: string) {
    return await LocksGatewayService.createFrontendSession(code, state);
  }

  static async lookupLocksVerification(creatorPubky: string, bundleId: string) {
    return await LocksGatewayService.lookupVerification(creatorPubky, bundleId);
  }

  static async issueLocksAccessCredential(creatorPubky: string, bundleId: string) {
    return await LocksGatewayService.issueAccessCredential(creatorPubky, bundleId);
  }

  static async fetchLocksGuardedContent(relativePath: string, credential: string) {
    return await LocksGatewayService.fetchGuardedContent(relativePath, credential);
  }

  static getPaykitSetupUrl(returnTo: string, state: string) {
    return LocksGatewayService.buildPaykitSetupUrl(returnTo, state);
  }

  /**
   * BTC/USD rate for the indicative "≈" price estimates shown beside listing
   * prices. Display-only: nothing transactional consumes this rate, and it
   * throws when unavailable so the UI shows no estimate instead of a stale
   * or invented number.
   */
  static async getIndicativeBtcRate() {
    return await ExchangerateService.getIndicativeBtcRate();
  }

  static async isFavorite(ownerPubky: string, listingId: string): Promise<boolean> {
    return await LocalCommerceService.isFavorite(ownerPubky, listingId);
  }

  static async getCartItems(ownerPubky: string) {
    return await LocalCommerceService.getCartItems(ownerPubky);
  }

  static async commitUpsertCartItem(
    ownerPubky: string,
    listingId: string,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    await LocalCommerceService.upsertCartItem(ownerPubky, listingId, variantId, quantity, Date.now());
  }

  static async commitDeleteCartItem(ownerPubky: string, listingId: string, variantId: string): Promise<void> {
    await LocalCommerceService.deleteCartItem(ownerPubky, listingId, variantId);
  }

  static async commitClearCart(ownerPubky: string): Promise<void> {
    await LocalCommerceService.clearCart(ownerPubky);
  }

  static async getDeliveryAddresses(ownerPubky: string) {
    return await LocalCommerceService.getDeliveryAddresses(ownerPubky);
  }

  static async commitUpsertDeliveryAddress(
    ownerPubky: string,
    addressId: string,
    input: CommerceDeliveryAddressInput,
  ): Promise<void> {
    await LocalCommerceService.upsertDeliveryAddress(ownerPubky, addressId, input, Date.now());
  }

  static async commitDeleteDeliveryAddress(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.deleteDeliveryAddress(ownerPubky, addressId);
  }

  static async commitSetDefaultDeliveryAddress(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.setDefaultDeliveryAddress(ownerPubky, addressId, Date.now());
  }

  static async commitMarkDeliveryAddressUsed(ownerPubky: string, addressId: string): Promise<void> {
    await LocalCommerceService.markDeliveryAddressUsed(ownerPubky, addressId, Date.now());
  }

  static async getShippingPresets(ownerPubky: string) {
    return await LocalCommerceService.getShippingPresets(ownerPubky);
  }

  static async commitUpsertShippingPreset(
    ownerPubky: string,
    presetId: string,
    input: CommerceShippingPresetInput,
  ): Promise<void> {
    await LocalCommerceService.upsertShippingPreset(ownerPubky, presetId, input, Date.now());
  }

  static async commitDeleteShippingPreset(ownerPubky: string, presetId: string): Promise<void> {
    await LocalCommerceService.deleteShippingPreset(ownerPubky, presetId);
  }

  static async getFavorites(ownerPubky: string) {
    return await LocalCommerceService.getFavorites(ownerPubky);
  }

  static async commitCreateFavorite(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.createFavorite(ownerPubky, listingId, Date.now());
    await this.stageWatchlistPush(ownerPubky);
  }

  static async commitDeleteFavorite(ownerPubky: string, listingId: string): Promise<void> {
    await LocalCommerceService.deleteFavorite(ownerPubky, listingId, Date.now());
    // The watch baseline shadows the favorite row; an unwatched item must not
    // keep producing alerts. Already-created alerts stay — they were real
    // observations made while the item was watched.
    await LocalCommerceService.deleteWatchSnapshot(ownerPubky, listingId);
    await this.stageWatchlistPush(ownerPubky);
  }

  // ---------------------------------------------------------------------------
  // Cross-device watchlist sync (PRIVATE homeserver document)
  // ---------------------------------------------------------------------------

  /** In-flight sync per owner, so overlapping triggers share one round-trip. */
  private static watchlistSyncInFlight = new Map<string, Promise<CommerceWatchlistSyncStatus>>();

  private static watchlistSyncJobId(ownerPubky: string): string {
    return `watchlist|${ownerPubky}`;
  }

  /**
   * Marks the private watchlist document dirty in the retryable outbox
   * (`commerce_sync_jobs`, same table the review outbox uses). The job id is
   * deterministic per owner because the document is whole-state — the latest
   * sync always carries every prior change, so one pending job coalesces any
   * number of toggles. Local-first: this stages only; the actual push is
   * triggered by the controller after the toggle, and any staged job that
   * outlives a failed push heals on the next watchlist sync.
   */
  private static async stageWatchlistPush(ownerPubky: string): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;
    const now = Date.now();
    await LocalCommerceService.upsertSyncJob({
      id: this.watchlistSyncJobId(ownerPubky),
      owner_id: ownerPubky,
      entity_type: 'watchlist',
      entity_id: ownerPubky,
      operation: 'update',
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      last_error_code: null,
      payload: {},
      created_at: now,
      updated_at: now,
    });
  }

  /**
   * Whether the CURRENT session can use private watchlist sync, decided from
   * session facts (`session.info.capabilities`), never by probing for 403s:
   * - `capable` — the session's grant covers writing `/priv/pubky.app/`
   *   (the widened Ring grant, or the root `/:rw` of a recovery-phrase sign-in)
   * - `needs_reauth` — a live session whose grant predates the `/priv` scope;
   *   the user must approve a fresh sign-in for sync to work
   * - `no_session` — signed out or the session is still being restored
   */
  static getWatchlistSyncCapability(): CommerceWatchlistSyncCapability {
    if (!HomeserverService.hasActiveSession()) return 'no_session';
    return HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH) ? 'capable' : 'needs_reauth';
  }

  /**
   * One full sync round of the private watchlist document: pull, merge,
   * apply locally, push back when the merge changed the remote.
   *
   * Local-first: Dexie is applied before any push, and a failed push leaves
   * the outbox job pending so the next sync heals it. The merge rule
   * (per-key LWW, tie -> tombstone) lives in `commerce.watchlist.ts`.
   *
   * Honesty contract: capability is decided from session facts up front, and
   * a 401/403 on the actual read or write ALSO returns `needs_reauth` — the
   * caller (controller) surfaces that state; nothing silently no-ops.
   */
  static async syncWatchlist(ownerPubky: string): Promise<CommerceWatchlistSyncStatus> {
    if (getCommerceAdapterMode() === 'sandbox') return 'skipped';

    const capability = this.getWatchlistSyncCapability();
    if (capability === 'no_session') return 'skipped';
    if (capability === 'needs_reauth') return 'needs_reauth';

    const inFlight = this.watchlistSyncInFlight.get(ownerPubky);
    if (inFlight) return await inFlight;

    const run = this.runWatchlistSync(ownerPubky).finally(() => {
      this.watchlistSyncInFlight.delete(ownerPubky);
    });
    this.watchlistSyncInFlight.set(ownerPubky, run);
    return await run;
  }

  private static async runWatchlistSync(ownerPubky: string): Promise<CommerceWatchlistSyncStatus> {
    const url = CommerceRecordNormalizer.watchlistUri(ownerPubky);
    try {
      let remote: CommerceWatchlistRecord | null = null;
      try {
        const payload = await CommerceHomeserverService.fetchJson(url);
        remote = CommerceRecordNormalizer.watchlistRecord(payload);
      } catch (error) {
        if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
        if (!(isAppError(error) && isNotFound(error))) throw error;
      }

      const [favorites, tombstoneRows] = await Promise.all([
        LocalCommerceService.getFavorites(ownerPubky),
        LocalCommerceService.getWatchTombstones(ownerPubky),
      ]);
      const localState = localRowsToWatchlistState(favorites, tombstoneRows);
      const remoteState = remote ? watchlistRecordToState(remote) : emptyWatchlistState();
      const merged = mergeWatchlistStates(localState, remoteState);

      if (!watchlistStatesEqual(merged, localState)) {
        await LocalCommerceService.applyWatchlistState(ownerPubky, merged.items, merged.tombstones);
      }

      const isEmptyAndUnpublished = !remote && merged.items.size === 0 && merged.tombstones.size === 0;
      const remoteNeedsWrite = !isEmptyAndUnpublished && (!remote || !watchlistStatesEqual(merged, remoteState));
      if (remoteNeedsWrite) {
        const nowIso = new Date().toISOString();
        const createdAt = remote?.createdAt ?? nowIso;
        // Guard against clock skew between devices: updatedAt must not
        // precede createdAt or the record fails its own validation.
        const updatedAt = Date.parse(createdAt) > Date.now() ? createdAt : nowIso;
        const body = watchlistStateToRecordBody({
          ownerPubky,
          state: merged,
          revision: (remote?.revision ?? 0) + 1,
          createdAt,
          updatedAt,
        });
        // Validate through the vendored specs builder before the PUT, the
        // same guarantee every other published marketplace record gets.
        const { PubkySpecsBuilder } = await import('pubky-app-specs');
        const built = new PubkySpecsBuilder(ownerPubky).createWatchlist(body);
        const record = CommerceRecordNormalizer.watchlistRecord(built.watchlist.toJson());
        try {
          await CommerceHomeserverService.putJson(url, { ...record });
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          throw error;
        }
      }

      await LocalCommerceService.completeSyncJob(this.watchlistSyncJobId(ownerPubky));
      return 'synced';
    } catch (error) {
      Logger.warn('Watchlist sync failed; the outbox job stays pending', { url, error });
      return 'error';
    }
  }

  /** 403 (scope refused) or 401 (session rejected) on the private document. */
  private static isPrivateAccessDenied(error: unknown): boolean {
    return hasHttpStatus(error, HttpStatusCode.FORBIDDEN) || hasHttpStatus(error, HttpStatusCode.UNAUTHORIZED);
  }

  // ---------------------------------------------------------------------
  // Portable order receipts (PRIVATE homeserver documents)
  // ---------------------------------------------------------------------

  /**
   * Session-scoped memo of receipt URLs confirmed present on the owner's
   * homeserver, so one browsing session re-reads each private receipt path
   * at most once. Keyed by the full owner-scoped URL, so an account switch
   * cannot bleed publication state across identities.
   */
  private static publishedReceiptUrls = new Set<string>();

  /** Test support: clears the session-scoped published-receipt memo. */
  static resetReceiptPublicationMemo(): void {
    this.publishedReceiptUrls.clear();
  }

  /**
   * Publishes the portable order receipt for every eligible paid order to
   * the CURRENT user's own homeserver
   * (`/priv/pubky.app/marketplace/v1/receipts/{receiptId}`, specs
   * `0.6.2-marketplace.7`) — the "credible exit for orders" record: killing
   * the marketplace operator must still leave a signed, verifiable purchase
   * history on the participants' homeservers.
   *
   * The document embeds the service attestor's deterministic
   * `pubky-order-receipt+v1` JWS (re-fetchable idempotently), and the
   * record's fields are taken from the VERIFIED claims, never from local
   * projections, so record and attestation cannot disagree. The client
   * re-runs the offline verification recipe before every PUT and refuses to
   * publish anything that does not verify.
   *
   * Failure semantics mirror the watchlist document: capability is decided
   * from session facts, absence of an attestor is an honest `unavailable`,
   * and a failed PUT simply retries on the next orders-surface load (the
   * homeserver read is the durable "already published" check — no local
   * marker table to drift). The returned status is what the controller
   * mirrors into the store: a narrow (bridged or legacy) grant reports
   * `needs_reauth` instead of returning without a trace.
   */
  static async publishOrderReceipts(
    ownerPubky: string,
    orders: MarketplaceOrder[],
  ): Promise<CommerceReceiptPublicationStatus> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return 'skipped';
    if (!HomeserverService.hasActiveSession()) return 'skipped';
    if (!HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH)) return 'needs_reauth';

    const eligible = orders.filter(
      (order) =>
        typeof order.receiptId === 'string' && (order.buyerPubky === ownerPubky || order.sellerPubky === ownerPubky),
    );

    for (const order of eligible) {
      const receiptId = order.receiptId as string;
      const url = CommerceRecordNormalizer.orderReceiptUri(ownerPubky, receiptId);
      if (this.publishedReceiptUrls.has(url)) continue;
      try {
        try {
          await CommerceHomeserverService.fetchJson(url);
          this.publishedReceiptUrls.add(url);
          continue;
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          if (!(isAppError(error) && isNotFound(error))) throw error;
        }

        const attestation = await MarketplaceGatewayService.getReceiptAttestation(ownerPubky, receiptId);
        if (attestation === null) return 'unavailable';

        // Drop orders additionally carry a `pubky-drop-edition+v1` proof
        // ("edition N of M") in the same portable document (ADR 0026). Its
        // absence for a non-drop order is honest, not a failure.
        const editionAttestation =
          typeof order.dropAggregateId === 'string'
            ? await MarketplaceGatewayService.getEditionAttestation(ownerPubky, receiptId)
            : null;

        const { claims } = attestation;
        const body = {
          schemaVersion: 1,
          recordType: 'order_receipt',
          ownerPubky,
          revision: 1,
          createdAt: claims.paidAt,
          updatedAt: claims.paidAt,
          role: claims.buyer === ownerPubky ? 'buyer' : 'seller',
          receiptId: claims.receipt,
          orderId: claims.order,
          buyerPubky: claims.buyer,
          sellerPubky: claims.seller,
          total: { amountMinor: claims.totalMinor, currency: claims.currency, exponent: claims.exponent },
          paidAt: claims.paidAt,
          receiptAttestation: attestation.jws,
          ...(editionAttestation !== null
            ? {
                editionAttestation: editionAttestation.jws,
                drop: {
                  dropId: editionAttestation.claims.drop,
                  edition: editionAttestation.claims.edition,
                  of: editionAttestation.claims.of,
                },
              }
            : {}),
        };
        const { PubkySpecsBuilder } = await import('pubky-app-specs');
        const built = new PubkySpecsBuilder(ownerPubky).createMarketplaceOrderReceipt(body);
        const record = CommerceRecordNormalizer.orderReceiptRecord(built.order_receipt.toJson());
        if (verifyOwnOrderReceipt({ ...record }) === null) {
          Logger.warn('Refusing to publish an order receipt whose attestation does not verify', { url });
          continue;
        }
        if (record.editionAttestation !== undefined && verifyOwnDropEdition({ ...record }) === null) {
          Logger.warn('Refusing to publish an order receipt whose edition attestation does not verify', { url });
          continue;
        }
        try {
          await CommerceHomeserverService.putJson(url, { ...record });
        } catch (error) {
          if (this.isPrivateAccessDenied(error)) return 'needs_reauth';
          throw error;
        }
        this.publishedReceiptUrls.add(url);
      } catch (error) {
        Logger.warn('Order receipt publication failed; it will retry on the next orders load', { url, error });
      }
    }

    // A receipt that failed mid-flight (logged above) retries on the next
    // orders-surface load; report that honestly instead of claiming done.
    const hasUnpublished = eligible.some(
      (order) =>
        !this.publishedReceiptUrls.has(CommerceRecordNormalizer.orderReceiptUri(ownerPubky, order.receiptId as string)),
    );
    return hasUnpublished ? 'unavailable' : 'published';
  }

  static async getWatchAlerts(ownerPubky: string): Promise<CommerceWatchAlertModelSchema[]> {
    return await LocalCommerceService.getWatchAlerts(ownerPubky);
  }

  static async getWatchSnapshots(ownerPubky: string): Promise<CommerceWatchSnapshotModelSchema[]> {
    return await LocalCommerceService.getWatchSnapshots(ownerPubky);
  }

  static async markWatchAlertsSeen(ownerPubky: string): Promise<void> {
    await LocalCommerceService.markWatchAlertsSeen(ownerPubky, Date.now());
  }

  static async getActivityReadCheckpoint(ownerPubky: string): Promise<number> {
    return await LocalCommerceService.getActivityReadCheckpoint(ownerPubky);
  }

  static async markActivityRead(ownerPubky: string): Promise<void> {
    await LocalCommerceService.markActivityRead(ownerPubky, Date.now());
  }

  /**
   * One bounded watchlist detection pass: re-observes the most recently
   * watched items and derives alerts from what actually changed against the
   * persisted per-item baselines (see `detectWatchAlerts` for the honesty
   * rules).
   *
   * Observation sources, per item:
   *
   * - Index: a per-listing Nexus read (`v0/listing/{seller}/{listing}`) —
   *   revision, price, state, auction deadline. Sandbox mode reads the
   *   locally seeded catalog instead (the sandbox never queries Nexus).
   *   Fresh Nexus rows are folded into the catalog cache, so the watchlist
   *   page renders the same freshness the detection observed.
   * - Projection: the transaction service's public listing projection —
   *   current bid, bid count, leader, sale state. Transactional modes only;
   *   a missing session or unreachable service yields no observation, never
   *   a fabricated one.
   *
   * An item where both reads failed is skipped entirely: no observation, no
   * claim, and the baseline stays where it was. The whole pass is bounded to
   * {@link COMMERCE_WATCH_CHECK_MAX_ITEMS} items and the caller enforces
   * spacing between passes — there is no background daemon.
   */
  static async runWatchlistDetection(ownerPubky: string): Promise<{ alertCount: number }> {
    const adapterMode = getCommerceAdapterMode();
    const favorites = await LocalCommerceService.getFavorites(ownerPubky);
    const watched = favorites.slice(-COMMERCE_WATCH_CHECK_MAX_ITEMS).reverse();
    if (watched.length === 0) return { alertCount: 0 };

    const baselines = new Map(
      (await LocalCommerceService.getWatchSnapshots(ownerPubky)).map((snapshot) => [snapshot.listing_id, snapshot]),
    );
    const now = Date.now();
    const freshEntries: CommerceCatalogEntryModelSchema[] = [];

    const observations = await Promise.all(
      watched.map(async (favorite): Promise<WatchObservation> => {
        const listingId = favorite.listing_id;
        const separator = listingId.indexOf(':');
        const sellerId = listingId.slice(0, separator);
        const id = listingId.slice(separator + 1);

        const [index, projection] = await Promise.all([
          this.observeWatchIndex(adapterMode, sellerId, id, listingId, freshEntries),
          this.observeWatchProjection(adapterMode, ownerPubky, sellerId, id),
        ]);
        return { ownerId: ownerPubky, listingId, sellerId, observedAt: now, index, projection };
      }),
    );

    const snapshots: CommerceWatchSnapshotModelSchema[] = [];
    const alerts: CommerceWatchAlertModelSchema[] = [];
    for (const observation of observations) {
      if (!observation.index && !observation.projection) continue;
      const result = detectWatchAlerts(baselines.get(observation.listingId) ?? null, observation, {
        endingSoonThresholdMs: COMMERCE_WATCH_ENDING_SOON_THRESHOLD_MS,
      });
      snapshots.push(result.snapshot);
      alerts.push(...result.alerts);
    }

    if (freshEntries.length > 0) {
      await LocalCommerceService.bulkUpsertCatalogEntries(freshEntries);
    }
    await LocalCommerceService.saveWatchDetection(ownerPubky, snapshots, alerts);
    return { alertCount: alerts.length };
  }

  private static async observeWatchIndex(
    adapterMode: ReturnType<typeof getCommerceAdapterMode>,
    sellerId: string,
    id: string,
    listingId: string,
    freshEntries: CommerceCatalogEntryModelSchema[],
  ): Promise<WatchIndexObservation | null> {
    if (adapterMode === 'sandbox') {
      // The sandbox catalog is seeded locally and never queries Nexus; its
      // local rows are the only index-shaped source that exists in this mode.
      const entry = await LocalCommerceService.getCatalogEntry(listingId);
      if (entry) {
        return {
          revision: entry.revision,
          state: entry.state,
          priceMinor: entry.price.amountMinor,
          currency: entry.price.currency,
          exponent: entry.price.exponent,
          auctionEndsAt: entry.auction?.endsAt ?? null,
          title: entry.title,
        };
      }
      const listing = await LocalCommerceService.getListing(listingId);
      if (!listing) return null;
      const record = listing.record;
      const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
      return {
        revision: listing.revision,
        state: listing.state,
        priceMinor: price.amountMinor,
        currency: price.currency,
        exponent: price.exponent,
        auctionEndsAt: record.sale.format === 'auction' ? record.sale.endsAt : null,
        title: record.title,
      };
    }

    try {
      const entry = CommerceRecordNormalizer.nexusListingDetails(
        await NexusMarketplaceService.fetchListingDetails({ seller_id: sellerId, listing_id: id }),
      );
      freshEntries.push(entry);
      return {
        revision: entry.revision,
        state: entry.state,
        priceMinor: entry.price.amountMinor,
        currency: entry.price.currency,
        exponent: entry.price.exponent,
        auctionEndsAt: entry.auction?.endsAt ?? null,
        title: entry.title,
      };
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error))) {
        Logger.warn('Failed to observe a watched listing on the Nexus index', { listing: listingId, error });
      }
      // 404 (never/no-longer indexed) and transport failures alike: nothing
      // was observed, so nothing may be claimed.
      return null;
    }
  }

  private static async observeWatchProjection(
    adapterMode: ReturnType<typeof getCommerceAdapterMode>,
    ownerPubky: string,
    sellerId: string,
    id: string,
  ): Promise<WatchProjectionObservation | null> {
    if (!isTransactionalCommerceMode(adapterMode)) return null;
    try {
      const projection = await MarketplaceGatewayService.getListing(
        ownerPubky,
        buildMarketplaceListingAggregateId(sellerId, id),
      );
      if (!projection) return null;
      return {
        serverRevision: projection.serverRevision,
        state: projection.state,
        auction: projection.auction
          ? {
              endsAt: projection.auction.endsAt,
              currentPriceMinor: projection.auction.currentPrice.amountMinor,
              currency: projection.auction.currentPrice.currency,
              exponent: projection.auction.currentPrice.exponent,
              bidCount: projection.auction.bidCount,
              leaderPubky: projection.auction.leaderPubky,
            }
          : null,
      };
    } catch {
      // No session yet, service unreachable, or listing unregistered — not an
      // error at watch level, and never a fabricated observation.
      return null;
    }
  }

  static async getSavedSearches(ownerPubky: string): Promise<CommerceSavedSearchModelSchema[]> {
    return await LocalCommerceService.getSavedSearches(ownerPubky);
  }

  /**
   * Saves the current catalog filter/search combination. The initial
   * watermark must be the newest `updated_at` among the search's CURRENT
   * matches (the caller just rendered them), so nothing that already existed
   * at save time can ever be counted as NEW.
   */
  static async commitCreateSavedSearch(
    ownerPubky: string,
    name: string,
    params: CommerceSavedSearchParams,
    initialWatermarkUpdatedAt: number,
  ): Promise<void> {
    const existing = await LocalCommerceService.getSavedSearches(ownerPubky);
    if (existing.length >= COMMERCE_SAVED_SEARCH_MAX_PER_OWNER) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        `You can keep up to ${COMMERCE_SAVED_SEARCH_MAX_PER_OWNER} saved searches.`,
        {
          service: ErrorService.Local,
          operation: 'commitCreateSavedSearch',
        },
      );
    }
    const now = Date.now();
    await LocalCommerceService.createSavedSearch({
      id: crypto.randomUUID(),
      owner_id: ownerPubky,
      name,
      params,
      watermark_updated_at: initialWatermarkUpdatedAt,
      latest_match_updated_at: initialWatermarkUpdatedAt,
      new_count: 0,
      last_checked_at: now,
      created_at: now,
    });
  }

  static async commitDeleteSavedSearch(ownerPubky: string, id: string): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.deleteSavedSearch(id);
  }

  static async recordSavedSearchCheck(
    ownerPubky: string,
    id: string,
    result: { newCount: number; latestMatchUpdatedAt: number; checkedAt: number },
  ): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.recordSavedSearchCheck(id, result);
  }

  static async acknowledgeSavedSearch(ownerPubky: string, id: string): Promise<void> {
    await this.assertSavedSearchOwner(ownerPubky, id);
    await LocalCommerceService.acknowledgeSavedSearch(id);
  }

  private static async assertSavedSearchOwner(ownerPubky: string, id: string): Promise<void> {
    const searches = await LocalCommerceService.getSavedSearches(ownerPubky);
    if (!searches.some((search) => search.id === id)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Saved search does not belong to this account.', {
        service: ErrorService.Local,
        operation: 'assertSavedSearchOwner',
      });
    }
  }

  static async isShopFollowed(ownerPubky: string, sellerPubky: string): Promise<boolean> {
    return await LocalCommerceService.isShopFollowed(ownerPubky, sellerPubky);
  }

  static async getShopFollows(ownerPubky: string) {
    return await LocalCommerceService.getShopFollows(ownerPubky);
  }

  static async commitCreateShopFollow(ownerPubky: string, sellerPubky: string): Promise<void> {
    await LocalCommerceService.createShopFollow(ownerPubky, sellerPubky, Date.now());
  }

  static async commitDeleteShopFollow(ownerPubky: string, sellerPubky: string): Promise<void> {
    await LocalCommerceService.deleteShopFollow(ownerPubky, sellerPubky);
  }

  static async getAllCatalogEntries() {
    return await LocalCommerceService.getAllCatalogEntries();
  }

  static async getCatalogEntriesBySeller(sellerPubky: string) {
    return await LocalCommerceService.getCatalogEntriesBySeller(sellerPubky);
  }

  /**
   * Populates the local catalog cache from the Nexus marketplace index.
   *
   * The index now carries everything a catalog card renders (including
   * auction terms), so discovery validates the stream and stores the
   * normalized entries directly — one request, no per-listing homeserver
   * hydration. The canonical owner-signed record is fetched lazily, when a
   * listing is actually opened (`getOrFetchListing`), keeping the homeserver
   * canonical per ADR-0020. Shop profiles are the one card field the index
   * cannot supply, so sellers without a locally cached shop record are still
   * hydrated here (deduplicated, cache-first).
   *
   * Sandbox catalogs are seeded locally and stay self-contained: querying the
   * index there would blend real network listings into a demo catalog of
   * fictional sellers, so sandbox mode never reads from Nexus.
   *
   * Per-shop hydration failures are logged and skipped so one unreachable
   * seller cannot block the rest of the catalog (cards fall back to the
   * seller's pubky until the shop record is reachable).
   */
  static async fetchCatalogListings(filters: CommerceCatalogStreamFilters = {}): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;

    const payload = await NexusMarketplaceService.fetchListingStream({
      state: 'active',
      limit: NEXUS_LISTINGS_PER_PAGE,
      ...(filters.saleFormat ? { sale_format: filters.saleFormat } : {}),
      ...(filters.condition ? { condition: filters.condition } : {}),
      ...(filters.endingSoonest ? { sorting: 'ends_at' as const, order: 'ascending' as const } : {}),
      ...(filters.country ? { country: filters.country } : {}),
    });
    const entries = CommerceRecordNormalizer.nexusListingStream(payload);
    await LocalCommerceService.bulkUpsertCatalogEntries(entries);
    await this.hydrateDiscoveredShops([...new Set(entries.map(({ seller_id }) => seller_id))]);
  }

  /**
   * Populates the local catalog cache with one seller's active listings from
   * the Nexus index — what a direct visit to a shop page needs when the
   * visitor never browsed the main catalog. Sandbox catalogs are seeded
   * locally, so (as with {@link fetchCatalogListings}) sandbox mode never
   * reads from Nexus.
   */
  static async fetchSellerCatalogListings(
    sellerPubky: string,
    options: { strictIdentity?: boolean; paginate?: boolean } = {},
  ): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;

    const entries = await this.collectSellerCatalogEntries(sellerPubky, options);
    await LocalCommerceService.bulkUpsertCatalogEntries(entries);
  }

  private static async collectSellerCatalogEntries(
    sellerPubky: string,
    options: { strictIdentity?: boolean; paginate?: boolean } = {},
  ): Promise<ReturnType<typeof CommerceRecordNormalizer.nexusListingStream>[number][]> {
    const pages: NexusListingDetails[][] = [];
    const maxPages = options.paginate ? SELLER_REFRESH_MAX_PAGES : 1;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await NexusMarketplaceService.fetchListingStream({
        seller_id: sellerPubky,
        state: 'active',
        limit: NEXUS_LISTINGS_PER_PAGE,
        ...(options.paginate && page > 0 ? { skip: page * NEXUS_LISTINGS_PER_PAGE } : {}),
      });
      if (!Array.isArray(payload)) {
        if (options.strictIdentity) throw this.invalidSellerCatalogIdentity();
        break;
      }
      this.validateSellerCatalogPage(payload, sellerPubky, options.strictIdentity);
      pages.push(payload);
      if (!options.paginate || payload.length < NEXUS_LISTINGS_PER_PAGE) break;
      if (page === maxPages - 1) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Seller catalog refresh exceeded its bounded page limit.',
          {
            service: ErrorService.Nexus,
            operation: 'fetchSellerCatalogListings',
            context: { maxPages },
          },
        );
      }
    }

    const entriesById = new Map<string, ReturnType<typeof CommerceRecordNormalizer.nexusListingStream>[number]>();
    for (const entry of CommerceRecordNormalizer.nexusListingStream(pages.flat())) {
      const prior = entriesById.get(entry.id);
      if (!prior || entry.revision > prior.revision) entriesById.set(entry.id, entry);
    }
    return [...entriesById.values()];
  }

  private static validateSellerCatalogPage(
    payload: NexusListingDetails[],
    sellerPubky: string,
    strictIdentity = false,
  ): void {
    if (
      strictIdentity &&
      payload.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          entry.owner_id !== sellerPubky ||
          entry.uri !== `pubky://${sellerPubky}/pub/pubky.app/marketplace/v1/listings/${entry.id}`,
      )
    ) {
      throw this.invalidSellerCatalogIdentity();
    }
  }

  private static invalidSellerCatalogIdentity() {
    return Err.validation(ValidationErrorCode.INVALID_INPUT, 'Seller catalog contains an invalid listing identity.', {
      service: ErrorService.Nexus,
      operation: 'fetchSellerCatalogListings',
      context: { ownerMatches: false },
    });
  }

  /**
   * Refreshes the catalog cache with recent active listings from the sellers
   * a viewer follows, for the home-feed "From sellers you follow" shelf.
   *
   * Cost model — the Nexus listing stream accepts one `seller_id` per
   * request, so intersecting a follow graph with the index can never be one
   * query. This method bounds the cost instead of hiding it:
   *
   * 1. ONE shared global page of the newest active listings (the same read
   *    the catalog grid does) — it both refreshes the cache and cheaply
   *    discovers followed accounts that recently listed something.
   * 2. Per-seller refreshes ONLY for follows already known to sell (cached
   *    shop record or cached index entry), capped at
   *    {@link MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES} — never a
   *    request per follow (see {@link selectFollowedSellersToRefresh}).
   *
   * Degradation: a failed global page falls back to refreshing cache-known
   * sellers; failed per-seller refreshes are logged and skipped
   * (`allSettled`) so one unreachable seller cannot empty the shelf; when
   * everything fails the shelf renders whatever the cache honestly holds.
   * Sandbox catalogs are seeded locally and never read from Nexus.
   */
  static async fetchFollowedSellerCatalogListings(followedPubkys: string[]): Promise<void> {
    if (getCommerceAdapterMode() === 'sandbox') return;
    if (followedPubkys.length === 0) return;

    try {
      const payload = await NexusMarketplaceService.fetchListingStream({
        state: 'active',
        limit: NEXUS_LISTINGS_PER_PAGE,
      });
      await LocalCommerceService.bulkUpsertCatalogEntries(CommerceRecordNormalizer.nexusListingStream(payload));
    } catch (error) {
      Logger.warn('Failed to refresh the global listing page for the followed-sellers shelf; using cache only', {
        error,
      });
    }

    const [entries, shops] = await Promise.all([
      LocalCommerceService.getAllCatalogEntries(),
      LocalCommerceService.getAllShops(),
    ]);
    const knownSellerIds = new Set([
      ...entries.map(({ seller_id }) => seller_id),
      ...shops.map(({ owner_id }) => owner_id),
    ]);
    const sellersToRefresh = selectFollowedSellersToRefresh(
      followedPubkys,
      knownSellerIds,
      MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES,
    );
    if (sellersToRefresh.length === 0) return;

    const results = await Promise.allSettled(
      sellersToRefresh.map((sellerId) => this.fetchSellerCatalogListings(sellerId)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        Logger.warn('Failed to refresh a followed seller for the shelf; keeping their cached listings', {
          sellerId: sellersToRefresh[index],
          error: result.reason,
        });
      }
    });

    await this.hydrateDiscoveredShops(sellersToRefresh);
  }

  private static async hydrateDiscoveredShops(sellerIds: string[]): Promise<void> {
    const shopResults = await Promise.allSettled(sellerIds.map((sellerId) => this.getOrFetchShop(sellerId)));
    shopResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        Logger.warn('Failed to hydrate a discovered marketplace shop', {
          sellerId: sellerIds[index],
          error: result.reason,
        });
      }
    });
  }

  static async fetchListing(ownerPubky: string, listingId: string): Promise<CommerceListingRecord> {
    const url = CommerceRecordNormalizer.listingUri(ownerPubky, listingId);
    const record = CommerceRecordNormalizer.listing(await CommerceHomeserverService.fetchJson(url));
    if (record.ownerPubky !== ownerPubky || record.listingId !== listingId) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'Canonical listing identity does not match the requested seller and listing.',
        {
          service: ErrorService.Marketplace,
          operation: 'fetchListing',
          context: {
            ownerMatches: record.ownerPubky === ownerPubky,
            listingMatches: record.listingId === listingId,
          },
        },
      );
    }
    return record;
  }

  /**
   * Returns the canonical listing record, fetching it from the owner
   * homeserver when it is not cached — or when the Nexus index has seen a
   * newer revision than the cache holds, so opening a listing always shows
   * the freshest record the network can supply. When a refresh fails but a
   * cached record exists, the cached record is returned (local-first
   * degradation, mirroring the catalog's behavior when Nexus is down).
   */
  static async getOrFetchListing(ownerPubky: string, listingId: string): Promise<CommerceListingRecord> {
    const compositeListingId = `${ownerPubky}:${listingId}`;
    const [local, indexed] = await Promise.all([
      LocalCommerceService.getListing(compositeListingId),
      LocalCommerceService.getCatalogEntry(compositeListingId),
    ]);
    if (local && (!indexed || local.revision >= indexed.revision)) return local.record;

    try {
      const record = await this.fetchListing(ownerPubky, listingId);
      if (indexed && record.revision < indexed.revision) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'Canonical listing revision is older than the Nexus discovery revision.',
          {
            service: ErrorService.Marketplace,
            operation: 'getOrFetchListing',
            context: { canonicalRevision: record.revision, indexedRevision: indexed.revision },
          },
        );
      }
      await LocalCommerceService.upsertListing(record, 'synced');
      return record;
    } catch (error) {
      if (isAppError(error) && error.code === ValidationErrorCode.INVALID_INPUT) throw error;
      if (!local) throw error;
      Logger.warn('Failed to refresh a stale marketplace listing; serving the cached record', {
        listing: compositeListingId,
        error,
      });
      return local.record;
    }
  }

  /**
   * The seller's standing amount-band consent (ratified D2, ADR 0024).
   * `null` means the running backend has no attestation support at all
   * (sandbox) — callers render absence, never a fake false.
   */
  static async getMarketplaceBandConsent(actorPubky: string, sellerPubky: string): Promise<boolean | null> {
    return await MarketplaceGatewayService.getBandConsent(actorPubky, sellerPubky);
  }

  static async getOwnMarketplaceReview(actorPubky: string, orderId: string): Promise<CommerceReviewModelSchema | null> {
    return (await LocalCommerceService.getOwnReviewByOrder(actorPubky, orderId)) ?? null;
  }

  /**
   * Publishes the reviewer-owned public review record after a successful
   * `review.create`/`review.update` (trust & reputation plan P1.6): builds
   * the `PubkyAppMarketplaceReview` via the specs builder (deterministic
   * hash ID), embeds the service-issued purchase attestation verbatim in
   * `eligibilityAttestation`, and PUTs it to the reviewer's homeserver with
   * the staged-job outbox pattern listing publication established — a failed
   * PUT leaves a visible pending row that
   * {@link resumeOwnReviewPublications} retries.
   *
   * Returns `null` (publishing nothing) when the command result carries no
   * attestation: the record's `eligibilityAttestation` is required, so a
   * deployment without an attestor keeps reviews service-only — an honest
   * absence, not a failure.
   */
  static async commitPublishOwnReview(input: {
    actorPubky: string;
    order: MarketplaceOrder;
    result: Record<string, unknown>;
  }): Promise<CommerceReviewModelSchema | null> {
    const { actorPubky, order, result } = input;
    const attestation = extractReviewAttestation(result);
    if (attestation === null) return null;
    const review = reviewResultSchema.parse(result.review);

    const listingPrefix = `listing:${order.sellerPubky}_`;
    const listingAggregateId = order.lines[0]?.listingAggregateId ?? '';
    if (!listingAggregateId.startsWith(listingPrefix)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Order lines carry no parseable listing identity.', {
        service: ErrorService.Marketplace,
        operation: 'commitPublishOwnReview',
        context: { orderId: order.id },
      });
    }
    const listingId = listingAggregateId.slice(listingPrefix.length);
    const role = review.reviewerRole === 'buyer' ? 'buyer_reviewing_seller' : 'seller_reviewing_buyer';

    const build = async (revision: number, createdAt: string) => {
      const { PubkySpecsBuilder } = await import('pubky-app-specs');
      const built = new PubkySpecsBuilder(actorPubky).createMarketplaceReview({
        schemaVersion: 1,
        recordType: 'review',
        ownerPubky: actorPubky,
        revision,
        createdAt,
        updatedAt: review.updatedAt,
        reviewId: '',
        subjectPubky: review.subjectPubky,
        listingOwnerPubky: order.sellerPubky,
        listingId,
        role,
        ratings: { overall: review.rating },
        text: review.text,
        eligibilityAttestation: attestation.jws,
      });
      return {
        record: commerceReviewRecordSchema.parse(built.marketplace_review.toJson()),
        reviewId: built.meta.id,
      };
    };

    // The hash ID is deterministic per (listing, subject, role): a revision
    // of the living record — an edit, or a repeat purchase refreshing the
    // attestation — bumps `revision` and keeps the original `createdAt`.
    const probe = await build(1, review.createdAt);
    const prior = await LocalCommerceService.getOwnReviewById(`${actorPubky}:${probe.reviewId}`);
    const { record, reviewId } =
      prior === undefined ? probe : await build(prior.record.revision + 1, prior.record.createdAt);

    const verifiedIss = verifyOwnReviewAttestation(record);
    const model: CommerceReviewModelSchema = {
      id: `${actorPubky}:${reviewId}`,
      owner_id: actorPubky,
      review_id: reviewId,
      order_id: order.id,
      subject_id: record.subjectPubky,
      record,
      attestation_verified: verifiedIss !== null,
      attestation_iss: verifiedIss,
      sync_status: 'pending',
      updated_at: Date.now(),
    };
    const url = CommerceRecordNormalizer.reviewUri(actorPubky, reviewId);
    const job = this.createSyncJob({
      ownerId: actorPubky,
      entityType: 'review',
      entityId: reviewId,
      operation: 'publish',
      payload: { url },
      now: Date.now(),
    });

    await LocalCommerceService.stageOwnReviewSync(model, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    const synced: CommerceReviewModelSchema = { ...model, sync_status: 'synced', updated_at: Date.now() };
    await LocalCommerceService.upsertOwnReview(synced);
    await LocalCommerceService.completeSyncJob(job.id);
    return synced;
  }

  /**
   * Retries every own-review record whose homeserver PUT never landed (the
   * visible retryable outbox): re-publishes the staged record verbatim and
   * marks it synced. Called when the orders surface loads, so a failed
   * publication heals on the next visit instead of rotting silently.
   */
  static async resumeOwnReviewPublications(actorPubky: string): Promise<number> {
    const pending = await LocalCommerceService.getPendingOwnReviews(actorPubky);
    let published = 0;
    for (const row of pending) {
      const url = CommerceRecordNormalizer.reviewUri(row.owner_id, row.review_id);
      try {
        await CommerceHomeserverService.putJson(url, { ...row.record });
        await LocalCommerceService.upsertOwnReview({ ...row, sync_status: 'synced', updated_at: Date.now() });
        published += 1;
      } catch (error) {
        Logger.warn('Own review publication retry failed; the row stays pending', {
          reviewId: row.review_id,
          error,
        });
      }
    }
    return published;
  }

  /**
   * The seller's public reputation overview for rating headers, with the
   * old-deployment ambiguity resolved honestly: the reputation endpoint
   * answers 404 both when the subject has no indexed reviews AND when the
   * Nexus deployment predates reputation indexing (unknown route). Claiming
   * "New seller" against an old index would be a fabrication, so a 404 is
   * only trusted as the New-seller state after the review-list endpoint
   * answers 200 (proving the deployment indexes reviews at all). Anything
   * else degrades to `unavailable`, which renders NO reputation surface —
   * absence, never a fake state.
   */
  static async fetchSellerReputationOverview(sellerPubky: string): Promise<CommerceSellerReputationOverview> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };

    try {
      const payload = await NexusMarketplaceService.fetchShopReputation({ seller_id: sellerPubky });
      return { status: 'rated', summary: CommerceRecordNormalizer.nexusReputationSummary(payload) };
    } catch (error) {
      if (!(isAppError(error) && isNotFound(error))) {
        Logger.warn('Seller reputation fetch failed; rendering no reputation surface', { sellerPubky, error });
        return { status: 'unavailable' };
      }
    }

    try {
      await NexusMarketplaceService.fetchShopReviews({ seller_id: sellerPubky, limit: 1 });
      return { status: 'new_seller' };
    } catch (error) {
      Logger.warn('Review index probe failed; rendering no reputation surface', { sellerPubky, error });
      return { status: 'unavailable' };
    }
  }

  /**
   * A page of indexed reviews about a seller (with joined seller responses),
   * newest-indexed first. `unavailable` means the index does not serve
   * review routes (old deployment or unreachable) — callers render no
   * review section rather than an empty one.
   */
  static async fetchSellerReviews(
    sellerPubky: string,
    page: { skip?: number; limit?: number } = {},
  ): Promise<CommerceIndexedReviewsResult> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };
    try {
      const payload = await NexusMarketplaceService.fetchShopReviews({ seller_id: sellerPubky, ...page });
      return { status: 'ok', reviews: CommerceRecordNormalizer.nexusReviewStream(payload) };
    } catch (error) {
      Logger.warn('Seller reviews fetch failed; rendering no review section', { sellerPubky, error });
      return { status: 'unavailable' };
    }
  }

  /** A page of indexed buyer reviews of one listing (with joined seller responses). */
  static async fetchListingReviews(
    sellerPubky: string,
    listingId: string,
    page: { skip?: number; limit?: number } = {},
  ): Promise<CommerceIndexedReviewsResult> {
    if (getCommerceAdapterMode() === 'sandbox') return { status: 'unavailable' };
    try {
      const payload = await NexusMarketplaceService.fetchListingReviews({
        seller_id: sellerPubky,
        listing_id: listingId,
        ...page,
      });
      return { status: 'ok', reviews: CommerceRecordNormalizer.nexusReviewStream(payload) };
    } catch (error) {
      Logger.warn('Listing reviews fetch failed; rendering no review section', { sellerPubky, listingId, error });
      return { status: 'unavailable' };
    }
  }

  /**
   * The current user's own published review rows (local-first: the user owns
   * these records, so the list renders from the local copies with their
   * publication + verification state — no index round-trip).
   */
  static async getOwnReviews(actorPubky: string): Promise<CommerceReviewModelSchema[]> {
    return await LocalCommerceService.getOwnReviews(actorPubky);
  }

  /** The current user's own response row for one review, or null. */
  static async getOwnReviewResponse(
    actorPubky: string,
    reviewId: string,
  ): Promise<CommerceReviewResponseModelSchema | null> {
    return (await LocalCommerceService.getOwnReviewResponse(actorPubky, reviewId)) ?? null;
  }

  /**
   * Publishes (or revises) the current user's response to a review they are
   * the subject of — a `PubkyAppReviewResponse` record on the user's OWN
   * homeserver (ratified D7: subject-only, one revisable response per
   * review; the path ID equals the review's ID). There is no service
   * command for responses: the record is the whole mechanism, and Nexus
   * indexes it with the structural `owner == subjectPubky` check. Publication
   * uses the same staged-job retryable outbox as reviews and listings.
   *
   * `priorRevision` carries the newest revision the caller has seen from the
   * index (a response written on another device); the new revision always
   * moves past both it and the local copy.
   */
  static async commitPublishReviewResponse(input: {
    actorPubky: string;
    review: CommerceIndexedReview;
    text: string;
    priorRevision?: number | null;
    priorCreatedAt?: string | null;
  }): Promise<CommerceReviewResponseModelSchema> {
    const { actorPubky, review, text } = input;
    if (review.subjectId !== actorPubky) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Only the review subject may respond to a review.', {
        service: ErrorService.Local,
        operation: 'commitPublishReviewResponse',
        context: { reviewId: review.reviewId },
      });
    }

    const prior = await LocalCommerceService.getOwnReviewResponse(actorPubky, review.reviewId);
    const baseRevision = Math.max(prior?.record.revision ?? 0, input.priorRevision ?? 0);
    const nowIso = new Date().toISOString();
    const createdAt = prior?.record.createdAt ?? input.priorCreatedAt ?? nowIso;

    const { PubkySpecsBuilder } = await import('pubky-app-specs');
    const built = new PubkySpecsBuilder(actorPubky).createReviewResponse({
      schemaVersion: 1,
      recordType: 'review_response',
      ownerPubky: actorPubky,
      revision: baseRevision + 1,
      createdAt,
      updatedAt: nowIso,
      reviewId: review.reviewId,
      reviewUri: CommerceRecordNormalizer.reviewUri(review.reviewerId, review.reviewId),
      text,
    });
    const record = CommerceRecordNormalizer.reviewResponse(built.review_response.toJson());

    const model: CommerceReviewResponseModelSchema = {
      id: `${actorPubky}:${review.reviewId}`,
      owner_id: actorPubky,
      review_id: review.reviewId,
      reviewer_id: review.reviewerId,
      record,
      sync_status: 'pending',
      updated_at: Date.now(),
    };
    const url = CommerceRecordNormalizer.reviewResponseUri(actorPubky, review.reviewId);
    const job = this.createSyncJob({
      ownerId: actorPubky,
      entityType: 'review_response',
      entityId: review.reviewId,
      operation: 'publish',
      payload: { url },
      now: Date.now(),
    });

    await LocalCommerceService.stageOwnReviewResponseSync(model, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    const synced: CommerceReviewResponseModelSchema = { ...model, sync_status: 'synced', updated_at: Date.now() };
    await LocalCommerceService.upsertOwnReviewResponse(synced);
    await LocalCommerceService.completeSyncJob(job.id);
    return synced;
  }

  /**
   * Retries every own review-response record whose homeserver PUT never
   * landed — the same visible retryable outbox reviews use.
   */
  static async resumeOwnReviewResponsePublications(actorPubky: string): Promise<number> {
    const pending = await LocalCommerceService.getPendingOwnReviewResponses(actorPubky);
    let published = 0;
    for (const row of pending) {
      const url = CommerceRecordNormalizer.reviewResponseUri(row.owner_id, row.review_id);
      try {
        await CommerceHomeserverService.putJson(url, { ...row.record });
        await LocalCommerceService.upsertOwnReviewResponse({ ...row, sync_status: 'synced', updated_at: Date.now() });
        published += 1;
      } catch (error) {
        Logger.warn('Own review response publication retry failed; the row stays pending', {
          reviewId: row.review_id,
          error,
        });
      }
    }
    return published;
  }

  static async commitUpsertShop(record: CommerceShopRecord): Promise<void> {
    const now = Date.now();
    const url = CommerceRecordNormalizer.shopUri(record.ownerPubky);
    const job = this.createSyncJob({
      ownerId: record.ownerPubky,
      entityType: 'shop',
      entityId: record.ownerPubky,
      operation: 'publish',
      payload: { url },
      now,
    });

    await LocalCommerceService.stageShopSync(record, job);
    await CommerceHomeserverService.putJson(url, { ...record });
    await LocalCommerceService.upsertShop(record, 'synced');
    await LocalCommerceService.completeSyncJob(job.id);
  }

  static async commitUpsertListing(record: CommerceListingRecord): Promise<{ registered: boolean }> {
    const now = Date.now();
    const url = CommerceRecordNormalizer.listingUri(record.ownerPubky, record.listingId);
    const publishJob = this.createSyncJob({
      ownerId: record.ownerPubky,
      entityType: 'listing',
      entityId: record.listingId,
      operation: 'publish',
      payload: { url },
      now,
    });

    await LocalCommerceService.stageListingSync(record, publishJob);
    await CommerceHomeserverService.putJson(url, { ...record });
    await LocalCommerceService.upsertListing(record, 'synced');
    await LocalCommerceService.completeSyncJob(publishJob.id);

    // Registration is idempotent (skipped when the aggregate already has a server
    // revision), so retrying the whole commit after a failure here is safe.
    // Every transactional mode needs it: without registration the service has
    // no aggregate for the listing, so checkout/offers/bids dead-end. (This
    // was sandbox-only once — a relic that left durable-mode listings
    // unregistered and therefore un-buyable.)
    //
    // A registration failure must NOT unwind the publish that already
    // happened: the record is on the homeserver, and reporting the whole
    // commit as failed made sellers retry into duplicate listings. The two
    // truths (published / registered) are returned separately; an
    // unregistered listing self-heals through ensureListingRegistered /
    // listing.sync once a marketplace session exists.
    if (getCommerceAdapterMode() !== 'unavailable') {
      try {
        await this.registerListing(record);
      } catch (error) {
        Logger.warn('Listing published but service registration failed; it will self-heal from owner surfaces', {
          listing: `${record.ownerPubky}:${record.listingId}`,
          error,
        });
        return { registered: false };
      }
    }
    return { registered: true };
  }

  /**
   * Self-heal for listings published while registration failed or was skipped
   * (e.g. records created before durable-mode registration existed): registers
   * the listing when the service has no aggregate for it. Idempotent; callers
   * invoke it from owner-facing surfaces where a session is available.
   */
  static async ensureListingRegistered(record: CommerceListingRecord): Promise<boolean> {
    if (getCommerceAdapterMode() === 'unavailable') return false;
    await this.registerListing(record);
    return true;
  }

  /**
   * Buyer-side heal (`listing.sync`, durable modes only): asks the
   * transaction service to fetch the canonical seller-signed record from the
   * seller's homeserver itself and register (or refresh) the aggregate from
   * it. Unlike {@link ensureListingRegistered}, the actor need NOT be the
   * seller — provenance comes from the service's homeserver fetch, not from
   * the session — so any signed-in user can heal a listing published before
   * durable-mode registration existed. Convergent: `expectedRevision` is
   * always 0 and a pre-existing aggregate is a no-op success.
   */
  // ---------------------------------------------------------------------
  // Drops (ADR 0026)
  // ---------------------------------------------------------------------

  /** Fetches the canonical seller-signed drop record from the homeserver. */
  static async fetchDrop(ownerPubky: string, dropId: string): Promise<CommerceDropRecord> {
    const url = CommerceRecordNormalizer.dropUri(ownerPubky, dropId);
    return CommerceRecordNormalizer.drop(await CommerceHomeserverService.fetchJson(url));
  }

  /**
   * Enumerates the drop ids published on an owner's homeserver by listing
   * the drops directory — the authoritative enumeration (works across
   * devices, unlike any local publish memo). Ids only; callers hydrate each
   * record/projection themselves and render read failures per row.
   */
  static async listOwnDropIds(ownerPubky: string): Promise<string[]> {
    const baseDirectory = `pubky://${ownerPubky}/pub/pubky.app/marketplace/v1/drops/`;
    const urls = await HomeserverService.listAll({ baseDirectory });
    return urls.map((url) => url.slice(baseDirectory.length)).filter((id) => id.length > 0 && !id.includes('/'));
  }

  /**
   * The transaction service's authoritative drop state (public projection,
   * stock redaction server-side, `serverTime` for countdown correction).
   * Null when unregistered or in sandbox mode — callers render absence.
   */
  static async getPublicDrop(sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getPublicDrop(sellerPubky, dropId);
  }

  static async getSellerDrop(actorPubky: string, sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getDrop(actorPubky, buildMarketplaceDropAggregateId(sellerPubky, dropId));
  }

  static async getDropReadyCheck(actorPubky: string, sellerPubky: string, dropId: string) {
    return await MarketplaceGatewayService.getDropReadyCheck(
      actorPubky,
      buildMarketplaceDropAggregateId(sellerPubky, dropId),
    );
  }

  /**
   * Publishes the seller-signed drop record to the seller's own homeserver.
   * The record is validated through the vendored specs builder before the
   * PUT (the same guarantee every published marketplace record gets); the
   * caller follows up with {@link syncDropRegistration} so the transaction
   * service registers the enforced schedule — the studio renders the two
   * truths (record published / service registered) separately.
   */
  static async commitPublishDrop(record: CommerceDropRecord): Promise<void> {
    const { PubkySpecsBuilder } = await import('pubky-app-specs');
    const built = new PubkySpecsBuilder(record.ownerPubky).createMarketplaceDrop({ ...record });
    const validated = CommerceRecordNormalizer.drop(built.marketplace_drop.toJson());
    const url = CommerceRecordNormalizer.dropUri(validated.ownerPubky, validated.dropId);
    await CommerceHomeserverService.putJson(url, { ...validated });
  }

  /**
   * Convergent drop registration from the seller-signed homeserver record —
   * `listing.sync`'s doctrine applied to drops. Any authenticated actor.
   */
  static async syncDropRegistration(
    actorPubky: string,
    sellerPubky: string,
    dropId: string,
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Drops require the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: 'syncDropRegistration',
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceDropAggregateId(sellerPubky, dropId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'drop.sync',
      payload: { sellerPubky, dropId },
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  /**
   * Seller-only drop lifecycle commands, both CAS-guarded with the freshly
   * read revision: `drop.cancel` (kill switch, announced/live) and
   * `drop.release_listings` (return an ENDED drop's listings to open sale).
   */
  static async cancelDrop(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
  ): Promise<MarketplaceCommandResponse> {
    return await this.executeDropLifecycleCommand(actorPubky, dropId, expectedRevision, 'drop.cancel');
  }

  static async releaseDropListings(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
  ): Promise<MarketplaceCommandResponse> {
    return await this.executeDropLifecycleCommand(actorPubky, dropId, expectedRevision, 'drop.release_listings');
  }

  private static async executeDropLifecycleCommand(
    actorPubky: string,
    dropId: string,
    expectedRevision: number,
    kind: 'drop.cancel' | 'drop.release_listings',
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Drops require the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: kind,
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceDropAggregateId(actorPubky, dropId),
      expectedRevision,
      issuedAt: new Date().toISOString(),
      kind,
      payload: {},
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  static async syncListingRegistration(
    actorPubky: string,
    sellerPubky: string,
    listingId: string,
  ): Promise<MarketplaceCommandResponse> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Listing sync requires the durable transaction service.', {
        service: ErrorService.Marketplace,
        operation: 'syncListingRegistration',
      });
    }
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId: buildMarketplaceListingAggregateId(sellerPubky, listingId),
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.sync',
      payload: { sellerPubky, listingId },
    });
    return await MarketplaceGatewayService.execute(actorPubky, command);
  }

  /**
   * Deletes a listing the current user owns: removes the owner-signed record
   * from the homeserver (the canonical copy indexers read), then clears every
   * local cache of it. Media files are deleted afterwards as best-effort
   * cleanup — a media file that outlives its record is unreferenced bytes,
   * not a live listing, so media failures never block the deletion.
   */
  static async commitDeleteListing(ownerPubky: string, listingId: string): Promise<void> {
    const compositeListingId = `${ownerPubky}:${listingId}`;
    const local = await LocalCommerceService.getListing(compositeListingId);
    const url = CommerceRecordNormalizer.listingUri(ownerPubky, listingId);
    const job = this.createSyncJob({
      ownerId: ownerPubky,
      entityType: 'listing',
      entityId: listingId,
      operation: 'remove',
      payload: { url },
      now: Date.now(),
    });

    await LocalCommerceService.upsertSyncJob(job);
    await CommerceHomeserverService.delete(url);
    await LocalCommerceService.deleteListing(compositeListingId);
    await LocalCommerceService.completeSyncJob(job.id);

    if (local) {
      const mediaResults = await Promise.allSettled(
        local.record.media.map((media) => CommerceHomeserverService.delete(media.url)),
      );
      mediaResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          Logger.warn('Failed to delete an orphaned listing media file', {
            mediaUrl: local.record.media[index].url,
            error: result.reason,
          });
        }
      });
    }
  }

  static async commitCreateMedia(ownerPubky: string, mediaId: string, bytes: Uint8Array): Promise<string> {
    const url = CommerceRecordNormalizer.mediaUri(ownerPubky, mediaId);
    await CommerceHomeserverService.putMedia(url, bytes);
    return url;
  }

  static async getMarketplaceMediaOwnerHomeserver(ownerPubky: string): Promise<string | null> {
    return await MarketplaceMediaService.getOwnerHomeserver(ownerPubky);
  }

  static async fetchMarketplaceMedia(uri: string): Promise<Blob> {
    return await MarketplaceMediaService.fetchMedia(uri);
  }

  private static async registerListing(listing: CommerceListingRecord): Promise<void> {
    const aggregateId = buildMarketplaceListingAggregateId(listing.ownerPubky, listing.listingId);
    const existing = await MarketplaceGatewayService.getListing(listing.ownerPubky, aggregateId);
    if (existing?.serverRevision) {
      // Already registered: EDITS must still reach the authority. `listing.sync`
      // is convergent — the service re-reads the seller-signed record and
      // updates the aggregate's terms when the record revision advanced, or
      // no-ops when nothing changed. Skipping here (the old behavior) left
      // the service charging a stale price after every edit. The sandbox has
      // no homeserver to sync from, so it keeps the skip.
      if (isDurableCommerceMode(getCommerceAdapterMode())) {
        await this.syncListingRegistration(listing.ownerPubky, listing.ownerPubky, listing.listingId);
      }
      return;
    }
    const unitPrice = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
    const command = CommerceRecordNormalizer.marketplaceCommand({
      version: 1,
      commandId: crypto.randomUUID(),
      aggregateId,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.register',
      payload: {
        sellerPubky: listing.ownerPubky,
        listingId: listing.listingId,
        title: listing.title,
        listingRevision: listing.revision,
        contentHash: listing.media[0].contentHash,
        quantity: listing.variants.reduce((total, variant) => total + variant.quantity, 0),
        unitPrice,
        shippingMinor: commerceListingShippingMinor(listing.shippingOptions),
        saleFormat: listing.sale.format,
        // The service-facing fulfillment methods (§A1), derived from the
        // record exactly as the service's own homeserver derivation would.
        fulfillmentMethods: commerceListingFulfillmentMethods(listing.fulfillmentMethods),
        auctionTerms:
          listing.sale.format === 'auction'
            ? {
                startsAt: listing.sale.startsAt,
                endsAt: listing.sale.endsAt,
                minimumIncrement: listing.sale.minimumIncrement,
                reservePrice: listing.sale.reservePrice,
                antiSnipingWindowSeconds: listing.sale.antiSnipingWindowSeconds,
                antiSnipingExtensionSeconds: listing.sale.antiSnipingExtensionSeconds,
              }
            : undefined,
      },
    });
    await MarketplaceGatewayService.execute(listing.ownerPubky, command);
  }

  private static createSyncJob({
    ownerId,
    entityType,
    entityId,
    operation,
    payload,
    now,
  }: {
    ownerId: string;
    entityType: CommerceSyncJobModelSchema['entity_type'];
    entityId: string;
    operation: CommerceSyncJobModelSchema['operation'];
    payload: CommerceSyncJobModelSchema['payload'];
    now: number;
  }): CommerceSyncJobModelSchema {
    return {
      id: crypto.randomUUID(),
      owner_id: ownerId,
      entity_type: entityType,
      entity_id: entityId,
      operation,
      status: 'pending',
      attempts: 0,
      next_attempt_at: now,
      last_error_code: null,
      payload,
      created_at: now,
      updated_at: now,
    };
  }
}
