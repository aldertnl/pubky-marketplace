'use client';

import { useEffect, useState } from 'react';
import { Clock3, Gavel } from 'lucide-react';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { AuctionPhase } from '@/libs/commerce/auction-phase';
import { dropClockOffsetMs, formatDropCountdown } from '@/libs/commerce/drop-clock';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { Logger } from '@/libs/logger/logger';
import type { MarketplaceBidHistory, MarketplaceListingProjection } from '@/services/marketplace/marketplace';

/**
 * Auction transparency panel: the service-corrected end countdown and the
 * bid history as the VISIBLE price progression. Both read the transaction
 * service — the only clock auctions run on and the only authority for bids.
 * Proxy maximums are never served, so nothing here can leak one; bids
 * recorded before the service stored visible prices render without an
 * amount rather than inventing one.
 *
 * Signed-out fallback: the bids read needs a session, so without one the
 * panel shows the seller-signed scheduled end from the record and says the
 * history needs sign-in — never a fabricated history.
 */
export function MarketplaceAuctionPanel({
  sellerPubky,
  listingId,
  auction,
  scheduledEndsAt,
  isSignedIn,
  auctionPhase,
}: {
  sellerPubky: string;
  listingId: string;
  /** The live auction projection, when the viewer has a service session. */
  auction: NonNullable<MarketplaceListingProjection['auction']> | null;
  /** The seller-signed `sale.endsAt` from the record (pre-session fallback). */
  scheduledEndsAt: string | null;
  isSignedIn: boolean;
  auctionPhase?: AuctionPhase;
}) {
  const [history, setHistory] = useState<MarketplaceBidHistory | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState<number | null>(null);
  const [deviceNowMs, setDeviceNowMs] = useState<number | null>(null);
  const bidCount = auction?.bidCount ?? 0;

  useEffect(() => {
    if (!isSignedIn) return;
    let active = true;
    const load = async () => {
      try {
        const bids = await CommerceController.getMarketplaceListingBids(sellerPubky, listingId);
        if (!active || bids === null) return;
        setHistory(bids);
        setClockOffsetMs(dropClockOffsetMs(bids.serverTime, Date.now()));
      } catch (error) {
        Logger.error('Failed to load the auction bid history', { error });
      }
    };
    void load();
    return () => {
      active = false;
    };
    // Refetches whenever the projection reports a new bid.
  }, [isSignedIn, sellerPubky, listingId, bidCount]);

  // Render-loop tick (1s): the countdown is rendering, never a claim — the
  // projection's status stays the authority for active/ended.
  const endsAt = auction?.endsAt ?? history?.auction?.endsAt ?? scheduledEndsAt;
  useEffect(() => {
    if (!endsAt) return;
    setDeviceNowMs(Date.now());
    const timer = window.setInterval(() => setDeviceNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [endsAt]);

  const remainingMs =
    endsAt && deviceNowMs !== null ? Math.max(0, Date.parse(endsAt) - (deviceNowMs + (clockOffsetMs ?? 0))) : null;

  return (
    <div className="grid gap-3 rounded-xl border p-4">
      {endsAt && remainingMs !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Clock3 className="size-4 text-muted-foreground" />
          {auctionPhase !== 'ended' ? (
            <Typography as="p" className="text-sm">
              Ends in <span className="font-semibold tabular-nums">{formatDropCountdown(remainingMs)}</span>
              <span className="text-muted-foreground"> · {new Date(endsAt).toLocaleString()}</span>
            </Typography>
          ) : (
            <Typography as="p" className="text-sm">
              Auction ended {new Date(endsAt).toLocaleString()}
            </Typography>
          )}
          {clockOffsetMs === null && (
            <Typography as="span" className="text-xs text-muted-foreground">
              (device clock)
            </Typography>
          )}
        </div>
      )}
      {auctionPhase === 'ended' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          Bidding is closed for this auction.
        </Typography>
      )}
      {auctionPhase !== 'ended' && remainingMs !== null && (
        <Typography as="p" className="text-xs text-muted-foreground">
          A bid in the final window extends the end time (anti-sniping) — the countdown updates from the
          marketplace&rsquo;s clock, which is the only clock the auction runs on.
        </Typography>
      )}

      <div className="flex items-center gap-2">
        <Gavel className="size-4 text-muted-foreground" />
        <Typography as="h3" className="text-sm font-semibold">
          Bid history
        </Typography>
      </div>
      {!isSignedIn ? (
        <Typography as="p" className="text-sm text-muted-foreground">
          Sign in to see the bid history — it is served by the transaction service, which needs to know who is asking.
        </Typography>
      ) : history === null ? (
        <Typography as="p" className="text-sm text-muted-foreground">
          Loading bid history…
        </Typography>
      ) : history.bids.length === 0 ? (
        <Typography as="p" className="text-sm text-muted-foreground">
          No bids yet.
        </Typography>
      ) : (
        <ol className="grid gap-1">
          {[...history.bids].reverse().map((bid) => (
            <li key={bid.sequence} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                #{bid.sequence} · {bid.bidderPubky.slice(0, 10)}…
              </span>
              <span className="tabular-nums">
                {/* The visible price after this bid — proxy maximums are
                    secret and never served. Older bids may predate the
                    recorded progression. */}
                {bid.visibleAmount ? formatCommerceMoney(bid.visibleAmount) : 'amount not recorded'}
                <span className="text-xs text-muted-foreground"> · {new Date(bid.createdAt).toLocaleString()}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {isSignedIn && history !== null && (
        <Typography as="p" className="text-xs text-muted-foreground">
          Amounts are the visible price after each bid (proxy bidding) — each bidder&rsquo;s private maximum stays
          secret, including from the seller.
        </Typography>
      )}
    </div>
  );
}
