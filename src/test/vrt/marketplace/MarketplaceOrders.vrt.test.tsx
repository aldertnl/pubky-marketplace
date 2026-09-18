// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceOrders } from '@/templates/Marketplace/MarketplaceOrders';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Covers every order state and every buyer-visible payment state defined by the
// transaction contract, so a state that only appears after a timeout, a return, or
// a reconciliation still has a reviewable rendering.
const fixtures = vi.hoisted(async () => {
  const {
    createOrderFixture,
    createOrderViewsForEveryState,
    createOrderViewsForEveryPaymentState,
    createPaymentFixture,
    ORDER_FIXTURE_BUYER,
    ORDER_FIXTURE_SELLER,
  } = await import('@/test/fixtures/commerce/orders');
  const { VRT_FROZEN_NOW_MS, HOUR_MS } = await import('@/test-utils/vrt.clock');
  const sellerNeedsAttention = [
    createOrderFixture('pending_payment', {
      id: '018f47d2-6a27-7c23-a49d-000000000701',
      buyerPubky: 'n'.repeat(52),
      sellerPubky: ORDER_FIXTURE_BUYER,
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_camera`,
          listingRevision: 1,
          contentHash: 'b'.repeat(64),
          title: 'Program-mode 35mm SLR',
          quantity: 1,
          unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
    }),
    createOrderFixture('return_requested', {
      id: '018f47d2-6a27-7c23-a49d-000000000702',
      buyerPubky: 'r'.repeat(52),
      sellerPubky: ORDER_FIXTURE_BUYER,
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_boots`,
          listingRevision: 2,
          contentHash: 'c'.repeat(64),
          title: 'Handmade leather boots',
          quantity: 1,
          unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        },
      ],
    }),
  ].map((order) => ({
    order,
    payment: createPaymentFixture(order.state === 'pending_payment' ? 'awaiting_entitlement' : 'confirmed', {
      id: order.paymentId,
      orderId: order.id,
    }),
    receipt: null,
  }));

  // A completed order the buyer already reviewed; the review's age relative
  // to the frozen clock decides whether the durable-only 24h edit window is
  // still open when the screenshot is taken.
  const reviewedOrderView = (reviewAgeHours: number) => {
    const order = createOrderFixture('completed', {
      reviews: [
        {
          id: '018f47d2-6a27-7c23-a62f-000000000601',
          reviewerPubky: ORDER_FIXTURE_BUYER,
          subjectPubky: ORDER_FIXTURE_SELLER,
          rating: 5,
          text: 'Accurate and fast.',
          createdAt: new Date(VRT_FROZEN_NOW_MS - reviewAgeHours * HOUR_MS).toISOString(),
        },
      ],
    });
    return { order, payment: createPaymentFixture('confirmed'), receipt: null };
  };

  // A shipped order whose carrier the curated registry resolves (USPS), so
  // the buyer's "Track package" link renders next to the tracking facts. The
  // every-state fixtures keep the unknown carrier ("Local Courier"), whose
  // shipment line stays plain text with no link — both fallbacks get a
  // baseline.
  const trackableShippedView = () => ({
    order: createOrderFixture('shipped', {
      shipment: {
        carrier: 'USPS',
        trackingNumber: '9400111899223197428490',
        state: 'shipped' as const,
        shippedAt: '2026-08-14T10:00:00.000Z',
        deliveredAt: null,
      },
    }),
    payment: createPaymentFixture('confirmed'),
    receipt: null,
  });

  const deliveryAssumedView = () => ({
    order: createOrderFixture('delivered', {
      id: '018f47d2-6a27-7c23-a49d-000000000703',
      deliveryAssumed: true,
      nextActor: 'none',
    }),
    payment: createPaymentFixture('confirmed'),
    receipt: null,
  });

  const sellerAwaitingPayment = [
    'awaiting_entitlement',
    'detected',
    'confirmed',
    'manual_review',
    'awaiting_entitlement',
  ] as const;
  const sellerAwaitingPaymentViews = sellerAwaitingPayment.map((paymentState, index) => {
    const payment = createPaymentFixture(paymentState, {
      id: `018f47d2-6a27-7c23-a49d-0000000007${10 + index}`,
    });
    const order = createOrderFixture('pending_payment', {
      id: `018f47d2-6a27-7c23-a49d-0000000007${20 + index}`,
      paymentId: payment.id,
      buyerPubky: index === 4 ? ORDER_FIXTURE_BUYER : 's'.repeat(52),
      sellerPubky: index === 4 ? ORDER_FIXTURE_SELLER : ORDER_FIXTURE_BUYER,
      nextActor: index === 4 ? 'none' : 'buyer',
      lines: [
        {
          listingAggregateId: `listing:${ORDER_FIXTURE_BUYER}_awaiting_${index}`,
          listingRevision: 1,
          contentHash: `${index}`.repeat(64),
          title: [
            'Seller awaiting entitlement',
            'Seller detected payment',
            'Seller confirmed payment',
            'Seller manual review',
            'Buyer awaiting payment',
          ][index],
          quantity: 1,
          unitPrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
          subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      ],
      subtotal: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      total: { amountMinor: 16_200, currency: 'USD', exponent: 2 },
    });
    return { order, payment, receipt: null };
  });

  return {
    buyer: ORDER_FIXTURE_BUYER,
    everyOrderState: createOrderViewsForEveryState(),
    everyPaymentState: createOrderViewsForEveryPaymentState(),
    sellerNeedsAttention,
    reviewedInWindow: [reviewedOrderView(23)],
    reviewedOutOfWindow: [reviewedOrderView(25)],
    trackableShipped: [trackableShippedView()],
    deliveryAssumed: [deliveryAssumedView()],
    sellerAwaitingPayment: sellerAwaitingPaymentViews,
  };
});

