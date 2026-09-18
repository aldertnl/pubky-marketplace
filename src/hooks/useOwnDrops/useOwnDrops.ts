'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { readOwnDropIndex } from '@/hooks/useDropStudio/drop-index';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import type { MarketplaceSellerDrop } from '@/services/marketplace/marketplace-projections';
import { useAuthStore } from '@/stores/auth/auth.store';

export interface OwnDropRow {
  dropId: string;
  /** The seller-signed homeserver record, or null when it could not be read. */
  record: CommerceDropRecord | null;
  /**
   * The transaction service's authoritative seller read. Null means the drop
   * is NOT registered with the service — rendered as "unregistered", never
   * guessed into a state.
   */
  drop: MarketplaceSellerDrop | null;
}

export interface UseOwnDropsResult {
  rows: OwnDropRow[];
  isLoading: boolean;
  isDurable: boolean;
  refresh: () => Promise<void>;
}

/**
 * The seller's drops for the drops home, enumerated from the homeserver's
 * drops directory (`CommerceController.listOwnDropIds` — authoritative,
 * works across devices), merged with the device-local publish index as a
 * freshness supplement for ids published moments ago. Each id is then
 * re-read from BOTH authorities: the homeserver record (title, schedule
 * intent) and the service's seller projection (state, revision). Rows sort
 * newest launch first. Every read failure renders as honest absence on its
 * own row — a missing projection never hides the record and vice versa;
 * an unreachable directory listing degrades to the local index alone.
 */
export function useOwnDrops(): UseOwnDropsResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isDurable = isDurableCommerceMode(getCommerceAdapterMode());
  const [rows, setRows] = useState<OwnDropRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    if (!currentUserPubky) {
      setRows([]);
      setIsLoading(false);
      return;
    }
    const listed = await CommerceController.listOwnDropIds().catch(() => [] as string[]);
    const remembered = readOwnDropIndex(currentUserPubky);
    const dropIds = [...new Set([...listed, ...remembered])];
    const loaded = await Promise.all(
      dropIds.map(async (dropId): Promise<OwnDropRow> => {
        const [record, drop] = await Promise.all([
          CommerceController.fetchDrop(currentUserPubky, dropId).catch(() => null),
          isDurable ? CommerceController.getOwnDrop(dropId).catch(() => null) : Promise.resolve(null),
        ]);
        return { dropId, record, drop };
      }),
    );
    loaded.sort((a, b) => {
      const aStart = a.record ? Date.parse(a.record.startsAt) : 0;
      const bStart = b.record ? Date.parse(b.record.startsAt) : 0;
      return bStart - aStart;
    });
    setRows(loaded);
    setIsLoading(false);
  }, [currentUserPubky, isDurable]);

  useEffect(() => {
    setIsLoading(true);
    void load();
  }, [load]);

  return { rows, isLoading, isDurable, refresh: load };
}
