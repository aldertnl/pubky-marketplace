import { z } from 'zod';

/**
 * The checkout form (local pickup design §A2): the delivery address is
 * required only when at least one cart group ships — a pickup-only checkout
 * sends NO address at all (the strictest reading of the address-privacy
 * policy). `requiresDeliveryAddress` is a hidden form value the cart keeps
 * in sync with the fulfillment choices, so the schema — and the cart's
 * `safeParse(formValues)` validity check — follows the groups.
 */
export const marketplaceCheckoutSchema = z
  .object({
    name: z.string().trim().max(100),
    line1: z.string().trim().max(200),
    line2: z.string().trim().max(200),
    city: z.string().trim().max(100),
    region: z.string().trim().max(100),
    postalCode: z.string().trim().max(32),
    countryCode: z
      .string()
      .trim()
      .refine((value) => value === '' || /^[A-Za-z]{2}$/.test(value), 'Use a two-letter country code.'),
    requiresDeliveryAddress: z.boolean(),
    acceptsGuarantee: z.boolean().refine((value) => value === true, {
      error: 'Accept the guarantee terms.',
    }),
    // Client-only address book controls; never part of the checkout command.
    saveAddress: z.boolean(),
    saveLabel: z.string().trim().max(40, 'Keep the label under 40 characters.'),
  })
  .superRefine((data, context) => {
    if (data.requiresDeliveryAddress) {
      if (!data.name) {
        context.addIssue({ code: 'custom', path: ['name'], message: 'Recipient name is required.' });
      }
      if (!data.line1) {
        context.addIssue({ code: 'custom', path: ['line1'], message: 'Address is required.' });
      }
      if (!data.city) {
        context.addIssue({ code: 'custom', path: ['city'], message: 'City is required.' });
      }
      if (!data.region) {
        context.addIssue({ code: 'custom', path: ['region'], message: 'Region is required.' });
      }
      if (!data.postalCode) {
        context.addIssue({ code: 'custom', path: ['postalCode'], message: 'Postal code is required.' });
      }
      if (!/^[A-Za-z]{2}$/.test(data.countryCode)) {
        context.addIssue({ code: 'custom', path: ['countryCode'], message: 'Use a two-letter country code.' });
      }
    }
    if (data.saveAddress && !data.saveLabel) {
      context.addIssue({ code: 'custom', path: ['saveLabel'], message: 'Give the saved address a label.' });
    }
  });

export type MarketplaceCheckoutData = z.infer<typeof marketplaceCheckoutSchema>;

export const marketplaceCheckoutDefaults: MarketplaceCheckoutData = {
  name: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  countryCode: 'US',
  requiresDeliveryAddress: true,
  acceptsGuarantee: false,
  saveAddress: false,
  saveLabel: '',
};

/** The checkout fields a saved address fills (everything except the guarantee and save controls). */
export const MARKETPLACE_CHECKOUT_ADDRESS_FIELDS = [
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'countryCode',
] as const;

export type MarketplaceCheckoutAddressField = (typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number];
