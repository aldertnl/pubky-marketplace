'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm, type UseFormReturn, useWatch } from 'react-hook-form';
import { COMMERCE_CONTRACT_VERSION, getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { type CommerceDropRecord, commerceDropRecordSchema } from '@/libs/commerce/marketplace-records';
import type { CommerceListingModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { rememberOwnDrop } from './drop-index';
import {
  DROP_MAX_TEASER_MEDIA,
  type DropPublishStatus,
  type DropStudioData,
  dropStudioDefaults,
  type DropStudioListingRegistration,
  dropStudioSchema,
} from './useDropStudio.types';

export interface UseDropStudioResult {
  form: UseFormReturn<DropStudioData>;
  /** The seller's own ACTIVE listings — the only ones a drop may bundle. */
  listings: CommerceListingModelSchema[];
  isLoadingListings: boolean;
  /** Whether drops can operate at all (durable transaction service only). */
  isDurable: boolean;
  /** Registration state per SELECTED listing id (transaction-service truth). */
  registration: Record<string, DropStudioListingRegistration>;
  /** Self-heal one listing: `ensureListingRegistered`, then `listing.sync`, then re-read. */
  registerListing: (listingId: string) => Promise<void>;
  publishStatus: DropPublishStatus;
  /** Readable violations from the record contract (specs builder is the final validator). */
  publishErrors: string[];
  /** The published drop's id once the record PUT succeeded (two-truth: sync may still be pending/failed). */
  publishedDropId: string | null;
  publish: () => Promise<void>;
  /** Re-runs ONLY the service registration after a record-ok / sync-failed publish. */
  retrySync: () => Promise<void>;
}

export function useDropStudio(): UseDropStudioResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const localListings = useLiveQuery(
    () => (currentUserPubky ? CommerceController.getListingsBySeller(currentUserPubky) : []),
    [currentUserPubky],
  );
  const listings = (localListings ?? []).filter(({ state }) => state === 'active');

  const form = useForm<DropStudioData>({
    resolver: zodResolver(dropStudioSchema),
    defaultValues: dropStudioDefaults,
    mode: 'onChange',
  });
  const selectedListingIds = useWatch({ control: form.control, name: 'listingIds' });

  const [registration, setRegistration] = useState<Record<string, DropStudioListingRegistration>>({});
  const checkedIdsRef = useRef(new Set<string>());

  const checkRegistration = useCallback(
    async (listingId: string) => {
      if (!currentUserPubky) return;
      setRegistration((previous) => ({ ...previous, [listingId]: 'checking' }));
      let next: DropStudioListingRegistration;
      try {
        const projection = await CommerceController.getMarketplaceListingProjection(currentUserPubky, listingId);
        next = projection ? 'registered' : 'unregistered';
      } catch {
        next = 'unknown';
      }
      setRegistration((previous) => ({ ...previous, [listingId]: next }));
    },
    [currentUserPubky],
  );

  // One bounded projection read per newly selected listing (≤20 selectable):
  // registration is transaction-service truth, so it is only knowable — and
  // only required — in durable mode.
  useEffect(() => {
    if (!isDurable || !currentUserPubky) return;
    for (const listingId of selectedListingIds) {
      if (checkedIdsRef.current.has(listingId)) continue;
      checkedIdsRef.current.add(listingId);
      void checkRegistration(listingId);
    }
  }, [selectedListingIds, isDurable, currentUserPubky, checkRegistration]);

  const registerListing = async (listingId: string): Promise<void> => {
    if (!currentUserPubky) return;
    const listing = listings.find((row) => row.listing_id === listingId);
    if (!listing) return;
    setRegistration((previous) => ({ ...previous, [listingId]: 'checking' }));
    try {
      // Seller-side heal first (idempotent), then the any-actor `listing.sync`
      // in case the service must fetch the canonical record itself.
      await CommerceController.ensureListingRegistered(listing.record).catch(() => {});
      let projection = await CommerceController.getMarketplaceListingProjection(currentUserPubky, listingId);
      if (!projection) {
        const response = await CommerceController.syncListingRegistration(currentUserPubky, listingId);
        if (response.ok) {
          projection = await CommerceController.getMarketplaceListingProjection(currentUserPubky, listingId);
        }
      }
      setRegistration((previous) => ({ ...previous, [listingId]: projection ? 'registered' : 'unregistered' }));
    } catch {
      setRegistration((previous) => ({ ...previous, [listingId]: 'unknown' }));
      toast({ variant: 'error', description: 'Could not register this listing with the transaction service.' });
    }
  };

  const [publishStatus, setPublishStatus] = useState<DropPublishStatus>({ record: 'idle', sync: 'idle' });
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [publishedDropId, setPublishedDropId] = useState<string | null>(null);

  const runSync = async (owner: string, dropId: string): Promise<void> => {
    setPublishStatus((previous) => ({ ...previous, sync: 'syncing' }));
    try {
      const response = await CommerceController.syncDropRegistration(owner, dropId);
      setPublishStatus((previous) => ({ ...previous, sync: response.ok ? 'ok' : 'failed' }));
      if (!response.ok) {
        toast({ variant: 'error', description: 'The record is on your homeserver, but service registration failed.' });
      }
    } catch {
      setPublishStatus((previous) => ({ ...previous, sync: 'failed' }));
      toast({ variant: 'error', description: 'The record is on your homeserver, but service registration failed.' });
    }
  };

  const publish = async (): Promise<void> => {
    if (!currentUserPubky || !isDurable) return;
    await form.handleSubmit(async (data) => {
      setPublishErrors([]);
      const built = buildDropRecord(currentUserPubky, data, listings);
      if (!built.ok) {
        setPublishErrors(built.errors);
        return;
      }
      setPublishStatus({ record: 'publishing', sync: 'idle' });
      try {
        await CommerceController.publishDrop(built.record);
      } catch (publishError) {
        setPublishStatus({ record: 'failed', sync: 'idle' });
        setPublishErrors([
          publishError instanceof Error && publishError.name === 'AppError'
            ? publishError.message
            : 'Could not publish the drop record to your homeserver.',
        ]);
        return;
      }
      // The record is now a fact on the homeserver — remember it for the
      // device-local drops index regardless of how registration goes.
      rememberOwnDrop(currentUserPubky, built.record.dropId);
      setPublishedDropId(built.record.dropId);
      setPublishStatus({ record: 'ok', sync: 'idle' });
      toast({ title: 'Drop record published', description: 'The seller-signed announcement is on your homeserver.' });
      await runSync(currentUserPubky, built.record.dropId);
    })();
  };

  const retrySync = async (): Promise<void> => {
    if (!currentUserPubky || !publishedDropId) return;
    await runSync(currentUserPubky, publishedDropId);
  };

  return {
    form,
    listings,
    isLoadingListings: localListings === undefined,
    isDurable,
    registration,
    registerListing,
    publishStatus,
    publishErrors,
    publishedDropId,
    publish,
    retrySync,
  };
}

type BuildDropRecordResult = { ok: true; record: CommerceDropRecord } | { ok: false; errors: string[] };

/**
 * Builds the canonical drop record from validated form data and parses it
 * through the SAME contract schema reads use — any violation comes back as
 * readable per-field messages instead of a failed PUT. Teaser media is the
 * first image of each bundled listing (selection order, capped at the
 * record's 10-asset bound): drops announce existing listings, so their own
 * photography is the honest teaser without a second upload pipeline.
 */
export function buildDropRecord(
  ownerPubky: string,
  data: DropStudioData,
  listings: CommerceListingModelSchema[],
): BuildDropRecordResult {
  const now = new Date().toISOString();
  const media = data.listingIds
    .map((listingId) => listings.find((row) => row.listing_id === listingId))
    .flatMap((listing) => {
      const firstImage = listing?.record.media.find((asset) => asset.type === 'image');
      return firstImage ? [firstImage.url] : [];
    })
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, DROP_MAX_TEASER_MEDIA);

  const parsed = commerceDropRecordSchema.safeParse({
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'drop',
    ownerPubky,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    dropId: crypto.randomUUID().replaceAll('-', ''),
    title: data.title,
    description: data.description,
    media,
    format: 'fcfs',
    startsAt: new Date(data.startsAtLocal).toISOString(),
    ...(data.endsAtLocal !== '' ? { endsAt: new Date(data.endsAtLocal).toISOString() } : {}),
    listingIds: data.listingIds,
    totalQuantity: Number(data.totalQuantity),
    perBuyerLimit: Number(data.perBuyerLimit),
    stockDisplay: data.stockDisplay,
  });
  if (parsed.success) return { ok: true, record: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}
