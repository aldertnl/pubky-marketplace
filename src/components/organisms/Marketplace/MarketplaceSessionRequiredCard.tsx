'use client';

import { KeyRound } from 'lucide-react';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Shows static Pubky Ring approval copy on durable marketplace surfaces when
 * the durable transport reports `isMarketplaceSessionRequiredError`. Sandbox
 * surfaces never see this card because they do not use the durable transport.
 */
export function MarketplaceSessionRequiredCard({
  onConnected,
}: {
  onConnected?: () => void | Promise<void>;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-56 flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-8 text-center"
    >
      <KeyRound className="size-10 text-muted-foreground" />
      <div>
        <Heading level={2} size="md">
          Approve purchases in Pubky Ring
        </Heading>
        <Typography as="p" className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          One approval lets you buy, bid, and make offers on this marketplace. Nothing is charged until you pay.
        </Typography>
      </div>
      <MarketplaceSessionConnectDialog triggerLabel="Approve in Pubky Ring" onConnected={onConnected} />
    </div>
  );
}
