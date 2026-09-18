import { describe, expect, it } from 'vitest';
import {
  asPickupDetailsCommandResult,
  clearPickupDetailsCommandSchema,
  confirmPickupCommandSchema,
  createMarketplaceCheckoutCommandSchema,
  createReviewCommandSchema,
  isMarketplaceRevisionConflict,
  marketplaceCommandSchema,
  markReadyForPickupCommandSchema,
  registerListingCommandSchema,
  setPickupDetailsCommandSchema,
  updateReviewCommandSchema,
} from './transaction-commands';

const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000720';

function reviewCommand(kind: 'review.create' | 'review.update', payload: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000721',
    aggregateId: `order:${ORDER_ID}`,
    expectedRevision: 3,
    issuedAt: '2026-08-20T12:00:00.000Z',
    kind,
    payload: { orderId: ORDER_ID, rating: 4, text: 'Solid transaction, fast shipping.', ...payload },
  };
}

// `review.create` and `review.update` share the service's single
// ReviewTermsPayload validator, so both kinds are exercised against the same
// bounds: integer rating 1–5 and trimmed text of 1–5,000 characters.
describe.each([
  ['review.create', createReviewCommandSchema],
  ['review.update', updateReviewCommandSchema],
] as const)('%s command contract', (kind, schema) => {
  it('accepts a payload matching the service validator', () => {
    const parsed = schema.parse(reviewCommand(kind));

    expect(parsed.kind).toBe(kind);
    expect(parsed.payload).toEqual({ orderId: ORDER_ID, rating: 4, text: 'Solid transaction, fast shipping.' });
  });

  it('is a member of the marketplace command union', () => {
    expect(marketplaceCommandSchema.parse(reviewCommand(kind)).kind).toBe(kind);
  });

  it.each([0, 6, 3.5])('rejects the out-of-bounds rating %s', (rating) => {
    expect(schema.safeParse(reviewCommand(kind, { rating })).success).toBe(false);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(schema.safeParse(reviewCommand(kind, { text: '' })).success).toBe(false);
    expect(schema.safeParse(reviewCommand(kind, { text: '   ' })).success).toBe(false);
  });

  it('accepts text at the 5,000-character bound and rejects one character more', () => {
    expect(schema.safeParse(reviewCommand(kind, { text: 'a'.repeat(5_000) })).success).toBe(true);
    expect(schema.safeParse(reviewCommand(kind, { text: 'a'.repeat(5_001) })).success).toBe(false);
  });

  it('rejects unknown payload fields, mirroring the service deny_unknown_fields', () => {
    expect(schema.safeParse(reviewCommand(kind, { deliveryAddress: 'leak' })).success).toBe(false);
  });

  it('rejects a non-uuid order id', () => {
    expect(schema.safeParse(reviewCommand(kind, { orderId: 'not-a-uuid' })).success).toBe(false);
  });
});

