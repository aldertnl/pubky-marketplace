import { z } from 'zod';
import { OTHER_CARRIER_ID, SHIPPING_CARRIERS } from '@/libs/commerce/carriers';

const carrierIds = SHIPPING_CARRIERS.map(({ id }) => id) as [string, ...string[]];

export const marketplaceOrderActionSchema = z
  .object({
    action: z.enum(['cancel', 'ship', 'return', 'refund', 'review', 'review_edit']),
    reason: z.string().trim().max(2_000),
    /** Curated carrier id from the registry, or `other` with a free-text name below. */
    carrierChoice: z.enum(carrierIds),
    carrier: z.string().trim().max(100),
    trackingNumber: z.string().trim().max(200),
    amount: z.string().trim(),
    transactionId: z.string().trim().max(200),
    rating: z.string().trim(),
    text: z.string().trim().max(5_000),
    /**
     * Buyer-side amount-band opt-in (ratified D2): rendered only when the
     * seller's standing consent allows bands at all; the attestation carries
     * a band only when both sides agreed.
     */
    allowAmountBand: z.boolean(),
  })
  .superRefine((data, context) => {
    if (['cancel', 'return'].includes(data.action) && !data.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Reason is required.' });
    }
    if (data.action === 'ship') {
      if (!data.trackingNumber) {
        context.addIssue({ code: 'custom', path: ['trackingNumber'], message: 'The tracking number is required.' });
      }
      if (data.carrierChoice === OTHER_CARRIER_ID && !data.carrier) {
        context.addIssue({ code: 'custom', path: ['carrier'], message: 'Name the carrier.' });
      }
    }
    if (data.action === 'refund') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(data.amount) || Number(data.amount) <= 0) {
        context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter a valid refund amount.' });
      }
      if (data.transactionId.length < 8) {
        context.addIssue({ code: 'custom', path: ['transactionId'], message: 'Transaction evidence is required.' });
      }
    }
    if (['review', 'review_edit'].includes(data.action) && (!/^[1-5]$/.test(data.rating) || !data.text)) {
      context.addIssue({ code: 'custom', path: ['rating'], message: 'Rating and review text are required.' });
    }
  });

export type MarketplaceOrderActionData = z.infer<typeof marketplaceOrderActionSchema>;

export const marketplaceOrderActionDefaults: MarketplaceOrderActionData = {
  action: 'cancel',
  reason: '',
  carrierChoice: 'usps',
  carrier: '',
  trackingNumber: '',
  amount: '',
  transactionId: '',
  rating: '5',
  text: '',
  allowAmountBand: false,
};
