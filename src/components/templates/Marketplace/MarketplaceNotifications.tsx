'use client';

import { useEffect } from 'react';
import { Bell, Eye, Gavel, HandCoins, MessageCircle } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceNotifications } from '@/hooks/useMarketplaceNotifications/useMarketplaceNotifications';
import { useMarketplaceWatchAlertFeed } from '@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed';
import { useMarketplaceWatchDetection } from '@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection';
import { useRelativeTime } from '@/hooks/useRelativeTime/useRelativeTime';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { Logger } from '@/libs/logger/logger';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import {
  getWatchAlertDetail,
  getWatchAlertHeadline,
} from '@/organisms/MarketplaceWatchAlertItem/MarketplaceWatchAlertItem.utils';
import type { MarketplaceNotification } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';

/** Device-local alerts shown on this page before the service-delivered list. */
const WATCH_ALERTS_SECTION_LIMIT = 6;

export function MarketplaceNotifications() {
  const {
    notifications,
    preferences,
    unreadCount,
    isLoading,
    error,
    needsSession,
    canMarkRead,
    markAllRead,
    updatePreferences,
  } = useMarketplaceNotifications();
  const watchAlerts = useMarketplaceWatchAlertFeed();
  // Opening the commerce activity page also runs the bounded watchlist check.
  useMarketplaceWatchDetection();

  // Re-run once the session is restored, since the writes are account-scoped.
  const isAuthenticated = useAuthStore((state) => state.session !== null);

  // Visiting this surface clears the device-local read state behind the
  // marketplace Activity badge: watch alerts get their real local `seen_at`
  // (the mount-frozen highlights above stay visible), and the activity read
  // checkpoint advances to now — the honest, device-local substitute for the
  // read state the durable service does not store. Sandbox service rows keep
  // their REAL read state and clear only via the Mark all read button.
  const markAllWatchAlertsSeen = watchAlerts.markAllSeen;
  useEffect(() => {
    if (!isAuthenticated) return;
    void markAllWatchAlertsSeen();
    CommerceController.markActivityRead().catch((error) => {
      Logger.warn('Failed to advance the activity read checkpoint', { error });
    });
  }, [isAuthenticated, markAllWatchAlertsSeen]);

  const setPreference = (key: 'messages' | 'offers' | 'bids' | 'auctions', checked: boolean) => {
    if (!preferences) return;
    void updatePreferences({
      messages: preferences.messages,
      offers: preferences.offers,
      bids: preferences.bids,
      auctions: preferences.auctions,
      [key]: checked,
    });
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Transaction history
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              Durable events recorded by the transaction service: orders, payments, offers, bids.
            </Typography>
          </div>
          {canMarkRead ? (
            <Button variant="secondary" className="rounded-full" disabled={unreadCount === 0} onClick={markAllRead}>
              Mark all read
            </Button>
          ) : (
            <Typography as="p" className="max-w-64 text-right text-xs text-muted-foreground">
              The durable marketplace service delivers notifications but does not store read state or preferences yet,
              so they cannot be marked read or filtered here.
            </Typography>
          )}
        </div>

        {preferences && (
          <Card className="border py-4">
            <CardContent className="grid gap-4 px-5 sm:grid-cols-2">
              {(
                [
                  ['messages', 'Messages'],
                  ['offers', 'Offers'],
                  ['bids', 'Bid updates'],
                  ['auctions', 'Auction results'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between gap-4 text-sm">
                  {label}
                  <Switch
                    checked={preferences[key]}
                    onCheckedChange={(checked) => setPreference(key, checked)}
                    aria-label={`${label} notifications`}
                  />
                </label>
              ))}
            </CardContent>
          </Card>
        )}

        {watchAlerts.items.length > 0 && (
          <section aria-label="Watchlist alerts" className="flex flex-col gap-3" data-cy="notifications-watch-alerts">
            <div className="flex flex-wrap items-center gap-2">
              <Eye className="size-4 text-brand" />
              <Heading level={2} size="sm" className="text-lg">
                Watchlist alerts
              </Heading>
              <Typography as="span" className="text-xs text-muted-foreground">
                Detected by checks this device runs when you visit — not server events.
              </Typography>
            </div>
            <Card className="border py-2">
              <CardContent className="flex flex-col gap-1 px-4 py-2">
                {watchAlerts.items.slice(0, WATCH_ALERTS_SECTION_LIMIT).map((alert) => (
                  <WatchAlertRow key={alert.id} alert={alert} />
                ))}
                <Link
                  href={MARKETPLACE_ROUTES.WATCHLIST}
                  overrideDefaults
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  View the full watchlist
                </Link>
              </CardContent>
            </Card>
          </section>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : needsSession && error ? (
          <MarketplaceSessionRequiredCard />
        ) : error ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4">
            {error}
          </div>
        ) : notifications.length ? (
          <div className="flex flex-col gap-3">
            {notifications.map((notification) => (
              <Card key={notification.id} className="border py-4">
                <CardContent className="flex items-center gap-4 px-4">
                  <div className="rounded-full bg-brand/15 p-3 text-brand">
                    <NotificationIcon type={notification.type} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Typography as="p" className="font-semibold">
                      {notificationLabel(notification.type)}
                      {/* §8-permitted monetary context (offer amount, auction
                          visible price), formatted per BIP-177 for bitcoin. */}
                      {notification.amount ? ` · ${formatCommerceMoney(notification.amount)}` : ''}
                    </Typography>
                    <Typography as="p" className="truncate text-sm text-muted-foreground">
                      From {notification.actorPubky.slice(0, 10)}…
                    </Typography>
                  </div>
                  <time dateTime={notification.createdAt} className="text-xs text-muted-foreground">
                    {new Date(notification.createdAt).toLocaleDateString('en-US')}
                  </time>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <Bell className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No commerce updates
            </Heading>
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function WatchAlertRow({ alert }: { alert: ReturnType<typeof useMarketplaceWatchAlertFeed>['items'][number] }) {
  const { formatRelativeTime } = useRelativeTime();
  const detail = getWatchAlertDetail(alert);
  return (
    <Link
      href={alert.href}
      overrideDefaults
      className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-background/60"
    >
      <div className="min-w-0">
        <Typography as="p" className="truncate text-sm font-medium">
          {getWatchAlertHeadline(alert)}: {alert.title}
        </Typography>
        <Typography as="p" className="truncate text-xs text-muted-foreground">
          {detail ? `${detail} · ` : ''}Observed {formatRelativeTime(new Date(alert.timestamp))} by this device
        </Typography>
      </div>
      {alert.isUnseen && <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden />}
    </Link>
  );
}

function NotificationIcon({ type }: { type: MarketplaceNotification['type'] }) {
  switch (type) {
    case 'message_received':
      return <MessageCircle className="size-5" />;
    case 'outbid':
    case 'auction_won':
    case 'auction_ended':
      return <Gavel className="size-5" />;
    default:
      return <HandCoins className="size-5" />;
  }
}

function notificationLabel(type: MarketplaceNotification['type']): string {
  switch (type) {
    case 'message_received':
      return 'New marketplace message';
    case 'offer_received':
      return 'New offer received';
    case 'offer_countered':
      return 'Offer countered';
    case 'offer_accepted':
      return 'Offer accepted';
    case 'offer_rejected':
      return 'Offer declined';
    case 'outbid':
      return 'You were outbid';
    case 'auction_won':
      return 'You won the auction';
    case 'auction_ended':
      return 'Auction ended';
    case 'order_created':
      return 'New order created';
    case 'payment_confirmed':
      return 'Payment confirmed';
    case 'order_cancelled':
      return 'Order cancelled';
    case 'order_cancelled_terms_change':
      return 'Order cancelled — pickup terms changed';
    case 'order_shipped':
      return 'Order shipped';
    case 'order_delivery_assumed':
      return 'Delivery marked automatically';
    case 'order_delivered':
      return 'Delivery confirmed';
    case 'order_completed':
      return 'Order completed';
    case 'return_updated':
      return 'Return updated';
    case 'refund_recorded':
      return 'External refund recorded';
    case 'review_received':
      return 'New review received';
    case 'pickup_details_updated':
      return 'Pickup details updated';
    case 'pickup_details_cleared':
      return 'Pickup details removed';
    case 'pickup_ready':
      return 'Order ready for pickup';
  }
}