const ordersState = vi.hoisted(() => ({
  orders: [] as unknown[],
  isLoading: false,
  error: null as string | null,
  adapterMode: 'sandbox' as string,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/orders',
}));

vi.mock('@/stores/auth/auth.store', async () => {
  const { buyer } = await fixtures;
  return {
    useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: buyer }),
  };
});

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: ordersState.orders,
    isLoading: ordersState.isLoading,
    error: ordersState.error,
    adapterMode: ordersState.adapterMode,
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
});

describe('Marketplace orders — visual regression', () => {
  it('renders every order state at desktop viewport', async () => {
    const { everyOrderState } = await fixtures;
    ordersState.orders = everyOrderState;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-every-state-desktop');
  });

  it('renders every order state at mobile viewport', async () => {
    const { everyOrderState } = await fixtures;
    ordersState.orders = everyOrderState;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-every-state-mobile');
  });

  it('renders seller orders that need attention at desktop viewport', async () => {
    const { sellerNeedsAttention } = await fixtures;
    ordersState.orders = sellerNeedsAttention;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-needs-attention-desktop');
  });

  it('renders a shipped order with a carrier tracking link at desktop viewport', async () => {
    const { trackableShipped } = await fixtures;
    ordersState.orders = trackableShipped;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-shipped-track-link-desktop');
  });

  it('renders an assumed-delivery order at desktop viewport', async () => {
    const { deliveryAssumed } = await fixtures;
    ordersState.orders = deliveryAssumed;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-delivery-assumed-desktop');
  });

  it('renders every buyer-visible payment state at desktop viewport', async () => {
    const { everyPaymentState } = await fixtures;
    ordersState.orders = everyPaymentState;
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-payment-states-desktop');
  });

  it('renders the active seller Awaiting payment tab at desktop viewport', async () => {
    const { sellerAwaitingPayment } = await fixtures;
    ordersState.orders = sellerAwaitingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('tab', { name: /Awaiting payment 2/i }).click();
    (screen.container.querySelector('[role="tablist"]') as HTMLElement).scrollLeft = 0;
    await expect(screen.getByRole('tab', { name: /Awaiting payment 2/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Seller awaiting entitlement')).toBeInTheDocument();
    expect(screen.getByText('Seller detected payment')).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain('Seller confirmed payment');
    expect(screen.container.textContent).not.toContain('Buyer awaiting payment');
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-awaiting-payment-seller-desktop');
  });

  it('renders the active seller Awaiting payment tab at mobile viewport', async () => {
    const { sellerAwaitingPayment } = await fixtures;
    ordersState.orders = sellerAwaitingPayment;
    ordersState.isLoading = false;
    ordersState.error = null;

    const screen = await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_MOBILE });
    await screen.getByRole('tab', { name: /Awaiting payment 2/i }).click();
    (screen.container.querySelector('[role="tablist"]') as HTMLElement).scrollLeft = 0;
    await expect(screen.getByRole('tab', { name: /Awaiting payment 2/i })).toHaveAttribute('aria-selected', 'true');
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-awaiting-payment-seller-mobile');
  });

  it('rejects an incorrect production surface marker', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    expect(() => expectVrtSurface('wrong-marketplace-orders')).toThrow(/no production \[data-surface/);
  });

  it('renders the loading state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = true;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-loading-desktop');
  });

  it('renders the empty state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-empty-desktop');
  });

  it('renders the error state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = 'Transaction service is unavailable.';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-error-desktop');
  });

  // Durable transaction-service mode: no simulate-payment buttons, no cancel
  // affordances (unported command), and the honest awaiting-payment note.
  it('renders durable-mode payment states without simulate affordances at desktop viewport', async () => {
    const { everyPaymentState } = await fixtures;
    ordersState.orders = everyPaymentState;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-durable-payment-states-desktop');
    ordersState.adapterMode = 'sandbox';
  });

  // `review.update` is durable-only with a 24-hour window from the review's
  // creation: inside the window the reviewer gets an Edit review affordance;
  // once the window closes the affordance is absent instead of failing on
  // submit.
  it('offers review editing inside the 24-hour window in transaction-service mode at desktop viewport', async () => {
    const { reviewedInWindow } = await fixtures;
    ordersState.orders = reviewedInWindow;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-review-edit-in-window-desktop');
    ordersState.adapterMode = 'sandbox';
  });

  it('withholds review editing once the 24-hour window has closed at desktop viewport', async () => {
    const { reviewedOutOfWindow } = await fixtures;
    ordersState.orders = reviewedOutOfWindow;
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'transaction-service';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-review-edit-out-of-window-desktop');
    ordersState.adapterMode = 'sandbox';
  });

  it('renders the no-backend state at desktop viewport', async () => {
    ordersState.orders = [];
    ordersState.isLoading = false;
    ordersState.error = null;
    ordersState.adapterMode = 'unavailable';

    await renderForVRT(<MarketplaceOrders />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(expectVrtSurface('marketplace-orders')).toMatchScreenshot('orders-no-backend-desktop');
    ordersState.adapterMode = 'sandbox';
  });
});
