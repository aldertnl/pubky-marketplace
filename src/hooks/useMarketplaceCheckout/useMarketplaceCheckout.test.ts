import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceCartItem } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { useMarketplaceCheckout } from './useMarketplaceCheckout';

const listing = createCommerceSandboxCatalog().listings.find(({ sale }) => sale.format === 'fixed_price')!;
const price = listing.sale.format === 'fixed_price' ? listing.sale.unitPrice : listing.sale.startingPrice;
const item: MarketplaceCartItem = {
  id: 'cart-item',
  listingId: `${listing.ownerPubky}:${listing.listingId}`,
  variantId: listing.variants[0].id,
  quantity: 1,
  listing: {
    id: `${listing.ownerPubky}:${listing.listingId}`,
    seller_id: listing.ownerPubky,
    listing_id: listing.listingId,
    record: { ...listing, fulfillmentMethods: ['physical' as const] },
    revision: 1,
    state: 'active',
    category_id: listing.categoryId,
    format: listing.sale.format,
    currency: price.currency,
    price_minor: price.amountMinor,
    sync_status: 'synced',
    updated_at: Date.parse(listing.updatedAt),
  },
};

const config = vi.hoisted(() => ({
  mode: 'sandbox' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingProjection: vi.fn(),
    syncListingRegistration: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
    fetchPickupAvailable: vi.fn(async () => true),
    commitCreateMarketplaceCheckout: vi.fn(),
    getDeliveryAddresses: vi.fn(async () => []),
    commitUpsertDeliveryAddress: vi.fn(async () => {}),
    commitMarkDeliveryAddressUsed: vi.fn(async () => {}),
    hasActiveMarketplaceSession: vi.fn(() => false),
    clearMarketplaceSession: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

const authMock = vi.hoisted(() => ({ currentUserPubky: null as string | null }));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: authMock.currentUserPubky }),
}));

const BUYER = 'b'.repeat(52);

const savedAddress = {
  id: `${BUYER}:addr1`,
  owner_id: BUYER,
  label: 'Home',
  name: 'Alice Buyer',
  line1: '1 Market Street',
  line2: '',
  city: 'New York',
  region: 'NY',
  postal_code: '10001',
  country_code: 'US',
  is_default: true,
  last_used_at: null,
  created_at: 100,
  updated_at: 100,
};

