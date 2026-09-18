import { useEffect, useState } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceCartCount } from './useMarketplaceCartCount';

const OWNER = 'y'.repeat(52);
const SELLER = 'b'.repeat(52);

const state = vi.hoisted(() => ({
  currentUserPubky: 'y'.repeat(52) as string | null,
}));

// The real hook reads live from Dexie; resolving the querier once per
// dependency change is enough for these assertions on the count math.
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const [value, setValue] = useState<unknown>(undefined);
    useEffect(() => {
      let active = true;
      void Promise.resolve(querier()).then((next) => {
        if (active) setValue(next);
      });
      return () => {
        active = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return value;
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: state.currentUserPubky }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getCartItems: vi.fn(),
    getListing: vi.fn(),
  },
}));

function cartRow(listingId: string, quantity: number) {
  return {
    id: `${OWNER}|${SELLER}:${listingId}|v1`,
    owner_id: OWNER,
    listing_id: `${SELLER}:${listingId}`,
    variant_id: 'v1',
    quantity,
    added_at: 100,
    updated_at: 100,
  };
}

describe('useMarketplaceCartCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = OWNER;
    vi.mocked(CommerceController.getCartItems).mockResolvedValue([]);
    vi.mocked(CommerceController.getListing).mockResolvedValue({ id: 'resolved' } as never);
  });

  it('sums quantities across cart lines — the same number the cart page shows', async () => {
    vi.mocked(CommerceController.getCartItems).mockResolvedValue([cartRow('boots_01', 2), cartRow('cam_02', 3)]);

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(5));
    expect(CommerceController.getListing).toHaveBeenCalledWith(SELLER, 'boots_01');
    expect(CommerceController.getListing).toHaveBeenCalledWith(SELLER, 'cam_02');
  });

  it('excludes lines whose listing no longer resolves, matching the cart page', async () => {
    vi.mocked(CommerceController.getCartItems).mockResolvedValue([cartRow('boots_01', 2), cartRow('gone_03', 4)]);
    vi.mocked(CommerceController.getListing).mockImplementation(async (_seller, listingId) =>
      listingId === 'gone_03' ? null : ({ id: 'resolved' } as never),
    );

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(2));
  });

  it('returns zero for an empty cart — zero renders no badge', async () => {
    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(CommerceController.getCartItems).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('returns zero without reading the cart when signed out', async () => {
    state.currentUserPubky = null;

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(0));
    expect(CommerceController.getCartItems).not.toHaveBeenCalled();
  });
});
