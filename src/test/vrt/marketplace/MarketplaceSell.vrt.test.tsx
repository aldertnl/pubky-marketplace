// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import { MarketplaceSell } from '@/templates/Marketplace/MarketplaceSell';

// 8x8 solid-color PNG so photo scenarios show real previews without any
// network fetch or file-picker interaction.
const PREVIEW_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=';

const draftFixture = vi.hoisted(() => ({
  id: 'draft_row_01',
  owner_id: 'y'.repeat(52),
  listing_id: 'draftlisting01',
  data: {
    form: {
      title: 'Vintage leather boots',
      description: 'Hand-finished leather boots with a softly worn patina. Resoled once.',
      categoryId: 'fashion',
      condition: 'good',
      countryCode: 'US',
      region: 'NY',
      saleFormat: 'fixed_price',
      price: '125.00',
      variants: [{ sku: 'BOOTS-42', size: '42', color: 'Brown', style: 'Classic', quantity: '1', priceOverride: '' }],
      fulfillment: 'physical',
      shippingPrice: '12.00',
      weightGrams: '1200',
      lengthMillimeters: '350',
      widthMillimeters: '250',
      heightMillimeters: '150',
      returnDays: '30',
    },
  },
  created_at: 1_000,
  updated_at: 2_000,
}));

interface MockMediaItem {
  key: string;
  kind: 'new';
  file: File | null;
  previewUrl: string;
  altText: string;
}

const view = vi.hoisted(() => ({
  adapterMode: 'sandbox' as 'sandbox' | 'transaction-service',
  drafts: [] as unknown[],
  mediaItems: [] as unknown[],
  shippingPresets: [] as unknown[],
  pickupAvailable: false,
}));
const sellerPaymentConfig = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      stripePaymentLink: null,
      paypalMerchantEmail: null,
    }),
  ),
);

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

// Two device-local shipping presets so the shipping section's apply-preset
// picker renders (shape mirrors CommerceShippingPresetModelSchema).
const presetFixtures = vi.hoisted(() => {
  const owner = 'y'.repeat(52);
  return [
    {
      id: `${owner}:preset_standard`,
      owner_id: owner,
      label: 'Standard shipping',
      price_minor: 1_200,
      currency: 'USD',
      estimated_min_days: 3,
      estimated_max_days: 7,
      created_at: 1_754_000_000_000,
      updated_at: 1_755_000_000_000,
    },
    {
      id: `${owner}:preset_express`,
      owner_id: owner,
      label: 'Express courier',
      price_minor: 2_500,
      currency: 'USD',
      estimated_min_days: 1,
      estimated_max_days: 2,
      created_at: 1_754_100_000_000,
      updated_at: 1_754_100_000_000,
    },
  ];
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getListingDrafts: () => Promise.resolve(view.drafts),
    commitUpdateListingDraft: () => Promise.resolve(),
    commitDeleteListingDraft: () => Promise.resolve(),
    commitCreateMedia: () => Promise.resolve(),
    commitUpsertListing: () => Promise.resolve(),
    getShippingPresets: () => Promise.resolve(view.shippingPresets),
    commitUpsertShippingPreset: () => Promise.resolve(),
    fetchPickupAvailable: () => Promise.resolve(view.pickupAvailable),
    getSellerPaymentConfig: sellerPaymentConfig,
  },
}));

