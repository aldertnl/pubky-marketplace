import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketplaceOrderPayment } from '@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment';
import { createOrderFixture, createPaymentFixture } from '@/test/fixtures/commerce/orders';
import { MarketplacePaymentStatusCard } from './MarketplacePaymentStatusCard';

const runtime = vi.hoisted(() => ({ deployEnv: 'production' as 'production' | 'staging' | undefined }));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => runtime.deployEnv };
});

vi.mock('@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment', () => ({
  useMarketplaceLocksPayment: () => ({
    enabled: false,
    correlation: null,
    isStarting: false,
    isUnlocking: false,
    delivery: null,
    error: null,
    pollExhausted: false,
    start: vi.fn(),
    unlock: vi.fn(),
    resumePolling: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment', () => ({
  useMarketplaceOrderPayment: vi.fn(() => ({
    availableMethods: null,
    bitcoinOfferUnavailable: false,
    configError: null,
    pendingAction: null,
    bind: vi.fn(),
    verifyStripe: vi.fn(),
    markPaid: vi.fn(),
    confirmReceived: vi.fn(),
  })),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: vi.fn(async () => ({ digitalLock: null })),
  },
}));

describe('MarketplacePaymentStatusCard', () => {
  beforeEach(() => {
    runtime.deployEnv = 'production';
  });

  it.each(['transaction-service', 'locks-paykit', 'unavailable'] as const)(
    'shows the non-dismissible real-money notice in %s mode',
    (adapterMode) => {
      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture('pending_payment')}
          payment={createPaymentFixture('awaiting_entitlement')}
          isBuyer
          adapterMode={adapterMode}
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );

      const notice = screen.getByRole('note');
      expect(notice).toHaveTextContent('Real money. Payments are final and go directly to the seller.');
      expect(notice.querySelector('button')).not.toBeInTheDocument();
    },
  );

  it('shows the staging notice instead of the real-money notice on a staging deploy', () => {
    runtime.deployEnv = 'staging';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('Staging environment — test rails, no real funds move');
    expect(screen.queryByText(/Real money/)).not.toBeInTheDocument();
  });

  it('fails closed to the real-money notice for an unknown deploy environment', () => {
    runtime.deployEnv = undefined;
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('Real money. Payments are final and go directly to the seller.');
  });

  it('shows the sandbox badge without any payment notice, even on a staging deploy', () => {
    runtime.deployEnv = 'staging';
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="sandbox"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText('Sandbox · simulated payment · no real funds')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('does not show the payment notice for sellers or terminal orders', () => {
    const payment = createPaymentFixture('awaiting_entitlement');
    const seller = render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment', { paymentId: payment.id })}
        payment={payment}
        isBuyer={false}
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(seller.queryByRole('note')).not.toBeInTheDocument();

    seller.unmount();
    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('completed', { paymentId: payment.id })}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('explains that PayPal buyer self-reporting does not confirm marketplace payment', () => {
    const payment = createPaymentFixture('awaiting_entitlement');
    const order = createOrderFixture('pending_payment', {
      paymentId: payment.id,
      paymentMethod: 'paypal',
      fiatCheckoutUrl: 'https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=seller%40example.com',
      fiatVerification: 'seller-attested',
    });

    render(
      <MarketplacePaymentStatusCard
        order={order}
        payment={payment}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText(/Use this only if automatic confirmation fails/i)).toBeInTheDocument();
    expect(screen.getByText(/seller must verify your PayPal transaction ID before shipping/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /I.ve paid/ })).toBeInTheDocument();
  });

  it('explains when Bitcoin is temporarily unavailable while other methods remain available', () => {
    vi.mocked(useMarketplaceOrderPayment).mockReturnValueOnce({
      availableMethods: ['stripe'],
      bitcoinOfferUnavailable: true,
      configError: null,
      pendingAction: null,
      bind: vi.fn(),
      verifyStripe: vi.fn(),
      markPaid: vi.fn(),
      confirmReceived: vi.fn(),
    });

    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('pending_payment')}
        payment={createPaymentFixture('awaiting_entitlement')}
        isBuyer
        adapterMode="transaction-service"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(
      screen.getByText('Bitcoin is temporarily unavailable. Other payment methods are unaffected.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Card \(Stripe\)/ })).toBeInTheDocument();
  });

  it.each(['cancelled', 'refunded_external', 'closed', 'completed'] as const)(
    'does not show payment instructions for terminal %s orders',
    (state) => {
      const payment = createPaymentFixture('awaiting_entitlement');

      render(
        <MarketplacePaymentStatusCard
          order={createOrderFixture(state, { paymentId: payment.id })}
          payment={payment}
          isBuyer
          adapterMode="transaction-service"
          advancePayment={async () => false}
          onPaymentChanged={() => {}}
        />,
      );

      expect(screen.queryByText('Awaiting payment')).not.toBeInTheDocument();
      expect(screen.queryByText(/seller has not set up any payment methods/i)).not.toBeInTheDocument();
    },
  );

  it('keeps confirmed Locks delivery visible after order completion', () => {
    const payment = createPaymentFixture('confirmed', { adapter: 'locks' });

    render(
      <MarketplacePaymentStatusCard
        order={createOrderFixture('completed', { paymentId: payment.id })}
        payment={payment}
        isBuyer
        adapterMode="locks-paykit"
        advancePayment={async () => false}
        onPaymentChanged={() => {}}
      />,
    );

    expect(screen.getByText('Payment confirmed')).toBeInTheDocument();
  });
});
