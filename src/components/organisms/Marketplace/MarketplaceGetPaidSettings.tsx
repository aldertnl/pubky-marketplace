'use client';

import { useEffect, useState } from 'react';
import {
  Bitcoin,
  CheckCircle2,
  ChevronDown,
  Copy,
  CreditCard,
  ExternalLink,
  HandCoins,
  Loader2,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/atoms/Collapsible/Collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { getLocksUrl } from '@/config/commerce';
import { useMarketplaceSellerPaymentConfig } from '@/hooks/useMarketplaceSellerPaymentConfig/useMarketplaceSellerPaymentConfig';
import { Logger } from '@/libs/logger/logger';
import { copyToClipboard } from '@/libs/utils/utils';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { toast } from '@/molecules/Toaster/use-toast';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  atLeastOneMethodSentence,
  countReadyPaymentMethods,
  deriveBitcoinStatus,
  derivePaypalStatus,
  deriveStripeStatus,
  PAYMENT_METHOD_STATUS_LABELS,
  type PaymentMethodStatus,
} from './MarketplaceGetPaidSettings.utils';

type LocksConnectView = {
  connectedCreator: string | null;
  isExchanging: boolean;
  error: string | null;
  openConnect: () => void;
};

type MarketplaceGetPaidSettingsProps = {
  /** Step 1 of the bitcoin method, owned by the template (no session needed). */
  locksConnect: LocksConnectView;
  /** Step 2 of the bitcoin method: opens the Bitkit setup window. */
  onOpenPaykit: () => void;
};

function StatusPill({ status, testId }: { status: PaymentMethodStatus; testId: string }) {
  const variant =
    status === 'connected' ? 'secondary' : status === 'needs_attention' ? 'destructive' : 'outline';
  return (
    <Badge variant={variant} role="status" data-testid={testId} className="mt-1">
      {PAYMENT_METHOD_STATUS_LABELS[status]}
    </Badge>
  );
}