describe('useMarketplaceCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    authMock.currentUserPubky = null;
    useCommerceStore.setState({ marketplaceSession: null });
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([]);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000001100');
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: `listing:${listing.ownerPubky}_${listing.listingId}`,
      sellerPubky: listing.ownerPubky,
      listingId: listing.listingId,
      listingRevision: listing.revision,
      contentHash: listing.media[0].contentHash,
      serverRevision: 1,
      state: 'available',
      availableQuantity: 1,
      reservedQuantity: 0,
      unitPrice: price,
      saleFormat: 'fixed_price',
      fulfillmentMethods: ['shipping'],
      auction: null,
    });
    vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000001100',
      aggregateId: 'checkout:00000000-0000-4000-8000-000000001100',
      revision: 1,
      eventIds: ['00000000-0000-4000-8000-000000001101'],
      result: { kind: 'checkout' },
    });
  });

  it('refreshes terms and creates a guarantee-versioned checkout', async () => {
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.commitCreateMarketplaceCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        fulfillmentChoiceBySeller: { [listing.ownerPubky]: 'shipping' },
        deliveryAddress: expect.objectContaining({ line1: '1 Market Street' }),
        lines: [
          {
            listingAggregateId: `listing:${listing.ownerPubky}_${listing.listingId}`,
            sellerPubky: listing.ownerPubky,
            publishedFulfillmentMethods: ['shipping'],
            expectedRevision: 1,
            quantity: 1,
            // The chosen variant rides the line as a display snapshot: the
            // id plus its option dimensions as an ordered {name, value}
            // array (safe through the wire-casing layer).
            variantId: listing.variants[0].id,
            ...(Object.keys(listing.variants[0].options).length
              ? {
                  variantOptions: Object.entries(listing.variants[0].options).map(([name, value]) => ({
                    name,
                    value,
                  })),
                }
              : {}),
          },
        ],
      }),
    );
    expect(clear).toHaveBeenCalled();
  });

  it('heals an unregistered cart line with one sync before checking out', async () => {
    config.mode = 'transaction-service';
    const registered = {
      aggregateId: `listing:${listing.ownerPubky}_${listing.listingId}`,
      serverRevision: 1,
    };
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(registered as never);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledWith(listing.ownerPubky, listing.listingId);
    expect(CommerceController.commitCreateMarketplaceCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [expect.objectContaining({ listingAggregateId: registered.aggregateId, expectedRevision: 1 })],
      }),
    );
  });

  it('fails honestly when the line sync also cannot register the listing', async () => {
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
    } as never);
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
    expect(CommerceController.commitCreateMarketplaceCheckout).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('could not be prepared for checkout') }),
    );
  });

  it('keeps the cart and asks for a retry when a listing revision conflicts mid-checkout', async () => {
    vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mockResolvedValue({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'The aggregate changed.', currentRevision: 2 },
    });
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('place the order again') }),
    );
  });

  it('prefills from the top saved address and marks it used after a successful order', async () => {
    authMock.currentUserPubky = BUYER;
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([savedAddress]);
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));

    await vi.waitFor(() => {
      if (result.current.selectedAddressId !== savedAddress.id) throw new Error('Address has not been applied yet.');
    });
    expect(result.current.addresses).toEqual([savedAddress]);
    expect(result.current.form.getValues('line1')).toBe('1 Market Street');
    expect(result.current.form.getValues('acceptsGuarantee')).toBe(false);

    act(() => {
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.commitCreateMarketplaceCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryAddress: {
          name: 'Alice Buyer',
          line1: '1 Market Street',
          line2: '',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'US',
        },
      }),
    );
    expect(CommerceController.commitMarkDeliveryAddressUsed).toHaveBeenCalledWith('addr1');
    expect(CommerceController.commitUpsertDeliveryAddress).not.toHaveBeenCalled();
  });

  it('saves a new labeled address after ordering when the buyer opted in', async () => {
    authMock.currentUserPubky = BUYER;
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('saveAddress', true);
      result.current.form.setValue('saveLabel', 'Home');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(CommerceController.commitUpsertDeliveryAddress).toHaveBeenCalledWith(expect.any(String), {
      label: 'Home',
      name: 'Alice Buyer',
      line1: '1 Market Street',
      line2: '',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      countryCode: 'US',
    });
    expect(CommerceController.commitMarkDeliveryAddressUsed).toHaveBeenCalled();
  });

  it('drops the picker selection when the buyer edits a picked address', async () => {
    authMock.currentUserPubky = BUYER;
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([savedAddress]);
    const { result } = renderHook(() =>
      useMarketplaceCheckout(
        [item],
        vi.fn(async () => {}),
      ),
    );
    await vi.waitFor(() => {
      if (result.current.selectedAddressId !== savedAddress.id) throw new Error('Address has not been applied yet.');
    });

    act(() => {
      result.current.form.setValue('line1', '99 Elsewhere Avenue');
    });

    await vi.waitFor(() => {
      if (result.current.selectedAddressId !== null) throw new Error('Selection has not been dropped yet.');
    });

    // Re-picking restores the saved values.
    act(() => {
      result.current.selectAddress(savedAddress.id);
    });
    expect(result.current.form.getValues('line1')).toBe('1 Market Street');
    expect(result.current.selectedAddressId).toBe(savedAddress.id);
  });

  it('leaves the guarantee unchecked until the buyer opts in', async () => {
    const { result } = renderHook(() =>
      useMarketplaceCheckout(
        [item],
        vi.fn(async () => {}),
      ),
    );

    expect(result.current.form.getValues('acceptsGuarantee')).toBe(false);
    expect(result.current.form.formState.errors.acceptsGuarantee).toBeUndefined();

    let succeeded = true;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(CommerceController.commitCreateMarketplaceCheckout).not.toHaveBeenCalled();
    expect(result.current.form.formState.errors.acceptsGuarantee?.message).toBe('Accept the guarantee terms.');
  });

  it('reports hasMarketplaceSession only when the store and getActiveSession agree', () => {
    vi.mocked(CommerceController.hasActiveMarketplaceSession).mockReturnValue(true);
    useCommerceStore.setState({
      marketplaceSession: {
        pubky: BUYER,
        capabilities: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuedAt: '2026-08-21T00:00:00.000Z',
      },
    });
    const { result } = renderHook(() =>
      useMarketplaceCheckout(
        [item],
        vi.fn(async () => {}),
      ),
    );

    expect(result.current.hasMarketplaceSession).toBe(true);

    vi.mocked(CommerceController.hasActiveMarketplaceSession).mockReturnValue(false);
    const expired = renderHook(() =>
      useMarketplaceCheckout(
        [item],
        vi.fn(async () => {}),
      ),
    );
    expect(expired.result.current.hasMarketplaceSession).toBe(false);
  });
});

