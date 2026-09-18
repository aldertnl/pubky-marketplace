// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplacePaymentStatusCard } from '@/organisms/Marketplace/MarketplacePaymentStatusCard';

/**
 * Every buyer-visible payment state of the truthful status card (plan task
 * 4.6), rendered for baselines (task 4.8):
 *
 * - `locks-paykit` mode: awaiting (start / registered / poll-bound reached),
 *   confirmed with the digital delivery view (locked and unlocked), expired,
 *   and manual review. Detection and confirmation counts are deliberately
 *   absent from every one of these — the upstream contract keeps them
 *   internal.
 * - sandbox mode: the simulate affordances and the finer-grained simulated
 *   `detected` state, which may exist ONLY under the visible sandbox label —
 *   the label is part of these baselines on purpose.
 */

const fixtures = vi.hoisted(async () => {
  const { createOrderFixture, createPaymentFixture, ORDER_FIXTURE_BUYER } =
    await import('@/test/fixtures/commerce/orders');
  return { createOrderFixture, createPaymentFixture, buyer: ORDER_FIXTURE_BUYER };
});

const view = vi.hoisted(() => ({
  deployEnv: 'production' as 'production' | 'staging' | undefined,
  locks: {
    enabled: true,
    correlation: null as unknown,
    isStarting: false,
    isUnlocking: false,
    delivery: null as unknown,
    error: null as string | null,
    pollExhausted: false,
  },
  sellerConfig: {
    bitcoinAvailable: true,
    bitcoinOfferAvailable: true,
    stripePaymentLink: 'https://buy.stripe.com/test_fixture' as string | null,
    paypalMerchantEmail: 'seller@example.com' as string | null,
  },
}));

vi.mock('@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment', () => ({
  useMarketplaceLocksPayment: () => ({
    ...view.locks,
    start: vi.fn(async () => false),
    unlock: vi.fn(async () => false),
    resumePolling: vi.fn(),
  }),
}));

// The money notice is gated on the deploy environment. Each scene names its
// environment: locks-paykit scenes run on production (real rails — the
// real-money notice is truthful there); transaction-service scenes run on
// staging (test rails — no real funds move). Sandbox scenes render no notice.
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => view.deployEnv };
});

