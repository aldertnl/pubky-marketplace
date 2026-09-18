'use client';

import { useRouter } from 'next/navigation';
import { Check, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import { APP_ROUTES, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Image } from '@/atoms/Image/Image';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode, isLocksPaykitCommerceMode } from '@/config/commerce';
import {
  type MarketplaceCartGroup,
  marketplaceCartShippingTotals,
  useMarketplaceCart,
} from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import { useMarketplaceCheckout } from '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout';
import { marketplaceCheckoutSchema } from '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types';
import {
  useMarketplaceFirstMediaUrls,
  useMarketplaceMediaUrl,
} from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceSellerSummary } from '@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { getDeployEnv } from '@/libs/runtime-config/runtime-config';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { MarketplaceSellerIdentity } from '@/molecules/MarketplaceSellerIdentity/MarketplaceSellerIdentity';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import { MarketplaceCartSkeleton } from './MarketplaceCart.skeleton';

export function MarketplaceCart() {
  const router = useRouter();
  const cart = useMarketplaceCart();
  const cartMediaUris = cart.items.map((item) =>
    item.listing.record.media.filter(({ type }) => type === 'image').map(({ url }) => url),
  );
  const cartMediaUrls = useMarketplaceFirstMediaUrls(cartMediaUris);
  const checkout = useMarketplaceCheckout(cart.items, cart.clear);
  const adapterMode = getCommerceAdapterMode();
  const isSandbox = adapterMode === 'sandbox';
  const isStaging = getDeployEnv() === 'staging';
  const formValues = useWatch({ control: checkout.form.control });
  const formValid = marketplaceCheckoutSchema.safeParse(formValues).success;
  const shipping = marketplaceCartShippingTotals(cart.groups, checkout.fulfillmentForSeller);
  const totalSubtotals = [...cart.subtotals, ...shipping.totals].reduce<
    Array<{ amountMinor: number; currency: string; exponent: number }>
  >((totals, money) => {
    const existing = totals.find(
      (candidate) => candidate.currency === money.currency && candidate.exponent === money.exponent,
    );
    if (existing) existing.amountMinor += money.amountMinor;
    else totals.push({ ...money });
    return totals;
  }, []);
  const sessionExpired = Boolean(checkout.needsSession && checkout.sessionError);
  const approvalNeeded = isDurableCommerceMode(adapterMode) && (!checkout.hasMarketplaceSession || sessionExpired);
  const canPlaceOrder = !approvalNeeded && formValid && !checkout.hasFulfillmentConflict;

  const submit = async () => {
    if (await checkout.submit()) router.push(MARKETPLACE_ROUTES.ORDERS);
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Cart
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'} · local-first until checkout.
          </Typography>
        </div>

        {cart.isLoading ? (
          <MarketplaceCartSkeleton />
        ) : cart.items.length ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
            <div className="flex flex-col gap-4">
              {/* Nothing ships on a pickup-only checkout — the shipping note
                  would be a lie there (§A2). */}
              {checkout.requiresDeliveryAddress && (
                <Typography as="p" className="rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground">
                  Each seller ships separately; shipping is calculated at checkout.
                </Typography>
              )}
              {cart.groups.map((group) => {
                // Per-(seller, fulfillment) grouping (§A2): the choice is
                // offered only among the methods every line in the group
                // publishes; a pickup group carries no shipping line and no
                // delivery-address step.
                const fulfillmentOptions = checkout.fulfillmentOptionsForSeller(group.sellerPubky);
                const fulfillment = checkout.fulfillmentForSeller(group.sellerPubky);
                const isPickupGroup = fulfillment === 'pickup';
                return (
                  <section
                    key={group.sellerPubky}
                    className="grid gap-3"
                    aria-label={`Cart items from ${group.sellerPubky}`}
                    data-surface={isPickupGroup ? 'cart-pickup-group' : undefined}
                  >
                    {cart.groups.length > 1 && <MarketplaceCartSellerHeader group={group} />}
                    {fulfillmentOptions.length > 1 && fulfillment && (
                      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/60 px-4 py-3">
                        <Label htmlFor={`fulfillment-${group.sellerPubky}`}>Fulfillment</Label>
                        <Select
                          value={fulfillment}
                          onValueChange={(value) => {
                            if (value === 'shipping' || value === 'pickup') {
                              checkout.setFulfillmentChoice(group.sellerPubky, value);
                            }
                          }}
                        >
                          <SelectTrigger
                            id={`fulfillment-${group.sellerPubky}`}
                            className="h-11 w-56 rounded-md border px-3"
                            aria-label={`Fulfillment for items from ${group.sellerPubky}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {fulfillmentOptions.includes('shipping') && (
                              <SelectItem value="shipping">Ship it</SelectItem>
                            )}
                            {fulfillmentOptions.includes('pickup') && (
                              <SelectItem value="pickup">Local pickup</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {isPickupGroup && (
                      <Typography
                        as="p"
                        className="rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground"
                      >
                        Local pickup — no delivery address or shipping for these items. The meeting point is revealed on
                        the order as soon as your payment confirms.
                      </Typography>
                    )}
                    {fulfillmentOptions.length === 0 && (
                      <Typography
                        as="p"
                        role="alert"
                        className="rounded-xl border border-destructive/40 px-4 py-3 text-sm"
                      >
                        These items can&apos;t be checked out together: they don&apos;t share a fulfillment method this
                        deployment supports (one ships while another is pickup-only). Remove one to continue.
                      </Typography>
                    )}
                    {group.items.map((item) => {
                      const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
                      const price =
                        variant?.priceOverride ??
                        (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
                      // The record's media order is authoritative: the first image
                      // is the cover here just as on cards and the detail gallery.
                      const coverUrl = cartMediaUrls[cart.items.findIndex(({ id }) => id === item.id)] ?? null;
                      const listingRoute = getMarketplaceListingRoute(
                        item.listing.record.ownerPubky,
                        item.listing.listing_id,
                      );
                      return (
                        <Card key={item.id} className="border py-4">
                          <CardContent className="flex items-center gap-4 px-4">
                            <Link href={listingRoute} overrideDefaults aria-label={`View ${item.listing.record.title}`}>
                              <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand/15">
                                <ShoppingCart className="size-7 text-brand" />
                                {coverUrl && (
                                  <Image
                                    src={coverUrl}
                                    alt={item.listing.record.title}
                                    fill
                                    sizes="80px"
                                    className="absolute inset-0 object-cover"
                                  />
                                )}
                              </div>
                            </Link>
                            <div className="min-w-0 flex-1">
                              <Typography as="h2" className="truncate font-semibold">
                                <Link href={listingRoute} overrideDefaults className="hover:text-brand hover:underline">
                                  {item.listing.record.title}
                                </Link>
                              </Typography>
                              <Typography as="p" className="text-sm text-muted-foreground">
                                {variant ? Object.values(variant.options).join(' · ') || 'Default' : 'Default'}
                              </Typography>
                              {price && (
                                <Typography as="p" className="mt-1 font-bold text-brand">
                                  {formatCommerceMoney(price)}{' '}
                                  <MarketplaceIndicativePrice money={price} className="font-normal" />
                                </Typography>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Decrease ${item.listing.record.title} quantity`}
                                disabled={item.quantity <= 1}
                                onClick={() => void cart.update(item.listingId, item.variantId, item.quantity - 1)}
                              >
                                <Minus className="size-4" />
                              </Button>
                              <Typography as="span" className="min-w-8 text-center">
                                {item.quantity}
                              </Typography>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Increase ${item.listing.record.title} quantity`}
                                disabled={!variant || item.quantity >= variant.quantity}
                                onClick={() => void cart.update(item.listingId, item.variantId, item.quantity + 1)}
                              >
                                <Plus className="size-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${item.listing.record.title}`}
                                onClick={() => void cart.remove(item.listingId, item.variantId)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </section>
                );
              })}
            </div>

            <Card className="h-fit border">
              <CardContent className="grid gap-6 px-6">
                <section className="grid gap-3" aria-label="1 Approve in Pubky Ring">
                  <Heading level={2} size="sm" className="text-xl font-semibold">
                    1 Approve in Pubky Ring
                  </Heading>
                  {approvalNeeded ? (
                    <MarketplaceSessionRequiredCard />
                  ) : (
                    <div className="flex items-start gap-3 rounded-xl border px-4 py-3">
                      <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                      <Typography as="p" className="text-sm text-muted-foreground">
                        {isSandbox
                          ? 'Sandbox checkout does not need a Pubky Ring approval.'
                          : 'Purchases approved in Pubky Ring. This session stays on this device until it expires or you sign out.'}
                      </Typography>
                    </div>
                  )}
                </section>

                <section className="grid gap-4" aria-label="2 Delivery and guarantee">
                  <Heading level={2} size="sm" className="text-xl font-semibold">
                    2 Delivery and guarantee
                  </Heading>
                  {/* A pickup-only checkout sends NO delivery address (§A2 —
                      the strictest reading of the address-privacy policy), so
                      the whole address step collapses to the explanation. */}
                  {/* The pickup panel concept is carried over from Igor's PR
                      22 cart (credited prior art), rebuilt on the grouped
                      (seller, fulfillment) cart: his single isPickupOnly
                      branch is now the "every group is pickup" case. */}
                  {!checkout.requiresDeliveryAddress && (
                    <div className="rounded-xl border bg-card/60 p-4">
                      <Typography as="p" className="text-sm font-medium">
                        Local pickup
                      </Typography>
                      <Typography as="p" className="mt-1 text-xs text-muted-foreground">
                        No delivery address is needed — every item in this cart is collected in person. The
                        seller&apos;s meeting point is revealed on the order as soon as your payment confirms.
                      </Typography>
                    </div>
                  )}
                  {checkout.requiresDeliveryAddress && checkout.addresses.length > 0 && (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="checkout-address-picker">Saved addresses</Label>
                        <Link
                          href={MARKETPLACE_ROUTES.SETTINGS_ADDRESSES}
                          overrideDefaults
                          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                          Manage
                        </Link>
                      </div>
                      <Select
                        value={checkout.selectedAddressId ?? 'new'}
                        onValueChange={(value) => checkout.selectAddress(value === 'new' ? null : value)}
                      >
                        <SelectTrigger id="checkout-address-picker" className="h-11 w-full rounded-md border px-3">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {checkout.addresses.map((address) => (
                            <SelectItem key={address.id} value={address.id}>
                              {address.label} · {address.city}
                              {address.is_default ? ' (default)' : ''}
                            </SelectItem>
                          ))}
                          <SelectItem value="new">New address</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {checkout.requiresDeliveryAddress && (
                    <>
                      <Typography
                        as="p"
                        className="rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground"
                      >
                        Your delivery address is sent with your order and shown only to the seller of that order.
                        Encrypting it to the seller&apos;s key is scheduled.
                      </Typography>
                      <ControlledInputField name="name" control={checkout.form.control} label="Recipient" />
                      <ControlledInputField name="line1" control={checkout.form.control} label="Address line 1" />
                      <ControlledInputField name="line2" control={checkout.form.control} label="Address line 2" />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <ControlledInputField name="city" control={checkout.form.control} label="City" />
                        <ControlledInputField name="region" control={checkout.form.control} label="Region" />
                        <ControlledInputField name="postalCode" control={checkout.form.control} label="Postal code" />
                        <ControlledInputField name="countryCode" control={checkout.form.control} label="Country" />
                      </div>
                    </>
                  )}
                  {checkout.requiresDeliveryAddress && checkout.selectedAddressId === null && (
                    <div className="grid gap-3 rounded-xl border bg-card/60 p-3">
                      <Controller
                        name="saveAddress"
                        control={checkout.form.control}
                        render={({ field }) => (
                          <Label className="items-start gap-3">
                            <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                            <span>Save this address on this device for next time</span>
                          </Label>
                        )}
                      />
                      {checkout.form.watch('saveAddress') && (
                        <ControlledInputField
                          name="saveLabel"
                          control={checkout.form.control}
                          label="Label"
                          placeholder="Home"
                        />
                      )}
                    </div>
                  )}
                  <Controller
                    name="acceptsGuarantee"
                    control={checkout.form.control}
                    render={({ field, fieldState }) => (
                      <div className="grid gap-2">
                        <Label className="items-start gap-3">
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            onBlur={field.onBlur}
                            aria-invalid={fieldState.error ? true : undefined}
                          />
                          <span>
                            {/* The guarantee copy must stay truthful per mode: only
                            locks-paykit has live payment rails, and even there the
                            marketplace never holds or moves funds itself. */}
                            {isSandbox
                              ? 'I accept sandbox guarantee policy v1. This is not legal escrow and moves no real funds.'
                              : isLocksPaykitCommerceMode(adapterMode)
                                ? 'I accept guarantee policy v1. This is not legal escrow — payment goes from your wallet directly to the seller, and this marketplace never holds funds.'
                                : 'I accept guarantee policy v1. This is not legal escrow, and no payment rails are live in this deployment — no real funds move.'}
                          </span>
                        </Label>
                        {fieldState.error && (
                          <Typography as="p" role="alert" className="text-sm text-destructive">
                            {fieldState.error.message}
                          </Typography>
                        )}
                      </div>
                    )}
                  />
                </section>

                <section className="grid gap-3 border-t pt-4" aria-label="3 Place order">
                  <Heading level={2} size="sm" className="text-xl font-semibold">
                    3 Place order
                  </Heading>
                  <div className="flex justify-between">
                    <Typography as="span">Items</Typography>
                    {/* One line per pricing asset: USD cents and bitcoin base
                        units are never summed into one false number. */}
                    <div className="flex flex-col items-end">
                      {cart.subtotals.map((subtotal) => (
                        <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="span" className="font-bold">
                          {formatCommerceMoney(subtotal)}{' '}
                          <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                        </Typography>
                      ))}
                    </div>
                  </div>
                  {shipping.totals.length > 0 && (
                    <div className="flex justify-between">
                      <Typography as="span">Shipping</Typography>
                      <div className="flex flex-col items-end">
                        {shipping.totals.map((subtotal) => (
                          <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="span" className="font-bold">
                            {formatCommerceMoney(subtotal)}{' '}
                            <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                          </Typography>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-3">
                    <Typography as="span" className="font-semibold">
                      Total
                    </Typography>
                    <div className="flex flex-col items-end">
                      {totalSubtotals.map((subtotal) => (
                        <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="span" className="font-bold">
                          {formatCommerceMoney(subtotal)}{' '}
                          <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                        </Typography>
                      ))}
                    </div>
                  </div>
                  <Typography as="p" className="text-xs text-muted-foreground">
                    {shipping.hasCalculatedShipping
                      ? 'Shipping calculated at checkout for the items that ship.'
                      : shipping.totals.length > 0
                        ? 'Shipping is shown from each seller’s configured flat or free option.'
                        : checkout.requiresDeliveryAddress
                          ? 'Shipping is calculated authoritatively at checkout for the items that ship.'
                          : 'No shipping — pickup is arranged with the seller after payment.'}
                  </Typography>
                  {/* The (seller, fulfillment) split, stated plainly before
                      submit (§A2): one order per seller group. */}
                  {checkout.orderCount > 1 && (
                    <Typography as="p" className="text-xs text-muted-foreground">
                      This places {checkout.orderCount} orders — one per seller and delivery method.
                    </Typography>
                  )}
                  {isStaging ? (
                    <Typography
                      as="p"
                      role="note"
                      className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                    >
                      Staging environment — test rails, no real funds move
                    </Typography>
                  ) : (
                    <Typography
                      as="p"
                      role="note"
                      className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                    >
                      Real money. Payments are final and go directly to the seller.
                    </Typography>
                  )}
                  <Button
                    className="w-full rounded-full"
                    onClick={submit}
                    disabled={!canPlaceOrder}
                    aria-describedby={!canPlaceOrder ? 'place-order-reason' : undefined}
                  >
                    {isSandbox ? 'Place sandbox order' : 'Place order'}
                  </Button>
                  {!canPlaceOrder && (
                    <Typography id="place-order-reason" as="p" className="text-xs text-muted-foreground">
                      {approvalNeeded
                        ? 'Approve purchases in Pubky Ring before placing the order.'
                        : checkout.hasFulfillmentConflict
                          ? "Some items can't be checked out together — see the note in your cart."
                          : 'Fill in delivery details and accept the guarantee to place the order.'}
                    </Typography>
                  )}
                </section>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <ShoppingCart className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              Your cart is empty
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              Items you add from listings appear here, saved on this device.
            </Typography>
            <Button asChild className="mt-6 rounded-full">
              <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
                Browse the marketplace
              </Link>
            </Button>
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function MarketplaceCartSellerHeader({ group }: { group: MarketplaceCartGroup }) {
  const seller = useMarketplaceSellerSummary(group.sellerPubky, { includeReputation: false });
  const avatarUrl = useMarketplaceMediaUrl(seller.shop?.record.avatarUrl);

  return (
    <Card className="border py-4">
      <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between">
        <MarketplaceSellerIdentity
          sellerPubky={group.sellerPubky}
          displayName={seller.displayName}
          avatarUrl={avatarUrl}
          avatarAlt={`${seller.shop?.record.name ?? 'Shop'} avatar`}
          reputation={seller.reputation}
        />
        <div className="flex flex-col gap-1 sm:items-end">
          <Typography as="p" className="text-sm text-muted-foreground">
            Seller subtotal
          </Typography>
          {group.subtotals.map((subtotal) => (
            <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="p" className="font-bold text-brand">
              {formatCommerceMoney(subtotal)} <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
            </Typography>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
