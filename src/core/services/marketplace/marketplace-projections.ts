import { z } from 'zod';
import { marketplaceFulfillmentMethodSchema, marketplaceFulfillmentMethodsSchema } from '@/libs/commerce/pickup';
import { commercePubkySchema, dropStateSchema, orderStateSchema } from '@/libs/commerce/transaction-contracts';

/**
 * Read-projection schemas shared by BOTH marketplace transports.
 *
 * The sandbox prototype and the durable Rust transaction service now serve
 * the same projection shapes (the durable service's `queries.rs` was written
 * against these), so the schemas live here rather than in either transport
 * module. Divergences between the two services are deliberate and encoded as
 * optional fields with a comment naming which side omits them.
 *
 * Sandbox-only projections with NO durable counterpart (conversations,
 * notification preferences, attachment metadata) stay in `marketplace.ts`
 * next to the sandbox transport that owns them.
 */

export const marketplaceMoneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string(),
  exponent: z.number().int(),
});

export const marketplaceListingProjectionSchema = z
  .object({
    aggregateId: z.string(),
    sellerPubky: commercePubkySchema,
    listingId: z.string(),
    listingRevision: z.number().int().positive(),
    contentHash: z.string(),
    serverRevision: z.number().int().positive(),
    state: z.enum(['available', 'reserved', 'sold']),
    availableQuantity: z.number().int().nonnegative(),
    reservedQuantity: z.number().int().nonnegative(),
    unitPrice: marketplaceMoneySchema,
    saleFormat: z.enum(['fixed_price', 'auction']),
    // The fulfillment methods the listing publishes (local pickup design
    // §A1), served by both backends. Defaults to shipping-only for rows
    // registered before the field existed — the service's own default.
    fulfillmentMethods: marketplaceFulfillmentMethodsSchema,
    auction: z
      .object({
        startsAt: z.string(),
        endsAt: z.string(),
        status: z.string().optional(),
        minimumIncrement: marketplaceMoneySchema,
        currentPrice: marketplaceMoneySchema,
        leaderPubky: commercePubkySchema.nullable(),
        bidCount: z.number().int().nonnegative(),
        reserveMet: z.boolean(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/**
 * The auction's public bid history: the VISIBLE price progression only.
 * Proxy maximums stay secret forever on the service; bids recorded before
 * the visible price existed carry `visibleAmount: null` rather than an
 * invented figure. `serverTime` corrects the end-of-auction countdown —
 * auctions run exclusively on the service clock.
 */
export const marketplaceBidHistorySchema = z.object({
  bids: z.array(
    z.object({
      sequence: z.number().int().positive(),
      bidderPubky: commercePubkySchema,
      visibleAmount: marketplaceMoneySchema.nullable(),
      createdAt: z.string(),
    }),
  ),
  auction: z
    .object({
      endsAt: z.string(),
      status: z.enum(['scheduled', 'active', 'sold', 'unsold', 'cancelled']),
      bidCount: z.number().int().nonnegative(),
    })
    .passthrough()
    .nullable(),
  serverTime: z.string(),
});

export type MarketplaceBidHistory = z.infer<typeof marketplaceBidHistorySchema>;

export const marketplaceNotificationSchema = z
  .object({
    id: z.uuid(),
    // Absent from the durable service: delivered notifications are immutable
    // outbox rows, not revisioned aggregates. The sandbox models them with a
    // revision, so this stays optional rather than required.
    revision: z.number().int().positive().optional(),
    recipientPubky: commercePubkySchema,
    actorPubky: commercePubkySchema,
    type: z.enum([
      'message_received',
      'offer_received',
      'offer_countered',
      'offer_accepted',
      'offer_rejected',
      'outbid',
      'auction_won',
      'auction_ended',
      'order_created',
      'payment_confirmed',
      'order_cancelled',
      'order_shipped',
      'order_delivery_assumed',
      'order_delivered',
      'order_completed',
      'return_updated',
      'refund_recorded',
      'review_received',
      // Local pickup (Wave 7, §A3/§A6): details edited or cleared on a paid
      // order (buyer-facing), and the seller arming pickup readiness.
      'pickup_details_updated',
      'pickup_details_cleared',
      'pickup_ready',
      // The buyer-protection exit (§A3): the terminal cancel rode the
      // distinct `order.cancelled_terms_change` event, never `order.cancelled`,
      // so the reputation worker excludes it — the notification says why.
      'order_cancelled_terms_change',
    ]),
    aggregateId: z.string(),
    // Optional monetary context (ADR-0019 §8: present only where the
    // recipient already sees the figure in a role-scoped projection — the
    // offer amount on offer notifications, the auction's visible price on
    // outbid/auction_won/auction_ended). Null on service rows delivered
    // before amounts existed and absent from sandbox notifications.
    amount: marketplaceMoneySchema.nullish(),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  })
  .passthrough();

export const marketplaceOfferSchema = z
  .object({
    id: z.uuid(),
    aggregateId: z.string(),
    listingAggregateId: z.string(),
    buyerPubky: commercePubkySchema,
    sellerPubky: commercePubkySchema,
    revision: z.number().int().positive(),
    state: z.enum(['pending', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired']),
    offeredBy: commercePubkySchema,
    amount: marketplaceMoneySchema,
    quantity: z.number().int().positive(),
    message: z.string(),
    expiresAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const marketplacePaymentSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    buyerPubky: commercePubkySchema,
    sellerPubky: commercePubkySchema,
    revision: z.number().int().positive(),
    // `locks` after `payment.register_locks`: the payment permanently refuses
    // sandbox advancement and only the service's independent Locks
    // verification can confirm it. Binding a payment method rewrites the
    // adapter to the bound rail: `paykit` (physical bitcoin via the seller's
    // claimed watch-only account), `stripe` (processor-verified), or
    // `paypal` (seller-attested).
    adapter: z.enum(['sandbox', 'locks', 'paykit', 'stripe', 'paypal']),
    state: z.enum(['awaiting_entitlement', 'detected', 'confirmed', 'expired', 'manual_review']),
    confirmations: z.number().int().min(0).max(6),
    // Withheld by the durable service: a bundle id is bearer material, so
    // ADR-0019 section 8 keeps it out of read projections. The sandbox still
    // sends it, hence optional rather than removed.
    locksBundleId: z.uuid().optional(),
    amount: marketplaceMoneySchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export const marketplaceOrderSchema = z
  .object({
    id: z.uuid(),
    buyerPubky: commercePubkySchema,
    sellerPubky: commercePubkySchema,
    revision: z.number().int().positive(),
    state: orderStateSchema,
    lines: z.array(
      z.object({
        listingAggregateId: z.string(),
        listingRevision: z.number().int().positive(),
        contentHash: z.string(),
        title: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: marketplaceMoneySchema,
        subtotal: marketplaceMoneySchema,
        // The buyer's variant snapshot from checkout, echoed for fulfillment
        // display. Absent on orders placed before the field existed.
        variantId: z.string().optional(),
        variantOptions: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        // The line's fulfillment kind (§A2). Absent on order lines placed
        // before Wave 7 — they read as shipped lines.
        fulfillment: marketplaceFulfillmentMethodSchema.optional(),
        // The pickup-details version pinned at payment (§A3). An absent key
        // reads as "no terms version pinned" (shipped lines and pre-Wave 7 rows).
        versionAtPayment: z.number().int().positive().optional(),
      }),
    ),
    subtotal: marketplaceMoneySchema,
    shipping: marketplaceMoneySchema,
    total: marketplaceMoneySchema,
    guaranteePolicyVersion: z.literal(1),
    paymentId: z.uuid(),
    receiptId: z.uuid().nullable(),
    // How this order reaches the buyer (§A2): exactly one fulfillment kind,
    // required on the service — one order per (seller, fulfillment). Orders
    // served by backends predating Wave 7 read as shipped orders.
    fulfillment: marketplaceFulfillmentMethodSchema.default('shipping'),
    // Durable service only: the first successful buyer reveal stamped the
    // bounded withdrawal window (§A3); null until then, absent on the sandbox.
    firstRevealedAt: z.string().nullable().optional(),
    // Durable service only (§A3): "meeting point updated since you ordered" —
    // the current details version exceeds a line's version_at_payment, or the
    // details were cleared. The reveal itself keeps serving the pinned snapshot.
    pickupTermsChanged: z.boolean().optional(),
    cancellationReason: z.string().nullable().optional(),
    deliveryAssumed: z.boolean().optional().default(false),
    nextActor: z
      .enum(['buyer', 'seller', 'none'])
      .nullable()
      .optional()
      .transform((value) => value ?? 'none'),
    // Embedded only by the durable service's order reads ("each order with
    // its payment projection"); the sandbox serves payments from a separate
    // endpoint instead.
    payment: marketplacePaymentSchema.optional(),
    shipment: z
      .object({
        carrier: z.string(),
        trackingNumber: z.string(),
        state: z.enum(['shipped', 'delivered']),
        shippedAt: z.string(),
        deliveredAt: z.string().nullable(),
      })
      .nullable()
      .optional(),
    returnRequest: z
      .object({
        state: z.enum(['requested', 'approved', 'received', 'refunded']),
        reason: z.string(),
        requestedAmountMinor: z.number().int().positive(),
        requestedAt: z.string(),
        updatedAt: z.string(),
      })
      .nullable()
      .optional(),
    externalRefund: z
      .object({ amountMinor: z.number().int().positive(), transactionId: z.string(), recordedAt: z.string() })
      .nullable()
      .optional(),
    reviews: z
      .array(
        z.object({
          id: z.uuid(),
          reviewerPubky: commercePubkySchema,
          subjectPubky: commercePubkySchema,
          rating: z.number().int().min(1).max(5),
          text: z.string(),
          createdAt: z.string(),
        }),
      )
      .optional(),
    // Seller-configurable payment method surface (durable service only;
    // absent on sandbox orders and on durable orders predating the feature).
    // `paymentMethod` stays null until the buyer binds one — one-shot per
    // order. `fiatCheckoutUrl` is the service-built checkout URL snapshot
    // taken at binding (Stripe payment link with `client_reference_id`, or
    // the PayPal web-accept URL with the order id in `custom`).
    paymentMethod: z.enum(['bitcoin', 'stripe', 'paypal']).nullable().optional(),
    fiatCheckoutUrl: z.string().nullable().optional(),
    // How the bound fiat rail is verified: Stripe is `processor` (the
    // service checks with the seller's restricted key), PayPal is
    // `gateway-notified` when a postback-verified IPN from PayPal's servers
    // paid the order automatically, or `seller-attested` as the fallback
    // (buyer reports, seller confirms). Deliberately visible to both
    // parties.
    fiatVerification: z.enum(['processor', 'gateway-notified', 'seller-attested']).nullable().optional(),
    paymentReportedAt: z.string().nullable().optional(),
    fiatTransactionRef: z.string().nullable().optional(),
    // Physical-bitcoin orders: the Paykit payment-request reference and the
    // worker-observed request state (`pending`/`detected`/`confirmed`).
    paykitRequestReference: z.string().nullable().optional(),
    paykitRequestState: z.string().nullable().optional(),
    // Drop orders (ADR 0026): the bound drop aggregate and, once paid, the
    // gapless edition number assigned inside the exactly-once confirmation.
    dropAggregateId: z.string().nullable().optional(),
    edition: z.number().int().min(1).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/**
 * The PUBLIC drop projection (`GET /v0/drops/{seller}/{dropId}`, ADR 0026):
 * the transaction service's authoritative drop state, with stock redaction
 * applied SERVER-side per the seller's `stockDisplay` policy — `exact`
 * carries `remaining`, `bands` carries `remainingBand`, `hidden` carries
 * neither. `serverTime` is the service clock the client corrects
 * countdowns from. Never render `live`/`sold out` from any other source.
 */
export const marketplacePublicDropSchema = z
  .object({
    sellerPubky: commercePubkySchema,
    dropId: z.string().min(1),
    aggregateId: z.string().min(1),
    state: dropStateSchema,
    format: z.literal('fcfs'),
    startsAt: z.string(),
    endsAt: z.string().nullable().optional(),
    stockDisplay: z.enum(['exact', 'bands', 'hidden']),
    totalQuantity: z.number().int().positive(),
    perBuyerLimit: z.number().int().positive(),
    remaining: z.number().int().min(0).nullable().optional(),
    remainingBand: z.enum(['plenty', 'low', 'last_few']).nullable().optional(),
    revision: z.number().int().positive(),
    serverTime: z.string(),
  })
  .passthrough();

/** The seller's own full-detail drop read (`GET /v1/drops/{aggregateId}`). */
export const marketplaceSellerDropSchema = marketplacePublicDropSchema
  .extend({
    remaining: z.number().int().min(0),
    paidQuantity: z.number().int().min(0),
    buyerCount: z.number().int().min(0),
    listingIds: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/** The buyer's ready-check read (`GET /v1/drops/{aggregateId}/me`). */
export const marketplaceDropReadyCheckSchema = z
  .object({
    purchased: z.number().int().min(0),
    perBuyerLimit: z.number().int().positive(),
    remainingAllowance: z.number().int().min(0),
  })
  .passthrough();

export const marketplaceReceiptSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  paymentId: z.uuid(),
  issuerPubky: commercePubkySchema,
  recipientPubky: commercePubkySchema,
  total: marketplaceMoneySchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string(),
});

export type MarketplaceListingProjection = z.infer<typeof marketplaceListingProjectionSchema>;
export type MarketplaceNotification = z.infer<typeof marketplaceNotificationSchema>;
export type MarketplaceOffer = z.infer<typeof marketplaceOfferSchema>;
export type MarketplaceOrder = z.infer<typeof marketplaceOrderSchema>;
export type MarketplacePublicDrop = z.infer<typeof marketplacePublicDropSchema>;
export type MarketplaceSellerDrop = z.infer<typeof marketplaceSellerDropSchema>;
export type MarketplaceDropReadyCheck = z.infer<typeof marketplaceDropReadyCheckSchema>;
export type MarketplacePayment = z.infer<typeof marketplacePaymentSchema>;
export type MarketplaceReceipt = z.infer<typeof marketplaceReceiptSchema>;
