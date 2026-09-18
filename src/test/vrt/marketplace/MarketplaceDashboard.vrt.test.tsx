// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceDashboard } from '@/templates/Marketplace/MarketplaceDashboard';

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, createCommerceShopFixture, COMMERCE_FIXTURE_SELLER } =
    await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel, toCommerceShopModel } = await import('@/test/fixtures/commerce/listing-models');

  const listings = [
    toCommerceListingModel(
      createCommerceListingFixture({
        variants: [
          { id: 'variant_42', options: { size: '42' }, quantity: 3, mediaIds: ['image_01'], enabled: true },
          { id: 'variant_43', options: { size: '43' }, quantity: 1, mediaIds: ['image_01'], enabled: true },
        ],
      }),
    ),
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'selvedge_jacket',
        title: 'Selvedge denim jacket',
        categoryId: 'fashion-jackets',
        sale: {
          format: 'fixed_price',
          unitPrice: { amountMinor: 8_900, currency: 'USD', exponent: 2 },
          acceptsOffers: true,
        },
      }),
    ),
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        categoryId: 'electronics-cameras-film',
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: '2026-08-19T20:00:00.000Z',
          endsAt: '2026-08-29T20:00:00.000Z',
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        },
      }),
    ),
    toCommerceListingModel(createCommerceListingFixture({ listingId: 'paused_boots', state: 'paused' })),
  ];

  return {
    seller: COMMERCE_FIXTURE_SELLER,
    shop: toCommerceShopModel(createCommerceShopFixture()),
    listings,
    populatedMetrics: {
      activeListings: 3,
      totalInventory: 6,
      lowStock: 2,
      paidOrders: 4,
      revenue: [{ amountMinor: 51_300, currency: 'USD', exponent: 2 }],
      openOffers: 2,
    },
    populatedActionNeeded: {
      ordersToShip: 2,
      offersAwaitingReply: 2,
      expiringAuctions: 1,
      total: 5,
    },
    emptyMetrics: {
      activeListings: 0,
      totalInventory: 0,
      lowStock: 0,
      paidOrders: 0,
      revenue: [],
      openOffers: 0,
    },
    emptyActionNeeded: {
      ordersToShip: 0,
      offersAwaitingReply: 0,
      expiringAuctions: 0,
      total: 0,
    },
  };
});

const view = vi.hoisted(() => ({
  listings: [] as unknown[],
  metrics: {} as unknown,
  actionNeeded: {} as unknown,
  isLoading: false,
  shop: null as unknown,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/dashboard',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

// The dashboard's shop query is async (it normalizes "no record" to null), so
// this mock unwraps promises into state instead of passing them through.
vi.mock('dexie-react-hooks', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useLiveQuery: (querier: () => unknown, deps: unknown[] = []) => {
      const [value, setValue] = useState<unknown>(undefined);
      useEffect(() => {
        let active = true;
        Promise.resolve(querier()).then((resolved) => {
          if (active) setValue(resolved);
        });
        return () => {
          active = false;
        };
        // The querier identity changes every render; the deps array is the contract.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps);
      return value;
    },
  };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: () => Promise.resolve(view.shop),
    getOrFetchShop: () =>
      view.shop ? Promise.resolve((view.shop as { record: unknown }).record) : Promise.reject(new Error('no shop')),
    getListingsBySeller: () => Promise.resolve(view.listings),
  },
}));

vi.mock('@/hooks/useMarketplaceSellerDashboard/useMarketplaceSellerDashboard', () => ({
  useMarketplaceSellerDashboard: () => ({
    listings: view.listings,
    sellerOrders: [],
    offers: [],
    isLoading: view.isLoading,
    needsSession: false,
    sessionError: null,
    metrics: view.metrics,
    actionNeeded: view.actionNeeded,
    updateListingState: vi.fn(async () => false),
    duplicateListing: vi.fn(async () => false),
    exportCsv: () => 'listing_id,title,state,format,price_minor,currency,inventory',
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace seller dashboard — visual regression', () => {
  it('renders populated metrics and inventory with row actions at desktop viewport', async () => {
    const { listings, populatedMetrics, populatedActionNeeded, shop } = await fixtures;
    view.listings = listings;
    view.metrics = populatedMetrics;
    view.actionNeeded = populatedActionNeeded;
    view.isLoading = false;
    view.shop = shop;

    const screen = await renderForVRT(<MarketplaceDashboard />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dashboard-populated-desktop');
  });

  it('renders populated metrics and inventory at mobile viewport', async () => {
    const { listings, populatedMetrics, populatedActionNeeded, shop } = await fixtures;
    view.listings = listings;
    view.metrics = populatedMetrics;
    view.actionNeeded = populatedActionNeeded;
    view.isLoading = false;
    view.shop = shop;

    const screen = await renderForVRT(<MarketplaceDashboard />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dashboard-populated-mobile');
  });

  // A seller with published listings but NO shop record dead-ends buyers on
  // their shop link — the dashboard must say so and offer the setup path.
  it('renders the set-up-your-shop prompt when listings exist without a shop at desktop viewport', async () => {
    const { listings, populatedMetrics, populatedActionNeeded } = await fixtures;
    view.listings = listings;
    view.metrics = populatedMetrics;
    view.actionNeeded = populatedActionNeeded;
    view.isLoading = false;
    view.shop = null;

    const screen = await renderForVRT(<MarketplaceDashboard />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Your shop page is not set up')) {
        throw new Error('The shop prompt has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dashboard-no-shop-prompt-desktop');
  });

  it('renders the new-seller empty state at desktop viewport', async () => {
    const { emptyMetrics, emptyActionNeeded, shop } = await fixtures;
    view.listings = [];
    view.metrics = emptyMetrics;
    view.actionNeeded = emptyActionNeeded;
    view.isLoading = false;
    view.shop = shop;

    const screen = await renderForVRT(<MarketplaceDashboard />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dashboard-empty-desktop');
  });

  it('renders the loading state at desktop viewport', async () => {
    const { emptyMetrics, emptyActionNeeded, shop } = await fixtures;
    view.listings = [];
    view.metrics = emptyMetrics;
    view.actionNeeded = emptyActionNeeded;
    view.isLoading = true;
    view.shop = shop;

    const screen = await renderForVRT(<MarketplaceDashboard />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dashboard-loading-desktop');
  });
});
