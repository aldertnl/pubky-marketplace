import { describe, expect, it } from 'vitest';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceCatalogEntryFixture,
  createCommerceListingFixture,
} from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import {
  applyMarketplaceAttributeFilters,
  buildMarketplaceCatalogItems,
  catalogItemFromCatalogEntry,
  collectMarketplaceAttributeFacets,
  filterMarketplaceCatalog,
  type MarketplaceCatalogFilters,
  type MarketplaceCatalogItem,
} from './useMarketplaceCatalog.utils';

function catalogItems(): MarketplaceCatalogItem[] {
  return buildMarketplaceCatalogItems(createCommerceSandboxCatalog().listings.map(toCommerceListingModel), []);
}

function filters(overrides: Partial<MarketplaceCatalogFilters> = {}): MarketplaceCatalogFilters {
  return {
    query: '',
    categoryId: null,
    saleFormat: 'all',
    conditions: [],
    minimumPriceMinor: null,
    maximumPriceMinor: null,
    countryCode: null,
    // (location filtering is covered in its own test below)
    sort: 'newest',
    ...overrides,
  };
}

describe('buildMarketplaceCatalogItems', () => {
  it('renders an index entry for a listing with no cached record', () => {
    const items = buildMarketplaceCatalogItems([], [createCommerceCatalogEntryFixture()]);

    expect(items).toEqual([
      expect.objectContaining({
        id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
        sellerId: COMMERCE_FIXTURE_SELLER,
        listingId: 'boots_01',
        title: 'Vintage leather boots',
        saleFormat: 'fixed_price',
        price: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        auction: null,
        location: { countryCode: 'US', region: 'NY' },
      }),
    ]);
  });

  it('prefers the cached canonical record when its revision is not behind the index', () => {
    const record = toCommerceListingModel(createCommerceListingFixture({ title: 'Hydrated title', revision: 2 }));
    const entry = createCommerceCatalogEntryFixture({ title: 'Indexed title', revision: 2 });

    const [item] = buildMarketplaceCatalogItems([record], [entry]);

    expect(item.title).toBe('Hydrated title');
    expect(item.revision).toBe(2);
  });

  it('prefers the index entry when it has seen a newer revision than the cache', () => {
    const record = toCommerceListingModel(createCommerceListingFixture({ title: 'Stale cached title', revision: 1 }));
    const entry = createCommerceCatalogEntryFixture({ title: 'Reindexed title', revision: 3 });

    const [item] = buildMarketplaceCatalogItems([record], [entry]);

    expect(item.title).toBe('Reindexed title');
    expect(item.revision).toBe(3);
  });

  it('unions records and entries that do not overlap', () => {
    const record = toCommerceListingModel(createCommerceListingFixture());
    const entry = createCommerceCatalogEntryFixture({
      id: `${COMMERCE_FIXTURE_SELLER}:jacket_01`,
      listing_id: 'jacket_01',
      title: 'Selvedge denim jacket',
    });

    const items = buildMarketplaceCatalogItems([record], [entry]);

    expect(items.map(({ listingId }) => listingId).sort()).toEqual(['boots_01', 'jacket_01']);
  });

  it('carries index media_urls onto the card item and tolerates entries cached before the field existed', () => {
    const [fresh] = buildMarketplaceCatalogItems([], [createCommerceCatalogEntryFixture()]);
    expect(fresh.mediaUrls).toEqual([`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`]);

    const legacyEntry = createCommerceCatalogEntryFixture();
    // Simulate a Dexie row written before the projection carried media_urls.
    delete (legacyEntry as Partial<typeof legacyEntry>).media_urls;
    const [legacy] = buildMarketplaceCatalogItems([], [legacyEntry]);
    expect(legacy.mediaUrls).toEqual([]);
  });

  it('uses only image media from a hydrated record for the card cover', () => {
    const record = createCommerceListingFixture();
    record.media = [
      {
        id: 'clip_01',
        type: 'video',
        url: `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/clip_01`,
        contentHash: 'b'.repeat(64),
        mimeType: 'video/mp4',
        byteSize: 20_000,
        width: 1_280,
        height: 720,
        durationMs: 4_000,
        altText: 'Boots walkthrough clip',
      },
      ...record.media,
    ];

    const [item] = buildMarketplaceCatalogItems([toCommerceListingModel(record)], []);

    expect(item.mediaUrls).toEqual([`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`]);
  });

  it('keeps auction terms null for an auction entry indexed before Nexus carried them', () => {
    const item = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({ sale_format: 'auction', auction: null }),
    );

    expect(item.saleFormat).toBe('auction');
    expect(item.auction).toBeNull();
    expect(item.price).toEqual({ amountMinor: 12_500, currency: 'USD', exponent: 2 });
  });
});

