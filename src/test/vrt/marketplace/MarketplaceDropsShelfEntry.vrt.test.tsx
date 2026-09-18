// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';
import { Marketplace } from '@/templates/Marketplace/Marketplace';

/**
 * The drops entry on the marketplace home (ADR 0026): rendered ONLY in the
 * durable modes — the sandbox baseline proves its absence, since drops need
 * the transaction service's clock and the shelf must not advertise a
 * feature the deployment cannot honor.
 */

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

const VRT_USER_PUBKY = vi.hoisted(() => 'y'.repeat(52));

const catalogView = vi.hoisted(() => ({ adapterMode: 'transaction-service' as string }));

const fixtures = vi.hoisted(async () => {
  const { createCommerceSandboxCatalog } = await import('@/libs/commerce/sandbox-catalog');
  const { buildMarketplaceCatalogItems } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const catalog = createCommerceSandboxCatalog();
  return {
    listings: buildMarketplaceCatalogItems(catalog.listings.map(toCommerceListingModel), []).slice(0, 4),
    shopsBySeller: new Map(catalog.shops.map((shop) => [shop.ownerPubky, shop])),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

// These scenes are framed as the production deploy: the home environment
// banner is a staging-only element, so neither baseline carries it. The
// sandbox scene's old baseline coupled the banner to the adapter mode; the
// named production environment keeps that coupling out of the fixture.
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'production' };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: VRT_USER_PUBKY }),
}));

vi.mock('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog', async () => {
  const catalog = await fixtures;
  return {
    useMarketplaceCatalog: () => ({
      listings: catalog.listings,
      facetPool: catalog.listings,
      shopsBySeller: catalog.shopsBySeller,
      isLoading: false,
      adapterMode: catalogView.adapterMode,
    }),
  };
});

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

// Nav badges read live Dexie/service state; zero keeps these baselines at the
// no-badge nav (populated badges are captured in MarketplaceNavBadges VRT).
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches', () => ({
  useMarketplaceSavedSearches: () => ({
    searches: [],
    isSignedIn: true,
    saveCurrentSearch: vi.fn(async () => true),
    applySearch: vi.fn(async () => {}),
    deleteSearch: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace home drops entry — visual regression', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The promo is captured by Marketplace.vrt; dismissing it here keeps this
    // baseline focused on the drops entry between the tools and the catalog.
    window.localStorage.setItem(
      buildFeatureDiscoveryStorageKey(VRT_USER_PUBKY, MARKETPLACE_PROMO_STORAGE_ID),
      'dismissed',
    );
  });

  it('renders the drops entry on the home in durable mode at desktop viewport', async () => {
    catalogView.adapterMode = 'transaction-service';
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByText('Browse drops')).toBeInTheDocument();
    expect(
      document.querySelector('[data-testid="marketplace-drops-shelf-entry"][data-variant="desktop"]'),
    ).not.toBeNull();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-home-drops-entry-desktop');
  });

  it('renders NO drops entry in sandbox mode at desktop viewport', async () => {
    catalogView.adapterMode = 'sandbox';
    const screen = await renderForVRT(<Marketplace />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('marketplace-home-no-drops-entry-desktop');
  });
});
