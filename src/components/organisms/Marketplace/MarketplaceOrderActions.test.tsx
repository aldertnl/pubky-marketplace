import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_REVIEW_EDIT_WINDOW_SECONDS } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceReviewModelSchema } from '@/models/commerce/commerce.schema';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { createOrderFixture, ORDER_FIXTURE_BUYER } from '@/test/fixtures/commerce/orders';
import { MarketplaceOrderActions } from './MarketplaceOrderActions';

// The component reads two honest projections through the controller: the
// seller's D2 band consent (review dialog) and the local copy of the user's
// own published review record (status line). Both are mocked per scenario.
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceBandConsent: vi.fn(async () => null),
    getOwnMarketplaceReview: vi.fn(async () => null),
    commitMarkReady: vi.fn(async () => ({ ok: true })),
    commitConfirmPickup: vi.fn(async () => ({ ok: true })),
    executeMarketplaceCommand: vi.fn(async () => ({ ok: true, result: { kind: 'order', order: { state: 'cancelled' } } })),
    fetchPickupReveal: vi.fn(async () => {
      throw new Error('not under test here');
    }),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

const mockedController = vi.mocked(CommerceController);

beforeEach(() => {
  mockedController.getMarketplaceBandConsent.mockReset().mockResolvedValue(null);
  mockedController.getOwnMarketplaceReview.mockReset().mockResolvedValue(null);
});

const WINDOW_MS = COMMERCE_REVIEW_EDIT_WINDOW_SECONDS * 1000;

function ownReview(createdAt: string): NonNullable<MarketplaceOrder['reviews']>[number] {
  return {
    id: '018f47d2-6a27-7c23-a62f-000000000601',
    reviewerPubky: ORDER_FIXTURE_BUYER,
    subjectPubky: 's'.repeat(52),
    rating: 5,
    text: 'Accurate and fast.',
    createdAt,
  };
}

function renderActions({
  reviewCreatedAt,
  canEditReview = true,
  withOwnReview = true,
}: {
  reviewCreatedAt?: string;
  canEditReview?: boolean;
  withOwnReview?: boolean;
} = {}) {
  const order = createOrderFixture('completed', {
    reviews: withOwnReview ? [ownReview(reviewCreatedAt ?? new Date(Date.now() - 60_000).toISOString())] : [],
  });
  const actOnOrder = vi.fn(async () => true);
  render(
    <MarketplaceOrderActions order={order} isBuyer={true} canEditReview={canEditReview} actOnOrder={actOnOrder} />,
  );
  return { order, actOnOrder };
}

describe('MarketplaceOrderActions review editing', () => {
  it('offers the edit inside the 24-hour window in transaction-service mode', () => {
    renderActions({ reviewCreatedAt: new Date(Date.now() - (WINDOW_MS - 60_000)).toISOString() });

    expect(screen.getByRole('button', { name: 'Edit review' })).toBeInTheDocument();
    // The review already exists, so the create affordance is gone.
    expect(screen.queryByRole('button', { name: 'Leave review' })).not.toBeInTheDocument();
  });

  it('withholds the edit once the window has closed instead of failing on submit', () => {
    renderActions({ reviewCreatedAt: new Date(Date.now() - (WINDOW_MS + 60_000)).toISOString() });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
  });

  it('withholds the edit in sandbox mode: the sandbox has no review.update command', () => {
    renderActions({ canEditReview: false });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
  });

  it('withholds the edit when the caller has not reviewed the order', () => {
    renderActions({ withOwnReview: false });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave review' })).toBeInTheDocument();
  });

  it('prefills the existing review and submits review.update with the revised terms', async () => {
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions();

    await user.click(screen.getByRole('button', { name: 'Edit review' }));
    expect(screen.getByText('Edit your review')).toBeInTheDocument();

    const textField = screen.getByLabelText('Review');
    expect(textField).toHaveValue('Accurate and fast.');
    expect(screen.getByRole('radio', { name: '5 stars' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: '3 stars' }));
    await user.clear(textField);
    await user.type(textField, 'Item arrived scratched after all.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.update', {
      rating: 3,
      text: 'Item arrived scratched after all.',
    });
  });

  it('changes the review rating with arrow keys and submits the same form field', async () => {
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const oneStar = screen.getByRole('radio', { name: '1 star' });
    await user.click(oneStar);
    expect(oneStar).toBeChecked();
    expect(oneStar).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '2 stars' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '2 stars' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '3 stars' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '3 stars' })).toHaveFocus();

    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 3,
      text: 'Accurate and fast.',
      allowAmountBand: false,
    });
  });

  it('keeps a single tab stop on the checked rating radio', async () => {
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const checked = screen.getByRole('radio', { name: '5 stars' });
    const radios = screen.getAllByRole('radio');
    expect(checked).toBeChecked();
    expect(radios.filter((radio) => radio.tabIndex >= 0)).toEqual([checked]);

    checked.focus();
    await user.tab();
    expect(screen.getByLabelText('Review')).toHaveFocus();
  });
});

