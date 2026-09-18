'use client';

import { useEffect, useState } from 'react';
import { buildFeatureDiscoveryStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { useAuthStore } from '@/stores/auth/auth.store';

interface PromoDismissalState {
  pubky: string | null;
  dismissed: boolean;
  hydrated: boolean;
}

/**
 * Per-account dismissal of the marketplace promo hero, persisted through the
 * same feature-discovery localStorage keys as useCollectionsNavDiscovery.
 * Guests can dismiss for the current session only (no account to key on).
 */
export function useMarketplacePromoDismissal() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [dismissalState, setDismissalState] = useState<PromoDismissalState>({
    pubky: null,
    dismissed: false,
    hydrated: false,
  });

  useEffect(() => {
    if (!currentUserPubky) {
      setDismissalState({ pubky: null, dismissed: false, hydrated: true });
      return;
    }

    try {
      const storageKey = buildFeatureDiscoveryStorageKey(currentUserPubky, MARKETPLACE_PROMO_STORAGE_ID);
      if (new URLSearchParams(window.location.search).get('resetBanner') === '1') {
        window.localStorage.removeItem(storageKey);
      }
      setDismissalState({
        pubky: currentUserPubky,
        dismissed: window.localStorage.getItem(storageKey) === 'dismissed',
        hydrated: true,
      });
    } catch {
      setDismissalState({ pubky: currentUserPubky, dismissed: false, hydrated: true });
    }
  }, [currentUserPubky]);

  const showPromo =
    dismissalState.hydrated && dismissalState.pubky === (currentUserPubky ?? null) && !dismissalState.dismissed;

  const dismissPromo = () => {
    if (!showPromo) return;
    setDismissalState({ pubky: currentUserPubky ?? null, dismissed: true, hydrated: true });
    if (!currentUserPubky) return;

    try {
      const storageKey = buildFeatureDiscoveryStorageKey(currentUserPubky, MARKETPLACE_PROMO_STORAGE_ID);
      window.localStorage.setItem(storageKey, 'dismissed');
    } catch {
      // The in-memory state already hides the promo for this render session.
    }
  };

  return {
    showPromo,
    dismissPromo,
  };
}