describe('review.update revision conflict handling', () => {
  it('classifies the 409 REVISION_CONFLICT answer for the refetch-and-retry pattern', () => {
    expect(
      isMarketplaceRevisionConflict({
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'The order revision is stale.', currentRevision: 4 },
      }),
    ).toBe(true);
  });

  it('does not classify the closed-window INVALID_STATE answer as retriable', () => {
    expect(
      isMarketplaceRevisionConflict({
        ok: false,
        error: { code: 'INVALID_STATE', message: 'The review edit window has closed.' },
      }),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Local pickup (Wave 7 safe subset) — shapes mirror the durable service
// (crates/domain/src/commands.rs, crates/service/tests/pickup_test.rs).
// -----------------------------------------------------------------------------

const SELLER = 's'.repeat(52);
const LISTING_AGGREGATE_ID = `listing:${SELLER}_boots_01`;

function pickupCommand(kind: string, payload: Record<string, unknown>, aggregateId = LISTING_AGGREGATE_ID) {
  return {
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000731',
    aggregateId,
    expectedRevision: 0,
    issuedAt: '2026-08-19T22:00:00.000Z',
    kind,
    payload,
  };
}

const spotDetails = {
  kind: 'spot',
  spot: 'Central Station, north entrance',
  instructions: 'Ask for the blue backpack.',
  availability: {
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

describe('pickup_details.set command contract', () => {
  it('accepts the payload captured from the service tests (CAS on the details version)', () => {
    // The service test fixture sends `expected_version` snake_case on the
    // wire; the wire-casing layer camelCases at the transport boundary, so
    // this schema validates the camelCase form.
    const parsed = setPickupDetailsCommandSchema.parse(
      pickupCommand('pickup_details.set', { expectedVersion: 0, details: spotDetails }),
    );
    expect(parsed.payload.expectedVersion).toBe(0);
    expect(parsed.payload.details.spot).toBe('Central Station, north entrance');
    expect(parsed.payload.details.instructions).toBe('Ask for the blue backpack.');
  });

  it('is a member of the marketplace command union', () => {
    expect(
      marketplaceCommandSchema.parse(pickupCommand('pickup_details.set', { expectedVersion: 2, details: spotDetails }))
        .kind,
    ).toBe('pickup_details.set');
  });

  it('rejects a negative expected version and unknown payload fields', () => {
    expect(
      setPickupDetailsCommandSchema.safeParse(pickupCommand('pickup_details.set', { expectedVersion: -1, details: spotDetails }))
        .success,
    ).toBe(false);
    expect(
      setPickupDetailsCommandSchema.safeParse(
        pickupCommand('pickup_details.set', { expectedVersion: 0, details: spotDetails, note: 'x' }),
      ).success,
    ).toBe(false);
  });
});

describe('pickup_details.clear command contract', () => {
  it('accepts the expected_version CAS payload', () => {
    const parsed = clearPickupDetailsCommandSchema.parse(pickupCommand('pickup_details.clear', { expectedVersion: 4 }));
    expect(parsed.payload.expectedVersion).toBe(4);
  });

  it('is a member of the marketplace command union', () => {
    expect(marketplaceCommandSchema.parse(pickupCommand('pickup_details.clear', { expectedVersion: 0 })).kind).toBe(
      'pickup_details.clear',
    );
  });
});

describe('fulfillment.mark_ready / fulfillment.confirm_pickup command contracts', () => {
  it.each([
    ['fulfillment.mark_ready', markReadyForPickupCommandSchema],
    ['fulfillment.confirm_pickup', confirmPickupCommandSchema],
  ] as const)('%s targets the order aggregate with the order id payload', (kind, schema) => {
    const command = pickupCommand(kind, { orderId: ORDER_ID }, `order:${ORDER_ID}`);
    expect(schema.parse(command).payload.orderId).toBe(ORDER_ID);
    expect(marketplaceCommandSchema.parse(command).kind).toBe(kind);
  });

  it.each([
    ['fulfillment.mark_ready', markReadyForPickupCommandSchema],
    ['fulfillment.confirm_pickup', confirmPickupCommandSchema],
  ] as const)('%s rejects a non-uuid order id', (kind, schema) => {
    expect(schema.safeParse(pickupCommand(kind, { orderId: 'nope' }, `order:${ORDER_ID}`)).success).toBe(false);
  });
});

describe('pickup_details command result narrowing', () => {
  const response = {
    ok: true as const,
    version: 1 as const,
    commandId: '018f47d2-6a27-7c23-a62f-000000000731',
    aggregateId: LISTING_AGGREGATE_ID,
    revision: 3,
    eventIds: ['018f47d2-6a27-7c23-a62f-000000000732'],
  };

  it('narrows the set result to the new details version', () => {
    const result = asPickupDetailsCommandResult({
      ...response,
      result: { kind: 'pickup_details', listingAggregateId: LISTING_AGGREGATE_ID, version: 3, updatedAt: '2026-08-19T22:00:00.000Z' },
    });
    expect(result).toMatchObject({ kind: 'pickup_details', version: 3, listingAggregateId: LISTING_AGGREGATE_ID });
  });

  it('narrows the clear result with the surviving version and the cleared flag', () => {
    const result = asPickupDetailsCommandResult({
      ...response,
      result: {
        kind: 'pickup_details',
        listingAggregateId: LISTING_AGGREGATE_ID,
        version: 4,
        cleared: true,
        updatedAt: '2026-08-19T22:05:00.000Z',
      },
    });
    expect(result).toMatchObject({ version: 4, cleared: true });
  });

  it('returns null for a refusal or another command kind', () => {
    expect(
      asPickupDetailsCommandResult({
        ok: false,
        error: { code: 'INVALID_STATE', message: 'The listing does not publish pickup.' },
      }),
    ).toBeNull();
    expect(asPickupDetailsCommandResult({ ...response, result: { kind: 'order', state: 'paid' } })).toBeNull();
  });
});

describe('listing.register fulfillment methods (mirrors the service register validation)', () => {
  const registerPayload = {
    sellerPubky: SELLER,
    listingId: 'boots_01',
    listingRevision: 1,
    contentHash: 'a'.repeat(64),
    quantity: 5,
    unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
  };

  function registerCommand(payload: Record<string, unknown>) {
    return {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000733',
      aggregateId: LISTING_AGGREGATE_ID,
      expectedRevision: 0,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'listing.register',
      payload: { ...registerPayload, ...payload },
    };
  }

  it('defaults to shipping-only when the payload omits the methods (pre-pickup clients)', () => {
    expect(registerListingCommandSchema.parse(registerCommand({})).payload.fulfillmentMethods).toEqual(['shipping']);
  });

  it('accepts shipping+pickup and rejects empties, repeats, and unknown methods', () => {
    expect(
      registerListingCommandSchema.parse(registerCommand({ fulfillmentMethods: ['shipping', 'pickup'] })).payload
        .fulfillmentMethods,
    ).toEqual(['shipping', 'pickup']);
    expect(registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: [] })).success).toBe(false);
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: ['pickup', 'pickup'] })).success,
    ).toBe(false);
    expect(registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: ['drone'] })).success).toBe(
      false,
    );
  });

  it('refuses non-shipping methods on auction listings (auctions are shipping-only, §A2)', () => {
    const auction = {
      saleFormat: 'auction',
      auctionTerms: {
        startsAt: '2026-08-19T22:00:00.000Z',
        endsAt: '2026-08-20T22:00:00.000Z',
        minimumIncrement: { amountMinor: 100, currency: 'USD', exponent: 2 },
        antiSnipingWindowSeconds: 300,
        antiSnipingExtensionSeconds: 300,
      },
    };
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ ...auction, fulfillmentMethods: ['shipping'] })).success,
    ).toBe(true);
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ ...auction, fulfillmentMethods: ['pickup'] })).success,
    ).toBe(false);
    expect(
      registerListingCommandSchema.safeParse(
        registerCommand({ ...auction, fulfillmentMethods: ['shipping', 'pickup'] }),
      ).success,
    ).toBe(false);
  });
});