vi.mock('@/controllers/commerce/commerce', async () => {
  const { ORDER_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/orders');
  return {
    CommerceController: {
      getOrFetchListing: vi.fn(async () => ({
        digitalLock: {
          policyUri: `pubky://${ORDER_FIXTURE_SELLER}/pub/locks.app/${'0'.repeat(52)}.json`,
          criterionId: 'criterion-1',
          contentPath: 'field_recordings/archive.zip',
          resourceHash: 'a'.repeat(64),
          minimumConfirmations: 1,
        },
      })),
      getSellerPaymentConfig: vi.fn(async () => view.sellerConfig),
      bindPaymentMethod: vi.fn(async () => ({})),
      verifyStripePayment: vi.fn(async () => ({ verified: false, order: null })),
      markFiatPaid: vi.fn(async () => ({})),
      confirmFiatReceived: vi.fn(async () => ({})),
    },
  };
});

function makeCorrelation(registered: boolean) {
  return {
    id: 'fixture-correlation',
    owner_id: 'b'.repeat(52),
    payment_id: '018f47d2-6a27-7c23-a49d-000000000301',
    order_id: '018f47d2-6a27-7c23-a49d-000000000001',
    seller_pubky: 's'.repeat(52),
    bundle_id: '000G40R40M30E209185GR38E1W',
    policy_uri: `pubky://${'s'.repeat(52)}/pub/locks.app/${'0'.repeat(52)}.json`,
    criterion_id: 'criterion-1',
    content_path: 'field_recordings/archive.zip',
    resource_hash: 'a'.repeat(64),
    window_expires_at: '2026-08-20T21:00:00.000Z',
    registered,
    created_at: 1,
    updated_at: 1,
  };
}

function Harness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

async function renderCard(
  paymentState: 'awaiting_entitlement' | 'detected' | 'confirmed' | 'expired' | 'manual_review',
  adapterMode: 'sandbox' | 'transaction-service' | 'locks-paykit',
  options: {
    adapter?: 'sandbox' | 'locks';
    orderState?: 'pending_payment' | 'paid';
    orderOverrides?: Record<string, unknown>;
    isBuyer?: boolean;
    viewport?: object;
    deployEnv?: 'production' | 'staging';
  } = {},
) {
  const { createOrderFixture, createPaymentFixture } = await fixtures;
  view.deployEnv = options.deployEnv ?? 'production';
  const payment = createPaymentFixture(paymentState, {
    adapter: options.adapter ?? 'sandbox',
    locksBundleId: undefined,
  });
  const order = createOrderFixture(options.orderState ?? (paymentState === 'confirmed' ? 'paid' : 'pending_payment'), {
    paymentId: payment.id,
    ...(options.orderOverrides ?? {}),
  });
  return await renderForVRT(
    <Harness>
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer={options.isBuyer ?? true}
        adapterMode={adapterMode}
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />
    </Harness>,
    { viewport: (options.viewport as never) ?? VRT_VIEWPORT_DESKTOP },
  );
}

describe('Marketplace payment status card — visual regression', () => {
  it('renders awaiting entitlement with the wallet payment request action (locks-paykit) at desktop viewport', async () => {
    view.locks = { ...view.locks, correlation: null, delivery: null, error: null, pollExhausted: false };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'sandbox' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-start-desktop');
  });

  it('renders awaiting entitlement with the wallet payment request action at mobile viewport', async () => {
    view.locks = { ...view.locks, correlation: null, delivery: null, error: null, pollExhausted: false };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', {
      adapter: 'sandbox',
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-start-mobile');
  });

  it('renders a registered payment request awaiting server-side verification at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-awaiting-registered-desktop');
  });

  it('renders the bounded-poll limit with its explicit resume action at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: true,
    };
    const screen = await renderCard('awaiting_entitlement', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-poll-exhausted-desktop');
  });

  it('renders a confirmed payment with the locked digital delivery at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('confirmed', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-confirmed-locked-desktop');
  });

  it('renders the unlocked digital delivery with its verified file at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: { objectUrl: 'blob:vrt-fixture', fileName: 'archive.zip', byteSize: 48_213 },
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('confirmed', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-delivery-unlocked-desktop');
  });

  it('renders the marketplace-expired state at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('expired', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-expired-desktop');
  });

  it('renders the manual-review state at desktop viewport', async () => {
    view.locks = {
      ...view.locks,
      correlation: makeCorrelation(true),
      delivery: null,
      error: null,
      pollExhausted: false,
    };
    const screen = await renderCard('manual_review', 'locks-paykit', { adapter: 'locks' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-manual-review-desktop');
  });

  it('renders the payment method picker with the seller-configured rails at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', { deployEnv: 'staging' });
    await expect.element(screen.getByText('₿ Bitcoin')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-picker-desktop');
    view.locks.enabled = true;
  });

  it('renders the honest empty state when the seller configured no payment methods', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const previous = view.sellerConfig;
    view.sellerConfig = {
      bitcoinAvailable: false,
      bitcoinOfferAvailable: true,
      stripePaymentLink: null,
      paypalMerchantEmail: null,
    };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', { deployEnv: 'staging' });
    await expect.element(screen.getByText(/has not set up any payment methods/)).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-none-desktop');
    view.sellerConfig = previous;
    view.locks.enabled = true;
  });

  it('renders the bound bitcoin wait state at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: { paymentMethod: 'bitcoin', paykitRequestState: 'pending' },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-bitcoin-desktop');
    view.locks.enabled = true;
  });

  it('renders the bound stripe checkout and verify affordances at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'stripe',
        fiatCheckoutUrl: 'https://buy.stripe.com/test_fixture?client_reference_id=order-1',
        fiatVerification: 'processor',
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-stripe-desktop');
    view.locks.enabled = true;
  });

  it('renders the buyer paypal report affordances at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-paypal-desktop');
    view.locks.enabled = true;
  });

  it('renders the buyer paypal reported state at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
        paymentReportedAt: '2026-08-22T12:00:00.000Z',
        fiatTransactionRef: '7AB12345CD678901E',
      },
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'payment-status-method-paypal-reported-desktop',
    );
    view.locks.enabled = true;
  });

  it('renders the seller paypal receipt confirmation at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'transaction-service', {
      deployEnv: 'staging',
      isBuyer: false,
      orderOverrides: {
        paymentMethod: 'paypal',
        fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
        fiatVerification: 'seller-attested',
        paymentReportedAt: '2026-08-22T12:00:00.000Z',
        fiatTransactionRef: '7AB12345CD678901E',
      },
    });
    await expect.element(screen.getByText('Confirm payment received')).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-method-paypal-confirm-desktop');
    view.locks.enabled = true;
  });

  it('renders the sandbox simulate affordances under the visible sandbox label at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('awaiting_entitlement', 'sandbox');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-sandbox-awaiting-desktop');
    view.locks.enabled = true;
  });

  it('renders the simulated detected state, which exists only under the sandbox label, at desktop viewport', async () => {
    view.locks = { ...view.locks, enabled: false, correlation: null, delivery: null, error: null };
    const screen = await renderCard('detected', 'sandbox');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('payment-status-sandbox-detected-desktop');
    view.locks.enabled = true;
  });
});
