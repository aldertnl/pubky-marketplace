'use client';

import { type CSSProperties,useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { getMarketplaceDropRoute } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode } from '@/config/commerce';
import type { DropStreamBucket, NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { cn } from '@/libs/utils/utils';
import type { CommerceLayout } from '@/stores/commerce/commerce.types';

const BUCKET_BADGES: Record<DropStreamBucket, string> = {
  upcoming: 'Upcoming · estimate',
  live: 'May be live',
  ended: 'Ended · estimate',
};

/**
 * One indexed drop on the shelf/calendar (drops design, "Discovery and hype
 * surfaces"). Everything here is INDEX data: the state chip and the
 * countdown are labeled estimates, and no claim affordance ever renders
 * from a card — opening the page hydrates the authoritative service
 * projection first.
 */
export function DropCard({
  entry,
  bucket,
  layout = 'grid',
}: {
  entry: NexusDropStreamEntry;
  bucket: DropStreamBucket;
  layout?: CommerceLayout;
}) {
  const isDemo = getCommerceAdapterMode() === 'sandbox' && entry.owner_id === 'demo-studio';
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [hoverRotation, setHoverRotation] = useState(0);
  const mediaUrl = useMarketplaceFirstMediaUrl(entry.media_urls);
  return (
    <>
      <Link
        href={getMarketplaceDropRoute(entry.owner_id, entry.id)}
        onClick={
          isDemo
            ? (event) => {
                event.preventDefault();
                setPreviewOpen(true);
              }
            : undefined
        }
        overrideDefaults
        className="group relative block rounded-xl transition-transform duration-300 ease-out outline-none hover:z-10 hover:scale-110 hover:rotate-(--card-hover-rotation) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:transition-none"
        style={{ '--card-hover-rotation': `${hoverRotation}deg` } as CSSProperties}
        onMouseEnter={() => setHoverRotation(Math.random() * 14 - 7)}
        aria-label={`View ${entry.title}`}
      >
        <Card
          className={cn(
            'h-full gap-0 overflow-hidden border-0 py-0 transition-all group-hover:shadow-[0_24px_64px_-8px_rgba(0,0,0,0.8),0_8px_24px_rgba(0,0,0,0.5)]',
            layout === 'list' && 'flex-row',
          )}
        >
          <div
            className={cn(
              'relative flex aspect-square items-center justify-center overflow-hidden bg-linear-to-br from-brand/45 via-purple-500/20 to-background',
              layout === 'list' && 'aspect-square w-36 shrink-0 sm:w-48',
            )}
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,0.16),transparent_32%)]" />
            <CalendarClock className="size-16 text-white opacity-80" aria-hidden="true" />
            {mediaUrl && !mediaFailed && (
              <Image
                src={mediaUrl}
                alt={entry.title}
                fill
                sizes="(max-width: 640px) 50vw, 300px"
                className="absolute inset-0 object-cover"
                onError={() => setMediaFailed(true)}
              />
            )}
            <Badge className="absolute top-3 left-3 gap-1 bg-background/85 text-foreground shadow-sm backdrop-blur-md">
              <CalendarClock aria-hidden="true" className="size-3" />
              Drop
            </Badge>
          </div>
          <CardContent className="flex min-w-0 flex-1 flex-col gap-4 p-4">
            <div className="space-y-1">
              <Typography as="h2" className="line-clamp-2 text-base leading-6 font-semibold text-foreground">
                {entry.title}
              </Typography>
              <Typography as="p" className="truncate text-sm text-muted-foreground">
                {isDemo ? 'Demo studio' : `${entry.owner_id.slice(0, 8)}…`}
              </Typography>
            </div>
            <div className="mt-auto space-y-1">
              <Typography as="p" className="text-xs text-muted-foreground">
                {bucket === 'upcoming' ? 'Scheduled start' : 'Drop status'}
              </Typography>
              <Typography as="p" className="text-xl leading-7 font-semibold text-foreground">
                {bucket === 'upcoming'
                  ? new Intl.DateTimeFormat('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(entry.starts_at))
                  : BUCKET_BADGES[bucket]}
              </Typography>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
              <Typography as="span" className="text-xs text-muted-foreground">
                {isDemo ? 'Preview only' : bucket === 'upcoming' ? 'Estimated time' : 'Open to confirm'}
              </Typography>
              {entry.total_quantity != null && <Badge variant="secondary">{entry.total_quantity} editions</Badge>}
            </div>
          </CardContent>
        </Card>
      </Link>
      {isDemo && (
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent>
            <DialogTitle>{entry.title}</DialogTitle>
            <DialogDescription>{entry.description}</DialogDescription>
            <Typography className="text-sm text-muted-foreground">
              Demo preview · {entry.total_quantity} editions · one per person. Purchases and claims are disabled.
            </Typography>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
