import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { useMarketplaceSellerDashboard } from './useMarketplaceSellerDashboard';

const OWNER = 'y'.repeat(52);
const OTHER_OWNER = 'z'.repeat(52);
let currentUserPubky = OWNER;
let localListings: Array<{ state: 'active'; record: ReturnType<typeof createCommerceListingFixture> }> = [];

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (store: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: currentUserPubky }),
}));

vi.mock('@/hooks/useMeasurementSystem/useMeasurementSystem', () => ({
  useMeasurementSystem: () => 'metric',
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({ orders: [], isLoading: false, needsSession: false, error: null }),
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: [], isLoading: false, needsSession: false, error: null }),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => localListings,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getListingsBySeller: vi.fn(async () => []),
    getOrFetchListingsBySeller: vi.fn(async () => []),
    refreshListingsBySeller: vi.fn(async () => undefined),
    fetchSellerCatalogListings: vi.fn(async () => undefined),
    getOrFetchListing: vi.fn(),
    commitUpdateListingDraft: vi.fn(),
    commitUpsertListing: vi.fn(),
    getListingDrafts: vi.fn(async () => []),
    commitDeleteListingDraft: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('useMarketplaceSellerDashboard duplicateListing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserPubky = OWNER;
    localListings = [];
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([]);
    vi.mocked(CommerceController.commitUpdateListingDraft).mockResolvedValue(undefined);
    vi.mocked(CommerceController.commitDeleteListingDraft).mockResolvedValue(undefined);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('018f47d2-6a27-7c23-a49d-6b21bb770999');
  });

  it('refreshes the seller catalog after rendering an empty local cache', async () => {
    const listing = createCommerceListingFixture({ listingId: 'boots_02' });
    vi.mocked(CommerceController.refreshListingsBySeller).mockImplementationOnce(async () => {
      localListings = [{ state: 'active', record: listing }];
    });
    const { result, rerender } = renderHook(() => useMarketplaceSellerDashboard());

    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OWNER));
    rerender();

    expect(result.current.listings).toEqual([{ state: 'active', record: listing }]);
    expect(result.current.error).toBeNull();
  });

  it('reports a catalog refresh failure instead of hiding cached listings', async () => {
    const listing = createCommerceListingFixture({ listingId: 'boots_02' });
    localListings = [{ state: 'active', record: listing }];
    vi.mocked(CommerceController.refreshListingsBySeller).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useMarketplaceSellerDashboard());

    await waitFor(() => expect(result.current.error).toBe('Could not load your listings.'));
    expect(result.current.listings).toEqual(localListings);
    expect(result.current.isLoading).toBe(false);
  });

  it('starts one background refresh while rendering cached listings immediately', async () => {
    const listing = createCommerceListingFixture({ listingId: 'boots_01' });
    localListings = [{ state: 'active', record: listing }];
    let resolveRefresh: (() => void) | undefined;
    vi.mocked(CommerceController.refreshListingsBySeller).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { result } = renderHook(() => useMarketplaceSellerDashboard());

    expect(result.current.listings).toEqual(localListings);
    expect(result.current.isLoading).toBe(false);
    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OWNER));
    resolveRefresh?.();
  });

  it('ignores a refresh that resolves after unmount', async () => {
    let resolveRefresh: (() => void) | undefined;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(CommerceController.refreshListingsBySeller).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { result, unmount } = renderHook(() => useMarketplaceSellerDashboard());

    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OWNER));
    const stateBeforeUnmount = {
      error: result.current.error,
      isLoading: result.current.isLoading,
      listings: result.current.listings,
    };
    unmount();
    resolveRefresh?.();
    await act(async () => {});

    expect({
      error: result.current.error,
      isLoading: result.current.isLoading,
      listings: result.current.listings,
    }).toEqual(stateBeforeUnmount);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not let seller A failure overwrite seller B state', async () => {
    let rejectA: ((error: Error) => void) | undefined;
    let resolveB: (() => void) | undefined;
    vi.mocked(CommerceController.refreshListingsBySeller)
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectA = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveB = resolve;
        }),
      );
    const { result, rerender } = renderHook(() => useMarketplaceSellerDashboard());

    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OWNER));
    currentUserPubky = OTHER_OWNER;
    rerender();
    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OTHER_OWNER));

    rejectA?.(new Error('seller A failed'));
    await act(async () => {});
    expect(result.current.error).toBeNull();

    resolveB?.();
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('updates the cached listing count after refresh hydrates a newly discovered listing', async () => {
    const first = createCommerceListingFixture({ listingId: 'boots_01' });
    const second = createCommerceListingFixture({ listingId: 'boots_02' });
    const third = createCommerceListingFixture({ listingId: 'boots_03' });
    localListings = [
      { state: 'active', record: first },
      { state: 'active', record: second },
    ];
    let resolveRefresh: (() => void) | undefined;
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = () => {
        localListings = [...localListings, { state: 'active', record: third }];
        resolve();
      };
    });
    vi.mocked(CommerceController.refreshListingsBySeller).mockReturnValueOnce(refresh);

    const { result, rerender } = renderHook(() => useMarketplaceSellerDashboard());

    expect(result.current.listings).toHaveLength(2);
    await waitFor(() => expect(CommerceController.refreshListingsBySeller).toHaveBeenCalledWith(OWNER));
    await act(async () => {
      resolveRefresh?.();
      await refresh;
    });
    rerender();

    expect(result.current.listings).toHaveLength(3);
    expect(result.current.metrics.activeListings).toBe(3);
  });

  it('seeds a new create draft from a fixed-price listing and excludes ids and revision', async () => {
    const source = createCommerceListingFixture({
      listingId: 'boots_01',
      revision: 7,
      title: 'Vintage leather boots',
      variants: [
        {
          id: 'variant_01',
          sku: 'BOOTS-42',
          options: { size: '42' },
          quantity: 4,
          mediaIds: ['image_01'],
          enabled: true,
        },
      ],
    });
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(source);

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let seeded = false;
    await act(async () => {
      seeded = await result.current.duplicateListing('boots_01');
    });

    expect(seeded).toBe(true);
    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledOnce();
    const [draftId, form] = vi.mocked(CommerceController.commitUpdateListingDraft).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(draftId).toBe('018f47d26a277c23a49d6b21bb770999');
    expect(form).not.toHaveProperty('listingId');
    expect(form).not.toHaveProperty('revision');
    expect(form).not.toHaveProperty('media');
    expect(form).toMatchObject({
      title: 'Vintage leather boots',
      description: source.description,
      categoryId: source.categoryId,
      condition: 'good',
      saleFormat: 'fixed_price',
      currency: 'USD',
      price: '125.00',
      seededFromTitle: 'Vintage leather boots',
      seededAuctionAsFixedPrice: false,
      variants: [expect.objectContaining({ sku: 'BOOTS-42-copy', quantity: '4', size: '42' })],
    });
    expect(JSON.stringify(form)).not.toContain('boots_01');
    expect(JSON.stringify(form)).not.toContain('variant_01');
    expect(JSON.stringify(form)).not.toContain('image_01');
  });

  it('refuses to duplicate over an unsaved draft unless replaceUnsavedDraft is set', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([unsavedDraft({ title: 'Unsaved boots' })]);
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(createCommerceListingFixture());

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let seeded = true;
    await act(async () => {
      seeded = await result.current.duplicateListing('boots_01');
    });

    expect(seeded).toBe(false);
    expect(CommerceController.commitUpdateListingDraft).not.toHaveBeenCalled();

    await act(async () => {
      seeded = await result.current.duplicateListing('boots_01', { replaceUnsavedDraft: true });
    });

    expect(seeded).toBe(true);
    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledOnce();
    expect(CommerceController.commitDeleteListingDraft).toHaveBeenCalledWith('existingdraft');
    expect(vi.mocked(CommerceController.commitUpdateListingDraft).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(CommerceController.commitDeleteListingDraft).mock.invocationCallOrder[0],
    );
  });

  it('leaves the old draft when seeding the replacement fails', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([unsavedDraft({ title: 'Unsaved boots' })]);
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(createCommerceListingFixture());
    vi.mocked(CommerceController.commitUpdateListingDraft).mockRejectedValue(new Error('dexie write failed'));

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let seeded = true;
    await act(async () => {
      seeded = await result.current.duplicateListing('boots_01', { replaceUnsavedDraft: true });
    });

    expect(seeded).toBe(false);
    expect(CommerceController.commitDeleteListingDraft).not.toHaveBeenCalled();
  });

  it('keeps the new draft when deleting the old one fails', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([unsavedDraft({ title: 'Unsaved boots' })]);
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(createCommerceListingFixture());
    vi.mocked(CommerceController.commitDeleteListingDraft).mockRejectedValue(new Error('dexie delete failed'));

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let seeded = false;
    await act(async () => {
      seeded = await result.current.duplicateListing('boots_01', {
        replaceUnsavedDraft: true,
        unsavedDraftId: 'existingdraft',
      });
    });

    expect(seeded).toBe(true);
    expect(CommerceController.commitUpdateListingDraft).toHaveBeenCalledOnce();
    expect(CommerceController.getListingDrafts).not.toHaveBeenCalled();
  });

  it('treats a photos-only draft as unsaved content', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      unsavedDraft({ photos: [{ name: 'boots.jpg' }] }),
    ]);

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let draftId: string | null = null;
    await act(async () => {
      draftId = await result.current.hasUnsavedListingDraft();
    });

    expect(draftId).toBe('existingdraft');
  });

  it('ignores a default empty autosaved draft', async () => {
    vi.mocked(CommerceController.getListingDrafts).mockResolvedValue([
      unsavedDraft({
        title: '',
        description: '',
        categoryId: '',
        condition: 'good',
        price: '',
        variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', priceOverride: '' }],
        shippingLabel: 'Seller shipping',
        shippingPrice: '',
        shippingMinDays: '3',
        shippingMaxDays: '7',
      }),
    ]);

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    let draftId: string | null = 'existingdraft';
    await act(async () => {
      draftId = await result.current.hasUnsavedListingDraft();
    });

    expect(draftId).toBeNull();
  });

  it('copies an auction as fixed price with a notice flag', async () => {
    const source = createCommerceListingFixture({
      listingId: 'auction_01',
      sale: {
        format: 'auction',
        startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      },
    });
    vi.mocked(CommerceController.getOrFetchListing).mockResolvedValue(source);

    const { result } = renderHook(() => useMarketplaceSellerDashboard());
    await act(async () => {
      await result.current.duplicateListing('auction_01');
    });

    const form = vi.mocked(CommerceController.commitUpdateListingDraft).mock.calls[0][1] as Record<string, unknown>;
    expect(form.saleFormat).toBe('fixed_price');
    expect(form.price).toBe('45.00');
    expect(form.seededAuctionAsFixedPrice).toBe(true);
  });
});

function unsavedDraft(form: Record<string, unknown>) {
  return {
    id: `${OWNER}:existingdraft`,
    owner_id: OWNER,
    listing_id: 'existingdraft',
    data: { ownerPubky: OWNER, listingId: 'existingdraft', form: JSON.parse(JSON.stringify(form)) },
    created_at: 1_000,
    updated_at: 2_000,
  };
}
