'use client';

import { type ReactNode, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Film,
  ImagePlus,
  Plus,
  Trash2,
} from 'lucide-react';
import { Controller, useFieldArray, type UseFormReturn, useWatch } from 'react-hook-form';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Container } from '@/atoms/Container/Container';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import { commerceAttributeFieldsFor, resolveCommerceCategory } from '@/config/taxonomy/taxonomy';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  CREATE_MARKETPLACE_LISTING_FIELDS,
  CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS,
  type CreateMarketplaceListingData,
  createMarketplaceListingPublishChecklist,
  createMarketplaceListingValuesFromWatch,
  isCreateMarketplaceListingPublishReady,
  listingAttributeFormField,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import type {
  ListingMediaItem,
  UseListingMediaManagerResult,
} from '@/hooks/useListingMediaManager/useListingMediaManager';
import { useMarketplaceShippingPresets } from '@/hooks/useMarketplaceShippingPresets/useMarketplaceShippingPresets';
import { presetToShippingFields } from '@/hooks/useMarketplaceShippingPresets/useMarketplaceShippingPresets.types';
import { amountInputSchemaForAsset, amountInputUnitLabel, assetForListingCurrency } from '@/libs/commerce/pricing';
import {
  dimensionInputFromMillimeters,
  dimensionUnitLabel,
  gramsFromWeightInput,
  millimetersFromDimensionInput,
  weightInputFromGrams,
  weightUnitLabel,
} from '@/libs/commerce/units';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { MarketplaceCategoryPicker } from '@/organisms/Marketplace/MarketplaceCategoryPicker';
import { MarketplaceListingAttributeFields } from '@/organisms/Marketplace/MarketplaceListingAttributeFields';
import { MarketplacePickupDetailsEditor } from '@/organisms/Marketplace/MarketplacePickupDetailsEditor';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

const LISTING_FORM_SECTIONS = [
  { id: 'listing-section-photos', label: 'Photos' },
  { id: 'listing-section-item', label: 'Item' },
  { id: 'listing-section-price', label: 'Price & format' },
  { id: 'listing-section-shipping', label: 'Shipping & returns' },
  { id: 'listing-section-review', label: 'Review & publish' },
] as const;

type ListingFormSectionId = (typeof LISTING_FORM_SECTIONS)[number]['id'];

export interface MarketplaceListingFormProps {
  form: UseFormReturn<CreateMarketplaceListingData>;
  media: UseListingMediaManagerResult;
  onSubmit: () => Promise<void>;
  isPublishing: boolean;
  /**
   * The listing id the pickup-details editor addresses — edit mode only (the
   * service accepts `pickup_details.set` for a registered listing, so create
   * mode shows the publish-first note instead). When omitted, the
   * pickup-details editor is not rendered.
   */
  listingId?: string;
  /** Edit mode locks the sale format (and auction terms) and relabels submit. */
  mode?: 'create' | 'edit';
  /** True for auctions being edited: price and format were fixed at publish. */
  saleTermsLocked?: boolean;
}

