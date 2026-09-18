import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/database/franky/franky';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import {
  CommerceActivityCheckpointModel,
  CommerceCartItemModel,
  CommerceCatalogEntryModel,
  CommerceDeliveryAddressModel,
  CommerceFavoriteModel,
  CommerceListingDraftModel,
  CommerceListingModel,
  CommerceListingProjectionModel,
  CommerceSavedSearchModel,
  CommerceShippingPresetModel,
  CommerceShopFollowModel,
  CommerceShopModel,
  CommerceSyncJobModel,
  CommerceWatchAlertModel,
  CommerceWatchSnapshotModel,
} from '@/models/commerce/commerce.models';
import type {
  CommerceWatchAlertModelSchema,
  CommerceWatchSnapshotModelSchema,
} from '@/models/commerce/commerce.schema';
import {
  COMMERCE_FIXTURE_BUYER,
  COMMERCE_FIXTURE_SELLER,
  createCommerceCatalogEntryFixture,
  createCommerceListingFixture,
  createCommerceProjectionFixture,
  createCommerceShopFixture,
  createCommerceSyncJobFixture,
} from '@/test/fixtures/commerce/commerce';
import { LocalCommerceService } from './commerce';

describe('LocalCommerceService', () => {
  beforeEach(async () => {
    await db.initialize();
    await Promise.all([
      CommerceShopModel.table.clear(),
      CommerceListingModel.table.clear(),
      CommerceCatalogEntryModel.table.clear(),
      CommerceListingDraftModel.table.clear(),
      CommerceListingProjectionModel.table.clear(),
      CommerceSyncJobModel.table.clear(),
      CommerceFavoriteModel.table.clear(),
      CommerceShopFollowModel.table.clear(),
      CommerceCartItemModel.table.clear(),
      CommerceWatchSnapshotModel.table.clear(),
      CommerceWatchAlertModel.table.clear(),
      CommerceSavedSearchModel.table.clear(),
      CommerceDeliveryAddressModel.table.clear(),
      CommerceShippingPresetModel.table.clear(),
      CommerceActivityCheckpointModel.table.clear(),
    ]);
  });

  it('seeds the deterministic sandbox catalog once', async () => {
    const catalog = createCommerceSandboxCatalog();

    await expect(LocalCommerceService.seedSandboxCatalog(catalog)).resolves.toBe(true);
    await expect(LocalCommerceService.seedSandboxCatalog(catalog)).resolves.toBe(false);

    expect(await LocalCommerceService.getAllShops()).toHaveLength(10);
    expect(await LocalCommerceService.getAllListings()).toHaveLength(10);
    expect(await CommerceListingProjectionModel.table.count()).toBe(10);
  });

  it('persists normalized shop and listing cache fields', async () => {
    const shop = createCommerceShopFixture();
    const listing = createCommerceListingFixture();

    await LocalCommerceService.upsertShop(shop, 'pending');
    await LocalCommerceService.upsertListing(listing, 'synced');

    const storedShop = await LocalCommerceService.getShop(COMMERCE_FIXTURE_SELLER);
    const storedListing = await LocalCommerceService.getListing(`${COMMERCE_FIXTURE_SELLER}:boots_01`);

    expect(storedShop).toMatchObject({
      owner_id: COMMERCE_FIXTURE_SELLER,
      revision: 1,
      sync_status: 'pending',
    });
    expect(storedListing).toMatchObject({
      seller_id: COMMERCE_FIXTURE_SELLER,
      category_id: 'fashion-shoes-boots',
      format: 'fixed_price',
      currency: 'USD',
      price_minor: 12_500,
      sync_status: 'synced',
    });
  });

  it('deletes a listing from the record, projection, and catalog caches at once', async () => {
    const listing = createCommerceListingFixture();
    const compositeId = `${COMMERCE_FIXTURE_SELLER}:boots_01`;
    await LocalCommerceService.upsertListing(listing, 'synced');
    await CommerceListingProjectionModel.upsert(createCommerceProjectionFixture());
    await LocalCommerceService.bulkUpsertCatalogEntries([createCommerceCatalogEntryFixture()]);

    await LocalCommerceService.deleteListing(compositeId);

    expect(await LocalCommerceService.getListing(compositeId)).toBeNull();
    expect(await LocalCommerceService.getListingProjection(compositeId)).toBeNull();
    expect(await LocalCommerceService.getCatalogEntry(compositeId)).toBeNull();
  });

  it('bulk-upserts discovered catalog entries and reads them back newest first, by seller, and by id', async () => {
    const older = createCommerceCatalogEntryFixture({
      updated_at: Date.parse('2026-08-19T20:00:00.000Z'),
    });
    const newerOtherSeller = createCommerceCatalogEntryFixture({
      id: `${COMMERCE_FIXTURE_BUYER}:jacket_01`,
      seller_id: COMMERCE_FIXTURE_BUYER,
      listing_id: 'jacket_01',
      title: 'Selvedge denim jacket',
      updated_at: Date.parse('2026-08-19T22:00:00.000Z'),
    });

    await LocalCommerceService.bulkUpsertCatalogEntries([older, newerOtherSeller]);
    // A rediscovery of the same listing replaces the row instead of duplicating it.
    const reindexed = { ...older, revision: 2, title: 'Vintage leather boots (reindexed)' };
    await LocalCommerceService.bulkUpsertCatalogEntries([reindexed]);

    const all = await LocalCommerceService.getAllCatalogEntries();
    expect(all.map(({ id }) => id)).toEqual([newerOtherSeller.id, older.id]);

    const bySeller = await LocalCommerceService.getCatalogEntriesBySeller(COMMERCE_FIXTURE_SELLER);
    expect(bySeller).toEqual([reindexed]);

    const byId = await LocalCommerceService.getCatalogEntry(older.id);
    expect(byId).toMatchObject({ revision: 2, title: 'Vintage leather boots (reindexed)' });
  });

  it('stages public records and their retry jobs in the same local transaction', async () => {
    const shop = createCommerceShopFixture();
    const listing = createCommerceListingFixture();
    const shopJob = createCommerceSyncJobFixture({
      id: '018f47d2-6a27-7c23-a49d-6b21bb770125',
      entity_type: 'shop',
      entity_id: COMMERCE_FIXTURE_SELLER,
      operation: 'publish',
    });
    const listingJob = createCommerceSyncJobFixture();

    await LocalCommerceService.stageShopSync(shop, shopJob);
    await LocalCommerceService.stageListingSync(listing, listingJob);

    expect(await LocalCommerceService.getShop(COMMERCE_FIXTURE_SELLER)).toMatchObject({ sync_status: 'pending' });
    expect(await LocalCommerceService.getListing(`${COMMERCE_FIXTURE_SELLER}:boots_01`)).toMatchObject({
      sync_status: 'pending',
    });
    expect(await CommerceSyncJobModel.findById(shopJob.id)).toMatchObject({ entity_type: 'shop' });
    expect(await CommerceSyncJobModel.findById(listingJob.id)).toMatchObject({ entity_type: 'listing' });
  });

  it('rejects a sync job scoped to a different public record', async () => {
    const listing = createCommerceListingFixture();
    const mismatchedJob = createCommerceSyncJobFixture({ entity_id: 'other_listing' });

    await expect(LocalCommerceService.stageListingSync(listing, mismatchedJob)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_INPUT',
      category: 'validation',
    });
    expect(await CommerceListingModel.table.count()).toBe(0);
    expect(await CommerceSyncJobModel.table.count()).toBe(0);
  });

  it('atomically persists matching public terms and transaction projection', async () => {
    const listing = createCommerceListingFixture();
    const projection = createCommerceProjectionFixture();

    await LocalCommerceService.upsertListingAndProjection(listing, 'synced', projection);

    const storedListing = await LocalCommerceService.getListing(projection.id);
    const storedProjection = await LocalCommerceService.getListingProjection(projection.id);

    expect(storedListing?.revision).toBe(1);
    expect(storedProjection).toMatchObject({
      listing_revision: 1,
      server_revision: 3,
      state: 'available',
    });
  });

  it('rejects mismatched projections before writing either record', async () => {
    const listing = createCommerceListingFixture();
    const projection = createCommerceProjectionFixture({ listing_revision: 2 });

    await expect(LocalCommerceService.upsertListingAndProjection(listing, 'synced', projection)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_INPUT',
      category: 'validation',
    });

    expect(await CommerceListingModel.table.count()).toBe(0);
    expect(await CommerceListingProjectionModel.table.count()).toBe(0);
  });

  it('keeps listing drafts account-scoped and preserves their creation timestamp', async () => {
    await LocalCommerceService.upsertDraft({
      ownerId: COMMERCE_FIXTURE_SELLER,
      listingId: 'boots_01',
      data: { ownerPubky: COMMERCE_FIXTURE_SELLER, listingId: 'boots_01', title: 'First title' },
      now: 100,
    });
    await LocalCommerceService.upsertDraft({
      ownerId: COMMERCE_FIXTURE_SELLER,
      listingId: 'boots_01',
      data: { ownerPubky: COMMERCE_FIXTURE_SELLER, listingId: 'boots_01', title: 'Updated title' },
      now: 200,
    });
    await LocalCommerceService.upsertDraft({
      ownerId: COMMERCE_FIXTURE_BUYER,
      listingId: 'private',
      data: { ownerPubky: COMMERCE_FIXTURE_BUYER, listingId: 'private', title: 'Other account' },
      now: 300,
    });

    const sellerDrafts = await LocalCommerceService.getDraftsByOwner(COMMERCE_FIXTURE_SELLER);

    expect(sellerDrafts).toHaveLength(1);
    expect(sellerDrafts[0]).toMatchObject({
      created_at: 100,
      updated_at: 200,
      data: { title: 'Updated title' },
    });
  });

  it('rejects a draft whose embedded identity does not match its storage scope', async () => {
    await expect(
      LocalCommerceService.upsertDraft({
        ownerId: COMMERCE_FIXTURE_SELLER,
        listingId: 'boots_01',
        data: { ownerPubky: COMMERCE_FIXTURE_BUYER, listingId: 'other', title: 'Cross-account draft' },
        now: 100,
      }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_INPUT',
      category: 'validation',
    });

    expect(await CommerceListingDraftModel.table.count()).toBe(0);
  });

  it('completes a staged sync job by removing it', async () => {
    const job = createCommerceSyncJobFixture();
    await LocalCommerceService.stageListingSync(createCommerceListingFixture(), job);
    expect(await CommerceSyncJobModel.findById(job.id)).toMatchObject({ status: 'pending' });

    await LocalCommerceService.completeSyncJob(job.id);
    expect(await CommerceSyncJobModel.findById(job.id)).toBeNull();
  });

  it('persists idempotent favorites and shop follows per owner', async () => {
    const listingId = `${COMMERCE_FIXTURE_BUYER}:boots_01`;

    await LocalCommerceService.createFavorite(COMMERCE_FIXTURE_SELLER, listingId, 100);
    await LocalCommerceService.createFavorite(COMMERCE_FIXTURE_SELLER, listingId, 200);
    await LocalCommerceService.createShopFollow(COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER, 300);

    expect(await LocalCommerceService.isFavorite(COMMERCE_FIXTURE_SELLER, listingId)).toBe(true);
    expect(await LocalCommerceService.getFavorites(COMMERCE_FIXTURE_SELLER)).toHaveLength(1);
    expect(await LocalCommerceService.isShopFollowed(COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER)).toBe(true);

    await LocalCommerceService.deleteFavorite(COMMERCE_FIXTURE_SELLER, listingId, 400);
    await LocalCommerceService.deleteShopFollow(COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER);

    expect(await LocalCommerceService.isFavorite(COMMERCE_FIXTURE_SELLER, listingId)).toBe(false);
    expect(await LocalCommerceService.isShopFollowed(COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER)).toBe(false);
    // The unwatch left a mergeable tombstone; re-watching clears it again.
    expect(await LocalCommerceService.getWatchTombstones(COMMERCE_FIXTURE_SELLER)).toEqual([
      expect.objectContaining({ listing_id: listingId, removed_at: 400 }),
    ]);
    await LocalCommerceService.createFavorite(COMMERCE_FIXTURE_SELLER, listingId, 500);
    expect(await LocalCommerceService.getWatchTombstones(COMMERCE_FIXTURE_SELLER)).toEqual([]);
  });

  it('persists account-scoped cart quantities against real listing variants', async () => {
    const listing = createCommerceListingFixture();
    listing.variants[0].quantity = 3;
    await LocalCommerceService.upsertListing(listing, 'synced');
    const listingId = `${COMMERCE_FIXTURE_SELLER}:${listing.listingId}`;

    await LocalCommerceService.upsertCartItem(COMMERCE_FIXTURE_BUYER, listingId, 'variant_01', 2, 100);
    await LocalCommerceService.upsertCartItem(COMMERCE_FIXTURE_BUYER, listingId, 'variant_01', 3, 200);

    expect(await LocalCommerceService.getCartItems(COMMERCE_FIXTURE_BUYER)).toEqual([
      expect.objectContaining({ listing_id: listingId, variant_id: 'variant_01', quantity: 3, added_at: 100 }),
    ]);
    await expect(
      LocalCommerceService.upsertCartItem(COMMERCE_FIXTURE_BUYER, listingId, 'variant_01', 4, 300),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await LocalCommerceService.clearCart(COMMERCE_FIXTURE_BUYER);
    expect(await LocalCommerceService.getCartItems(COMMERCE_FIXTURE_BUYER)).toEqual([]);
  });

  const watchListingId = `${COMMERCE_FIXTURE_SELLER}:boots_01`;

  function watchSnapshotFixture(
    overrides: Partial<CommerceWatchSnapshotModelSchema> = {},
  ): CommerceWatchSnapshotModelSchema {
    return {
      id: `${COMMERCE_FIXTURE_BUYER}|${watchListingId}`,
      owner_id: COMMERCE_FIXTURE_BUYER,
      listing_id: watchListingId,
      title: 'Vintage boots',
      index_revision: 3,
      index_state: 'active',
      price_minor: 12_000,
      price_currency: 'USD',
      price_exponent: 2,
      auction_ends_at: null,
      server_revision: null,
      projection_state: null,
      bid_count: null,
      bid_amount_minor: null,
      leader_pubky: null,
      ending_soon_alerted_ends_at: null,
      checked_at: 100,
      ...overrides,
    };
  }

  function watchAlertFixture(overrides: Partial<CommerceWatchAlertModelSchema> = {}): CommerceWatchAlertModelSchema {
    const kind = overrides.kind ?? 'price_change';
    const dedupe = overrides.observed_revision ?? 4;
    return {
      id: `${COMMERCE_FIXTURE_BUYER}|${watchListingId}|${kind}|${dedupe}`,
      owner_id: COMMERCE_FIXTURE_BUYER,
      listing_id: watchListingId,
      seller_id: COMMERCE_FIXTURE_SELLER,
      kind,
      title: 'Vintage boots',
      source: 'index',
      observed_revision: 4,
      ends_at: null,
      previous_amount_minor: 12_000,
      current_amount_minor: 9_000,
      currency: 'USD',
      exponent: 2,
      bid_count: null,
      previous_state: null,
      next_state: null,
      created_at: 200,
      seen_at: null,
      ...overrides,
    };
  }

  it('persists a detection pass atomically and never resets seen state on re-detection', async () => {
    const snapshot = watchSnapshotFixture();
    const alert = watchAlertFixture();

    await LocalCommerceService.saveWatchDetection(COMMERCE_FIXTURE_BUYER, [snapshot], [alert]);
    await LocalCommerceService.markWatchAlertsSeen(COMMERCE_FIXTURE_BUYER, 999);

    // A re-detection producing the same deterministic alert id must not
    // overwrite the row (that would resurrect it as unseen).
    await LocalCommerceService.saveWatchDetection(
      COMMERCE_FIXTURE_BUYER,
      [watchSnapshotFixture({ checked_at: 300 })],
      [watchAlertFixture()],
    );

    const alerts = await LocalCommerceService.getWatchAlerts(COMMERCE_FIXTURE_BUYER);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].seen_at).toBe(999);
    expect(await LocalCommerceService.getWatchSnapshots(COMMERCE_FIXTURE_BUYER)).toEqual([
      expect.objectContaining({ checked_at: 300 }),
    ]);
  });

  it('prunes the oldest watch alerts beyond the per-owner cap', async () => {
    const { COMMERCE_WATCH_ALERTS_MAX_PER_OWNER } = await import('./commerce');
    const alerts = Array.from({ length: COMMERCE_WATCH_ALERTS_MAX_PER_OWNER + 5 }, (_, index) =>
      watchAlertFixture({
        id: `${COMMERCE_FIXTURE_BUYER}|${watchListingId}|price_change|${index}`,
        observed_revision: index,
        created_at: index,
      }),
    );

    await LocalCommerceService.saveWatchDetection(COMMERCE_FIXTURE_BUYER, [], alerts);

    const stored = await LocalCommerceService.getWatchAlerts(COMMERCE_FIXTURE_BUYER);
    expect(stored).toHaveLength(COMMERCE_WATCH_ALERTS_MAX_PER_OWNER);
    // Newest-first read; the oldest five were pruned.
    expect(stored[stored.length - 1].created_at).toBe(5);
  });

  it('advances a saved search watermark only on acknowledgement', async () => {
    await LocalCommerceService.createSavedSearch({
      id: 'search-1',
      owner_id: COMMERCE_FIXTURE_BUYER,
      name: 'Boots under $150',
      params: {
        query: 'boots',
        categoryId: null,
        saleFormat: 'all',
        conditions: [],
        minimumPriceMinor: null,
        maximumPriceMinor: 15_000,
        sort: 'newest',
      },
      watermark_updated_at: 1_000,
      latest_match_updated_at: 1_000,
      new_count: 0,
      last_checked_at: null,
      created_at: 100,
    });

    await LocalCommerceService.recordSavedSearchCheck('search-1', {
      newCount: 3,
      latestMatchUpdatedAt: 5_000,
      checkedAt: 6_000,
    });
    let [search] = await LocalCommerceService.getSavedSearches(COMMERCE_FIXTURE_BUYER);
    expect(search).toMatchObject({ new_count: 3, latest_match_updated_at: 5_000, watermark_updated_at: 1_000 });

    await LocalCommerceService.acknowledgeSavedSearch('search-1');
    [search] = await LocalCommerceService.getSavedSearches(COMMERCE_FIXTURE_BUYER);
    expect(search).toMatchObject({ new_count: 0, watermark_updated_at: 5_000 });

    await LocalCommerceService.deleteSavedSearch('search-1');
    expect(await LocalCommerceService.getSavedSearches(COMMERCE_FIXTURE_BUYER)).toEqual([]);
  });

  describe('delivery address book', () => {
    const addressInput = (label: string) => ({
      label,
      name: 'Satoshi Buyer',
      line1: '1 Main Street',
      line2: '',
      city: 'Lisbon',
      region: 'Lisboa',
      postalCode: '1000-001',
      countryCode: 'PT',
    });

    it('creates, updates, and deletes account-scoped addresses', async () => {
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr1', addressInput('Home'), 100);

      let addresses = await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER);
      expect(addresses).toEqual([
        expect.objectContaining({
          id: `${COMMERCE_FIXTURE_BUYER}:addr1`,
          owner_id: COMMERCE_FIXTURE_BUYER,
          label: 'Home',
          postal_code: '1000-001',
          country_code: 'PT',
          created_at: 100,
          updated_at: 100,
          last_used_at: null,
        }),
      ]);

      await LocalCommerceService.upsertDeliveryAddress(
        COMMERCE_FIXTURE_BUYER,
        'addr1',
        { ...addressInput('Home office'), line1: '2 Other Street' },
        200,
      );
      addresses = await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER);
      expect(addresses).toEqual([
        expect.objectContaining({ label: 'Home office', line1: '2 Other Street', created_at: 100, updated_at: 200 }),
      ]);

      await LocalCommerceService.deleteDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr1');
      expect(await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER)).toEqual([]);
    });

    it('makes the first saved address the default and keeps defaults exclusive', async () => {
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr1', addressInput('Home'), 100);
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr2', addressInput('Work'), 200);

      let addresses = await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER);
      expect(addresses.map(({ label, is_default }) => ({ label, is_default }))).toEqual([
        { label: 'Home', is_default: true },
        { label: 'Work', is_default: false },
      ]);

      await LocalCommerceService.setDefaultDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr2', 300);
      addresses = await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER);
      expect(addresses.map(({ label, is_default }) => ({ label, is_default }))).toEqual([
        { label: 'Work', is_default: true },
        { label: 'Home', is_default: false },
      ]);

      await expect(
        LocalCommerceService.setDefaultDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'missing', 400),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('orders the picker default-first, then by most recent use', async () => {
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr1', addressInput('Home'), 100);
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr2', addressInput('Work'), 200);
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr3', addressInput('Parents'), 300);

      await LocalCommerceService.markDeliveryAddressUsed(COMMERCE_FIXTURE_BUYER, 'addr2', 400);

      const addresses = await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_BUYER);
      // addr1 is the default; among the rest, addr2 was used most recently.
      expect(addresses.map(({ label }) => label)).toEqual(['Home', 'Work', 'Parents']);
      expect(addresses[1].last_used_at).toBe(400);

      // Marking an unknown address used is a silent no-op (the order already
      // succeeded; there is nothing to update).
      await LocalCommerceService.markDeliveryAddressUsed(COMMERCE_FIXTURE_BUYER, 'missing', 500);
    });

    it('keeps address books account-scoped', async () => {
      await LocalCommerceService.upsertDeliveryAddress(COMMERCE_FIXTURE_BUYER, 'addr1', addressInput('Home'), 100);
      expect(await LocalCommerceService.getDeliveryAddresses(COMMERCE_FIXTURE_SELLER)).toEqual([]);
    });
  });

  describe('shipping presets', () => {
    const presetInput = (label: string, priceMinor = 1_200) => ({
      label,
      priceMinor,
      currency: 'USD' as const,
      estimatedMinDays: 2,
      estimatedMaxDays: 6,
    });

    it('creates, updates, lists, and deletes account-scoped presets', async () => {
      await LocalCommerceService.upsertShippingPreset(COMMERCE_FIXTURE_SELLER, 'p1', presetInput('Standard'), 100);
      await LocalCommerceService.upsertShippingPreset(
        COMMERCE_FIXTURE_SELLER,
        'p2',
        presetInput('Express', 2_500),
        200,
      );

      let presets = await LocalCommerceService.getShippingPresets(COMMERCE_FIXTURE_SELLER);
      expect(presets.map(({ label }) => label)).toEqual(['Express', 'Standard']);
      expect(presets[0]).toMatchObject({
        id: `${COMMERCE_FIXTURE_SELLER}:p2`,
        price_minor: 2_500,
        estimated_min_days: 2,
        estimated_max_days: 6,
      });

      await LocalCommerceService.upsertShippingPreset(
        COMMERCE_FIXTURE_SELLER,
        'p1',
        presetInput('Standard tracked', 1_500),
        300,
      );
      presets = await LocalCommerceService.getShippingPresets(COMMERCE_FIXTURE_SELLER);
      expect(presets.map(({ label }) => label)).toEqual(['Standard tracked', 'Express']);
      expect(presets[0]).toMatchObject({ created_at: 100, updated_at: 300 });

      await LocalCommerceService.deleteShippingPreset(COMMERCE_FIXTURE_SELLER, 'p1');
      await LocalCommerceService.deleteShippingPreset(COMMERCE_FIXTURE_SELLER, 'p2');
      expect(await LocalCommerceService.getShippingPresets(COMMERCE_FIXTURE_SELLER)).toEqual([]);
    });

    it('keeps presets account-scoped', async () => {
      await LocalCommerceService.upsertShippingPreset(COMMERCE_FIXTURE_SELLER, 'p1', presetInput('Standard'), 100);
      expect(await LocalCommerceService.getShippingPresets(COMMERCE_FIXTURE_BUYER)).toEqual([]);
    });
  });

  describe('activity read checkpoint', () => {
    it('defaults to zero for an account this device never opened an activity surface for', async () => {
      expect(await LocalCommerceService.getActivityReadCheckpoint(COMMERCE_FIXTURE_BUYER)).toBe(0);
    });

    it('advances on visit and never moves backward', async () => {
      await LocalCommerceService.markActivityRead(COMMERCE_FIXTURE_BUYER, 1_000);
      expect(await LocalCommerceService.getActivityReadCheckpoint(COMMERCE_FIXTURE_BUYER)).toBe(1_000);

      await LocalCommerceService.markActivityRead(COMMERCE_FIXTURE_BUYER, 2_000);
      expect(await LocalCommerceService.getActivityReadCheckpoint(COMMERCE_FIXTURE_BUYER)).toBe(2_000);

      // A stale clock (or an out-of-order call) must not resurrect "new" rows.
      await LocalCommerceService.markActivityRead(COMMERCE_FIXTURE_BUYER, 500);
      expect(await LocalCommerceService.getActivityReadCheckpoint(COMMERCE_FIXTURE_BUYER)).toBe(2_000);
    });

    it('keeps checkpoints account-scoped', async () => {
      await LocalCommerceService.markActivityRead(COMMERCE_FIXTURE_BUYER, 1_000);
      expect(await LocalCommerceService.getActivityReadCheckpoint(COMMERCE_FIXTURE_SELLER)).toBe(0);
    });
  });
});