vi.mock('@/hooks/useListingMediaManager/useListingMediaManager', () => ({
  useListingMediaManager: () => ({
    items: view.mediaItems,
    maxPhotos: 8,
    error: null,
    inputRef: { current: null },
    onInputChange: vi.fn(),
    choose: vi.fn(),
    removeItem: vi.fn(),
    moveItem: vi.fn(),
    setAltText: vi.fn(),
    seed: vi.fn(),
    reset: vi.fn(),
    prepare: vi.fn(async () => ({ ok: false as const, reason: 'no-photos' as const })),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

function photoItem(key: string, altText: string): MockMediaItem {
  return { key, kind: 'new', file: null, previewUrl: PREVIEW_DATA_URL, altText };
}

describe('Marketplace sell studio — visual regression', () => {
  beforeEach(() => {
    // The display store persists to localStorage, which browser-mode workers
    // share across suites — MarketplacePricingUnits sets both systems, so an
    // unpinned preference here renders whichever ran last. Pin the system the
    // committed baselines were captured with.
    useMarketplaceDisplayStore.setState({ measurementSystem: 'imperial' });
    view.pickupAvailable = false;
    view.adapterMode = 'sandbox';
    sellerPaymentConfig.mockClear();
  });

  it('renders the empty listing form at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-empty-form-desktop');
  });

  it('renders the empty listing form at mobile viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-empty-form-mobile');
  });

  it('renders the publish-blocked payment state at desktop viewport', async () => {
    view.adapterMode = 'transaction-service';
    view.drafts = [
      {
        ...draftFixture,
        data: {
          ...draftFixture.data,
          form: {
            ...draftFixture.data.form,
            categoryId: 'fashion-men-footwear-boots',
            attrSize: 'US 9',
            currency: 'USD',
            fulfillment: 'pickup',
          },
        },
      },
    ];
    view.mediaItems = [photoItem('photo_front', 'Front view of the boots')];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: 'Publish listing' }).click();
    await vi.waitFor(() => screen.getByText('Configure a payment method before publishing'));
    expect(sellerPaymentConfig).toHaveBeenCalledWith('y'.repeat(52));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-surface', 'seller-publish-blocked');
    expect(alert).toHaveTextContent('Configure a payment method before publishing');
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
    await expect(expectVrtSurface('seller-publish-blocked')).toMatchScreenshot('sell-publish-blocked-desktop');
  });

  // The shipping section with saved presets: the apply-preset picker renders
  // next to "Save as preset" once the seller has presets on this device.
  it('renders the shipping section with the preset picker at desktop viewport', async () => {
    view.drafts = [draftFixture];
    view.mediaItems = [];
    view.shippingPresets = presetFixtures;

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('#listing-shipping-preset')) {
        throw new Error('The preset picker has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-shipping-presets-desktop');
    view.shippingPresets = [];
  });

  it('renders the form with an autosaved draft restored at desktop viewport', async () => {
    view.drafts = [draftFixture];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const input = screen.container.querySelector<HTMLInputElement>('#title');
      if (input?.value !== draftFixture.data.form.title) throw new Error('Draft has not populated the form yet.');
    });
    // The restored-draft notice sits at the top; the populated fields prove
    // hydration below the fold.
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-draft-restored-desktop');
  });

  it('renders the form with additional variants added at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: 'Add variant' }).click();
    await screen.getByRole('button', { name: 'Add variant' }).click();
    await vi.waitFor(() => {
      if (screen.container.querySelectorAll('input[name^="variants."][name$=".sku"]').length !== 3) {
        throw new Error('Variant rows have not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-variants-added-desktop');
  });

  it('renders the compose form with multiple ordered photos at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = [
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
      photoItem('photo_sole', 'Soles with light wear'),
    ];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-photos-attached-desktop');
  });

  it('renders the compose form with multiple ordered photos at mobile viewport', async () => {
    view.drafts = [];
    view.mediaItems = [
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
    ];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-photos-attached-mobile');
  });

  it('renders the photo list after a reorder moved a new cover first at desktop viewport', async () => {
    view.drafts = [];
    // Same photos as the compose scenario but with the sole shot promoted to
    // cover — the Cover badge must follow position one, not the original file.
    view.mediaItems = [
      photoItem('photo_sole', 'Soles with light wear'),
      photoItem('photo_front', 'Front view of the boots'),
      photoItem('photo_back', 'Back view showing the heels'),
    ];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-photos-reordered-desktop');
  });

  it('renders the photo limit reached state at desktop viewport', async () => {
    view.drafts = [];
    view.mediaItems = Array.from({ length: 8 }, (_, index) =>
      photoItem(`photo_${index + 1}`, `Detail photo ${index + 1}`),
    );

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-photos-limit-desktop');
  });

  // A restored draft for a sized fashion leaf: the category cascade shows
  // the full path and the category-dependent item specifics render populated
  // (size chart select, brand, color/style chips, source, age).
  it('renders fashion item specifics for a sized leaf at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            categoryId: 'fashion-men-tops-hoodies',
            attrSize: 'L',
            attrBrand: 'Champion',
            attrColors: ['grey', 'navy'],
            attrSource: 'vintage',
            attrAge: '90s',
            attrStyles: ['retro', 'sportswear'],
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('[data-cy="marketplace-listing-attributes"]')) {
        throw new Error('The item specifics block has not rendered yet.');
      }
      if (!screen.container.querySelector('#marketplace-attribute-size')) {
        throw new Error('The size field has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-attributes-fashion-desktop');
    view.drafts = [];
  });

  it('renders electronics item specifics (brand, model, colors) at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            title: 'Program-mode 35mm SLR',
            description: 'Clean program-mode SLR body with a fresh light seal service.',
            categoryId: 'electronics-cameras-film',
            attrBrand: 'Canon',
            attrModel: 'AE-1 Program',
            attrColors: ['black'],
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!screen.container.querySelector('#marketplace-attribute-model')) {
        throw new Error('The model field has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-attributes-electronics-desktop');
    view.drafts = [];
  });

  it('renders validation errors after an empty submit at desktop viewport', async () => {
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            description: '',
            fulfillment: 'pickup',
          },
        },
      },
    ];
    view.mediaItems = [photoItem('photo_front', 'Front view of the boots')];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const input = screen.container.querySelector<HTMLInputElement>('#title');
      if (input?.value !== draftFixture.data.form.title) throw new Error('Draft has not populated the form yet.');
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Description')) {
        throw new Error('The description checklist row has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('sell-validation-errors-desktop');
  });

  it('renders the seller studio with pickup enabled and a pickup-only draft at desktop viewport', async () => {
    view.pickupAvailable = true;
    view.drafts = [
      {
        ...draftFixture,
        data: {
          form: {
            ...draftFixture.data.form,
            fulfillment: 'pickup',
          },
        },
      },
    ];
    view.mediaItems = [];

    const screen = await renderForVRT(<MarketplaceSell />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const input = screen.container.querySelector<HTMLInputElement>('#title');
      if (input?.value !== draftFixture.data.form.title) throw new Error('Draft has not populated the form yet.');
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Publish first, then add your meeting point')) {
        throw new Error('The pickup-enabled studio copy has not rendered yet.');
      }
    });
    await expect(expectVrtSurface('listing-section-shipping')).toMatchScreenshot('sell-pickup-enabled-desktop');
    view.pickupAvailable = false;
    view.drafts = [];
  });
});
