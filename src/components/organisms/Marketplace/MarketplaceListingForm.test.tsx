import { createRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CreateMarketplaceListingData,
  createMarketplaceListingDefaults,
  createMarketplaceListingSchema,
  isCreateMarketplaceListingPublishReady,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import type {
  ListingMediaItem,
  UseListingMediaManagerResult,
} from '@/hooks/useListingMediaManager/useListingMediaManager';
import { MarketplaceListingForm } from './MarketplaceListingForm';

// The form reads the deployment's `pickup_available` capability through the
// controller seam (§A7). Tests default it to ON; the capability-off describe
// flips it. The editor's owner read is stubbed too so edit-mode mounts do
// not touch the network.
const pickupCapability = vi.hoisted(() => ({ available: true }));

// Presets are device-local (Dexie) and not under test here; the row's own
// behavior (apply fills fields and untoggles free shipping) IS — so the hook
// is mocked with one preset for that single test.
const shippingPresetsMock = vi.hoisted(() => ({
  presets: [] as Array<{
    id: string;
    owner_id: string;
    label: string;
    price_minor: number;
    currency: string;
    estimated_min_days: number;
    estimated_max_days: number;
    created_at: number;
    updated_at: number;
  }>,
}));

vi.mock('@/hooks/useMarketplaceShippingPresets/useMarketplaceShippingPresets', () => ({
  useMarketplaceShippingPresets: () => ({
    presets: shippingPresetsMock.presets,
    isLoading: false,
    saveFromFields: vi.fn(async () => true),
    remove: vi.fn(),
  }),
}));

vi.mock('@/controllers/commerce/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/controllers/commerce/commerce')>();
  return {
    ...actual,
    CommerceController: {
      ...actual.CommerceController,
      fetchPickupAvailable: () => Promise.resolve(pickupCapability.available),
      fetchSellerPickupDetails: () =>
        Promise.resolve({ listingAggregateId: 'listing:agg', current: null, lastVersion: 0 }),
    },
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

beforeEach(() => {
  // The shipping-preset picker renders only when presets exist; keep the
  // shared mock empty unless a test opts in (the snapshot stays picker-free).
  shippingPresetsMock.presets = [];
});

function buildMedia(items: ListingMediaItem[] = []): UseListingMediaManagerResult {
  return {
    items,
    maxPhotos: 8,
    error: null,
    inputRef: createRef<HTMLInputElement>(),
    onInputChange: vi.fn(),
    choose: vi.fn(),
    removeItem: vi.fn(),
    moveItem: vi.fn(),
    setAltText: vi.fn(),
    seed: vi.fn(),
    reset: vi.fn(),
    prepare: vi.fn(),
  };
}

function photoItem(key: string, altText = ''): ListingMediaItem {
  return {
    key,
    kind: 'new',
    file: new File(['x'], `${key}.jpg`, { type: 'image/jpeg' }),
    previewUrl: `blob:${key}`,
    altText,
  };
}

function expectIconOnlyButtonsToHaveLabels(container: HTMLElement) {
  const iconOnlyButtons = Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === '' && button.querySelector('svg') !== null,
  );
  expect(iconOnlyButtons.length).toBeGreaterThan(0);
  for (const button of iconOnlyButtons) {
    expect(button).toHaveAttribute('aria-label', expect.stringMatching(/\S/));
  }
}

function FormHarness({
  fulfillment = 'shipping',
  defaultValues = {},
  onSubmit = vi.fn(),
  media = buildMedia(),
  mode = 'create' as const,
  saleTermsLocked = false,
  listingId,
}: {
  fulfillment?: CreateMarketplaceListingData['fulfillment'];
  defaultValues?: Partial<CreateMarketplaceListingData>;
  onSubmit?: () => Promise<void>;
  media?: UseListingMediaManagerResult;
  mode?: 'create' | 'edit';
  saleTermsLocked?: boolean;
  listingId?: string;
}) {
  const form = useForm<CreateMarketplaceListingData>({
    defaultValues: { ...createMarketplaceListingDefaults, fulfillment, ...defaultValues },
  });
  return (
    <MarketplaceListingForm
      form={form}
      media={media}
      onSubmit={onSubmit}
      isPublishing={false}
      mode={mode}
      saleTermsLocked={saleTermsLocked}
      listingId={listingId}
    />
  );
}

describe('MarketplaceListingForm', () => {
  it('renders the complete physical listing contract', () => {
    render(<FormHarness />);

    expect(screen.getByRole('heading', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Item' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Price & format' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shipping & returns' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review & publish' })).toBeInTheDocument();
    expect(screen.getByText('Pricing currency')).toBeInTheDocument();
    expect(screen.getByText('Flat shipping (USD)')).toBeInTheDocument();
    expect(screen.getByText('Weight (g)')).toBeInTheDocument();
    expect(screen.getByText('Length (cm)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('You can add these later')).toBeInTheDocument();
  });

  it('hides package fields for pickup listings', () => {
    render(<FormHarness fulfillment="pickup" />);

    expect(screen.queryByText('Flat shipping (USD)')).not.toBeInTheDocument();
    expect(screen.queryByText('Weight (g)')).not.toBeInTheDocument();
  });
});

describe('MarketplaceListingForm pickup capability (§A7)', () => {
  beforeEach(() => {
    pickupCapability.available = true;
  });

  it('offers all three fulfillment choices when the deployment has pickup', async () => {
    const user = userEvent.setup();
    render(<FormHarness />);

    await user.click(screen.getByRole('combobox', { name: 'Fulfillment' }));
    expect(await screen.findByRole('option', { name: 'Ship item' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Local pickup' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Pickup or shipping' })).toBeInTheDocument();
  });

  it('offers shipping only, coerces a pickup value, and says why when the deployment has no pickup', async () => {
    pickupCapability.available = false;
    render(<FormHarness fulfillment="pickup" />);

    // The note renders once the capability read resolves…
    expect(await screen.findByText('Local pickup is not available on this deployment.')).toBeInTheDocument();
    // …and the stale pickup value is coerced to shipping the way the auction
    // path does, so the shipping/package fields come back.
    await waitFor(() => {
      expect(screen.getByText('Weight (g)')).toBeInTheDocument();
    });
    const select = screen.getByRole('combobox', { name: 'Fulfillment' });
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent('Ship item');
  });

  it('does not mount the pickup-details editor in create mode — it points at the edit page', async () => {
    render(<FormHarness fulfillment="shipping_and_pickup" listingId="boots_01" />);

    expect(
      await screen.findByText("Publish first, then add your meeting point from the listing's edit page."),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-surface="pickup-details-editor"]')).toBeNull();
  });

  it('mounts the pickup-details editor in edit mode when the listing offers pickup', async () => {
    render(<FormHarness fulfillment="shipping_and_pickup" mode="edit" listingId="boots_01" />);

    await waitFor(() => {
      expect(document.querySelector('[data-surface="pickup-details-editor"]')).not.toBeNull();
    });
    expect(screen.queryByText(/Publish first, then add your meeting point/)).not.toBeInTheDocument();
  });

  it('opens the photo picker and submits through the form owner', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const media = buildMedia([photoItem('one', 'Front')]);
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        onSubmit={onSubmit}
        media={media}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add photos (1/8)' }));
    await user.click(screen.getByRole('button', { name: 'Publish listing' }));

    expect(media.choose).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('focuses sections from anchor navigation', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<FormHarness />);

    await user.click(screen.getAllByRole('link', { name: /Price & format/ })[0]);

    expect(document.activeElement).toHaveAttribute('id', 'listing-section-price');
  });

  it('advances the mobile step indicator without unmounting sections', async () => {
    const user = userEvent.setup();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<FormHarness />);

    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review & publish' })).toBeInTheDocument();
  });

  it(
    'drops filled title, description, price, and category from the publish checklist',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup({ delay: null });
      render(<FormHarness />);

      const requiredItems = () => {
        const heading = screen.getByText('Required to publish');
        return Array.from(heading.parentElement?.querySelectorAll('ul li') ?? []).map((item) => item.textContent);
      };
      expect(requiredItems()).toEqual(expect.arrayContaining(['Title', 'Description', 'Category', 'Price']));
      const remainingBefore = requiredItems().length;

      await user.type(screen.getByLabelText('Title'), 'Vintage leather boots');
      await user.type(screen.getByLabelText('Description'), 'Well cared for boots with light wear.');
      await user.type(screen.getByLabelText('Price (USD)'), '125.00');
      await user.click(screen.getByRole('combobox', { name: 'Category' }));
      await user.click(await screen.findByRole('option', { name: 'Fashion' }));

      expect(requiredItems()).not.toEqual(expect.arrayContaining(['Title']));
      expect(requiredItems()).not.toEqual(expect.arrayContaining(['Description']));
      expect(requiredItems()).not.toEqual(expect.arrayContaining(['Category']));
      expect(requiredItems()).not.toEqual(expect.arrayContaining(['Price']));
      expect(requiredItems().length).toBeLessThan(remainingBefore);
    },
  );

  it('keeps publish disabled when description is empty even if other minimums are filled', () => {
    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{ title: 'Vintage boots', categoryId: 'fashion', price: '125.00', description: '' }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('Required to publish').parentElement).toHaveTextContent('Description');
  });

  it('keeps physical listings unpublished until shipping fields are filled or pickup is chosen', () => {
    const first = render(
      <FormHarness
        fulfillment="shipping"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    expect(screen.getByText('Shipping details')).toBeInTheDocument();
    first.unmount();

    render(
      <FormHarness
        fulfillment="pickup"
        defaultValues={{
          title: 'Vintage boots',
          description: 'Well cared for boots.',
          categoryId: 'fashion',
          price: '125.00',
        }}
        media={buildMedia([photoItem('one', 'Front')])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
  });

  it('defaults returns to final sale while remaining editable', () => {
    render(<FormHarness />);

    expect(screen.getByLabelText('Returns')).toHaveTextContent('Final sale');
  });

  it('renders photos in order with cover badge, reorder, and remove controls', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one', 'Front'), photoItem('two', 'Back'), photoItem('three', 'Sole')]);
    render(<FormHarness media={media} />);

    expect(screen.getByText('Cover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add photos (3/8)' })).toBeInTheDocument();
    // The cover cannot move earlier and the last photo cannot move later.
    expect(screen.getByRole('button', { name: 'Move photo 1 earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move photo 3 later' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move photo 2 earlier' }));
    expect(media.moveItem).toHaveBeenCalledWith('two', -1);

    await user.click(screen.getByRole('button', { name: 'Move photo 1 later' }));
    expect(media.moveItem).toHaveBeenCalledWith('one', 1);

    await user.click(screen.getByRole('button', { name: 'Remove photo 3' }));
    expect(media.removeItem).toHaveBeenCalledWith('three');
  });

  it('edits per-photo descriptions through the media manager', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one')]);
    render(<FormHarness media={media} />);

    await user.type(screen.getByLabelText('Photo 1 description'), 'F');
    expect(media.setAltText).toHaveBeenCalledWith('one', 'F');
  });

  it('disables adding photos once the studio limit is reached', () => {
    const media = buildMedia(
      Array.from({ length: 8 }, (_, index) => photoItem(`photo-${index + 1}`, `Photo ${index + 1}`)),
    );
    render(<FormHarness media={media} />);

    expect(screen.getByRole('button', { name: 'Add photos (8/8)' })).toBeDisabled();
  });

  it('locks the sale format and relabels submit in edit mode', () => {
    render(<FormHarness mode="edit" />);

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.getByText('The sale format cannot change after publishing.')).toBeInTheDocument();
  });

  it('locks the price for published auctions', () => {
    render(<FormHarness mode="edit" saleTermsLocked />);

    expect(screen.getByLabelText('Price (USD)')).toBeDisabled();
    expect(
      screen.getByText('Auction terms (format, starting price, and schedule) are fixed once the auction is published.'),
    ).toBeInTheDocument();
  });

  it('adds and removes inventory variants', async () => {
    const user = userEvent.setup();
    render(<FormHarness fulfillment="pickup" />);

    await user.click(screen.getByRole('button', { name: 'Add variant' }));
    expect(screen.getAllByText('Seller SKU')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove variant 2' }));
    expect(screen.getAllByText('Seller SKU')).toHaveLength(1);
  });

  it('labels every icon-only control in listing forms', async () => {
    const user = userEvent.setup();
    const media = buildMedia([photoItem('one', 'Front'), photoItem('two', 'Back')]);
    const { container } = render(<FormHarness media={media} />);

    await user.click(screen.getByRole('button', { name: 'Add variant' }));

    expectIconOnlyButtonsToHaveLabels(container);
  });
});

describe('MarketplaceListingForm scoped status watch', () => {
  function StatusWatchHarness({
    defaultValues,
    media = buildMedia([photoItem('one', 'Front')]),
  }: {
    defaultValues?: Partial<CreateMarketplaceListingData>;
    media?: UseListingMediaManagerResult;
  }) {
    const form = useForm<CreateMarketplaceListingData>({
      defaultValues: {
        ...createMarketplaceListingDefaults,
        fulfillment: 'pickup',
        title: 'Vintage boots',
        description: 'Well cared for boots.',
        categoryId: 'fashion-shoes-boots',
        price: '125.00',
        ...defaultValues,
      },
    });
    return (
      <>
        <button type="button" onClick={() => form.setValue('title', 'ab')}>
          shorten-title
        </button>
        <button type="button" onClick={() => form.setValue('description', '')}>
          clear-description
        </button>
        <button type="button" onClick={() => form.setValue('categoryId', '')}>
          clear-category
        </button>
        <button type="button" onClick={() => form.setValue('price', '')}>
          clear-price
        </button>
        <button
          type="button"
          onClick={() =>
            form.setValue('variants', [{ sku: '', size: '', color: '', style: '', quantity: '0', priceOverride: '' }])
          }
        >
          invalidate-variants
        </button>
        <button type="button" onClick={() => form.setValue('fulfillment', 'shipping')}>
          set-physical
        </button>
        <button type="button" onClick={() => form.setValue('shippingLabel', 'Ground')}>
          set-shipping-label
        </button>
        <button type="button" onClick={() => form.setValue('shippingPrice', '12.00')}>
          set-shipping-price
        </button>
        <button type="button" onClick={() => form.setValue('shippingMinDays', '3')}>
          set-shipping-min
        </button>
        <button type="button" onClick={() => form.setValue('shippingMaxDays', '7')}>
          set-shipping-max
        </button>
        <button type="button" onClick={() => form.setValue('packageWeight', '1200')}>
          set-weight
        </button>
        <button type="button" onClick={() => form.setValue('packageLength', '35.0')}>
          set-length
        </button>
        <button type="button" onClick={() => form.setValue('packageWidth', '25.0')}>
          set-width
        </button>
        <button type="button" onClick={() => form.setValue('packageHeight', '15.0')}>
          set-height
        </button>
        <button type="button" onClick={() => form.setValue('returnDays', '30')}>
          set-returns
        </button>
        <MarketplaceListingForm form={form} media={media} onSubmit={async () => {}} isPublishing={false} />
      </>
    );
  }

  // This re-renders the full studio per case (8 mounts of a 1,000-line
  // form); under full-suite load it exceeds the 5s default even on a clean
  // tree, so it gets an explicit budget.
  it('updates section status when each watched field changes', { timeout: 40_000 }, async () => {
    const user = userEvent.setup({ delay: null });
    const first = render(<StatusWatchHarness />);

    expect(document.getElementById('listing-section-item')).toHaveAttribute('data-section-complete', 'true');
    expect(document.getElementById('listing-section-price')).toHaveAttribute('data-section-complete', 'true');
    expect(document.getElementById('listing-section-shipping')).toHaveAttribute('data-section-complete', 'true');
    expect(document.getElementById('listing-section-review')).toHaveAttribute('data-section-complete', 'true');

    await user.click(screen.getByRole('button', { name: 'shorten-title' }));
    expect(document.getElementById('listing-section-item')).toHaveAttribute('data-section-complete', 'false');
    first.unmount();

    const descriptionCase = render(<StatusWatchHarness />);
    await user.click(screen.getByRole('button', { name: 'clear-description' }));
    expect(document.getElementById('listing-section-item')).toHaveAttribute('data-section-complete', 'false');
    descriptionCase.unmount();

    const categoryCase = render(<StatusWatchHarness />);
    await user.click(screen.getByRole('button', { name: 'clear-category' }));
    expect(document.getElementById('listing-section-item')).toHaveAttribute('data-section-complete', 'false');
    categoryCase.unmount();

    const priceCase = render(<StatusWatchHarness />);
    await user.click(screen.getByRole('button', { name: 'clear-price' }));
    expect(document.getElementById('listing-section-price')).toHaveAttribute('data-section-complete', 'false');
    priceCase.unmount();

    const variantsCase = render(<StatusWatchHarness />);
    await user.click(screen.getByRole('button', { name: 'invalidate-variants' }));
    expect(document.getElementById('listing-section-price')).toHaveAttribute('data-section-complete', 'false');
    variantsCase.unmount();

    const shippingCase = render(<StatusWatchHarness />);
    await user.click(screen.getByRole('button', { name: 'set-physical' }));
    expect(document.getElementById('listing-section-shipping')).toHaveAttribute('data-section-complete', 'false');
    await user.click(screen.getByRole('button', { name: 'set-shipping-label' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-price' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-min' }));
    await user.click(screen.getByRole('button', { name: 'set-shipping-max' }));
    await user.click(screen.getByRole('button', { name: 'set-weight' }));
    await user.click(screen.getByRole('button', { name: 'set-length' }));
    await user.click(screen.getByRole('button', { name: 'set-width' }));
    await user.click(screen.getByRole('button', { name: 'set-height' }));
    expect(document.getElementById('listing-section-shipping')).toHaveAttribute('data-section-complete', 'true');
    shippingCase.unmount();

    const returnsCase = render(<StatusWatchHarness />);
    expect(screen.getByText('Returns policy')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'set-returns' }));
    expect(screen.queryByText('Returns policy')).not.toBeInTheDocument();
    returnsCase.unmount();
  });
});