describe('MarketplaceOrderActions amount-band opt-in (D2 both-sides consent)', () => {
  it('renders the opt-in only when the seller consented, and submits the buyer choice', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(true);
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const checkbox = await screen.findByRole('checkbox', { name: /include an approximate price range/i });
    expect(checkbox).not.toBeChecked();

    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 5,
      text: 'Accurate and fast.',
      allowAmountBand: true,
    });
  });

  it('defaults the opt-in to excluded (not included unless both sides opt in)', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(true);
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    await screen.findByRole('checkbox', { name: /include an approximate price range/i });
    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 5,
      text: 'Accurate and fast.',
      allowAmountBand: false,
    });
  });

  it('states truthfully that the seller has not enabled bands instead of a dead checkbox', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(false);
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    expect(await screen.findByText(/has not enabled price-range sharing/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders neither checkbox nor note when the backend has no attestation support', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(null);
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/price-range sharing/i)).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions own-review verified status', () => {
  function publishedReviewRow(overrides: Partial<CommerceReviewModelSchema> = {}): CommerceReviewModelSchema {
    return {
      id: `${ORDER_FIXTURE_BUYER}:8Z8CWH8NVYQY39ZEBFGKQWWEKG`,
      owner_id: ORDER_FIXTURE_BUYER,
      review_id: '8Z8CWH8NVYQY39ZEBFGKQWWEKG',
      order_id: 'order-1',
      subject_id: 's'.repeat(52),
      record: {} as CommerceReviewModelSchema['record'],
      attestation_verified: true,
      attestation_iss: 'o'.repeat(52),
      sync_status: 'synced',
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it('shows the verified state when the published record carries a verifying attestation', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(publishedReviewRow());
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(/Verified purchase/);
    });
    expect(screen.getByTestId('own-review-status')).toHaveTextContent(/signed by attestor oooooooo…/);
  });

  it('shows the pending-publication state truthfully', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(publishedReviewRow({ sync_status: 'pending' }));
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(/still pending and will retry/);
    });
  });

  it('does not claim that no attestation was issued when the durable row is unavailable', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(null);
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(/publication status will appear/);
    });
  });
});

