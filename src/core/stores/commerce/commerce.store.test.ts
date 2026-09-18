import { beforeEach, describe, expect, it } from 'vitest';
import { useCommerceStore } from './commerce.store';
import { commerceInitialState } from './commerce.types';

describe('useCommerceStore', () => {
  beforeEach(() => {
    useCommerceStore.getState().reset();
  });

  it('updates marketplace discovery filters and display preferences', () => {
    const store = useCommerceStore.getState();

    store.setQuery('vintage boots');
    store.setCategoryId('fashion-shoes-boots');
    store.setSaleFormat('auction');
    store.setConditions(['good', 'excellent', 'good']);
    store.setPriceRange(5_000, 20_000);
    store.setSort('ending_soon');
    store.setLayout('list');
    store.setSelectedListingId('seller:boots_01');

    expect(useCommerceStore.getState()).toMatchObject({
      query: 'vintage boots',
      categoryId: 'fashion-shoes-boots',
      saleFormat: 'auction',
      conditions: ['good', 'excellent'],
      minimumPriceMinor: 5_000,
      maximumPriceMinor: 20_000,
      sort: 'ending_soon',
      layout: 'list',
      selectedListingId: 'seller:boots_01',
    });
  });

  it('tracks pending entities idempotently', () => {
    const store = useCommerceStore.getState();

    store.setEntityPending('seller:boots_01', true);
    store.setEntityPending('seller:boots_01', true);
    store.setEntityPending('seller:jacket_01', true);
    store.setEntityPending('seller:boots_01', false);

    expect(useCommerceStore.getState().pendingEntityIds).toEqual(['seller:jacket_01']);
  });

  it('resets filters without discarding layout, selection, or in-flight UI state', () => {
    const store = useCommerceStore.getState();
    store.setQuery('boots');
    store.setCategoryId('fashion');
    store.setLayout('list');
    store.setSelectedListingId('seller:boots_01');
    store.setEntityPending('seller:boots_01', true);

    store.resetFilters();

    expect(useCommerceStore.getState()).toMatchObject({
      query: '',
      categoryId: null,
      layout: 'list',
      selectedListingId: 'seller:boots_01',
      pendingEntityIds: ['seller:boots_01'],
    });
  });

  it('resets every account-scoped UI value on sign-out', () => {
    const store = useCommerceStore.getState();
    store.setQuery('private search');
    store.setSelectedListingId('seller:boots_01');
    store.setEntityPending('seller:boots_01', true);

    store.reset();

    expect(useCommerceStore.getState()).toMatchObject(commerceInitialState);
  });

  it('tracks the receipts publication status and clears it on sign-out', () => {
    const store = useCommerceStore.getState();

    store.setReceiptsPublicationStatus('needs_reauth');
    expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('needs_reauth');

    store.setReceiptsPublicationStatus('published');
    expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('published');

    store.reset();
    expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('idle');
  });
});
