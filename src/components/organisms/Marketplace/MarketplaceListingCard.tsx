'use client';

import { type CSSProperties,useState } from 'react';
import {
  Bell,
  Camera,
  Disc3,
  Footprints,
  Gavel,
  Gem,
  Heart,
  House,
  Keyboard,
  Package,
  Shirt,
  Star,
} from 'lucide-react';
import { getMarketplaceListingRoute } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Image } from '@/atoms/Image/Image';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useCommerceFavorite } from '@/hooks/useCommerceFavorite/useCommerceFavorite';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { useMarketplaceLiveBid } from '@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { formatCommerceCondition } from '@/libs/commerce/format';
import { cn } from '@/libs/utils/utils';
import { MarketplaceFulfillmentBadge } from '@/molecules/MarketplaceFulfillmentBadge/MarketplaceFulfillmentBadge';
import { MarketplaceCardPrice } from '@/organisms/Marketplace/MarketplaceCardPrice';
import type { CommerceLayout } from '@/stores/commerce/commerce.types';

const MEDIA_BACKGROUNDS = [
  'from-brand/45 via-purple-500/20 to-background',
  'from-cyan-500/40 via-blue-500/20 to-background',
  'from-amber-500/45 via-orange-500/20 to-background',
  'from-emerald-500/40 via-teal-500/20 to-background',
  'from-rose-500/40 via-pink-500/20 to-background',
  'from-slate-400/35 via-zinc-500/20 to-background',
] as const;

export interface MarketplaceListingCardProps {
  listing: MarketplaceCatalogItem;
  shopName?: string;
  layout?: CommerceLayout;
}

/**
 * One catalog card, renderable purely from the Nexus index projection.
 *
 * Truthfulness constraint: live auction state (current bid, bid count) is
 * not part of the listing record or its index projection — it lives in the
 * transaction service. In `transaction-service` mode the card lazily reads
 * the service's public listing projection once it scrolls into view (see
 * `useMarketplaceLiveBid` for the cost model) and, only when at least one
 * bid actually exists, relabels the price as the current bid. In every
 * other case — no bids yet, service unreachable, sandbox or read-only
 * modes — the card shows only the seller's terms from the index: the
 * starting bid (labeled as such, never as a current price) and the end date. An auction whose index row predates the
 * term fields (`auction === null`) simply omits the term badges instead of
 * guessing.
 */
