import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@/config/app';
import type { UseStepUpReauthReturn } from '@/hooks/useStepUpReauth/useStepUpReauth.types';
import { MarketplaceReauthDialog } from './MarketplaceReauthDialog';

const reauth: UseStepUpReauthReturn = {
  status: 'idle',
  authorizationUrl: '',
  errorMessage: null,
  start: vi.fn(),
  cancel: vi.fn(),
  copyAuthUrl: vi.fn(),
  openInRing: vi.fn(),
  isOpeningRing: false,
};

vi.mock('@/hooks/useStepUpReauth/useStepUpReauth', () => ({
  useStepUpReauth: () => reauth,
}));

describe('MarketplaceReauthDialog', () => {
  it('renders the exact requested capability string beside the QR so the user can compare it with the signer', async () => {
    render(<MarketplaceReauthDialog triggerLabel="Sign in again" />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));

    // Verbatim from the single CAPABILITIES constant — never a paraphrase.
    expect(screen.getByText(CAPABILITIES)).toBeInTheDocument();
    expect(screen.getByText(/Pubky Ring will show this exact permission list/)).toBeInTheDocument();
  });
});
