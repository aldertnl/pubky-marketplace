// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceCart } from '@/templates/Marketplace/MarketplaceCart';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Cart rows show the listing's cover photo (record media order, first image);
// a deterministic data-URI keeps the capture free of network fetches.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture } = await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const otherSeller = 'n'.repeat(52);
  const boots = toCommerceListingModel(
    createCommerceListingFixture({
      variants: [
        { id: 'variant_42', options: { size: '42' }, quantity: 3, mediaIds: ['image_01'], enabled: true },
        { id: 'variant_43', options: { size: '43' }, quantity: 1, mediaIds: ['image_01'], enabled: true },
      ],
    }),
  );
  const jacket = toCommerceListingModel(
    createCommerceListingFixture({
      listingId: 'selvedge_jacket',
      title: 'Selvedge denim jacket',
      categoryId: 'fashion-jackets',
      condition: 'excellent',
      variants: [{ id: 'variant_01', options: { size: 'M' }, quantity: 2, mediaIds: ['image_01'], enabled: true }],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 8_900, currency: 'USD', exponent: 2 },
        acceptsOffers: true,
      },
    }),
  );
  const camera = toCommerceListingModel(
    createCommerceListingFixture({
      ownerPubky: otherSeller,
      listingId: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      categoryId: 'electronics-cameras-film',
      condition: 'excellent',
      variants: [{ id: 'variant_01', options: {}, quantity: 1, mediaIds: ['image_01'], enabled: true }],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        acceptsOffers: false,
      },
    }),
  );

  const item = (listing: ReturnType<typeof toCommerceListingModel>, variantId: string, quantity: number) => ({
    id: `${listing.id}:${variantId}`,
    listingId: listing.id,
    variantId,
    quantity,
    listing,
  });

  return {
    singleSeller: [item(boots, 'variant_42', 1), item(boots, 'variant_43', 1)],
    multiSeller: [item(boots, 'variant_42', 2), item(jacket, 'variant_01', 1), item(camera, 'variant_01', 1)],
    staleItem: [item(boots, 'variant_42', 1), item(jacket, 'variant_gone', 1)],
  };
});

interface CartItemMoneyLike {
  amountMinor: number;
  currency: string;
  exponent: number;
}

interface CartItemLike {
  quantity: number;
  variantId: string;
  listing: {
    record: {
      variants: Array<{ id: string; priceOverride?: CartItemMoneyLike }>;
      sale: { format: string; unitPrice?: CartItemMoneyLike };
    };
  };
}

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  isLoading: false,
  adapterMode: 'sandbox' as string,
  deployEnv: 'staging' as 'production' | 'staging' | undefined,
  hasMarketplaceSession: false,
  addresses: [] as unknown[],
  selectedAddressId: null as string | null,
}));

