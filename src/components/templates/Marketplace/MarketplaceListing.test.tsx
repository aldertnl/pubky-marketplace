import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { CAPABILITIES } from '@/config/app';
import { createCommerceListingFixture, createCommerceShopFixture } from '@/test/fixtures/commerce/commerce';
import { toCommerceListingModel, toCommerceShopModel } from '@/test/fixtures/commerce/listing-models';
import { createListingProjectionFixture } from '@/test/fixtures/commerce/projections';
import { MarketplaceListing } from './MarketplaceListing';

const cartAdd = vi.hoisted(() => vi.fn());
const projectionRefresh = vi.hoisted(() => vi.fn());
const sellerReputation = vi.hoisted((): { value: CommerceSellerReputationOverview | { status: 'loading' } } => ({
  value: { status: 'new_seller' as const },
}));
const authState = vi.hoisted(() => ({
  currentUserPubky: 'b'.repeat(52),
  setShowSignInDialog: vi.fn(),
}));

const view = vi.hoisted(() => ({
  listing: null as ReturnType<typeof toCommerceListingModel> | null,
  shop: null as ReturnType<typeof toCommerceShopModel> | null,
  projection: null as ReturnType<typeof createListingProjectionFixture> | null,
  projectionError: null as string | null,
  needsSession: false,
  hasFullHomeserverGrant: false,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => 'transaction-service' };
});

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getListing: () => view.listing,
    getShop: () => view.shop,
    getOrFetchListing: () => Promise.resolve(null),
    hasFullHomeserverGrant: () => view.hasFullHomeserverGrant,
  },
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'awaiting',
    authorizationUrl: '',
    errorMessage: null,
    // Mirrors the hook's single decision: full grant iff the homeserver
    // grant is narrow (the flag defaults on under tests).
    requestsFullGrant: !view.hasFullHomeserverGrant,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
    getState: () => authState,
  }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', () => ({
  useMarketplaceCart: () => ({
    items: [],
    itemCount: 0,
    subtotals: [],
    isLoading: false,
    add: cartAdd,
    update: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceProjection/useMarketplaceProjection', () => ({
  useMarketplaceProjection: () => ({
    projection: view.projection,
    isLoading: false,
    error: view.projectionError,
    needsSession: view.needsSession,
    refresh: projectionRefresh,
  }),
}));

vi.mock('@/hooks/useMarketplaceReviews/useMarketplaceReviews', () => ({
  useSellerReputation: () => sellerReputation.value,
}));

vi.mock('@/hooks/useMeasurementSystem/useMeasurementSystem', () => ({
  useMeasurementSystem: () => 'metric',
}));

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceCommunityTags', () => ({
  MarketplaceCommunityTags: () => null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceListingSavePicker', () => ({
  MarketplaceListingSavePicker: () => null,
}));

vi.mock('@/organisms/Marketplace/MarketplaceMessageDialog', () => ({
  MarketplaceMessageDialog: () => <button type="button">Message seller</button>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceReviewsSection', () => ({
  MarketplaceReviewsSection: () => <section aria-label="Reviews" />,
}));

