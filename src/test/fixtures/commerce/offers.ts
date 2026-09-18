import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';

export const OFFER_FIXTURE_BUYER = 'b'.repeat(52);
export const OFFER_FIXTURE_SELLER = 's'.repeat(52);

/**
 * Keyed record instead of a plain array so adding a state to the offer schema
 * union fails compilation here (missing key) instead of leaving the new state
 * silently untested.
 */
const OFFER_STATE_MESSAGES = {
  pending: 'Would you take this for the pair? I can pick up locally this week.',
  countered: 'Meet in the middle? This is my best number for a fast close.',
  accepted: 'Great — accepted. Please proceed to checkout when ready.',
  rejected: 'Sorry, this is below what I can accept for this item.',
  withdrawn: 'Withdrawing this offer — found another option.',
  expired: 'This offer lapsed before the seller responded.',
} as const satisfies Record<MarketplaceOffer['state'], string>;

/** Every offer state the marketplace offer schema defines. */
export const OFFER_STATES = Object.keys(OFFER_STATE_MESSAGES) as readonly MarketplaceOffer['state'][];

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `018f47d2-6a27-7c23-b51e-${hex}`;
}

export function createOfferFixture(
  state: MarketplaceOffer['state'],
  overrides: Partial<MarketplaceOffer> = {},
): MarketplaceOffer {
  const stateIndex = OFFER_STATES.indexOf(state) + 1;
  return {
    id: uuid(stateIndex),
    aggregateId: `offer:${uuid(100 + stateIndex)}`,
    listingAggregateId: buildMarketplaceListingAggregateId(OFFER_FIXTURE_SELLER, 'leather_boots'),
    buyerPubky: OFFER_FIXTURE_BUYER,
    sellerPubky: OFFER_FIXTURE_SELLER,
    revision: stateIndex,
    state,
    offeredBy: OFFER_FIXTURE_BUYER,
    amount: usd(9_500 + stateIndex * 500),
    quantity: 1,
    message: OFFER_STATE_MESSAGES[state],
    expiresAt: '2026-08-21T12:00:00.000Z',
    updatedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

/** One offer per schema state, authored by `offeredBy` (defaults to the buyer). */
export function createOffersForEveryState(offeredBy: string = OFFER_FIXTURE_BUYER): MarketplaceOffer[] {
  return OFFER_STATES.map((state) => createOfferFixture(state, { offeredBy }));
}
