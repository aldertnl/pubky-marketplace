'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn, useWatch } from 'react-hook-form';
import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { commerceAttributeFieldsFor } from '@/config/taxonomy/taxonomy';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  type ListingMediaRecord,
  type PrepareListingMediaResult,
  useListingMediaManager,
  type UseListingMediaManagerResult,
} from '@/hooks/useListingMediaManager/useListingMediaManager';
import { useMeasurementSystem } from '@/hooks/useMeasurementSystem/useMeasurementSystem';
import { type CommerceListingRecord, commerceListingRecordSchema } from '@/libs/commerce/marketplace-records';
import { availablePaymentMethods } from '@/libs/commerce/payment-methods';
import {
  amountInputFromMoney,
  amountInputToMoney,
  assetForListingCurrency,
  type CommerceAsset,
  listingCurrencyChoiceForAsset,
} from '@/libs/commerce/pricing';
import {
  dimensionInputFromMillimeters,
  gramsFromWeightInput,
  type MeasurementSystem,
  millimetersFromDimensionInput,
  weightInputFromGrams,
} from '@/libs/commerce/units';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  type CreateMarketplaceListingData,
  createMarketplaceListingDefaults,
  type CreateMarketplaceListingDraftData,
  createMarketplaceListingDraftSchema,
  createMarketplaceListingSchema,
  fulfillmentFormValueFromRecord,
  fulfillmentMethodsFromForm,
  fulfillmentRequiresShipping,
  listingAttributeFormField,
} from './useCreateMarketplaceListing.types';

export interface UseCreateMarketplaceListingResult {
  form: UseFormReturn<CreateMarketplaceListingData>;
  media: UseListingMediaManagerResult;
  /** The draft's listing id — also the id the publish path reuses. */
  draftId: string;
  /** True when the form was hydrated from a locally autosaved draft. */
  restoredDraft: boolean;
  /** Source listing title when this draft was seeded by Duplicate. */
  seededFromTitle: string | null;
  /** True when Duplicate copied an auction as a fixed-price draft. */
  seededAuctionAsFixedPrice: boolean;
  submit: () => Promise<string | null>;
  reset: () => void;
  publishBlocked: 'no-method' | 'unverified' | null;
}

