import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { CommerceCatalogAuctionTerms } from '@/models/commerce/commerce.schema';

export type MarketplaceAuctionCatalogItem = MarketplaceCatalogItem & { auction: CommerceCatalogAuctionTerms };

/**
 * Composes the Hot-page "Ending soon" module: active auctions ordered by
 * soonest auction end, capped at `cap`.
 *
 * Deadline-based ordering only — the client holds no bid data (bids live in
 * the transaction service, not the Nexus index), so bid-count ranking is not
 * offered. Auctions whose stale index row predates the auction-term fields
 * (`auction === null`) are excluded rather than ranked by a guessed end time;
 * listing state comes from the index, so no client-side clock decides whether
 * an auction "already ended".
 */
export function composeEndingSoonListings(
  items: MarketplaceCatalogItem[],
  cap: number,
): MarketplaceAuctionCatalogItem[] {
  return items
    .filter(
      (item): item is MarketplaceAuctionCatalogItem =>
        item.state === 'active' && item.saleFormat === 'auction' && item.auction !== null,
    )
    .sort((left, right) => Date.parse(left.auction.endsAt) - Date.parse(right.auction.endsAt))
    .slice(0, cap);
}

/**
 * Composes the Hot-page "Fresh listings" module: active listings ordered by
 * most recent record update, capped at `cap`. `excludeIds` removes listings
 * already shown by a sibling module (ending-soon auctions are usually also
 * recent) so the two modules never duplicate a card.
 */
export function composeFreshListings(
  items: MarketplaceCatalogItem[],
  excludeIds: ReadonlySet<string>,
  cap: number,
): MarketplaceCatalogItem[] {
  return items
    .filter((item) => item.state === 'active' && !excludeIds.has(item.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, cap);
}