describe('MarketplaceOrderActions refund reference labels', () => {
  it.each([
    ['bitcoin', 'External Bitcoin transaction reference'],
    ['paypal', 'PayPal transaction reference'],
    ['stripe', 'Stripe payment reference'],
    [undefined, 'External payment reference'],
  ] as const)('uses the %s rail label', async (paymentMethod, label) => {
    const order = createOrderFixture('return_received', { paymentMethod });
    render(
      <MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={vi.fn(async () => true)} />,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'Record external refund' }));
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions local pickup (Wave 7, §A6)', () => {
  const pickupControllerState = {
    confirmResponse: { ok: true } as unknown,
    cancelResponse: { ok: true, result: { kind: 'order', order: { state: 'cancelled' } } } as unknown,
  };

  beforeEach(() => {
    mockedController.commitMarkReady.mockClear().mockResolvedValue({ ok: true } as never);
    mockedController.commitConfirmPickup.mockClear().mockImplementation(async () => pickupControllerState.confirmResponse as never);
    mockedController.executeMarketplaceCommand.mockClear().mockImplementation(async () => pickupControllerState.cancelResponse as never);
    pickupControllerState.confirmResponse = { ok: true };
    pickupControllerState.cancelResponse = { ok: true, result: { kind: 'order', order: { state: 'cancelled' } } };
  });

  function renderPickupActions({
    state,
    isBuyer,
    overrides = {},
  }: {
    state: 'paid' | 'ready_for_pickup' | 'delivered';
    isBuyer: boolean;
    overrides?: Partial<MarketplaceOrder>;
  }) {
    const order = createOrderFixture(state, { fulfillment: 'pickup', ...overrides });
    const actOnOrder = vi.fn(async () => true);
    const onChanged = vi.fn();
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={isBuyer}
        canEditReview={false}
        actOnOrder={actOnOrder}
        onChanged={onChanged}
      />,
    );
    return { order, actOnOrder, onChanged };
  }

  it('offers the seller Mark ready for pickup and Confirm handover from paid — and no shipping actions', () => {
    renderPickupActions({ state: 'paid', isBuyer: false });

    expect(screen.getByRole('button', { name: 'Mark ready for pickup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeInTheDocument();
    // Pickup orders never ship (§A6): no tracking, no label.
    expect(screen.queryByRole('button', { name: 'Add tracking' })).not.toBeInTheDocument();
  });

  it('hides the packing-slip print affordance on pickup orders (§A5)', () => {
    renderPickupActions({ state: 'paid', isBuyer: false });
    expect(screen.queryByRole('button', { name: 'Packing slip' })).not.toBeInTheDocument();

    renderPickupActions({ state: 'delivered', isBuyer: false });
    expect(screen.queryByRole('button', { name: 'Packing slip' })).not.toBeInTheDocument();
  });

  it('keeps the packing-slip affordance on shipped orders', () => {
    const order = createOrderFixture('paid', { fulfillment: 'shipping' });
    render(
      <MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={vi.fn(async () => true)} />,
    );
    expect(screen.getByRole('button', { name: 'Packing slip' })).toBeInTheDocument();
  });

  it('marks ready through commitMarkReady and reloads the timeline', async () => {
    const user = userEvent.setup();
    const { order, onChanged } = renderPickupActions({ state: 'paid', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Mark ready for pickup' }));

    await waitFor(() => {
      expect(mockedController.commitMarkReady).toHaveBeenCalledWith(order.id, order.revision);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers the buyer Show meeting point and Confirm handover from ready_for_pickup', () => {
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: true });

    expect(screen.getByRole('button', { name: 'Show meeting point' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
  });

  it('withholds the meeting-point reveal once the order is terminal (§A3)', () => {
    // A delivered pickup order is NOT terminal — the buyer may still need the
    // pinned meeting point (a return is still possible).
    renderPickupActions({ state: 'delivered', isBuyer: true });
    expect(screen.getByRole('button', { name: 'Show meeting point' })).toBeInTheDocument();
  });

  it('hides the reveal on a cancelled pickup order — the entitlement ended at the cancel (§A3)', () => {
    // The order keeps its payment receipt — the gate is the terminal state,
    // not the receipt, per the reveal cutoff.
    renderPickupActions({ state: 'delivered', isBuyer: true, overrides: { state: 'cancelled' } });
    expect(screen.queryByRole('button', { name: 'Show meeting point' })).not.toBeInTheDocument();
  });

  it('warns the buyer before confirm — only once the item is in their hands', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: true });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(screen.getByText('Only confirm once the item is in your hands.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    await waitFor(() => {
      expect(mockedController.commitConfirmPickup).toHaveBeenCalled();
    });
  });

  it('carries the seller-attested wording on the seller confirm', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(screen.getByText(/A handover you confirm yourself counts toward your reputation/)).toBeInTheDocument();
  });

  it('renders the seller-actor terms-change refusal as an explanation, not an error toast', async () => {
    pickupControllerState.confirmResponse = {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message:
          'The pickup terms changed after payment; the seller cannot confirm the handover until the buyer has seen the change.',
      },
    };
    const user = userEvent.setup();
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));

    expect(
      await screen.findByText(/Until the buyer has seen the change, only the buyer can confirm the handover/),
    ).toBeInTheDocument();
  });

  it('states that cancelling moves no money on the pickup cancel dialog, and confirms the unilateral exit', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true, overrides: { pickupTermsChanged: true } });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByText('Cancel this pickup order')).toBeInTheDocument();
    // Framed as a REQUEST that completes immediately only under the §A3
    // conditions — the service can still degrade to cancel_requested.
    expect(screen.getByText(/This requests a cancellation — cancelling moves no money/)).toBeInTheDocument();
    // The projection flagged a terms change: the immediate-exit copy (§A3).
    expect(screen.getByText(/this completes immediately, with no seller approval needed/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Reason'), 'The new spot is unreachable for me');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(mockedController.executeMarketplaceCommand).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'order.cancel_request' }),
      );
    });
  });

  it('asks for seller approval on the pickup cancel dialog while no unilateral exit is open', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByText(/This requests a cancellation — cancelling moves no money/)).toBeInTheDocument();
    expect(
      screen.getByText(/It completes immediately only if the seller changes the pickup terms after you paid/),
    ).toBeInTheDocument();
    expect(screen.getByText(/otherwise the seller is asked to approve/)).toBeInTheDocument();
  });

  it('renders the degraded cancel_requested outcome honestly (the lost race, §7.2)', async () => {
    pickupControllerState.cancelResponse = {
      ok: true,
      result: { kind: 'order', order: { state: 'cancel_requested' } },
    };
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true, overrides: { firstRevealedAt: '2026-08-19T21:00:00.000Z' } });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await user.type(screen.getByLabelText('Reason'), 'The spot does not work for me');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'warning',
          description: 'Instant cancellation was not available; your cancellation request now awaits the seller.',
        }),
      );
    });
  });
});
