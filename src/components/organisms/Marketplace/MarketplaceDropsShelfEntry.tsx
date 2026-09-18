'use client';

import { ArrowRight, CalendarClock, ChevronRight } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';

const DROPS_TAGLINE =
  'Timed, limited releases on a server-enforced clock — no fake queues, no invented stock, editions you own on your homeserver.';

const DROPS_TAGLINE_COMPACT = 'Timed, limited releases';

/**
 * Home-shelf entry for Drops (ADR 0026). Both variants are always in the
 * markup so SSR HTML matches the client; Tailwind `md` gates which one
 * paints. Compact stays ≤56px below `md` so listing cards remain in the
 * first viewport.
 */
export function MarketplaceDropsShelfEntry() {
  return (
    <>
      <section
        aria-label="Drops"
        data-testid="marketplace-drops-shelf-entry"
        data-variant="compact"
        className="flex h-14 max-h-14 items-center gap-3 overflow-hidden rounded-2xl border border-brand/20 bg-linear-to-r from-brand/10 via-card to-card px-3 md:hidden"
      >
        <div className="shrink-0 rounded-full bg-brand/15 p-1.5 text-brand">
          <CalendarClock className="size-4" aria-hidden />
        </div>
        <Heading level={2} size="sm" className="shrink-0 text-base leading-none">
          Drops
        </Heading>
        <Typography as="p" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {DROPS_TAGLINE_COMPACT}
        </Typography>
        <Link
          href={MARKETPLACE_ROUTES.DROPS}
          overrideDefaults
          className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-brand"
        >
          Browse
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </section>
      <section
        aria-label="Drops"
        data-testid="marketplace-drops-shelf-entry"
        data-variant="desktop"
        className="hidden flex-wrap items-center justify-between gap-4 rounded-2xl border border-brand/20 bg-linear-to-r from-brand/10 via-card to-card p-5 md:flex"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-brand/15 p-2 text-brand">
            <CalendarClock className="size-5" />
          </div>
          <div>
            <Heading level={2} size="md">
              Drops
            </Heading>
            <Typography as="p" className="mt-1 max-w-xl text-sm text-muted-foreground">
              {DROPS_TAGLINE}
            </Typography>
          </div>
        </div>
        <Button asChild className="rounded-full">
          <Link href={MARKETPLACE_ROUTES.DROPS} overrideDefaults>
            Browse drops
            <ArrowRight className="ml-2 size-4" />
          </Link>
        </Button>
      </section>
    </>
  );
}