describe('checkout.create fulfillment and address rules (§A2)', () => {
  const address = {
    name: 'Alice Buyer',
    line1: '1 Market Street',
    line2: '',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    countryCode: 'US',
  };

  function checkoutCommand(lines: Record<string, unknown>[], withAddress: boolean) {
    return {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000734',
      aggregateId: 'checkout:018f47d2-6a27-7c23-a62f-000000000734',
      expectedRevision: 0,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'checkout.create',
      payload: {
        lines,
        ...(withAddress ? { deliveryAddress: address } : {}),
        guaranteePolicyVersion: 1,
      },
    };
  }

  const pickupLine = {
    listingAggregateId: LISTING_AGGREGATE_ID,
    expectedRevision: 1,
    quantity: 1,
    fulfillment: 'pickup',
  };
  const shippingLine = { listingAggregateId: `listing:${SELLER}_lamp_02`, expectedRevision: 2, quantity: 1 };

  it('accepts a pickup-only checkout with NO delivery address', () => {
    const parsed = createMarketplaceCheckoutCommandSchema.parse(checkoutCommand([pickupLine], false));
    expect(parsed.payload.deliveryAddress).toBeUndefined();
    expect(parsed.payload.lines[0].fulfillment).toBe('pickup');
  });

  it('rejects a pickup-only checkout that PRESENTS a delivery address', () => {
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine], true)).success).toBe(false);
  });

  it('requires a delivery address when any line ships (absent fulfillment means shipping)', () => {
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine, shippingLine], false)).success).toBe(
      false,
    );
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine, shippingLine], true)).success).toBe(
      true,
    );
  });

  it('keeps legacy checkouts valid: no line fulfillment plus an address', () => {
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([shippingLine], true)).success).toBe(true);
  });
});
