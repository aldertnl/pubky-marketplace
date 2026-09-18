import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceInbox as default } from '@/templates/Marketplace/MarketplaceInbox';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Messages | Pubky Marketplace',
    'Encrypted buyer-seller messaging on Pubky Marketplace.',
    MARKETPLACE_ROUTES.MESSAGES,
  );
}
