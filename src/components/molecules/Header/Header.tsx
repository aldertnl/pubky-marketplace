'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Flame, Home, Library, MessageCircle, Settings, Store, UserRoundPlus } from 'lucide-react';
import { APP_ROUTES, isCoreExploreRoute, isNavItemActive, SETTINGS_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode } from '@/config/commerce';
import { getGithubLink, getTelegramLink, getTwitterGetpubkyLink } from '@/config/externalLinks';
import { useCollectionsNavDiscovery } from '@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { Github2, Telegram, XTwitter } from '@/icons';
import { handleFeedNavClick } from '@/libs/utils/feedScrollTop';
import { cn } from '@/libs/utils/utils';
import { AvatarWithFallback } from '@/organisms/AvatarWithFallback/AvatarWithFallback';
import { SearchInput } from '@/organisms/SearchInput/SearchInput';
import { useAuthStore } from '@/stores/auth/auth.store';
import { ProgressSteps } from '../ProgressSteps/ProgressSteps';

export interface HeaderContainerProps {
  children: React.ReactNode;
  className?: string;
  classNameNav?: string;
}
export const HeaderContainer = ({ children, className, classNameNav }: HeaderContainerProps) => {
  return (
    <Container
      overrideDefaults
      as="header"
      className={cn(
        'pointer-events-none sticky top-0 z-(--z-sticky-header) w-full bg-linear-to-b from-(--background) from-50% to-transparent p-0 sm:py-6',
        className,
      )}
    >
      <Container
        as="nav"
        size="container"
        className={cn(
          'pointer-events-auto mx-auto flex h-24 w-full flex-row flex-wrap items-center justify-between gap-4 sm:flex-nowrap sm:gap-6',
          'p-6',
          classNameNav,
        )}
      >
        {children}
      </Container>
    </Container>
  );
};
export const HeaderTitle = ({ currentTitle }: { currentTitle: string }) => {
  return (
    <Container className="hidden flex-1 md:flex">
      <Heading level={2} size="lg" className="font-normal text-muted-foreground">
        {currentTitle}
      </Heading>
    </Container>
  );
};
export const HeaderOnboarding = ({ currentStep }: { currentStep: number }) => {
  return <ProgressSteps currentStep={currentStep} totalSteps={5} />;
};
export function HeaderSocialLinks({ ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Container
      data-testid="header-social-links"
      className={cn('mr-6 hidden flex-row justify-end gap-6 md:flex', props.className)}
    >
      <Link href={getGithubLink()} target="_blank" variant="muted" size="default">
        <Github2 className="h-6 w-6" />
      </Link>
      <Link href={getTwitterGetpubkyLink()} target="_blank" variant="muted" size="default">
        <XTwitter className="h-6 w-6" />
      </Link>
      <Link href={getTelegramLink()} target="_blank" variant="muted" size="default">
        <Telegram className="h-6 w-6" />
      </Link>
    </Container>
  );
}
type NavigationItemConfig = {
  href: string;
  icon: React.ComponentType<{
    className?: string;
  }>;
  label: string;
  dataCy?: string;
  activePrefix?: string;
  isFeedRoute?: boolean;
};
type HeaderNavigationButtonsProps = {
  counter?: number;
  avatarImage?: string;
  avatarName?: string;
  avatarSeed?: string;
  className?: string;
};
// Marketplace stays out of primary navigation until the commerce adapter is
// explicitly configured; production defaults to 'unavailable' (ADR 0019).
const isMarketplaceNavEnabled = () => getCommerceAdapterMode() !== 'unavailable';

