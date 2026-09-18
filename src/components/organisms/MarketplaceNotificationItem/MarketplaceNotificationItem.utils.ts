import { formatCommerceMoney } from '@/libs/commerce/format';
import type { MarketplaceFeedNotification } from '@/pipes/marketplaceNotification/marketplaceNotification.types';

/**
 * Action text rendered after the actor's username, mirroring the social
 * rows' "<username> <action>" grammar. Phrasing stays mechanical — it only
 * claims what the notification type itself asserts. When the payload
 * carries an amount (the §8-permitted monetary context the recipient
 * already sees in a projection), it is appended through
 * `formatCommerceMoney`, so bitcoin renders per BIP-177 (₿ + grouped base
 * units, never "sats"). Exhaustive: adding a notification type fails
 * compilation.
 */
export function getMarketplaceNotificationActionText(
  notification: Pick<MarketplaceFeedNotification, 'type' | 'amount'>,
): string {
  const base = getBaseActionText(notification.type);
  if (!notification.amount) return base;
  const money = formatCommerceMoney(notification.amount);
  switch (notification.type) {
    case 'offer_received':
      return `sent you an offer of ${money}`;
    case 'offer_countered':
      return `countered an offer at ${money}`;
    case 'offer_accepted':
      return `accepted an offer of ${money}`;
    case 'offer_rejected':
      return `declined an offer of ${money}`;
    case 'outbid':
      return `outbid you in an auction — now at ${money}`;
    case 'auction_won':
      return `closed an auction you won at ${money}`;
    case 'auction_ended':
      return `ended an auction at ${money}`;
    default:
      // Other types never carry amounts today; if one ever does, render the
      // mechanical base text rather than inventing phrasing for it.
      return base;
  }
}

function getBaseActionText(type: MarketplaceFeedNotification['type']): string {
  switch (type) {
    case 'message_received':
      return 'sent you a marketplace message';
    case 'offer_received':
      return 'sent you an offer';
    case 'offer_countered':
      return 'countered an offer';
    case 'offer_accepted':
      return 'accepted an offer';
    case 'offer_rejected':
      return 'declined an offer';
    case 'outbid':
      return 'outbid you in an auction';
    case 'auction_won':
      return 'closed an auction you won';
    case 'auction_ended':
      return 'ended an auction';
    case 'order_created':
      return 'placed an order';
    case 'payment_confirmed':
      return 'confirmed payment for an order';
    case 'order_cancelled':
      return 'updated an order cancellation';
    case 'order_cancelled_terms_change':
      return 'cancelled because the seller changed the pickup terms';
    case 'order_shipped':
      return 'shipped your order';
    case 'order_delivery_assumed':
      return 'marked an order delivered automatically';
    case 'order_delivered':
      return 'confirmed delivery of an order';
    case 'order_completed':
      return 'completed an order';
    case 'return_updated':
      return 'updated a return';
    case 'refund_recorded':
      return 'recorded a refund';
    case 'review_received':
      return 'left you a review';
    case 'pickup_details_updated':
      return 'updated the pickup details';
    case 'pickup_details_cleared':
      return 'removed the pickup details';
    case 'pickup_ready':
      return 'marked your order ready for pickup';
  }
}
