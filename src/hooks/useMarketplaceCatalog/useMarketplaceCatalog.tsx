'use client';

import { useContext, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode, MARKETPLACE_ATTRIBUTE_FILTERS_ENABLED } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { Logger } from '@/libs/logger/logger';
import { DatabaseContext } from '@/providers/DatabaseProvider/DatabaseProvider';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  applyMarketplaceAttributeFilters,
  buildMarketplaceCatalogItems,
  filterMarketplaceCatalog,
  type MarketplaceCatalogItem,
} from './useMarketplaceCatalog.utils';

export function useMarketplaceCatalog(
  initialListings: MarketplaceCatalogItem[] = [],
  initialShops: CommerceShopRecord[] = [],
) {
  const { isReady: isDatabaseReady } = useContext(DatabaseContext);
  const query = useCommerceStore((state) => state.query);
  const categoryId = useCommerceStore((state) => state.categoryId);
  const attributeFilters = useCommerceStore((state) => state.attributeFilters);
  const saleFormat = useCommerceStore((state) => state.saleFormat);
  const conditions = useCommerceStore((state) => state.conditions);
  const minimumPriceMinor = useCommerceStore((state) => state.minimumPriceMinor);
  const maximumPriceMinor = useCommerceStore((state) => state.maximumPriceMinor);
  const countryCode = useCommerceStore((state) => state.countryCode);
  const sort = useCommerceStore((state) => state.sort);
  const adapterMode = getCommerceAdapterMode();

  // Sandbox catalogs are seeded locally and never query Nexus (see
  // docs/ecommerce/RUNNING.md), so in that mode there is no refresh to wait for.
  const [isRefreshing, setIsRefreshing] = useState(adapterMode !== 'sandbox');

  useEffect(() => {
    if (adapterMode === 'sandbox' || !isDatabaseReady) return;

    let active = true;
    setIsRefreshing(true);
    CommerceController.fetchCatalogListings({ saleFormat, conditions, sort, countryCode })
      .catch((error) => {
        // The catalog keeps rendering from the local cache when the index is
        // unreachable; discovery just does not widen until it comes back.
        Logger.warn('[useMarketplaceCatalog] Nexus catalog refresh failed; rendering cached catalog', { error });
      })
      .finally(() => {
        if (active) setIsRefreshing(false);
      });

    return () => {
      active = false;
    };
  }, [adapterMode, isDatabaseReady, saleFormat, conditions, sort, countryCode]);

  // The grid renders from both catalog sources: index projections cached by
  // discovery (no homeserver round-trips) and canonical records that are
  // already local (opened listings, own listings, sandbox seeds).
  const localListings = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllListings() : undefined),
    [isDatabaseReady],
  );
  const catalogEntries = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllCatalogEntries() : undefined),
    [isDatabaseReady],
  );
  const localShops = useLiveQuery(
    () => (isDatabaseReady ? CommerceController.getAllShops() : undefined),
    [isDatabaseReady],
  );
  useEffect(() => {
    if (adapterMode !== 'sandbox' || !isDatabaseReady || localListings?.length !== 0) return;
    void CommerceController.initializeSandboxCatalog().catch((error) => {
      Logger.warn('[useMarketplaceCatalog] Sandbox catalog initialization failed', { error });
    });
  }, [adapterMode, isDatabaseReady, localListings?.length]);

  // While a refresh is in flight over an empty cache, stay in the loading
  // state so the skeleton shows instead of flashing "No listings match"
  // before the first discovery results land.
  const isCacheUnresolved = localListings === undefined || catalogEntries === undefined || localShops === undefined;
  const isCacheEmpty =
    localListings !== undefined && catalogEntries !== undefined && localListings.length + catalogEntries.length === 0;
  const isLoading = isCacheUnresolved || (isCacheEmpty && isRefreshing);
  // SSR and the first client paint have no Dexie snapshot yet. Keep the
  // server-fetched catalog mounted so hydration does not replace it with a
  // skeleton.
  const sourceItems =
    isLoading && initialListings.length > 0
      ? initialListings
      : buildMarketplaceCatalogItems(localListings ?? [], catalogEntries ?? []);
  // The facet pool matches every filter EXCEPT the attribute filters, so the
  // facet chips keep offering alternatives to the active value.
  const facetPool = filterMarketplaceCatalog(sourceItems, {
    query,
    categoryId,
    saleFormat,
    conditions,
    minimumPriceMinor,
    maximumPriceMinor,
    countryCode,
    sort,
  });
  const countryFacetPool = filterMarketplaceCatalog(sourceItems, {
    query,
    categoryId,
    saleFormat,
    conditions,
    minimumPriceMinor,
    maximumPriceMinor,
    countryCode: null,
    sort,
  });
  const listings = MARKETPLACE_ATTRIBUTE_FILTERS_ENABLED
    ? applyMarketplaceAttributeFilters(facetPool, attributeFilters)
    : facetPool;
  const shopsBySeller = new Map<string, (typeof initialShops)[number]>(
    initialShops.map((shop) => [shop.ownerPubky, shop]),
  );
  for (const { owner_id, record } of localShops ?? []) {
    shopsBySeller.set(owner_id, record);
  }

  return {
    listings,
    facetPool,
    countryFacetPool,
    shopsBySeller,
    isLoading,
    adapterMode,
  };
}
