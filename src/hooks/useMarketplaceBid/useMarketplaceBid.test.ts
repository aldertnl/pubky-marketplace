import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { useMarketplaceBid } from './useMarketplaceBid';

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    executeMarketplaceCommand: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

describe('useMarketplaceBid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000810');
  });

  it('submits a private proxy maximum at the authoritative auction revision', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000810',
      aggregateId: 'listing:seller_item',
      revision: 4,
      eventIds: ['00000000-0000-4000-8000-000000000811'],
      result: { kind: 'bid' },
    });
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'listing:seller_item',
        expectedRevision: 3,
        kind: 'auction.place_bid',
        payload: {
          maximumAmount: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
        },
      }),
    );
  });

  it('refuses to submit after the shared auction phase ends', async () => {
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET, 'ended'));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refetches the projection and asks for a retry on a revision conflict', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 5 },
    });
    const onConflict = vi.fn();
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, onConflict, USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(onConflict).toHaveBeenCalledTimes(1);
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('reloaded') }),
    );
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_bid';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const { result } = renderHook(() => useMarketplaceBid('listing:seller_item', 3, vi.fn(), USD_ASSET));
    act(() => result.current.form.setValue('maximumAmount', '150.00'));

    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(vi.mocked(toast).mock.calls[0]?.[0]?.description).toBeTypeOf('string');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce({
      name: 'AppError',
      code: 'INVALID_STATE',
      message: sentinel,
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
  });
});
