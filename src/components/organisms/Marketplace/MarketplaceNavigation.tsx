'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Bell, HandCoins, Heart, LayoutDashboard, MessageCircle, ReceiptText, ShoppingCart, Store } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Link } from '@/atoms/Link/Link';
import { useMarketplaceActivityUnread } from '@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread';
import { useMarketplaceCartCount } from '@/hooks/useMarketplaceCartCount/useMarketplaceCartCount';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { cn } from '@/libs/utils/utils';

export function MarketplaceNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, requireAuth } = useRequireAuth();
  const cartCount = useMarketplaceCartCount();
  const activityCount = useMarketplaceActivityUnread();
  const tabs = [
    { name: 'Marketplace', href: '/marketplace', icon: Store },
    { name: 'Messages', href: MARKETPLACE_ROUTES.MESSAGES, icon: MessageCircle },
    { name: 'Offers', href: MARKETPLACE_ROUTES.OFFERS, icon: HandCoins },
    { name: 'Watchlist', href: MARKETPLACE_ROUTES.WATCHLIST, icon: Heart },
    { name: 'Cart', href: MARKETPLACE_ROUTES.CART, icon: ShoppingCart, count: cartCount },
    { name: 'Orders', href: MARKETPLACE_ROUTES.ORDERS, icon: ReceiptText },
    { name: 'Activity', href: MARKETPLACE_ROUTES.NOTIFICATIONS, icon: Bell, count: activityCount },
    { name: 'Seller studio', href: MARKETPLACE_ROUTES.DASHBOARD, icon: LayoutDashboard },
  ];
  return (
    <nav aria-label="Marketplace sections" className="mb-6 flex w-full overflow-x-auto">
      {tabs.map(({ name, href, icon: Icon, count }) => {
        const active = pathname === href;
        return (
          <Link
            overrideDefaults
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => {
              if (href !== '/marketplace' && !isAuthenticated) {
                event.preventDefault();
                requireAuth(() => router.push(href));
              }
            }}
            className={cn(
              'flex min-h-12 flex-1 shrink-0 items-center justify-center gap-2 border-b px-4 text-sm font-medium whitespace-nowrap transition-colors hover:text-white',
              active ? 'border-white text-white' : 'border-border text-muted-foreground',
            )}
          >
            <Icon className="size-5 shrink-0" />
            {name}
            {!!count && <span className="text-xs text-brand">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