describe('MarketplaceListingForm free shipping', () => {
  it('disables the flat price while free shipping is on and keeps it for toggling back', async () => {
    const user = userEvent.setup();
    render(<FormHarness defaultValues={{ shippingPrice: '12.00' }} />);

    const price = screen.getByLabelText(/Flat shipping/);
    expect(price).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Free shipping' }));
    expect(price).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Free shipping' }));
    expect(price).toBeEnabled();
    expect(price).toHaveValue('12.00');
  });

  it('treats a free-shipping listing as shipping-section complete without a price', () => {
    render(
      <FormHarness
        defaultValues={{
          freeShipping: true,
          shippingPrice: '',
          packageWeight: '1200',
          packageLength: '35.0',
          packageWidth: '25.0',
          packageHeight: '15.0',
        }}
      />,
    );

    expect(
      document.querySelector('[data-surface="listing-section-shipping"]')?.getAttribute('data-section-complete'),
    ).toBe('true');
  });

  it('untoggles free shipping and fills the price when a preset is applied', async () => {
    shippingPresetsMock.presets = [
      {
        id: 'preset_1',
        owner_id: 'y'.repeat(52),
        label: 'Standard shipping',
        price_minor: 1200,
        currency: 'USD',
        estimated_min_days: 3,
        estimated_max_days: 7,
        created_at: 1,
        updated_at: 1,
      },
    ];
    const user = userEvent.setup();
    render(<FormHarness defaultValues={{ freeShipping: true, shippingPrice: '' }} />);

    const price = screen.getByLabelText(/Flat shipping/);
    expect(price).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: /shipping preset/i }));
    await user.click(await screen.findByRole('option', { name: /Standard shipping/ }));

    await waitFor(() => expect(price).toBeEnabled());
    expect(price).toHaveValue('12.00');
    expect(screen.getByRole('checkbox', { name: 'Free shipping' })).not.toBeChecked();
  });
});