// Two saved delivery addresses for the picker baseline (device-local rows;
// the shape mirrors CommerceDeliveryAddressModelSchema).
const savedAddresses = vi.hoisted(() => {
  const owner = 'b'.repeat(52);
  return [
    {
      id: `${owner}:addr_home`,
      owner_id: owner,
      label: 'Home',
      name: 'Alice Buyer',
      line1: '1 Market Street',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10001',
      country_code: 'US',
      is_default: true,
      last_used_at: 1_755_000_000_000,
      created_at: 1_754_000_000_000,
      updated_at: 1_755_000_000_000,
    },
    {
      id: `${owner}:addr_work`,
      owner_id: owner,
      label: 'Work',
      name: 'Alice Buyer',
      line1: '77 Broadway, Floor 4',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10006',
      country_code: 'US',
      is_default: false,
      last_used_at: null,
      created_at: 1_754_100_000_000,
      updated_at: 1_754_100_000_000,
    },
  ];
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/cart',
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

// The checkout money notice is gated on the deploy environment, not the
// adapter mode. Each scene names its environment explicitly: staging (test
// rails, no real funds) is the default; the locks-paykit scene runs on
// production, where real payment rails are live.
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => view.deployEnv };
});

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  const { sumMoneyByAsset } = await import('@/libs/commerce/pricing');
  return {
    ...actual,
    useMarketplaceCart: () => {
      const items = view.items as CartItemLike[];
      return {
        items,
        itemCount: items.reduce((total, item) => total + item.quantity, 0),
        subtotals: sumMoneyByAsset(
          items.flatMap((item) => {
            const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
            const price =
              variant?.priceOverride ??
              (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
            return price ? [{ money: price, quantity: item.quantity }] : [];
          }),
        ),
        isLoading: view.isLoading,
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceCheckoutDefaults } = await import('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types');
  return {
    useMarketplaceCheckout: () => ({
      form: useForm({ defaultValues: marketplaceCheckoutDefaults }),
      submit: vi.fn(async () => false),
      needsSession: false,
      sessionError: null,
      hasMarketplaceSession: view.hasMarketplaceSession,
      addresses: view.addresses,
      selectedAddressId: view.selectedAddressId,
      selectAddress: vi.fn(),
      // The fixture listings ship only, so no fulfillment choice renders.
      fulfillmentOptionsForSeller: () => ['shipping' as const],
      fulfillmentForSeller: () => 'shipping' as const,
      setFulfillmentChoice: vi.fn(),
      requiresDeliveryAddress: true,
      hasFulfillmentConflict: false,
      orderCount: 1,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string, options?: { includeReputation?: boolean }) => ({
    shop: null,
    reputation: options?.includeReputation === false ? { status: 'unavailable' } : { status: 'new_seller' },
    displayName: sellerPubky === 'n'.repeat(52) ? 'Film Camera Supply' : 'Satoshi Vintage',
  }),
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  view.hasMarketplaceSession = false;
  view.adapterMode = 'sandbox';
  view.deployEnv = 'staging';
  view.addresses = [];
  view.selectedAddressId = null;
  view.isLoading = false;
});

describe('Marketplace cart — visual regression', () => {
  it('renders a single-seller cart at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-single-seller-desktop');
  });

  it('renders a single-seller cart at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-single-seller-mobile');
  });

  it('renders a multi-seller cart at desktop viewport', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-multi-seller-desktop');
  });

  it('renders a multi-seller cart at mobile viewport', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-multi-seller-mobile');
  });

  it('renders a cart with a stale item whose variant is gone at desktop viewport', async () => {
    const { staleItem } = await fixtures;
    view.items = staleItem;
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-stale-item-desktop');
  });

  // The address book picker: two saved addresses with the default applied,
  // so the picker renders and the save-for-next-time controls stay hidden.
  it('renders the checkout with the saved-address picker at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;
    view.addresses = savedAddresses;
    view.selectedAddressId = (savedAddresses[0] as { id: string }).id;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-address-picker-desktop');
    view.addresses = [];
    view.selectedAddressId = null;
  });

  it('renders the checkout with the saved-address picker at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;
    view.addresses = savedAddresses;
    view.selectedAddressId = (savedAddresses[0] as { id: string }).id;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-address-picker-mobile');
    view.addresses = [];
    view.selectedAddressId = null;
  });

  it('renders the empty cart at desktop viewport', async () => {
    view.items = [];
    view.isLoading = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-empty-desktop');
  });

  it('renders the loading state at desktop viewport', async () => {
    view.items = [];
    view.isLoading = true;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-loading-desktop');
  });

  // Durable transaction-service mode: no "sandbox" wording on the guarantee
  // label or submit button — the copy states what is actually true.
  it('renders the durable-mode checkout labels at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;
    view.adapterMode = 'transaction-service';

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-durable-desktop');
    view.adapterMode = 'sandbox';
  });

  // locks-paykit mode: real payment rails are live, so the guarantee copy must
  // NOT claim "no real funds move" — it states where the funds actually go.
  // The scene is framed as the production deploy, so the money notice is the
  // real-money one.
  it('renders the locks-paykit checkout labels at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;
    view.adapterMode = 'locks-paykit';
    view.deployEnv = 'production';

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-locks-paykit-desktop');
    view.adapterMode = 'sandbox';
    view.deployEnv = 'staging';
  });

  // Durable mode with no marketplace session: step 1 shows the Ring approval
  // card and Place order stays disabled. Fixtured via adapterMode + the
  // checkout mock's hasMarketplaceSession flag (same seam as other cart VRTs).
  it('renders the unapproved durable cart at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    const screen = await renderForVRT(<MarketplaceCart />, { viewport: { width: 1440, height: 1600 } });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('cart-durable-unapproved-desktop');
    view.adapterMode = 'sandbox';
    view.hasMarketplaceSession = false;
  });
});
