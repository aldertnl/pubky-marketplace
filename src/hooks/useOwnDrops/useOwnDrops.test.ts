import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { rememberOwnDrop } from '@/hooks/useDropStudio/drop-index';
import { useOwnDrops } from './useOwnDrops';

const SELLER = vi.hoisted(() => 'y'.repeat(52));

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchDrop: vi.fn(),
    getOwnDrop: vi.fn(),
    listOwnDropIds: vi.fn(async () => []),
  },
}));

describe('useOwnDrops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    config.mode = 'transaction-service';
  });

  it('enumerates from the device-local index and joins record + authoritative state per row', async () => {
    rememberOwnDrop(SELLER, 'older');
    rememberOwnDrop(SELLER, 'newer');
    vi.mocked(CommerceController.fetchDrop).mockImplementation(
      async (_owner, dropId) =>
        ({
          dropId,
          title: dropId === 'newer' ? 'New drop' : 'Old drop',
          startsAt: dropId === 'newer' ? '2026-09-01T10:00:00.000Z' : '2026-08-01T10:00:00.000Z',
        }) as never,
    );
    vi.mocked(CommerceController.getOwnDrop).mockImplementation(async (dropId) =>
      dropId === 'newer' ? ({ dropId, state: 'announced', revision: 1 } as never) : null,
    );

    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows).toHaveLength(2);
    // Newest launch first.
    expect(result.current.rows[0]).toMatchObject({
      dropId: 'newer',
      record: { title: 'New drop' },
      drop: { state: 'announced' },
    });
    // The service has no aggregate → drop is null, rendered as "unregistered".
    expect(result.current.rows[1]).toMatchObject({ dropId: 'older', drop: null });
  });

  it('keeps a row when the homeserver record read fails — honest absence, never a hidden drop', async () => {
    rememberOwnDrop(SELLER, 'orphan');
    vi.mocked(CommerceController.fetchDrop).mockRejectedValue(new Error('404'));
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue({ dropId: 'orphan', state: 'live' } as never);

    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows).toEqual([
      { dropId: 'orphan', record: null, drop: expect.objectContaining({ state: 'live' }) },
    ]);
  });

  it('never queries the service outside durable mode', async () => {
    config.mode = 'sandbox';
    rememberOwnDrop(SELLER, 'drop1');
    vi.mocked(CommerceController.fetchDrop).mockResolvedValue({
      dropId: 'drop1',
      startsAt: '2026-08-01T10:00:00.000Z',
    } as never);

    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(CommerceController.getOwnDrop).not.toHaveBeenCalled();
    expect(result.current.isDurable).toBe(false);
    expect(result.current.rows[0]).toMatchObject({ dropId: 'drop1', drop: null });
  });

  it('renders an empty list when this device has published nothing', async () => {
    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(CommerceController.fetchDrop).not.toHaveBeenCalled();
  });

  it('enumerates from the homeserver directory listing and merges the local index without duplicates', async () => {
    // Published from ANOTHER device: only the directory listing knows it.
    vi.mocked(CommerceController.listOwnDropIds).mockResolvedValue(['from_other_device', 'shared']);
    // Published from this browser moments ago: only the local index knows it.
    rememberOwnDrop(SELLER, 'shared');
    rememberOwnDrop(SELLER, 'just_published');
    vi.mocked(CommerceController.fetchDrop).mockImplementation(
      async (_owner, dropId) => ({ dropId, startsAt: '2026-08-01T10:00:00.000Z' }) as never,
    );
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(null);

    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows.map((row) => row.dropId).sort()).toEqual([
      'from_other_device',
      'just_published',
      'shared',
    ]);
  });

  it('degrades to the local index alone when the directory listing is unreachable', async () => {
    vi.mocked(CommerceController.listOwnDropIds).mockRejectedValue(new Error('homeserver unreachable'));
    rememberOwnDrop(SELLER, 'local_only');
    vi.mocked(CommerceController.fetchDrop).mockResolvedValue({
      dropId: 'local_only',
      startsAt: '2026-08-01T10:00:00.000Z',
    } as never);
    vi.mocked(CommerceController.getOwnDrop).mockResolvedValue(null);

    const { result } = renderHook(() => useOwnDrops());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rows.map((row) => row.dropId)).toEqual(['local_only']);
  });
});
