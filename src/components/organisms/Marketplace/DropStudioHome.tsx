'use client';

import { ArrowLeft, Rocket } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useDropStudio } from '@/hooks/useDropStudio/useDropStudio';
import { type OwnDropRow, useOwnDrops } from '@/hooks/useOwnDrops/useOwnDrops';
import type { DropState } from '@/libs/commerce/transaction-contracts';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropStudioComposer } from '@/organisms/Marketplace/DropStudioComposer';
import { useAuthStore } from '@/stores/auth/auth.store';

/**
 * The drops home in the sell area: the seller's drops (each row carrying the
 * AUTHORITATIVE state from the service's seller projection, or a Draft label
 * when the service has no aggregate) above the Drop Studio composer. Drops
 * are durable-mode only — server time is the feature — so every other mode
 * renders the affordance as unavailable, labeled.
 */
export function DropStudioHome() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const drops = useOwnDrops();
  const studio = useDropStudio();

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-4xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          href={MARKETPLACE_ROUTES.SELL}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Sell
        </Link>

        <div>
          <Badge className="mb-4">Seller studio · Drops</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Drops
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Timed, limited releases of your listings. The announcement is a seller-signed record on your homeserver; the
            clock, the caps, and every state come from the transaction service.
          </Typography>
        </div>

        {!studio.isDurable ? (
          <Card className="border-dashed py-5">
            <CardContent className="flex flex-col gap-2 px-5">
              <Typography as="p" className="font-semibold">
                Drops are unavailable in this mode
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Drops require the durable transaction service — server time is the feature. The sandbox cannot honestly
                simulate a server-enforced schedule, so nothing here pretends to.
              </Typography>
            </CardContent>
          </Card>
        ) : !currentUserPubky ? (
          <Card className="border-dashed py-5">
            <CardContent className="px-5">
              <Typography as="p" className="text-sm text-muted-foreground">
                Sign in to compose and run drops.
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <Typography as="h2" className="text-xl font-semibold">
                Your drops
              </Typography>
              {drops.isLoading ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-16 w-full rounded-lg" />
                  <Skeleton className="h-16 w-full rounded-lg" />
                </div>
              ) : drops.rows.length === 0 ? (
                <Card className="border-dashed py-4">
                  <CardContent className="px-5">
                    <Typography as="p" className="text-sm text-muted-foreground">
                      No drops published yet — compose your first one below.
                    </Typography>
                  </CardContent>
                </Card>
              ) : (
                <ul className="flex flex-col gap-2">
                  {drops.rows.map((row) => (
                    <DropStudioHomeRow key={row.dropId} row={row} />
                  ))}
                </ul>
              )}
              <Typography as="p" className="text-xs text-muted-foreground">
                Listed from the drops directory on your homeserver, so drops published from any device appear here. Each
                row is re-read from your homeserver record and the transaction service before anything renders.
              </Typography>
            </section>

            <section className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Rocket className="size-5 text-brand" aria-hidden />
                <Typography as="h2" className="text-xl font-semibold">
                  New drop
                </Typography>
              </div>
              <DropStudioComposer studio={studio} />
            </section>
          </>
        )}
      </Container>
    </ContentLayout>
  );
}

const DROP_STATE_LABELS: Record<DropState, string> = {
  announced: 'Scheduled',
  live: 'Live',
  ended_sold_out: 'Ended',
  ended_closed: 'Ended',
  ended_cancelled: 'Ended',
};

function DropStudioHomeRow({ row }: { row: OwnDropRow }) {
  const startsAtMs = row.record ? Date.parse(row.record.startsAt) : null;
  const endsAtMs = row.record?.endsAt !== undefined ? Date.parse(row.record.endsAt) : null;
  return (
    <li>
      <Link
        href={`${MARKETPLACE_ROUTES.SELL_DROPS}/${row.dropId}`}
        overrideDefaults
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4 hover:border-brand/50"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <Typography as="p" className="truncate font-medium">
            {row.record?.title ?? `Drop ${row.dropId}`}
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            {startsAtMs !== null
              ? `Launch ${new Date(startsAtMs).toLocaleString()}${endsAtMs !== null ? ` → ends ${new Date(endsAtMs).toLocaleString()}` : ' → runs until sell-out or cancel'}`
              : 'The record could not be read from your homeserver.'}
          </Typography>
        </div>
        {row.drop ? (
          <Badge variant={row.drop.state === 'live' ? 'default' : 'secondary'}>
            {DROP_STATE_LABELS[row.drop.state]}
          </Badge>
        ) : (
          <Badge variant="outline">Draft</Badge>
        )}
      </Link>
    </li>
  );
}
