'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import { seedDraftFormFromListing } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import { useMarketplaceOffers } from '@/hooks/useMarketplaceOffers/useMarketplaceOffers';
import { useMarketplaceOrders } from '@/hooks/useMarketplaceOrders/useMarketplaceOrders';
import { useMeasurementSystem } from '@/hooks/useMeasurementSystem/useMeasurementSystem';
import { sumMoneyByAsset } from '@/libs/commerce/pricing';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

export function useMarketplaceSellerDashboard() {
  const [nowMs, setNowMs] = useState(0);
  const [catalogFetchState, setCatalogFetchState] = useState<'idle' | 'loading' | 'settled' | 'error'>('idle');
  const catalogFetchAttempted = useRef<string | null>(null);
  const catalogRefreshGeneration = useRef(0);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const measurementSystem = useMeasurementSystem();
  const localListings = useLiveQuery(
    () => (currentUserPubky ? CommerceController.getListingsBySeller(currentUserPubky) : []),
    [currentUserPubky],
  );
  useEffect(() => {
    if (!currentUserPubky || localListings === undefined) return;
    if (catalogFetchAttempted.current === currentUserPubky) return;
    const sellerPubky = currentUserPubky;
    const generation = ++catalogRefreshGeneration.current;
    let active = true;
    catalogFetchAttempted.current = currentUserPubky;
    setCatalogFetchState('loading');
    CommerceController.refreshListingsBySeller(sellerPubky)
      .then(() => {
        if (active && catalogRefreshGeneration.current === generation) setCatalogFetchState('settled');
      })
      .catch(() => {
        if (active && catalogRefreshGeneration.current === generation) setCatalogFetchState('error');
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, localListings]);
  const orders = useMarketplaceOrders();
  const offers = useMarketplaceOffers();
  const sellerOrders = orders.orders.filter(({ order }) => order.sellerPubky === currentUserPubky);
  const sellerOffers = offers.offers.filter(({ sellerPubky }) => sellerPubky === currentUserPubky);
  const activeListings = (localListings ?? []).filter(({ state }) => state === 'active');
  const expiringBefore = nowMs + 24 * 60 * 60 * 1_000;
  const expiringAuctions = activeListings.filter((listing) => {
    if (listing.record.sale.format !== 'auction') return false;
    const endsAt = Date.parse(listing.record.sale.endsAt);
    return endsAt > nowMs && endsAt <= expiringBefore;
  }).length;
  const ordersToShip = sellerOrders.filter(({ order }) => order.state === 'paid').length;
  const offersAwaitingReply = sellerOffers.filter(
    ({ state, offeredBy }) => (state === 'pending' || state === 'countered') && offeredBy !== currentUserPubky,
  ).length;
  const totalInventory = activeListings.reduce(
    (total, listing) =>
      total +
      (listing.purchasableQuantity ??
        listing.record.variants.reduce((sum, variant) => sum + (variant.enabled ? variant.quantity : 0), 0)),
    0,
  );
  // One revenue figure per pricing asset: minor units of different assets
  // (USD cents, bitcoin base units) are never summed into one false number.
  const revenue = sumMoneyByAsset(
    sellerOrders
      .filter(({ order }) => ['paid', 'processing', 'shipped', 'delivered', 'completed'].includes(order.state))
      .map(({ order }) => ({ money: order.total, quantity: 1 })),
  );

  const updateListingState = async (listingIds: string[], state: 'active' | 'paused') => {
    const selected = (localListings ?? []).filter(({ id }) => listingIds.includes(id));
    try {
      await Promise.all(
        selected.map(({ record }) =>
          CommerceController.commitUpsertListing({
            ...record,
            revision: record.revision + 1,
            state,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
      toast({ title: state === 'active' ? 'Listings activated' : 'Listings paused' });
      return true;
    } catch {
      toast({ variant: 'error', description: 'Could not update selected listings.' });
      return false;
    }
  };

  const duplicateListing = async (
    listingId: string,
    options: { replaceUnsavedDraft?: boolean; unsavedDraftId?: string | null } = {},
  ): Promise<boolean> => {
    if (!currentUserPubky) return false;
    try {
      const unsavedDraftId =
        options.unsavedDraftId !== undefined ? options.unsavedDraftId : await unsavedListingDraftId();
      if (unsavedDraftId && !options.replaceUnsavedDraft) return false;
      const record = await CommerceController.getOrFetchListing(currentUserPubky, listingId);
      if (record.ownerPubky !== currentUserPubky) {
        toast({ variant: 'error', description: 'You can only duplicate your own listings.' });
        return false;
      }
      const draftId = crypto.randomUUID().replaceAll('-', '');
      const form = seedDraftFormFromListing(record, measurementSystem);
      await CommerceController.commitUpdateListingDraft(draftId, form);
      if (unsavedDraftId && options.replaceUnsavedDraft) {
        try {
          await CommerceController.commitDeleteListingDraft(unsavedDraftId);
        } catch {
          // Newest draft is drafts[0]; leaving the old row is safe.
        }
      }
      return true;
    } catch {
      toast({ variant: 'error', description: 'Could not duplicate this listing.' });
      return false;
    }
  };

  const hasUnsavedListingDraft = async (): Promise<string | null> => unsavedListingDraftId();

  const exportCsv = (): string => {
    const header = ['listing_id', 'title', 'state', 'format', 'price_minor', 'currency', 'inventory'];
    const rows = (localListings ?? []).map((listing) => [
      csvCell(listing.listing_id),
      csvCell(listing.record.title),
      listing.state,
      listing.format,
      String(listing.price_minor),
      listing.currency,
      String(listing.record.variants.reduce((total, variant) => total + variant.quantity, 0)),
    ]);
    return [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
  };

  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return {
    listings: localListings ?? [],
    sellerOrders,
    offers: sellerOffers,
    isLoading:
      localListings === undefined ||
      (localListings.length === 0 && (catalogFetchState === 'idle' || catalogFetchState === 'loading')) ||
      orders.isLoading ||
      offers.isLoading,
    error: catalogFetchState === 'error' ? 'Could not load your listings.' : null,
    // Orders and offers ride the same durable session, so either flag means
    // the dashboard's remote-backed numbers are missing until reconnect.
    needsSession: orders.needsSession || offers.needsSession,
    sessionError: (orders.needsSession ? orders.error : null) ?? (offers.needsSession ? offers.error : null),
    metrics: {
      activeListings: activeListings.length,
      totalInventory,
      lowStock: activeListings.filter((listing) =>
        listing.record.variants.some((variant) => variant.enabled && variant.quantity <= 1),
      ).length,
      paidOrders: sellerOrders.filter(({ order }) => order.state !== 'pending_payment').length,
      revenue,
      openOffers: sellerOffers.filter(({ state }) => state === 'pending' || state === 'countered').length,
    },
    actionNeeded: {
      ordersToShip,
      offersAwaitingReply,
      expiringAuctions,
      total: ordersToShip + offersAwaitingReply + expiringAuctions,
    },
    updateListingState,
    duplicateListing,
    hasUnsavedListingDraft,
    exportCsv,
  };
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""').replace(/^[=+\-@]/, "'$&")}"`;
}

async function unsavedListingDraftId(): Promise<string | null> {
  const drafts = await CommerceController.getListingDrafts();
  const latest = drafts[0];
  if (!latest) return null;
  const form = latest.data.form;
  if (!form || typeof form !== 'object') return null;
  return listingDraftHasUserContent(form as Record<string, unknown>) ? latest.listing_id : null;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function listingDraftHasUserContent(record: Record<string, unknown>): boolean {
  if (
    [record.title, record.description, record.seededFromTitle, record.categoryId, record.price].some(isNonEmptyString)
  ) {
    return true;
  }
  if (typeof record.condition === 'string' && record.condition.trim() !== '' && record.condition !== 'good') {
    return true;
  }
  if (listingDraftHasCustomVariants(record.variants)) return true;
  if (listingDraftHasMedia(record)) return true;
  if (
    [
      record.shippingPrice,
      record.packageWeight,
      record.packageLength,
      record.packageWidth,
      record.packageHeight,
      record.region,
    ].some(isNonEmptyString)
  ) {
    return true;
  }
  if (
    typeof record.shippingLabel === 'string' &&
    record.shippingLabel.trim() !== '' &&
    record.shippingLabel !== 'Seller shipping'
  ) {
    return true;
  }
  if (
    typeof record.shippingMinDays === 'string' &&
    record.shippingMinDays.trim() !== '' &&
    record.shippingMinDays !== '3'
  ) {
    return true;
  }
  if (
    typeof record.shippingMaxDays === 'string' &&
    record.shippingMaxDays.trim() !== '' &&
    record.shippingMaxDays !== '7'
  ) {
    return true;
  }
  return false;
}

function listingDraftHasMedia(record: Record<string, unknown>): boolean {
  if (isNonEmptyString(record.altText)) return true;
  return ['photos', 'media', 'photoIds', 'mediaIds'].some((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function listingDraftHasCustomVariants(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length > 1) return true;
  const row = value[0];
  if (!row || typeof row !== 'object') return true;
  const variant = row as Record<string, unknown>;
  return (
    isNonEmptyString(variant.sku) ||
    isNonEmptyString(variant.size) ||
    isNonEmptyString(variant.color) ||
    isNonEmptyString(variant.style) ||
    isNonEmptyString(variant.priceOverride) ||
    (typeof variant.quantity === 'string' && variant.quantity.trim() !== '' && variant.quantity.trim() !== '1')
  );
}
