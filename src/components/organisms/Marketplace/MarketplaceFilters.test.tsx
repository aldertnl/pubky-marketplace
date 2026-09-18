import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { collectMarketplaceCountryFacets, MarketplaceFilters } from './MarketplaceFilters';

describe('MarketplaceFilters', () => {
  beforeEach(() => {
    useCommerceStore.getState().reset();
  });

  it('changes sale format and layout through the dropdowns', async () => {
    const user = userEvent.setup();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    render(<MarketplaceFilters resultCount={8} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sale format' }), { key: 'ArrowDown' });
    await user.click(await screen.findByRole('option', { name: 'Drops' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Listing layout: Grid' }), { key: 'ArrowDown' });
    await user.click(await screen.findByRole('option', { name: 'List' }));
    expect(useCommerceStore.getState()).toMatchObject({ saleFormat: 'drops', layout: 'list' });
  });

  it('renders supplied search and sell controls', () => {
    render(
      <MarketplaceFilters
        resultCount={8}
        searchControl={<input aria-label="Filter marketplace" />}
        sellControl={<button>Sell an item</button>}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Filter marketplace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sell an item' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Display currency/ })).toBeInTheDocument();
  });

  it('clears active discovery filters without changing layout', async () => {
    const user = userEvent.setup();
    useCommerceStore.getState().setLayout('list');
    useCommerceStore.getState().setQuery('camera');
    useCommerceStore.getState().setCategoryId('fashion');
    useCommerceStore.getState().setAttributeFilter('size', 'L');
    render(<MarketplaceFilters resultCount={1} />);

    await user.click(screen.getByRole('button', { name: 'Reset search and filters' }));

    expect(useCommerceStore.getState()).toMatchObject({
      query: '',
      categoryId: null,
      attributeFilters: {},
      saleFormat: 'all',
      layout: 'list',
    });
  });

  it('clears the category from the category menu', async () => {
    const user = userEvent.setup();
    useCommerceStore.getState().setCategoryId('fashion-men-footwear');
    render(<MarketplaceFilters resultCount={8} />);
    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.click(await screen.findByRole('menuitem', { name: 'All Categories' }));
    expect(useCommerceStore.getState().categoryId).toBeNull();
  });

  it('clears attribute filters when the category changes', () => {
    useCommerceStore.getState().setCategoryId('fashion');
    useCommerceStore.getState().setAttributeFilter('size', 'L');
    expect(useCommerceStore.getState().attributeFilters).toEqual({ size: 'L' });

    useCommerceStore.getState().setCategoryId('electronics');
    expect(useCommerceStore.getState().attributeFilters).toEqual({});
  });

  it('keeps alternative countries in the unfiltered facet set', () => {
    const item = (countryCode: string) => ({
      id: `seller:${countryCode}`,
      sellerId: 'seller',
      listingId: countryCode,
      state: 'active' as const,
      title: countryCode,
      description: '',
      categoryId: 'fashion',
      condition: 'good' as const,
      tags: [],
      saleFormat: 'fixed_price' as const,
      price: { amountMinor: 100, currency: 'USD', exponent: 2 },
      auction: null,
      attributes: null,
      location: { countryCode, region: null },
      mediaUrls: [],
      reputation: null,
      revision: 1,
      updatedAt: 1,
    });
    expect(collectMarketplaceCountryFacets([item('BE'), item('FR'), item('PT')])).toEqual([
      ['BE', 1],
      ['FR', 1],
      ['PT', 1],
    ]);
  });

  it('renders alternative countries when one country is selected', async () => {
    const item = (countryCode: string) => ({
      id: `seller:${countryCode}`,
      sellerId: 'seller',
      listingId: countryCode,
      state: 'active' as const,
      title: countryCode,
      description: '',
      categoryId: 'fashion',
      condition: 'good' as const,
      tags: [],
      saleFormat: 'fixed_price' as const,
      price: { amountMinor: 100, currency: 'USD', exponent: 2 },
      auction: null,
      attributes: null,
      location: { countryCode, region: null },
      mediaUrls: [],
      reputation: null,
      revision: 1,
      updatedAt: 1,
    });

    useCommerceStore.getState().setCountryCode('BE');
    render(
      <MarketplaceFilters
        resultCount={1}
        facetPool={[item('BE')]}
        countryFacetPool={[item('BE'), item('FR'), item('PT')]}
      />,
    );
    const locationSelect = screen.getByRole('combobox', { name: 'Item location' });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fireEvent.keyDown(locationSelect, { key: 'ArrowDown' });

    await waitFor(() => expect(screen.getByRole('option', { name: 'France' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Portugal' })).toBeInTheDocument();
  });

  it('hides detailed attribute facets from the preview filters', () => {
    useCommerceStore.getState().setCategoryId('fashion');
    const facetItem = {
      id: 'seller:varsity_fleece',
      sellerId: 'seller',
      listingId: 'varsity_fleece',
      state: 'active' as const,
      title: 'Heavyweight varsity fleece',
      description: 'Boxy 90s collegiate fleece.',
      categoryId: 'fashion-men-tops-hoodies',
      condition: 'good' as const,
      tags: [],
      saleFormat: 'fixed_price' as const,
      price: { amountMinor: 7_200, currency: 'USD', exponent: 2 },
      auction: null,
      attributes: { size: 'L', brand: 'Champion', color: ['grey', 'navy'] },
      location: { countryCode: 'US', region: null },
      mediaUrls: [],
      reputation: null,
      revision: 1,
      updatedAt: 1_000,
    };
    render(<MarketplaceFilters resultCount={1} facetPool={[facetItem]} />);

    expect(screen.queryByText('Size')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'L · 1' })).not.toBeInTheDocument();
  });
});

describe('MarketplaceFilters - Snapshots', () => {
  it('matches the default filter snapshot', () => {
    const { container } = render(<MarketplaceFilters resultCount={8} />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
