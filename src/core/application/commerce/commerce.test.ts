import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagKind } from '@/application/tag/tag.types';
import * as commerceConfig from '@/config/commerce';
import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AuthErrorCode, ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceCatalogEntryModel, CommerceListingModel, CommerceShopModel } from '@/models/commerce/commerce.models';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { LocalMarketplaceTagService } from '@/services/local/tag/marketplace/tag.marketplace';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { NexusMarketplaceService } from '@/services/nexus/marketplace/marketplace';
import type { NexusListingDetails } from '@/services/nexus/marketplace/marketplace.types';
import {
  COMMERCE_FIXTURE_SELLER,
  createCommerceCatalogEntryFixture,
  createCommerceListingFixture,
  createCommerceShopFixture,
  createNexusAuctionListingDetailsFixture,
  createNexusListingDetailsFixture,
} from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { CommerceApplication } from './commerce';

const SHOP_URL = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/shop.json`;
const LISTING_URL = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/listings/boots_01`;
const SELLER_REFRESH_FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../test/fixtures/commerce/live/seller-dashboard-refresh-v23.json'), 'utf8'),
) as {
  nexus: NexusListingDetails[];
  canonical: Array<{ record: unknown; provenance: { contentSha256: string; sourceUri: string } }>;
  provenance: {
    capturedAtUtc: string;
    sourceManifestSha256: string;
    nexusInventoryWholeFileSha256: string;
    stableContentHashEncoding: string;
    sources: Record<string, { wholeFileSha256: string; contentSha256: string }>;
  };
};

