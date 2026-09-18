import { describe, expect, it } from 'vitest';
import { catalogItemFromCatalogEntry } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { COMMERCE_FIXTURE_SELLER, createCommerceCatalogEntryFixture } from '@/test/fixtures/commerce/commerce';
import { composeEndingSoonListings, composeFreshListings } from './useMarketplaceHotListings.utils';

function item(overrides: Parameters<typeof createCommerceCatalogEntryFixture>[0]) {
  return catalogItemFromCatalogEntry(createCommerceCatalogEntryFixture(overrides));
}

function auctionItem(listingId: string, endsAt: string, overrides: Parameters<typeof item>[0] = {}) {
  return item({
    id: `${COMMERCE_FIXTURE_SELLER}:${listingId}`,
    listing_id: listingId,
    sale_format: 'auction',
    auction: {
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt,
      reservePrice: null,
      buyNowPrice: null,
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
    },
    ...overrides,
  });
}

describe('composeEndingSoonListings', () => {
  it('orders active auctions by soonest end and caps the module', () => {
    const endsLater = auctionItem('ends_later', '2026-08-29T20:00:00.000Z');
    const endsSoonest = auctionItem('ends_soonest', '2026-08-22T20:00:00.000Z');
    const endsMiddle = auctionItem('ends_middle', '2026-08-25T20:00:00.000Z');

    const result = composeEndingSoonListings([endsLater, endsSoonest, endsMiddle], 2);

    expect(result.map(({ id }) => id)).toEqual([endsSoonest.id, endsMiddle.id]);
  });

  it('excludes fixed-price listings, non-active auctions, and stale rows without auction terms', () => {
    const fixedPrice = item({});
    const endedAuction = auctionItem('ended_auction', '2026-08-22T20:00:00.000Z', { state: 'ended' });
    const termlessAuction = item({
      id: `${COMMERCE_FIXTURE_SELLER}:termless`,
      listing_id: 'termless',
      sale_format: 'auction',
      auction: null,
    });

    expect(composeEndingSoonListings([fixedPrice, endedAuction, termlessAuction], 4)).toEqual([]);
  });
});

describe('composeFreshListings', () => {
  it('orders active listings by most recent update, skipping ids a sibling module already shows', () => {
    const shownElsewhere = item({ id: `${COMMERCE_FIXTURE_SELLER}:shown`, listing_id: 'shown', updated_at: 3_000 });
    const fresh = item({ id: `${COMMERCE_FIXTURE_SELLER}:fresh`, listing_id: 'fresh', updated_at: 2_000 });
    const stale = item({ id: `${COMMERCE_FIXTURE_SELLER}:stale`, listing_id: 'stale', updated_at: 1_000 });
    const paused = item({ id: `${COMMERCE_FIXTURE_SELLER}:paused`, listing_id: 'paused', state: 'paused' });

    const result = composeFreshListings([stale, shownElsewhere, fresh, paused], new Set([shownElsewhere.id]), 4);

    expect(result.map(({ id }) => id)).toEqual([fresh.id, stale.id]);
  });

  it('caps the module and returns empty when nothing is active', () => {
    const items = [
      item({ id: `${COMMERCE_FIXTURE_SELLER}:one`, listing_id: 'one', updated_at: 1 }),
      item({ id: `${COMMERCE_FIXTURE_SELLER}:two`, listing_id: 'two', updated_at: 2 }),
    ];

    expect(composeFreshListings(items, new Set(), 1)).toHaveLength(1);
    expect(composeFreshListings([item({ state: 'removed' })], new Set(), 4)).toEqual([]);
  });
});
