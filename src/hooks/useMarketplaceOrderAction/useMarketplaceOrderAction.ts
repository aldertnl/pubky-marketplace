'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { getCarrierById, OTHER_CARRIER_ID } from '@/libs/commerce/carriers';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import {
  type MarketplaceOrderActionData,
  marketplaceOrderActionDefaults,
  marketplaceOrderActionSchema,
} from './useMarketplaceOrderAction.types';

export function useMarketplaceOrderAction(
  order: MarketplaceOrder,
  actOnOrder: (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>,
) {
  const form = useForm<MarketplaceOrderActionData>({
    resolver: zodResolver(marketplaceOrderActionSchema),
    defaultValues: marketplaceOrderActionDefaults,
    mode: 'onChange',
  });

  const setAction = (
    action: MarketplaceOrderActionData['action'],
    overrides: Partial<MarketplaceOrderActionData> = {},
  ) => {
    form.reset({
      ...marketplaceOrderActionDefaults,
      action,
      amount: (order.total.amountMinor / 100).toFixed(2),
      ...overrides,
    });
  };

  const submit = async (): Promise<boolean> => {
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      switch (data.action) {
        case 'cancel':
          succeeded = await actOnOrder(order, 'order.cancel_request', { reason: data.reason });
          break;
        case 'ship':
          // The service's `carrier` field is a structured free string; the
          // curated select writes the registry's canonical display name into
          // it (resolvable back to a tracking link on the buyer side), and
          // "Other" passes the seller's own carrier name through verbatim.
          succeeded = await actOnOrder(order, 'fulfillment.ship', {
            carrier:
              data.carrierChoice === OTHER_CARRIER_ID
                ? data.carrier
                : (getCarrierById(data.carrierChoice)?.name ?? data.carrier),
            trackingNumber: data.trackingNumber,
          });
          break;
        case 'return':
          succeeded = await actOnOrder(order, 'return.request', {
            reason: data.reason,
            requestedAmountMinor: Math.round(Number(data.amount) * 100),
          });
          break;
        case 'refund':
          succeeded = await actOnOrder(order, 'refund.record_external', {
            amountMinor: Math.round(Number(data.amount) * 100),
            transactionId: data.transactionId,
          });
          break;
        case 'review':
          succeeded = await actOnOrder(order, 'review.create', {
            rating: Number(data.rating),
            text: data.text,
            // D2 both-sides consent: this is only half the gate — the
            // service includes a band only when the seller also consented.
            allowAmountBand: data.allowAmountBand,
          });
          break;
        case 'review_edit':
          // Durable service only (24h edit window); `actOnOrder` sources
          // `expected_revision` from the freshly loaded order and handles
          // REVISION_CONFLICT with the refetch-and-retry pattern.
          succeeded = await actOnOrder(order, 'review.update', {
            rating: Number(data.rating),
            text: data.text,
          });
          break;
      }
    })();
    return succeeded;
  };

  return { form, setAction, submit };
}