export function useCreateMarketplaceListing(): UseCreateMarketplaceListingResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const measurementSystem = useMeasurementSystem();
  const media = useListingMediaManager();
  const [draftId, setDraftId] = useState(() => crypto.randomUUID().replaceAll('-', ''));
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [seededFromTitle, setSeededFromTitle] = useState<string | null>(null);
  const [seededAuctionAsFixedPrice, setSeededAuctionAsFixedPrice] = useState(false);
  const [publishBlocked, setPublishBlocked] = useState<'no-method' | 'unverified' | null>(null);
  const draftReadyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingListingIdRef = useRef<string | null>(null);
  const form = useForm<CreateMarketplaceListingData>({
    resolver: zodResolver(createMarketplaceListingSchema),
    defaultValues: createMarketplaceListingDefaults,
    mode: 'onChange',
  });
  const watchedValues = useWatch({ control: form.control });

  // Adopt the preferred measurement system while the package fields are still
  // empty. Once something is typed (or a draft restored values), the form
  // keeps ITS system so labels always match the numbers on screen.
  useEffect(() => {
    const values = form.getValues();
    if (values.measurementSystem === measurementSystem) return;
    const hasPackageInput = [
      values.packageWeight,
      values.packageLength,
      values.packageWidth,
      values.packageHeight,
    ].some((value) => value.trim() !== '');
    if (!hasPackageInput) {
      form.setValue('measurementSystem', measurementSystem);
    }
    // Watched package fields re-run this after a draft restore resets the form.
  }, [
    measurementSystem,
    form,
    watchedValues.measurementSystem,
    watchedValues.packageWeight,
    watchedValues.packageLength,
    watchedValues.packageWidth,
    watchedValues.packageHeight,
  ]);

  useEffect(() => {
    if (!currentUserPubky) return;
    let active = true;
    CommerceController.getListingDrafts()
      .then((drafts) => {
        if (!active) return;
        const latest = drafts[0];
        const parsed = createMarketplaceListingDraftSchema.safeParse(latest?.data.form);
        if (latest && parsed.success) {
          setDraftId(latest.listing_id);
          form.reset({ ...createMarketplaceListingDefaults, ...normalizeDraftForm(parsed.data) });
          setRestoredDraft(true);
          setSeededFromTitle(parsed.data.seededFromTitle?.trim() ? parsed.data.seededFromTitle : null);
          setSeededAuctionAsFixedPrice(parsed.data.seededAuctionAsFixedPrice === true);
        }
        draftReadyRef.current = true;
      })
      .catch(() => {
        draftReadyRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, form]);

  useEffect(() => {
    if (!currentUserPubky) return;
    if (!draftReadyRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const serialized = JSON.stringify(watchedValues);
      if (serialized) {
        const form = JSON.parse(serialized) as Record<string, unknown>;
        if (seededFromTitle) {
          form.seededFromTitle = seededFromTitle;
          form.seededAuctionAsFixedPrice = seededAuctionAsFixedPrice;
        }
        void CommerceController.commitUpdateListingDraft(draftId, form);
      }
    }, 750);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [currentUserPubky, draftId, seededAuctionAsFixedPrice, seededFromTitle, watchedValues]);

  const submit = async (): Promise<string | null> => {
    if (!currentUserPubky) return null;
    setPublishBlocked(null);
    let createdListingId: string | null = null;

    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      try {
        const paymentConfig = await CommerceController.getSellerPaymentConfig(currentUserPubky);
        if (availablePaymentMethods(paymentConfig).length === 0) {
          setPublishBlocked('no-method');
          return null;
        }
      } catch {
        setPublishBlocked('unverified');
        return null;
      }
    }

    await form.handleSubmit(async (data) => {
      const preparedMedia = await media.prepare(currentUserPubky);
      if (!preparedMedia.ok) {
        toast({ variant: 'error', description: describeMediaFailure(preparedMedia.reason) });
        return;
      }

      // One listing id per draft, held across retries: a submit that fails
      // AFTER the homeserver PUT must overwrite the same record when
      // retried, never publish a duplicate. The id is the draft id itself.
      pendingListingIdRef.current ??= draftId;

      try {
        await uploadListingMedia(preparedMedia.uploads);
        const listing = buildListingRecord(currentUserPubky, data, preparedMedia.media, pendingListingIdRef.current);
        const { registered } = await CommerceController.commitUpsertListing(listing);
        await CommerceController.commitDeleteListingDraft(draftId);
        createdListingId = `${currentUserPubky}:${listing.listingId}`;
        pendingListingIdRef.current = null;
        if (registered) {
          toast({ title: 'Listing published', description: 'Your owner-signed listing is now available.' });
        } else {
          // Two truths, reported separately (same discipline as the Drop
          // Studio): the record IS on the homeserver; only the service
          // registration is missing, and it self-heals once a session exists.
          toast({
            title: 'Listing published — registration pending',
            description:
              'Your owner-signed listing is on your homeserver, but it is not buyable yet: connect a marketplace session and it will register automatically.',
          });
        }
      } catch (error) {
        Logger.error('Failed to publish a marketplace listing', { draftId, error });
        toast({ variant: 'error', description: 'Could not publish this listing.' });
      }
    })();

    return createdListingId;
  };

  const reset = () => {
    form.reset({ ...createMarketplaceListingDefaults, measurementSystem });
    media.reset();
    setRestoredDraft(false);
    setSeededFromTitle(null);
    setSeededAuctionAsFixedPrice(false);
    setPublishBlocked(null);
    pendingListingIdRef.current = null;
    draftReadyRef.current = false;
    void CommerceController.commitDeleteListingDraft(draftId);
    setDraftId(crypto.randomUUID().replaceAll('-', ''));
    draftReadyRef.current = true;
  };

  return {
    form,
    media,
    draftId,
    restoredDraft,
    seededFromTitle,
    seededAuctionAsFixedPrice,
    submit,
    reset,
    publishBlocked,
  };
}

/**
 * Maps a stored draft onto the current form shape. Legacy drafts carried the
 * package fields as raw record units (whole millimeters/grams under the old
 * field names); those values convert to the metric input unit (centimeters,
 * grams) and pin the draft to the metric system so labels match the numbers.
 * Legacy drafts also stored the bitcoin pricing choice as 'SATS'; it migrates
 * to the canonical 'BTC' here.
 */
