'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm, type UseFormReturn, useWatch } from 'react-hook-form';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceCartItem } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { commerceListingFulfillmentMethods } from '@/libs/commerce/marketplace-records';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';
import { pickupRefusalFailureMessage } from '@/libs/commerce/pickup';
import {
  classifyMarketplacePickupCommandRefusal,
  isMarketplaceRevisionConflict,
} from '@/libs/commerce/transaction-commands';
import { AppError } from '@/libs/error/error';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  MARKETPLACE_CHECKOUT_ADDRESS_FIELDS,
  type MarketplaceCheckoutData,
  marketplaceCheckoutDefaults,
  marketplaceCheckoutSchema,
} from './useMarketplaceCheckout.types';

/**
 * The bare (non-owner-prefixed) address id the controller works with — the
 * stored primary key is `${owner_id}:${addressId}`.
 */
function bareAddressId(address: CommerceDeliveryAddressModelSchema): string {
  return address.id.slice(address.owner_id.length + 1);
}

function addressFieldValues(
  address: CommerceDeliveryAddressModelSchema,
): Pick<MarketplaceCheckoutData, (typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]> {
  return {
    name: address.name,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postal_code,
    countryCode: address.country_code,
  };
}

/**
 * One `listing.sync` attempt followed by one projection re-read — the
 * buyer-side heal for a cart line whose listing was published before
 * durable-mode registration existed. Sync failures fall through to the
 * caller's honest failure toast.
 */
async function syncLineProjection(ownerPubky: string, listingId: string) {
  try {
    const response = await CommerceController.syncListingRegistration(ownerPubky, listingId);
    if (!response.ok) return null;
    return await CommerceController.getMarketplaceListingProjection(ownerPubky, listingId);
  } catch {
    return null;
  }
}

function formMatchesAddress(
  data: Pick<MarketplaceCheckoutData, (typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]>,
  address: CommerceDeliveryAddressModelSchema,
): boolean {
  const fields = addressFieldValues(address);
  return MARKETPLACE_CHECKOUT_ADDRESS_FIELDS.every((field) => {
    const entered = field === 'countryCode' ? data[field].trim().toUpperCase() : data[field].trim();
    return entered === fields[field];
  });
}

