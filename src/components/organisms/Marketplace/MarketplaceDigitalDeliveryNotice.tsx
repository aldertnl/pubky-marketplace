'use client';

import { KeyRound } from 'lucide-react';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Typography } from '@/atoms/Typography/Typography';
import { type CommerceAdapterMode, isLocksPaykitCommerceMode } from '@/config/commerce';

/**
 * Pre-purchase notice on a Locks-guarded digital listing. Purely
 * informational: the payment itself happens after checkout, from the order
 * (see `MarketplacePaymentStatusCard`), where the transaction service
 * independently verifies the Locks entitlement before the order advances.
 */
export function MarketplaceDigitalDeliveryNotice({ adapterMode }: { adapterMode: CommerceAdapterMode }) {
  return (
    <Card className="gap-4 border border-brand/30 py-5">
      <CardContent className="flex items-start gap-3 px-5">
        <div className="rounded-full bg-brand/15 p-2 text-brand">
          <KeyRound className="size-5" />
        </div>
        <div>
          <Typography as="h2" className="font-semibold">
            Locks-protected digital delivery
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            {isLocksPaykitCommerceMode(adapterMode)
              ? 'After checkout, Paykit privately sends the Bitcoin payment request to your wallet, and the content unlocks once the payment is independently verified. Pubky App never receives wallet keys.'
              : 'Buying this item requires the real Locks/Paykit payment rails, which are not enabled in this deployment.'}
          </Typography>
        </div>
      </CardContent>
    </Card>
  );
}
