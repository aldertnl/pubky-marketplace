import { z } from 'zod';
import {
  classifyMarketplacePickupRefusal,
  marketplaceFulfillmentMethodSchema,
  marketplaceFulfillmentMethodsSchema,
  type MarketplacePickupRefusal,
  pickupDetailsSchema,
} from './pickup';
import {
  commerceEntityIdSchema,
  commercePositiveMoneySchema,
  commercePubkySchema,
  createCommerceCommandSchema,
} from './transaction-contracts';

const auctionTermsSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    minimumIncrement: commercePositiveMoneySchema,
    reservePrice: commercePositiveMoneySchema.optional(),
    antiSnipingWindowSeconds: z.number().int().min(0).max(3_600),
    antiSnipingExtensionSeconds: z.number().int().min(0).max(3_600),
  })
  .strict();

const registerListingPayloadSchema = z
  .object({
    sellerPubky: commercePubkySchema,
    listingId: commerceEntityIdSchema,
    title: z.string().trim().min(1).max(80).default('Marketplace item'),
    listingRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    quantity: z.number().int().positive().max(1_000_000),
    unitPrice: commercePositiveMoneySchema,
    // Flat seller-signed shipping per order line in the listing currency's
    // minor units (0 = free / not configured): the cheapest priceable option
    // among the record's shippingOptions.
    shippingMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    saleFormat: z.enum(['fixed_price', 'auction']).default('fixed_price'),
    auctionTerms: auctionTermsSchema.optional(),
    // The fulfillment methods the owner-signed record publishes (local
    // pickup design §A1). Public catalog data echoed at register/sync;
    // defaults to shipping-only so pre-pickup clients are unaffected.
    fulfillmentMethods: marketplaceFulfillmentMethodsSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.saleFormat === 'auction') !== (payload.auctionTerms !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['auctionTerms'],
        message: 'Auction format and terms must be configured together.',
      });
    }
    if (payload.auctionTerms) {
      if (Date.parse(payload.auctionTerms.endsAt) <= Date.parse(payload.auctionTerms.startsAt)) {
        context.addIssue({
          code: 'custom',
          path: ['auctionTerms', 'endsAt'],
          message: 'Auction end must follow start.',
        });
      }
      for (const price of [payload.auctionTerms.minimumIncrement, payload.auctionTerms.reservePrice]) {
        if (price && (price.currency !== payload.unitPrice.currency || price.exponent !== payload.unitPrice.exponent)) {
          context.addIssue({
            code: 'custom',
            path: ['auctionTerms'],
            message: 'Auction amounts must use the listing asset and exponent.',
          });
        }
      }
    }
    // Auction listings are shipping-only (§A2 v1 scope): an auction order
    // carries no address and no checkout step, so a pickup choice could
    // never be expressed for it. Mirrors the service's register validation.
    if (
      payload.saleFormat === 'auction' &&
      !(payload.fulfillmentMethods.length === 1 && payload.fulfillmentMethods[0] === 'shipping')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fulfillmentMethods'],
        message: 'Auction listings are shipping-only.',
      });
    }
  });

export const registerListingCommandSchema = createCommerceCommandSchema(
  'listing.register',
  registerListingPayloadSchema,
);

/**
 * `listing.sync` (durable service only, ANY authenticated actor): asks the
 * service to fetch the canonical seller-signed listing record from the
 * seller's homeserver and register (or refresh) the inventory aggregate from
 * it. Provenance comes from the service's own homeserver fetch — the record
 * lives on a seller-owned path — so the actor deliberately need not be the
 * seller: any buyer can heal a listing published before durable-mode
 * registration existed. Convergent, not optimistic: callers always send
 * `expectedRevision` 0, and a pre-existing aggregate is a no-op success,
 * never a conflict.
 */
export const syncListingCommandSchema = createCommerceCommandSchema(
  'listing.sync',
  z
    .object({
      sellerPubky: commercePubkySchema,
      listingId: commerceEntityIdSchema,
    })
    .strict(),
);

export const reserveInventoryCommandSchema = createCommerceCommandSchema(
  'inventory.reserve',
  z
    .object({
      quantity: z.number().int().positive().max(1_000_000),
      reservationTtlSeconds: z.number().int().min(60).max(1_800),
    })
    .strict(),
);