export function MarketplaceListingForm({
  form,
  media,
  onSubmit,
  isPublishing,
  listingId,
  mode = 'create',
  saleTermsLocked = false,
}: MarketplaceListingFormProps) {
  const {
    items: mediaItems,
    maxPhotos,
    error: pickerError,
    inputRef,
    onInputChange,
    choose,
    removeItem,
    moveItem,
    setAltText,
  } = media;
  const fulfillment = useWatch({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT });
  const saleFormat = useWatch({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.SALE_FORMAT });
  const currency = useWatch({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.CURRENCY });
  const freeShipping = useWatch({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.FREE_SHIPPING });
  const watchedListingFields = useWatch({
    control: form.control,
    name: CREATE_MARKETPLACE_LISTING_SCHEMA_KEYS,
  });
  const measurementSystem = useWatch({
    control: form.control,
    name: CREATE_MARKETPLACE_LISTING_FIELDS.MEASUREMENT_SYSTEM,
  });
  const variants = useFieldArray({ control: form.control, name: CREATE_MARKETPLACE_LISTING_FIELDS.VARIANTS });
  // The inline unit toggle writes the device-wide preference AND the form:
  // the hook only adopts the preference while the package fields are empty
  // (so labels always match typed numbers), so an explicit toggle must also
  // convert any values already entered — via the exact mm/g round-trip the
  // publish path uses, so nothing drifts.
  const setMeasurementSystem = useMarketplaceDisplayStore((state) => state.setMeasurementSystem);
  // Free shipping toggle: check/uncheck keeps the typed price in the form
  // state (toggling back restores it) but clears its validation error while
  // it is unused — the record emits a `pricing: 'free'` option either way.
  const setFreeShipping = (next: boolean) => {
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.FREE_SHIPPING, next);
    if (next) {
      form.clearErrors(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE);
    } else {
      void form.trigger(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE);
    }
  };
  const switchMeasurementSystem = (next: 'metric' | 'imperial') => {
    const current = form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.MEASUREMENT_SYSTEM) as 'metric' | 'imperial';
    if (next === current) return;
    setMeasurementSystem(next);
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.MEASUREMENT_SYSTEM, next);
    const dimensionFields = [
      CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_LENGTH,
      CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WIDTH,
      CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_HEIGHT,
    ] as const;
    for (const name of dimensionFields) {
      const raw = String(form.getValues(name) ?? '').trim();
      const parsed = Number(raw);
      if (raw === '' || !Number.isFinite(parsed)) continue;
      form.setValue(name, dimensionInputFromMillimeters(millimetersFromDimensionInput(parsed, current), next));
    }
    const rawWeight = String(form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WEIGHT) ?? '').trim();
    const parsedWeight = Number(rawWeight);
    if (rawWeight !== '' && Number.isFinite(parsedWeight)) {
      form.setValue(
        CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WEIGHT,
        weightInputFromGrams(gramsFromWeightInput(parsedWeight, current), next),
      );
    }
  };
  const isEdit = mode === 'edit';
  // The deployment's `pickup_available` capability (§A7), the same source the
  // pickup-details editor and the checkout read: off without the sealing key
  // and on every sandbox deployment. When off (or unreadable), the form
  // offers shipping only.
  const [pickupAvailable, setPickupAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    CommerceController.fetchPickupAvailable()
      .then((available) => {
        if (active) setPickupAvailable(available);
      })
      .catch(() => {
        if (active) setPickupAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);
  // Auctions are shipping-only (local pickup design §A2 — an auction order
  // has no checkout step to express a pickup choice), so switching the format
  // to auction coerces fulfillment back to shipping; the schema backstops it.
  useEffect(() => {
    if (saleFormat === 'auction' && form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT) !== 'shipping') {
      form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT, 'shipping', { shouldValidate: true });
    }
  }, [saleFormat, form]);
  // A deployment without pickup cannot publish it either — coerce any pickup
  // value to shipping the same way the auction path does, so a stale form
  // value never slips past the hidden options.
  useEffect(() => {
    if (pickupAvailable === false && form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT) !== 'shipping') {
      form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT, 'shipping', { shouldValidate: true });
    }
  }, [pickupAvailable, form]);
  const priceUnit = amountInputUnitLabel(assetForListingCurrency(currency));
  const pricePlaceholder = currency === 'BTC' ? '150000' : '125.00';
  const isImperial = measurementSystem === 'imperial';
  const formValues = createMarketplaceListingValuesFromWatch(watchedListingFields, () => {
    void form.formState.isValidating;
    return form.getValues();
  });
  const mediaError =
    pickerError === 'invalid-type'
      ? 'Choose image files only.'
      : pickerError === 'too-large'
        ? 'An image is too large.'
        : pickerError === 'decode-failed'
          ? 'A photo could not be processed.'
          : pickerError === 'limit-reached'
            ? `Listings support up to ${maxPhotos} photos.`
            : null;
  const sectionStatuses = getListingSectionStatuses(formValues, mediaItems.length);
  const publishMinimumMet = isCreateMarketplaceListingPublishReady(formValues, mediaItems.length);
  const remainingRequired = createMarketplaceListingPublishChecklist(formValues, mediaItems.length);
  const optionalLaterItems = getOptionalLaterItems(formValues);
  const [activeSectionId, setActiveSectionId] = useState<ListingFormSectionId>(LISTING_FORM_SECTIONS[0].id);
  const activeSectionIndex = LISTING_FORM_SECTIONS.findIndex((section) => section.id === activeSectionId);
  const navigateToSection = (sectionId: ListingFormSectionId) => {
    setActiveSectionId(sectionId);
    const section = document.getElementById(sectionId);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section?.focus({ preventScroll: true });
  };

  return (
    <form
      className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)_9rem]"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <SectionProgressRail
        activeSectionId={activeSectionId}
        sectionStatuses={sectionStatuses}
        onNavigate={navigateToSection}
      />
      <div className="flex flex-col gap-6">
        <MobileSectionStepper
          activeSectionIndex={activeSectionIndex}
          sectionStatuses={sectionStatuses}
          onNavigate={navigateToSection}
        />

        <ListingFormSection
          id="listing-section-photos"
          title="Photos"
          description={`Up to ${media.maxPhotos} photos. The first photo is the cover buyers see everywhere. Metadata is stripped before publication.`}
          complete={sectionStatuses['listing-section-photos']}
        >
          {mediaItems.length > 0 && (
            <ul className="flex flex-col gap-3" aria-label="Listing photos in display order">
              {mediaItems.map((item, index) => (
                <ListingPhotoRow
                  key={item.key}
                  item={item}
                  index={index}
                  count={mediaItems.length}
                  isPublishing={isPublishing}
                  onMove={moveItem}
                  onRemove={removeItem}
                  onAltTextChange={setAltText}
                />
              ))}
            </ul>
          )}

          <Button
            type="button"
            variant="secondary"
            className="w-fit rounded-full"
            disabled={isPublishing || mediaItems.length >= maxPhotos}
            onClick={choose}
          >
            <ImagePlus className="mr-2 size-4" />
            Add photos ({mediaItems.length}/{maxPhotos})
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={onInputChange}
          />
          {mediaError && (
            <Typography as="p" role="alert" className="text-sm text-destructive">
              {mediaError}
            </Typography>
          )}
        </ListingFormSection>

        <ListingFormSection
          id="listing-section-item"
          title="Item"
          description="Describe what the buyer receives and classify it for marketplace discovery."
          complete={sectionStatuses['listing-section-item']}
        >
          <ControlledInputField
            name={CREATE_MARKETPLACE_LISTING_FIELDS.TITLE}
            control={form.control}
            label="Title"
            placeholder="What are you selling?"
            disabled={isPublishing}
          />
          <ControlledTextareaField
            name={CREATE_MARKETPLACE_LISTING_FIELDS.DESCRIPTION}
            control={form.control}
            label="Description"
            placeholder="Condition, provenance, measurements, and anything a buyer should know"
            rows={6}
            disabled={isPublishing}
          />
          <Controller
            name={CREATE_MARKETPLACE_LISTING_FIELDS.CATEGORY}
            control={form.control}
            render={({ field, fieldState }) => (
              <MarketplaceCategoryPicker
                value={field.value}
                onChange={field.onChange}
                disabled={isPublishing}
                error={fieldState.error?.message}
              />
            )}
          />
          <MarketplaceListingAttributeFields form={form} isPublishing={isPublishing} />
          <div className="grid gap-5 sm:grid-cols-2">
            <FormSelect
              form={form}
              name={CREATE_MARKETPLACE_LISTING_FIELDS.CONDITION}
              label="Condition"
              disabled={isPublishing}
              options={[
                { value: 'new', label: 'New' },
                { value: 'like_new', label: 'Like new' },
                { value: 'excellent', label: 'Excellent' },
                { value: 'good', label: 'Good' },
                { value: 'fair', label: 'Fair' },
                { value: 'for_parts', label: 'For parts' },
              ]}
            />
            <ControlledInputField
              name={CREATE_MARKETPLACE_LISTING_FIELDS.COUNTRY_CODE}
              control={form.control}
              label="Country"
              placeholder="US"
              disabled={isPublishing}
            />
            <ControlledInputField
              name={CREATE_MARKETPLACE_LISTING_FIELDS.REGION}
              control={form.control}
              label="Region (optional)"
              placeholder="NY"
              disabled={isPublishing}
            />
          </div>
        </ListingFormSection>

        <ListingFormSection
          id="listing-section-price"
          title="Price & format"
          description="Choose the sale format, price, and inventory options."
          complete={sectionStatuses['listing-section-price']}
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <FormSelect
              form={form}
              name={CREATE_MARKETPLACE_LISTING_FIELDS.SALE_FORMAT}
              label="Sale format"
              disabled={isPublishing || isEdit}
              options={[
                { value: 'fixed_price', label: 'Buy now' },
                { value: 'auction', label: '7-day auction' },
              ]}
            />
            <FormSelect
              form={form}
              name={CREATE_MARKETPLACE_LISTING_FIELDS.CURRENCY}
              label="Pricing currency"
              disabled={isPublishing || saleTermsLocked}
              options={[
                { value: 'USD', label: 'US dollars (USD)' },
                { value: 'BTC', label: 'Bitcoin (₿)' },
              ]}
            />
            <ControlledInputField
              name={CREATE_MARKETPLACE_LISTING_FIELDS.PRICE}
              control={form.control}
              label={saleFormat === 'auction' ? `Starting price (${priceUnit})` : `Price (${priceUnit})`}
              placeholder={pricePlaceholder}
              disabled={isPublishing || saleTermsLocked}
            />
          </div>
          {currency === 'BTC' && (
            <Typography as="p" className="text-sm text-muted-foreground">
              Bitcoin prices are entered in whole base units: 150000 publishes as ₿150,000.
            </Typography>
          )}
          {isEdit && (
            <Typography as="p" className="text-sm text-muted-foreground">
              {saleTermsLocked
                ? 'Auction terms (format, starting price, and schedule) are fixed once the auction is published.'
                : 'The sale format cannot change after publishing.'}
            </Typography>
          )}

          <div className="flex items-center justify-between gap-4 border-t pt-5">
            <div>
              <Typography as="h3" className="font-semibold">
                Variants and inventory
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                Up to three option dimensions with independent SKU, price, and quantity.
              </Typography>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0 rounded-full"
              disabled={isPublishing || saleFormat === 'auction' || variants.fields.length >= 100}
              onClick={() =>
                variants.append({ sku: '', size: '', color: '', style: '', quantity: '1', priceOverride: '' })
              }
            >
              <Plus className="mr-2 size-4" />
              Add variant
            </Button>
          </div>

          <div className="flex flex-col gap-4">
            {variants.fields.map((variant, index) => (
              <div key={variant.id} className="relative grid gap-4 rounded-xl border bg-card/60 p-4 sm:grid-cols-3">
                <ControlledInputField
                  name={`variants.${index}.sku`}
                  control={form.control}
                  label="Seller SKU"
                  placeholder="BOOTS-42"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={`variants.${index}.size`}
                  control={form.control}
                  label="Size"
                  placeholder="42"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={`variants.${index}.color`}
                  control={form.control}
                  label="Color"
                  placeholder="Brown"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={`variants.${index}.style`}
                  control={form.control}
                  label="Style"
                  placeholder="Classic"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={`variants.${index}.quantity`}
                  control={form.control}
                  label="Quantity"
                  placeholder="1"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={`variants.${index}.priceOverride`}
                  control={form.control}
                  label={`Price override (${priceUnit})`}
                  placeholder="Optional"
                  disabled={isPublishing}
                />
                {variants.fields.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute top-2 right-2 rounded-full"
                    aria-label={`Remove variant ${index + 1}`}
                    disabled={isPublishing}
                    onClick={() => variants.remove(index)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </ListingFormSection>

        <ListingFormSection
          id="listing-section-shipping"
          title="Shipping & returns"
          description="Fulfillment: ship the item, offer local pickup, or both. Shipping requires the shipping details and package size; pickup-only listings skip those fields."
          complete={sectionStatuses['listing-section-shipping']}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <FormSelect
              form={form}
              name={CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT}
              label="Fulfillment"
              disabled={isPublishing || saleFormat === 'auction' || pickupAvailable === false}
              options={
                pickupAvailable === false
                  ? [{ value: 'shipping', label: 'Ship item' }]
                  : [
                      { value: 'shipping', label: 'Ship item' },
                      { value: 'pickup', label: 'Local pickup' },
                      { value: 'shipping_and_pickup', label: 'Pickup or shipping' },
                    ]
              }
            />
            <FormSelect
              form={form}
              name={CREATE_MARKETPLACE_LISTING_FIELDS.RETURN_DAYS}
              label="Returns"
              disabled={isPublishing}
              options={[
                { value: '30', label: '30 days' },
                { value: '14', label: '14 days' },
                { value: 'none', label: 'Final sale' },
              ]}
            />
          </div>
          {saleFormat === 'auction' && (
            <Typography as="p" className="text-sm text-muted-foreground">
              Auctions ship only — local pickup is available on Buy now listings.
            </Typography>
          )}
          {pickupAvailable === false && (
            <Typography as="p" className="text-sm text-muted-foreground">
              Local pickup is not available on this deployment.
            </Typography>
          )}

          {/* The pickup-details editor only exists post-publish: the service
              accepts `pickup_details.set` for a REGISTERED listing that
              publishes pickup, so a create-mode mount could only ever fail
              its owner read. Create mode points at the edit page instead. */}
          {fulfillment !== 'shipping' && listingId && isEdit && (
            <MarketplacePickupDetailsEditor listingId={listingId} disabled={isPublishing} />
          )}
          {fulfillment !== 'shipping' && !isEdit && (
            <Typography as="p" className="text-sm text-muted-foreground">
              Publish first, then add your meeting point from the listing&apos;s edit page.
            </Typography>
          )}

          {fulfillment !== 'pickup' && (
            <>
              <ListingShippingPresetRow form={form} isPublishing={isPublishing} />
              <div className="grid gap-5 sm:grid-cols-2">
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_LABEL}
                  control={form.control}
                  label="Shipping label"
                  placeholder="Standard shipping"
                  disabled={isPublishing}
                />
                <div className="grid gap-2">
                  <ControlledInputField
                    name={CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE}
                    control={form.control}
                    label={`Flat shipping (${priceUnit})`}
                    placeholder={currency === 'BTC' ? '15000' : '12.00'}
                    disabled={isPublishing || freeShipping}
                  />
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="listing-free-shipping"
                      checked={freeShipping}
                      disabled={isPublishing}
                      onCheckedChange={(checked) => setFreeShipping(checked === true)}
                    />
                    <Label htmlFor="listing-free-shipping" className="cursor-pointer text-sm">
                      Free shipping
                    </Label>
                  </div>
                </div>
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MIN_DAYS}
                  control={form.control}
                  label="Delivery estimate min (days)"
                  placeholder="3"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MAX_DAYS}
                  control={form.control}
                  label="Delivery estimate max (days)"
                  placeholder="7"
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WEIGHT}
                  control={form.control}
                  label={`Weight (${weightUnitLabel(measurementSystem)})`}
                  placeholder={isImperial ? '42.3' : '1200'}
                  disabled={isPublishing}
                />
              </div>
              <div className="flex items-center gap-2" data-cy="marketplace-package-units-toggle">
                <Typography as="span" className="text-sm text-muted-foreground">
                  Units
                </Typography>
                <Button
                  type="button"
                  size="sm"
                  variant={isImperial ? 'default' : 'secondary'}
                  className="rounded-full"
                  aria-pressed={isImperial}
                  disabled={isPublishing}
                  onClick={() => switchMeasurementSystem('imperial')}
                >
                  in / oz
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={isImperial ? 'secondary' : 'default'}
                  className="rounded-full"
                  aria-pressed={!isImperial}
                  disabled={isPublishing}
                  onClick={() => switchMeasurementSystem('metric')}
                >
                  cm / g
                </Button>
              </div>
              <div className="grid gap-5 sm:grid-cols-3">
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_LENGTH}
                  control={form.control}
                  label={`Length (${dimensionUnitLabel(measurementSystem)})`}
                  placeholder={isImperial ? '13.8' : '35.0'}
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_WIDTH}
                  control={form.control}
                  label={`Width (${dimensionUnitLabel(measurementSystem)})`}
                  placeholder={isImperial ? '9.8' : '25.0'}
                  disabled={isPublishing}
                />
                <ControlledInputField
                  name={CREATE_MARKETPLACE_LISTING_FIELDS.PACKAGE_HEIGHT}
                  control={form.control}
                  label={`Height (${dimensionUnitLabel(measurementSystem)})`}
                  placeholder={isImperial ? '5.9' : '15.0'}
                  disabled={isPublishing}
                />
              </div>
              <Typography as="p" className="text-sm text-muted-foreground">
                Package details are entered in {isImperial ? 'inches and ounces' : 'centimeters and grams'} (your
                measurement preference) and stored exactly in millimeters and grams.
              </Typography>
            </>
          )}
        </ListingFormSection>

        <ListingFormSection
          id="listing-section-review"
          title="Review & publish"
          description="Publish is available after title, price, category, and at least one photo are ready."
          complete={sectionStatuses['listing-section-review']}
        >
          <ReviewPublishChecklist
            remainingRequired={remainingRequired}
            optionalLaterItems={optionalLaterItems}
            publishMinimumMet={publishMinimumMet}
          />
          <Button type="submit" size="lg" className="w-full rounded-full" disabled={isPublishing || !publishMinimumMet}>
            {isEdit ? (isPublishing ? 'Saving…' : 'Save changes') : isPublishing ? 'Publishing…' : 'Publish listing'}
          </Button>
        </ListingFormSection>
      </div>
      <SectionProgressRail
        activeSectionId={activeSectionId}
        sectionStatuses={sectionStatuses}
        onNavigate={navigateToSection}
        align="right"
      />
    </form>
  );
}

