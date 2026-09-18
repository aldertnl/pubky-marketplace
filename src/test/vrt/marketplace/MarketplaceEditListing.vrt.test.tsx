// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceEditListing } from '@/templates/Marketplace/MarketplaceEditListing';

// Existing photos resolve to a deterministic data-URI so the edit studio
// shows real thumbnails without fetching homeserver bytes.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, COMMERCE_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/commerce');
  const seller = COMMERCE_FIXTURE_SELLER;
  const image = (id: string, altText: string) => ({
    id,
    type: 'image' as const,
    url: `pubky://${seller}/pub/pubky.app/marketplace/v1/media/${id}`,
    contentHash: 'c'.repeat(64),
    mimeType: 'image/jpeg',
    byteSize: 10_000,
    width: 1_200,
    height: 1_600,
    altText,
  });
  // A complete shipped listing's delivery facts: hydration fills the
  // shipping/package fields from these, so the publish checklist renders
  // complete (a shipping record without them would leave "Shipping details"
  // outstanding — and the auction coercion to shipping would surface it).
  const shipping = {
    fulfillmentMethods: ['physical' as const],
    shippingOptions: [
      {
        id: 'ship_01',
        pricing: 'flat' as const,
        label: 'Standard shipping',
        price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
        estimatedMinDays: 3,
        estimatedMaxDays: 7,
      },
    ],
    package: { weightGrams: 800, lengthMillimeters: 320, widthMillimeters: 220, heightMillimeters: 120 },
  };
  return {
    seller,
    record: createCommerceListingFixture({
      ...shipping,
      media: [image('image_01', 'Front view'), image('image_02', 'Sole view')],
    }),
    auctionRecord: createCommerceListingFixture({
      ...shipping,
      listingId: 'rangefinder_camera',
      title: '35mm rangefinder camera',
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
  };
});

const view = vi.hoisted(() => ({
  record: undefined as unknown,
  currentUserPubky: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/listing',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: view.currentUserPubky }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: () =>
      view.record ? Promise.resolve(view.record) : Promise.reject(new Error('listing unavailable')),
    commitCreateMedia: () => Promise.resolve(),
    commitUpsertListing: () => Promise.resolve(),
    getShippingPresets: () => Promise.resolve([]),
    commitUpsertShippingPreset: () => Promise.resolve(),
    // Pickup is unavailable on this capture's deployment: the studio renders
    // the deterministic unavailability note, not an async capability race.
    fetchPickupAvailable: () => Promise.resolve(false),
  },
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

async function waitForHydration(screen: { container: HTMLElement }, title: string) {
  await vi.waitFor(() => {
    const input = screen.container.querySelector<HTMLInputElement>('#title');
    if (input?.value !== title) throw new Error('The edit form has not hydrated yet.');
  });
}

describe('Marketplace edit listing — visual regression', () => {
  it('renders the prefilled edit studio with existing photos at desktop viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, record.title);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-prefilled-desktop');
  });

  it('renders the prefilled edit studio at mobile viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await waitForHydration(screen, record.title);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-prefilled-mobile');
  });

  it('renders the locked auction terms notice at desktop viewport', async () => {
    const { seller, auctionRecord } = await fixtures;
    view.record = auctionRecord;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="rangefinder_camera" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, auctionRecord.title);
    // The price/sale-format lockout note sits in the pricing card below the
    // crop; bring it into view for the baseline.
    screen.container.querySelector('#saleFormat')?.scrollIntoView({ block: 'center' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-auction-locked-desktop');
  });

  it('renders the not-owner refusal at desktop viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = 'z'.repeat(52);

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Only the seller can edit this listing')) {
        throw new Error('The refusal state has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-not-owner-desktop');
  });

  it('renders the load-failure state at desktop viewport', async () => {
    const { seller } = await fixtures;
    view.record = undefined;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="gone_listing" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Listing unavailable')) {
        throw new Error('The load-failure state has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-unavailable-desktop');
  });
});