/**
 * `drop.sync` (ADR 0026): convergent registration of a drop aggregate from
 * the seller-signed homeserver record — same doctrine as `listing.sync`
 * (any authenticated actor, `expectedRevision` 0, no-op on non-advancing
 * record revisions). The service refuses to change caps/schedule/listings
 * once the drop is live: terms are locked at launch.
 */
export const syncDropCommandSchema = createCommerceCommandSchema(
  'drop.sync',
  z
    .object({
      sellerPubky: commercePubkySchema,
      dropId: commerceEntityIdSchema,
    })
    .strict(),
);

/** `drop.cancel` (seller only, CAS): announced/live → `ended_cancelled`. */
export const cancelDropCommandSchema = createCommerceCommandSchema('drop.cancel', z.object({}).strict());

/**
 * `drop.release_listings` (seller only, CAS, ended drops only): removes the
 * drop's listing bindings from gating so remaining stock sells as ordinary
 * open inventory again.
 */
export const releaseDropListingsCommandSchema = createCommerceCommandSchema(
  'drop.release_listings',
  z.object({}).strict(),
);

const offerTermsSchema = z
  .object({
    amount: commercePositiveMoneySchema,
    quantity: z.number().int().positive().max(1_000_000),
    expiresInSeconds: z
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 60 * 60),
    message: z.string().trim().max(500),
  })
  .strict();

export const createOfferCommandSchema = createCommerceCommandSchema('offer.create', offerTermsSchema);

export const counterOfferCommandSchema = createCommerceCommandSchema(
  'offer.counter',
  offerTermsSchema.extend({ offerId: z.uuid() }).strict(),
);

const offerActionSchema = z.object({ offerId: z.uuid() }).strict();

export const acceptOfferCommandSchema = createCommerceCommandSchema('offer.accept', offerActionSchema);
export const rejectOfferCommandSchema = createCommerceCommandSchema('offer.reject', offerActionSchema);
export const withdrawOfferCommandSchema = createCommerceCommandSchema('offer.withdraw', offerActionSchema);

export const placeBidCommandSchema = createCommerceCommandSchema(
  'auction.place_bid',
  z.object({ maximumAmount: commercePositiveMoneySchema }).strict(),
);

export const closeAuctionCommandSchema = createCommerceCommandSchema('auction.close', z.object({}).strict());

export const markMarketplaceNotificationReadCommandSchema = createCommerceCommandSchema(
  'notification.mark_read',
  z.object({ notificationId: z.uuid() }).strict(),
);

export const updateMarketplaceNotificationPreferencesCommandSchema = createCommerceCommandSchema(
  'notification.preferences.update',
  z
    .object({
      messages: z.boolean(),
      offers: z.boolean(),
      bids: z.boolean(),
      auctions: z.boolean(),
    })
    .strict(),
);

/**
 * One `name → value` pair of the buyer's chosen variant, carried as an
 * ordered array (never an open-keyed map: the wire-casing layer converts
 * object KEYS between camelCase and snake_case, which would mangle
 * free-form option names in transit). Limits mirror the listing record's
 * variant contract: names ≤40 chars, values ≤80 chars, ≤3 dimensions.
 */
const checkoutLineVariantOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(80),
  })
  .strict();

const checkoutLineSchema = z.object({
  listingAggregateId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000_000),
  // Optional variant snapshot for fulfillment display (packing slips, order
  // rows). Additive on the service's checkout contract; the service stores
  // it as the buyer's claim about the owner-signed listing content, exactly
  // like quantity.
  variantId: commerceEntityIdSchema.optional(),
  variantOptions: z.array(checkoutLineVariantOptionSchema).min(1).max(3).optional(),
  // The buyer's fulfillment choice for this line (local pickup design §A2).
  // Absent means `shipping` — old clients are unaffected. The service
  // validates the choice against the methods the line's listing publishes
  // and never silently rewrites it; the client mirrors that up front via
  // `resolveCheckoutFulfillment` (see pickup.ts).
  fulfillment: marketplaceFulfillmentMethodSchema.optional(),
});

