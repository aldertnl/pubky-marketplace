import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceCart } from './MarketplaceCart';

beforeAll(() => {
  // Radix Select needs pointer-capture and scrollIntoView in jsdom (same
  // stubs the listing-form tests use).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
});

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  isLoading: false,
  adapterMode: 'sandbox' as string,
  deployEnv: 'production' as 'production' | 'staging' | undefined,
  hasMarketplaceSession: false,
  needsSession: false,
  sessionError: null as string | null,
  addresses: [] as unknown[],
  selectedAddressId: null as string | null,
  fulfillmentOptions: {} as Record<string, Array<'shipping' | 'pickup'>>,
  fulfillmentEffective: {} as Record<string, 'shipping' | 'pickup'>,
  requiresDeliveryAddress: true,
  hasFulfillmentConflict: false,
  orderCount: 1,
}));

const cartActions = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  setFulfillmentChoice: vi.fn(),
}));

const listing = {
  id: 'seller:boots',
  listing_id: 'boots',
  record: {
    ownerPubky: 's'.repeat(52),
    listingId: 'boots',
    title: 'Vintage boots',
    media: [],
    variants: [{ id: 'variant_42', options: { size: '42' }, quantity: 3 }],
    sale: { format: 'fixed_price', unitPrice: { amountMinor: 1200, currency: 'USD', exponent: 2 } },
  },
};

const secondSellerListing = {
  ...listing,
  id: 'other:camera',
  listing_id: 'camera',
  record: {
    ...listing.record,
    ownerPubky: 'o'.repeat(52),
    listingId: 'camera',
    title: 'Rangefinder camera',
    variants: [{ id: 'variant_01', options: {}, quantity: 2 }],
    sale: { format: 'fixed_price', unitPrice: { amountMinor: 15000, currency: 'BTC', exponent: 8 } },
  },
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/cart',
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

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
      const items = view.items as Array<{
        listingId: string;
        quantity: number;
        variantId: string;
        listing: {
          record: {
            variants: Array<{ id: string; priceOverride?: { amountMinor: number; currency: string; exponent: number } }>;
            sale: { format: string; unitPrice?: { amountMinor: number; currency: string; exponent: number } };
          };
        };
      }>;
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
        update: cartActions.update,
        remove: cartActions.remove,
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout', async () => {
  const { useForm } = await import('react-hook-form');
  const { zodResolver } = await import('@hookform/resolvers/zod');
  const { marketplaceCheckoutDefaults, marketplaceCheckoutSchema } = await import(
    '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types'
  );
  return {
    useMarketplaceCheckout: () => ({
      form: useForm({
        resolver: zodResolver(marketplaceCheckoutSchema),
        defaultValues: marketplaceCheckoutDefaults,
        mode: 'onTouched',
      }),
      submit: vi.fn(async () => false),
      needsSession: view.needsSession,
      sessionError: view.sessionError,
      hasMarketplaceSession: view.hasMarketplaceSession,
      addresses: view.addresses,
      selectedAddressId: view.selectedAddressId,
      selectAddress: vi.fn(),
      fulfillmentOptionsForSeller: (sellerPubky: string) => view.fulfillmentOptions[sellerPubky] ?? ['shipping'],
      fulfillmentForSeller: (sellerPubky: string) => view.fulfillmentEffective[sellerPubky] ?? 'shipping',
      setFulfillmentChoice: cartActions.setFulfillmentChoice,
      requiresDeliveryAddress: view.requiresDeliveryAddress,
      hasFulfillmentConflict: view.hasFulfillmentConflict,
      orderCount: view.orderCount,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel?: string }) => (
    <button type="button">{triggerLabel ?? 'Approve in Pubky Ring'}</button>
  ),
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string, options?: { includeReputation?: boolean }) => ({
    shop: null,
    reputation: options?.includeReputation === false ? { status: 'unavailable' } : { status: 'new_seller' },
    displayName: sellerPubky === listing.record.ownerPubky ? 'Satoshi Vintage' : 'Film Camera Supply',
  }),
}));

