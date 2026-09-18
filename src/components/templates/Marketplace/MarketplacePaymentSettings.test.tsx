import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { MarketplacePaymentSettings } from './MarketplacePaymentSettings';

const view = vi.hoisted(() => ({
  locksConnect: {
    connectedCreator: null as string | null,
    isExchanging: false,
    error: null as string | null,
  },
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getPaykitSetupUrl: vi.fn(() => 'https://paykit.example/setup'),
    getMyPaymentConfig: vi.fn(),
    isOwnPaykitAccountClaimed: vi.fn(),
    putMyPaymentConfig: vi.fn(),
    beginPaykitClaimFlow: vi.fn(),
    beginMarketplaceSessionConnect: vi.fn(),
    createLocksFrontendSession: vi.fn(),
  },
}));

vi.mock('@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect', () => ({
  useMarketplaceLocksConnect: () => ({
    ...view.locksConnect,
    openConnect: vi.fn(),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

const mockedController = vi.mocked(CommerceController);

const EMPTY_CONFIG: SellerPaymentConfigOwnView = {
  bitcoinEnabled: false,
  stripePaymentLink: null,
  paypalMerchantEmail: null,
  stripeRestrictedKeySet: false,
  updatedAt: '2026-08-22T12:00:00.000Z',
};

const PLAUSIBLE_XPUB = `zpub${'r'.repeat(107)}`;

beforeEach(() => {
  view.locksConnect = { connectedCreator: null, isExchanging: false, error: null };
  mockedController.getMyPaymentConfig.mockReset().mockResolvedValue(EMPTY_CONFIG);
  mockedController.isOwnPaykitAccountClaimed.mockReset().mockResolvedValue(false);
  mockedController.putMyPaymentConfig.mockReset().mockImplementation(async (input) => ({
    bitcoinEnabled: input.bitcoinEnabled,
    stripePaymentLink: input.stripePaymentLink,
    paypalMerchantEmail: input.paypalMerchantEmail,
    stripeRestrictedKeySet: Boolean('stripeRestrictedKey' in input && input.stripeRestrictedKey),
    updatedAt: '2026-08-22T12:30:00.000Z',
  }));
  mockedController.beginPaykitClaimFlow.mockReset().mockReturnValue({
    authorizationUrl: 'https://auth.example/claim',
    awaitClaim: () => new Promise<{ creator: string; accountIndex: number }>(() => {}),
    cancel: vi.fn(),
  });
  // A marketplace session makes the stored-rail forms render; the page is the
  // seller's own settings, never a guest surface.
  useCommerceStore.setState({
    marketplaceSession: {
      pubky: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      capabilities: '/pub/pubky.app/:rw',
      issuedAt: '2026-08-21T12:00:00.000Z',
      expiresAt: '2026-09-21T12:00:00.000Z',
    },
  });
});

async function renderSettings() {
  render(<MarketplacePaymentSettings />);
  // Wait until the payment configuration finished loading into the form.
  await screen.findByRole('heading', { name: 'PayPal' });
  await waitFor(() => expect(screen.queryByText('Loading payment settings…')).not.toBeInTheDocument());
}

describe('MarketplacePaymentSettings', () => {
  it('leads with the seller-direct promise', async () => {
    await renderSettings();

    expect(screen.getByRole('heading', { name: 'How you get paid' })).toBeInTheDocument();
    expect(
      screen.getByText('Every method pays the seller directly — this marketplace never holds funds.'),
    ).toBeInTheDocument();
  });

  it('renders the three method cards in buyer-familiar order', async () => {
    await renderSettings();

    const methodsSection = screen.getByRole('region', { name: 'Payment methods' });
    const titles = within(methodsSection)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(['PayPal', 'Card via Stripe', 'Bitcoin wallet']);
  });

  it('derives each status pill from the loaded configuration state', async () => {
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      paypalMerchantEmail: 'seller@example.com',
      // Stripe link without the restricted key cannot verify payments.
      stripePaymentLink: 'https://buy.stripe.com/test_abc',
    });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Email saved');
    expect(screen.getByTestId('payment-method-status-stripe')).toHaveTextContent('Needs attention');
    // Claim without Lock Server authorization is not Connected.
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('button', { name: /Open Locks connect/ })).toBeInTheDocument();
    expect(screen.getByTestId('payment-methods-ready-summary')).toHaveTextContent(
      '1 method is ready to accept payments.',
    );
  });

  it('shows Bitcoin Connected only when Lock Server authorization and the Paykit claim are both present', async () => {
    view.locksConnect = {
      connectedCreator: 'gy1wnkhfwezwdnawnur1bc3kw1x3jf5ggjj3cm37e31i5ntq3pco',
      isExchanging: false,
      error: null,
    };
    mockedController.getMyPaymentConfig.mockResolvedValue({
      ...EMPTY_CONFIG,
      paypalMerchantEmail: 'seller@example.com',
      stripePaymentLink: 'https://buy.stripe.com/test_abc',
      stripeRestrictedKeySet: true,
    });
    mockedController.isOwnPaykitAccountClaimed.mockResolvedValue(true);

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Email saved');
    expect(screen.getByTestId('payment-method-status-stripe')).toHaveTextContent('Connected');
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Connected');
    expect(screen.getByTestId('payment-methods-ready-summary')).toHaveTextContent(
      '3 methods are ready to accept payments.',
    );
  });

  it('shows Not set up on every pill for a new seller', async () => {
    await renderSettings();

    expect(screen.getByTestId('payment-method-status-paypal')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('payment-method-status-stripe')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('payment-methods-ready-summary')).toHaveTextContent(
      'Set up at least one method below to start selling.',
    );
  });

  it('needs attention when the Lock Server connect errored', async () => {
    view.locksConnect = { connectedCreator: null, isExchanging: false, error: 'connect rejected' };

    await renderSettings();

    expect(screen.getByTestId('payment-method-status-bitcoin')).toHaveTextContent('Needs attention');
  });

  it('keeps the bitcoin protocol details collapsed until asked', async () => {
    const user = userEvent.setup();
    await renderSettings();

    const detailsToggle = screen.getByRole('button', { name: 'Technical details' });
    expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/watch-only BIP84 account claim/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Lock Server:/)).not.toBeInTheDocument();

    await user.click(detailsToggle);

    expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/watch-only BIP84 account claim/)).toBeInTheDocument();
    expect(screen.getByText(/account xpub/)).toBeInTheDocument();
    expect(screen.getByText(/^Lock Server:/)).toBeInTheDocument();
  });

  it('saves the Stripe and PayPal rails with the unchanged payload shape', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.type(screen.getByLabelText('PayPal merchant email'), 'seller@example.com');
    await user.type(screen.getByLabelText('Stripe payment link'), 'https://buy.stripe.com/test_abc');
    await user.type(screen.getByLabelText('Stripe restricted key'), 'rk_test_12345678');
    await user.click(screen.getByRole('switch', { name: 'Accept bitcoin' }));

    await user.click(screen.getAllByRole('button', { name: 'Save payment settings' })[0]);

    await waitFor(() => expect(mockedController.putMyPaymentConfig).toHaveBeenCalledTimes(1));
    expect(mockedController.putMyPaymentConfig.mock.calls).toMatchSnapshot();
  });

  it('refuses to send a non-Stripe checkout link to the service', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.type(screen.getByLabelText('Stripe payment link'), 'https://evil.example/checkout');
    await user.click(screen.getAllByRole('button', { name: 'Save payment settings' })[0]);

    // The payload contract is unchanged: invalid input never leaves the browser.
    expect(mockedController.putMyPaymentConfig).not.toHaveBeenCalled();
  });

  it('opens the Bitkit setup through the existing controller call', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await renderSettings();

    await user.click(screen.getByRole('button', { name: /Open Bitkit setup/ }));

    expect(mockedController.getPaykitSetupUrl).toHaveBeenCalledTimes(1);
    expect(mockedController.getPaykitSetupUrl.mock.calls).toMatchSnapshot();
    openSpy.mockRestore();
    uuidSpy.mockRestore();
  });

  it('starts the watch-only claim with the pasted xpub, payload unchanged', async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    await user.type(screen.getByLabelText('Account xpub'), PLAUSIBLE_XPUB);
    await user.click(screen.getByRole('button', { name: 'Claim with signer' }));

    expect(mockedController.beginPaykitClaimFlow).toHaveBeenCalledTimes(1);
    expect(mockedController.beginPaykitClaimFlow.mock.calls).toMatchSnapshot();
  });
});
