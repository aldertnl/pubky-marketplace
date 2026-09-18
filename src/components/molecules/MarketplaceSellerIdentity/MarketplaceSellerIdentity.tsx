'use client';

import { Store } from 'lucide-react';
import type { CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { Typography } from '@/atoms/Typography/Typography';
import { MarketplaceStarRating } from '@/molecules/MarketplaceStarRating/MarketplaceStarRating';

export interface MarketplaceSellerIdentityProps {
  sellerPubky: string;
  displayName: string;
  avatarUrl?: string | null;
  avatarAlt?: string;
  reputation: CommerceSellerReputationOverview | { status: 'loading' };
  onAvatarError?: () => void;
}

export function MarketplaceSellerIdentity({
  displayName,
  avatarUrl,
  avatarAlt,
  reputation,
  onAvatarError,
}: MarketplaceSellerIdentityProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- homeserver media bypasses Next image optimization
        <img
          src={avatarUrl}
          alt={avatarAlt ?? `${displayName} avatar`}
          className="size-12 shrink-0 rounded-xl object-cover"
          onError={onAvatarError}
        />
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
          <Store className="size-5" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <Typography as="p" className="text-sm text-muted-foreground">
          Sold by
        </Typography>
        <Typography
          as="p"
          className="break-words font-semibold"
        >
          {displayName}
        </Typography>
        {reputation.status === 'rated' && reputation.summary.count > 0 ? (
          <MarketplaceStarRating
            rating={reputation.summary.avg}
            count={reputation.summary.count}
            verifiedCount={reputation.summary.verifiedCount}
            size="sm"
            className="mt-1"
          />
        ) : (
          <Typography as="p" className="mt-1 text-xs text-muted-foreground">
            New seller · no reviews yet
          </Typography>
        )}
      </div>
    </div>
  );
}