export function normalizeDraftForm(draft: CreateMarketplaceListingDraftData): Partial<CreateMarketplaceListingData> {
  const {
    altText: _legacyAltText,
    weightGrams: legacyWeightGrams,
    lengthMillimeters: legacyLengthMm,
    widthMillimeters: legacyWidthMm,
    heightMillimeters: legacyHeightMm,
    currency: draftCurrency,
    fulfillment: draftFulfillment,
    seededFromTitle: _seededFromTitle,
    seededAuctionAsFixedPrice: _seededAuctionAsFixedPrice,
    ...draftForm
  } = draft;
  const normalized: Partial<CreateMarketplaceListingData> = { ...draftForm };
  if (draftCurrency !== undefined) {
    normalized.currency = draftCurrency === 'SATS' ? 'BTC' : draftCurrency;
  }
  // Legacy drafts stored the shipping choice as 'physical' (the old conflated
  // item-type/fulfillment axis); the fulfillment control now says 'shipping'.
  if (draftFulfillment !== undefined) {
    normalized.fulfillment = draftFulfillment === 'physical' ? 'shipping' : draftFulfillment;
  }

  const legacyDimension = (value: string | undefined): string | null =>
    value !== undefined && /^[1-9]\d*$/.test(value.trim())
      ? dimensionInputFromMillimeters(Number(value.trim()), 'metric')
      : null;

  const legacyLength = legacyDimension(legacyLengthMm);
  const legacyWidth = legacyDimension(legacyWidthMm);
  const legacyHeight = legacyDimension(legacyHeightMm);
  const legacyWeight = legacyWeightGrams !== undefined && /^[1-9]\d*$/.test(legacyWeightGrams.trim());

  if (legacyWeight && normalized.packageWeight === undefined) normalized.packageWeight = legacyWeightGrams.trim();
  if (legacyLength && normalized.packageLength === undefined) normalized.packageLength = legacyLength;
  if (legacyWidth && normalized.packageWidth === undefined) normalized.packageWidth = legacyWidth;
  if (legacyHeight && normalized.packageHeight === undefined) normalized.packageHeight = legacyHeight;
  if ((legacyWeight || legacyLength || legacyWidth || legacyHeight) && normalized.measurementSystem === undefined) {
    normalized.measurementSystem = 'metric';
  }

  return normalized;
}

export type SeededListingDraftForm = CreateMarketplaceListingData & {
  seededFromTitle: string;
  seededAuctionAsFixedPrice: boolean;
};

/**
 * Builds a create-studio draft from an owned listing. A new listing id is
 * assigned by the draft row, not copied from the source. Photos, revision,
 * drop membership, and reservation state are omitted — media is not part of
 * drafts, and sharing homeserver media ids across listings would couple
 * delete/edit of one listing to the other.
 */