export const createMarketplaceCheckoutCommandSchema = createCommerceCommandSchema(
  'checkout.create',
  z
    .object({
      lines: z.array(checkoutLineSchema).min(1).max(50),
      // The buyer's delivery address. Required when any seller group ships;
      // absent when every group is pickup — a pickup-only checkout that
      // PRESENTS an address is rejected, so a buggy or malicious client
      // cannot smuggle one into storage (§A2).
      deliveryAddress: z
        .object({
          name: z.string().trim().min(1).max(100),
          line1: z.string().trim().min(1).max(200),
          line2: z.string().trim().max(200),
          city: z.string().trim().min(1).max(100),
          region: z.string().trim().min(1).max(100),
          postalCode: z.string().trim().min(1).max(32),
          countryCode: z.string().regex(/^[A-Z]{2}$/),
        })
        .strict()
        .optional(),
      guaranteePolicyVersion: z.literal(1),
    })
    .strict()
    .superRefine((payload, context) => {
      const ids = payload.lines.map(({ listingAggregateId }) => listingAggregateId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', path: ['lines'], message: 'Checkout listing lines must be unique.' });
      }
      // The address rule of §A2, mirroring the service's checkout validator.
      const anyShipping = payload.lines.some((line) => line.fulfillment !== 'pickup');
      if (anyShipping && payload.deliveryAddress === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryAddress'],
          message: 'A delivery address is required when any checkout line ships.',
        });
      }
      if (!anyShipping && payload.deliveryAddress !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['deliveryAddress'],
          message: 'A pickup-only checkout must not carry a delivery address.',
        });
      }
    }),
);

export const advanceSandboxPaymentCommandSchema = createCommerceCommandSchema(
  'payment.sandbox_advance',
  z
    .object({
      paymentId: z.uuid(),
      target: z.enum(['detected', 'confirmed', 'expired', 'manual_review']),
      confirmations: z.number().int().min(0).max(6),
    })
    .strict(),
);

/** Canonical 26-character uppercase Crockford-base32 Locks bundle id (the `BundleId` wire form). */
export const locksBundleIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Expected a canonical 26-character Crockford-base32 bundle id');

/**
 * The addressed public lock resource in the transaction service's bare form:
 * `<z-base-32 creator>/pub/locks.app/<52-char Crockford lock id>.json` — no
 * `pubky://` scheme and no `pubky` prefix.
 */
export const locksBareLockResourceSchema = z
  .string()
  .regex(
    /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/locks\.app\/[0-9A-HJKMNP-TV-Z]{52}\.json$/,
    'Expected <creator>/pub/locks.app/<lock-id>.json',
  );

/**
 * `payment.register_locks` (buyer only, payment `awaiting_entitlement`):
 * registers the encrypted correlation between the payment and the buyer's
 * Locks verification lifecycle `{creator, bundle_id}`. The bundle id is a
 * bearer secret — the service stores it encrypted and never serializes it
 * back. Registration flips the payment to the `locks` adapter (permanently
 * refusing `payment.sandbox_advance`) and NEVER advances the payment state:
 * only the service worker's independent verification of a completed Locks
 * lifecycle confirms it (ADR-0019 §7).
 */
export const registerLocksPaymentCommandSchema = createCommerceCommandSchema(
  'payment.register_locks',
  z
    .object({
      paymentId: z.uuid(),
      bundleId: locksBundleIdSchema,
      pubkyLockResource: locksBareLockResourceSchema,
    })
    .strict(),
);

const orderIdPayload = z.object({ orderId: z.uuid() }).strict();

export const requestOrderCancellationCommandSchema = createCommerceCommandSchema(
  'order.cancel_request',
  orderIdPayload.extend({ reason: z.string().trim().min(1).max(500) }).strict(),
);

export const approveOrderCancellationCommandSchema = createCommerceCommandSchema(
  'order.cancel_approve',
  orderIdPayload,
);

export const shipOrderCommandSchema = createCommerceCommandSchema(
  'fulfillment.ship',
  orderIdPayload
    .extend({
      carrier: z.string().trim().min(1).max(100),
      trackingNumber: z.string().trim().min(1).max(200),
    })
    .strict(),
);

export const confirmOrderDeliveryCommandSchema = createCommerceCommandSchema(
  'fulfillment.confirm_delivery',
  orderIdPayload,
);

// -----------------------------------------------------------------------------
// Local pickup (Wave 7 safe subset, local pickup design PART A). The shapes
// mirror the durable service (`crates/domain/src/commands.rs`,
// `crates/service/src/handlers/pickup.rs`) — the service is the source of
// truth. All four are durable-service commands: deployments with sandbox
// payments enabled refuse them, and this client gates them to durable modes
// at the application layer.
// -----------------------------------------------------------------------------

