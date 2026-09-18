import { describe, expect, it } from 'vitest';
import {
  availablePaymentMethods,
  isPlausibleAccountXpub,
  isStripePaymentLink,
  isStripeRestrictedKey,
  sellerPaymentConfigSchema,
} from './payment-methods';

const TPUB =
  'tpubDC5FSnBiZDMmhiuCmWAYsLwgLYrrT9rAqvTySfuCCrgsWz8wxMXUS9Tb9iVMvcRbvFcAHGkMD5Kx8koh4GquNGNTfohfk7pgjhaPCdXpoba';

describe('payment-methods', () => {
  describe('availablePaymentMethods', () => {
    it('renders methods in bitcoin, stripe, paypal order and only when configured', () => {
      expect(
        availablePaymentMethods({
          bitcoinAvailable: true,
          bitcoinOfferAvailable: true,
          stripePaymentLink: 'https://buy.stripe.com/test_abc',
          paypalMerchantEmail: 'seller@example.com',
        }),
      ).toEqual(['bitcoin', 'stripe', 'paypal']);
      expect(
        availablePaymentMethods({
          bitcoinAvailable: false,
          bitcoinOfferAvailable: true,
          stripePaymentLink: null,
          paypalMerchantEmail: null,
        }),
      ).toEqual([]);
      expect(
        availablePaymentMethods({
          bitcoinAvailable: false,
          bitcoinOfferAvailable: true,
          stripePaymentLink: null,
          paypalMerchantEmail: 'seller@example.com',
        }),
      ).toEqual(['paypal']);
    });

    it('defaults an absent Bitcoin offer gate to available for older services', () => {
      const config = sellerPaymentConfigSchema.parse({
        bitcoinAvailable: true,
        stripePaymentLink: null,
        paypalMerchantEmail: null,
      });

      expect(config.bitcoinOfferAvailable).toBe(true);
      expect(availablePaymentMethods(config)).toEqual(['bitcoin']);
    });

    it('omits Bitcoin when the rail-wide offer gate is off', () => {
      const config = sellerPaymentConfigSchema.parse({
        bitcoinAvailable: true,
        bitcoinOfferAvailable: false,
        stripePaymentLink: null,
        paypalMerchantEmail: null,
      });

      expect(availablePaymentMethods(config)).toEqual([]);
    });

    it('keeps Bitcoin when the rail-wide offer gate is on', () => {
      const config = sellerPaymentConfigSchema.parse({
        bitcoinAvailable: true,
        bitcoinOfferAvailable: true,
        stripePaymentLink: null,
        paypalMerchantEmail: null,
      });

      expect(availablePaymentMethods(config)).toEqual(['bitcoin']);
    });
  });

  describe('isStripePaymentLink', () => {
    it('accepts only https links on Stripe-hosted payment link hosts', () => {
      expect(isStripePaymentLink('https://buy.stripe.com/test_abc123')).toBe(true);
      expect(isStripePaymentLink('https://book.stripe.com/abc123')).toBe(true);
      expect(isStripePaymentLink('http://buy.stripe.com/test_abc123')).toBe(false);
      expect(isStripePaymentLink('https://evil.example.com/buy.stripe.com')).toBe(false);
      expect(isStripePaymentLink('https://stripe.com/payments')).toBe(false);
      expect(isStripePaymentLink('not a url')).toBe(false);
    });
  });

  describe('isStripeRestrictedKey', () => {
    it('accepts rk_ keys and refuses secret sk_ keys so they never leave the browser', () => {
      expect(isStripeRestrictedKey('rk_test_51NzXAbCdEfGh')).toBe(true);
      expect(isStripeRestrictedKey('rk_live_51NzXAbCdEfGh')).toBe(true);
      expect(isStripeRestrictedKey(' rk_test_51NzXAbCdEfGh ')).toBe(true);
      expect(isStripeRestrictedKey('sk_test_51NzXAbCdEfGh')).toBe(false);
      expect(isStripeRestrictedKey('pk_test_51NzXAbCdEfGh')).toBe(false);
      expect(isStripeRestrictedKey('rk_test_')).toBe(false);
      expect(isStripeRestrictedKey('')).toBe(false);
    });
  });

  describe('isPlausibleAccountXpub', () => {
    it('accepts a real tpub and tolerates surrounding whitespace', () => {
      expect(isPlausibleAccountXpub(TPUB)).toBe(true);
      expect(isPlausibleAccountXpub(`  ${TPUB}\n`)).toBe(true);
    });

    it('rejects wrong prefixes, wrong lengths, and non-base58 content', () => {
      expect(isPlausibleAccountXpub('')).toBe(false);
      expect(isPlausibleAccountXpub('npub1abcdef')).toBe(false);
      expect(isPlausibleAccountXpub('tpubshort')).toBe(false);
      expect(isPlausibleAccountXpub(`${TPUB}0`)).toBe(false); // '0' is not base58
      expect(isPlausibleAccountXpub('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    });
  });
});