describe('useMarketplaceCheckout local pickup (§A2)', () => {
  const OTHER_SELLER = 'z'.repeat(52);

  function itemWithFulfillment(
    methods: Array<'physical' | 'digital' | 'shipping' | 'pickup'>,
    sellerPubky = listing.ownerPubky,
  ): MarketplaceCartItem {
    return {
      ...item,
      id: `cart-item-${sellerPubky.slice(0, 4)}-${methods.join('-')}`,
      listing: {
        ...item.listing,
        id: `${sellerPubky}:${listing.listingId}`,
        seller_id: sellerPubky,
        record: { ...item.listing.record, ownerPubky: sellerPubky, fulfillmentMethods: methods },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    authMock.currentUserPubky = null;
    useCommerceStore.setState({ marketplaceSession: null });
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([]);
    vi.mocked(CommerceController.fetchPickupAvailable).mockResolvedValue(true);
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: `listing:${listing.ownerPubky}_${listing.listingId}`,
      sellerPubky: listing.ownerPubky,
      listingId: listing.listingId,
      listingRevision: listing.revision,
      contentHash: listing.media[0].contentHash,
      serverRevision: 1,
      state: 'available',
      availableQuantity: 1,
      reservedQuantity: 0,
      unitPrice: price,
      saleFormat: 'fixed_price',
      fulfillmentMethods: ['shipping'],
      auction: null,
    });
    vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000001100',
      aggregateId: 'checkout:00000000-0000-4000-8000-000000001100',
      revision: 1,
      eventIds: ['00000000-0000-4000-8000-000000001101'],
      result: { kind: 'checkout' },
    });
  });

  it('omits the delivery address from the checkout command on a pickup-only cart', async () => {
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([itemWithFulfillment(['pickup'])], clear));

    expect(result.current.requiresDeliveryAddress).toBe(false);
    expect(result.current.fulfillmentForSeller(listing.ownerPubky)).toBe('pickup');
    act(() => {
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    const command = vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mock.calls[0][0];
    expect(command).not.toHaveProperty('deliveryAddress');
    expect(command.fulfillmentChoiceBySeller).toEqual({ [listing.ownerPubky]: 'pickup' });
    expect(clear).toHaveBeenCalled();
  });

  it('sends the address on a mixed cart and keeps each group\u2019s fulfillment choice independent', async () => {
    const shippingItem = itemWithFulfillment(['physical'], OTHER_SELLER);
    const bothWaysItem = itemWithFulfillment(['physical', 'shipping', 'pickup']);
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([shippingItem, bothWaysItem], clear));

    // The buyer collects from the both-ways seller; the other seller ships.
    act(() => {
      result.current.setFulfillmentChoice(listing.ownerPubky, 'pickup');
    });
    expect(result.current.fulfillmentForSeller(listing.ownerPubky)).toBe('pickup');
    expect(result.current.fulfillmentForSeller(OTHER_SELLER)).toBe('shipping');
    expect(result.current.requiresDeliveryAddress).toBe(true);
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    const command = vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mock.calls[0][0];
    expect(command.deliveryAddress).toEqual(expect.objectContaining({ line1: '1 Market Street' }));
    expect(command.fulfillmentChoiceBySeller).toEqual({
      [listing.ownerPubky]: 'pickup',
      [OTHER_SELLER]: 'shipping',
    });
  });

  it('removes pickup from the options when the deployment capability is off', async () => {
    vi.mocked(CommerceController.fetchPickupAvailable).mockResolvedValue(false);
    const { result } = renderHook(() =>
      useMarketplaceCheckout(
        [itemWithFulfillment(['physical', 'shipping', 'pickup'])],
        vi.fn(async () => {}),
      ),
    );

    await vi.waitFor(() => {
      expect(result.current.fulfillmentOptionsForSeller(listing.ownerPubky)).toEqual(['shipping']);
    });
    // A pickup-only listing on such a deployment leaves the group with no
    // common method — the honest conflict, never a silent shipping fallback.
    const conflict = renderHook(() =>
      useMarketplaceCheckout(
        [itemWithFulfillment(['pickup'])],
        vi.fn(async () => {}),
      ),
    );
    await vi.waitFor(() => {
      expect(conflict.result.current.fulfillmentOptionsForSeller(listing.ownerPubky)).toEqual([]);
    });
    expect(conflict.result.current.hasFulfillmentConflict).toBe(true);
  });

  it('maps server and thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_checkout';
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const clear = vi.fn(async () => {});
    const { result } = renderHook(() => useMarketplaceCheckout([item], clear));
    act(() => {
      result.current.form.setValue('name', 'Alice Buyer');
      result.current.form.setValue('line1', '1 Market Street');
      result.current.form.setValue('city', 'New York');
      result.current.form.setValue('region', 'NY');
      result.current.form.setValue('postalCode', '10001');
      result.current.form.setValue('acceptsGuarantee', true);
    });

    vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: sentinel },
    } as never);
    await act(async () => {
      await result.current.submit();
    });
    expect(vi.mocked(toast).mock.calls[0]?.[0]?.description).toBeTypeOf('string');
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);

    vi.mocked(CommerceController.commitCreateMarketplaceCheckout).mockRejectedValueOnce(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'checkout',
      }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
  });
});
