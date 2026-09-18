'use client';

import { CalendarClock, SearchX } from 'lucide-react';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { isDurableCommerceMode } from '@/config/commerce';
import type { DropStreamBucket, NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { useMarketplaceDrops } from '@/hooks/useMarketplaceDrops/useMarketplaceDrops';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropCard } from '@/organisms/Marketplace/DropCard';

const SECTION_TITLES: Record<DropStreamBucket, string> = {
  upcoming: 'Upcoming',
  live: 'May be live now',
  ended: 'Ended',
};

const SECTION_ORDER: DropStreamBucket[] = ['live', 'upcoming', 'ended'];

/**
 * The drops calendar (drops design, "Discovery and hype surfaces"): indexed
 * drops in estimate buckets, cards that carry estimate-labeled countdowns,
 * and an honest empty state when the deployment's Nexus does not index
 * drops yet. Nothing here ever claims `live` — the drop page hydrates the
 * authoritative service projection on open.
 */
export function MarketplaceDrops() {
  const { buckets, isIndexed, isLoading, error, adapterMode } = useMarketplaceDrops();
  const totalCount = SECTION_ORDER.reduce((count, bucket) => count + buckets[bucket].length, 0);

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Drops
          </Heading>
          <Typography as="p" className="mt-2 max-w-2xl text-muted-foreground">
            Timed, limited releases with a server-enforced clock. Shelf states and countdowns here are estimates from
            the discovery index — every drop page confirms the real state with the transaction service before showing
            live.
          </Typography>
        </div>

        {!isDurableCommerceMode(adapterMode) && adapterMode !== 'sandbox' ? (
          <EmptyState
            icon={<CalendarClock className="mb-3 size-10 text-muted-foreground" />}
            title="Drops are not available here"
            body="Drops need the durable transaction service — server time is the feature. This deployment runs without it, so there is no drop schedule to show, simulated or otherwise."
          />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : error ? (
          <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200">
            {error}
          </div>
        ) : !isIndexed ? (
          <EmptyState
            icon={<SearchX className="mb-3 size-10 text-muted-foreground" />}
            title="Drop discovery isn't indexed on this deployment yet"
            body="The Nexus here does not serve the drops stream, so there is no calendar to show — open a drop by link and it works normally, including the live claim."
          />
        ) : totalCount === 0 ? (
          <EmptyState
            icon={<CalendarClock className="mb-3 size-10 text-muted-foreground" />}
            title="No drops indexed yet"
            body="When sellers announce drops, they appear here — upcoming first."
          />
        ) : (
          SECTION_ORDER.map((bucket) => <DropSection key={bucket} bucket={bucket} entries={buckets[bucket]} />)
        )}
      </Container>
    </ContentLayout>
  );
}

function DropSection({ bucket, entries }: { bucket: DropStreamBucket; entries: NexusDropStreamEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={SECTION_TITLES[bucket]} className="flex flex-col gap-3">
      <Heading level={2} size="md">
        {SECTION_TITLES[bucket]}
        <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">estimated from index times</span>
      </Heading>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <DropCard key={`${entry.owner_id}:${entry.id}`} entry={entry} bucket={bucket} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 p-8 text-center">
      {icon}
      <Heading level={2} size="md">
        {title}
      </Heading>
      <Typography as="p" className="mt-2 max-w-lg text-sm text-muted-foreground">
        {body}
      </Typography>
    </div>
  );
}
