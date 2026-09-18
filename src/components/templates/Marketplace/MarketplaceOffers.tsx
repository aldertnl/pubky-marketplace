'use client';

import { useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Heading } from '@/atoms/Heading/Heading';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceOffers } from '@/hooks/useMarketplaceOffers/useMarketplaceOffers';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { amountInputUnitLabel, isBitcoinAsset } from '@/libs/commerce/pricing';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';

export function MarketplaceOffers() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const offers = useMarketplaceOffers();
  const [countering, setCountering] = useState<MarketplaceOffer | null>(null);

  const submitCounter = async () => {
    if (!countering || !(await offers.counter(countering))) return;
    setCountering(null);
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
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Offers
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            Private, expiring terms with immutable counteroffer history.
          </Typography>
        </div>

        {offers.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : offers.needsSession && offers.error ? (
          <MarketplaceSessionRequiredCard />
        ) : offers.error ? (
          <div role="alert" className="rounded-xl border border-destructive/40 p-4">
            {offers.error}
          </div>
        ) : offers.offers.length ? (
          <div className="grid gap-4">
            {offers.offers.map((offer) => {
              const actionable = offer.state === 'pending' || offer.state === 'countered';
              const incoming = offer.offeredBy !== currentUserPubky;
              return (
                <Card key={offer.id} className="border py-5">
                  <CardContent className="grid gap-4 px-5 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge>{incoming ? 'Incoming' : 'Sent'}</Badge>
                        <Badge variant="secondary">{offer.state}</Badge>
                      </div>
                      <Typography as="p" className="text-2xl font-bold text-brand">
                        {formatCommerceMoney(offer.amount)}
                      </Typography>
                      <Typography as="p" className="text-sm text-muted-foreground">
                        Quantity {offer.quantity} · Expires {new Date(offer.expiresAt).toLocaleString('en-US')}
                      </Typography>
                      {offer.message && (
                        <Typography as="p" className="mt-2 text-sm">
                          “{offer.message}”
                        </Typography>
                      )}
                    </div>
                    {actionable && (
                      <div className="flex flex-wrap gap-2">
                        {incoming ? (
                          <>
                            <Button
                              size="sm"
                              className="rounded-full"
                              onClick={() => void offers.act(offer, 'offer.accept')}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="rounded-full"
                              onClick={() => setCountering(offer)}
                            >
                              Counter
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="rounded-full"
                              onClick={() => void offers.act(offer, 'offer.reject')}
                            >
                              Decline
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="rounded-full"
                            onClick={() => void offers.act(offer, 'offer.withdraw')}
                          >
                            Withdraw
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <HandCoins className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No offers yet
            </Heading>
          </div>
        )}
      </Container>

      <Dialog open={Boolean(countering)} onOpenChange={(open) => !open && setCountering(null)}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Send a counteroffer</DialogTitle>
          </DialogHeader>
          <ControlledInputField
            name="amount"
            control={offers.form.control}
            label={`Counter amount (${countering ? amountInputUnitLabel(countering.amount) : 'USD'})`}
            placeholder={countering && isBitcoinAsset(countering.amount) ? '110000' : '110.00'}
          />
          <ControlledInputField name="quantity" control={offers.form.control} label="Quantity" placeholder="1" />
          <ControlledTextareaField
            name="message"
            control={offers.form.control}
            label="Message"
            placeholder="Explain your terms"
          />
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => setCountering(null)}>
              Cancel
            </Button>
            <Button className="rounded-full" onClick={submitCounter}>
              Send counter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContentLayout>
  );
}