describe('CommerceApplication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins repaired fixture provenance and canonical content hashes', () => {
    expect(SELLER_REFRESH_FIXTURE.provenance).toMatchObject({
      capturedAtUtc: '2026-09-11T13:00:05.111Z',
      sourceManifestSha256: '75bbbe4c5d3b4ae160589ffb25c3cbaf7df63b3ae1b07129887d891248455a42',
      nexusInventoryWholeFileSha256: 'b899f0ca780dda0d226c7140b393818fd873f8acfb0006bd05d037d7d4ecc4b0',
    });
    expect(SELLER_REFRESH_FIXTURE.provenance.sources).toEqual({
      offer: {
        wholeFileSha256: '01bfd471185db06f79bb148df4009a946e51c09e8fa83d582e144bd4b8ae5439',
        contentSha256: '4a200919c86eb6450f2d6cc15d5adc2e25422d39f9911a6a5e21d04a025924d0',
      },
      verify: {
        wholeFileSha256: '6dc57c5fed7da1914efe30600decc9e8030c2e8ca65b44725f32d163e75fdf48',
        contentSha256: 'be1b2a4e6d02998cc446080eadf037bfc2bb2e5cc6ddfd0b540906323a84502e',
      },
      casio: {
        wholeFileSha256: '4b4d25a821683373f0717ed0cd2457696c5b630802e36f9519b08b4cda50155c',
        contentSha256: '055c7270893b0fc45837b0b4235b82f4ed689c6a733330f059566145d0845171',
      },
    });

    const sourceByListingId = {
      c73b6be3ab4642539c69a797f9006dcb: 'offer',
      '45b2aedff744407ea2d67c8069ed112e': 'verify',
      aa2c8b308dbc47619793fe64dcefa9e8: 'casio',
    } as const;
    for (const { record, provenance } of SELLER_REFRESH_FIXTURE.canonical) {
      const listingRecord = record as { listingId: keyof typeof sourceByListingId };
      const source = SELLER_REFRESH_FIXTURE.provenance.sources[sourceByListingId[listingRecord.listingId]];
      expect(createHash('sha256').update(JSON.stringify(record)).digest('hex')).toBe(provenance.contentSha256);
      expect(provenance.contentSha256).toBe(source.contentSha256);
    }

    const tampered = { ...(SELLER_REFRESH_FIXTURE.canonical[0].record as Record<string, unknown>), title: 'tampered' };
    expect(createHash('sha256').update(JSON.stringify(tampered)).digest('hex')).not.toBe(
      SELLER_REFRESH_FIXTURE.provenance.sources.offer.contentSha256,
    );
  });

  it('returns a local shop without a network request', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
      new CommerceShopModel({
        id: COMMERCE_FIXTURE_SELLER,
        owner_id: COMMERCE_FIXTURE_SELLER,
        record,
        revision: 1,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      }),
    );
    const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    await expect(CommerceApplication.getOrFetchShop(COMMERCE_FIXTURE_SELLER)).resolves.toEqual(record);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    { available: 0, expected: 0 },
    { available: 2, expected: 2 },
  ])('derives purchasable inventory without rewriting the signed record', async ({ available, expected }) => {
    const record = createCommerceListingFixture({
      variants: [{ ...createCommerceListingFixture().variants[0], quantity: 3 }],
    });
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: available === 0 ? 'sold' : 'available',
      available_quantity: available,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });

    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);

    expect(listing.purchasableQuantity).toBe(expected);
    expect(listing.record.variants[0].quantity).toBe(3);
  });

  it('keeps the original quantity in the homeserver write after reading projected inventory', async () => {
    const record = createCommerceListingFixture({
      variants: [{ ...createCommerceListingFixture().variants[0], quantity: 3 }],
    });
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: 'available',
      available_quantity: 0,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });
    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');

    await CommerceApplication.commitUpsertListing({
      ...listing.record,
      revision: listing.record.revision + 1,
      state: 'paused',
      updatedAt: new Date().toISOString(),
    });

    expect(put.mock.calls[0][1]).toMatchObject({ variants: [{ quantity: 3 }] });
  });

  it('does not derive availability from a stale projection revision', async () => {
    const record = createCommerceListingFixture();
    const model = toCommerceListingModel(record);
    vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue([model]);
    vi.spyOn(LocalCommerceService, 'getListingProjection').mockResolvedValue({
      id: model.id,
      seller_id: model.seller_id,
      listing_id: model.listing_id,
      listing_revision: record.revision - 1,
      content_hash: record.media[0].contentHash,
      server_revision: 2,
      state: 'sold',
      available_quantity: 0,
      current_price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
      auction_state: null,
      bid_count: 0,
      sync_status: 'synced',
      synced_at: Date.now(),
    });

    const [listing] = await CommerceApplication.getListingsBySeller(record.ownerPubky);

    expect(listing.purchasableQuantity).toBeNull();
  });

  it('seeds catalog data only when sandbox mode is explicit', async () => {
    const seed = vi.spyOn(LocalCommerceService, 'seedSandboxCatalog').mockResolvedValue(true);
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');

    await expect(CommerceApplication.initializeSandboxCatalog()).resolves.toBe(false);
    expect(seed).not.toHaveBeenCalled();

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('sandbox');
    await expect(CommerceApplication.initializeSandboxCatalog()).resolves.toBe(true);
    expect(seed).toHaveBeenCalledOnce();
  });

  it('fetches, validates, and caches a missing shop', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(record);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

    await expect(CommerceApplication.getOrFetchShop(COMMERCE_FIXTURE_SELLER)).resolves.toEqual(record);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
  });

  it('fetches, validates, and caches a missing listing', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(record);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);

    await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(record);
    expect(CommerceHomeserverService.fetchJson).toHaveBeenCalledWith(LISTING_URL);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
  });

  it('stages a shop locally before publishing and then clears its job', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770120');
    const stage = vi.spyOn(LocalCommerceService, 'stageShopSync').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);

    await CommerceApplication.commitUpsertShop(record);

    expect(stage).toHaveBeenCalledWith(
      record,
      expect.objectContaining({
        id: '018f47d2-6a27-7c23-a49d-6b21bb770120',
        entity_type: 'shop',
        entity_id: COMMERCE_FIXTURE_SELLER,
        operation: 'publish',
        status: 'pending',
        payload: { url: SHOP_URL },
      }),
    );
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(put.mock.invocationCallOrder[0]);
    expect(put).toHaveBeenCalledWith(SHOP_URL, record);
    expect(upsert).toHaveBeenCalledWith(record, 'synced');
    expect(complete).toHaveBeenCalledWith('018f47d2-6a27-7c23-a49d-6b21bb770120');
  });

  it('leaves a staged shop pending when the homeserver write fails', async () => {
    const record = createCommerceShopFixture();
    vi.spyOn(LocalCommerceService, 'stageShopSync').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(new TypeError('network unavailable'));
    const upsert = vi.spyOn(LocalCommerceService, 'upsertShop');
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

    await expect(CommerceApplication.commitUpsertShop(record)).rejects.toThrow('network unavailable');
    expect(upsert).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('publishes a listing and registers it with the transaction service in sandbox mode', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const stage = vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({} as never);

    await CommerceApplication.commitUpsertListing(record);

    expect(stage).toHaveBeenCalledWith(record, expect.objectContaining({ operation: 'publish' }));
    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        kind: 'listing.register',
        payload: expect.objectContaining({
          sellerPubky: record.ownerPubky,
          listingId: record.listingId,
          listingRevision: record.revision,
        }),
      }),
    );
  });

  it('skips transaction-service registration when the listing is already registered (sandbox)', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 4 } as never);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await CommerceApplication.commitUpsertListing(record);

    expect(execute).not.toHaveBeenCalled();
  });

  it('syncs an already-registered listing on republish so edits reach the authority (durable)', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue({ serverRevision: 4 } as never);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

    const result = await CommerceApplication.commitUpsertListing(record);

    // The convergent sync — never a fresh register — carries the edit.
    expect(execute).toHaveBeenCalledWith(
      record.ownerPubky,
      expect.objectContaining({
        kind: 'listing.sync',
        payload: { sellerPubky: record.ownerPubky, listingId: record.listingId },
      }),
    );
    expect(result).toEqual({ registered: true });
  });

  it('publishes a listing without registration when the marketplace adapter is unavailable', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
    vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await CommerceApplication.commitUpsertListing(record);

    expect(put).toHaveBeenCalledWith(LISTING_URL, record);
    expect(execute).not.toHaveBeenCalled();
  });

  it('issues listing.sync as a convergent command any actor may send', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770130');
    const response = {
      ok: true as const,
      version: 1 as const,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770130',
      aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
      revision: 1,
      eventIds: [],
      result: { kind: 'listing' as const },
    };
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(response);
    const buyer = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u';

    await expect(
      CommerceApplication.syncListingRegistration(buyer, COMMERCE_FIXTURE_SELLER, 'boots_01'),
    ).resolves.toEqual(response);

    // The buyer — not the seller — is the acting identity, and the command
    // is convergent: expectedRevision is always 0.
    expect(execute).toHaveBeenCalledWith(
      buyer,
      expect.objectContaining({
        kind: 'listing.sync',
        aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
        expectedRevision: 0,
        payload: { sellerPubky: COMMERCE_FIXTURE_SELLER, listingId: 'boots_01' },
      }),
    );
  });

  it('refuses listing.sync outside the durable transaction-service modes', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(
      CommerceApplication.syncListingRegistration(
        'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u',
        COMMERCE_FIXTURE_SELLER,
        'boots_01',
      ),
    ).rejects.toThrow('Listing sync requires the durable transaction service.');
    expect(execute).not.toHaveBeenCalled();
  });

  describe('multi-operator mismatch guard (docs/ecommerce/multi-operator.md, increment 1)', () => {
    const command = {
      version: 1 as const,
      commandId: '018f47d2-6a27-7c23-a49d-6b21bb770140',
      aggregateId: `listing:${COMMERCE_FIXTURE_SELLER}_boots_01`,
      expectedRevision: 1,
      issuedAt: '2026-08-23T12:00:00.000Z',
      kind: 'checkout.create',
      payload: {},
    } as never;

    const shopModelWith = (transactionService?: string) => {
      const record = { ...createCommerceShopFixture(), ...(transactionService ? { transactionService } : {}) };
      return new CommerceShopModel({
        id: COMMERCE_FIXTURE_SELLER,
        owner_id: COMMERCE_FIXTURE_SELLER,
        record,
        revision: 1,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      });
    };

    it('refuses a listing-aggregate command when the shop declares a different service origin', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith('https://other-operator.example'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).rejects.toThrow(
        'sells through a different marketplace service',
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('passes when the declared origin matches the configured service', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        shopModelWith('https://service.this-deployment.example/api'),
      );
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('passes when the shop declares nothing', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith());
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('fails open when the shop record cannot be read at all', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new Error('homeserver unreachable'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });

    it('does not guard sandbox commands or non-listing aggregates', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(shopModelWith('https://other-operator.example'));
      const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue({ ok: true } as never);

      await expect(CommerceApplication.executeMarketplaceCommand('actor', command)).resolves.toEqual({ ok: true });

      vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
      vi.spyOn(commerceConfig, 'getMarketplaceUrl').mockReturnValue('https://service.this-deployment.example');
      const orderCommand = { ...(command as Record<string, unknown>), aggregateId: 'order:some-order-id' } as never;
      await expect(CommerceApplication.executeMarketplaceCommand('actor', orderCommand)).resolves.toEqual({
        ok: true,
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it('lists own drop ids from the homeserver drops directory, ignoring non-id entries', async () => {
    const base = `pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/drops/`;
    vi.spyOn(HomeserverService, 'listAll').mockResolvedValue([
      `${base}drop_summer_01`,
      `${base}drop_autumn_02`,
      `${base}nested/never-an-id`,
      base,
    ]);

    await expect(CommerceApplication.listOwnDropIds(COMMERCE_FIXTURE_SELLER)).resolves.toEqual([
      'drop_summer_01',
      'drop_autumn_02',
    ]);
    expect(HomeserverService.listAll).toHaveBeenCalledWith({ baseDirectory: base });
  });

  it('deletes a listing from the homeserver, then every local cache, then its media', async () => {
    const record = createCommerceListingFixture();
    const compositeId = `${record.ownerPubky}:${record.listingId}`;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770122');
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(
      new CommerceListingModel({
        id: compositeId,
        seller_id: record.ownerPubky,
        listing_id: record.listingId,
        record,
        revision: record.revision,
        state: record.state,
        category_id: record.categoryId,
        format: record.sale.format,
        currency: 'USD',
        price_minor: 12_500,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      }),
    );
    const upsertJob = vi.spyOn(LocalCommerceService, 'upsertSyncJob').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'delete').mockResolvedValue(undefined);
    const deleteLocal = vi.spyOn(LocalCommerceService, 'deleteListing').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);

    await CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId);

    expect(upsertJob).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'listing', entity_id: record.listingId, operation: 'remove' }),
    );
    expect(remove).toHaveBeenNthCalledWith(1, LISTING_URL);
    expect(deleteLocal).toHaveBeenCalledWith(compositeId);
    expect(complete).toHaveBeenCalledWith('018f47d2-6a27-7c23-a49d-6b21bb770122');
    // Media cleanup follows the record deletion, one call per media file.
    record.media.forEach((media) => expect(remove).toHaveBeenCalledWith(media.url));
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(deleteLocal.mock.invocationCallOrder[0]);
  });

  it('keeps the local listing when the homeserver record deletion fails', async () => {
    const record = createCommerceListingFixture();
    vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
    vi.spyOn(LocalCommerceService, 'upsertSyncJob').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'delete').mockRejectedValue(new TypeError('network unavailable'));
    const deleteLocal = vi.spyOn(LocalCommerceService, 'deleteListing');
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

    await expect(CommerceApplication.commitDeleteListing(record.ownerPubky, record.listingId)).rejects.toThrow(
      'network unavailable',
    );
    expect(deleteLocal).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  describe('fetchSellerCatalogListings', () => {
    const capturedRecords = SELLER_REFRESH_FIXTURE.canonical.map(({ record }) =>
      CommerceRecordNormalizer.listing(record),
    );
    const capturedById = new Map(capturedRecords.map((record) => [record.listingId, record]));
    const capturedSeller = capturedRecords[0].ownerPubky;

    it('refreshes discovery and hydrates the missing canonical listing while retaining cached records', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(capturedById.get('c73b6be3ab4642539c69a797f9006dcb')!, 'synced');
      await LocalCommerceService.upsertListing(capturedById.get('45b2aedff744407ea2d67c8069ed112e')!, 'synced');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(SELLER_REFRESH_FIXTURE.nexus);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        const listingId = url.split('/').pop();
        return capturedById.get(listingId!)!;
      });

      await CommerceApplication.refreshListingsBySeller(capturedSeller);

      expect(await LocalCommerceService.getListingsBySeller(capturedSeller)).toHaveLength(3);
      expect(fetchJson).toHaveBeenCalledExactlyOnceWith(
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/aa2c8b308dbc47619793fe64dcefa9e8`,
      );
    });

    it('rejects an owner-mismatched Nexus row before mutating the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const existing = createCommerceCatalogEntryFixture({ listing_id: 'existing' });
      await CommerceCatalogEntryModel.table.clear();
      await CommerceCatalogEntryModel.table.put(existing);
      const before = await CommerceCatalogEntryModel.table.toArray();
      const mismatched = {
        ...(SELLER_REFRESH_FIXTURE.nexus[0] as Record<string, unknown>),
        owner_id: 's'.repeat(52),
        uri: `pubky://${'s'.repeat(52)}/pub/pubky.app/marketplace/v1/listings/c73b6be3ab4642539c69a797f9006dcb`,
      } as NexusListingDetails;
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([mismatched]);

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(before);
    });

    it('uses the real Dexie revision seam for missing and stale canonical hydration', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const stale = { ...capturedById.get('45b2aedff744407ea2d67c8069ed112e')!, revision: 1 };
      await LocalCommerceService.upsertListing(capturedById.get('c73b6be3ab4642539c69a797f9006dcb')!, 'synced');
      await LocalCommerceService.upsertListing(stale, 'synced');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(SELLER_REFRESH_FIXTURE.nexus);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        const listingId = url.split('/').pop();
        return capturedById.get(listingId!)!;
      });

      await CommerceApplication.refreshListingsBySeller(capturedSeller);

      expect(await LocalCommerceService.getListingsBySeller(capturedSeller)).toHaveLength(3);
      expect(fetchJson.mock.calls.map(([url]) => url).sort()).toEqual([
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/45b2aedff744407ea2d67c8069ed112e`,
        `pubky://${capturedSeller}/pub/pubky.app/marketplace/v1/listings/aa2c8b308dbc47619793fe64dcefa9e8`,
      ]);
      expect(
        (await LocalCommerceService.getListing(`${capturedSeller}:45b2aedff744407ea2d67c8069ed112e`))?.revision,
      ).toBe(3);
    });

    it('pages a complete seller refresh and keeps the highest duplicate revision', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const pageOne = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) =>
        nexusRow(`page_${index}`, index === 0 ? 1 : 1),
      );
      const duplicate = nexusRow('page_0', 2);
      const pageTwo = [duplicate, nexusRow('page_30', 1)];
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValueOnce(pageOne)
        .mockResolvedValueOnce(pageTwo);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);

      await CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
        strictIdentity: true,
        paginate: true,
      });

      expect(stream.mock.calls).toEqual([
        [{ seller_id: capturedSeller, state: 'active', limit: NEXUS_LISTINGS_PER_PAGE }],
        [{ seller_id: capturedSeller, state: 'active', limit: NEXUS_LISTINGS_PER_PAGE, skip: NEXUS_LISTINGS_PER_PAGE }],
      ]);
      const entries = bulkUpsert.mock.calls[0][0];
      expect(entries).toHaveLength(NEXUS_LISTINGS_PER_PAGE + 1);
      expect(entries.find(({ listing_id }) => listing_id === 'page_0')?.revision).toBe(2);
    });

    it('rejects a bad later page before mutating the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await CommerceCatalogEntryModel.table.put(createCommerceCatalogEntryFixture({ listing_id: 'existing' }));
      await CommerceListingModel.table.put(
        toCommerceListingModel(createCommerceListingFixture({ listingId: 'existing' })),
      );
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      const pageOne = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) => nexusRow(`page_${index}`, 1));
      const badPage = {
        ...nexusRow('page_30', 1),
        owner_id: 's'.repeat(52),
        uri: `pubky://${'s'.repeat(52)}/pub/pubky.app/marketplace/v1/listings/page_30`,
      };
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValueOnce(pageOne)
        .mockResolvedValueOnce([badPage]);

      await expect(
        CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
          strictIdentity: true,
          paginate: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('rejects a lower canonical revision without mutating either real cache table', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const indexed = capturedById.get('45b2aedff744407ea2d67c8069ed112e')!;
      await CommerceCatalogEntryModel.table.put(
        createCommerceCatalogEntryFixture({
          id: `${capturedSeller}:45b2aedff744407ea2d67c8069ed112e`,
          seller_id: capturedSeller,
          listing_id: indexed.listingId,
          revision: indexed.revision,
        }),
      );
      await CommerceListingModel.table.put(toCommerceListingModel({ ...indexed, revision: 1 }));
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([SELLER_REFRESH_FIXTURE.nexus[1]]);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ ...indexed, revision: 1 });

      await expect(CommerceApplication.refreshListingsBySeller(capturedSeller)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('fails instead of claiming completeness when the bounded page cap is exhausted', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const fullPage = Array.from({ length: NEXUS_LISTINGS_PER_PAGE }, (_, index) => nexusRow(`page_${index}`, 1));
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue(fullPage);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(
        CommerceApplication.fetchSellerCatalogListings(capturedSeller, {
          strictIdentity: true,
          paginate: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(stream).toHaveBeenCalledTimes(100);
      expect(bulkUpsert).not.toHaveBeenCalled();
    });

    it('retains cached listings when the seller Nexus refresh fails', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const cached = [
        createCommerceListingFixture({ listingId: 'boots_01' }),
        createCommerceListingFixture({ listingId: 'boots_02' }),
      ];
      vi.spyOn(LocalCommerceService, 'getListingsBySeller').mockResolvedValue(
        cached.map((record) => toCommerceListingModel(record)),
      );
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockRejectedValue(new Error('nexus unreachable'));

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).rejects.toThrow(
        'nexus unreachable',
      );

      expect(await LocalCommerceService.getListingsBySeller(COMMERCE_FIXTURE_SELLER)).toHaveLength(2);
    });

    it('never queries Nexus in sandbox mode and retains the cached seller rows', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(createCommerceListingFixture({ listingId: 'boots_01' }), 'synced');
      await LocalCommerceService.upsertListing(createCommerceListingFixture({ listingId: 'boots_02' }), 'synced');
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      const beforeListings = await CommerceListingModel.table.toArray();
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({});
      const commitRefresh = vi.spyOn(LocalCommerceService, 'commitSellerCatalogRefresh');
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toBeUndefined();

      expect(stream).not.toHaveBeenCalled();
      expect(fetchJson).not.toHaveBeenCalled();
      expect(commitRefresh).not.toHaveBeenCalled();
      expect(bulkUpsert).not.toHaveBeenCalled();
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
    });

    it('deduplicates concurrent refreshes by seller', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(LocalCommerceService, 'getCatalogEntriesBySeller').mockResolvedValue([]);
      let release: ((entries: NexusListingDetails[]) => void) | undefined;
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const first = CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER);
      const second = CommerceApplication.refreshListingsBySeller(COMMERCE_FIXTURE_SELLER);
      release?.([]);
      await Promise.all([first, second]);

      expect(stream).toHaveBeenCalledOnce();
    });

    it('returns locally cached seller listings without fetching the catalog', async () => {
      const first = createCommerceListingFixture({ listingId: 'boots_01' });
      const second = createCommerceListingFixture({ listingId: 'boots_02' });
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      await LocalCommerceService.upsertListing(first, 'synced');
      await LocalCommerceService.upsertListing(second, 'synced');
      await LocalCommerceService.bulkUpsertCatalogEntries([
        createCommerceCatalogEntryFixture({ listing_id: 'boots_01' }),
        createCommerceCatalogEntryFixture({ id: `${COMMERCE_FIXTURE_SELLER}:boots_02`, listing_id: 'boots_02' }),
      ]);

      const fetchCatalog = vi.spyOn(CommerceApplication, 'fetchSellerCatalogListings');
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toHaveLength(2);

      expect(fetchCatalog).not.toHaveBeenCalled();
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('fetches an empty seller catalog and persists fetched listings in Dexie', async () => {
      const listing = createCommerceListingFixture();
      const catalogEntry = createCommerceCatalogEntryFixture();
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.clear();
      const fetchStream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(listing);

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toMatchObject([
        expect.objectContaining({ listing_id: 'boots_01' }),
      ]);

      expect(fetchStream).toHaveBeenCalledWith(
        expect.objectContaining({ seller_id: COMMERCE_FIXTURE_SELLER, state: 'active' }),
      );
      expect(fetchJson).toHaveBeenCalledOnce();
      expect(await LocalCommerceService.getCatalogEntriesBySeller(COMMERCE_FIXTURE_SELLER)).toEqual([catalogEntry]);
      expect(await LocalCommerceService.getListingsBySeller(COMMERCE_FIXTURE_SELLER)).toHaveLength(1);
    });

    it('hydrates canonical seller listings after discovering catalog entries', async () => {
      const first = createCommerceListingFixture({ listingId: 'boots_01' });
      const second = createCommerceListingFixture({ listingId: 'boots_02' });
      const listingRows = [
        new CommerceListingModel({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
          listing_id: 'boots_01',
          record: first,
          revision: first.revision,
          state: 'active',
          category_id: first.categoryId,
          format: 'fixed_price',
          price_minor: 12_500,
          currency: 'USD',
          sync_status: 'synced',
          updated_at: Date.parse(first.updatedAt),
          seller_id: COMMERCE_FIXTURE_SELLER,
        }),
        new CommerceListingModel({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_02`,
          listing_id: 'boots_02',
          record: second,
          revision: second.revision,
          state: 'active',
          category_id: second.categoryId,
          format: 'fixed_price',
          price_minor: 12_500,
          currency: 'USD',
          sync_status: 'synced',
          updated_at: Date.parse(second.updatedAt),
          seller_id: COMMERCE_FIXTURE_SELLER,
        }),
      ];
      vi.spyOn(LocalCommerceService, 'getListingsBySeller')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(listingRows);
      vi.spyOn(LocalCommerceService, 'getCatalogEntriesBySeller').mockResolvedValue([
        createCommerceCatalogEntryFixture({ listing_id: 'boots_01' }),
        createCommerceCatalogEntryFixture({ listing_id: 'boots_02' }),
      ]);
      vi.spyOn(CommerceApplication, 'fetchSellerCatalogListings').mockResolvedValue(undefined);
      const hydrate = vi
        .spyOn(CommerceApplication, 'getOrFetchListing')
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);

      await expect(CommerceApplication.getOrFetchListingsBySeller(COMMERCE_FIXTURE_SELLER)).resolves.toHaveLength(2);
      expect(hydrate).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'boots_01');
      expect(hydrate).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'boots_02');
    });

    it('hydrates one seller from the Nexus index outside sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);

      await CommerceApplication.fetchSellerCatalogListings(COMMERCE_FIXTURE_SELLER);

      expect(stream).toHaveBeenCalledWith(
        expect.objectContaining({ seller_id: COMMERCE_FIXTURE_SELLER, state: 'active' }),
      );
      expect(bulkUpsert).toHaveBeenCalledOnce();
    });

    it('never reads from Nexus in sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchSellerCatalogListings(COMMERCE_FIXTURE_SELLER);

      expect(stream).not.toHaveBeenCalled();
    });
  });

  describe('fetchFollowedSellerCatalogListings', () => {
    const FOLLOWED_KNOWN_SELLER = COMMERCE_FIXTURE_SELLER;
    const FOLLOWED_SHOP_ONLY_SELLER = 's'.repeat(52);
    const FOLLOWED_NON_SELLER = 'z'.repeat(52);

    function mockLocalCache({ withShopOnlySeller = false } = {}) {
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getAllCatalogEntries').mockResolvedValue([createCommerceCatalogEntryFixture()]);
      vi.spyOn(LocalCommerceService, 'getAllShops').mockResolvedValue(
        withShopOnlySeller
          ? [
              new CommerceShopModel({
                id: FOLLOWED_SHOP_ONLY_SELLER,
                owner_id: FOLLOWED_SHOP_ONLY_SELLER,
                record: createCommerceShopFixture({ ownerPubky: FOLLOWED_SHOP_ONLY_SELLER }),
                revision: 1,
                sync_status: 'synced',
                updated_at: 1_000,
              }),
            ]
          : [],
      );
      // Shop hydration for refreshed sellers stays cache-first.
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: FOLLOWED_KNOWN_SELLER,
          owner_id: FOLLOWED_KNOWN_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
    }

    it('never reads from Nexus in sandbox mode or without follows', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchFollowedSellerCatalogListings([FOLLOWED_KNOWN_SELLER]);
      expect(stream).not.toHaveBeenCalled();

      vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
      await CommerceApplication.fetchFollowedSellerCatalogListings([]);
      expect(stream).not.toHaveBeenCalled();
    });

    it('issues one global page plus per-seller refreshes only for follows known to sell', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      mockLocalCache({ withShopOnlySeller: true });
      const stream = vi
        .spyOn(NexusMarketplaceService, 'fetchListingStream')
        .mockResolvedValue([createNexusListingDetailsFixture()]);

      await CommerceApplication.fetchFollowedSellerCatalogListings([
        FOLLOWED_NON_SELLER,
        FOLLOWED_KNOWN_SELLER,
        FOLLOWED_SHOP_ONLY_SELLER,
      ]);

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(stream).toHaveBeenNthCalledWith(1, { state: 'active', limit: 30 });
      // The known seller (cached index entry) and the shop-only seller are
      // refreshed; the followed account that never sold anything costs nothing.
      expect(sellerCalls).toEqual([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]);
    });

    it('caps per-seller refreshes at the configured budget', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const followedSellers = Array.from({ length: 10 }, (_, index) => String.fromCharCode(97 + index).repeat(52));
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getAllCatalogEntries').mockResolvedValue(
        followedSellers.map((sellerId) =>
          createCommerceCatalogEntryFixture({ id: `${sellerId}:boots_01`, seller_id: sellerId }),
        ),
      );
      vi.spyOn(LocalCommerceService, 'getAllShops').mockResolvedValue([]);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: COMMERCE_FIXTURE_SELLER,
          owner_id: COMMERCE_FIXTURE_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchFollowedSellerCatalogListings(followedSellers);

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(sellerCalls).toEqual(
        followedSellers.slice(0, commerceConfig.MARKETPLACE_FOLLOWED_SHELF_MAX_SELLER_FETCHES),
      );
    });

    it('falls back to cache-known sellers when the global page fails, and survives per-seller failures', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      mockLocalCache({ withShopOnlySeller: true });
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockImplementation(async (params = {}) => {
        if (!params.seller_id) throw new TypeError('nexus unreachable');
        if (params.seller_id === FOLLOWED_SHOP_ONLY_SELLER) throw new TypeError('seller stream failed');
        return [createNexusListingDetailsFixture()];
      });

      await expect(
        CommerceApplication.fetchFollowedSellerCatalogListings([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]),
      ).resolves.toBeUndefined();

      const sellerCalls = stream.mock.calls.map(([params]) => params?.seller_id).filter(Boolean);
      expect(sellerCalls).toEqual([FOLLOWED_KNOWN_SELLER, FOLLOWED_SHOP_ONLY_SELLER]);
    });
  });

  describe('fetchMarketplaceTags', () => {
    const VIEWER = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';
    const nexusTag = { label: 'handmade', taggers: [VIEWER], taggers_count: 1, relationship: true };

    it('fetches listing tags from Nexus and merges them into the local cache', async () => {
      const fetchSpy = vi.spyOn(NexusMarketplaceService, 'fetchListingTags').mockResolvedValue([nexusTag]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags').mockResolvedValue(undefined);

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.LISTING,
        taggedId: `${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
        viewerId: VIEWER,
      });

      expect(result).toEqual([nexusTag]);
      expect(fetchSpy).toHaveBeenCalledWith({
        seller_id: COMMERCE_FIXTURE_SELLER,
        listing_id: '0034A0X7NJ52A',
        skip_tags: undefined,
        limit_tags: undefined,
        viewer_id: VIEWER,
      });
      expect(mergeSpy).toHaveBeenCalledWith({
        taggedId: `listing:${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
        tags: [nexusTag],
        viewerId: VIEWER,
      });
    });

    it('fetches shop tags from Nexus keyed by the owner pubky', async () => {
      const fetchSpy = vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockResolvedValue([nexusTag]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags').mockResolvedValue(undefined);

      await CommerceApplication.fetchMarketplaceTags({ kind: TagKind.SHOP, taggedId: COMMERCE_FIXTURE_SELLER });

      expect(fetchSpy).toHaveBeenCalledWith({
        seller_id: COMMERCE_FIXTURE_SELLER,
        skip_tags: undefined,
        limit_tags: undefined,
        viewer_id: undefined,
      });
      expect(mergeSpy).toHaveBeenCalledWith({
        taggedId: `shop:${COMMERCE_FIXTURE_SELLER}`,
        tags: [nexusTag],
        viewerId: null,
      });
    });

    it('returns [] without touching the cache when the tag endpoint answers 404 (not deployed)', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchListingTags').mockRejectedValue(
        Err.client(ClientErrorCode.NOT_FOUND, 'Not found', { service: ErrorService.Nexus, operation: 'fetchNexus' }),
      );
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags');

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.LISTING,
        taggedId: `${COMMERCE_FIXTURE_SELLER}:0034A0X7NJ52A`,
      });

      expect(result).toEqual([]);
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it('propagates non-404 errors', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockRejectedValue(new Error('nexus unreachable'));

      await expect(
        CommerceApplication.fetchMarketplaceTags({ kind: TagKind.SHOP, taggedId: COMMERCE_FIXTURE_SELLER }),
      ).rejects.toThrow('nexus unreachable');
    });

    it('skips the merge when Nexus returns an empty aggregate', async () => {
      vi.spyOn(NexusMarketplaceService, 'fetchShopTags').mockResolvedValue([]);
      const mergeSpy = vi.spyOn(LocalMarketplaceTagService, 'mergeTags');

      const result = await CommerceApplication.fetchMarketplaceTags({
        kind: TagKind.SHOP,
        taggedId: COMMERCE_FIXTURE_SELLER,
      });

      expect(result).toEqual([]);
      expect(mergeSpy).not.toHaveBeenCalled();
    });
  });

  describe('fetchCatalogListings', () => {
    const SELLER_B = 'b'.repeat(52);
    const SELLER_B_SHOP_URL = `pubky://${SELLER_B}/pub/pubky.app/marketplace/v1/shop.json`;
    const liveListingStream = JSON.parse(
      readFileSync(resolve(__dirname, '../../../test/fixtures/commerce/live/marketplace-listings.json'), 'utf8'),
    );

    it('never reads from Nexus in sandbox mode', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream');

      await CommerceApplication.fetchCatalogListings();

      expect(stream).not.toHaveBeenCalled();
    });

    it('passes server-side filters to the listing stream', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchCatalogListings({ saleFormat: 'auction', condition: 'like_new' });

      expect(stream).toHaveBeenCalledWith({
        state: 'active',
        limit: 30,
        sale_format: 'auction',
        condition: 'like_new',
      });
    });

    it('requests the auction end-time stream for the ending-soonest catalog', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      const stream = vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);

      await CommerceApplication.fetchCatalogListings({ endingSoonest: true });

      expect(stream).toHaveBeenCalledWith({
        state: 'active',
        limit: 30,
        sorting: 'ends_at',
        order: 'ascending',
      });
    });

    it('caches the validated index projections without hydrating listings from homeservers', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusAuctionListingDetailsFixture(),
      ]);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(
        new CommerceShopModel({
          id: COMMERCE_FIXTURE_SELLER,
          owner_id: COMMERCE_FIXTURE_SELLER,
          record: createCommerceShopFixture(),
          revision: 1,
          sync_status: 'synced',
          updated_at: 1_000,
        }),
      );
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing');

      await CommerceApplication.fetchCatalogListings();

      expect(bulkUpsert).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ id: `${COMMERCE_FIXTURE_SELLER}:boots_01`, sale_format: 'fixed_price' }),
        expect.objectContaining({
          id: `${COMMERCE_FIXTURE_SELLER}:rangefinder_camera`,
          sale_format: 'auction',
          auction: expect.objectContaining({ endsAt: '2026-08-29T20:00:00.000Z' }),
        }),
      ]);
      expect(fetchJson).not.toHaveBeenCalled();
      expect(upsertListing).not.toHaveBeenCalled();
    });

    it('hydrates only shop records the cache is missing, deduplicated per seller', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'jacket_01' }),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'scarf_01' }),
      ]);
      vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getShop').mockImplementation(async (ownerId) =>
        ownerId === COMMERCE_FIXTURE_SELLER
          ? new CommerceShopModel({
              id: COMMERCE_FIXTURE_SELLER,
              owner_id: COMMERCE_FIXTURE_SELLER,
              record: createCommerceShopFixture(),
              revision: 1,
              sync_status: 'synced',
              updated_at: 1_000,
            })
          : null,
      );
      const sellerBShop = createCommerceShopFixture({ ownerPubky: SELLER_B, name: 'Block 9 Archive' });
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(sellerBShop);
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

      await CommerceApplication.fetchCatalogListings();

      expect(fetchJson).toHaveBeenCalledExactlyOnceWith(SELLER_B_SHOP_URL);
      expect(upsertShop).toHaveBeenCalledExactlyOnceWith(sellerBShop, 'synced');
    });

    it('keeps the discovered catalog when one seller shop is unreachable', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusListingDetailsFixture(),
        createNexusListingDetailsFixture({ owner_id: SELLER_B, id: 'jacket_01' }),
      ]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue(null);
      const sellerAShop = createCommerceShopFixture();
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async (url) => {
        if (url.startsWith(`pubky://${SELLER_B}/`)) throw new TypeError('seller homeserver unreachable');
        return sellerAShop;
      });
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop').mockResolvedValue(undefined);

      await expect(CommerceApplication.fetchCatalogListings()).resolves.toBeUndefined();

      expect(bulkUpsert).toHaveBeenCalledOnce();
      expect(upsertShop).toHaveBeenCalledExactlyOnceWith(sellerAShop, 'synced');
    });

    it('propagates a Nexus failure without touching the cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockRejectedValue(new Error('nexus unreachable'));
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');
      const upsertShop = vi.spyOn(LocalCommerceService, 'upsertShop');

      await expect(CommerceApplication.fetchCatalogListings()).rejects.toThrow('nexus unreachable');
      expect(bulkUpsert).not.toHaveBeenCalled();
      expect(upsertShop).not.toHaveBeenCalled();
    });

    it('persists the live Nexus stream into the catalog cache', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      await CommerceCatalogEntryModel.table.clear();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(liveListingStream), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.spyOn(CommerceApplication, 'getOrFetchShop').mockResolvedValue(createCommerceShopFixture());

      await CommerceController.fetchCatalogListings({
        saleFormat: 'all',
        conditions: [],
        sort: 'recommended',
        countryCode: null,
      });

      expect(await CommerceCatalogEntryModel.table.count()).toBeGreaterThan(0);
    });

    it('rejects an invalid stream payload before caching anything', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('unavailable');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([
        createNexusAuctionListingDetailsFixture({ auction_ends_at: null }),
      ]);
      const bulkUpsert = vi.spyOn(LocalCommerceService, 'bulkUpsertCatalogEntries');

      await expect(CommerceApplication.fetchCatalogListings()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(bulkUpsert).not.toHaveBeenCalled();
    });
  });

  describe('getOrFetchListing revision freshness', () => {
    function cachedListingModel(revision: number) {
      const record = createCommerceListingFixture({ revision });
      return new CommerceListingModel({
        id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
        seller_id: COMMERCE_FIXTURE_SELLER,
        listing_id: 'boots_01',
        record,
        revision,
        state: 'active',
        category_id: 'fashion-shoes-boots',
        format: 'fixed_price',
        currency: 'USD',
        price_minor: 12_500,
        sync_status: 'synced',
        updated_at: Date.parse(record.updatedAt),
      });
    }

    it('returns a cached listing without fetching when the index has seen nothing newer', async () => {
      const cached = cachedListingModel(1);
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cached);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 1 })),
      );
      const fetchJson = vi.spyOn(CommerceHomeserverService, 'fetchJson');

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        cached.record,
      );
      expect(fetchJson).not.toHaveBeenCalled();
    });

    it('refetches the canonical record when the index revision moved past the cache', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cachedListingModel(1));
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 2 })),
      );
      const refreshedRecord = createCommerceListingFixture({ revision: 2 });
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(refreshedRecord);
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        refreshedRecord,
      );
      expect(upsertListing).toHaveBeenCalledExactlyOnceWith(refreshedRecord, 'synced');
    });

    it('rejects a canonical record older than the Nexus revision without overwriting the cache', async () => {
      await CommerceListingModel.table.clear();
      await CommerceCatalogEntryModel.table.clear();
      await CommerceListingModel.table.put(cachedListingModel(1));
      await CommerceCatalogEntryModel.table.put(
        createCommerceCatalogEntryFixture({
          id: `${COMMERCE_FIXTURE_SELLER}:boots_01`,
          seller_id: COMMERCE_FIXTURE_SELLER,
          listing_id: 'boots_01',
          revision: 2,
        }),
      );
      const beforeListings = await CommerceListingModel.table.toArray();
      const beforeCatalog = await CommerceCatalogEntryModel.table.toArray();
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(createCommerceListingFixture({ revision: 1 }));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(await CommerceListingModel.table.toArray()).toEqual(beforeListings);
      expect(await CommerceCatalogEntryModel.table.toArray()).toEqual(beforeCatalog);
    });

    it('serves the cached record when a staleness refresh fails', async () => {
      const cached = cachedListingModel(1);
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(cached);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(
        new CommerceCatalogEntryModel(createCommerceCatalogEntryFixture({ revision: 2 })),
      );
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new TypeError('homeserver unreachable'));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).resolves.toEqual(
        cached.record,
      );
    });

    it('propagates a fetch failure when no cached record exists', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(new TypeError('homeserver unreachable'));

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toThrow(
        'homeserver unreachable',
      );
    });

    it('rejects a canonical record whose identity does not match its requested path', async () => {
      vi.spyOn(LocalCommerceService, 'getListing').mockResolvedValue(null);
      vi.spyOn(LocalCommerceService, 'getCatalogEntry').mockResolvedValue(null);
      vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(
        createCommerceListingFixture({ ownerPubky: 's'.repeat(52) }),
      );
      const upsertListing = vi.spyOn(LocalCommerceService, 'upsertListing');

      await expect(CommerceApplication.getOrFetchListing(COMMERCE_FIXTURE_SELLER, 'boots_01')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });

      expect(upsertListing).not.toHaveBeenCalled();
    });
  });

  /**
   * docs/ecommerce/step-up-approval.md, Option C: the widened homeserver
   * grant is requested LAZILY, only from the explicit re-auth CTA. A bridged
   * (narrow-grant) session must be able to browse, publish listings, and hit
   * the first checkout without the app ever requesting a wider approval on
   * its own. (The bridged-restore leg is asserted in
   * src/core/application/auth/auth.test.ts; the hook itself only starts from
   * its CTA — src/hooks/useStepUpReauth/useStepUpReauth.test.ts.)
   */
  describe('step-up re-approval is never auto-triggered', () => {
    it('browsing the catalog never requests a widened grant or a service session', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(NexusMarketplaceService, 'fetchListingStream').mockResolvedValue([]);
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await CommerceApplication.fetchCatalogListings();

      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });

    it('publishing a listing under the narrow bridged grant never requests a widened grant', async () => {
      const record = createCommerceListingFixture();
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      vi.spyOn(LocalCommerceService, 'stageListingSync').mockResolvedValue(undefined);
      // The public /pub write succeeds under the narrow grant.
      const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'upsertListing').mockResolvedValue(undefined);
      vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
      // Service registration fails without a marketplace session; the publish
      // stands and registration self-heals later — no approval is requested.
      vi.spyOn(MarketplaceGatewayService, 'getListing').mockResolvedValue(null);
      vi.spyOn(MarketplaceGatewayService, 'execute').mockRejectedValue(
        Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Connect a marketplace session to continue.', {
          service: ErrorService.Marketplace,
          operation: 'test',
        }),
      );
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await expect(CommerceApplication.commitUpsertListing(record)).resolves.toEqual({ registered: false });

      expect(put).toHaveBeenCalledWith(LISTING_URL, { ...record });
      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });

    it('the first checkout fails closed on a missing session instead of auto-requesting any approval', async () => {
      vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
      const sessionRequired = Err.auth(AuthErrorCode.SESSION_EXPIRED, 'Connect a marketplace session to continue.', {
        service: ErrorService.Marketplace,
        operation: 'test',
      });
      vi.spyOn(MarketplaceGatewayService, 'execute').mockRejectedValue(sessionRequired);
      const generateAuthUrlSpy = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const beginSessionFlowSpy = vi.spyOn(MarketplaceSessionService, 'beginSessionFlow');

      await expect(
        CommerceApplication.executeMarketplaceCommand(COMMERCE_FIXTURE_SELLER, {
          version: 1,
          commandId: '018f47d2-6a27-7c23-a49d-6b21bb770299',
          aggregateId: 'checkout:018f47d2-6a27-7c23-a49d-6b21bb770299',
          expectedRevision: 0,
          issuedAt: new Date().toISOString(),
          kind: 'checkout.create',
          payload: {
            lines: [
              {
                listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
                expectedRevision: 0,
                quantity: 1,
              },
            ],
            deliveryAddress: {
              name: 'Buyer',
              line1: '1 Main St',
              line2: '',
              city: 'Lisbon',
              region: 'Lisbon',
              postalCode: '1000-001',
              countryCode: 'PT',
            },
            guaranteePolicyVersion: 1,
          },
        } as never),
      ).rejects.toMatchObject({ code: AuthErrorCode.SESSION_EXPIRED, service: ErrorService.Marketplace });

      // The empty-caps service token comes only from the explicit connect
      // dialog; the wide homeserver grant only from the re-auth CTA.
      expect(generateAuthUrlSpy).not.toHaveBeenCalled();
      expect(beginSessionFlowSpy).not.toHaveBeenCalled();
    });
  });
});

function nexusRow(id: string, revision: number): NexusListingDetails {
  const row = SELLER_REFRESH_FIXTURE.nexus[0];
  return {
    ...row,
    id,
    uri: `pubky://${row.owner_id}/pub/pubky.app/marketplace/v1/listings/${id}`,
    revision,
  };
}
