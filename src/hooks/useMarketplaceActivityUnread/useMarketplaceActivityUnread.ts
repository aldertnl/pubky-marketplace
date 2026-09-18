'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * Device-local unread count for the marketplace Activity entry point.
 *
 * HONESTY CONTRACT (same doctrine as the Messages badge): the durable
 * service stores NO notification read state, so this badge never claims
 * "unread" on the service's behalf. It counts, without overlap:
 *
 * - service notifications, per mode: sandbox rows by their REAL read state
 *   (`readAt`, clearable via `notification.mark_read`); durable rows by a
 *   device-local read checkpoint — only rows created after the last time
 *   THIS device opened an activity surface, cleared by visiting one.
 * - unseen watch alerts — rows this device's own checks produced, whose
 *   `seen_at` read state is real because it is local.
 *
 * The local parts (alerts, checkpoint) are live Dexie reads; the service
 * list is fetched on mount and re-fetched when the session or checkpoint
 * changes. A failed fetch contributes zero — the badge may lag reality but
 * can never invent it. Zero renders no badge.
 */
export function useMarketplaceActivityUnread(): number {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object (the
  // same wiring the activity page's own notifications hook relies on).
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const adapterMode = getCommerceAdapterMode();
  const [notificationCount, setNotificationCount] = useState(0);

  const local = useLiveQuery(async () => {
    if (!currentUserPubky) return { unseenAlertCount: 0, checkpoint: 0 };
    const [alerts, checkpoint] = await Promise.all([
      CommerceController.getWatchAlerts(),
      CommerceController.getActivityReadCheckpoint(),
    ]);
    return {
      unseenAlertCount: alerts.filter(({ seen_at }) => seen_at === null).length,
      checkpoint,
    };
  }, [currentUserPubky]);

  const checkpoint = local?.checkpoint;

  useEffect(() => {
    if (!currentUserPubky || adapterMode === 'unavailable' || checkpoint === undefined) {
      setNotificationCount(0);
      return;
    }
    let active = true;
    CommerceController.getMarketplaceNotifications()
      .then((notifications) => {
        if (!active) return;
        setNotificationCount(
          adapterMode === 'sandbox'
            ? notifications.filter(({ readAt }) => !readAt).length
            : notifications.filter(({ createdAt }) => new Date(createdAt).getTime() > checkpoint).length,
        );
      })
      .catch((error) => {
        if (!active) return;
        setNotificationCount(0);
        Logger.warn('Failed to load the marketplace activity badge count', { error });
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, adapterMode, checkpoint, marketplaceSession]);

  return notificationCount + (local?.unseenAlertCount ?? 0);
}
