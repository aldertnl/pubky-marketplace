'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import {
  isPlausibleAccountXpub,
  isStripePaymentLink,
  isStripeRestrictedKey,
  type SellerPaymentConfigOwnView,
} from '@/libs/commerce/payment-methods';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';

type ClaimStatus = 'idle' | 'awaiting' | 'claimed' | 'error';

type ClaimFlow = ReturnType<typeof CommerceController.beginPaykitClaimFlow>;

/**
 * The seller's "Get paid" configuration: stored rails (loaded from the
 * durable service), the save action, and the manual watch-only claim flow.
 * Claim state (`accountClaimed`) is read from paykit-server, so it reflects
 * the Bitkit-driven setup and the manual claim alike.
 */
export function useMarketplaceSellerPaymentConfig() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [config, setConfig] = useState<SellerPaymentConfigOwnView | null>(null);
  const [accountClaimed, setAccountClaimed] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [claimStatus, setClaimStatus] = useState<ClaimStatus>('idle');
  const [claimAuthorizationUrl, setClaimAuthorizationUrl] = useState('');
  const [claimError, setClaimError] = useState<string | null>(null);
  const activeClaimRef = useRef<ClaimFlow | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      const [configResult, claimedResult] = await Promise.allSettled([
        CommerceController.getMyPaymentConfig(),
        CommerceController.isOwnPaykitAccountClaimed(),
      ]);
      if (!active) return;
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value);
      } else {
        Logger.error('Failed to load the payment configuration', { error: configResult.reason });
        setLoadError(
          marketplaceFailureMessage(
            marketplaceErrorCode(configResult.reason),
            MARKETPLACE_FAILURE_MESSAGES.paymentSettings,
            configResult.reason,
          ),
        );
      }
      // A paykit outage must not block the fiat form: claim state renders
      // as unknown instead.
      setAccountClaimed(claimedResult.status === 'fulfilled' ? claimedResult.value : null);
      setIsLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(
    async (input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string;
      stripeRestrictedKey: string;
      paypalMerchantEmail: string;
    }): Promise<boolean> => {
      const stripePaymentLink = input.stripePaymentLink.trim();
      const paypalMerchantEmail = input.paypalMerchantEmail.trim();
      const stripeRestrictedKey = input.stripeRestrictedKey.trim();
      if (stripePaymentLink && !isStripePaymentLink(stripePaymentLink)) {
        toast({
          title: 'Invalid Stripe payment link',
          description: 'Paste the https://buy.stripe.com/… link from your Stripe dashboard.',
        });
        return false;
      }
      if (stripeRestrictedKey && !isStripeRestrictedKey(stripeRestrictedKey)) {
        toast({
          title: 'Invalid Stripe key',
          description:
            'Paste a restricted key (rk_…) with read access to Checkout Sessions. Secret keys (sk_…) are refused and should never leave your Stripe account.',
        });
        return false;
      }
      setIsSaving(true);
      try {
        const saved = await CommerceController.putMyPaymentConfig({
          bitcoinEnabled: input.bitcoinEnabled,
          stripePaymentLink: stripePaymentLink || null,
          // Omit to preserve the stored key; the empty string clears it only
          // when a key exists to clear (an explicit user action in the form).
          ...(stripeRestrictedKey ? { stripeRestrictedKey } : {}),
          paypalMerchantEmail: paypalMerchantEmail || null,
        });
        setConfig(saved);
        toast({ title: 'Payment settings saved' });
        return true;
      } catch (error) {
        Logger.error('Failed to save the payment configuration', { error });
        toast({
          title: 'Saving payment settings failed',
          description: marketplaceFailureMessage(
            marketplaceErrorCode(error),
            MARKETPLACE_FAILURE_MESSAGES.paymentSettingsSave,
          ),
        });
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  const clearStripeKey = useCallback(async (): Promise<boolean> => {
    if (!config) return false;
    setIsSaving(true);
    try {
      const saved = await CommerceController.putMyPaymentConfig({
        bitcoinEnabled: config.bitcoinEnabled,
        stripePaymentLink: config.stripePaymentLink,
        stripeRestrictedKey: '',
        paypalMerchantEmail: config.paypalMerchantEmail,
      });
      setConfig(saved);
      toast({ title: 'Stripe key removed' });
      return true;
    } catch (error) {
      Logger.error('Failed to remove the Stripe key', { error });
      toast({
        title: 'Removing the Stripe key failed',
        description: marketplaceFailureMessage(
          marketplaceErrorCode(error),
          MARKETPLACE_FAILURE_MESSAGES.stripeKeyRemoval,
          error,
        ),
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [config]);

  const cancelClaim = useCallback(() => {
    const flow = activeClaimRef.current;
    activeClaimRef.current = null;
    if (flow) flow.cancel();
    setClaimStatus('idle');
    setClaimAuthorizationUrl('');
    setClaimError(null);
  }, []);

  const startClaim = useCallback((accountXpub: string) => {
    const trimmed = accountXpub.trim();
    if (!isPlausibleAccountXpub(trimmed)) {
      setClaimError(MARKETPLACE_FAILURE_MESSAGES.watchOnlyClaimInvalid);
      setClaimStatus('error');
      return;
    }
    const previous = activeClaimRef.current;
    activeClaimRef.current = null;
    if (previous) previous.cancel();
    setClaimError(null);

    let flow: ClaimFlow;
    try {
      flow = CommerceController.beginPaykitClaimFlow(trimmed);
    } catch (error) {
      Logger.error('Failed to start the watch-only claim flow', { error });
      setClaimError(
        marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.watchOnlyClaimStart),
      );
      setClaimStatus('error');
      return;
    }
    activeClaimRef.current = flow;
    setClaimAuthorizationUrl(flow.authorizationUrl);
    setClaimStatus('awaiting');

    flow
      .awaitClaim()
      .then(() => {
        if (activeClaimRef.current !== flow) return;
        activeClaimRef.current = null;
        setClaimAuthorizationUrl('');
        setClaimStatus('claimed');
        setAccountClaimed(true);
        toast({ title: 'Watch-only account claimed', description: 'Bitcoin payment requests now use this account.' });
      })
      .catch((error: unknown) => {
        if (activeClaimRef.current !== flow) return;
        activeClaimRef.current = null;
        Logger.error('Watch-only claim failed', { error });
        setClaimAuthorizationUrl('');
        setClaimError(
          marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.watchOnlyClaimComplete),
        );
        setClaimStatus('error');
      });
  }, []);

  useEffect(() => {
    return () => {
      const flow = activeClaimRef.current;
      activeClaimRef.current = null;
      if (flow) flow.cancel();
    };
  }, []);

  return {
    isLoading,
    isSaving,
    config,
    accountClaimed,
    loadError,
    save,
    clearStripeKey,
    claimStatus,
    claimAuthorizationUrl,
    claimError,
    startClaim,
    cancelClaim,
  };
}