describe('MarketplaceListingForm publish gate vs schema', () => {
  const pickupReady = {
    title: 'Vintage boots',
    description: 'Well cared for boots.',
    categoryId: 'fashion',
    price: '125.00',
  };

  it.each([
    {
      label: 'pickup schema-valid with photo',
      fulfillment: 'pickup' as const,
      values: pickupReady,
      photos: 1,
      enabled: true,
    },
    {
      label: 'empty description',
      fulfillment: 'pickup' as const,
      values: { ...pickupReady, description: '' },
      photos: 1,
      enabled: false,
    },
    {
      label: 'physical without shipping',
      fulfillment: 'shipping' as const,
      values: pickupReady,
      photos: 1,
      enabled: false,
    },
    {
      label: 'physical with shipping fields',
      fulfillment: 'shipping' as const,
      values: {
        ...pickupReady,
        shippingPrice: '12.00',
        packageWeight: '1200',
        packageLength: '35.0',
        packageWidth: '25.0',
        packageHeight: '15.0',
      },
      photos: 1,
      enabled: true,
    },
    {
      label: 'schema-valid without photo',
      fulfillment: 'pickup' as const,
      values: pickupReady,
      photos: 0,
      enabled: false,
    },
  ])('Publish enabled iff schema-valid plus photos ($label)', ({ fulfillment, values, photos, enabled }) => {
    render(
      <FormHarness
        fulfillment={fulfillment}
        defaultValues={values}
        media={photos > 0 ? buildMedia([photoItem('one', 'Front')]) : buildMedia()}
      />,
    );

    const formValues = { ...createMarketplaceListingDefaults, fulfillment, ...values };
    const schemaValid = createMarketplaceListingSchema.safeParse(formValues).success;
    expect(isCreateMarketplaceListingPublishReady(formValues, photos)).toBe(schemaValid && photos > 0);
    expect(isCreateMarketplaceListingPublishReady(formValues, photos)).toBe(enabled);
    if (enabled) {
      expect(screen.getByRole('button', { name: 'Publish listing' })).toBeEnabled();
    } else {
      expect(screen.getByRole('button', { name: 'Publish listing' })).toBeDisabled();
    }
  });
});

describe('MarketplaceListingForm - Snapshots', () => {
  it('matches the physical listing form snapshot', () => {
    const { container } = render(<FormHarness />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
