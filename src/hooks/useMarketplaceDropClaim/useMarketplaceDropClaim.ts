'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MARKETPLACE_FAILURE_MESSAGES, marketplaceDropRefusalMessage } from '@/libs/commerce/failure-messages';
import {
  buildMarketplaceCheckoutAggregateId,
  isMarketplaceRevisionConflict,
} from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface UseMarketplaceDropClaimResult {
  /** Saved addresses in picker order (default first); the claim uses the first. */
  addresses: CommerceDeliveryAddressModelSchema[];
  claimAddress: CommerceDeliveryAddressModelSchema | null;
  /** The listing currently submitting; claims are serialized, never parallel. */
  submittingListingId: string | null;
  /** Listings this session claimed successfully (composite `seller:listingId`). */
  claimedListingIds: ReadonlySet<string>;
  /**
   * The last claim refusal, mapped to client-owned static copy.
   */
  failure: string | null;
  needsSession: boolean;
  sessionError: string | null;
  claim: (listingOwnerPubky: string, listingId: string) => Promise<boolean>;
}

/**
 * The FCFS claim (drops design, "At T-0"): one unit of one listing per
 * checkout (the v1 rule), through the EXACT existing checkout path —
 * projection read (with the one-sync listing heal), `checkout.create` with
 * quantity 1, the buyer's saved delivery address, optimistic `submitting`
 * state, then the authoritative result. No queue UI of any kind exists:
 * the service answers reserved or refused, and a refusal renders static
 * client-owned copy.
 */
export function useMarketplaceDropClaim(onClaimed?: () => void | Promise<void>): UseMarketplaceDropClaimResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Connecting a session replaces this store object; the session-required
  // affordance clears without a failed claim attempt.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [submittingListingId, setSubmittingListingId] = useState<string | null>(null);
  const [claimedListingIds, setClaimedListingIds] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const addresses = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getDeliveryAddresses();
    },
    [currentUserPubky],
    [] as CommerceDeliveryAddressModelSchema[],
  );
  const claimAddress = addresses[0] ?? null;

  useEffect(() => {
    if (!marketplaceSession) return;
    setNeedsSession(false);
    setSessionError(null);
  }, [marketplaceSession]);

  const claim = async (listingOwnerPubky: string, listingId: string): Promise<boolean> => {
    if (submittingListingId !== null) return false;
    if (!claimAddress) {
      setFailure(MARKETPLACE_FAILURE_MESSAGES.claimAddress);
      return false;
    }
    const compositeId = `${listingOwnerPubky}:${listingId}`;
    setSubmittingListingId(compositeId);
    setFailure(null);
    try {
      let projection = await CommerceController.getMarketplaceListingProjection(listingOwnerPubky, listingId);
      if (!projection && isDurableCommerceMode(getCommerceAdapterMode())) {
        projection = await syncThenReread(listingOwnerPubky, listingId);
      }
      if (!projection) {
        setFailure(MARKETPLACE_FAILURE_MESSAGES.claimListingUnavailable);
        return false;
      }
      const commandId = crypto.randomUUID();
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId,
        aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
        expectedRevision: 0,
        issuedAt: new Date().toISOString(),
        kind: 'checkout.create',
        payload: {
          lines: [
            {
              listingAggregateId: projection.aggregateId,
              expectedRevision: projection.serverRevision,
              quantity: 1,
            },
          ],
          deliveryAddress: {
            name: claimAddress.name,
            line1: claimAddress.line1,
            line2: claimAddress.line2,
            city: claimAddress.city,
            region: claimAddress.region,
            postalCode: claimAddress.postal_code,
            countryCode: claimAddress.country_code.toUpperCase(),
          },
          guaranteePolicyVersion: 1,
        },
      });
      if (!response.ok) {
        // The service's refusal is classified by stable code and message;
        // arbitrary wire text never reaches rendered state.
        setFailure(
          isMarketplaceRevisionConflict(response)
            ? 'The listing changed while you were claiming. Refresh and try again.'
            : (marketplaceDropRefusalMessage(response.error.code, response.error.message) ??
                MARKETPLACE_FAILURE_MESSAGES.claimRefusal),
        );
        return false;
      }
      setClaimedListingIds((current) => new Set(current).add(compositeId));
      toast({
        title: 'Claimed',
        description: 'The order was recorded by the transaction service. Open Orders to complete the payment.',
      });
      await onClaimed?.();
      return true;
    } catch (claimError) {
      if (isMarketplaceSessionRequiredError(claimError)) {
        setNeedsSession(true);
        setSessionError(MARKETPLACE_FAILURE_MESSAGES.session);
        return false;
      }
      setFailure(MARKETPLACE_FAILURE_MESSAGES.claim);
      return false;
    } finally {
      setSubmittingListingId(null);
    }
  };

  return {
    addresses,
    claimAddress,
    submittingListingId,
    claimedListingIds,
    failure,
    needsSession,
    sessionError,
    claim,
  };
}

/**
 * One `listing.sync` attempt followed by one projection re-read — the same
 * buyer-side heal the cart checkout uses for a listing published before
 * durable-mode registration existed.
 */
async function syncThenReread(sellerPubky: string, listingId: string) {
  try {
    const response = await CommerceController.syncListingRegistration(sellerPubky, listingId);
    if (!response.ok) return null;
    return await CommerceController.getMarketplaceListingProjection(sellerPubky, listingId);
  } catch {
    return null;
  }
}