export function seedDraftFormFromListing(
  record: CommerceListingRecord,
  measurementSystem: MeasurementSystem,
): SeededListingDraftForm {
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  const currency = listingCurrencyChoiceForAsset(price);
  if (currency === null) {
    throw new Error('unsupported-currency');
  }
  const isPhysical = record.fulfillmentMethods.includes('physical');
  if (!isPhysical && !record.fulfillmentMethods.includes('pickup')) {
    throw new Error('unsupported-fulfillment');
  }
  const fulfillment = fulfillmentFormValueFromRecord(record.fulfillmentMethods);
  const auctionAsFixed = record.sale.format === 'auction';
  const flatShipping = record.shippingOptions.find((option) => option.pricing === 'flat');
  const returnDays =
    record.returnPolicy.acceptsReturns && record.returnPolicy.returnWindowDays !== undefined
      ? record.returnPolicy.returnWindowDays <= 14
        ? ('14' as const)
        : ('30' as const)
      : ('none' as const);

  return {
    ...createMarketplaceListingDefaults,
    ...listingAttributeFormValues(record),
    title: record.title,
    description: record.description,
    categoryId: record.categoryId,
    condition: record.condition,
    countryCode: record.location.countryCode,
    region: record.location.region ?? '',
    saleFormat: 'fixed_price',
    currency,
    price: amountInputFromMoney(price),
    variants: record.variants.map((variant) => ({
      sku: variant.sku ? `${variant.sku}-copy` : '',
      size: variant.options.size ?? '',
      color: variant.options.color ?? '',
      style: variant.options.style ?? '',
      quantity: String(variant.quantity),
      priceOverride: variant.priceOverride ? amountInputFromMoney(variant.priceOverride) : '',
    })),
    fulfillment,
    shippingLabel: flatShipping ? flatShipping.label : createMarketplaceListingDefaults.shippingLabel,
    shippingPrice: flatShipping ? amountInputFromMoney(flatShipping.price) : '',
    shippingMinDays: flatShipping
      ? String(flatShipping.estimatedMinDays)
      : createMarketplaceListingDefaults.shippingMinDays,
    shippingMaxDays: flatShipping
      ? String(flatShipping.estimatedMaxDays)
      : createMarketplaceListingDefaults.shippingMaxDays,
    measurementSystem,
    packageWeight: record.package ? weightInputFromGrams(record.package.weightGrams, measurementSystem) : '',
    packageLength: record.package
      ? dimensionInputFromMillimeters(record.package.lengthMillimeters, measurementSystem)
      : '',
    packageWidth: record.package
      ? dimensionInputFromMillimeters(record.package.widthMillimeters, measurementSystem)
      : '',
    packageHeight: record.package
      ? dimensionInputFromMillimeters(record.package.heightMillimeters, measurementSystem)
      : '',
    returnDays,
    seededFromTitle: record.title,
    seededAuctionAsFixedPrice: auctionAsFixed,
  };
}

function listingAttributeFormValues(record: CommerceListingRecord): Partial<CreateMarketplaceListingData> {
  const formValues: Partial<CreateMarketplaceListingData> = {};
  const fieldsByKey = new Map(commerceAttributeFieldsFor(record.categoryId).map((field) => [field.key, field]));

  for (const [key, value] of Object.entries(record.attributes ?? {})) {
    const field = fieldsByKey.get(key);
    const formField = field ? listingAttributeFormField(field.key) : null;
    if (!field || !formField) continue;
    if (field.input === 'multi-select') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (
        Array.isArray(value) &&
        (field.maxValues === undefined || value.length <= field.maxValues) &&
        value.every((entry) => allowed.has(entry))
      ) {
        (formValues as Record<string, string | string[]>)[formField] = value;
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    if (field.input === 'select') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (allowed.has(value)) {
        (formValues as Record<string, string | string[]>)[formField] = value;
      }
      continue;
    }
    (formValues as Record<string, string | string[]>)[formField] = value;
  }

  return formValues;
}

export function describeMediaFailure(reason: Extract<PrepareListingMediaResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'no-photos':
      return 'Add at least one photo.';
    case 'missing-alt-text':
      return 'Every photo needs a description for screen readers.';
    case 'decode-failed':
      return 'A photo could not be processed. Remove it and try another file.';
  }
}

export async function uploadListingMedia(
  uploads: Array<{ record: ListingMediaRecord; bytes: Uint8Array }>,
): Promise<void> {
  for (const upload of uploads) {
    await CommerceController.commitCreateMedia(upload.record.id, upload.bytes);
  }
}