/**
 * `pickup_details.set` (seller, own listing only): sealed whole-payload
 * upsert of the listing's pickup details. Versions are monotonic per listing
 * via the service's counters row (§A3); `expectedVersion` is the
 * compare-and-swap against lost updates, 0 when no details exist yet. The
 * envelope's `expectedRevision` is always 0 — the CAS rides the payload, and
 * the details aggregate is distinct from the listing's own revision
 * sequence. Refused (`INVALID_STATE`) when the listing does not publish
 * pickup, when the sealing key is absent, or on sandbox-payments
 * deployments.
 */
export const setPickupDetailsCommandSchema = createCommerceCommandSchema(
  'pickup_details.set',
  z
    .object({
      expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      details: pickupDetailsSchema,
    })
    .strict(),
);

/**
 * `pickup_details.clear` (seller, own listing only): removes the details.
 * The service retains only the versions pinned by a paid, non-terminal
 * order; the per-listing version counter survives, so versions never
 * restart (§A3). Same payload CAS as `pickup_details.set`.
 */
export const clearPickupDetailsCommandSchema = createCommerceCommandSchema(
  'pickup_details.clear',
  z
    .object({
      expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
);

/** `fulfillment.mark_ready` (seller, own pickup order in `paid`): order → `ready_for_pickup`; notifies the buyer. */
export const markReadyForPickupCommandSchema = createCommerceCommandSchema('fulfillment.mark_ready', orderIdPayload);

/**
 * `fulfillment.confirm_pickup` (buyer OR seller, own pickup order in `paid`
 * or `ready_for_pickup`): order → `delivered` with the one-row handover
 * record. A seller-actor confirm is refused (`INVALID_STATE`) while a
 * post-payment terms change is unresolved (§A6).
 */
export const confirmPickupCommandSchema = createCommerceCommandSchema('fulfillment.confirm_pickup', orderIdPayload);

export const requestReturnCommandSchema = createCommerceCommandSchema(
  'return.request',
  orderIdPayload
    .extend({
      reason: z.string().trim().min(1).max(1_000),
      requestedAmountMinor: z.number().int().positive(),
    })
    .strict(),
);

export const approveReturnCommandSchema = createCommerceCommandSchema('return.approve', orderIdPayload);
export const receiveReturnCommandSchema = createCommerceCommandSchema('return.receive', orderIdPayload);

export const recordExternalRefundCommandSchema = createCommerceCommandSchema(
  'refund.record_external',
  orderIdPayload
    .extend({
      amountMinor: z.number().int().positive(),
      transactionId: z.string().trim().min(8).max(200),
    })
    .strict(),
);

/**
 * Review terms shared by `review.create` and `review.update`, mirroring the
 * service's single `ReviewTermsPayload` validator: an integer rating 1–5 and
 * trimmed text of 1–5,000 characters against the reviewed order.
 */
const reviewTermsPayloadSchema = orderIdPayload
  .extend({
    rating: z.number().int().min(1).max(5),
    text: z.string().trim().min(1).max(5_000),
    /**
     * Buyer-side amount-band opt-in (ratified D2, ADR 0024): the purchase
     * attestation carries a log-decade amount band only when this is true
     * AND the seller's standing band-consent preference allows it. Omitted
     * means false; ignored by `review.update` (the attestation is
     * immutable).
     */
    allowAmountBand: z.boolean().optional(),
  })
  .strict();

export const createReviewCommandSchema = createCommerceCommandSchema('review.create', reviewTermsPayloadSchema);

/**
 * `review.update` exists only on the durable service (the sandbox prototype
 * had no review editing): the reviewer may revise their own review's rating
 * and text within `COMMERCE_REVIEW_EDIT_WINDOW_SECONDS` (24 hours, the
 * service's `REVIEW_EDIT_WINDOW_SECONDS`) of the review's creation. Outside
 * the window the service answers `INVALID_STATE` ("The review edit window
 * has closed."), so the UI withholds the affordance instead of failing on
 * submit. `expected_revision` is the ORDER's revision — the service bumps
 * the order on every review edit — and a stale value gets the standard 409
 * `REVISION_CONFLICT` refetch-and-retry treatment.
 */
export const updateReviewCommandSchema = createCommerceCommandSchema('review.update', reviewTermsPayloadSchema);

export const sendMarketplaceMessageCommandSchema = createCommerceCommandSchema(
  'message.send',
  z
    .object({
      listingAggregateId: z.string().min(1),
      recipientPubky: commercePubkySchema,
      text: z.string().trim().min(1).max(2_000),
      attachmentIds: z.array(z.uuid()).max(4).default([]),
    })
    .strict(),
);

export const marketplaceCommandSchema = z.union([
  registerListingCommandSchema,
  syncListingCommandSchema,
  reserveInventoryCommandSchema,
  syncDropCommandSchema,
  cancelDropCommandSchema,
  releaseDropListingsCommandSchema,
  createOfferCommandSchema,
  counterOfferCommandSchema,
  acceptOfferCommandSchema,
  rejectOfferCommandSchema,
  withdrawOfferCommandSchema,
  placeBidCommandSchema,
  closeAuctionCommandSchema,
  sendMarketplaceMessageCommandSchema,
  markMarketplaceNotificationReadCommandSchema,
  updateMarketplaceNotificationPreferencesCommandSchema,
  createMarketplaceCheckoutCommandSchema,
  advanceSandboxPaymentCommandSchema,
  registerLocksPaymentCommandSchema,
  requestOrderCancellationCommandSchema,
  approveOrderCancellationCommandSchema,
  shipOrderCommandSchema,
  confirmOrderDeliveryCommandSchema,
  setPickupDetailsCommandSchema,
  clearPickupDetailsCommandSchema,
  markReadyForPickupCommandSchema,
  confirmPickupCommandSchema,
  requestReturnCommandSchema,
  approveReturnCommandSchema,
  receiveReturnCommandSchema,
  recordExternalRefundCommandSchema,
  createReviewCommandSchema,
  updateReviewCommandSchema,
]);

export const marketplaceCommandResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      version: z.literal(1),
      commandId: z.uuid(),
      aggregateId: z.string().min(1),
      revision: z.number().int().positive(),
      eventIds: z.array(z.uuid()),
      result: z
        .object({
          kind: z.enum([
            'listing',
            'reservation',
            'offer',
            'accepted_offer',
            'bid',
            'message',
            'auction_result',
            'notification',
            'notification_preferences',
            'checkout',
            'payment',
            'order',
            'review',
            'drop',
            'pickup_details',
          ]),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          currentRevision: z.number().int().nonnegative().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
]);

export type RegisterListingCommand = z.infer<typeof registerListingCommandSchema>;
export type SyncListingCommand = z.infer<typeof syncListingCommandSchema>;
export type SyncDropCommand = z.infer<typeof syncDropCommandSchema>;
export type CancelDropCommand = z.infer<typeof cancelDropCommandSchema>;
export type ReleaseDropListingsCommand = z.infer<typeof releaseDropListingsCommandSchema>;
export type ReserveInventoryCommand = z.infer<typeof reserveInventoryCommandSchema>;
export type CreateOfferCommand = z.infer<typeof createOfferCommandSchema>;
export type CounterOfferCommand = z.infer<typeof counterOfferCommandSchema>;
export type AcceptOfferCommand = z.infer<typeof acceptOfferCommandSchema>;
export type RejectOfferCommand = z.infer<typeof rejectOfferCommandSchema>;
export type WithdrawOfferCommand = z.infer<typeof withdrawOfferCommandSchema>;
export type PlaceBidCommand = z.infer<typeof placeBidCommandSchema>;
export type CloseAuctionCommand = z.infer<typeof closeAuctionCommandSchema>;
export type SendMarketplaceMessageCommand = z.infer<typeof sendMarketplaceMessageCommandSchema>;
export type MarkMarketplaceNotificationReadCommand = z.infer<typeof markMarketplaceNotificationReadCommandSchema>;
export type UpdateMarketplaceNotificationPreferencesCommand = z.infer<
  typeof updateMarketplaceNotificationPreferencesCommandSchema
>;
export type CreateMarketplaceCheckoutCommand = z.infer<typeof createMarketplaceCheckoutCommandSchema>;
export type AdvanceSandboxPaymentCommand = z.infer<typeof advanceSandboxPaymentCommandSchema>;
export type RegisterLocksPaymentCommand = z.infer<typeof registerLocksPaymentCommandSchema>;
export type RequestOrderCancellationCommand = z.infer<typeof requestOrderCancellationCommandSchema>;
export type ApproveOrderCancellationCommand = z.infer<typeof approveOrderCancellationCommandSchema>;
export type ShipOrderCommand = z.infer<typeof shipOrderCommandSchema>;
export type ConfirmOrderDeliveryCommand = z.infer<typeof confirmOrderDeliveryCommandSchema>;
export type SetPickupDetailsCommand = z.infer<typeof setPickupDetailsCommandSchema>;
export type ClearPickupDetailsCommand = z.infer<typeof clearPickupDetailsCommandSchema>;
export type MarkReadyForPickupCommand = z.infer<typeof markReadyForPickupCommandSchema>;
export type ConfirmPickupCommand = z.infer<typeof confirmPickupCommandSchema>;
export type RequestReturnCommand = z.infer<typeof requestReturnCommandSchema>;
export type ApproveReturnCommand = z.infer<typeof approveReturnCommandSchema>;
export type ReceiveReturnCommand = z.infer<typeof receiveReturnCommandSchema>;
export type RecordExternalRefundCommand = z.infer<typeof recordExternalRefundCommandSchema>;
export type CreateReviewCommand = z.infer<typeof createReviewCommandSchema>;
export type UpdateReviewCommand = z.infer<typeof updateReviewCommandSchema>;
export type MarketplaceCommand = z.infer<typeof marketplaceCommandSchema>;
export type MarketplaceCommandResponse = z.infer<typeof marketplaceCommandResponseSchema>;

/**
 * The `result` view of a successful `pickup_details.set` /
 * `pickup_details.clear` (mirrors `handlers/pickup.rs`): the new (or, after
 * a clear, surviving) details version the client's next CAS builds on.
 * `cleared` is present only on the clear result.
 */
export const pickupDetailsCommandResultSchema = z
  .object({
    kind: z.literal('pickup_details'),
    listingAggregateId: z.string().min(1),
    version: z.number().int().nonnegative(),
    cleared: z.boolean().optional(),
    updatedAt: z.string(),
  })
  .passthrough();

export type PickupDetailsCommandResult = z.infer<typeof pickupDetailsCommandResultSchema>;

/**
 * Narrows a command response to the pickup-details result, or null for a
 * refusal / a different command's result. Callers that need the new version
 * for the next CAS use this instead of casting the passthrough result.
 */
export function asPickupDetailsCommandResult(response: MarketplaceCommandResponse): PickupDetailsCommandResult | null {
  if (!response.ok) return null;
  const parsed = pickupDetailsCommandResultSchema.safeParse(response.result);
  return parsed.success ? parsed.data : null;
}

/**
 * True when a command was refused because the caller's `expected_revision`
 * went stale (both services answer 409 `REVISION_CONFLICT` with the current
 * revision). The correct reaction is to refetch the projection the revision
 * came from and let the user retry against fresh state — never to resubmit
 * blindly and never to swallow the failure.
 */
export function isMarketplaceRevisionConflict(response: MarketplaceCommandResponse): boolean {
  return !response.ok && response.error.code === 'REVISION_CONFLICT';
}

/**
 * The response-level counterpart of the entitled reads' refusal mapping
 * (§A3/§A6/§A7): command refusals come back in the envelope
 * (`ok:false, error:{code, message}`), never as thrown errors, so the typed
 * pickup refusals — `pickup_not_published`, the `pickup_unavailable`
 * deployment refusal, `terms_change_unresolved` on a seller-actor confirm —
 * would otherwise reach callers as an opaque INVALID_STATE message. Returns
 * the typed refusal, or null for non-refusal failures (revision conflicts,
 * validation), which keep their envelope handling.
 */
export function classifyMarketplacePickupCommandRefusal(
  response: MarketplaceCommandResponse,
): MarketplacePickupRefusal | null {
  if (response.ok || response.error.code !== 'INVALID_STATE') return null;
  return classifyMarketplacePickupRefusal(response.error.message);
}

export function buildMarketplaceListingAggregateId(sellerPubky: string, listingId: string): string {
  return `listing:${sellerPubky}_${listingId}`;
}

export function buildMarketplaceDropAggregateId(sellerPubky: string, dropId: string): string {
  return `drop:${sellerPubky}_${dropId}`;
}

export function buildMarketplaceOfferAggregateId(offerId: string): string {
  return `offer:${offerId}`;
}

export function buildMarketplaceConversationAggregateId(
  sellerPubky: string,
  buyerPubky: string,
  listingId: string,
): string {
  return `conversation:${sellerPubky}_${buyerPubky}_${listingId}`;
}

export function buildMarketplaceCheckoutAggregateId(commandId: string): string {
  return `checkout:${commandId}`;
}

export function buildMarketplacePaymentAggregateId(paymentId: string): string {
  return `payment:${paymentId}`;
}

export function buildMarketplaceOrderAggregateId(orderId: string): string {
  return `order:${orderId}`;
}

