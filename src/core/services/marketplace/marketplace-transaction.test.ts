import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { AppError } from '@/libs/error/error';
import { ErrorService } from '@/libs/error/error.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';
import { Logger } from '@/libs/logger/logger';
import { scrubSensitiveData } from '@/libs/observability/sentry.utils';
import { asOpaque } from '@/test-utils/type-assertions';
import { MarketplaceSessionService } from './marketplace-session';
import { MarketplaceTransactionService } from './marketplace-transaction';

const ACTOR = 'y'.repeat(52);
const OTHER_ACTOR = 'b'.repeat(52);
const SESSION_BEARER = `Bearer ${'A'.repeat(43)}`;
const AGGREGATE_ID = buildMarketplaceListingAggregateId(ACTOR, 'boots_01');
const COMMAND_ID = '00000000-0000-4000-8000-000000000700';

const config = vi.hoisted(() => ({
  mode: 'transaction-service' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: { generateAuthTokenFlow: vi.fn() },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bidCommand() {
  return {
    version: 1 as const,
    commandId: COMMAND_ID,
    aggregateId: AGGREGATE_ID,
    expectedRevision: 1,
    issuedAt: '2026-08-19T23:00:00.000Z',
    kind: 'auction.place_bid' as const,
    payload: {
      maximumAmount: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
    },
  };
}

async function establishSession(): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(
    jsonResponse(201, {
      token: 'A'.repeat(43),
      pubky: ACTOR,
      capabilities: '',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), ACTOR);
  vi.mocked(fetch).mockClear();
}

describe('MarketplaceTransactionService.execute', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('sends a snake_case envelope with the session bearer and returns the camelCase response', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: AGGREGATE_ID,
        revision: 2,
        event_ids: ['00000000-0000-4000-8000-000000000701'],
        result: { kind: 'bid', current_price: { amount_minor: 10_000, currency: 'USD', exponent: 2 } },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, bidCommand());

    expect(response).toMatchObject({
      ok: true,
      commandId: COMMAND_ID,
      revision: 2,
      result: { kind: 'bid', currentPrice: { amountMinor: 10_000 } },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/v1/commands');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: SESSION_BEARER,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1,
      command_id: COMMAND_ID,
      aggregate_id: AGGREGATE_ID,
      expected_revision: 1,
      issued_at: '2026-08-19T23:00:00.000Z',
      kind: 'auction.place_bid',
      payload: {
        maximum_amount: { amount_minor: 10_000, currency: 'USD', exponent: 2 },
      },
    });
    // The forgeable sandbox identity header must never reach the real service.
    expect(JSON.stringify(init.headers)).not.toContain('x-pubky-actor');
  });

  it('surfaces command failures as parsed camelCase error responses', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, {
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', current_revision: 5 },
      }),
    );

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).resolves.toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 5 },
    });
  });

  it('requires an established session before any bytes leave the client', async () => {
    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      name: 'AppError',
      code: 'SESSION_EXPIRED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops the session and asks for a fresh approval when the service answers 401', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(401, { error: { message: 'The session is invalid or expired.' } }),
    );

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('refuses to act for a different pubky than the session was minted for', async () => {
    await establishSession();

    await expect(MarketplaceTransactionService.execute(OTHER_ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it.each([
    'payment.sandbox_advance',
    'message.send',
    'notification.mark_read',
    'notification.preferences.update',
  ] as const)('rejects the sandbox-only command kind %s before sending', async (kind) => {
    await establishSession();

    await expect(
      MarketplaceTransactionService.execute(ACTOR, { ...bidCommand(), kind } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'fulfillment.ship',
    'fulfillment.confirm_delivery',
    'order.cancel_request',
    'order.cancel_approve',
    'return.request',
    'return.approve',
    'return.receive',
    'refund.record_external',
    'review.create',
    'review.update',
  ] as const)('sends the ported post-purchase command kind %s to the service', async (kind) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: 'order:00000000-0000-4000-8000-000000000720',
        revision: 3,
        event_ids: ['00000000-0000-4000-8000-000000000721'],
        result: { kind: 'order' },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, { ...bidCommand(), kind } as never);

    expect(response).toMatchObject({ ok: true, result: { kind: 'order' } });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ kind });
  });

  it('fails closed outside transaction-service mode', async () => {
    config.mode = 'sandbox';

    await expect(MarketplaceTransactionService.execute(ACTOR, bidCommand())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('MarketplaceTransactionService read projections', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const ORDER_ID = '00000000-0000-4000-8000-000000000910';
  const PAYMENT_ID = '00000000-0000-4000-8000-000000000911';
  const RECEIPT_ID = '00000000-0000-4000-8000-000000000912';

  function orderWire(overrides: Record<string, unknown> = {}) {
    return {
      id: ORDER_ID,
      buyer_pubky: ACTOR,
      seller_pubky: OTHER_ACTOR,
      revision: 2,
      state: 'pending_payment',
      lines: [
        {
          listing_aggregate_id: AGGREGATE_ID,
          listing_revision: 1,
          content_hash: 'a'.repeat(64),
          title: 'Boots',
          quantity: 1,
          unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
          subtotal: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
      shipping: { amount_minor: 1_200, currency: 'USD', exponent: 2 },
      total: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
      guarantee_policy_version: 1,
      payment_id: PAYMENT_ID,
      receipt_id: null,
      cancellation_reason: null,
      shipment: null,
      return_request: null,
      external_refund: null,
      reviews: [],
      created_at: '2026-08-20T10:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
      ...overrides,
    };
  }

  // The wire payment deliberately has NO locks_bundle_id (ADR-0019 §8).
  function paymentWire() {
    return {
      id: PAYMENT_ID,
      order_id: ORDER_ID,
      buyer_pubky: ACTOR,
      seller_pubky: OTHER_ACTOR,
      revision: 1,
      adapter: 'sandbox',
      state: 'awaiting_entitlement',
      confirmations: 0,
      amount: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
      created_at: '2026-08-20T10:00:00.000Z',
      updated_at: '2026-08-20T10:00:00.000Z',
    };
  }

  it('reads the listing projection with the bearer session and camel-cases the auction state', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        aggregate_id: AGGREGATE_ID,
        seller_pubky: ACTOR,
        listing_id: 'boots_01',
        title: 'Boots',
        listing_revision: 1,
        content_hash: 'a'.repeat(64),
        server_revision: 4,
        state: 'available',
        total_quantity: 5,
        available_quantity: 4,
        reserved_quantity: 1,
        sold_quantity: 0,
        unit_price: { amount_minor: 12_500, currency: 'USD', exponent: 2 },
        sale_format: 'auction',
        auction: {
          starts_at: '2026-08-20T09:00:00.000Z',
          ends_at: '2026-08-21T09:00:00.000Z',
          minimum_increment: { amount_minor: 100, currency: 'USD', exponent: 2 },
          reserve_price: null,
          anti_sniping_window_seconds: 120,
          anti_sniping_extension_seconds: 120,
          status: 'active',
          current_price: { amount_minor: 13_000, currency: 'USD', exponent: 2 },
          leader_pubky: OTHER_ACTOR,
          bid_count: 3,
          reserve_met: true,
        },
        updated_at: '2026-08-20T10:00:00.000Z',
      }),
    );

    const listing = await MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID);

    expect(listing).toMatchObject({
      aggregateId: AGGREGATE_ID,
      serverRevision: 4,
      state: 'available',
      auction: { currentPrice: { amountMinor: 13_000 }, leaderPubky: OTHER_ACTOR, bidCount: 3, reserveMet: true },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/listings/${encodeURIComponent(AGGREGATE_ID)}`);
    expect(init.headers).toEqual({ authorization: SESSION_BEARER });
  });

  it('returns null for an unregistered listing (service 404)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The listing was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID)).resolves.toBeNull();
  });

  it('reads participant offers and maps the negotiation view', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        offers: [
          {
            id: '00000000-0000-4000-8000-000000000920',
            aggregate_id: 'offer:00000000-0000-4000-8000-000000000920',
            listing_aggregate_id: AGGREGATE_ID,
            buyer_pubky: ACTOR,
            seller_pubky: OTHER_ACTOR,
            revision: 2,
            state: 'countered',
            offered_by: OTHER_ACTOR,
            amount: { amount_minor: 11_000, currency: 'USD', exponent: 2 },
            quantity: 1,
            message: 'Meet in the middle?',
            history: [],
            expires_at: '2026-08-21T10:00:00.000Z',
            created_at: '2026-08-20T10:00:00.000Z',
            updated_at: '2026-08-20T11:00:00.000Z',
          },
        ],
      }),
    );

    await expect(MarketplaceTransactionService.getOffers(ACTOR)).resolves.toEqual([
      expect.objectContaining({
        aggregateId: 'offer:00000000-0000-4000-8000-000000000920',
        revision: 2,
        state: 'countered',
        offeredBy: OTHER_ACTOR,
        amount: { amountMinor: 11_000, currency: 'USD', exponent: 2 },
      }),
    ]);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8080/v1/offers');
  });

  it('reads orders with embedded payment and post-purchase sub-objects, redactions honored', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        orders: [
          orderWire({
            state: 'delivered',
            payment: paymentWire(),
            shipment: {
              carrier: 'DHL',
              tracking_number: 'JD014600003RU',
              state: 'delivered',
              shipped_at: '2026-08-20T11:00:00.000Z',
              delivered_at: '2026-08-20T12:00:00.000Z',
            },
          }),
        ],
      }),
    );

    const orders = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: ORDER_ID,
      revision: 2,
      state: 'delivered',
      deliveryAssumed: false,
      nextActor: 'none',
      payment: { id: PAYMENT_ID, state: 'awaiting_entitlement', adapter: 'sandbox' },
      shipment: { carrier: 'DHL', trackingNumber: 'JD014600003RU', state: 'delivered' },
      receiptId: null,
    });
    expect(orders[0]).not.toHaveProperty('deliveryAddress');
    expect(orders[0].payment).not.toHaveProperty('locksBundleId');
  });

  it('reads assumed-delivery and next-actor order projection fields when present', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        orders: [
          orderWire({
            state: 'delivered',
            delivery_assumed: true,
            next_actor: 'buyer',
          }),
        ],
      }),
    );

    const [order] = await MarketplaceTransactionService.getOrders(ACTOR);

    expect(order).toMatchObject({
      deliveryAssumed: true,
      nextActor: 'buyer',
    });
  });

  it('reads a single payment and returns null for foreign/absent payments', async () => {
    await establishSession();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, paymentWire()))
      .mockResolvedValueOnce(
        jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The payment was not found.' } }),
      );

    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).resolves.toMatchObject({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      revision: 1,
    });
    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).resolves.toBeNull();
  });

  it('reads a receipt with its integrity hash', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: RECEIPT_ID,
        order_id: ORDER_ID,
        payment_id: PAYMENT_ID,
        issuer_pubky: OTHER_ACTOR,
        recipient_pubky: ACTOR,
        total: { amount_minor: 13_700, currency: 'USD', exponent: 2 },
        content_hash: 'b'.repeat(64),
        issued_at: '2026-08-20T12:00:00.000Z',
      }),
    );

    await expect(MarketplaceTransactionService.getReceipt(ACTOR, RECEIPT_ID)).resolves.toMatchObject({
      id: RECEIPT_ID,
      contentHash: 'b'.repeat(64),
      total: { amountMinor: 13_700 },
    });
  });

  it('reads recipient notifications that carry no revision', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        notifications: [
          {
            id: '00000000-0000-4000-8000-000000000930',
            recipient_pubky: ACTOR,
            actor_pubky: OTHER_ACTOR,
            type: 'order_shipped',
            aggregate_id: `order:${ORDER_ID}`,
            created_at: '2026-08-20T11:00:00.000Z',
            read_at: null,
          },
        ],
      }),
    );

    const notifications = await MarketplaceTransactionService.getNotifications(ACTOR);

    expect(notifications).toEqual([
      expect.objectContaining({ type: 'order_shipped', aggregateId: `order:${ORDER_ID}`, readAt: null }),
    ]);
    expect(notifications[0].revision).toBeUndefined();
  });

  it('requires a session for every projection read', async () => {
    await expect(MarketplaceTransactionService.getListing(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getOffers(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(MarketplaceTransactionService.getPayment(ACTOR, PAYMENT_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getReceipt(ACTOR, RECEIPT_ID)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(MarketplaceTransactionService.getNotifications(ACTOR)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed outside transaction-service mode', async () => {
    config.mode = 'sandbox';

    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops the session when a projection read answers 401', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(401, { error: { message: 'The session is invalid or expired.' } }),
    );

    await expect(MarketplaceTransactionService.getOrders(ACTOR)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  describe('seller payment methods', () => {
    beforeEach(() => {
      config.mode = 'transaction-service';
      MarketplaceSessionService.clearSession();
    });

    it('reads a seller payment config publicly, without any session', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          bitcoin_available: true,
          stripe_payment_link: 'https://buy.stripe.com/test_abc',
          paypal_merchant_email: 'seller@example.com',
        }),
      );

      const configView = await MarketplaceTransactionService.getSellerPaymentConfig(OTHER_ACTOR);

      expect(configView).toEqual({
        bitcoinAvailable: true,
        bitcoinOfferAvailable: true,
        stripePaymentLink: 'https://buy.stripe.com/test_abc',
        paypalMerchantEmail: 'seller@example.com',
      });
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8080/v0/sellers/${OTHER_ACTOR}/payment-config`);
      expect(init.headers).toEqual(expect.not.objectContaining({ authorization: expect.anything() }));
    });

    it('saves the own config with the bearer, omitting the key unless provided, and never gets it back', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          payment_config: {
            bitcoin_enabled: true,
            stripe_payment_link: 'https://buy.stripe.com/test_abc',
            paypal_merchant_email: null,
            stripe_restricted_key_set: true,
            updated_at: '2026-08-22T12:00:00.000Z',
          },
        }),
      );

      const saved = await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: true,
        stripePaymentLink: 'https://buy.stripe.com/test_abc',
        paypalMerchantEmail: null,
      });

      expect(saved.stripeRestrictedKeySet).toBe(true);
      expect(Object.keys(saved)).not.toContain('stripeRestrictedKey');
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('stripe_restricted_key');
      expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    });

    it('sends the restricted key on the wire only when the seller supplies one', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          payment_config: {
            bitcoin_enabled: false,
            stripe_payment_link: null,
            paypal_merchant_email: null,
            stripe_restricted_key_set: true,
            updated_at: '2026-08-22T12:00:00.000Z',
          },
        }),
      );

      await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: false,
        stripePaymentLink: null,
        stripeRestrictedKey: 'rk_test_12345678',
        paypalMerchantEmail: null,
      });

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.stripe_restricted_key).toBe('rk_test_12345678');
    });

    it('surfaces the service error envelope message and reason on a refused binding', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: {
            code: 'INVALID_STATE',
            message: 'A different payment method is already bound to this order.',
            reason: 'payment_method_already_bound',
          },
        }),
      );

      await expect(MarketplaceTransactionService.bindPaymentMethod(ACTOR, ORDER_ID, 'stripe')).rejects.toMatchObject({
        message: 'A payment method is already bound to this order.',
      });
    });

    it('maps payment-method reasons to static copy and never logs the server message', async () => {
      await establishSession();
      const echoed = 'rk_live_echoed_restricted_key_value';
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(400, {
          ok: false,
          error: {
            code: 'INVALID_COMMAND',
            message: `Stripe rejected ${echoed}`,
            reason: 'stripe_key_invalid',
          },
        }),
      );
      const loggerError = vi.spyOn(Logger, 'error');

      const error = (await MarketplaceTransactionService.putMyPaymentConfig(ACTOR, {
        bitcoinEnabled: false,
        stripePaymentLink: null,
        stripeRestrictedKey: 'rk_test_12345678',
        paypalMerchantEmail: null,
      }).catch((caught: unknown) => caught)) as AppError;

      expect(error).toMatchObject({
        message: 'Stripe rejected the seller payment key. The seller must update their payment settings.',
      });
      expect(error.message).not.toContain(echoed);
      expect(JSON.stringify(error.context)).not.toContain(echoed);
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(echoed);
      loggerError.mockRestore();
    });

    it('reports an honest not-found verification without touching the order', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true, verified: false, status: 'not_found' }));

      const result = await MarketplaceTransactionService.verifyStripePayment(ACTOR, ORDER_ID);

      expect(result).toEqual({ verified: false, order: null });
    });
  });

  describe('seller shipping integration', () => {
    const SHIP_FROM_WIRE = {
      name: 'Olive Farm',
      line1: 'Maslinska 1',
      line2: '',
      city: 'Split',
      region: '',
      postal_code: '21000',
      country_code: 'HR',
      phone: '',
      email: '',
    };

    beforeEach(() => {
      config.mode = 'transaction-service';
      MarketplaceSessionService.clearSession();
    });

    it('saves the shipping config; the Shippo token is write-only and only its presence returns', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          shipping_config: {
            ship_from: SHIP_FROM_WIRE,
            shippo_api_key_set: true,
            updated_at: '2026-08-24T12:00:00.000Z',
          },
        }),
      );

      const saved = await MarketplaceTransactionService.putMyShippingConfig(ACTOR, {
        shippoApiKey: 'shippo_test_1234567890',
        shipFrom: {
          name: 'Olive Farm',
          line1: 'Maslinska 1',
          line2: '',
          city: 'Split',
          region: '',
          postalCode: '21000',
          countryCode: 'HR',
          phone: '',
          email: '',
        },
      });

      expect(saved.shippoApiKeySet).toBe(true);
      expect(saved.shipFrom?.city).toBe('Split');
      expect(Object.keys(saved)).not.toContain('shippoApiKey');
      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.shippo_api_key).toBe('shippo_test_1234567890');
      expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    });

    it('quotes rates for a parcel and parses them', async () => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          rates: [
            {
              rate_id: 'rate_1',
              provider: 'USPS',
              servicelevel: 'Ground',
              amount: '7.85',
              currency: 'USD',
              estimated_days: 3,
              duration_terms: null,
            },
          ],
        }),
      );

      const rates = await MarketplaceTransactionService.quoteShippingRates(ACTOR, ORDER_ID, {
        weightGrams: 900,
        lengthMm: 300,
        widthMm: 200,
        heightMm: 150,
      });

      expect(rates).toEqual([
        {
          rateId: 'rate_1',
          provider: 'USPS',
          servicelevel: 'Ground',
          amount: '7.85',
          currency: 'USD',
          estimatedDays: 3,
          durationTerms: null,
        },
      ]);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:8080/v0/orders/${ORDER_ID}/shipping/rates`);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.weight_grams).toBe(900);
    });

    it('purchases a label and reads the stored one back; absent labels are null', async () => {
      await establishSession();
      const labelWire = {
        transaction_id: 'txn_1',
        carrier: 'USPS',
        servicelevel: 'Ground',
        amount: '7.85',
        currency: 'USD',
        tracking_number: 'TRACK123',
        tracking_url: null,
        label_url: 'https://deliver.goshippo.com/label_1.pdf',
        purchased_at: '2026-08-24T12:00:00.000Z',
      };
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, label: labelWire }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, label: labelWire }))
        .mockResolvedValueOnce(
          jsonResponse(404, {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'No shipping label has been purchased for this order.' },
          }),
        );

      const purchased = await MarketplaceTransactionService.purchaseShippingLabel(ACTOR, ORDER_ID, 'rate_1');
      expect(purchased.trackingNumber).toBe('TRACK123');
      expect(purchased.labelUrl).toContain('.pdf');

      const stored = await MarketplaceTransactionService.getShippingLabel(ACTOR, ORDER_ID);
      expect(stored?.transactionId).toBe('txn_1');

      const missing = await MarketplaceTransactionService.getShippingLabel(ACTOR, ORDER_ID);
      expect(missing).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// Local pickup (Wave 7 safe subset) — request/response shapes captured from
// crates/service/tests/pickup_test.rs (snake_case on the wire).
// -----------------------------------------------------------------------------

const PICKUP_ORDER_ID = '00000000-0000-4000-8000-000000000920';

const spotDetailsWire = {
  kind: 'spot',
  spot: 'Central Station, north entrance',
  instructions: 'Ask for the blue backpack.',
  availability: {
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

function setPickupDetailsCommand() {
  return {
    version: 1 as const,
    commandId: COMMAND_ID,
    aggregateId: AGGREGATE_ID,
    expectedRevision: 0,
    issuedAt: '2026-08-19T22:00:00.000Z',
    kind: 'pickup_details.set' as const,
    payload: {
      expectedVersion: 0,
      details: {
        kind: 'spot' as const,
        spot: 'Central Station, north entrance',
        instructions: 'Ask for the blue backpack.',
        availability: {
          windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
          zone: 'Europe/Berlin',
        },
      },
    },
  };
}

describe('MarketplaceTransactionService pickup commands', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('sends pickup_details.set as a snake_case envelope with the payload CAS', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        version: 1,
        command_id: COMMAND_ID,
        aggregate_id: AGGREGATE_ID,
        revision: 1,
        event_ids: ['00000000-0000-4000-8000-000000000701'],
        result: {
          kind: 'pickup_details',
          listing_aggregate_id: AGGREGATE_ID,
          version: 1,
          updated_at: '2026-08-19T22:00:00.000Z',
        },
      }),
    );

    const response = await MarketplaceTransactionService.execute(ACTOR, setPickupDetailsCommand());

    expect(response).toMatchObject({ ok: true, result: { kind: 'pickup_details', version: 1 } });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      version: 1,
      command_id: COMMAND_ID,
      aggregate_id: AGGREGATE_ID,
      expected_revision: 0,
      issued_at: '2026-08-19T22:00:00.000Z',
      kind: 'pickup_details.set',
      payload: { expected_version: 0, details: spotDetailsWire },
    });
  });

  it.each(['pickup_details.clear', 'fulfillment.mark_ready', 'fulfillment.confirm_pickup'] as const)(
    'accepts %s as a supported command kind',
    async (kind) => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          version: 1,
          command_id: COMMAND_ID,
          aggregate_id: kind.startsWith('fulfillment') ? `order:${PICKUP_ORDER_ID}` : AGGREGATE_ID,
          revision: 2,
          event_ids: [],
          result: { kind: 'order' },
        }),
      );
      const base = { version: 1 as const, commandId: COMMAND_ID, issuedAt: '2026-08-19T22:00:00.000Z' };
      const command =
        kind === 'pickup_details.clear'
          ? { ...base, aggregateId: AGGREGATE_ID, expectedRevision: 0, kind, payload: { expectedVersion: 3 } }
          : {
              ...base,
              aggregateId: `order:${PICKUP_ORDER_ID}`,
              expectedRevision: 1,
              kind,
              payload: { orderId: PICKUP_ORDER_ID },
            };
      const response = await MarketplaceTransactionService.execute(ACTOR, command);
      expect(response.ok).toBe(true);
    },
  );
});

describe('MarketplaceTransactionService.getOrderPickupDetails (the buyer reveal, §A3)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const revealWire = {
    order_id: PICKUP_ORDER_ID,
    first_revealed_at: '2026-08-19T22:05:00.000Z',
    lines: [
      {
        line_index: 0,
        listing_aggregate_id: AGGREGATE_ID,
        version: 1,
        current_version: 2,
        updated_since_payment: true,
        withdrawn_by_seller: false,
        updated_at: '2026-08-19T22:00:00.000Z',
        details: spotDetailsWire,
      },
    ],
  };

  it('reads the pinned snapshot per line with the service flags, camelCased', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    const reveal = await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:8080/v1/orders/${PICKUP_ORDER_ID}/pickup-details`);
    expect((init.headers as Record<string, string>).authorization).toBe(SESSION_BEARER);
    expect(reveal.orderId).toBe(PICKUP_ORDER_ID);
    expect(reveal.firstRevealedAt).toBe('2026-08-19T22:05:00.000Z');
    expect(reveal.lines).toHaveLength(1);
    expect(reveal.lines[0]).toMatchObject({
      lineIndex: 0,
      version: 1,
      currentVersion: 2,
      updatedSincePayment: true,
      withdrawnBySeller: false,
    });
    expect(reveal.lines[0].details.value.spot).toBe('Central Station, north entrance');
  });

  it('keeps the revealed details masked at every serialization boundary', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    const reveal = await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const serialized = JSON.stringify(reveal);
    expect(serialized).not.toContain('Central Station');
    expect(serialized).not.toContain('blue backpack');
    expect(serialized).toContain('[redacted: pickup details]');
  });

  it.each([
    ['Pickup is unavailable on this deployment.', 'pickup_unavailable'],
    ['The order carries no payment confirmation.', 'payment_unconfirmed'],
    ['The order is terminal; the pickup details are no longer revealed.', 'order_terminal'],
    ['This order was confirmed by a sandbox payment; its pickup details are never revealed.', 'sandbox_confirmed'],
    ['This order carries no pinned pickup details.', 'no_pinned_details'],
    ['Only pickup orders carry pickup details.', 'not_pickup_order'],
  ] as const)('maps the INVALID_STATE refusal "%s" to a typed CONFLICT error', async (message, refusal) => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(409, { ok: false, error: { code: 'INVALID_STATE', message } }));

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      context: { statusCode: 409, refusal },
    });
  });

  it('maps pickup refusals to static copy and never logs the server message', async () => {
    await establishSession();
    const echoed = 'Meet at 14 Oak Lane after 6pm; ask for the red jacket.';
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(409, { ok: false, error: { code: 'INVALID_STATE', message: echoed } }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({
      category: 'client',
      code: 'CONFLICT',
      message: 'The pickup request was refused.',
      context: { statusCode: 409, refusal: null },
    });
    expect(error.message).not.toContain(echoed);
    expect(JSON.stringify(error.context)).not.toContain(echoed);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(echoed);
    loggerError.mockRestore();
  });

  it('maps the non-buyer 403 to an auth FORBIDDEN error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the buyer may reveal the pickup details.' },
      }),
    );

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'auth',
      code: 'FORBIDDEN',
    });
  });

  it('maps an absent or foreign order 404 to a client NOT_FOUND error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The order was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'NOT_FOUND',
    });
  });

  it('sends cache: no-store on the request, mirroring the service response header (WEB-03)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, revealWire));

    await MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});

