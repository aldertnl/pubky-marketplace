import { z } from 'zod';
import { getCommerceAdapterMode, getMarketplaceUrl, isDurableCommerceMode } from '@/config/commerce';
import {
  type MarketplaceEditionAttestation,
  marketplaceEditionAttestationSchema,
  type MarketplaceReceiptAttestation,
  marketplaceReceiptAttestationSchema,
} from '@/libs/commerce/attestation';
import {
  type PaymentMethodKind,
  type SellerPaymentConfig,
  type SellerPaymentConfigOwnView,
  sellerPaymentConfigOwnViewSchema,
  sellerPaymentConfigSchema,
} from '@/libs/commerce/payment-methods';
import {
  classifyMarketplacePickupRefusal,
  type MarketplaceHealth,
  marketplaceHealthSchema,
  type MarketplacePickupReveal,
  marketplacePickupRevealSchema,
  type MarketplaceSellerPickupDetails,
  marketplaceSellerPickupDetailsSchema,
  PICKUP_REFUSAL_FAILURE_MESSAGES,
  pickupRefusalFailureMessage,
} from '@/libs/commerce/pickup';
import {
  type SellerShippingConfig,
  sellerShippingConfigSchema,
  type ShipFromAddress,
  type ShippingLabel,
  shippingLabelSchema,
  type ShippingParcel,
  type ShippoRate,
  shippoRateSchema,
} from '@/libs/commerce/shipping';
import {
  type MarketplaceCommand,
  type MarketplaceCommandResponse,
  marketplaceCommandResponseSchema,
} from '@/libs/commerce/transaction-commands';
import { commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { toCamelCaseWire, toSnakeCaseWire } from '@/libs/commerce/wire-casing';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';
import {
  type MarketplaceBidHistory,
  marketplaceBidHistorySchema,
  type MarketplaceDropReadyCheck,
  marketplaceDropReadyCheckSchema,
  type MarketplaceListingProjection,
  marketplaceListingProjectionSchema,
  type MarketplaceNotification,
  marketplaceNotificationSchema,
  type MarketplaceOffer,
  marketplaceOfferSchema,
  type MarketplaceOrder,
  marketplaceOrderSchema,
  type MarketplacePayment,
  marketplacePaymentSchema,
  type MarketplacePublicDrop,
  marketplacePublicDropSchema,
  type MarketplaceReceipt,
  marketplaceReceiptSchema,
  type MarketplaceSellerDrop,
  marketplaceSellerDropSchema,
} from './marketplace-projections';
import { MarketplaceSessionService } from './marketplace-session';

const PAYMENT_METHOD_FAILURE_MESSAGES: Record<string, string> = {
  bitcoin_unavailable: 'Bitcoin payments are not available for this seller.',
  currency_unsupported: 'This payment method does not support the order currency.',
  hold_unavailable: 'The inventory hold for this order is no longer available.',
  invalid_method: 'That payment method is not valid for this order.',
  invalid_payment_link: 'The Stripe payment link is not valid.',
  invalid_paypal_email: 'The PayPal merchant email is not valid.',
  invalid_pubky: 'The seller identity on this payment configuration is not valid.',
  invalid_restricted_key: 'The Stripe restricted key is not valid.',
  invalid_transaction_ref: 'The payment reference is not valid.',
  locks_managed: 'A Locks-correlated payment advances only by server-side verification.',
  method_mismatch: 'The payment method does not match this order.',
  method_unavailable: 'That payment method is not available.',
  not_buyer: 'Only the buyer may bind the payment method.',
  not_participant: 'Only a participant on this order can continue.',
  not_seller: 'Only the seller can continue this payment step.',
  order_not_found: 'The order was not found.',
  order_not_pending: 'Only an order pending payment can bind a payment method.',
  paykit_rejected: 'The Paykit server rejected the payment request.',
  paykit_unavailable: 'The Paykit server is unavailable. Try again shortly.',
  payment_method_already_bound: 'A payment method is already bound to this order.',
  payment_not_awaiting: 'The payment is no longer awaiting a method.',
  payments_disabled: 'Payments are disabled on this marketplace.',
  seller_account_unclaimed: 'The seller has not claimed a Bitcoin account yet.',
  sold_out: 'This listing no longer has enough inventory.',
  stripe_key_invalid: 'Stripe rejected the seller payment key. The seller must update their payment settings.',
  stripe_key_missing: 'This seller has not configured a Stripe key.',
  stripe_unavailable: 'Stripe could not be reached. Try again shortly.',
  unavailable: 'The payment method request was refused.',
};

/**
 * Command kinds the durable Rust service implements (its envelope contract
 * rejects everything else until it is ported with its tests). Kinds the
 * service does NOT implement are rejected here, before any bytes leave the
 * client, so simulated affordances cannot reach the authority:
 *
 * - `payment.sandbox_advance` exists on the service (it drives the sandbox
 *   payment adapter end to end in its own tests), but this client refuses to
 *   send it as a matter of policy — simulate buttons are sandbox-only.
 * - `payment.register_locks` IS sent: it registers the buyer's Locks
 *   lifecycle correlation and never advances the payment — the service's
 *   worker independently verifies the Locks lifecycle and confirms exactly
 *   once (ADR-0019 §7). Deployments without Locks configured refuse it.
 * - `message.send` and `notification.*` have no durable tables; messaging
 *   and notification preferences remain sandbox-only.
 */
const TRANSACTION_SERVICE_COMMAND_KINDS: ReadonlySet<MarketplaceCommand['kind']> = new Set([
  'listing.register',
  'listing.sync',
  'inventory.reserve',
  'drop.sync',
  'drop.cancel',
  'drop.release_listings',
  'checkout.create',
  'offer.create',
  'offer.counter',
  'offer.accept',
  'offer.reject',
  'offer.withdraw',
  'auction.place_bid',
  'auction.close',
  'payment.register_locks',
  'fulfillment.ship',
  'fulfillment.confirm_delivery',
  // Local pickup (Wave 7 safe subset, §A7): the sealed-details commands and
  // the pickup handover path. The service refuses them on sandbox-payments
  // deployments; this client additionally gates them to durable modes at the
  // application layer.
  'pickup_details.set',
  'pickup_details.clear',
  'fulfillment.mark_ready',
  'fulfillment.confirm_pickup',
  'order.cancel_request',
  'order.cancel_approve',
  'return.request',
  'return.approve',
  'return.receive',
  'refund.record_external',
  'review.create',
  'review.update',
] satisfies MarketplaceCommand['kind'][]);

/**
 * Transport for the durable Rust Marketplace Transaction Service
 * (`pubky-marketplace-service`). Differences from the sandbox transport are
 * deliberate and load-bearing:
 *
 * - **Identity comes from the session**, never from a header. Requests carry
 *   the opaque bearer token issued by `POST /v1/auth/sessions`; the service
 *   resolves the actor from its stored hash. There is no `x-pubky-actor`.
 * - **Wire casing is snake_case** per ADR-0019 §3. The client's internal
 *   camelCase contracts are converted at this boundary only.
 * - **Role-scoped projection reads.** The service serves listings, offers,
 *   orders (with embedded payment/shipment/return/refund/review
 *   sub-objects), payments, receipts, and notifications; every
 *   endpoint requires the same bearer session as `/v1/commands`, and
 *   participation is enforced server-side in SQL. Deliberate redactions
 *   (ADR-0019 §8): no `delivery_address`, no `locks_bundle_id`, and
 *   notifications carry no `revision`. Conversations and notification preferences
 *   have NO durable tables and are not served at all — those stay sandbox-only.
 */
export class MarketplaceTransactionService {
  private constructor() {}

  static async execute(actor: string, command: MarketplaceCommand): Promise<MarketplaceCommandResponse> {
    this.assertTransactionServiceMode('execute');
    if (!TRANSACTION_SERVICE_COMMAND_KINDS.has(command.kind)) {
      throw Err.client(
        ClientErrorCode.BAD_REQUEST,
        `The marketplace transaction service does not support '${command.kind}' commands.`,
        {
          service: ErrorService.Marketplace,
          operation: 'execute',
          context: { kind: command.kind },
        },
      );
    }
    const session = this.requireSession('execute', actor);
    const url = `${getMarketplaceUrl()}/v1/commands`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(toSnakeCaseWire(command)),
      },
      ErrorService.Marketplace,
      'execute',
    );
    this.throwIfSessionRejected(response.status, 'execute');
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'execute', url);
    const parsed = marketplaceCommandResponseSchema.safeParse(toCamelCaseWire(raw));
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid command response.', {
        service: ErrorService.Marketplace,
        operation: 'execute',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  /**
   * `GET /v1/listings/{aggregate_id}`: public catalog data, but still behind
   * the bearer session like every durable read. 404 means the aggregate was
   * never registered with the transaction authority.
   */
  static async getListing(actor: string, aggregateId: string): Promise<MarketplaceListingProjection | null> {
    const raw = await this.readProjection('getListing', actor, `/v1/listings/${encodeURIComponent(aggregateId)}`, {
      nullOnNotFound: true,
    });
    if (raw === null) return null;
    return this.parseProjection(
      'getListing',
      marketplaceListingProjectionSchema,
      raw,
      'Marketplace returned an invalid listing projection.',
    );
  }

  /**
   * `GET /v1/listings/{aggregateId}/bids`: the auction's bid history as the
   * visible price progression (never anyone's proxy maximum), with the live
   * auction terms and the service clock for countdown correction.
   */
  static async getListingBids(actor: string, aggregateId: string): Promise<MarketplaceBidHistory | null> {
    const raw = await this.readProjection(
      'getListingBids',
      actor,
      `/v1/listings/${encodeURIComponent(aggregateId)}/bids`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getListingBids',
      marketplaceBidHistorySchema,
      raw,
      'Marketplace returned an invalid bid history.',
    );
  }

  /** `GET /v1/offers`: offers where the session's pubky is buyer or seller. */
  static async getOffers(actor: string): Promise<MarketplaceOffer[]> {
    const raw = await this.readProjection('getOffers', actor, '/v1/offers');
    return this.parseProjection(
      'getOffers',
      z.object({ offers: z.array(marketplaceOfferSchema) }),
      raw,
      'Marketplace returned invalid offers.',
    ).offers;
  }

  /**
   * `GET /v1/orders`: participant-scoped orders, each carrying its embedded
   * `payment` projection plus shipment/return/refund/review
   * sub-objects. `receipt_id` stays null until payment confirmation issues
   * the durable receipt.
   */
  static async getOrders(actor: string): Promise<MarketplaceOrder[]> {
    const raw = await this.readProjection('getOrders', actor, '/v1/orders');
    return this.parseProjection(
      'getOrders',
      z.object({ orders: z.array(marketplaceOrderSchema) }),
      raw,
      'Marketplace returned invalid orders.',
    ).orders;
  }

  /** `GET /v1/payments/{id}`: participants only; foreign payments are 404. */
  static async getPayment(actor: string, paymentId: string): Promise<MarketplacePayment | null> {
    const raw = await this.readProjection('getPayment', actor, `/v1/payments/${encodeURIComponent(paymentId)}`, {
      nullOnNotFound: true,
    });
    if (raw === null) return null;
    return this.parseProjection(
      'getPayment',
      marketplacePaymentSchema,
      raw,
      'Marketplace returned an invalid payment.',
    );
  }

  /** `GET /v1/receipts/{id}`: issuer and recipient only; foreign receipts are 404. */
  static async getReceipt(actor: string, receiptId: string): Promise<MarketplaceReceipt | null> {
    const raw = await this.readProjection('getReceipt', actor, `/v1/receipts/${encodeURIComponent(receiptId)}`, {
      nullOnNotFound: true,
    });
    if (raw === null) return null;
    return this.parseProjection(
      'getReceipt',
      marketplaceReceiptSchema,
      raw,
      'Marketplace returned an invalid receipt.',
    );
  }

  /** `GET /v1/orders/{id}`: participant-scoped order read; foreign orders are 404. */
  static async getOrder(actor: string, orderId: string): Promise<MarketplaceOrder | null> {
    const raw = await this.readProjection('getOrder', actor, `/v1/orders/${encodeURIComponent(orderId)}`, {
      nullOnNotFound: true,
    });
    if (raw === null) return null;
    return this.parseProjection('getOrder', marketplaceOrderSchema, raw, 'Marketplace returned an invalid order.');
  }

  /**
   * `GET /v1/orders/{id}/pickup-details` (local pickup §A3): the paying
   * buyer's per-line reveal of the PINNED pickup-details snapshot recorded
   * at payment — never the listing's current details — with the
   * version-change and withdrawn-by-seller flags. Buyer only; the service
   * re-evaluates the entitlement (durable payment fact + terminal cutoff)
   * on every read and answers `Cache-Control: no-store`.
   *
   * The revealed details are restricted personal data: they are returned in
   * their self-redacting wrapper, held IN MEMORY ONLY, and are never
   * persisted to Dexie or any store (§A1). This module never logs the
   * response body.
   *
   * Refusals are typed: the service's INVALID_STATE answers map to
   * `Err.client(CONFLICT)` carrying the classified
   * `context.refusal` (`pickup_unavailable` for the key-absent /
   * sandbox-payments deployment boundary, `no_pinned_details` for the empty
   * reveal, `sandbox_confirmed`, `order_terminal`, `payment_unconfirmed`,
   * `not_pickup_order`); a non-buyer maps to `Err.auth(FORBIDDEN)` and an
   * absent/foreign order to `Err.client(NOT_FOUND)`.
   */
  static async getOrderPickupDetails(actor: string, orderId: string): Promise<MarketplacePickupReveal> {
    const raw = await this.readPickupEntitled(
      'getOrderPickupDetails',
      actor,
      `/v1/orders/${encodeURIComponent(orderId)}/pickup-details`,
    );
    return this.parseProjection(
      'getOrderPickupDetails',
      marketplacePickupRevealSchema,
      raw,
      'Marketplace returned an invalid pickup-details reveal.',
    );
  }

  /**
   * `GET /v1/listings/{aggregate_id}/pickup-details` (§A4): the seller's
   * owner read — their own current details alongside the surviving version
   * counter, so the next `pickup_details.set` can compare-and-swap without
   * a hidden second read. After a clear, `current` is null and the counter
   * still answers. Seller only; a foreign or absent listing maps to
   * `Err.client(NOT_FOUND)`.
   */
  static async getListingPickupDetails(actor: string, aggregateId: string): Promise<MarketplaceSellerPickupDetails> {
    const raw = await this.readPickupEntitled(
      'getListingPickupDetails',
      actor,
      `/v1/listings/${encodeURIComponent(aggregateId)}/pickup-details`,
    );
    return this.parseProjection(
      'getListingPickupDetails',
      marketplaceSellerPickupDetailsSchema,
      raw,
      'Marketplace returned an invalid seller pickup-details read.',
    );
  }

  /**
   * `GET /health` — deliberately public (no bearer): the service's
   * health/capability surface. `pickupAvailable` is on iff the deployment
   * has the pickup sealing key configured AND sandbox payments are disabled
   * (§A7); the client hides the pickup option everywhere when it is off.
   */
  static async getHealth(): Promise<MarketplaceHealth> {
    this.assertTransactionServiceMode('getHealth');
    const url = `${getMarketplaceUrl()}/health`;
    const response = await safeFetch(url, { method: 'GET' }, ErrorService.Marketplace, 'getHealth');
    const raw = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Marketplace,
      'getHealth',
      url,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );
    return this.parseProjection(
      'getHealth',
      marketplaceHealthSchema,
      toCamelCaseWire(raw),
      'Marketplace returned an invalid health read.',
    );
  }

  /**
   * One bearer-authenticated entitled-details read with the pickup refusal
   * mapping of §A3/§A7 applied before the generic HTTP error mapping: the
   * service answers refusals as `{ok:false, error:{code, message}}` with
   * the wire code carrying the HTTP status (403 buyer-only, 404
   * absent/foreign, 409 INVALID_STATE for every pickup refusal).
   */
  private static async readPickupEntitled(operation: string, actor: string, path: string): Promise<unknown> {
    this.assertTransactionServiceMode(operation);
    const session = this.requireSession(operation, actor);
    const url = `${getMarketplaceUrl()}${path}`;
    const response = await safeFetch(
      url,
      // `cache: 'no-store'` mirrors the service's `Cache-Control: no-store`
      // response header (WEB-03) on the request side: revealed details must
      // never sit in the browser's HTTP cache either.
      { method: 'GET', headers: { authorization: `Bearer ${session.token}` }, cache: 'no-store' },
      ErrorService.Marketplace,
      operation,
    );
    this.throwIfSessionRejected(response.status, operation);
    if (!response.ok) {
      await this.throwPickupRefusal(response, operation);
    }
    const raw = await this.parsePickupEntitledBody(response, operation);
    return toCamelCaseWire(raw);
  }

  /**
   * Reads and parses an entitled-details body WITHOUT the generic
   * `parseResponseOrThrow`: even with excerpts opt-in off, a `cause` on the
   * generic path used to carry V8 parse-error text. Pickup plaintext must
   * never appear in logs. The body is read locally and any parse failure throws
   * INVALID_RESPONSE with NO excerpt: the context carries the status code
   * only.
   */
  private static async parsePickupEntitledBody(response: Response, operation: string): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // No `cause`: a V8 parse-error message can embed a window of the source
      // text — here the revealed pickup plaintext — and Sentry's linkedErrors
      // would attach it. The status-code context is enough.
      throw Err.server(
        ServerErrorCode.INVALID_RESPONSE,
        'Marketplace returned an unreadable pickup-details response.',
        {
          service: ErrorService.Marketplace,
          operation,
          context: { statusCode: response.status },
        },
      );
    }
  }

  /**
   * Maps an entitled-read failure body to a typed `Err.*`. Classify the
   * service's stable INVALID_STATE message locally, then throw a client-owned
   * string from `PICKUP_REFUSAL_FAILURE_MESSAGES` — never copy `error.message`,
   * which can echo request content or sealed pickup details into logs and the
   * reporter. Falls through (returns) when the body is not the service's
   * refusal shape, letting the generic response parser report it.
   */
  private static async throwPickupRefusal(response: Response, operation: string): Promise<void> {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await response.clone().json()) as { error?: { code?: unknown; message?: unknown } };
      code = typeof body.error?.code === 'string' ? body.error.code : undefined;
      message = typeof body.error?.message === 'string' ? body.error.message : undefined;
    } catch {
      return; // A non-JSON failure body falls through to the generic parse error.
    }
    if (!code || !message) return;
    if (code === 'NOT_FOUND') {
      throw Err.client(ClientErrorCode.NOT_FOUND, PICKUP_REFUSAL_FAILURE_MESSAGES.not_found, {
        service: ErrorService.Marketplace,
        operation,
        context: { statusCode: response.status },
      });
    }
    if (code === 'UNAUTHORIZED') {
      throw Err.auth(AuthErrorCode.FORBIDDEN, PICKUP_REFUSAL_FAILURE_MESSAGES.forbidden, {
        service: ErrorService.Marketplace,
        operation,
        context: { statusCode: response.status },
      });
    }
    if (code === 'INVALID_STATE') {
      const refusal = classifyMarketplacePickupRefusal(message);
      throw Err.client(ClientErrorCode.CONFLICT, pickupRefusalFailureMessage(refusal), {
        service: ErrorService.Marketplace,
        operation,
        context: { statusCode: response.status, refusal },
      });
    }
  }

  /**
   * `GET /v1/sellers/{pubky}/band-consent`: the seller's standing
   * amount-band consent (ratified D2, ADR 0024). Readable by any
   * authenticated session — it is a disclosure preference, not private
   * order data — so a buyer's review dialog can honestly decide whether to
   * surface the per-review band opt-in. Absent row means false.
   */
  static async getBandConsent(actor: string, sellerPubky: string): Promise<boolean> {
    const raw = await this.readProjection(
      'getBandConsent',
      actor,
      `/v1/sellers/${encodeURIComponent(sellerPubky)}/band-consent`,
    );
    return this.parseProjection(
      'getBandConsent',
      z.object({ sellerPubky: commercePubkySchema, allowsAmountBand: z.boolean() }),
      raw,
      'Marketplace returned an invalid band-consent read.',
    ).allowsAmountBand;
  }

  /**
   * `GET /v1/orders/{id}/review-attestation`: the caller's own stored
   * purchase attestation for the order — idempotent re-fetch for
   * re-publication (issuance is deterministic per order+reviewer). Null when
   * the caller has not reviewed the order or the deployment issues no
   * attestations.
   */
  static async getReviewAttestation(actor: string, orderId: string): Promise<unknown | null> {
    const raw = await this.readProjection(
      'getReviewAttestation',
      actor,
      `/v1/orders/${encodeURIComponent(orderId)}/review-attestation`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getReviewAttestation',
      z.object({ attestation: z.object({ jws: z.string().min(32) }).passthrough() }),
      raw,
      'Marketplace returned an invalid review attestation.',
    ).attestation;
  }

  /**
   * `GET /v1/receipts/{id}/attestation`: the compact JWS the service's
   * attestor signs over the receipt's facts (participants, order/receipt
   * ids, total, `paid_at`), for the portable receipt document the buyer or
   * seller publishes to their own homeserver. Issuance is deterministic per
   * receipt, so re-fetching for re-publication is idempotent. Null when the
   * receipt is absent/foreign or the deployment has no attestor.
   */
  static async getReceiptAttestation(actor: string, receiptId: string): Promise<MarketplaceReceiptAttestation | null> {
    const raw = await this.readProjection(
      'getReceiptAttestation',
      actor,
      `/v1/receipts/${encodeURIComponent(receiptId)}/attestation`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getReceiptAttestation',
      z.object({ receiptAttestation: marketplaceReceiptAttestationSchema }),
      raw,
      'Marketplace returned an invalid receipt attestation.',
    ).receiptAttestation;
  }

  /**
   * `GET /v0/drops/{seller}/{dropId}` — deliberately public (no bearer):
   * the transaction service's authoritative drop state, with stock
   * redaction applied server-side and `serverTime` for countdown
   * correction. Null when the drop is not registered.
   */
  static async getPublicDrop(sellerPubky: string, dropId: string): Promise<MarketplacePublicDrop | null> {
    this.assertTransactionServiceMode('getPublicDrop');
    const url = `${getMarketplaceUrl()}/v0/drops/${encodeURIComponent(sellerPubky)}/${encodeURIComponent(dropId)}`;
    const response = await safeFetch(url, { method: 'GET' }, ErrorService.Marketplace, 'getPublicDrop');
    if (response.status === 404) return null;
    const raw = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Marketplace,
      'getPublicDrop',
      url,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );
    return this.parseProjection(
      'getPublicDrop',
      z.object({ drop: marketplacePublicDropSchema }),
      toCamelCaseWire(raw),
      'Marketplace returned an invalid public drop projection.',
    ).drop;
  }

  /** `GET /v1/drops/{aggregateId}` — the seller's own full-detail drop read. */
  static async getDrop(actor: string, aggregateId: string): Promise<MarketplaceSellerDrop | null> {
    const raw = await this.readProjection('getDrop', actor, `/v1/drops/${encodeURIComponent(aggregateId)}`, {
      nullOnNotFound: true,
    });
    if (raw === null) return null;
    return this.parseProjection(
      'getDrop',
      z.object({ drop: marketplaceSellerDropSchema }),
      raw,
      'Marketplace returned an invalid drop projection.',
    ).drop;
  }

  /** `GET /v1/drops/{aggregateId}/me` — the buyer's ready-check allowance. */
  static async getDropReadyCheck(actor: string, aggregateId: string): Promise<MarketplaceDropReadyCheck | null> {
    const raw = await this.readProjection(
      'getDropReadyCheck',
      actor,
      `/v1/drops/${encodeURIComponent(aggregateId)}/me`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getDropReadyCheck',
      marketplaceDropReadyCheckSchema,
      raw,
      'Marketplace returned an invalid drop ready-check.',
    );
  }

  /**
   * `GET /v1/receipts/{id}/edition-attestation`: the deterministic
   * `pubky-drop-edition+v1` JWS for a paid drop order's receipt. Null for
   * non-drop orders, absent/foreign receipts, or attestor-less deployments.
   */
  static async getEditionAttestation(actor: string, receiptId: string): Promise<MarketplaceEditionAttestation | null> {
    const raw = await this.readProjection(
      'getEditionAttestation',
      actor,
      `/v1/receipts/${encodeURIComponent(receiptId)}/edition-attestation`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getEditionAttestation',
      z.object({ editionAttestation: marketplaceEditionAttestationSchema }),
      raw,
      'Marketplace returned an invalid edition attestation.',
    ).editionAttestation;
  }

  /**
   * `GET /v1/notifications`: recipient-scoped delivered outbox rows. They
   * carry no `revision` — there is no notification command surface on the
   * durable service, so nothing can mark them read.
   */
  static async getNotifications(actor: string): Promise<MarketplaceNotification[]> {
    const raw = await this.readProjection('getNotifications', actor, '/v1/notifications');
    return this.parseProjection(
      'getNotifications',
      z.object({ notifications: z.array(marketplaceNotificationSchema) }),
      raw,
      'Marketplace returned invalid notifications.',
    ).notifications;
  }

  /**
   * Performs one bearer-authenticated projection read and returns the
   * camelCased body. Returns null for a 404 only when the endpoint is a
   * single-object read (`nullOnNotFound`), where the service deliberately
   * answers 404 for absent AND foreign aggregates; and for a 403 only when
   * the endpoint is role-gated (`nullOnForbidden`), where 403 means "the
   * session's pubky does not hold the required role".
   */
  /**
   * `GET /v0/sellers/{pubky}/payment-config` — deliberately public (no
   * bearer): buyers see a seller's available rails before committing to an
   * order. `bitcoinAvailable` is service-verified against paykit-server
   * (enabled AND actually claimed); a paykit outage surfaces as an error,
   * never a silent `false`.
   */
  static async getSellerPaymentConfig(sellerPubky: string): Promise<SellerPaymentConfig> {
    this.assertTransactionServiceMode('getSellerPaymentConfig');
    const url = `${getMarketplaceUrl()}/v0/sellers/${encodeURIComponent(sellerPubky)}/payment-config`;
    const response = await safeFetch(url, { method: 'GET' }, ErrorService.Marketplace, 'getSellerPaymentConfig');
    await this.throwPaymentMethodError(response, 'getSellerPaymentConfig');
    const raw = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Marketplace,
      'getSellerPaymentConfig',
      url,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );
    return this.parseProjection(
      'getSellerPaymentConfig',
      sellerPaymentConfigSchema,
      toCamelCaseWire(raw),
      'Marketplace returned an invalid seller payment configuration.',
    );
  }

  /**
   * `GET /v0/sellers/me/payment-config` — the seller's own STORED
   * configuration (no paykit availability lookup). `null` when nothing was
   * ever saved.
   */
  static async getMyPaymentConfig(actor: string): Promise<SellerPaymentConfigOwnView | null> {
    const raw = await this.readProjection('getMyPaymentConfig', actor, '/v0/sellers/me/payment-config');
    const parsed = this.parseProjection(
      'getMyPaymentConfig',
      z.object({ paymentConfig: sellerPaymentConfigOwnViewSchema.nullable() }),
      raw,
      'Marketplace returned an invalid payment configuration.',
    );
    return parsed.paymentConfig;
  }

  /**
   * `PUT /v0/sellers/me/payment-config` — the seller's own rails. The Stripe
   * restricted key is write-only: send it to set it, send `''` to clear it,
   * omit it to keep the stored one; only `stripeRestrictedKeySet` ever comes
   * back.
   */
  static async putMyPaymentConfig(
    actor: string,
    input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string | null;
      stripeRestrictedKey?: string;
      paypalMerchantEmail: string | null;
    },
  ): Promise<SellerPaymentConfigOwnView> {
    const raw = await this.paymentMethodRequest('putMyPaymentConfig', actor, '/v0/sellers/me/payment-config', {
      method: 'PUT',
      body: input,
    });
    const parsed = this.parseProjection(
      'putMyPaymentConfig',
      z.object({ paymentConfig: sellerPaymentConfigOwnViewSchema }),
      raw,
      'Marketplace returned an invalid payment configuration response.',
    );
    return parsed.paymentConfig;
  }

  /**
   * `POST /v0/orders/{id}/payment-method` — one-shot buyer binding. Binding
   * `bitcoin` creates the signed Paykit payment request inside the same
   * transaction, so a paykit refusal leaves the order unbound and retryable.
   */
  static async bindPaymentMethod(actor: string, orderId: string, method: PaymentMethodKind): Promise<MarketplaceOrder> {
    const raw = await this.paymentMethodRequest(
      'bindPaymentMethod',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/payment-method`,
      { method: 'POST', body: { method } },
    );
    return this.parseOrderEnvelope('bindPaymentMethod', raw);
  }

  /**
   * `POST /v0/orders/{id}/fiat/verify` — Stripe only. The service checks the
   * seller's own Stripe account with their stored restricted key and pays the
   * order on an exact match; `verified: false` is an honest "not found yet",
   * not a failure.
   */
  static async verifyStripePayment(
    actor: string,
    orderId: string,
  ): Promise<{ verified: boolean; order: MarketplaceOrder | null }> {
    const raw = await this.paymentMethodRequest(
      'verifyStripePayment',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/fiat/verify`,
      { method: 'POST', body: {} },
    );
    const parsed = this.parseProjection(
      'verifyStripePayment',
      z.object({ verified: z.boolean(), order: marketplaceOrderSchema.optional() }),
      raw,
      'Marketplace returned an invalid fiat verification response.',
    );
    return { verified: parsed.verified, order: parsed.order ?? null };
  }

  /** `POST /v0/orders/{id}/fiat/mark-paid` — buyer's PayPal payment report; never advances the payment itself. */
  static async markFiatPaid(actor: string, orderId: string, transactionRef?: string): Promise<MarketplaceOrder> {
    const raw = await this.paymentMethodRequest(
      'markFiatPaid',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/fiat/mark-paid`,
      { method: 'POST', body: transactionRef ? { transactionRef } : {} },
    );
    return this.parseOrderEnvelope('markFiatPaid', raw);
  }

  /**
   * `GET /v0/sellers/me/shipping-config` — the seller's own Shippo
   * configuration. `null` when nothing was ever saved.
   */
  static async getMyShippingConfig(actor: string): Promise<SellerShippingConfig | null> {
    const raw = await this.readProjection('getMyShippingConfig', actor, '/v0/sellers/me/shipping-config');
    return this.parseProjection(
      'getMyShippingConfig',
      z.object({ shippingConfig: sellerShippingConfigSchema.nullable() }),
      raw,
      'Marketplace returned an invalid shipping configuration.',
    ).shippingConfig;
  }

  /**
   * `PUT /v0/sellers/me/shipping-config` — the Shippo token is write-only:
   * send it to set it, send `''` to clear it, omit it to keep the stored
   * one; only `shippoApiKeySet` ever comes back.
   */
  static async putMyShippingConfig(
    actor: string,
    input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null },
  ): Promise<SellerShippingConfig> {
    const raw = await this.paymentMethodRequest('putMyShippingConfig', actor, '/v0/sellers/me/shipping-config', {
      method: 'PUT',
      body: input,
    });
    return this.parseProjection(
      'putMyShippingConfig',
      z.object({ shippingConfig: sellerShippingConfigSchema }),
      raw,
      'Marketplace returned an invalid shipping configuration response.',
    ).shippingConfig;
  }

  /**
   * `POST /v0/orders/{id}/shipping/rates` — real Shippo rates for this
   * order's delivery address with the seller's own token. Nothing is
   * purchased.
   */
  static async quoteShippingRates(actor: string, orderId: string, parcel: ShippingParcel): Promise<ShippoRate[]> {
    const raw = await this.paymentMethodRequest(
      'quoteShippingRates',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/shipping/rates`,
      { method: 'POST', body: parcel },
    );
    return this.parseProjection(
      'quoteShippingRates',
      z.object({ rates: z.array(shippoRateSchema) }),
      raw,
      'Marketplace returned invalid shipping rates.',
    ).rates;
  }

  /**
   * `POST /v0/orders/{id}/shipping/label` — purchases the selected rate on
   * the seller's own Shippo account (REAL money). One label per order: a
   * repeat call returns the stored label unchanged.
   */
  static async purchaseShippingLabel(actor: string, orderId: string, rateId: string): Promise<ShippingLabel> {
    const raw = await this.paymentMethodRequest(
      'purchaseShippingLabel',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/shipping/label`,
      { method: 'POST', body: { rateId } },
    );
    return this.parseProjection(
      'purchaseShippingLabel',
      z.object({ label: shippingLabelSchema }),
      raw,
      'Marketplace returned an invalid shipping label.',
    ).label;
  }

  /** `GET /v0/orders/{id}/shipping/label` — the stored label, null when none was purchased. */
  static async getShippingLabel(actor: string, orderId: string): Promise<ShippingLabel | null> {
    const raw = await this.readProjection(
      'getShippingLabel',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/shipping/label`,
      { nullOnNotFound: true },
    );
    if (raw === null) return null;
    return this.parseProjection(
      'getShippingLabel',
      z.object({ label: shippingLabelSchema }),
      raw,
      'Marketplace returned an invalid shipping label.',
    ).label;
  }

  /** `POST /v0/orders/{id}/fiat/confirm-received` — the seller's confirmation pays a PayPal order. */
  static async confirmFiatReceived(actor: string, orderId: string): Promise<MarketplaceOrder> {
    const raw = await this.paymentMethodRequest(
      'confirmFiatReceived',
      actor,
      `/v0/orders/${encodeURIComponent(orderId)}/fiat/confirm-received`,
      { method: 'POST', body: {} },
    );
    return this.parseOrderEnvelope('confirmFiatReceived', raw);
  }

  private static async paymentMethodRequest(
    operation: string,
    actor: string,
    path: string,
    request: { method: 'PUT' | 'POST'; body: unknown },
  ): Promise<unknown> {
    this.assertTransactionServiceMode(operation);
    const session = this.requireSession(operation, actor);
    const url = `${getMarketplaceUrl()}${path}`;
    const response = await safeFetch(
      url,
      {
        method: request.method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify(toSnakeCaseWire(request.body)),
      },
      ErrorService.Marketplace,
      operation,
    );
    this.throwIfSessionRejected(response.status, operation);
    await this.throwPaymentMethodError(response, operation);
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, operation, url);
    return toCamelCaseWire(raw);
  }

  /**
   * The payment-methods surface answers failures with
   * `{ok:false, error:{code, message, reason}}`. Map `reason` to a static
   * client string — never copy `error.message`, which can echo a rejected
   * Stripe restricted key or other private value into logs and the reporter.
   */
  private static async throwPaymentMethodError(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    let reason: string | undefined;
    try {
      const body = (await response.clone().json()) as { error?: { reason?: string } };
      reason = typeof body.error?.reason === 'string' ? body.error.reason : undefined;
    } catch {
      // A non-JSON failure body falls through to the generic parse error.
      return;
    }
    throw Err.client(
      ClientErrorCode.BAD_REQUEST,
      PAYMENT_METHOD_FAILURE_MESSAGES[reason ?? ''] ?? PAYMENT_METHOD_FAILURE_MESSAGES.unavailable,
      {
        service: ErrorService.Marketplace,
        operation,
        context: { statusCode: response.status, reason },
      },
    );
  }

  private static parseOrderEnvelope(operation: string, raw: unknown): MarketplaceOrder {
    const parsed = this.parseProjection(
      operation,
      z.object({ order: marketplaceOrderSchema }),
      raw,
      'Marketplace returned an invalid order response.',
    );
    return parsed.order;
  }

  private static async readProjection(
    operation: string,
    actor: string,
    path: string,
    options: { nullOnNotFound?: boolean; nullOnForbidden?: boolean } = {},
  ): Promise<unknown> {
    this.assertTransactionServiceMode(operation);
    const session = this.requireSession(operation, actor);
    const url = `${getMarketplaceUrl()}${path}`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${session.token}` } },
      ErrorService.Marketplace,
      operation,
    );
    this.throwIfSessionRejected(response.status, operation);
    if (options.nullOnNotFound && response.status === HttpStatusCode.NOT_FOUND) return null;
    if (options.nullOnForbidden && response.status === HttpStatusCode.FORBIDDEN) return null;
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, operation, url);
    return toCamelCaseWire(raw);
  }

  private static parseProjection<Schema extends z.ZodTypeAny>(
    operation: string,
    schema: Schema,
    raw: unknown,
    invalidMessage: string,
  ): z.infer<Schema> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, invalidMessage, {
        service: ErrorService.Marketplace,
        operation,
      });
    }
    return parsed.data;
  }

  private static requireSession(operation: string, actor: string): { token: string; pubky: string } {
    const session = MarketplaceSessionService.getActiveSession();
    if (!session) {
      throw Err.auth(
        AuthErrorCode.SESSION_EXPIRED,
        'A marketplace session is required. Approve the marketplace connection on your signer and try again.',
        { service: ErrorService.Marketplace, operation },
      );
    }
    if (session.pubky !== actor) {
      // A session minted for another key must never act for the current user.
      MarketplaceSessionService.clearSession('rejected');
      throw Err.auth(AuthErrorCode.FORBIDDEN, 'The marketplace session belongs to a different pubky.', {
        service: ErrorService.Marketplace,
        operation,
      });
    }
    return session;
  }

  /**
   * Only the auth middleware answers 401 (command failures map to 403/404/409/422),
   * so a 401 always means the session is gone server-side — drop the local copy.
   */
  private static throwIfSessionRejected(statusCode: number, operation: string): void {
    if (statusCode !== HttpStatusCode.UNAUTHORIZED) return;
    MarketplaceSessionService.clearSession('rejected');
    throw Err.auth(
      AuthErrorCode.SESSION_EXPIRED,
      'The marketplace session expired. Approve the marketplace connection on your signer and try again.',
      { service: ErrorService.Marketplace, operation },
    );
  }

  private static assertTransactionServiceMode(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace transaction-service commands are disabled.', {
        service: ErrorService.Marketplace,
        operation,
      });
    }
  }
}