function seededCart() {
  view.items = [
    {
      id: 'seller:boots:variant_42',
      listingId: listing.id,
      variantId: 'variant_42',
      quantity: 1,
      listing,
    },
  ];
  view.isLoading = false;
}

async function fillValidDelivery(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Recipient'), 'Alice Buyer');
  await user.type(screen.getByLabelText('Address line 1'), '1 Market Street');
  await user.type(screen.getByLabelText('City'), 'New York');
  await user.type(screen.getByLabelText('Region'), 'NY');
  await user.type(screen.getByLabelText('Postal code'), '10001');
}

describe('MarketplaceCart', () => {
  beforeEach(() => {
    cartActions.update.mockReset();
    cartActions.remove.mockReset();
    cartActions.setFulfillmentChoice.mockReset();
    view.items = [];
    view.isLoading = false;
    view.adapterMode = 'sandbox';
    view.deployEnv = 'production';
    view.hasMarketplaceSession = false;
    view.needsSession = false;
    view.sessionError = null;
    view.addresses = [];
    view.selectedAddressId = null;
    view.fulfillmentOptions = {};
    view.fulfillmentEffective = {};
    view.requiresDeliveryAddress = true;
    view.hasFulfillmentConflict = false;
    view.orderCount = 1;
  });

  it('disables Place order without a marketplace session in durable mode', () => {
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    render(<MarketplaceCart />);

    expect(screen.getByRole('heading', { name: '1 Approve in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    const placeOrder = screen.getByRole('button', { name: 'Place order' });
    expect(placeOrder).toBeDisabled();
    expect(placeOrder).toHaveAttribute('aria-describedby', 'place-order-reason');
    expect(screen.getByText('Approve purchases in Pubky Ring before placing the order.')).toHaveAttribute(
      'id',
      'place-order-reason',
    );
    expect(screen.queryByText('Accept the guarantee terms.')).not.toBeInTheDocument();
  });

  it.each(['transaction-service', 'locks-paykit', 'unavailable'] as const)(
    'shows the fail-closed real-money notice in %s mode and the interim address copy',
    (adapterMode) => {
      seededCart();
      view.adapterMode = adapterMode;
      view.hasMarketplaceSession = true;

      render(<MarketplaceCart />);

      expect(screen.getAllByRole('note')).toHaveLength(1);
      expect(screen.getByRole('note')).toHaveTextContent(
        'Real money. Payments are final and go directly to the seller.',
      );
      expect(
        screen.getByText(/Your delivery address is sent with your order/),
      ).toBeInTheDocument();
    },
  );

  it('fails closed to the real-money notice for an unknown deploy environment', () => {
    seededCart();
    view.adapterMode = 'sandbox';
    view.deployEnv = undefined;

    render(<MarketplaceCart />);

    expect(screen.getByRole('note')).toHaveTextContent('Real money. Payments are final and go directly to the seller.');
    expect(screen.queryByText(/Staging environment/)).not.toBeInTheDocument();
  });

  it('shows the staging notice regardless of adapter mode', () => {
    seededCart();
    view.adapterMode = 'sandbox';
    view.deployEnv = 'staging';

    render(<MarketplaceCart />);

    expect(screen.getByRole('note')).toHaveTextContent('Staging environment — test rails, no real funds move');
    expect(screen.queryByText('Real money. Payments are final and go directly to the seller.')).not.toBeInTheDocument();
  });

  it.each([false, true])('renders truthful address copy exactly once with saved addresses=%s', (hasSavedAddress) => {
    seededCart();
    view.addresses = hasSavedAddress
      ? [{ id: 'home', label: 'Home', city: 'New York', is_default: true }]
      : [];

    render(<MarketplaceCart />);

    expect(screen.getAllByText(/Your delivery address is sent with your order/)).toHaveLength(1);
    expect(screen.queryByText(/not sent/)).not.toBeInTheDocument();
  });

  it('enables Place order after session plus a valid form', async () => {
    const user = userEvent.setup();
    seededCart();
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;

    render(<MarketplaceCart />);

    expect(screen.getByText(/Purchases approved in Pubky Ring/)).toBeInTheDocument();
    const placeOrder = screen.getByRole('button', { name: 'Place order' });
    expect(placeOrder).toBeDisabled();

    await fillValidDelivery(user);
    expect(placeOrder).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /I accept guarantee policy v1/ }));
    expect(placeOrder).toBeEnabled();
  });

  it('requires the guarantee after a submit attempt and leaves it unchecked by default', async () => {
    const user = userEvent.setup();
    seededCart();

    render(<MarketplaceCart />);

    const guarantee = screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ });
    expect(guarantee).not.toBeChecked();
    expect(screen.queryByText('Accept the guarantee terms.')).not.toBeInTheDocument();

    await fillValidDelivery(user);
    expect(screen.getByRole('button', { name: 'Place sandbox order' })).toBeDisabled();
    expect(screen.getByText('Fill in delivery details and accept the guarantee to place the order.')).toBeInTheDocument();
  });

  it('re-opens step 1 when a session expires mid-flow', () => {
    seededCart();
    view.adapterMode = 'locks-paykit';
    view.hasMarketplaceSession = true;
    view.needsSession = true;
    view.sessionError = 'Marketplace session required.';

    render(<MarketplaceCart />);

    expect(screen.getByRole('heading', { name: 'Approve purchases in Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();
  });

  it('renders a two-column loading skeleton', () => {
    view.isLoading = true;
    view.items = [];

    render(<MarketplaceCart />);

    const skeleton = screen.getByTestId('marketplace-cart-skeleton');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton.className).toContain('lg:grid-cols-[1fr_420px]');
    expect(within(skeleton).getAllByRole('generic').length).toBeGreaterThan(1);
  });

  it('groups multi-seller cart items by seller with per-asset subtotals', () => {
    seededCart();
    view.items = [
      ...(view.items as unknown[]),
      {
        id: 'other:camera:variant_01',
        listingId: secondSellerListing.id,
        variantId: 'variant_01',
        quantity: 2,
        listing: secondSellerListing,
      },
    ];

    render(<MarketplaceCart />);

    expect(screen.getByText('Each seller ships separately; shipping is calculated at checkout.')).toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.getByText('Film Camera Supply')).toBeInTheDocument();
    expect(screen.getAllByText('Seller subtotal')).toHaveLength(2);
    expect(screen.getAllByText('$12.00')).not.toHaveLength(0);
    expect(screen.getAllByText('₿30,000')).toHaveLength(3);
  });

  it('does not render a seller header for a single-seller cart', () => {
    seededCart();

    render(<MarketplaceCart />);

    expect(screen.getByText('Each seller ships separately; shipping is calculated at checkout.')).toBeInTheDocument();
    expect(screen.queryByText('Satoshi Vintage')).not.toBeInTheDocument();
    expect(screen.queryByText('Seller subtotal')).not.toBeInTheDocument();
    expect(screen.getByText('Vintage boots')).toBeInTheDocument();
  });

  it('keeps remove and quantity actions scoped to the cart line', async () => {
    const user = userEvent.setup();
    seededCart();

    render(<MarketplaceCart />);

    await user.click(screen.getByRole('button', { name: 'Increase Vintage boots quantity' }));
    expect(cartActions.update).toHaveBeenCalledWith(listing.id, 'variant_42', 2);

    await user.click(screen.getByRole('button', { name: 'Remove Vintage boots' }));
    expect(cartActions.remove).toHaveBeenCalledWith(listing.id, 'variant_42');
  });
});

