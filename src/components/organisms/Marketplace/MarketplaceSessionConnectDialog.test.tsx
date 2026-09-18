import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceSessionConnectStatus } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect.types';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Dialog states are driven entirely by the mocked hook: these tests pin WHAT
 * the dialog renders per status — in particular that the joined state (an
 * approval already in progress on another surface) shows honest copy and
 * suppresses the QR slot, Copy, and Open affordances.
 */
const view = vi.hoisted(() => ({
  status: 'joined' as MarketplaceSessionConnectStatus,
  authorizationUrl: '',
  errorMessage: null as string | null,
  isOpeningRing: false,
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: view.status,
    authorizationUrl: view.authorizationUrl,
    errorMessage: view.errorMessage,
    requestsFullGrant: true,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: view.isOpeningRing,
  }),
}));

// Render the dialog content inline (no portal, no trigger click): these tests
// assert the rendered states, not Radix wiring.
vi.mock('@/atoms/Dialog/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('MarketplaceSessionConnectDialog', () => {
  beforeEach(() => {
    view.status = 'joined';
    view.authorizationUrl = '';
    view.errorMessage = null;
    view.isOpeningRing = false;
  });

  it('joined state: honest copy, and no QR slot, Copy, or Open affordances', () => {
    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByText(/approval is already in progress on another surface/i)).toBeInTheDocument();
    // The QR slot button (its aria-label is the copy affordance) must not
    // render — there is no URL on this surface to scan, copy, or open.
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open in pubky ring/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
  });

  it('awaiting state with a URL still renders the QR slot (contrast)', () => {
    view.status = 'awaiting';
    view.authorizationUrl = 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=x';

    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByLabelText('Copy authorization link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open in pubky ring/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
  });
});
