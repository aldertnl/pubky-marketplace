'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bell, Heart, MapPin, Package, PlaneTakeoff, ShieldCheck, ShoppingCart, Store } from 'lucide-react';
import { APP_ROUTES, getMarketplaceShopRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { TagKind } from '@/application/tag/tag.types';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isTransactionalCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceFavorite } from '@/hooks/useCommerceFavorite/useCommerceFavorite';
import { useMarketplaceCart } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import { useMarketplaceMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceProjection } from '@/hooks/useMarketplaceProjection/useMarketplaceProjection';
import { useSellerReputation } from '@/hooks/useMarketplaceReviews/useMarketplaceReviews';
import { useMeasurementSystem } from '@/hooks/useMeasurementSystem/useMeasurementSystem';
import { getAuctionPhase } from '@/libs/commerce/auction-phase';
import { formatCommerceCondition, formatCommerceMoney } from '@/libs/commerce/format';
import {
  commerceListingFulfillmentMethods,
  type CommerceListingRecord,
  type CommerceShippingOption,
} from '@/libs/commerce/marketplace-records';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { formatPackageDimensions, formatWeight } from '@/libs/commerce/units';
import { MarketplaceFulfillmentBadge } from '@/molecules/MarketplaceFulfillmentBadge/MarketplaceFulfillmentBadge';
import { MarketplaceSellerIdentity } from '@/molecules/MarketplaceSellerIdentity/MarketplaceSellerIdentity';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceAuctionPanel } from '@/organisms/Marketplace/MarketplaceAuctionPanel';
import { MarketplaceBidDialog } from '@/organisms/Marketplace/MarketplaceBidDialog';
import { MarketplaceCommunityTags } from '@/organisms/Marketplace/MarketplaceCommunityTags';
import { MarketplaceDigitalDeliveryNotice } from '@/organisms/Marketplace/MarketplaceDigitalDeliveryNotice';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceListingOwnerPanel } from '@/organisms/Marketplace/MarketplaceListingOwnerPanel';
import { MarketplaceListingSavePicker } from '@/organisms/Marketplace/MarketplaceListingSavePicker';
import { MarketplaceListingSpecifics } from '@/organisms/Marketplace/MarketplaceListingSpecifics';
import { MarketplaceMediaGallery } from '@/organisms/Marketplace/MarketplaceMediaGallery';
import { MarketplaceMessageDialog } from '@/organisms/Marketplace/MarketplaceMessageDialog';
import { MarketplaceOfferDialog } from '@/organisms/Marketplace/MarketplaceOfferDialog';
import { MarketplaceReviewsSection } from '@/organisms/Marketplace/MarketplaceReviewsSection';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceListingDetailSkeleton } from './Marketplace.skeleton';

export interface MarketplaceListingProps {
  sellerPubky: string;
  listingId: string;
}

