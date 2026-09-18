'use client';

import { SlidersHorizontal, Store } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceLocksConnect } from '@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceGetPaidSettings } from '@/organisms/Marketplace/MarketplaceGetPaidSettings';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

export function MarketplacePaymentSettings() {
  const locksConnect = useMarketplaceLocksConnect();
  const showFxEstimate = useMarketplaceDisplayStore((state) => state.showFxEstimate);
  const setShowFxEstimate = useMarketplaceDisplayStore((state) => state.setShowFxEstimate);
  const measurementSystem = useMarketplaceDisplayStore((state) => state.measurementSystem);
  const setMeasurementSystem = useMarketplaceDisplayStore((state) => state.setMeasurementSystem);

  const openPaykit = () => {
    const url = CommerceController.getPaykitSetupUrl(window.location.href, crypto.randomUUID().replaceAll('-', ''));
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div>
          <Badge className="mb-4">Pre-production integration</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            How you get paid
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            Every method pays the seller directly — this marketplace never holds funds.
          </Typography>
        </div>

        <MarketplaceGetPaidSettings locksConnect={locksConnect} onOpenPaykit={openPaykit} />

        <Card className="border">
          <CardContent className="flex flex-col gap-3 px-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <Store className="mt-1 size-5 text-brand" />
              <div>
                <Typography as="h2" className="font-semibold">
                  Looking for your shop name and policies?
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Storefront settings live under My shop, next to your listings.
                </Typography>
              </div>
            </div>
            <Button asChild variant="secondary" className="shrink-0 rounded-full">
              <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                Open My shop
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="border">
          <CardContent className="grid gap-5 px-6">
            <div className="flex gap-3">
              <SlidersHorizontal className="mt-1 size-5 text-brand" />
              <div>
                <Typography as="h2" className="font-semibold">
                  Display preferences
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  How prices and package details render for you, stored on this device. Neither setting changes any
                  listing record or payment amount.
                </Typography>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="marketplace-fx-estimate" className="font-medium">
                  Approximate price conversions
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Show &ldquo;≈&rdquo; estimates beside prices (fiat ↔ bitcoin) at the current exchange rate. Indicative
                  only — payments always settle in the listing&rsquo;s own pricing asset.
                </Typography>
              </div>
              <Switch
                id="marketplace-fx-estimate"
                checked={showFxEstimate}
                onCheckedChange={setShowFxEstimate}
                aria-label="Show approximate price conversions"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="marketplace-measurement-system" className="font-medium">
                  Measurement system
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Units for package dimensions and weight. Records always store exact millimeters and grams.
                </Typography>
              </div>
              <Select
                value={measurementSystem ?? 'auto'}
                onValueChange={(value) =>
                  setMeasurementSystem(value === 'auto' ? null : (value as 'metric' | 'imperial'))
                }
              >
                <SelectTrigger
                  id="marketplace-measurement-system"
                  className="h-11 w-56 shrink-0 rounded-md border px-3"
                  aria-label="Measurement system"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automatic (from locale)</SelectItem>
                  <SelectItem value="metric">Metric (cm, g)</SelectItem>
                  <SelectItem value="imperial">Imperial (in, oz)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Locks and Paykit Server are pre-production. Do not use this prototype to protect valuable content or real
          funds without an independent security and operational review.
        </div>
      </Container>
    </ContentLayout>
  );
}
