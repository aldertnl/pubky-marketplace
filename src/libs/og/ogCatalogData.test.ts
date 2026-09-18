import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMarketplaceNexusUrl } from '@/config/nexus';
import { Logger } from '@/libs/logger/logger';
import { getCommerceAdapterMode } from '@/libs/runtime-config/runtime-config';
import { createCommerceShopFixture, createNexusListingDetailsFixture } from '@/test/fixtures/commerce/commerce';
import { fetchMarketplaceCatalogForSsr } from './ogCatalogData';
import { OG_COMMERCE_REVALIDATE } from './ogCommerceData';

vi.mock('@synonymdev/pubky', () => ({
  Client: class {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      return globalThis.fetch(input, init);
    }
  },
  resolvePubky: (url: string) => url.replace('pubky://', 'https://'),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return {
    ...actual,
    getCommerceAdapterMode: vi.fn(() => 'transaction-service'),
  };
});

describe('fetchMarketplaceCatalogForSsr', () => {
  beforeEach(() => {
    vi.mocked(getCommerceAdapterMode).mockReturnValue('transaction-service');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a fixture listing stream into catalog cards and caches like listing OG', async () => {
    const fixture = createNexusListingDetailsFixture();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([fixture]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createCommerceShopFixture()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { listings, shops } = await fetchMarketplaceCatalogForSsr();

    expect(fetchMock).toHaveBeenCalledWith(`${getMarketplaceNexusUrl()}/v0/stream/listings?state=active&limit=30`, {
      next: { revalidate: OG_COMMERCE_REVALIDATE },
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.title).toBe('Vintage leather boots');
    expect(listings[0]?.listingId).toBe('boots_01');
    expect(shops).toHaveLength(1);
    expect(shops[0]?.name).toBe('Satoshi Vintage');
  });

  it('skips Nexus in sandbox mode', async () => {
    vi.mocked(getCommerceAdapterMode).mockReturnValue('sandbox');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(fetchMarketplaceCatalogForSsr()).resolves.toEqual({ listings: [], shops: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty catalog when the stream is not ok', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(fetchMarketplaceCatalogForSsr()).resolves.toEqual({ listings: [], shops: [] });
  });

  it('returns an empty catalog for a malformed stream payload', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ not: 'an array' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchMarketplaceCatalogForSsr()).resolves.toEqual({ listings: [], shops: [] });
  });

  it('keeps listings when a shop record fetch fails', async () => {
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const fixture = createNexusListingDetailsFixture();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([fixture]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(new Response('missing', { status: 500 }));

    const { listings, shops } = await fetchMarketplaceCatalogForSsr();

    expect(listings).toHaveLength(1);
    expect(shops).toEqual([]);
  });

  it('caps concurrent shop fetches at six for a 30-seller stream', async () => {
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';
    const listings = Array.from({ length: 30 }, (_, index) => {
      const ownerId = `${alphabet[index % alphabet.length]}${'y'.repeat(51)}`;
      return createNexusListingDetailsFixture({
        id: `listing_${index}`,
        owner_id: ownerId,
        uri: `pubky://${ownerId}/pub/pubky.app/marketplace/v1/listings/listing_${index}`,
      });
    });

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v0/stream/listings')) {
        return new Response(JSON.stringify(listings), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return new Response(JSON.stringify(createCommerceShopFixture()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { listings: catalog, shops } = await fetchMarketplaceCatalogForSsr();

    expect(catalog).toHaveLength(30);
    expect(shops).toHaveLength(30);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBe(6);
  });
});