const getNavigationItems = (): NavigationItemConfig[] => [
  {
    href: APP_ROUTES.HOME,
    icon: Home,
    label: 'Home',
    dataCy: 'header-home-btn',
    isFeedRoute: true,
  },
  {
    href: APP_ROUTES.HOT,
    icon: Flame,
    label: 'Hot',
    dataCy: 'header-hot-btn',
  },
  ...(isMarketplaceNavEnabled()
    ? [
        {
          href: APP_ROUTES.MARKETPLACE,
          icon: Store,
          label: 'Marketplace',
          dataCy: 'header-marketplace-btn',
          activePrefix: APP_ROUTES.MARKETPLACE,
        },
      ]
    : []),
  {
    href: APP_ROUTES.COLLECTIONS,
    icon: Library,
    label: 'Collections',
    dataCy: 'header-collections-btn',
    activePrefix: APP_ROUTES.COLLECTIONS,
  },
  {
    href: APP_ROUTES.MESSAGES,
    icon: MessageCircle,
    label: 'Messages',
    dataCy: 'header-messages-btn',
    activePrefix: APP_ROUTES.MESSAGES,
  },
  {
    href: SETTINGS_ROUTES.ACCOUNT,
    icon: Settings,
    label: 'Settings',
    dataCy: 'header-settings-btn',
    activePrefix: APP_ROUTES.SETTINGS,
  },
];
type NavigationButtonProps = {
  /** Present → navigates client-side via Link. Omit (and pass onClick) for auth-gated items. */
  href?: string;
  onClick?: () => void;
  icon: React.ComponentType<{
    className?: string;
  }>;
  label: string;
  isActive: boolean;
  dataCy?: string;
  isFeedRoute?: boolean;
  showNew?: boolean;
  newLabel?: string;
  /** Honest device-local count (e.g. unread conversations); 0 hides the badge. */
  badgeCount?: number;
};
const NavigationButton = ({
  href,
  onClick,
  icon: Icon,
  label,
  isActive,
  dataCy,
  isFeedRoute,
  showNew = false,
  newLabel,
  badgeCount = 0,
}: NavigationButtonProps) => {
  const accessibleLabel =
    badgeCount > 0 ? `${label}, ${badgeCount} unread` : showNew && newLabel ? `${label}, ${newLabel}` : label;
  const button = (
    <Button
      data-cy={href ? undefined : dataCy}
      className={cn(
        'h-12 w-12 backdrop-blur-md',
        isActive ? '' : 'border bg-white/5',
        showNew && 'border-brand bg-white/5 text-brand hover:bg-brand/10',
      )}
      variant="secondary"
      size="icon"
      aria-label={accessibleLabel}
      onClick={href ? undefined : onClick}
    >
      <Icon className="size-6" />
    </Button>
  );
  const content = (
    <>
      {button}
      {badgeCount > 0 && (
        <Badge
          data-cy={dataCy ? `${dataCy}-counter` : undefined}
          className="absolute -right-1 -bottom-1 h-5 w-5 rounded-full bg-brand shadow-sm"
          variant="secondary"
        >
          <Typography className={cn('font-semibold text-primary-foreground', badgeCount > 21 && 'text-xs')} size="xs">
            {badgeCount > 21 ? '21+' : badgeCount}
          </Typography>
        </Badge>
      )}
      {showNew && newLabel ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 text-xs font-semibold text-brand uppercase"
        >
          {newLabel}
        </span>
      ) : null}
    </>
  );
  const needsRelativeWrap = showNew || badgeCount > 0;
  return href ? (
    <Link
      href={href}
      data-cy={dataCy}
      className={needsRelativeWrap ? 'relative inline-flex' : undefined}
      onClick={(event) => {
        onClick?.();
        if (!isFeedRoute) return;
        handleFeedNavClick(event, { isActive, smoothScrollWhenActive: true });
      }}
    >
      {content}
    </Link>
  ) : (
    <span className={needsRelativeWrap ? 'relative inline-flex' : undefined}>{content}</span>
  );
};
export function HeaderNavigationButtons({
  counter = 0,
  avatarImage,
  avatarName = 'U',
  avatarSeed,
  className,
}: HeaderNavigationButtonsProps) {
  const pathname = usePathname();
  const { markCollectionsNavSeen } = useCollectionsNavDiscovery();
  // Honest badge: conversations on THIS device whose last received message
  // postdates the local read checkpoint — never a server-claimed count.
  const unreadMessages = useMessagesUnread();
  const counterString = counter > 21 ? '21+' : counter.toString();
  return (
    <Container className={cn('hidden w-auto shrink-0 flex-row items-center justify-start gap-3 lg:flex', className)}>
      {getNavigationItems().map((item) => {
        const isCollectionsItem = item.href === APP_ROUTES.COLLECTIONS;
        const isMessagesItem = item.href === APP_ROUTES.MESSAGES;
        return (
          <NavigationButton
            key={item.href}
            href={item.href}
            onClick={isCollectionsItem ? markCollectionsNavSeen : undefined}
            icon={item.icon}
            label={item.label}
            isActive={isNavItemActive(pathname, item)}
            dataCy={item.dataCy}
            isFeedRoute={item.isFeedRoute}
            badgeCount={isMessagesItem ? unreadMessages : 0}
          />
        );
      })}

      <Link data-cy="header-nav-profile-btn" className="relative" href={APP_ROUTES.PROFILE}>
        <AvatarWithFallback
          avatarUrl={avatarImage}
          name={avatarName}
          fallbackSeed={avatarSeed || avatarName}
          size="lg"
          className="cursor-pointer"
          alt={'Profile'}
        />
        {counter > 0 && (
          <Badge
            data-cy="header-notification-counter"
            className="absolute right-0 bottom-0 h-5 w-5 rounded-full bg-brand shadow-sm"
            variant="secondary"
          >
            <Typography className={cn('font-semibold text-primary-foreground', counter > 21 && 'text-xs')} size="xs">
              {counterString}
            </Typography>
          </Badge>
        )}
      </Link>
    </Container>
  );
}

type HeaderExploreNavigationButtonsProps = {
  className?: string;
  showSearch?: boolean;
};

export function HeaderExploreNavigationButtons({
  className,
  showSearch = true,
}: HeaderExploreNavigationButtonsProps = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { requireAuth } = useRequireAuth();
  const setShowSignInDialog = useAuthStore((state) => state.setShowSignInDialog);

  return (
    <Container className={cn('hidden min-w-0 flex-1 flex-row items-center justify-end gap-3 lg:flex', className)}>
      {showSearch && <SearchInput />}
      {getNavigationItems().map((item) => {
        // Core explore routes navigate freely; Settings requires an account.
        const requiresAuth = !isCoreExploreRoute(item.href);
        return (
          <NavigationButton
            key={item.href}
            href={requiresAuth ? undefined : item.href}
            onClick={requiresAuth ? () => requireAuth(() => router.push(item.href)) : undefined}
            icon={item.icon}
            label={item.label}
            isActive={isNavItemActive(pathname, item)}
            dataCy={item.dataCy}
          />
        );
      })}

      <Button
        variant="secondary"
        size="icon"
        className="h-12 w-12 border bg-white/5"
        onClick={() => setShowSignInDialog(true)}
        aria-label="Join Pubky"
        data-testid="header-explore-join-button"
      >
        <UserRoundPlus className="size-6" />
      </Button>
    </Container>
  );
}
