import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { useMarketplaceSellerPaymentConfig } from './useMarketplaceSellerPaymentConfig';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMyPaymentConfig: vi.fn(),
    isOwnPaykitAccountClaimed: vi.fn(),
    putMyPaymentConfig: vi.fn(),
    beginPaykitClaimFlow: vi.fn(),
  },
}));
vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/libs/logger/logger', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

const error = (operation: string) =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.CONFLICT,
    message: `SENTINEL_SELLER_PAYMENT_${operation}`,
    service: ErrorService.Marketplace,
    operation,
  });

const config = {
  bitcoinEnabled: true,
  stripePaymentLink: null,
  stripeRestrictedKeySet: false,
  paypalMerchantEmail: null,
  updatedAt: '2026-09-09T00:00:00.000Z',
};

describe('useMarketplaceSellerPaymentConfig', () => {
  it('uses static copy for configuration load and save failures', async () => {
    vi.mocked(CommerceController.getMyPaymentConfig).mockRejectedValueOnce(error('load'));
    vi.mocked(CommerceController.isOwnPaykitAccountClaimed).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useMarketplaceSellerPaymentConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toBeTruthy();
    expect(result.current.loadError).not.toContain('SENTINEL_SELLER_PAYMENT_load');

    vi.mocked(CommerceController.putMyPaymentConfig).mockRejectedValueOnce(error('save'));
    await act(async () => {
      await result.current.save({
        bitcoinEnabled: true,
        stripePaymentLink: '',
        stripeRestrictedKey: '',
        paypalMerchantEmail: '',
      });
    });
    const saveDescription = vi.mocked(toast).mock.calls.at(-1)?.[0]?.description;
    expect(saveDescription).toBeTypeOf('string');
    expect(saveDescription).not.toContain('SENTINEL_SELLER_PAYMENT_save');
  });

  it('uses static copy for Stripe removal and watch-only claim failures', async () => {
    vi.mocked(CommerceController.getMyPaymentConfig).mockResolvedValue(config);
    vi.mocked(CommerceController.isOwnPaykitAccountClaimed).mockResolvedValue(false);
    vi.mocked(CommerceController.putMyPaymentConfig).mockRejectedValueOnce(error('remove'));
    const { result } = renderHook(() => useMarketplaceSellerPaymentConfig());
    await waitFor(() => expect(result.current.config).not.toBeNull());

    await act(async () => {
      await result.current.clearStripeKey();
    });
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]?.description).not.toContain('SENTINEL_SELLER_PAYMENT_remove');

    vi.mocked(CommerceController.beginPaykitClaimFlow).mockImplementationOnce(() => {
      throw error('start');
    });
    act(() => result.current.startClaim(`xpub${'1'.repeat(107)}`));
    expect(result.current.claimError).toBeTruthy();
    expect(result.current.claimError).not.toContain('SENTINEL_SELLER_PAYMENT_start');

    vi.mocked(CommerceController.beginPaykitClaimFlow).mockReturnValueOnce({
      authorizationUrl: 'pubkyauth://claim',
      awaitClaim: () => Promise.reject(error('complete')),
      cancel: vi.fn(),
    });
    act(() => result.current.startClaim(`xpub${'1'.repeat(107)}`));
    await waitFor(() => expect(result.current.claimStatus).toBe('error'));
    expect(result.current.claimError).not.toContain('SENTINEL_SELLER_PAYMENT_complete');
  });
});
