'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { AuctionPhase } from '@/libs/commerce/auction-phase';
import { MARKETPLACE_FAILURE_MESSAGES, marketplaceFailureMessage } from '@/libs/commerce/failure-messages';
import { amountInputSchemaForAsset, amountInputToMoney, type CommerceAsset } from '@/libs/commerce/pricing';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import { toast } from '@/molecules/Toaster/use-toast';
import { type MarketplaceBidData, marketplaceBidDefaults, marketplaceBidSchema } from './useMarketplaceBid.types';

export interface UseMarketplaceBidResult {
  form: UseFormReturn<MarketplaceBidData>;
  submit: () => Promise<boolean>;
  reset: () => void;
}

/**
 * `priceAsset` is the auction's own pricing asset: the proxy maximum is built
 * in it (bitcoin bids on bitcoin auctions, USD on USD) because the record and
 * service reject cross-asset amounts.
 */
export function useMarketplaceBid(
  aggregateId: string,
  expectedRevision: number | null,
  onConflict: () => void | Promise<void>,
  priceAsset: CommerceAsset,
  auctionPhase: AuctionPhase = 'live',
): UseMarketplaceBidResult {
  const form = useForm<MarketplaceBidData>({
    resolver: zodResolver(marketplaceBidSchema),
    defaultValues: marketplaceBidDefaults,
    mode: 'onChange',
  });

  const submit = async (): Promise<boolean> => {
    if (expectedRevision === null || auctionPhase === 'ended') return false;
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      const assetCheck = amountInputSchemaForAsset(priceAsset).safeParse(data.maximumAmount);
      if (!assetCheck.success) {
        form.setError('maximumAmount', { message: assetCheck.error.issues[0]?.message ?? 'Enter a valid amount.' });
        return;
      }
      try {
        const response = await CommerceController.executeMarketplaceCommand({
          version: 1,
          commandId: crypto.randomUUID(),
          aggregateId,
          expectedRevision,
          issuedAt: new Date().toISOString(),
          kind: 'auction.place_bid',
          payload: {
            maximumAmount: amountInputToMoney(data.maximumAmount, priceAsset),
          },
        });
        if (!response.ok) {
          if (isMarketplaceRevisionConflict(response)) {
            await onConflict();
            toast({
              variant: 'error',
              description: 'The auction moved since you loaded it. The latest price was reloaded — bid again.',
            });
            return;
          }
          toast({
            variant: 'error',
            description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.bid),
          });
          return;
        }
        succeeded = true;
        toast({ title: 'Bid accepted', description: 'Your private proxy maximum is active.' });
      } catch {
        toast({ variant: 'error', description: 'Could not place this bid.' });
      }
    })();
    return succeeded;
  };

  const reset = () => form.reset(marketplaceBidDefaults);
  return { form, submit, reset };
}
