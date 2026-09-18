'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell,
  FileText,
  Flame,
  Home,
  Library,
  MessageCircle,
  Search,
  Settings,
  Store,
  UserRound,
  UserRoundPlus,
} from 'lucide-react';
import { APP_ROUTES, isNavItemActive, PROFILE_ROUTES, SETTINGS_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/atoms/DropdownMenu/DropdownMenu';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode } from '@/config/commerce';
import { FileController } from '@/controllers/file/file';
import { useCollectionsNavDiscovery } from '@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile/useCurrentUserProfile';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset/useKeyboardOffset';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { usePublicRoute } from '@/hooks/usePublicRoute/usePublicRoute';
import { handleFeedNavClick } from '@/libs/utils/feedScrollTop';
import { cn } from '@/libs/utils/utils';
import { AvatarWithFallback } from '@/organisms/AvatarWithFallback/AvatarWithFallback';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useLocalFilesStore } from '@/stores/localFiles/localFiles.store';
import { useNotificationStore } from '@/stores/notification/notification.store';

export interface MobileFooterProps {
  className?: string;
}

/**
 * MobileFooter - Bottom navigation for mobile devices
 *
 * Hidden for unauthenticated users on public routes (single post, profile)
 * following pubky-app pattern.
 */
export function MobileFooter({ className }: MobileFooterProps) {
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((state) => Boolean(state.currentUserPubky));
  const setShowSignInDialog = useAuthStore((state) => state.setShowSignInDialog);
  const { isPublicExploreRoute } = usePublicRoute();
  const { userDetails, currentUserPubky } = useCurrentUserProfile();
  // Social unread plus marketplace unread — one badge for the whole surface.
  const unreadNotifications = useNotificationStore((state) => state.selectTotalUnread());
  // Honest device-local unread: conversations whose last received message
  // postdates the local read checkpoint.
  const unreadMessages = useMessagesUnread();
  const accountUnread = unreadNotifications + unreadMessages;
  const localAvatarUrl = useLocalFilesStore((state) => state.profile);
  const { isKeyboardVisible, keyboardOffset } = useKeyboardOffset();
  const { markCollectionsNavSeen } = useCollectionsNavDiscovery();

  // Get avatar URL and fallback initial - same logic as desktop header
  const avatarUrl =
    localAvatarUrl ??
    (currentUserPubky && userDetails?.image
      ? FileController.getAvatarUrl(currentUserPubky, userDetails.indexed_at)
      : undefined);
  const avatarName = userDetails?.name || 'U';
  const authenticatedNavItems = [
    {
      href: APP_ROUTES.HOME,
      icon: Home,
      label: 'Home',
      isFeedRoute: true,
    },
    {
      href: APP_ROUTES.SEARCH,
      icon: Search,
      label: 'Search',
      isFeedRoute: true,
    },
    {
      href: APP_ROUTES.HOT,
      icon: Flame,
      label: 'Hot',
    },
    // Marketplace stays out of primary navigation until the commerce adapter is
    // explicitly configured; production defaults to 'unavailable' (ADR 0019).
    ...(getCommerceAdapterMode() !== 'unavailable'
      ? [
          {
            href: APP_ROUTES.MARKETPLACE,
            activePrefix: APP_ROUTES.MARKETPLACE,
            icon: Store,
            label: 'Marketplace',
          },
        ]
      : []),
    {
      href: APP_ROUTES.COLLECTIONS,
      activePrefix: APP_ROUTES.COLLECTIONS,
      icon: Library,
      label: 'Collections',
    },
  ];
  const protectedNavHrefs = new Set<string>([SETTINGS_ROUTES.ACCOUNT, APP_ROUTES.MESSAGES]);
  // Hide footer for guests only on non-explore routes. Core explore and dynamic public
  // routes (/home, /post/..., /profile/...) use the public explore footer.
  if (!isAuthenticated && !isPublicExploreRoute) {
    return null;
  }

  return (
    <Container
      overrideDefaults
      className={cn(
        'fixed bottom-0 z-40 w-full overflow-x-auto bg-gradient-to-t from-background via-background/95 to-transparent px-3 py-4 transition-transform duration-75 lg:hidden',
        className,
      )}
      style={
        isKeyboardVisible && keyboardOffset > 0
          ? {
              transform: `translateY(-${keyboardOffset}px)`,
            }
          : undefined
      }
    >
      <Container
        overrideDefaults
        className="mx-auto flex max-w-[380px] items-center justify-between sm:max-w-[600px] md:max-w-[720px]"
      >
        {authenticatedNavItems.map((item) => {
          const Icon = item.icon;
          const itemIsActive = isNavItemActive(pathname, item);
          const isCollectionsItem = item.href === APP_ROUTES.COLLECTIONS;
          const itemBadgeCount = item.href === APP_ROUTES.MESSAGES ? unreadMessages : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={itemBadgeCount > 0 ? `${item.label}, ${itemBadgeCount} unread` : item.label}
              onClick={(event) => {
                if (!isAuthenticated && protectedNavHrefs.has(item.href)) {
                  event.preventDefault();
                  setShowSignInDialog(true);
                  return;
                }
                if (isAuthenticated && isCollectionsItem) {
                  markCollectionsNavSeen();
                }
                if (!item.isFeedRoute) return;
                handleFeedNavClick(event, { isActive: itemIsActive, smoothScrollWhenActive: true });
              }}
              className={cn(
                'rounded-full p-3 transition-all',
                itemBadgeCount > 0 && 'relative inline-flex',
                itemIsActive ? 'bg-secondary' : 'border border-border bg-white/5 backdrop-blur-sm hover:bg-white/10',
              )}
            >
              <Icon className="h-6 w-6" />
              {itemBadgeCount > 0 && (
                <Badge
                  data-cy="mobile-messages-counter"
                  className="absolute -right-1 -bottom-1 h-5 w-5 rounded-full bg-brand shadow-sm"
                  variant="secondary"
                >
                  <Typography
                    className={cn('font-semibold text-primary-foreground', itemBadgeCount > 21 && 'text-xs')}
                    size="xs"
                  >
                    {itemBadgeCount > 21 ? '21+' : itemBadgeCount}
                  </Typography>
                </Badge>
              )}
            </Link>
          );
        })}
        {isAuthenticated ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                data-cy="footer-nav-profile-btn"
                variant="ghost"
                size="icon"
                aria-label="Account menu"
                className="relative size-12 shrink-0 rounded-full"
              >
                <AvatarWithFallback
                  avatarUrl={avatarUrl}
                  name={avatarName}
                  fallbackSeed={currentUserPubky || avatarName}
                  size="lg"
                  className="cursor-pointer"
                  alt={'Profile'}
                />
                {accountUnread > 0 && (
                  <Badge
                    data-testid="mobile-notification-counter"
                    data-cy="mobile-notification-counter"
                    className="absolute right-0 bottom-0 h-5 w-5 rounded-full bg-brand shadow-sm"
                    variant="secondary"
                  >
                    <Typography
                      className={cn('font-semibold text-primary-foreground', accountUnread > 21 && 'text-xs')}
                      size="xs"
                    >
                      {accountUnread > 21 ? '21+' : accountUnread}
                    </Typography>
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" sideOffset={12} className="w-72 p-2">
              <DropdownMenuItem asChild>
                <Link href={APP_ROUTES.MESSAGES} className="gap-4 px-4 py-3 text-lg">
                  <MessageCircle className="size-6" />
                  <span className="flex-1">Messages</span>
                  {unreadMessages > 0 && (
                    <span className="text-brand">{unreadMessages > 21 ? '21+' : unreadMessages}</span>
                  )}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={SETTINGS_ROUTES.ACCOUNT} className="gap-4 px-4 py-3 text-lg">
                  <Settings className="size-6" />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={PROFILE_ROUTES.PROFILE} className="gap-4 px-4 py-3 text-lg">
                  <Bell className="size-6" />
                  <span className="flex-1">Notifications</span>
                  {unreadNotifications > 0 && (
                    <span className="text-brand">{unreadNotifications > 21 ? '21+' : unreadNotifications}</span>
                  )}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={PROFILE_ROUTES.PROFILE_PAGE} className="gap-4 px-4 py-3 text-lg">
                  <UserRound className="size-6" />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={PROFILE_ROUTES.POSTS} className="gap-4 px-4 py-3 text-lg">
                  <FileText className="size-6" />
                  My posts
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="secondary"
            size="icon"
            className="size-12 items-center justify-center border bg-white/5"
            aria-label="Join Pubky"
            onClick={() => setShowSignInDialog(true)}
          >
            <UserRoundPlus className="size-6" />
          </Button>
        )}
      </Container>
    </Container>
  );
}