function SectionProgressRail({
  activeSectionId,
  sectionStatuses,
  onNavigate,
  align = 'left',
}: {
  activeSectionId: ListingFormSectionId;
  sectionStatuses: Record<ListingFormSectionId, boolean>;
  onNavigate: (sectionId: ListingFormSectionId) => void;
  align?: 'left' | 'right';
}) {
  return (
    <nav
      aria-label={align === 'left' ? 'Listing sections' : 'Listing section status'}
      className="sticky top-24 hidden h-fit flex-col gap-2 lg:flex"
    >
      {LISTING_FORM_SECTIONS.map((section, index) => {
        const complete = sectionStatuses[section.id];
        const active = activeSectionId === section.id;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={[
              'flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors',
              active
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border text-muted-foreground hover:text-foreground',
              align === 'right' ? 'justify-center' : '',
            ].join(' ')}
            aria-current={active ? 'step' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(section.id);
            }}
          >
            {complete ? (
              <CheckCircle2 className="size-4 shrink-0 text-brand" aria-hidden="true" />
            ) : (
              <Circle className="size-4 shrink-0" aria-hidden="true" />
            )}
            {align === 'left' ? section.label : `${index + 1}`}
            <span className="sr-only">{complete ? ' complete' : ' incomplete'}</span>
          </a>
        );
      })}
    </nav>
  );
}

