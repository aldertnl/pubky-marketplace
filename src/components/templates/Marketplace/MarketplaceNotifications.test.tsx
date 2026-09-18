import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MarketplaceNotifications } from './MarketplaceNotifications';

const authStoreState = vi.hoisted(() => ({ session: {} as unknown }));
const markAllSeen = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { session: unknown | null }) => unknown) => selector(authStoreState),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    markActivityRead: vi.fn(async () => {}),
  },
}));

vi.mock('@/hooks/useMarketplaceNotifications/useMarketplaceNotifications', () => ({
  useMarketplaceNotifications: () => ({
    notifications: [],
    preferences: null,
    unreadCount: 0,
    isLoading: false,
    error: null,
    needsSession: false,
    canMarkRead: false,
    markAllRead: vi.fn(),
    updatePreferences: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: [], markAllSeen }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('MarketplaceNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authStoreState.session = {};
  });

  it('clears the device-local read state on entry: watch alerts seen, activity checkpoint advanced', async () => {
    render(<MarketplaceNotifications />);

    await waitFor(() => expect(markAllSeen).toHaveBeenCalledOnce());
    expect(CommerceController.markActivityRead).toHaveBeenCalledOnce();
  });

  it('does not touch device-local read state while no session is restored', () => {
    authStoreState.session = null;

    render(<MarketplaceNotifications />);

    expect(markAllSeen).not.toHaveBeenCalled();
    expect(CommerceController.markActivityRead).not.toHaveBeenCalled();
  });
});