describe('MarketplaceTransactionService.getListingPickupDetails (the seller owner read, §A4)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it('returns the current details with the version counter', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        listing_aggregate_id: AGGREGATE_ID,
        current: { details: spotDetailsWire, version: 4, updated_at: '2026-08-19T22:02:00.000Z' },
        last_version: 4,
      }),
    );

    const read = await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toBe(`http://127.0.0.1:8080/v1/listings/${encodeURIComponent(AGGREGATE_ID)}/pickup-details`);
    expect(read.listingAggregateId).toBe(AGGREGATE_ID);
    expect(read.current?.version).toBe(4);
    expect(read.current?.details.value.spot).toBe('Central Station, north entrance');
    expect(read.lastVersion).toBe(4);
    expect(JSON.stringify(read)).not.toContain('Central Station');
  });

  it('returns the post-clear shape: no current details, the counter survives', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { listing_aggregate_id: AGGREGATE_ID, current: null, last_version: 4 }),
    );

    const read = await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    expect(read.current).toBeNull();
    expect(read.lastVersion).toBe(4);
  });

  it('maps a foreign or absent listing 404 to a client NOT_FOUND error', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'The listing was not found.' } }),
    );

    await expect(MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID)).rejects.toMatchObject({
      category: 'client',
      code: 'NOT_FOUND',
    });
  });

  it('sends cache: no-store on the request, mirroring the service response header (WEB-03)', async () => {
    await establishSession();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { listing_aggregate_id: AGGREGATE_ID, current: null, last_version: 4 }),
    );

    await MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});