function buildListingRecord(
  ownerPubky: string,
  data: CreateMarketplaceListingData,
  media: ListingMediaRecord[],
  listingId: string,
): CommerceListingRecord {
  const now = new Date();
  const asset = assetForListingCurrency(data.currency);
  const unitPrice = amountInputToMoney(data.price, asset);
  const sale: CommerceListingRecord['sale'] =
    data.saleFormat === 'auction'
      ? {
          format: 'auction',
          startingPrice: unitPrice,
          minimumIncrement: { ...unitPrice, amountMinor: Math.max(100, Math.round(unitPrice.amountMinor * 0.05)) },
          startsAt: now.toISOString(),
          endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
          antiSnipingWindowSeconds: 120,
          antiSnipingExtensionSeconds: 120,
        }
      : {
          format: 'fixed_price',
          unitPrice,
          acceptsOffers: true,
        };
  const requiresShipping = fulfillmentRequiresShipping(data.fulfillment);
  const returnWindowDays = data.returnDays === 'none' ? undefined : Number(data.returnDays);

  return commerceListingRecordSchema.parse({
    schemaVersion: COMMERCE_CONTRACT_VERSION,
    recordType: 'listing',
    ownerPubky,
    revision: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    listingId,
    state: 'active',
    title: data.title,
    description: data.description,
    taxonomyVersion: COMMERCE_TAXONOMY_VERSION,
    categoryId: data.categoryId,
    attributes: listingAttributesFromFormData(data),
    condition: data.condition,
    tags: deriveTags(data.title),
    location: {
      countryCode: data.countryCode.toUpperCase(),
      region: data.region || undefined,
    },
    media,
    variants: buildListingVariants(data, media),
    sale,
    fulfillmentMethods: fulfillmentMethodsFromForm(data.fulfillment),
    package: requiresShipping ? buildPackageRecord(data) : undefined,
    shippingOptions: requiresShipping
      ? [
          data.freeShipping
            ? {
                id: 'seller_flat_rate',
                pricing: 'free' as const,
                label: data.shippingLabel,
                estimatedMinDays: Number(data.shippingMinDays),
                estimatedMaxDays: Number(data.shippingMaxDays),
              }
            : {
                id: 'seller_flat_rate',
                pricing: 'flat' as const,
                label: data.shippingLabel,
                price: amountInputToMoney(data.shippingPrice, asset),
                estimatedMinDays: Number(data.shippingMinDays),
                estimatedMaxDays: Number(data.shippingMaxDays),
              },
        ]
      : [],
    returnPolicy: {
      acceptsReturns: returnWindowDays !== undefined,
      returnWindowDays,
      buyerPaysReturnShipping: true,
    },
    adultOnly: false,
  });
}

/**
 * The structured item specifics for the chosen category: only the keys the
 * category's attribute set defines, only non-empty values. Returns
 * `undefined` when nothing was filled in, so the record omits the field
 * instead of publishing an empty object.
 */
export function listingAttributesFromFormData(
  data: CreateMarketplaceListingData,
): Record<string, string | string[]> | undefined {
  const attributes: Record<string, string | string[]> = {};
  for (const field of commerceAttributeFieldsFor(data.categoryId)) {
    const formField = listingAttributeFormField(field.key);
    if (!formField) continue;
    const value = data[formField];
    if (Array.isArray(value)) {
      if (value.length > 0) attributes[field.key] = value;
    } else if (value !== '') {
      attributes[field.key] = value;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

/** The canonical package record: entered units converted to exact integer millimeters/grams. */
export function buildPackageRecord(
  data: Pick<
    CreateMarketplaceListingData,
    'measurementSystem' | 'packageWeight' | 'packageLength' | 'packageWidth' | 'packageHeight'
  >,
): { weightGrams: number; lengthMillimeters: number; widthMillimeters: number; heightMillimeters: number } {
  const system = data.measurementSystem;
  return {
    weightGrams: gramsFromWeightInput(Number(data.packageWeight), system),
    lengthMillimeters: millimetersFromDimensionInput(Number(data.packageLength), system),
    widthMillimeters: millimetersFromDimensionInput(Number(data.packageWidth), system),
    heightMillimeters: millimetersFromDimensionInput(Number(data.packageHeight), system),
  };
}

export function buildListingVariants(
  data: Pick<CreateMarketplaceListingData, 'variants' | 'currency'>,
  media: ListingMediaRecord[],
): Array<Record<string, unknown>> {
  const asset: CommerceAsset = assetForListingCurrency(data.currency);
  return data.variants.map((variant, index) => ({
    id: `variant_${index + 1}`,
    sku: variant.sku || undefined,
    options: Object.fromEntries(
      [
        ['size', variant.size],
        ['color', variant.color],
        ['style', variant.style],
      ].filter((entry) => entry[1]),
    ),
    priceOverride: variant.priceOverride ? amountInputToMoney(variant.priceOverride, asset) : undefined,
    quantity: Number(variant.quantity),
    mediaIds: media.map(({ id }) => id),
    enabled: true,
  }));
}

export function deriveTags(title: string): string[] {
  return [
    ...new Set(
      title
        .toLocaleLowerCase('en-US')
        .split(/[^a-z0-9]+/)
        .filter((part) => part.length >= 3),
    ),
  ].slice(0, 5);
}
