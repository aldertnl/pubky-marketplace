import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { MarketplaceDropsShelfEntry } from './MarketplaceDropsShelfEntry';

function variants() {
  return screen.getAllByTestId('marketplace-drops-shelf-entry');
}

describe('MarketplaceDropsShelfEntry', () => {
  it('renders both compact and desktop variants with breakpoint classes in SSR markup', () => {
    const html = renderToString(<MarketplaceDropsShelfEntry />);

    expect(html).toContain('data-variant="compact"');
    expect(html).toContain('data-variant="desktop"');
    expect(html).toMatch(/data-variant="compact"[^>]*class="[^"]*md:hidden/);
    expect(html).toMatch(/data-variant="desktop"[^>]*class="[^"]*hidden[^"]*md:flex/);
  });

  it('keeps the full desktop entry with the long tagline and Browse drops CTA', () => {
    render(<MarketplaceDropsShelfEntry />);

    const desktop = variants().find((node) => node.getAttribute('data-variant') === 'desktop');
    expect(desktop).toBeDefined();
    expect(desktop).toHaveClass('hidden', 'md:flex');
    expect(desktop).not.toHaveClass('h-14');
    expect(screen.getAllByRole('heading', { name: 'Drops' })).toHaveLength(2);
    expect(screen.getByText(/server-enforced clock/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse drops/ })).toHaveAttribute('href', MARKETPLACE_ROUTES.DROPS);
  });

  it('keeps the compact single row with a one-line tagline and Browse chevron', () => {
    render(<MarketplaceDropsShelfEntry />);

    const compact = variants().find((node) => node.getAttribute('data-variant') === 'compact');
    expect(compact).toBeDefined();
    expect(compact).toHaveClass('h-14', 'max-h-14', 'md:hidden');
    const tagline = screen.getByText('Timed, limited releases');
    expect(tagline).toHaveClass('truncate');
    expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute('href', MARKETPLACE_ROUTES.DROPS);
  });
});
