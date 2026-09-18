import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { useMarketplaceOrderAction } from './useMarketplaceOrderAction';

describe('useMarketplaceOrderAction ship action', () => {
  it('sends the curated carrier by its canonical display name', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'royal-mail', trackingNumber: 'RN123456785GB' });
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'fulfillment.ship', {
      carrier: 'Royal Mail',
      trackingNumber: 'RN123456785GB',
    });
  });

  it('passes an "Other" carrier through as the seller\'s own free text', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', {
        carrierChoice: 'other',
        carrier: 'Correio da Aldeia',
        trackingNumber: 'CA-0001',
      });
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'fulfillment.ship', {
      carrier: 'Correio da Aldeia',
      trackingNumber: 'CA-0001',
    });
  });

  it('refuses to ship without a tracking number or an unnamed Other carrier', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'usps', trackingNumber: '' });
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(actOnOrder).not.toHaveBeenCalled();

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'other', carrier: '', trackingNumber: 'X-1' });
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(actOnOrder).not.toHaveBeenCalled();
  });
});
