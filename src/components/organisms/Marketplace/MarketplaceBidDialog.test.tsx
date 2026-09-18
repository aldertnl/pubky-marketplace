import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { useAuthStore } from '@/stores/auth/auth.store';
import { createAuctionProjectionFixture } from '@/test/fixtures/commerce/projections';
import { MarketplaceBidDialog } from './MarketplaceBidDialog';

const SIGNED_IN_PUBKY = 'y'.repeat(52);

describe('MarketplaceBidDialog', () => {
  beforeEach(() => {
    useAuthStore.setState({ currentUserPubky: SIGNED_IN_PUBKY });
  });

  it('disables the trigger while the auction has no projection to bid against', () => {
    render(
      <MarketplaceBidDialog aggregateId="listing:x" projection={null} priceAsset={USD_ASSET} onAccepted={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Place a bid' })).toBeDisabled();
  });

  it('keeps the trigger enabled and asks for approval when only the marketplace session is missing', async () => {
    const user = userEvent.setup();
    const onSessionRequired = vi.fn();
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={null}
        priceAsset={USD_ASSET}
        isSessionRequired
        onSessionRequired={onSessionRequired}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(onSessionRequired).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains maximum-bid proxy semantics inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={createAuctionProjectionFixture()}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('dialog', { name: 'Set your maximum bid' })).toBeInTheDocument();
    expect(screen.getByText("We bid only what's needed to keep you ahead, up to your maximum.")).toBeInTheDocument();
    expect(
      screen.getByText('Your maximum stays private. The visible price advances only enough to keep you ahead.'),
    ).toBeInTheDocument();
  });
});