describe('pickup entitled reads never leak the plaintext into error telemetry', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  const SENTINEL = 'Central Station, north entrance';
  // A malformed 200 whose body carries revealed pickup plaintext (truncated
  // mid-payload, as a proxy/server fault would produce it).
  const MALFORMED_BODY = `{"order_id":"${PICKUP_ORDER_ID}","lines":[{"details":{"spot":"${SENTINEL}","instructions":"Ask for the blue backpack.`;

  const pickupReads = [
    ['buyer reveal', () => MarketplaceTransactionService.getOrderPickupDetails(ACTOR, PICKUP_ORDER_ID)],
    ['seller owner read', () => MarketplaceTransactionService.getListingPickupDetails(ACTOR, AGGREGATE_ID)],
  ] as const;

  it.each(pickupReads)(
    'a malformed 200 on the %s throws INVALID_RESPONSE whose context, log output, and Sentry scrub carry no body excerpt',
    async (_label, read) => {
      await establishSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const loggerError = vi.spyOn(Logger, 'error');

      const error = (await read().catch((caught: unknown) => caught)) as AppError;

      expect(error).toMatchObject({ name: 'AppError', category: 'server', code: 'INVALID_RESPONSE' });
      // The thrown error's context carries the status code only — no excerpt.
      expect(JSON.stringify(error.context)).not.toContain(SENTINEL);
      expect(error.context).not.toHaveProperty('responseText');
      // No `cause` either: a V8 parse-error message can embed a window of the
      // malformed body, and Sentry's linkedErrors would attach it. (AppError
      // declares the own property unconditionally, so assert the value.)
      expect(error.cause).toBeUndefined();
      // The Err.* factory logged the same context: no excerpt there either.
      expect(loggerError).toHaveBeenCalled();
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(SENTINEL);
      // And the Sentry scrub of the error context is clean.
      const scrubbed = scrubSensitiveData(
        asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
          message: error.message,
          contexts: { 'error.context': error.context },
        }),
      );
      expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
      loggerError.mockRestore();
    },
  );

  it('negative control: the generic parseResponseOrThrow WOULD embed the excerpt — and the scrubber denylist now redacts it', async () => {
    const response = new Response(MALFORMED_BODY, { status: 200, headers: { 'content-type': 'application/json' } });

    const error = (await parseResponseOrThrow(
      response,
      ErrorService.Marketplace,
      'negativeControl',
      undefined,
      PARSE_JSON_WITH_BODY_EXCERPT,
    ).catch((caught: unknown) => caught)) as AppError;

    // Proves the fixture is sensitive and the pickup-specific parser above is
    // load-bearing: the generic path puts the body excerpt into the context.
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(JSON.stringify(error.context)).toContain(SENTINEL);
    expect(error.context).toHaveProperty('responseText');

    // Defense in depth: `responseText` is on the scrubber denylist, so even
    // this context is redacted before it can reach Sentry.
    const scrubbed = scrubSensitiveData(
      asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
        message: error.message,
        contexts: { 'error.context': error.context },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL);
    expect(JSON.stringify(scrubbed)).toContain('[redacted: sensitive field]');
  });
});

describe('MarketplaceTransactionService.getHealth (the pickup_available capability, §A7)', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  it.each([true, false])('parses pickup_available %s from the public health read', async (pickupAvailable) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { status: 'ok', pickup_available: pickupAvailable }));

    const health = await MarketplaceTransactionService.getHealth();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/health');
    // The capability read is deliberately public: no session, no bearer.
    expect(init?.headers).toBeUndefined();
    expect(health.pickupAvailable).toBe(pickupAvailable);
  });
});
