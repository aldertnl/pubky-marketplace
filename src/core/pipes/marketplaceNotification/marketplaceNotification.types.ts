import type { MarketplaceNotification } from '@/services/marketplace/marketplace';

/**
 * A marketplace notification prepared for the app's general notification
 * surface. Built field-by-field from the transactional projection — never by
 * spreading it — so the general surface can only ever see the redacted set
 * ADR-0019 §8 allows a notification to carry: a type, the acting pubky, an
 * opaque aggregate reference, a timestamp, and (where the recipient already
 * sees the figure in a role-scoped projection) a monetary amount. Order
 * contents, payment detail, delivery info, and message bodies never reach
 * this shape because the fields simply do not exist on it.
 */
export type MarketplaceFeedNotification = {
  /** `marketplace:${uuid}` — namespaced so it can never collide with a social business key. */
  id: string;
  /** Discriminates marketplace rows from social `FlatNotification`s in shared UI. */
  source: 'marketplace';
  type: MarketplaceNotification['type'];
  actorPubky: string;
  /** Opaque aggregate reference (`order:…`, `offer:…`, `listing:…`, `conversation:…`). */
  aggregateId: string;
  /** Millisecond epoch derived from the projection's `createdAt`. */
  timestamp: number;
  /**
   * Whether the row still counts as unread. Only the sandbox stores read
   * state (`readAt` + `notification.mark_read`); the durable service delivers
   * immutable outbox rows, so in `transaction-service` mode this is always
   * false — an unread marker the user could never clear would be a lie.
   */
  isUnread: boolean;
  /** Deep link to the marketplace surface that shows the referenced aggregate. */
  href: string;
  /**
   * Optional monetary context, carried only where ADR-0019 §8 permits: the
   * recipient already reads this exact figure in a role-scoped projection
   * (the offer amount on offer notifications, the auction's visible price on
   * `outbid`/`auction_won`/`auction_ended`). Never address- or
   * payment-bearing. Absent on sandbox rows and on service rows delivered
   * before amounts existed.
   */
  amount?: { amountMinor: number; currency: string; exponent: number };
};

/** Exactly the keys a `MarketplaceFeedNotification` may carry, for redaction tests. */
export const MARKETPLACE_FEED_NOTIFICATION_KEYS = [
  'id',
  'source',
  'type',
  'actorPubky',
  'aggregateId',
  'timestamp',
  'isUnread',
  'href',
  'amount',
] as const;
