import { NEXUS_LISTINGS_PER_PAGE } from '@/config/nexus';
import {
  catalogItemFromCatalogEntry,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { NEXUS_STREAM_LISTINGS_ROUTE } from '@/libs/commerce/nexus-routes';
import { Logger } from '@/libs/logger/logger';
import { getCommerceAdapterMode, getMarketplaceNexusUrl } from '@/libs/runtime-config/runtime-config';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { fetchShopForMetadata, type MetadataFetchResult, OG_COMMERCE_REVALIDATE } from './ogCommerceData';

export interface MarketplaceCatalogSsrPayload {
  listings: MarketplaceCatalogItem[];
  shops: CommerceShopRecord[];
}

/**
 * Server-only first page of the public Nexus marketplace listing stream for
 * the `/marketplace` catalog HTML, plus shop records for the distinct sellers
 * on that page so SSR cards render the shop name (not the pubky fallback).
 * Same constraints as `ogCommerceData`: no Dexie/controller writes — a read of
 * public index projections and public `shop.json` records, cached with the
 * listing/shop OG revalidate window.
 *
 * Sandbox deployments never query Nexus (seeded local catalogs only).
 */
export async function fetchMarketplaceCatalogForSsr(): Promise<MarketplaceCatalogSsrPayload> {
  if (getCommerceAdapterMode() === 'sandbox') return { listings: [], shops: [] };

  const query = new URLSearchParams({
    state: 'active',
    limit: String(NEXUS_LISTINGS_PER_PAGE),
  });
  const url = `${getMarketplaceNexusUrl()}/${NEXUS_STREAM_LISTINGS_ROUTE}?${query.toString()}`;

  try {
    const res = await fetch(url, { next: { revalidate: OG_COMMERCE_REVALIDATE } });
    if (!res.ok) {
      Logger.warn('[ogCatalogData] Listing stream failed', { url, status: res.status });
      return { listings: [], shops: [] };
    }

    const json: unknown = await res.json();
    const listings = CommerceRecordNormalizer.nexusListingStream(json).map(catalogItemFromCatalogEntry);
    const shops = await fetchShopsForCatalogSellers(listings);
    return { listings, shops };
  } catch (error) {
    Logger.warn('[ogCatalogData] Failed to fetch marketplace listing stream', { error });
    return { listings: [], shops: [] };
  }
}

const SHOP_FETCH_CONCURRENCY = 6;

async function fetchShopsForCatalogSellers(listings: MarketplaceCatalogItem[]): Promise<CommerceShopRecord[]> {
  const sellers = [...new Set(listings.map((listing) => listing.sellerId))];
  const settled: PromiseSettledResult<MetadataFetchResult<CommerceShopRecord>>[] = [];
  for (let offset = 0; offset < sellers.length; offset += SHOP_FETCH_CONCURRENCY) {
    const chunk = sellers.slice(offset, offset + SHOP_FETCH_CONCURRENCY);
    settled.push(...(await Promise.allSettled(chunk.map((seller) => fetchShopForMetadata(seller)))));
  }
  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || result.value.kind !== 'found') return [];
    return [result.value.record];
  });
}
