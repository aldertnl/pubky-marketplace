'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { History, Rocket, ShieldCheck } from 'lucide-react';
import { getMarketplaceListingEditRoute, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { useCreateMarketplaceListing } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import { CREATE_MARKETPLACE_LISTING_FIELDS } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceListingForm } from '@/organisms/Marketplace/MarketplaceListingForm';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';

export function MarketplaceSell() {
  const router = useRouter();
  const listing = useCreateMarketplaceListing();
  const [isPublishing, setIsPublishing] = useState(false);

  const submit = async () => {
    setIsPublishing(true);
    try {
      const compositeId = await listing.submit();
      if (!compositeId) return;
      const separator = compositeId.indexOf(':');
      const sellerPubky = compositeId.slice(0, separator);
      const listingId = compositeId.slice(separator + 1);
      // A listing published WITH pickup still needs its meeting point, and
      // the pickup-details editor only exists post-publish (the service
      // accepts pickup_details.set for a registered listing): land the
      // seller on the edit page's pickup section instead of the public page.
      const fulfillment = listing.form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT);
      router.push(
        fulfillment === 'shipping'
          ? getMarketplaceListingRoute(sellerPubky, listingId)
          : `${getMarketplaceListingEditRoute(sellerPubky, listingId)}#listing-section-shipping`,
      );
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container
        overrideDefaults
        data-surface="seller-studio"
        className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8"
      >
        <div>
          <Badge className="mb-4">Seller studio</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Create a listing
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Publish owner-signed item terms, inventory, delivery, returns, and either a fixed price or seven-day
            auction.
          </Typography>
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-brand" />
            Drafts autosave locally. Images are sanitized and BLAKE3 hashed before upload.
          </div>
          <Link href={MARKETPLACE_ROUTES.SETTINGS} className="mt-2 inline-flex">
            Configure Paykit and Locks for digital delivery
          </Link>
        </div>

        {isDurableCommerceMode(getCommerceAdapterMode()) && (
          <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Rocket className="mt-0.5 size-5 shrink-0 text-brand" />
              <div>
                <Typography as="p" className="font-semibold">
                  Drops — timed limited releases
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Bundle listings into a scheduled, capped release the transaction service enforces on server time.
                </Typography>
              </div>
            </div>
            <Button asChild variant="secondary" className="shrink-0 rounded-full">
              <Link href={MARKETPLACE_ROUTES.SELL_DROPS} overrideDefaults>
                Open Drops
              </Link>
            </Button>
          </div>
        )}

        {listing.restoredDraft && (
          <div
            role="status"
            className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <History className="mt-0.5 size-5 shrink-0 text-brand" />
              <div>
                <Typography as="p" className="font-semibold">
                  {listing.seededFromTitle ? `Draft created from ${listing.seededFromTitle}` : 'Draft restored'}
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  {listing.seededFromTitle
                    ? [
                        listing.seededAuctionAsFixedPrice ? 'Auction listings are copied as fixed price.' : null,
                        'Photos were not copied — add them again before publishing.',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    : 'We loaded your unfinished listing from this device. Photos are not part of drafts — add them again before publishing.'}
                </Typography>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 rounded-full"
              disabled={isPublishing}
              onClick={listing.reset}
            >
              Discard draft and start fresh
            </Button>
          </div>
        )}

        {listing.publishBlocked && (
          <div
            role="alert"
            data-surface="seller-publish-blocked"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
          >
            <Typography as="p" className="font-semibold">
              {listing.publishBlocked === 'no-method'
                ? 'Configure a payment method before publishing'
                : 'We could not verify your payment settings. Reconnect your session and try again.'}
            </Typography>
            <Typography as="p" className="mt-1 text-sm text-muted-foreground">
              {listing.publishBlocked === 'no-method'
                ? 'Buyers cannot pay for a published listing until you add at least one payment method.'
                : 'Your payment settings could not be checked against the marketplace service.'}
            </Typography>
            {listing.publishBlocked === 'no-method' ? (
              <Button asChild variant="link" className="mt-2 h-auto p-0">
                <Link href={MARKETPLACE_ROUTES.SETTINGS} overrideDefaults>
                  Payment settings
                </Link>
              </Button>
            ) : (
              <MarketplaceSessionRequiredCard />
            )}
          </div>
        )}

        <MarketplaceListingForm
          form={listing.form}
          media={listing.media}
          onSubmit={submit}
          isPublishing={isPublishing}
        />
      </Container>
    </ContentLayout>
  );
}
