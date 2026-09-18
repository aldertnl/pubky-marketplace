// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { DropStudioHome } from '@/organisms/Marketplace/DropStudioHome';

const view = vi.hoisted(() => ({
  filled: false,
  publishStatus: { record: 'idle', sync: 'idle' } as { record: string; sync: string },
  publishedDropId: null as string | null,
}));

// Media-less fixtures keep every capture network-free: the preview card and
// listing rows render their gradient/text fallbacks byte-identically.
const listingsFixture = vi.hoisted(() => [
  {
    id: `${'y'.repeat(52)}:item1`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item1',
    record: {
      title: 'Numbered print — Genesis',
      media: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 4_500,
    sync_status: 'synced',
    updated_at: 0,
  },
  {
    id: `${'y'.repeat(52)}:item2`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item2',
    record: {
      title: 'Signed zine',
      media: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 1_200, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 1_200,
    sync_status: 'synced',
    updated_at: 0,
  },
]);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell/drops',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/hooks/useOwnDrops/useOwnDrops', () => ({
  useOwnDrops: () => ({
    isLoading: false,
    isDurable: true,
    refresh: async () => undefined,
    rows: [
      {
        dropId: 'drop-live',
        record: {
          dropId: 'drop-live',
          title: 'Winter capsule',
          startsAt: '2026-01-01T10:00:00.000Z',
          endsAt: '2026-01-02T10:00:00.000Z',
        },
        drop: { dropId: 'drop-live', state: 'live', revision: 3 },
      },
      {
        dropId: 'drop-unregistered',
        record: {
          dropId: 'drop-unregistered',
          title: 'Spring preview',
          startsAt: '2025-12-20T10:00:00.000Z',
        },
        drop: null,
      },
    ],
  }),
}));

vi.mock('@/hooks/useDropStudio/useDropStudio', async () => {
  const { useForm } = await import('react-hook-form');
  const { dropStudioDefaults: defaults } = await import('@/hooks/useDropStudio/useDropStudio.types');
  return {
    useDropStudio: () => ({
      form: useForm({
        defaultValues: view.filled
          ? {
              ...defaults,
              title: 'Winter capsule — 100 numbered pieces',
              description: 'One hundred numbered pieces, first come first served.',
              listingIds: ['item1', 'item2'],
              startsAtLocal: '2026-01-15T18:00',
              endsAtLocal: '2026-01-16T18:00',
              totalQuantity: '100',
              perBuyerLimit: '2',
              stockDisplay: 'bands',
            }
          : defaults,
      }),
      listings: listingsFixture,
      isLoadingListings: false,
      isDurable: true,
      registration: { item1: 'registered', item2: 'unregistered' },
      registerListing: async () => undefined,
      publishStatus: view.publishStatus,
      publishErrors: [],
      publishedDropId: view.publishedDropId,
      publish: async () => undefined,
      retrySync: async () => undefined,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace Drop Studio — visual regression', () => {
  it('renders the drops home with the composer blank at desktop viewport', async () => {
    view.filled = false;
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-blank-desktop');
  });

  it('renders the drops home at mobile viewport', async () => {
    view.filled = false;
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-blank-mobile');
  });

  it('renders the filled composer with mixed listing registration states at desktop viewport', async () => {
    view.filled = true;
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-filled-desktop');
  });

  it('renders the record-ok / sync-failed two-truth panel with its retry affordance', async () => {
    view.filled = true;
    view.publishStatus = { record: 'ok', sync: 'failed' };
    view.publishedDropId = 'drop123';

    // Keep pointer events on: this scene must open the native <details> so the
    // two-truth rows and retry control are in frame. disableHover would set
    // pointer-events:none on the VRT root and make the trigger click time out.
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP });
    // Overflow is clipped to the VRT viewport; the native <summary> lives below
    // the fold. Native <summary> is not exposed as role=button in Playwright's
    // a11y tree (chromium/webkit/firefox), so query by its accessible name.
    screen.container.querySelector('[role="status"]')?.scrollIntoView({ block: 'center' });
    const detailsTrigger = screen.getByText('Technical details');
    await expect.element(detailsTrigger).toBeVisible();
    await detailsTrigger.click();
    await expect.element(screen.getByText('Retry registration')).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-two-truth-sync-failed-desktop');
  });
});