function MethodCard({
  icon: Icon,
  title,
  promise,
  status,
  statusTestId,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  promise: string;
  status: PaymentMethodStatus;
  statusTestId: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border">
      <CardContent className="grid gap-4 px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <Icon className="mt-1 size-5 text-brand" />
            <div>
              <Typography as="h2" className="font-semibold">
                {title}
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                {promise}
              </Typography>
            </div>
          </div>
          <StatusPill status={status} testId={statusTestId} />
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The seller's "How you get paid" methods, in buyer-familiar order: PayPal,
 * card via Stripe, then bitcoin. Every rail is seller-direct — bitcoin
 * settles to the seller's own claimed watch-only account, Stripe/PayPal
 * settle into the seller's own processor accounts. This marketplace never
 * receives funds on any rail.
 */
export function MarketplaceGetPaidSettings({ locksConnect, onOpenPaykit }: MarketplaceGetPaidSettingsProps) {
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const payments = useMarketplaceSellerPaymentConfig();

  const [bitcoinEnabled, setBitcoinEnabled] = useState(false);
  const [stripePaymentLink, setStripePaymentLink] = useState('');
  const [stripeRestrictedKey, setStripeRestrictedKey] = useState('');
  const [paypalMerchantEmail, setPaypalMerchantEmail] = useState('');
  const [xpubInput, setXpubInput] = useState('');
  const [claimDialogOpen, setClaimDialogOpen] = useState(false);

  useEffect(() => {
    if (!payments.config) return;
    setBitcoinEnabled(payments.config.bitcoinEnabled);
    setStripePaymentLink(payments.config.stripePaymentLink ?? '');
    setPaypalMerchantEmail(payments.config.paypalMerchantEmail ?? '');
  }, [payments.config]);

  useEffect(() => {
    if (payments.claimStatus === 'claimed') setClaimDialogOpen(false);
  }, [payments.claimStatus]);

  const onSave = async () => {
    const saved = await payments.save({ bitcoinEnabled, stripePaymentLink, stripeRestrictedKey, paypalMerchantEmail });
    if (saved) setStripeRestrictedKey('');
  };

  const onStartClaim = () => {
    setClaimDialogOpen(true);
    payments.startClaim(xpubInput);
  };

  const onCloseClaimDialog = (open: boolean) => {
    setClaimDialogOpen(open);
    if (!open) payments.cancelClaim();
  };

  const copyClaimUrl = async () => {
    try {
      await copyToClipboard({ text: payments.claimAuthorizationUrl });
      toast({ variant: 'info', title: 'Authorization link copied' });
    } catch (error) {
      Logger.error('Failed to copy the claim authorization link', { error });
      toast({ variant: 'error', description: 'Could not copy to clipboard' });
    }
  };

  const saveButton = (
    <Button className="w-fit rounded-full" disabled={payments.isSaving} onClick={() => void onSave()}>
      {payments.isSaving ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
      Save payment settings
    </Button>
  );

  const paypalStatus = derivePaypalStatus(payments.config);
  const stripeStatus = deriveStripeStatus(payments.config);
  const bitcoinStatus = deriveBitcoinStatus({
    connectedCreator: locksConnect.connectedCreator,
    accountClaimed: payments.accountClaimed,
    locksError: locksConnect.error,
    claimError: payments.claimError,
  });
  const readyCount = countReadyPaymentMethods([paypalStatus, stripeStatus, bitcoinStatus]);
  const step1NeedsPrimary = !locksConnect.connectedCreator && bitcoinStatus === 'needs_attention';

  // Stored rails need the marketplace session and the loaded config; the
  // bitcoin connect steps above them do not, so they render unconditionally.
  const renderStoredRailBody = (children: React.ReactNode) => {
    if (!marketplaceSession) {
      return (
        <div className="grid justify-items-start gap-3 rounded-xl border p-4">
          <Typography as="p" className="text-sm text-muted-foreground">
            Saving payment settings requires a marketplace session.
          </Typography>
          <MarketplaceSessionConnectDialog />
        </div>
      );
    }
    if (payments.isLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading payment settings…
        </div>
      );
    }
    if (payments.loadError) {
      return (
        <Typography as="p" role="alert" className="text-sm text-amber-300">
          {payments.loadError}
        </Typography>
      );
    }
    return children;
  };

  return (
    <section aria-label="Payment methods" className="flex flex-col gap-6">
      <Typography as="p" className="text-muted-foreground" data-testid="payment-methods-ready-summary">
        {atLeastOneMethodSentence(readyCount)}
      </Typography>
      <MethodCard
        icon={HandCoins}
        title="PayPal"
        promise="Buyers pay straight to your PayPal account — all you need is the email you use there."
        status={paypalStatus}
        statusTestId="payment-method-status-paypal"
      >
        {renderStoredRailBody(
          <>
            <div className="grid gap-3 rounded-xl border p-4">
              <div>
                <Label htmlFor="get-paid-paypal" className="font-medium">
                  PayPal email
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Buyers pay this PayPal email directly; payments are confirmed by PayPal, not by this marketplace.
                </Typography>
              </div>
              <Input
                id="get-paid-paypal"
                type="email"
                value={paypalMerchantEmail}
                onChange={(event) => setPaypalMerchantEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="off"
                className="h-10 max-w-md"
                aria-label="PayPal merchant email"
              />
            </div>
            {saveButton}
          </>,
        )}
      </MethodCard>

      <MethodCard
        icon={CreditCard}
        title="Card via Stripe"
        promise="Take card payments through your own Stripe payment link — payouts land in your Stripe account."
        status={stripeStatus}
        statusTestId="payment-method-status-stripe"
      >
        {renderStoredRailBody(
          <>
            <div className="grid gap-3 rounded-xl border p-4">
              <div>
                <Label htmlFor="get-paid-stripe-link" className="font-medium">
                  Stripe
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Buyers pay through your own Stripe payment link. The restricted key (rk_…, read-only) lets the
                  marketplace verify a payment against your Stripe account — it is stored server-side, never shown
                  again, and cannot move money.
                </Typography>
              </div>
              <Input
                id="get-paid-stripe-link"
                value={stripePaymentLink}
                onChange={(event) => setStripePaymentLink(event.target.value)}
                placeholder="https://buy.stripe.com/…"
                autoComplete="off"
                className="h-10 max-w-md"
                aria-label="Stripe payment link"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="password"
                  value={stripeRestrictedKey}
                  onChange={(event) => setStripeRestrictedKey(event.target.value)}
                  placeholder={payments.config?.stripeRestrictedKeySet ? 'Key stored — paste to replace' : 'rk_…'}
                  autoComplete="off"
                  className="h-10 max-w-md"
                  aria-label="Stripe restricted key"
                />
                {payments.config?.stripeRestrictedKeySet && (
                  <>
                    <Badge variant="secondary">Key stored</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      disabled={payments.isSaving}
                      onClick={() => void payments.clearStripeKey()}
                    >
                      <Trash2 className="mr-2 size-4" />
                      Remove key
                    </Button>
                  </>
                )}
              </div>
            </div>
            {saveButton}
          </>,
        )}
      </MethodCard>

      <MethodCard
        icon={Bitcoin}
        title="Bitcoin wallet"
        promise="Get paid in bitcoin, straight to your own wallet — set it up in two steps."
        status={bitcoinStatus}
        statusTestId="payment-method-status-bitcoin"
      >
        <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              <span className="text-brand">Step 1</span> Connect your Lock Server
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Approve the connection in Pubky Ring. The Lock Server can then lock your content for buyers — it never
              sees your identity secret.
            </Typography>
            {locksConnect.connectedCreator && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Creator authority connected: {locksConnect.connectedCreator.slice(0, 12)}…
              </Typography>
            )}
            {locksConnect.error && (
              <Typography as="p" role="alert" className="mt-2 text-sm text-amber-300">
                {locksConnect.error}
              </Typography>
            )}
          </div>
          {locksConnect.connectedCreator ? (
            <Badge variant="secondary" className="justify-self-start sm:justify-self-auto">
              Connected
            </Badge>
          ) : (
            <Button
              variant={step1NeedsPrimary ? 'default' : 'secondary'}
              className="rounded-full"
              disabled={locksConnect.isExchanging}
              onClick={locksConnect.openConnect}
            >
              {locksConnect.isExchanging ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              Open Locks connect
              <ExternalLink className="ml-2 size-4" />
            </Button>
          )}
        </div>

        <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              <span className="text-brand">Step 2</span> Approve Paykit in Bitkit
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Open the setup in Bitkit and approve it there. Payments settle to your own bitcoin wallet — your spending
              keys never leave it.
            </Typography>
            {payments.accountClaimed === true && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Watch-only account claimed — payment requests derive fresh addresses from it.
              </Typography>
            )}
          </div>
          <Button variant={step1NeedsPrimary ? 'secondary' : 'default'} className="rounded-full" onClick={onOpenPaykit}>
            Open Bitkit setup
            <ExternalLink className="ml-2 size-4" />
          </Button>
        </div>

        {renderStoredRailBody(
          <>
            <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
              <div>
                <Label htmlFor="get-paid-bitcoin" className="font-medium">
                  Accept bitcoin
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Buyers see bitcoin as a payment option on your orders.
                </Typography>
              </div>
              <Switch
                id="get-paid-bitcoin"
                checked={bitcoinEnabled}
                onCheckedChange={setBitcoinEnabled}
                aria-label="Accept bitcoin"
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="group flex w-fit items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                Technical details
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-3 rounded-xl border p-4 text-sm text-muted-foreground data-[state=closed]:hidden">
                <Typography as="p" className="text-sm text-muted-foreground">
                  Pubky Ring displays the exact creator capability grant. No identity secret enters Pubky App.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Bitkit sends a watch-only BIP84 account claim directly to Paykit Server. Spending keys remain in the
                  wallet. Completion is confirmed inside the setup window — this app has no API to verify Paykit setup
                  state and does not pretend to.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Payment requests are delivered privately via Paykit and settle to your claimed watch-only account.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Lock Server: {getLocksUrl()}
                </Typography>
                {payments.accountClaimed !== true && (
                  <div className="grid gap-2">
                    <Typography as="p" className="text-sm text-muted-foreground">
                      {payments.accountClaimed === null
                        ? 'The Paykit server could not report your account state right now; claiming again is safe.'
                        : 'No watch-only account is claimed yet. Connect through Bitkit above, or paste your BIP84 account xpub — the same registration, without the wallet app. The xpub is watch-only: it can derive receiving addresses, never spend.'}
                    </Typography>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={xpubInput}
                        onChange={(event) => setXpubInput(event.target.value)}
                        placeholder="Account xpub (zpub/vpub/xpub/tpub…)"
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 max-w-md font-mono text-xs"
                        aria-label="Account xpub"
                      />
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        disabled={!xpubInput.trim()}
                        onClick={onStartClaim}
                      >
                        Claim with signer
                      </Button>
                    </div>
                    {payments.claimStatus === 'error' && payments.claimError && (
                      <Typography as="p" role="alert" className="text-sm text-amber-300">
                        {payments.claimError}
                      </Typography>
                    )}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>

            {saveButton}
          </>,
        )}
      </MethodCard>

      <Dialog open={claimDialogOpen} onOpenChange={onCloseClaimDialog}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Claim watch-only account</DialogTitle>
          </DialogHeader>
          <Typography as="p" className="text-sm text-muted-foreground">
            Approving on your signer registers the pasted account xpub with the Paykit server — exactly what
            Bitkit&rsquo;s setup does. The approval is scoped to the Paykit receiver path and grants nothing else.
          </Typography>
          {payments.claimStatus === 'error' ? (
            <div className="grid gap-3">
              <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
                {payments.claimError}
              </div>
              <Button className="w-fit rounded-full" onClick={onStartClaim}>
                <RefreshCw className="mr-2 size-4" />
                Try again
              </Button>
            </div>
          ) : (
            <div className="grid justify-items-center gap-4">
              <button
                type="button"
                className="group relative flex size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2"
                onClick={() => void copyClaimUrl()}
                disabled={!payments.claimAuthorizationUrl}
                aria-label="Copy authorization link"
              >
                <QrCodeSlot
                  isLoading={payments.claimStatus !== 'awaiting'}
                  isExpired={false}
                  url={payments.claimAuthorizationUrl}
                  generatingLabel="Generating QR Code..."
                  clickToReloadLabel="Click to reload"
                  activeQrHasHoverEffect
                />
              </button>
              {payments.claimStatus === 'awaiting' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                  <Loader2 className="size-4 animate-spin" />
                  Waiting for approval on your signer…
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="secondary"
                  className="rounded-full"
                  onClick={() => {
                    window.location.href = payments.claimAuthorizationUrl;
                  }}
                  disabled={!payments.claimAuthorizationUrl}
                >
                  <Smartphone className="mr-2 size-4" />
                  Open in Pubky Ring
                </Button>
                <Button
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => void copyClaimUrl()}
                  disabled={!payments.claimAuthorizationUrl}
                >
                  <Copy className="mr-2 size-4" />
                  Copy link
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => onCloseClaimDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
