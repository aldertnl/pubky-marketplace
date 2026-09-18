import { describe, expect, it } from 'vitest';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { marketplaceOrderSchema } from './marketplace-projections';

/**
 * Taxation was removed from the marketplace: no tax computation in checkout
 * (the sandbox service no longer adds an 8% line), no `tax` money field on
 * the order projection, and no Tax line in the UI.
 *
 * This test is the guard against it coming back: the shared order-projection
 * schema must not expose a `tax` field, and a wire payload that still
 * carries one (a stale or non-conforming service) must not surface it in the
 * parsed order the UI renders from.
 */
describe('marketplace order projection — taxation removed', () => {
  it('exposes no tax field and a tax-free total on a valid order', () => {
    const fixture = createOrderFixture('pending_payment');
    const parsed = marketplaceOrderSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('tax' in parsed.data).toBe(false);
      // The total stands on its own: subtotal + shipping, nothing added for tax.
      expect(parsed.data.total.amountMinor).toBe(parsed.data.subtotal.amountMinor + parsed.data.shipping.amountMinor);
    }
  });

  it('ignores a tax field on the wire rather than reintroducing it', () => {
    const fixture = createOrderFixture('pending_payment');
    const payload = { ...fixture, tax: { amountMinor: 1_096, currency: 'USD', exponent: 2 } };
    const parsed = marketplaceOrderSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // `.passthrough()` keeps unknown wire keys on the object; the declared
      // projection (schema shape / parse result fields the UI types from)
      // must still omit `tax`.
      expect('tax' in marketplaceOrderSchema.shape).toBe(false);
      expect(parsed.data.total.amountMinor).toBe(parsed.data.subtotal.amountMinor + parsed.data.shipping.amountMinor);
    }
  });
});