export function MarketplaceListing({ sellerPubky, listingId }: MarketplaceListingProps) {
  const [error, setError] = useState<string | null>(null);
  // Local cache answers `null` instantly for a listing this device has never
  // seen, while the network fetch is still in flight — without tracking the
  // fetch, the page flashes "Listing unavailable" before the record lands.
  const [isFetchSettled, setIsFetchSettled] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [showSessionRequired, setShowSessionRequired] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const adapterMode = getCommerceAdapterMode();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isOwner = currentUserPubky === sellerPubky;
  const favorite = useCommerceFavorite(`${sellerPubky}:${listingId}`);
  const negotiation = useMarketplaceProjection(sellerPubky, listingId);
  const sellerReputation = useSellerReputation(sellerPubky);
  const cart = useMarketplaceCart();
  const measurementSystem = useMeasurementSystem();
  const aggregateId = buildMarketplaceListingAggregateId(sellerPubky, listingId);

  useEffect(() => {
    if (adapterMode === 'sandbox') {
      setIsFetchSettled(true);
      return;
    }
    let active = true;
    setIsFetchSettled(false);
    CommerceController.getOrFetchListing(sellerPubky, listingId)
      .catch(() => {
        if (active) setError('This listing could not be loaded.');
      })
      .finally(() => {
        if (active) setIsFetchSettled(true);
      });
    return () => {
      active = false;
    };
  }, [adapterMode, listingId, sellerPubky]);

  const listing = useLiveQuery(() => CommerceController.getListing(sellerPubky, listingId), [sellerPubky, listingId]);
  const shop = useLiveQuery(() => CommerceController.getShop(sellerPubky), [sellerPubky]);
  const auctionEndsAt =
    listing?.record.sale.format === 'auction'
      ? (negotiation.projection?.auction?.endsAt ?? listing.record.sale.endsAt)
      : null;
  const auctionStatus = negotiation.projection?.auction?.status;
  const auctionPhase =
    listing?.record.sale.format === 'auction'
      ? getAuctionPhase(listing.record.sale.startsAt, auctionEndsAt ?? listing.record.sale.endsAt, nowMs, auctionStatus)
      : null;
  const shopAvatarUrl = useMarketplaceMediaUrl(shop?.record.avatarUrl);

  useEffect(() => {
    const firstVariant = listing?.record.variants[0]?.id;
    if (firstVariant && !listing?.record.variants.some(({ id }) => id === selectedVariantId)) {
      setSelectedVariantId(firstVariant);
    }
  }, [listing, selectedVariantId]);

  useEffect(() => {
    if (!negotiation.needsSession) setShowSessionRequired(false);
  }, [negotiation.needsSession]);

  useEffect(() => {
    if (!auctionEndsAt) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [auctionEndsAt]);

  if (listing === undefined || shop === undefined || (!listing && !isFetchSettled && !error)) {
    return (
      <ContentLayout
        showLeftSidebar={false}
        showRightSidebar={false}
        showLeftMobileButton={false}
        showRightMobileButton={false}
      >
        <Container overrideDefaults className="w-full px-4 sm:px-6">
          <MarketplaceListingDetailSkeleton />
        </Container>
      </ContentLayout>
    );
  }

  if (!listing || error) {
    return (
      <ContentLayout
        showLeftSidebar={false}
        showRightSidebar={false}
        showLeftMobileButton={false}
        showRightMobileButton={false}
      >
        <Container className="min-h-96 items-center justify-center px-6 text-center">
          <Store className="mb-4 size-12 text-muted-foreground" />
          <Heading level={1} size="lg">
            Listing unavailable
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {error ?? 'This listing is no longer in the local marketplace catalog.'}
          </Typography>
          <Button asChild className="mt-6 rounded-full">
            <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
              Back to marketplace
            </Link>
          </Button>
        </Container>
      </ContentLayout>
    );
  }

  const record = listing.record;
  const selectedVariant = record.variants.find(({ id }) => id === selectedVariantId) ?? record.variants[0];
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  const displayPrice = negotiation.projection?.auction?.currentPrice ?? price;
  const sellerDisplayName = shop?.record.name ?? `${sellerPubky.slice(0, 10)}…`;
  const recordQuantity = record.variants.reduce(
    (total, variant) => total + (variant.enabled ? variant.quantity : 0),
    0,
  );
  const isSoldOut = (listing.purchasableQuantity ?? recordQuantity) <= 0;
  const isPurchasable = record.state === 'active';
  const stateNotice =
    record.state === 'paused'
      ? 'The seller has unlisted this item. It cannot be purchased right now.'
      : record.state === 'ended'
        ? 'This listing has ended.'
        : record.state === 'removed'
          ? 'This listing was removed.'
          : null;
  const revealSessionRequired = () => setShowSessionRequired(true);
  const onSessionConnected = () => {
    setShowSessionRequired(false);
    void negotiation.refresh();
  };
  const addSelectedVariantToCart = () => {
    if (!selectedVariant) return;
    void cart.add(`${record.ownerPubky}:${record.listingId}`, selectedVariant.id, 1);
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
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div className="flex w-full items-center justify-between gap-2">
          {cart.itemCount > 0 && (
            <Link
              href={MARKETPLACE_ROUTES.CART}
              overrideDefaults
              data-cy="marketplace-listing-cart-link"
              className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-sm text-foreground transition-colors hover:border-brand/40 hover:text-brand"
            >
              <ShoppingCart className="size-4" />
              Cart
              <Badge variant="secondary" className="px-1.5">
                {cart.itemCount}
              </Badge>
            </Link>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <MarketplaceMediaGallery
            media={record.media}
            saleFormat={record.sale.format}
            auctionPhase={auctionPhase ?? undefined}
          />

          <div className="flex flex-col gap-5">
            {isOwner && <MarketplaceListingOwnerPanel record={record} />}
            {stateNotice && (
              <div
                role="status"
                className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"
              >
                {stateNotice}
              </div>
            )}
            <div>
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="secondary">{formatCommerceCondition(record.condition)}</Badge>
                <MarketplaceFulfillmentBadge methods={commerceListingFulfillmentMethods(record.fulfillmentMethods)} />
                {isSoldOut && record.sale.format === 'fixed_price' && <Badge variant="outline">Sold out</Badge>}
                {shop?.record.vacationMode && (
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-300">
                    <PlaneTakeoff className="mr-1 size-3" />
                    Seller on vacation
                  </Badge>
                )}
                {adapterMode === 'sandbox' && <Badge variant="outline">Sandbox · no real funds</Badge>}
              </div>
              <Heading level={1} size="xl" className="text-3xl leading-tight sm:text-5xl">
                {record.title}
              </Heading>
              <Typography as="p" className="mt-3 text-3xl font-bold text-brand">
                {record.sale.format === 'auction'
                  ? negotiation.projection?.auction?.bidCount
                    ? 'Current bid '
                    : 'Starting at '
                  : ''}
                {formatCommerceMoney(displayPrice)}
              </Typography>
              <MarketplaceIndicativePrice money={displayPrice} className="text-sm" />
              <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                {formatListingShipping(record)}
              </Typography>
              {negotiation.projection?.auction && (
                <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                  {negotiation.projection.auction.bidCount}{' '}
                  {negotiation.projection.auction.bidCount === 1 ? 'bid' : 'bids'} ·{' '}
                  {negotiation.projection.auction.reserveMet ? 'Reserve met' : 'Reserve not met'}
                </Typography>
              )}
            </div>

            <Card className="gap-4 border py-5">
              <CardContent className="flex flex-col gap-4 px-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 sm:min-w-[12rem]">
                  <MarketplaceSellerIdentity
                    sellerPubky={sellerPubky}
                    displayName={sellerDisplayName}
                    avatarUrl={shopAvatarUrl}
                    avatarAlt={`${shop?.record.name ?? 'Shop'} avatar`}
                    reputation={sellerReputation}
                  />
                  {isOwner && !shop && (
                    <Typography as="p" className="mt-2 text-sm text-muted-foreground">
                      You haven&apos;t created a shop yet — buyers only see your key.
                    </Typography>
                  )}
                </div>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  {isOwner && !shop ? (
                    <Button asChild size="sm" className="rounded-full">
                      <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                        Set up your shop
                      </Link>
                    </Button>
                  ) : (
                    <Button asChild variant="secondary" size="sm" className="rounded-full">
                      <Link href={getMarketplaceShopRoute(sellerPubky)} overrideDefaults>
                        View shop
                      </Link>
                    </Button>
                  )}
                  <div>
                    <MarketplaceMessageDialog sellerPubky={sellerPubky} listingId={listingId} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Typography as="p" className="text-base leading-7 text-muted-foreground">
              {record.description}
            </Typography>

            <MarketplaceListingSpecifics record={record} />

            {record.tags.length > 0 && (
              <div className="flex flex-col gap-2">
                <Typography as="p" className="text-sm font-semibold">
                  Seller&apos;s keywords
                </Typography>
                <div className="flex flex-wrap gap-2" data-cy="marketplace-seller-keywords">
                  {record.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      #{tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <MarketplaceCommunityTags
              target={{ kind: TagKind.LISTING, sellerPubky: record.ownerPubky, listingId: record.listingId }}
            />

            <MarketplaceReviewsSection sellerPubky={record.ownerPubky} listingId={record.listingId} />

            {record.variants.length > 1 && (
              <div>
                <Typography as="p" className="mb-2 text-sm font-semibold">
                  Variant
                </Typography>
                <Select value={selectedVariant?.id} onValueChange={setSelectedVariantId}>
                  <SelectTrigger className="h-11 w-full rounded-md border px-3" aria-label="Choose listing variant">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {record.variants.map((variant) => (
                      <SelectItem
                        key={variant.id}
                        value={variant.id}
                        disabled={!variant.enabled || variant.quantity === 0}
                      >
                        {Object.values(variant.options).join(' · ') || variant.sku || 'Default'} · {variant.quantity}{' '}
                        left
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
                <MapPin className="size-5 text-brand" />
                <div>
                  <Typography as="p" className="text-sm font-semibold">
                    Ships from
                  </Typography>
                  <Typography as="p" className="text-sm text-muted-foreground">
                    {record.location.region ? `${record.location.region}, ` : ''}
                    {record.location.countryCode}
                  </Typography>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
                <ShieldCheck className="size-5 text-brand" />
                <div>
                  <Typography as="p" className="text-sm font-semibold">
                    Owner-signed
                  </Typography>
                  <Typography as="p" className="text-sm text-muted-foreground">
                    Revision {record.revision}
                  </Typography>
                </div>
              </div>
              {record.package && (
                <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
                  <Package className="size-5 text-brand" />
                  <div>
                    <Typography as="p" className="text-sm font-semibold">
                      Package
                    </Typography>
                    <Typography as="p" className="text-sm text-muted-foreground">
                      {formatWeight(record.package.weightGrams, measurementSystem)} ·{' '}
                      {formatPackageDimensions(record.package, measurementSystem)}
                    </Typography>
                  </div>
                </div>
              )}
            </div>

            {record.digitalLock && <MarketplaceDigitalDeliveryNotice adapterMode={adapterMode} />}

            {record.sale.format === 'auction' && (
              <MarketplaceAuctionPanel
                sellerPubky={sellerPubky}
                listingId={listingId}
                auction={negotiation.projection?.auction ?? null}
                scheduledEndsAt={record.sale.endsAt ?? null}
                isSignedIn={Boolean(currentUserPubky)}
                auctionPhase={auctionPhase ?? undefined}
              />
            )}

            {/* flex-wrap: four buttons exceed narrow viewports' min-content width,
                and a non-wrapping row would overflow the grid column — clipping
                the watch and collection buttons off-screen entirely. */}
            <div className="mt-auto flex flex-wrap gap-3">
              {record.sale.format === 'auction' ? (
                <div className="[&_[data-slot=button]]:border-brand [&_[data-slot=button]]:bg-brand [&_[data-slot=button]]:text-background [&_[data-slot=button]:hover]:bg-brand/90">
                  <MarketplaceBidDialog
                    aggregateId={aggregateId}
                    projection={negotiation.projection}
                    priceAsset={price}
                    isSessionRequired={negotiation.needsSession}
                    onSessionRequired={revealSessionRequired}
                    onAccepted={negotiation.refresh}
                    auctionPhase={auctionPhase ?? undefined}
                  />
                </div>
              ) : (
                <>
                  <Button
                    size="lg"
                    className="flex-1 rounded-full"
                    disabled={
                      adapterMode === 'unavailable' ||
                      !isPurchasable ||
                      !selectedVariant ||
                      selectedVariant.quantity === 0
                    }
                    onClick={addSelectedVariantToCart}
                  >
                    <ShoppingCart className="mr-2 size-4" />
                    {isSoldOut ? 'Sold out' : isPurchasable ? 'Add to cart' : 'Unavailable'}
                  </Button>
                  {record.sale.acceptsOffers && isPurchasable && (
                    <MarketplaceOfferDialog
                      aggregateId={aggregateId}
                      expectedRevision={negotiation.projection?.serverRevision ?? null}
                      priceAsset={price}
                      askingPrice={record.sale.unitPrice}
                      isSessionRequired={negotiation.needsSession}
                      onSessionRequired={revealSessionRequired}
                      onAccepted={negotiation.refresh}
                    />
                  )}
                </>
              )}
              <Button
                size="lg"
                variant="secondary"
                className="rounded-full"
                aria-label={favorite.isFavorite ? 'Remove from watchlist' : 'Add to watchlist'}
                aria-pressed={favorite.isFavorite}
                disabled={favorite.isMutating}
                onClick={favorite.toggle}
              >
                {record.sale.format === 'auction' ? (
                  <Bell className={favorite.isFavorite ? 'fill-brand text-brand' : ''} />
                ) : (
                  <Heart className={favorite.isFavorite ? 'fill-brand text-brand' : ''} />
                )}
              </Button>
              <MarketplaceListingSavePicker sellerPubky={record.ownerPubky} listingId={record.listingId} />
            </div>
            {adapterMode === 'unavailable' && (
              <Typography as="p" className="text-center text-sm text-muted-foreground">
                Transactions are disabled in this deployment.
              </Typography>
            )}
            {isTransactionalCommerceMode(adapterMode) && negotiation.needsSession && showSessionRequired && (
              <MarketplaceSessionRequiredCard onConnected={onSessionConnected} />
            )}
            {isTransactionalCommerceMode(adapterMode) && negotiation.error && !negotiation.needsSession && (
              <Typography as="p" role="alert" className="text-center text-sm text-amber-300">
                {negotiation.error}
              </Typography>
            )}
          </div>
        </div>
      </Container>
    </ContentLayout>
  );
}

function formatListingShipping(record: CommerceListingRecord): string {
  const flat = record.shippingOptions.find((option) => option.pricing === 'flat');
  if (flat) return `Shipping: ${formatShippingOption(flat)} ${formatCommerceMoney(flat.price)}`;

  const free = record.shippingOptions.find((option) => option.pricing === 'free');
  if (free) return `Shipping: ${formatShippingOption(free)}`;

  return 'Shipping: calculated at checkout';
}

function formatShippingOption(option: CommerceShippingOption): string {
  return option.label.endsWith(':') ? option.label.slice(0, -1) : option.label;
}