describe('filterMarketplaceCatalog', () => {
  it('excludes ordinary listings when browsing drops', () => {
    expect(filterMarketplaceCatalog(catalogItems(), filters({ saleFormat: 'drops' }))).toEqual([]);
    expect(filterMarketplaceCatalog(catalogItems(), filters({ saleFormat: 'all' })).length).toBeGreaterThan(0);
  });

  it('filters by the seller-declared item location', () => {
    const items = catalogItems();
    // Every sandbox fixture declares US: US matches everything, HR nothing,
    // and null means anywhere.
    expect(filterMarketplaceCatalog(items, filters({ countryCode: 'US' }))).toHaveLength(
      filterMarketplaceCatalog(items, filters()).length,
    );
    expect(filterMarketplaceCatalog(items, filters({ countryCode: 'HR' }))).toHaveLength(0);
  });

  it('searches title, description, and tags case-insensitively', () => {
    const results = filterMarketplaceCatalog(catalogItems(), filters({ query: 'JAZZ' }));

    expect(results.map(({ listingId }) => listingId)).toEqual(['jazz_first_press']);
  });

  it('matches a category subtree', () => {
    const results = filterMarketplaceCatalog(catalogItems(), filters({ categoryId: 'fashion-shoes' }));

    expect(results.map(({ listingId }) => listingId).sort()).toEqual(['leather_boots', 'trail_runners']);
  });

  it('combines format, condition, and inclusive price filters', () => {
    const results = filterMarketplaceCatalog(
      catalogItems(),
      filters({
        saleFormat: 'fixed_price',
        conditions: ['excellent'],
        minimumPriceMinor: 8_000,
        maximumPriceMinor: 14_000,
      }),
    );

    expect(results.map(({ listingId }) => listingId).sort()).toEqual(['mechanical_keyboard', 'selvedge_jacket']);
  });

  it('sorts price in both directions', () => {
    const low = filterMarketplaceCatalog(catalogItems(), filters({ sort: 'price_low' }));
    const high = filterMarketplaceCatalog(catalogItems(), filters({ sort: 'price_high' }));

    expect(low[0].listingId).toBe('jazz_first_press');
    expect(high[0].listingId).toBe('slr_program');
  });

  it('puts active auctions before fixed-price listings for ending-soon', () => {
    const results = filterMarketplaceCatalog(catalogItems(), filters({ sort: 'ending_soon' }));

    expect(results.slice(0, 2).every(({ saleFormat }) => saleFormat === 'auction')).toBe(true);
  });

  it('orders term-less auctions after known auctions but before fixed-price for ending-soon', () => {
    const staleAuction = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({
        id: `${COMMERCE_FIXTURE_SELLER}:mystery_auction`,
        listing_id: 'mystery_auction',
        sale_format: 'auction',
        auction: null,
      }),
    );

    const results = filterMarketplaceCatalog([...catalogItems(), staleAuction], filters({ sort: 'ending_soon' }));
    const order = results.map(({ listingId }) => listingId);
    const staleIndex = order.indexOf('mystery_auction');
    const knownAuctionIndexes = results
      .map((item, index) => (item.saleFormat === 'auction' && item.auction ? index : -1))
      .filter((index) => index >= 0);
    const fixedPriceIndexes = results
      .map((item, index) => (item.saleFormat === 'fixed_price' ? index : -1))
      .filter((index) => index >= 0);

    expect(knownAuctionIndexes.every((index) => index < staleIndex)).toBe(true);
    expect(fixedPriceIndexes.every((index) => index > staleIndex)).toBe(true);
  });
});

describe('applyMarketplaceAttributeFilters', () => {
  it('matches string values and list membership, and excludes unknown-attribute items honestly', () => {
    const items = catalogItems();
    // Index-projection item: attributes unknown, not merely empty.
    const indexItem = catalogItemFromCatalogEntry(
      createCommerceCatalogEntryFixture({
        id: `${COMMERCE_FIXTURE_SELLER}:index_only`,
        listing_id: 'index_only',
      }),
    );
    expect(indexItem.attributes).toBeNull();

    const bySize = applyMarketplaceAttributeFilters([...items, indexItem], { size: 'L' });
    expect(bySize.map(({ listingId }) => listingId)).toEqual(['varsity_fleece']);

    const byColor = applyMarketplaceAttributeFilters(items, { color: 'navy' });
    expect(byColor.map(({ listingId }) => listingId)).toEqual(['varsity_fleece']);

    const byBrandAndColor = applyMarketplaceAttributeFilters(items, { brand: 'Canon', color: 'black' });
    expect(byBrandAndColor.map(({ listingId }) => listingId)).toEqual(['slr_program']);

    // No active filters: everything passes, including unknown-attribute items.
    expect(applyMarketplaceAttributeFilters([...items, indexItem], {})).toHaveLength(items.length + 1);
  });
});

describe('collectMarketplaceAttributeFacets', () => {
  it('counts facet values over items with known attributes, expanding list values', () => {
    const facets = collectMarketplaceAttributeFacets(catalogItems(), ['size', 'brand', 'color']);

    expect(facets.get('size')).toEqual([{ value: 'L', count: 1 }]);
    expect(facets.get('brand')).toEqual([
      { value: 'Canon', count: 1 },
      { value: 'Champion', count: 1 },
    ]);
    expect(facets.get('color')).toEqual([
      { value: 'black', count: 1 },
      { value: 'grey', count: 1 },
      { value: 'navy', count: 1 },
    ]);
  });
});