describe('MarketplaceCart local pickup (Wave 7, §A2)', () => {
  beforeEach(() => {
    cartActions.update.mockReset();
    cartActions.remove.mockReset();
    cartActions.setFulfillmentChoice.mockReset();
    view.items = [];
    view.isLoading = false;
    view.adapterMode = 'sandbox';
    view.hasMarketplaceSession = false;
    view.needsSession = false;
    view.sessionError = null;
    view.addresses = [];
    view.selectedAddressId = null;
    view.fulfillmentOptions = {};
    view.fulfillmentEffective = {};
    view.requiresDeliveryAddress = true;
    view.hasFulfillmentConflict = false;
    view.orderCount = 1;
  });

  it('offers the fulfillment choice only when every line in the group publishes both', async () => {
    const user = userEvent.setup();
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: ['shipping', 'pickup'] };

    render(<MarketplaceCart />);

    const select = screen.getByLabelText(`Fulfillment for items from ${listing.record.ownerPubky}`);
    expect(select).toHaveTextContent('Ship it');
    await user.click(select);
    await user.click(screen.getByRole('option', { name: 'Local pickup' }));
    expect(cartActions.setFulfillmentChoice).toHaveBeenCalledWith(listing.record.ownerPubky, 'pickup');
  });

  it('renders a pickup group with no shipping line and the reveal note', () => {
    seededCart();
    view.fulfillmentEffective = { [listing.record.ownerPubky]: 'pickup' };
    view.requiresDeliveryAddress = false;

    render(<MarketplaceCart />);

    const group = screen.getByRole('region', { name: `Cart items from ${listing.record.ownerPubky}` });
    expect(group).toHaveAttribute('data-surface', 'cart-pickup-group');
    expect(
      within(group).getByText(/Local pickup — no delivery address or shipping for these items/),
    ).toBeInTheDocument();
  });

  it('hides the per-seller shipping note on a pickup-only cart', () => {
    seededCart();
    view.fulfillmentEffective = { [listing.record.ownerPubky]: 'pickup' };
    view.requiresDeliveryAddress = false;

    render(<MarketplaceCart />);

    expect(
      screen.queryByText('Each seller ships separately; shipping is calculated at checkout.'),
    ).not.toBeInTheDocument();
  });

  it('hides the delivery-address step on a pickup-only checkout and says why', () => {
    seededCart();
    view.fulfillmentEffective = { [listing.record.ownerPubky]: 'pickup' };
    view.requiresDeliveryAddress = false;

    render(<MarketplaceCart />);

    expect(screen.queryByLabelText('Recipient')).not.toBeInTheDocument();
    expect(screen.getByText(/No delivery address is needed/)).toBeInTheDocument();
    expect(screen.getByText('No shipping — pickup is arranged with the seller after payment.')).toBeInTheDocument();
    // The guarantee step stays — it is not address-bearing.
    expect(screen.getByRole('checkbox', { name: /I accept sandbox guarantee policy v1/ })).toBeInTheDocument();
  });

  it('states the (seller, fulfillment) split plainly before submit', () => {
    view.items = [
      { id: 'seller:boots:variant_42', listingId: listing.id, variantId: 'variant_42', quantity: 1, listing },
      {
        id: 'other:camera:variant_01',
        listingId: secondSellerListing.id,
        variantId: 'variant_01',
        quantity: 1,
        listing: secondSellerListing,
      },
    ];
    view.orderCount = 2;

    render(<MarketplaceCart />);

    expect(screen.getByText('This places 2 orders — one per seller and delivery method.')).toBeInTheDocument();
  });

  it('blocks the order and explains when a group has no common fulfillment', () => {
    seededCart();
    view.fulfillmentOptions = { [listing.record.ownerPubky]: [] };
    view.fulfillmentEffective = {};
    view.hasFulfillmentConflict = true;

    render(<MarketplaceCart />);

    expect(screen.getByRole('alert')).toHaveTextContent(/can't be checked out together/);
    expect(screen.getByRole('button', { name: 'Place sandbox order' })).toBeDisabled();
    expect(
      screen.getByText("Some items can't be checked out together — see the note in your cart."),
    ).toHaveAttribute('id', 'place-order-reason');
  });
});
