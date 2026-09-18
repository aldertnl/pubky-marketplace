'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, ReceiptText } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { isTransactionalCommerceMode } from '@/config/commerce';
import { type MarketplaceOrderView, useMarketplaceOrders } from '@/hooks/useMarketplaceOrders/useMarketplaceOrders';
import { buildCarrierTrackingUrl } from '@/libs/commerce/carriers';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { buyerVisiblePaymentStatus } from '@/libs/commerce/locks-payment';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropEditionBadge, DropEditionReceiptLine } from '@/organisms/Marketplace/DropEditionBadge';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceMyReviews } from '@/organisms/Marketplace/MarketplaceMyReviews';
import { MarketplaceOrderActions } from '@/organisms/Marketplace/MarketplaceOrderActions';
import { MarketplacePaymentStatusCard } from '@/organisms/Marketplace/MarketplacePaymentStatusCard';
import { MarketplaceReauthDialog } from '@/organisms/Marketplace/MarketplaceReauthDialog';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

type OrdersTab = 'to_ship' | 'awaiting_payment' | 'needs_attention' | 'in_transit' | 'completed' | 'cancelled' | 'all';

const ORDER_TABS: { id: OrdersTab; label: string }[] = [
  { id: 'to_ship', label: 'To ship' },
  { id: 'awaiting_payment', label: 'Awaiting payment' },
  { id: 'needs_attention', label: 'Needs attention' },
  { id: 'in_transit', label: 'In transit' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

const SELLER_NEEDS_ATTENTION_STATES: MarketplaceOrder['state'][] = [
  'pending_payment',
  'cancel_requested',
  'return_requested',
  'return_approved',
  'return_received',
];

export function MarketplaceOrders() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const receiptsPublicationStatus = useCommerceStore((state) => state.receiptsPublicationStatus);
  const { orders, isLoading, error, needsSession, refresh, advancePayment, actOnOrder, adapterMode } =
    useMarketplaceOrders();
  const isSandbox = adapterMode === 'sandbox';
  const hasTransactionBackend = isTransactionalCommerceMode(adapterMode);
  const [activeTab, setActiveTab] = useState<OrdersTab>('all');
  const [hasSelectedTab, setHasSelectedTab] = useState(false);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<OrdersTab, HTMLButtonElement | null>>>({});
  const orderCounts = getOrderTabCounts(orders, currentUserPubky);
  const visibleOrders = orders.filter((view) => isOrderInTab(view, activeTab, currentUserPubky));

  useEffect(() => {
    if (hasSelectedTab || !orders.length) return;
    setActiveTab(
      orderCounts.needs_attention > 0
        ? 'needs_attention'
        : orderCounts.awaiting_payment > 0
          ? 'awaiting_payment'
          : orders.some(({ order }) => isCurrentUserSeller(order, currentUserPubky))
            ? 'to_ship'
            : 'all',
    );
  }, [currentUserPubky, hasSelectedTab, orderCounts.awaiting_payment, orderCounts.needs_attention, orders]);

  useEffect(() => {
    const tabList = tabListRef.current;
    const activeTabButton = tabRefs.current[activeTab];
    if (!tabList || !activeTabButton) return;

    const isClipped =
      activeTabButton.offsetLeft < tabList.scrollLeft ||
      activeTabButton.offsetLeft + activeTabButton.offsetWidth > tabList.scrollLeft + tabList.clientWidth;
    if (!isClipped) return;

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    tabList.scrollTo({
      left: Math.max(0, activeTabButton.offsetLeft - (tabList.clientWidth - activeTabButton.offsetWidth) / 2),
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, [activeTab]);

  const chooseTab = (tab: OrdersTab) => {
    setHasSelectedTab(true);
    setActiveTab(tab);
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
      <Container overrideDefaults className="flex w-full flex-col gap-6" data-surface="marketplace-orders">
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Orders
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {isSandbox
              ? 'Buyer and seller timelines with sandbox payment facts.'
              : 'Buyer and seller timelines from the durable transaction service.'}
          </Typography>
        </div>

        {!hasTransactionBackend ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
            <ReceiptText className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              Order timelines are not available here
            </Heading>
            <Typography as="p" className="mt-2 max-w-lg text-sm text-muted-foreground">
              This deployment runs no marketplace transaction backend — neither the sandbox nor the durable transaction
              service — so there is no order history to show, simulated or otherwise.
            </Typography>
          </div>
        ) : isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : needsSession && error ? (
          <MarketplaceSessionRequiredCard />
        ) : error ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4">
            {error}
          </div>
        ) : orders.length ? (
          <>
            <div
              ref={tabListRef}
              className="flex flex-nowrap gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible"
              role="tablist"
              aria-label="Order filters"
            >
              {ORDER_TABS.map((tab) => (
                <Button
                  key={tab.id}
                  type="button"
                  size="sm"
                  variant={activeTab === tab.id ? 'default' : 'ghost'}
                  className="rounded-full"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-label={`${tab.label} ${orderCounts[tab.id]}`}
                  ref={(element) => {
                    tabRefs.current[tab.id] = element;
                  }}
                  onClick={() => chooseTab(tab.id)}
                >
                  {tab.label}
                  <span className="text-xs text-muted-foreground">{orderCounts[tab.id]}</span>
                </Button>
              ))}
            </div>
            <div className="grid gap-4">
              {visibleOrders.map(({ order, payment, receipt }) => {
                const isBuyer = currentUserPubky === order.buyerPubky;
                const nextActorHint = getNextActorHint(order, isBuyer);
                return (
                  <Card key={order.id} className="border py-5">
                    <CardContent className="grid gap-5 px-5 lg:grid-cols-[1fr_auto] lg:items-center">
                      <div>
                        <div className="mb-3 flex flex-wrap gap-2">
                          <Badge variant="outline" className="border-border/60 text-muted-foreground">
                            {isBuyer ? 'You bought' : 'You sold'}
                          </Badge>
                          <Badge variant="secondary">{orderStateLabel(order)}</Badge>
                          {order.fulfillment === 'pickup' && <Badge variant="secondary">Local pickup</Badge>}
                          <DropEditionBadge order={order} />
                          {nextActorHint && (
                            <Badge variant={nextActorHint.isCurrentUser ? 'default' : 'outline'}>
                              {nextActorHint.label}
                            </Badge>
                          )}
                        </div>
                        {order.lines.map((line) => (
                          <div key={line.listingAggregateId}>
                            <Typography as="p" className="font-semibold">
                              {line.title} × {line.quantity}
                            </Typography>
                            {/* The buyer's variant snapshot from checkout. */}
                            {line.variantOptions?.length ? (
                              <Typography as="p" className="text-xs text-muted-foreground">
                                {line.variantOptions.map(({ name, value }) => `${name}: ${value}`).join(' · ')}
                              </Typography>
                            ) : null}
                          </div>
                        ))}
                        <Typography as="p" className="mt-2 text-2xl font-bold text-brand">
                          {formatCommerceMoney(order.total)}{' '}
                          <MarketplaceIndicativePrice money={order.total} className="text-sm font-normal" />
                        </Typography>
                        <Typography as="p" className="mt-1 text-xs text-muted-foreground">
                          Items {formatCommerceMoney(order.subtotal)} · Shipping {formatCommerceMoney(order.shipping)}
                        </Typography>
                        {/* A post-payment terms change (§A3): the buyer is told
                            plainly, and their unilateral exit is named. */}
                        {isBuyer && order.fulfillment === 'pickup' && order.pickupTermsChanged && (
                          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3" role="status">
                            <Typography as="p" className="text-sm text-amber-200">
                              The seller changed the pickup terms since you paid. Show the meeting point to see the
                              terms you paid against — you can cancel this order instantly from the order actions.
                            </Typography>
                          </div>
                        )}
                        {receipt && (
                          <div className="mt-3 flex flex-col gap-1">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <ReceiptText className="size-4 text-brand" />
                              Receipt integrity {receipt.contentHash.slice(0, 12)}…
                            </div>
                            <DropEditionReceiptLine order={order} />
                            {receiptsPublicationStatus === 'needs_reauth' && (
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <Typography as="p" className="text-sm text-muted-foreground">
                                  Receipt not saved to your private storage yet — reconnect to save it
                                </Typography>
                                <MarketplaceReauthDialog triggerLabel="Sign in again" onReauthenticated={refresh} />
                              </div>
                            )}
                          </div>
                        )}
                        {order.shipment && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                            <Typography as="p">
                              {order.shipment.carrier} · {order.shipment.trackingNumber} · {order.shipment.state}
                            </Typography>
                            {/* Only carriers the curated registry can resolve get a
                              link — an unrecognized carrier stays plain text
                              instead of risking a dead tracking URL. */}
                            {(() => {
                              const trackingUrl = buildCarrierTrackingUrl(
                                order.shipment.carrier,
                                order.shipment.trackingNumber,
                              );
                              return trackingUrl ? (
                                <Link
                                  href={trackingUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  overrideDefaults
                                  className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
                                >
                                  Track package
                                  <ExternalLink className="size-3.5" />
                                </Link>
                              ) : null;
                            })()}
                          </div>
                        )}
                        {order.deliveryAssumed && (
                          <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
                            <Typography as="p" className="text-sm text-foreground">
                              Marked delivered automatically after the delivery window; tell the seller if it
                              hasn&apos;t arrived.
                            </Typography>
                            {isBuyer && (
                              <div className="mt-2 max-w-44">
                                <Button asChild variant="secondary" className="rounded-full">
                                  <Link href={MARKETPLACE_ROUTES.MESSAGES} overrideDefaults>
                                    Message seller
                                  </Link>
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        {order.state === 'delivered' && (
                          <Typography as="p" className="mt-2 text-sm text-muted-foreground">
                            Completes automatically after the return window unless a return is requested.
                          </Typography>
                        )}
                        {order.returnRequest && (
                          <Typography as="p" className="mt-2 text-sm text-muted-foreground">
                            Return {order.returnRequest.state}: {order.returnRequest.reason}
                          </Typography>
                        )}
                        {order.externalRefund && (
                          <Typography as="p" className="mt-2 text-sm text-brand">
                            {/* Only ever externally evidenced: Paykit Server cannot spend, so
                              the app records the seller's transaction evidence and never
                              claims it moved funds itself. */}
                            Refund recorded from external evidence: {order.externalRefund.transactionId}
                          </Typography>
                        )}
                        <div className="mt-4">
                          <MarketplacePaymentStatusCard
                            order={order}
                            payment={payment}
                            isBuyer={isBuyer}
                            adapterMode={adapterMode}
                            advancePayment={advancePayment}
                            onPaymentChanged={refresh}
                          />
                        </div>
                      </div>

                      <MarketplaceOrderActions
                        order={order}
                        isBuyer={isBuyer}
                        canEditReview={adapterMode === 'transaction-service'}
                        actOnOrder={actOnOrder}
                        onChanged={refresh}
                      />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <ReceiptText className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No orders yet
            </Heading>
          </div>
        )}

        <MarketplaceMyReviews />
      </Container>
    </ContentLayout>
  );
}

function getOrderTabCounts(orders: MarketplaceOrderView[], currentUserPubky: string | null): Record<OrdersTab, number> {
  return {
    to_ship: orders.filter((view) => isOrderInTab(view, 'to_ship', currentUserPubky)).length,
    awaiting_payment: orders.filter((view) => isOrderInTab(view, 'awaiting_payment', currentUserPubky)).length,
    needs_attention: orders.filter((view) => isOrderInTab(view, 'needs_attention', currentUserPubky)).length,
    in_transit: orders.filter((view) => isOrderInTab(view, 'in_transit', currentUserPubky)).length,
    completed: orders.filter((view) => isOrderInTab(view, 'completed', currentUserPubky)).length,
    cancelled: orders.filter((view) => isOrderInTab(view, 'cancelled', currentUserPubky)).length,
    all: orders.length,
  };
}

function isOrderInTab(
  { order, payment }: MarketplaceOrderView,
  tab: OrdersTab,
  currentUserPubky: string | null,
): boolean {
  switch (tab) {
    case 'to_ship':
      return isCurrentUserSeller(order, currentUserPubky) && order.state === 'paid';
    case 'awaiting_payment':
      return isSellerAwaitingPayment({ order, payment }, currentUserPubky);
    case 'needs_attention':
      return isOrderNeedingCurrentUser(order, currentUserPubky);
    case 'in_transit':
      return ['shipped', 'delivered'].includes(order.state);
    case 'completed':
      return ['completed', 'refunded_external', 'closed'].includes(order.state);
    case 'cancelled':
      return order.state === 'cancelled';
    case 'all':
      return true;
  }
}

function isCurrentUserSeller(order: MarketplaceOrder, currentUserPubky: string | null): boolean {
  return currentUserPubky !== null && order.sellerPubky === currentUserPubky;
}

function isCurrentUserBuyer(order: MarketplaceOrder, currentUserPubky: string | null): boolean {
  return currentUserPubky !== null && order.buyerPubky === currentUserPubky;
}

function isSellerAwaitingPayment(
  { order, payment }: Pick<MarketplaceOrderView, 'order' | 'payment'>,
  currentUserPubky: string | null,
): boolean {
  return (
    isCurrentUserSeller(order, currentUserPubky) &&
    !isCurrentUserBuyer(order, currentUserPubky) &&
    order.state === 'pending_payment' &&
    payment !== null &&
    buyerVisiblePaymentStatus(payment.state) === 'awaiting_entitlement'
  );
}

function isOrderNeedingCurrentUser(order: MarketplaceOrder, currentUserPubky: string | null): boolean {
  if (currentUserPubky === null) return false;
  if (order.nextActor === 'buyer') return isCurrentUserBuyer(order, currentUserPubky);
  if (order.nextActor === 'seller') return isCurrentUserSeller(order, currentUserPubky);
  return isCurrentUserSeller(order, currentUserPubky) && SELLER_NEEDS_ATTENTION_STATES.includes(order.state);
}

/**
 * The state pill. Pickup orders get plain-language labels for their path
 * (§A6): paid means paid-and-not-yet-collected, ready_for_pickup speaks for
 * itself, and a delivered pickup order was handed over in person.
 */
function orderStateLabel(order: MarketplaceOrder): string {
  if (order.fulfillment === 'pickup') {
    switch (order.state) {
      case 'paid':
        return 'Paid';
      case 'ready_for_pickup':
        return 'Ready for pickup';
      case 'delivered':
        return 'Picked up';
    }
  }
  return order.state.replaceAll('_', ' ');
}

function getNextActorHint(order: MarketplaceOrder, isBuyer: boolean): { label: string; isCurrentUser: boolean } | null {
  if (order.nextActor === 'buyer') {
    return isBuyer ? { label: 'Your move', isCurrentUser: true } : { label: 'Waiting on buyer', isCurrentUser: false };
  }
  if (order.nextActor === 'seller') {
    return isBuyer ? { label: 'Waiting on seller', isCurrentUser: false } : { label: 'Your move', isCurrentUser: true };
  }
  return { label: 'No action pending', isCurrentUser: false };
}