function MobileSectionStepper({
  activeSectionIndex,
  sectionStatuses,
  onNavigate,
}: {
  activeSectionIndex: number;
  sectionStatuses: Record<ListingFormSectionId, boolean>;
  onNavigate: (sectionId: ListingFormSectionId) => void;
}) {
  const safeIndex = Math.max(0, activeSectionIndex);
  const activeSection = LISTING_FORM_SECTIONS[safeIndex];
  const previousSection = LISTING_FORM_SECTIONS[safeIndex - 1];
  const nextSection = LISTING_FORM_SECTIONS[safeIndex + 1];

  return (
    <div className="sticky top-2 z-10 flex flex-col gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Typography as="p" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Step {safeIndex + 1} of {LISTING_FORM_SECTIONS.length}
          </Typography>
          <Typography as="p" className="font-semibold">
            {activeSection.label}
          </Typography>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={!previousSection}
            onClick={() => previousSection && onNavigate(previousSection.id)}
          >
            <ChevronLeft className="mr-1 size-4" />
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={!nextSection}
            onClick={() => nextSection && onNavigate(nextSection.id)}
          >
            Next
            <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Listing section anchors">
        {LISTING_FORM_SECTIONS.map((section, index) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={[
              'rounded-full border px-2.5 py-1 text-xs',
              activeSection.id === section.id
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border text-muted-foreground',
            ].join(' ')}
            aria-current={activeSection.id === section.id ? 'step' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(section.id);
            }}
          >
            {index + 1}
            <span className="sr-only">
              {' '}
              {section.label}
              {sectionStatuses[section.id] ? ' complete' : ' incomplete'}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function ListingFormSection({
  id,
  title,
  description,
  complete,
  children,
}: {
  id: ListingFormSectionId;
  title: string;
  description: string;
  complete: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-title`} data-section-complete={complete} data-surface={id}>
      <Card className="border">
        <CardContent className="grid gap-5 px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Typography id={`${id}-title`} as="h2" className="text-xl font-semibold">
                {title}
              </Typography>
              <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                {description}
              </Typography>
            </div>
            <Badge className={complete ? '' : 'bg-muted text-muted-foreground'}>
              {complete ? 'Complete' : 'Incomplete'}
            </Badge>
          </div>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

function ReviewPublishChecklist({
  remainingRequired,
  optionalLaterItems,
  publishMinimumMet,
}: {
  remainingRequired: string[];
  optionalLaterItems: string[];
  publishMinimumMet: boolean;
}) {
  return (
    <div className="grid gap-4 rounded-xl border bg-card/60 p-4">
      <div className="flex items-start gap-3">
        {publishMinimumMet ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
        ) : (
          <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div>
          <Typography as="p" className="font-semibold">
            Required to publish
          </Typography>
          {remainingRequired.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {remainingRequired.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <Typography as="p" className="mt-1 text-sm text-muted-foreground">
              Every schema-required field is valid and at least one photo is attached.
            </Typography>
          )}
        </div>
      </div>
      <div>
        <Typography as="p" className="font-semibold">
          You can add these later
        </Typography>
        {optionalLaterItems.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {optionalLaterItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <Typography as="p" className="mt-2 text-sm text-muted-foreground">
            All optional listing details are filled.
          </Typography>
        )}
      </div>
    </div>
  );
}

function getListingSectionStatuses(
  values: CreateMarketplaceListingData,
  photoCount: number,
): Record<ListingFormSectionId, boolean> {
  const categoryResolved = Boolean(resolveCommerceCategory(values.categoryId));
  const priceValid = amountInputSchemaForAsset(assetForListingCurrency(values.currency)).safeParse(
    values.price,
  ).success;
  const variantsValid =
    values.variants.length > 0 && values.variants.every((variant) => /^[1-9]\d*$/.test(variant.quantity));
  const itemComplete =
    values.title.trim().length >= 3 &&
    values.description.trim().length > 0 &&
    categoryResolved &&
    /^[A-Za-z]{2}$/.test(values.countryCode.trim()) &&
    categoryRequiredAttributesComplete(values);
  const shippingComplete =
    values.fulfillment === 'pickup' ||
    (values.shippingLabel.trim().length > 0 &&
      (values.freeShipping ||
        amountInputSchemaForAsset(assetForListingCurrency(values.currency)).safeParse(values.shippingPrice).success) &&
      /^\d+$/.test(values.shippingMinDays) &&
      /^\d+$/.test(values.shippingMaxDays) &&
      values.packageWeight.trim().length > 0 &&
      values.packageLength.trim().length > 0 &&
      values.packageWidth.trim().length > 0 &&
      values.packageHeight.trim().length > 0);

  return {
    'listing-section-photos': photoCount > 0,
    'listing-section-item': itemComplete,
    'listing-section-price': priceValid && variantsValid,
    'listing-section-shipping': shippingComplete,
    'listing-section-review': isCreateMarketplaceListingPublishReady(values, photoCount),
  };
}

function categoryRequiredAttributesComplete(values: CreateMarketplaceListingData): boolean {
  return commerceAttributeFieldsFor(values.categoryId).every((field) => {
    if (!field.required) return true;
    const formField = listingAttributeFormField(field.key);
    if (!formField) return true;
    const value = values[formField];
    return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  });
}

function getOptionalLaterItems(values: CreateMarketplaceListingData): string[] {
  const optionalItems: string[] = [];
  const hasAttributes = commerceAttributeFieldsFor(values.categoryId).some((field) => {
    const formField = listingAttributeFormField(field.key);
    if (!formField || field.required) return false;
    const value = values[formField];
    return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
  });

  if (!hasAttributes) optionalItems.push('Optional category specifics like brand, color, style, model, or material');
  if (!values.region.trim()) optionalItems.push('Region');
  if (
    values.variants.every(
      (variant) => !variant.sku && !variant.size && !variant.color && !variant.style && !variant.priceOverride,
    )
  ) {
    optionalItems.push('Variant SKUs, options, and price overrides');
  }
  if (values.fulfillment === 'pickup') optionalItems.push('Shipping details');
  if (values.returnDays === 'none') optionalItems.push('Returns policy');

  return optionalItems;
}

/**
 * Save/apply shipping presets: device-local templates over the four shipping
 * fields. Applying only fills the form — the published record shape is
 * unchanged either way.
 */
function ListingShippingPresetRow({
  form,
  isPublishing,
}: {
  form: UseFormReturn<CreateMarketplaceListingData>;
  isPublishing: boolean;
}) {
  const { presets, saveFromFields } = useMarketplaceShippingPresets();

  const applyPreset = (presetId: string) => {
    const preset = presets.find(({ id }) => id === presetId);
    if (!preset) return;
    const fields = presetToShippingFields(preset);
    // Presets carry a concrete flat price, so applying one is a priced
    // choice: untoggle free shipping if it was on.
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.FREE_SHIPPING, false);
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_LABEL, fields.shippingLabel, { shouldValidate: true });
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_PRICE, fields.shippingPrice, { shouldValidate: true });
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MIN_DAYS, fields.shippingMinDays, {
      shouldValidate: true,
    });
    form.setValue(CREATE_MARKETPLACE_LISTING_FIELDS.SHIPPING_MAX_DAYS, fields.shippingMaxDays, {
      shouldValidate: true,
    });
  };

  const saveAsPreset = () => {
    const values = form.getValues();
    void saveFromFields(null, {
      shippingLabel: values.shippingLabel,
      shippingPrice: values.shippingPrice,
      shippingMinDays: values.shippingMinDays,
      shippingMaxDays: values.shippingMaxDays,
    });
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card/60 p-3">
      {presets.length > 0 && (
        <Container className="min-w-48 flex-1 gap-2">
          <Label htmlFor="listing-shipping-preset" className={FORM_LABEL_CLASSES}>
            Shipping preset
          </Label>
          <Select onValueChange={applyPreset} disabled={isPublishing}>
            <SelectTrigger id="listing-shipping-preset" className="h-11 w-full rounded-md border px-3">
              <SelectValue placeholder="Apply a saved preset" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label} · ${(preset.price_minor / 100).toFixed(2)} · {preset.estimated_min_days}–
                  {preset.estimated_max_days}d
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Container>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="rounded-full"
        disabled={isPublishing}
        onClick={saveAsPreset}
      >
        Save as preset
      </Button>
      {presets.length === 0 && (
        <Typography as="p" className="text-sm text-muted-foreground">
          Presets store these shipping fields on this device so future listings start pre-filled.
        </Typography>
      )}
    </div>
  );
}

function ListingPhotoRow({
  item,
  index,
  count,
  isPublishing,
  onMove,
  onRemove,
  onAltTextChange,
}: {
  item: ListingMediaItem;
  index: number;
  count: number;
  isPublishing: boolean;
  onMove: (key: string, direction: -1 | 1) => void;
  onRemove: (key: string) => void;
  onAltTextChange: (key: string, altText: string) => void;
}) {
  const position = `Photo ${index + 1} of ${count}`;
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card/60 p-3 sm:flex-row sm:items-center">
      <div className="relative size-24 shrink-0 overflow-hidden rounded-lg border bg-card">
        {item.previewUrl ? (
          // Plain <img>: previews are local object URLs or direct homeserver
          // reads, neither of which should go through Next image optimization.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt={item.altText || position} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center">
            <Film aria-hidden="true" className="size-8 text-muted-foreground" />
          </span>
        )}
        {index === 0 && <Badge className="absolute bottom-1 left-1 px-1.5 py-0 text-[10px]">Cover</Badge>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Label htmlFor={`listing-photo-alt-${item.key}`} className={FORM_LABEL_CLASSES}>
          Photo {index + 1} description
        </Label>
        <Input
          id={`listing-photo-alt-${item.key}`}
          value={item.altText}
          placeholder="Describe this photo for people using screen readers"
          disabled={isPublishing}
          onChange={(event) => onAltTextChange(item.key, event.target.value)}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="rounded-full"
          aria-label={`Move photo ${index + 1} earlier`}
          disabled={isPublishing || index === 0}
          onClick={() => onMove(item.key, -1)}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="rounded-full"
          aria-label={`Move photo ${index + 1} later`}
          disabled={isPublishing || index === count - 1}
          onClick={() => onMove(item.key, 1)}
        >
          <ArrowDown className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="rounded-full"
          aria-label={`Remove photo ${index + 1}`}
          disabled={isPublishing}
          onClick={() => onRemove(item.key)}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}

function FormSelect({
  form,
  name,
  label,
  options,
  disabled,
}: {
  form: UseFormReturn<CreateMarketplaceListingData>;
  name:
    | typeof CREATE_MARKETPLACE_LISTING_FIELDS.CONDITION
    | typeof CREATE_MARKETPLACE_LISTING_FIELDS.SALE_FORMAT
    | typeof CREATE_MARKETPLACE_LISTING_FIELDS.CURRENCY
    | typeof CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT
    | typeof CREATE_MARKETPLACE_LISTING_FIELDS.RETURN_DAYS;
  label: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
}) {
  return (
    <Container className="gap-2">
      <Label htmlFor={name} className={FORM_LABEL_CLASSES}>
        {label}
      </Label>
      <Controller
        name={name}
        control={form.control}
        render={({ field, fieldState }) => (
          <>
            <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
              <SelectTrigger id={name} className="h-11 w-full rounded-md border px-3" aria-invalid={!!fieldState.error}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldState.error && (
              <Typography as="p" role="alert" className="text-sm text-destructive">
                {fieldState.error.message}
              </Typography>
            )}
          </>
        )}
      />
    </Container>
  );
}
