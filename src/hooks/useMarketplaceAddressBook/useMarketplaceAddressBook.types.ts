import { z } from 'zod';

/**
 * Address book management form. Field limits mirror the checkout command
 * contract (and therefore the `deliveryAddressInput` normalizer), so every
 * saved address is submittable at checkout unchanged.
 */
export const marketplaceAddressFormSchema = z.object({
  label: z.string().trim().min(1, 'Give this address a label.').max(40, 'Keep the label under 40 characters.'),
  name: z.string().trim().min(1, 'Recipient name is required.').max(100),
  line1: z.string().trim().min(1, 'Address is required.').max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().min(1, 'City is required.').max(100),
  region: z.string().trim().min(1, 'Region is required.').max(100),
  postalCode: z.string().trim().min(1, 'Postal code is required.').max(32),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code.'),
});

export type MarketplaceAddressFormData = z.infer<typeof marketplaceAddressFormSchema>;

export const marketplaceAddressFormDefaults: MarketplaceAddressFormData = {
  label: '',
  name: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  countryCode: 'US',
};