export function MarketplaceListingCard({ listing, shopName, layout = 'grid' }: MarketplaceListingCardProps) {
  const background = MEDIA_BACKGROUNDS[colorIndex(listing.listingId)];
  const isAuction = listing.saleFormat === 'auction';
  const { ref: liveBidRef, bid } = useMarketplaceLiveBid(listing.sellerId, listing.listingId, isAuction);
  const hasLiveBid = isAuction && bid !== null && bid.bidCount > 0;
  // The card's watch toggle IS the favorite — one concept, presented as the
  // watchlist (favorites are the account-scoped store the watchlist reads).
  const watch = useCommerceFavorite(listing.id);
  // The gradient+icon stays rendered UNDER the image, so it is also the
  // loading state; a failed load unmounts the image instead of showing a
  // broken-image icon.
  const [mediaFailed, setMediaFailed] = useState(false);
  const [hoverRotation, setHoverRotation] = useState(0);
  const mediaUrl = useMarketplaceFirstMediaUrl(listing.mediaUrls);
  const showMedia = mediaUrl !== null && !mediaFailed;

  return (
    <Link
      href={getMarketplaceListingRoute(listing.sellerId, listing.listingId)}
      overrideDefaults
      className="group relative block rounded-xl transition-transform duration-300 ease-out outline-none hover:z-10 hover:scale-110 hover:rotate-(--card-hover-rotation) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none"
      style={{ '--card-hover-rotation': `${hoverRotation}deg` } as CSSProperties}
      onMouseEnter={() => setHoverRotation(Math.random() * 14 - 7)}
      aria-label={`View ${listing.title}`}
    >
      <Card
        ref={liveBidRef}
        className={cn(
          'h-full gap-0 overflow-hidden border-0 py-0 transition-all group-hover:shadow-[0_24px_64px_-8px_rgba(0,0,0,0.8),0_8px_24px_rgba(0,0,0,0.5)]',
          layout === 'list' && 'flex-row',
        )}
      >
        <div
          className={cn(
            `relative flex aspect-square items-center justify-center overflow-hidden bg-linear-to-br ${background}`,
            layout === 'list' && 'aspect-square w-36 shrink-0 sm:w-48',
          )}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,0.16),transparent_32%)]" />
          <MarketplaceCategoryIcon categoryId={listing.categoryId} />
          {showMedia && (
            <Image
              src={mediaUrl}
              alt={listing.title}
              fill
              sizes="(max-width: 640px) 50vw, 300px"
              className="absolute inset-0 object-cover"
              onError={() => setMediaFailed(true)}
            />
          )}
          <Badge className="absolute top-3 left-3 gap-1 bg-background/85 text-foreground shadow-sm backdrop-blur-md">
            {isAuction ? (
              <Gavel aria-hidden="true" className="size-3" />
            ) : (
              <Star aria-hidden="true" className="size-3" />
            )}
            {isAuction ? 'Auction' : 'Buy now'}
          </Badge>
          <button
            type="button"
            aria-label={watch.isFavorite ? 'Remove from watchlist' : 'Add to watchlist'}
            aria-pressed={watch.isFavorite}
            disabled={watch.isMutating}
            data-cy="marketplace-card-watch-toggle"
            className="absolute top-2.5 right-2.5 z-10 flex size-8 items-center justify-center rounded-full bg-background/85 text-foreground shadow-sm backdrop-blur-md transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={(event) => {
              // The whole card is a link to the listing; watching must not navigate.
              event.preventDefault();
              event.stopPropagation();
              void watch.toggle();
            }}
          >
            {isAuction ? (
              <Bell className={cn('size-4', watch.isFavorite && 'fill-brand text-brand')} />
            ) : (
              <Heart className={cn('size-4', watch.isFavorite && 'fill-brand text-brand')} />
            )}
          </button>
          {listing.auction && (
            <Badge variant="secondary" className="absolute right-3 bottom-3 bg-background/85 backdrop-blur-md">
              Ends {formatAuctionEnd(listing.auction.endsAt)}
            </Badge>
          )}
        </div>

        <CardContent className="flex min-w-0 flex-1 flex-col gap-4 p-4">
          <div className="space-y-1">
            <Typography as="h2" className="line-clamp-2 text-base leading-6 font-semibold text-foreground">
              {listing.title}
            </Typography>
            <Typography as="p" className="truncate text-sm text-muted-foreground">
              {shopName ?? `${listing.sellerId.slice(0, 8)}…`}
            </Typography>
          </div>
          <div className="mt-auto space-y-1">
            <Label asChild className="text-xs tracking-wide text-muted-foreground uppercase">
              <span>{isAuction ? (hasLiveBid ? 'Current bid' : 'Starting bid') : 'Price'}</span>
            </Label>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Typography as="p" className="text-xl leading-7 font-semibold text-brand">
                <MarketplaceCardPrice money={hasLiveBid ? bid.currentPrice : listing.price} />
              </Typography>
              {hasLiveBid && (
                <Typography as="span" className="text-xs text-muted-foreground">
                  {bid.bidCount} {bid.bidCount === 1 ? 'bid' : 'bids'}
                </Typography>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Typography as="span" className="text-xs text-muted-foreground">
              {formatCommerceCondition(listing.condition)}
            </Typography>
            <MarketplaceFulfillmentBadge methods={listing.fulfillmentMethods} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Deterministic per-listing gradient, seeded by the listing id so the card
// keeps its color whether it rendered from the index projection or from the
// hydrated record. It is the loading/error backdrop for cards with media and
// the honest permanent rendering for cards without any.
function colorIndex(listingId: string): number {
  let sum = 0;
  for (let index = 0; index < listingId.length; index++) {
    sum = (sum + listingId.charCodeAt(index)) % MEDIA_BACKGROUNDS.length;
  }
  return sum;
}

function formatAuctionEnd(endsAt: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(endsAt));
}

function MarketplaceCategoryIcon({ categoryId }: { categoryId: string }) {
  const className = 'size-20 text-foreground opacity-75 drop-shadow-xl transition-transform group-hover:scale-105';
  switch (true) {
    case categoryId.includes('camera'):
      return <Camera aria-hidden="true" className={className} />;
    case categoryId.includes('vinyl'):
      return <Disc3 aria-hidden="true" className={className} />;
    case categoryId.includes('shoes'):
      return <Footprints aria-hidden="true" className={className} />;
    case categoryId.includes('jewelry'):
      return <Gem aria-hidden="true" className={className} />;
    case categoryId.includes('home'):
      return <House aria-hidden="true" className={className} />;
    case categoryId.includes('keyboard'):
      return <Keyboard aria-hidden="true" className={className} />;
    case categoryId.includes('fashion'):
      return <Shirt aria-hidden="true" className={className} />;
    default:
      return <Package aria-hidden="true" className={className} />;
  }
}