describe('MarketplaceListing', () => {
  beforeEach(() => {
    view.listing = toCommerceListingModel(createCommerceListingFixture());
    view.shop = toCommerceShopModel(createCommerceShopFixture());
    view.projection = createListingProjectionFixture();
    view.projectionError = null;
    view.needsSession = false;
    view.hasFullHomeserverGrant = false;
    sellerReputation.value = { status: 'new_seller' };
    cartAdd.mockClear();
    projectionRefresh.mockClear();
    authState.setShowSignInDialog.mockClear();
  });

  const renderListing = () => {
    const listing = view.listing;
    if (!listing) throw new Error('Expected listing fixture');
    render(<MarketplaceListing sellerPubky={listing.seller_id} listingId={listing.listing_id} />);
    return listing;
  };

  it('does not show the approval card just for viewing a listing without a marketplace session', () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;

    renderListing();

    expect(screen.getByRole('heading', { name: 'Vintage leather boots' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message seller' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve in Pubky Ring' })).not.toBeInTheDocument();
  });

  it('renders the seller block with shop identity, actions, and shipping copy', () => {
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        fulfillmentMethods: ['physical'],
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground shipping',
            price: { amountMinor: 899, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 5,
          },
        ],
      }),
    );

    renderListing();

    expect(screen.getByText('Sold by')).toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.getByText('New seller · no reviews yet')).toBeInTheDocument();
    expect(screen.queryByText(/Shop opened/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View shop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message seller' })).toBeInTheDocument();
    expect(screen.getByText('Shipping: Ground shipping $8.99')).toBeInTheDocument();
  });

  it('falls back to the seller pubky when no shop record exists', () => {
    view.shop = null;
    const listing = renderListing();

    expect(screen.getByText(`${listing.seller_id.slice(0, 10)}…`)).toBeInTheDocument();
    expect(screen.getByText('New seller · no reviews yet')).toBeInTheDocument();
    expect(screen.queryByText('Shop opened Aug 2026')).not.toBeInTheDocument();
  });

  it('renders the seller rating aggregate when reputation is present', () => {
    sellerReputation.value = {
      status: 'rated',
      summary: {
        count: 12,
        verifiedCount: 9,
        avg: 4.7,
        histogram: [0, 0, 1, 2, 9],
        responseCount: 3,
        editedLateCount: 0,
        attestors: {},
        lastReviewedAt: '2026-08-20T12:00:00.000Z',
      },
    };

    renderListing();

    expect(screen.getByRole('img', { name: 'Rated 4.7 out of 5 from 12 reviews' })).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
    expect(screen.queryByText('New seller · no reviews yet')).not.toBeInTheDocument();
  });

  it('adds the selected variant to cart without a marketplace session', async () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    const user = userEvent.setup();

    const listing = renderListing();
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));

    expect(cartAdd).toHaveBeenCalledWith(`${listing.seller_id}:${listing.listing_id}`, 'variant_01', 1);
  });

  it('does not show the approval card after Add to cart is clicked without a marketplace session', async () => {
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    const user = userEvent.setup();

    renderListing();
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));

    expect(screen.queryByRole('heading', { name: 'Approve purchases in Pubky Ring' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve in Pubky Ring' })).not.toBeInTheDocument();
  });

  it('adds the selected variant to cart when the marketplace session is ready', async () => {
    const user = userEvent.setup();

    const listing = renderListing();
    await user.click(screen.getByRole('button', { name: 'Add to cart' }));

    expect(cartAdd).toHaveBeenCalledWith(`${listing.seller_id}:${listing.listing_id}`, 'variant_01', 1);
    expect(screen.queryByRole('button', { name: 'Approve in Pubky Ring' })).not.toBeInTheDocument();
  });

  function renderAuctionListingNeedingSession() {
    const auctionStartsAt = new Date(Date.now() - 60_000).toISOString();
    const auctionEndsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        listingId: 'rangefinder_camera',
        title: '35mm rangefinder camera',
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          reservePrice: { amountMinor: 6_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: auctionStartsAt,
          endsAt: auctionEndsAt,
          antiSnipingWindowSeconds: 300,
          antiSnipingExtensionSeconds: 300,
        },
      }),
    );
    view.projection = null;
    view.projectionError = 'A marketplace session is required.';
    view.needsSession = true;
    renderListing();
  }

  it('uses an anti-sniping projection extension to keep bidding live', () => {
    const scheduledEndsAt = new Date(Date.now() - 60_000).toISOString();
    const projectedEndsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    view.listing = toCommerceListingModel(
      createCommerceListingFixture({
        sale: {
          format: 'auction',
          startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
          reservePrice: { amountMinor: 6_500, currency: 'USD', exponent: 2 },
          minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
          startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          endsAt: scheduledEndsAt,
          antiSnipingWindowSeconds: 300,
          antiSnipingExtensionSeconds: 300,
        },
      }),
    );
    view.projection = createListingProjectionFixture({
      saleFormat: 'auction',
      auction: {
        startsAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        endsAt: projectedEndsAt,
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        currentPrice: { amountMinor: 6_900, currency: 'USD', exponent: 2 },
        leaderPubky: 'b'.repeat(52),
        bidCount: 4,
        reserveMet: true,
      },
    });

    renderListing();

    expect(screen.getByRole('button', { name: 'Place a bid' })).toBeEnabled();
  });

  it('reveals the full-grant approval card when a bridged buyer with a narrow grant places a bid', async () => {
    view.hasFullHomeserverGrant = false;
    const user = userEvent.setup();

    renderAuctionListingNeedingSession();
    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    expect(screen.getByText(CAPABILITIES)).toBeInTheDocument();
    expect(
      screen.getByText(/this is the first Shop-scoped approval; it was not covered by signing in on pubky.app/i),
    ).toBeInTheDocument();
  });

  it('reveals the empty-caps reconnect card when a full-grant buyer places a bid without a marketplace session', async () => {
    view.hasFullHomeserverGrant = true;
    const user = userEvent.setup();

    renderAuctionListingNeedingSession();
    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Pubky Ring' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve in Pubky Ring' }));
    expect(screen.getByText(/Ring will show an empty permission list/i)).toBeInTheDocument();
    expect(screen.queryByText(CAPABILITIES)).not.toBeInTheDocument();
  });
});