export function useMarketplaceCheckout(
  items: MarketplaceCartItem[],
  clearCart: () => Promise<void>,
): {
  form: UseFormReturn<MarketplaceCheckoutData>;
  submit: () => Promise<boolean>;
  needsSession: boolean;
  sessionError: string | null;
  /** True when the store holds session facts and getActiveSession still accepts them. */
  hasMarketplaceSession: boolean;
  /** Saved addresses in picker order (default first, then last used). */
  addresses: CommerceDeliveryAddressModelSchema[];
  /** Composite row id of the applied saved address; null while entering a new one. */
  selectedAddressId: string | null;
  selectAddress: (id: string | null) => void;
  /**
   * The fulfillment methods a seller group's lines ALL publish (the choice
   * is selectable only among these, §A2), filtered by the deployment's
   * `pickup_available` capability. Empty when the group's lines force
   * incompatible single methods — a conflict the cart must surface.
   */
  fulfillmentOptionsForSeller: (sellerPubky: string) => MarketplaceFulfillmentMethod[];
  /** The group's effective choice: the buyer's, else shipping when shippable. */
  fulfillmentForSeller: (sellerPubky: string) => MarketplaceFulfillmentMethod | undefined;
  setFulfillmentChoice: (sellerPubky: string, method: MarketplaceFulfillmentMethod) => void;
  /** False only when EVERY group is pickup — a pickup-only checkout sends no address (§A2). */
  requiresDeliveryAddress: boolean;
  /** True when a group's lines force incompatible single fulfillments. */
  hasFulfillmentConflict: boolean;
  /** The number of orders this checkout places — one per (seller, fulfillment) group. */
  orderCount: number;
} {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Connecting a session replaces this store object; the flag below clears so
  // the cart's session-required card disappears without a submit attempt.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const hasActiveServiceSession = CommerceController.hasActiveMarketplaceSession();
  const [needsSession, setNeedsSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [pickupAvailable, setPickupAvailable] = useState<boolean | null>(null);
  const [choiceOverrides, setChoiceOverrides] = useState<Record<string, MarketplaceFulfillmentMethod>>({});
  const appliedInitialAddressRef = useRef(false);
  const form = useForm<MarketplaceCheckoutData>({
    resolver: zodResolver(marketplaceCheckoutSchema),
    defaultValues: marketplaceCheckoutDefaults,
    mode: 'onTouched',
  });

  const addresses = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getDeliveryAddresses();
    },
    [currentUserPubky],
    [] as CommerceDeliveryAddressModelSchema[],
  );

  // If getActiveSession dropped the bearer (TTL margin), null the store copy
  // so step 1 cannot stay "approved" after the service would reject.
  useEffect(() => {
    if (marketplaceSession !== null && !CommerceController.hasActiveMarketplaceSession()) {
      CommerceController.clearMarketplaceSession();
    }
  }, [marketplaceSession]);

  // Pre-fill once from the picker's top address (default, else last used) —
  // but never over anything the buyer already typed.
  useEffect(() => {
    if (appliedInitialAddressRef.current) return;
    const first = addresses[0];
    if (!first) return;
    appliedInitialAddressRef.current = true;
    if (form.formState.isDirty) return;
    form.reset({ ...form.getValues(), ...addressFieldValues(first) });
    setSelectedAddressId(first.id);
  }, [addresses, form]);

  // Editing any address field after picking a saved address turns the entry
  // back into a "new address", which is what re-reveals the save controls.
  const watchedAddressValues = useWatch({
    control: form.control,
    name: MARKETPLACE_CHECKOUT_ADDRESS_FIELDS as unknown as Array<(typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]>,
  });
  useEffect(() => {
    setSelectedAddressId((current) => {
      if (current === null) return null;
      const selected = addresses.find(({ id }) => id === current);
      if (!selected) return null;
      // The watched values only trigger this effect; the comparison reads the
      // live form state, which a just-applied `form.reset` already reflects.
      return formMatchesAddress(form.getValues(), selected) ? current : null;
    });
  }, [addresses, watchedAddressValues, form]);

  useEffect(() => {
    if (!marketplaceSession) return;
    setNeedsSession(false);
    setSessionError(null);
  }, [marketplaceSession]);

  // The deployment capability (§A7): pickup choices are offered only when
  // the service reports `pickup_available` (off without the sealing key, and
  // off on every sandbox-payments deployment — the sandbox included).
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

  // Per-seller-group fulfillment resolution (§A2): the intersection of the
  // methods every line in the group publishes — the choice is selectable
  // only among those, never silently rewritten to shipping (the prior art's
  // `?? 'shipping'` defect, PR 22 review item 1).
  const optionsBySeller = new Map<string, MarketplaceFulfillmentMethod[]>();
  for (const item of items) {
    const sellerPubky = item.listing.record.ownerPubky;
    const published = commerceListingFulfillmentMethods(item.listing.record.fulfillmentMethods);
    const allowed = pickupAvailable === false ? published.filter((method) => method !== 'pickup') : published;
    const existing = optionsBySeller.get(sellerPubky);
    optionsBySeller.set(sellerPubky, existing ? existing.filter((method) => allowed.includes(method)) : [...allowed]);
  }
  const fulfillmentOptionsForSeller = (sellerPubky: string) => optionsBySeller.get(sellerPubky) ?? [];
  const fulfillmentForSeller = (sellerPubky: string): MarketplaceFulfillmentMethod | undefined => {
    const options = fulfillmentOptionsForSeller(sellerPubky);
    if (options.length === 0) return undefined;
    const override = choiceOverrides[sellerPubky];
    if (override && options.includes(override)) return override;
    return options.includes('shipping') ? 'shipping' : options[0];
  };
  const hasFulfillmentConflict = [...optionsBySeller.values()].some((options) => options.length === 0);
  const requiresDeliveryAddress =
    items.length === 0 ||
    [...optionsBySeller.keys()].some((sellerPubky) => fulfillmentForSeller(sellerPubky) !== 'pickup');
  const orderCount = optionsBySeller.size;

  // Keep the hidden schema flag in sync so the address requirement follows
  // the groups (a pickup-only checkout must not demand — or send — one, §A2).
  useEffect(() => {
    form.setValue('requiresDeliveryAddress', requiresDeliveryAddress, { shouldValidate: true });
  }, [form, requiresDeliveryAddress]);

  const setFulfillmentChoice = (sellerPubky: string, method: MarketplaceFulfillmentMethod) => {
    setChoiceOverrides((current) => ({ ...current, [sellerPubky]: method }));
  };

  const selectAddress = (id: string | null) => {
    if (id === null) {
      setSelectedAddressId(null);
      return;
    }
    const address = addresses.find((candidate) => candidate.id === id);
    if (!address) return;
    form.reset({ ...form.getValues(), ...addressFieldValues(address) });
    setSelectedAddressId(id);
  };

  /**
   * Address book bookkeeping after a successful order: a used saved address
   * gets its last-used timestamp; a new address the buyer opted to keep is
   * created (and immediately marked used). Local-only writes — the address
   * itself traveled exactly once, inside the checkout command.
   */
  const persistAddressBookAfterOrder = async (data: MarketplaceCheckoutData): Promise<void> => {
    try {
      const selected = addresses.find(({ id }) => id === selectedAddressId);
      if (selected && formMatchesAddress(data, selected)) {
        await CommerceController.commitMarkDeliveryAddressUsed(bareAddressId(selected));
        return;
      }
      if (!data.saveAddress || !data.saveLabel) return;
      const addressId = crypto.randomUUID().replaceAll('-', '');
      await CommerceController.commitUpsertDeliveryAddress(addressId, {
        label: data.saveLabel,
        name: data.name,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        region: data.region,
        postalCode: data.postalCode,
        countryCode: data.countryCode.toUpperCase(),
      });
      await CommerceController.commitMarkDeliveryAddressUsed(addressId);
    } catch {
      // The order already succeeded; failing to update the local address book
      // must not look like a failed checkout.
      toast({ variant: 'error', description: 'The order was placed, but the address could not be saved.' });
    }
  };

  const submit = async (): Promise<boolean> => {
    if (!items.length) return false;
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      try {
        const lines = await Promise.all(
          items.map(async (item) => {
            const record = item.listing.record;
            let projection = await CommerceController.getMarketplaceListingProjection(
              record.ownerPubky,
              record.listingId,
            );
            // An unregistered line is healable by the buyer: one sync
            // attempt per listing per submit, then one re-read, before the
            // line is declared dead.
            if (!projection && isDurableCommerceMode(getCommerceAdapterMode())) {
              projection = await syncLineProjection(record.ownerPubky, record.listingId);
            }
            if (!projection) return null;
            // Snapshot the chosen variant for fulfillment display: the id and
            // its option dimensions ride the line as an ordered {name, value}
            // array (safe through the wire-casing layer) and are echoed back
            // on the order for packing slips and order rows.
            const variant = record.variants.find(({ id }) => id === item.variantId);
            const variantOptions = variant ? Object.entries(variant.options) : [];
            return {
              listingAggregateId: projection.aggregateId,
              sellerPubky: record.ownerPubky,
              publishedFulfillmentMethods: commerceListingFulfillmentMethods(record.fulfillmentMethods),
              expectedRevision: projection.serverRevision,
              quantity: item.quantity,
              ...(variant ? { variantId: variant.id } : {}),
              ...(variantOptions.length
                ? { variantOptions: variantOptions.map(([name, value]) => ({ name, value })) }
                : {}),
            };
          }),
        );
        if (lines.some((line) => line === null)) {
          toast({
            variant: 'error',
            description:
              'A listing in your cart could not be prepared for checkout. It may have been removed by the seller. Nothing was ordered.',
          });
          return;
        }
        // The fulfillment-aware checkout (§A2): one choice per seller group,
        // the service splits one order per (seller, fulfillment), and the
        // delivery address rides only when at least one group ships.
        const fulfillmentChoiceBySeller: Record<string, MarketplaceFulfillmentMethod> = {};
        for (const sellerPubky of optionsBySeller.keys()) {
          const fulfillment = fulfillmentForSeller(sellerPubky);
          if (fulfillment) fulfillmentChoiceBySeller[sellerPubky] = fulfillment;
        }
        const checkoutLines = lines.filter((line): line is NonNullable<typeof line> => line !== null);
        const response = await CommerceController.commitCreateMarketplaceCheckout({
          lines: checkoutLines,
          fulfillmentChoiceBySeller,
          ...(requiresDeliveryAddress
            ? {
                deliveryAddress: {
                  name: data.name,
                  line1: data.line1,
                  line2: data.line2,
                  city: data.city,
                  region: data.region,
                  postalCode: data.postalCode,
                  countryCode: data.countryCode.toUpperCase(),
                },
              }
            : {}),
        });
        if (!response.ok) {
          if (isMarketplaceRevisionConflict(response)) {
            // The revisions were read at submit time, so a conflict means a
            // listing moved mid-checkout; the next submit re-reads them all.
            toast({
              variant: 'error',
              description: 'A listing changed while you were checking out. Review your cart and place the order again.',
            });
            return;
          }
          const pickupRefusal = classifyMarketplacePickupCommandRefusal(response);
          toast({
            variant: 'error',
            description: pickupRefusal
              ? pickupRefusalFailureMessage(pickupRefusal)
              : marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.checkout),
          });
          return;
        }
        // The address book only learns an address that actually traveled —
        // a pickup-only checkout sent none (§A2).
        if (requiresDeliveryAddress) await persistAddressBookAfterOrder(data);
        await clearCart();
        succeeded = true;
        const mode = getCommerceAdapterMode();
        toast({
          title: 'Order created',
          description:
            mode === 'sandbox'
              ? 'Complete the sandbox payment to continue.'
              : mode === 'locks-paykit'
                ? 'Recorded by the transaction service. Open Orders to request the payment in your wallet.'
                : 'Recorded by the transaction service. Payments are not enabled here, so it will stay awaiting payment.',
        });
      } catch (checkoutError) {
        if (isMarketplaceSessionRequiredError(checkoutError)) {
          // The projection reads and the checkout command both require the
          // durable session; surface the reconnect affordance instead of a
          // generic failure toast. The controller already cleared store+service.
          setNeedsSession(true);
          setSessionError(MARKETPLACE_FAILURE_MESSAGES.session);
          toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
          return;
        }
        if (checkoutError instanceof AppError) {
          toast({
            variant: 'error',
            description: marketplaceFailureMessage(
              marketplaceErrorCode(checkoutError),
              MARKETPLACE_FAILURE_MESSAGES.checkout,
              checkoutError,
            ),
          });
          return;
        }
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.checkout });
      }
    })();
    return succeeded;
  };

  return {
    form,
    submit,
    needsSession,
    sessionError,
    hasMarketplaceSession: marketplaceSession !== null && hasActiveServiceSession,
    addresses,
    selectedAddressId,
    selectAddress,
    fulfillmentOptionsForSeller,
    fulfillmentForSeller,
    setFulfillmentChoice,
    requiresDeliveryAddress,
    hasFulfillmentConflict,
    orderCount,
  };
}
