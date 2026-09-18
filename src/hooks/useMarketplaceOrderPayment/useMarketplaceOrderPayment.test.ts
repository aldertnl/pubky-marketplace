import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { useMarketplaceOrderPayment } from './useMarketplaceOrderPayment';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSellerPaymentConfig: vi.fn(),
    bindPaymentMethod: vi.fn(),
    verifyStripePayment: vi.fn(),
    markFiatPaid: vi.fn(),
    confirmFiatReceived: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/libs/logger/logger', () => ({ Logger: { error: vi.fn(), warn: vi.fn() } }));

const appError = (message: string) =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.CONFLICT,
    message,
    service: ErrorService.Marketplace,
    operation: 'payment',
  });

describe('useMarketplaceOrderPayment', () => {
  it('uses static copy when loading seller payment configuration fails', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockRejectedValueOnce(
      appError('SENTINEL_ORDER_PAYMENT_CONFIG'),
    );
    const { result } = renderHook(() =>
      useMarketplaceOrderPayment({ order: createOrderFixture('paid'), enabled: true, onPaymentChanged: vi.fn() }),
    );

    await waitFor(() => expect(result.current.configError).toBeTypeOf('string'));
    expect(result.current.configError).toBeTruthy();
    expect(result.current.configError).not.toContain('SENTINEL_ORDER_PAYMENT_CONFIG');
  });

  it('uses static copy when a payment action fails', async () => {
    vi.mocked(CommerceController.getSellerPaymentConfig).mockResolvedValueOnce({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      stripePaymentLink: null,
      paypalMerchantEmail: null,
    });
    vi.mocked(CommerceController.bindPaymentMethod).mockRejectedValueOnce(appError('SENTINEL_ORDER_PAYMENT_ACTION'));
    const { result } = renderHook(() =>
      useMarketplaceOrderPayment({ order: createOrderFixture('paid'), enabled: true, onPaymentChanged: vi.fn() }),
    );

    await act(async () => {
      await result.current.bind('bitcoin');
    });
    const description = vi.mocked(toast).mock.calls.at(-1)?.[0]?.description;
    expect(description).toBeTypeOf('string');
    expect(description).not.toContain('SENTINEL_ORDER_PAYMENT_ACTION');
  });
});
