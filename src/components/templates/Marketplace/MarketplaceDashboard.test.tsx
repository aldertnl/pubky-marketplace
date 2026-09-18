import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { COMMERCE_FIXTURE_SELLER, createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { MarketplaceDashboard } from './MarketplaceDashboard';

const viewport = vi.hoisted(() => ({ isMobile: false }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const dashboardFns = vi.hoisted(() => ({
  duplicateListing: vi.fn(async () => true),
  hasUnsavedListingDraft: vi.fn(async (): Promise<string | null> => null),
}));
const dashboardState = vi.hoisted(() => ({
  listings: [] as unknown[],
  metrics: {
    activeListings: 0,
    totalInventory: 0,
    lowStock: 0,
    paidOrders: 0,
    revenue: [] as unknown[],
    openOffers: 0,
  },
  actionNeeded: {
    ordersToShip: 0,
    offersAwaitingReply: 0,
    expiringAuctions: 0,
    total: 0,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/hooks/useIsMobile/useIsMobile', () => ({
  useIsMobile: () => viewport.isMobile,
}));

vi.mock('@/hooks/useMarketplaceSellerDashboard/useMarketplaceSellerDashboard', () => ({
  useMarketplaceSellerDashboard: () => ({
    listings: dashboardState.listings,
    sellerOrders: [],
    offers: [],
    isLoading: false,
    needsSession: false,
    sessionError: null,
    metrics: dashboardState.metrics,
    actionNeeded: dashboardState.actionNeeded,
    updateListingState: vi.fn(async () => true),
    duplicateListing: dashboardFns.duplicateListing,
    hasUnsavedListingDraft: dashboardFns.hasUnsavedListingDraft,
    exportCsv: () => 'listing_id,title,state,format,price_minor,currency,inventory',
  }),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => ({ record: { name: 'Satoshi Vintage' } }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: () => Promise.resolve({ record: { name: 'Satoshi Vintage' } }),
    getOrFetchShop: () => Promise.resolve({ name: 'Satoshi Vintage' }),
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: COMMERCE_FIXTURE_SELLER }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('MarketplaceDashboard', () => {
  it('renders KPI metrics as a horizontal chip strip on mobile', () => {
    viewport.isMobile = true;
    dashboardState.listings = [listing()];
    dashboardState.metrics = {
      activeListings: 1,
      totalInventory: 4,
      lowStock: 0,
      paidOrders: 2,
      revenue: [{ amountMinor: 12_500, currency: 'USD', exponent: 2 }],
      openOffers: 1,
    };
    dashboardState.actionNeeded = {
      ordersToShip: 1,
      offersAwaitingReply: 0,
      expiringAuctions: 0,
      total: 1,
    };

    render(<MarketplaceDashboard />);

    expect(screen.getByRole('heading', { name: 'Seller studio' })).toBeInTheDocument();
    const chips = screen.getByTestId('marketplace-dashboard-kpi-chips');
    expect(chips).toHaveAttribute('role', 'region');
    expect(chips).toHaveAttribute('aria-label', 'Dashboard metrics');
    expect(chips).toHaveAttribute('tabindex', '0');
    expect(chips).toHaveTextContent('Active listings');
    expect(chips).toHaveTextContent('1');
    expect(chips).toHaveTextContent('$125.00');
    expect(screen.getByText('Action needed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My listings' })).toBeInTheDocument();
  });

  it('keeps KPI cards on desktop', () => {
    viewport.isMobile = false;
    dashboardState.listings = [listing()];

    render(<MarketplaceDashboard />);

    expect(screen.queryByTestId('marketplace-dashboard-kpi-chips')).not.toBeInTheDocument();
    expect(screen.getByText('Active listings')).toBeInTheDocument();
  });

  it('seeds a sell draft from Duplicate and navigates to the sell studio', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue(null);
    router.push.mockClear();
    const rowListing = listing({ listingId: 'no_media', title: 'No media listing', media: [] });
    dashboardState.listings = [rowListing];

    render(<MarketplaceDashboard />);

    const row = screen.getByRole('row', { name: /No media listing/ });
    expect(within(row).getByLabelText('No thumbnail for No media listing')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Duplicate/ }));

    await vi.waitFor(() => {
      expect(dashboardFns.duplicateListing).toHaveBeenCalledWith('no_media', { replaceUnsavedDraft: false });
    });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
    });
  });

  it('asks before replacing an unsaved draft and keeps it when Keep is chosen', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('existingdraft');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );

    expect(await screen.findByTestId('dialog-title')).toHaveTextContent('Replace your unsaved draft?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(dashboardFns.duplicateListing).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('replaces an unsaved draft when Replace is confirmed', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('existingdraft');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));

    await vi.waitFor(() => {
      expect(dashboardFns.duplicateListing).toHaveBeenCalledWith('no_media', {
        replaceUnsavedDraft: true,
        unsavedDraftId: 'existingdraft',
      });
    });
    await vi.waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.SELL);
    });
  });

  it('asks before replacing an unsaved photos-only draft', async () => {
    viewport.isMobile = false;
    dashboardFns.duplicateListing.mockClear();
    dashboardFns.hasUnsavedListingDraft.mockResolvedValue('photosonly');
    router.push.mockClear();
    dashboardState.listings = [listing({ listingId: 'no_media', title: 'No media listing', media: [] })];

    render(<MarketplaceDashboard />);

    fireEvent.click(
      within(screen.getByRole('row', { name: /No media listing/ })).getByRole('button', { name: /Duplicate/ }),
    );

    expect(await screen.findByTestId('dialog-title')).toHaveTextContent('Replace your unsaved draft?');
    expect(dashboardFns.duplicateListing).not.toHaveBeenCalled();
  });
});

function listing(overrides: Partial<Parameters<typeof createCommerceListingFixture>[0]> = {}) {
  return toCommerceListingModel(createCommerceListingFixture(overrides));
}
