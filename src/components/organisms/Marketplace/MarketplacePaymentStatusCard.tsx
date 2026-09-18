'use client';

import { useEffect, useState } from 'react';
import {
  Banknote,
  CheckCircle2,
  Clock3,
  CreditCard,
  Download,
  FileWarning,
  KeyRound,
  LoaderCircle,
  WalletCards,
} from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { type CommerceAdapterMode, isDurableCommerceMode, isLocksPaykitCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceLocksPayment } from '@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment';
import { useMarketplaceOrderPayment } from '@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { type BuyerVisiblePaymentStatus, buyerVisiblePaymentStatus } from '@/libs/commerce/locks-payment';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import { getDeployEnv } from '@/libs/runtime-config/runtime-config';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';

/**
 * The buyer-visible payment status vocabulary is deliberately small
 * (implementation plan, "Paykit, Locks, and payment confirmation"): awaiting
 * entitlement, confirmed, marketplace-expired, and manual review. Detection,
 * underpayment/overpayment, and confirmation counts stay internal to
 * Locks/Paykit Server and are never rendered as real facts — only the
 * visibly-labeled sandbox demonstrates the finer-grained simulated states.
 */
const BUYER_VISIBLE_STATUS_LABELS: Record<BuyerVisiblePaymentStatus, string> = {
  awaiting_entitlement: 'Awaiting payment',
  confirmed: 'Payment confirmed',
  expired: 'Payment window expired',
  manual_review: 'Under manual review',
};

function parseListingAggregateId(aggregateId: string): { sellerPubky: string; listingId: string } | null {
  if (!aggregateId.startsWith('listing:')) return null;
  const rest = aggregateId.slice('listing:'.length);
  if (rest.length < 54 || rest[52] !== '_') return null;
  return { sellerPubky: rest.slice(0, 52), listingId: rest.slice(53) };
}

/**
 * Truthful payment status for one order. Renders only the buyer-visible
 * states; never claims settlement detail the upstream contract keeps
 * internal; never advances a payment itself — in `locks-paykit` mode the
 * buyer's only actions are creating the payment request (proof bundle +
 * `payment.register_locks`) and, after server-side confirmation, unlocking
 * the purchased digital content.
 */
export function MarketplacePaymentStatusCard({
  order,
  payment,
  isBuyer,
  adapterMode,
  advancePayment,
  onPaymentChanged,
}: {
  order: MarketplaceOrder;
  payment: MarketplacePayment | null;
  isBuyer: boolean;
  adapterMode: CommerceAdapterMode;
  advancePayment: (
    payment: MarketplacePayment,
    target: 'detected' | 'confirmed' | 'expired' | 'manual_review',
    confirmations: number,
  ) => Promise<boolean>;
  onPaymentChanged: () => void | Promise<void>;
}) {
  const isSandbox = adapterMode === 'sandbox';
  const isStaging = getDeployEnv() === 'staging';
  const isLocksPaykit = isLocksPaykitCommerceMode(adapterMode);
  const [digitalLock, setDigitalLock] = useState<CommerceDigitalLock | null>(null);

  // The digital lock lives on the seller-signed listing record (cached
  // locally when the buyer browsed it; fetched from the seller's homeserver
  // otherwise). Without it there is nothing to pay through Locks.
  useEffect(() => {
    if (!isLocksPaykit) return;
    let active = true;
    const load = async () => {
      for (const line of order.lines) {
        const parsed = parseListingAggregateId(line.listingAggregateId);
        if (!parsed) continue;
        try {
          const record = await CommerceController.getOrFetchListing(parsed.sellerPubky, parsed.listingId);
          if (record.digitalLock) {
            if (active) setDigitalLock(record.digitalLock);
            return;
          }
        } catch {
          // An unreachable listing record just means no Locks flow is offered.
        }
      }
      if (active) setDigitalLock(null);
    };
    void load();
    return () => {
      active = false;
    };
  }, [isLocksPaykit, order.lines]);

  const locks = useMarketplaceLocksPayment({
    order,
    payment,
    digitalLock,
    isBuyer,
    onPaymentChanged,
  });

  const isDurable = isDurableCommerceMode(adapterMode);
  const isTerminal = ['completed', 'cancelled', 'refunded_external', 'closed'].includes(order.state);
  const visibleStatus = payment ? buyerVisiblePaymentStatus(payment.state) : null;
  const isAwaiting = visibleStatus === 'awaiting_entitlement' && !isTerminal;
  // Digital Locks orders keep the Locks/Paykit flow; everything else in the
  // durable modes goes through the seller-configured payment methods.
  const usesMethodFlow = isDurable && isAwaiting && !digitalLock;
  const methodPayment = useMarketplaceOrderPayment({
    order,
    enabled: usesMethodFlow && isBuyer,
    onPaymentChanged,
  });
  const [paypalTransactionRef, setPaypalTransactionRef] = useState('');

  if (!payment || visibleStatus === null) return null;

  const visibleStatusLabel =
    isTerminal && visibleStatus === 'awaiting_entitlement'
      ? order.state === 'cancelled'
        ? 'Order cancelled'
        : 'Not paid'
      : BUYER_VISIBLE_STATUS_LABELS[visibleStatus];

  return (
    <div className="grid gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={visibleStatus === 'confirmed' ? 'default' : 'outline'}>
          {visibleStatusLabel}
        </Badge>
        {payment.adapter === 'locks' && <Badge variant="secondary">Locks/Paykit</Badge>}
        {order.paymentMethod === 'bitcoin' && <Badge variant="secondary">₿ Bitcoin</Badge>}
        {order.paymentMethod === 'stripe' && <Badge variant="secondary">Card (Stripe)</Badge>}
        {order.paymentMethod === 'paypal' && <Badge variant="secondary">PayPal</Badge>}
        {/* How the fiat rail is verified is a fact both parties should see on
            the order forever, not only in the pre-payment copy: Stripe pulls
            truth from the processor; a gateway-notified PayPal payment was
            confirmed by PayPal's own verified notification; seller-attested
            is the seller saying so. */}
        {order.fiatVerification === 'processor' && <Badge variant="secondary">Processor-verified</Badge>}
        {order.fiatVerification === 'gateway-notified' && <Badge variant="secondary">PayPal-verified</Badge>}
        {order.fiatVerification === 'seller-attested' && <Badge variant="outline">Seller-attested</Badge>}
        {isSandbox && <Badge variant="secondary">Sandbox · simulated payment · no real funds</Badge>}
      </div>
      {!isSandbox && isBuyer && isAwaiting && (
        <Typography as="p" role="note" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {isStaging ? 'Staging environment — test rails, no real funds move' : 'Real money. Payments are final and go directly to the seller.'}
        </Typography>
      )}
      {visibleStatus === 'confirmed' && order.fiatVerification === 'gateway-notified' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          This payment was confirmed automatically by a verified notification from PayPal&rsquo;s servers, matched
          against the seller&rsquo;s configured PayPal address and the exact order total.
        </Typography>
      )}
      {visibleStatus === 'confirmed' && order.fiatVerification === 'seller-attested' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          This payment was confirmed by the seller reporting receipt in their own PayPal account — not by automatic
          processor verification. The confirmation is the seller&rsquo;s attestation.
        </Typography>
      )}

      {visibleStatus === 'expired' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          The marketplace payment window elapsed before a verified payment arrived, so this order was not completed. A
          payment verified after expiry is reconciled manually — never silently applied or discarded.
        </Typography>
      )}
      {visibleStatus === 'manual_review' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          A verified event arrived outside the normal flow (for example after the payment window expired), so an
          operator has to reconcile this order manually. No funds are held by this marketplace.
        </Typography>
      )}

      {/* Sandbox-only simulated detail, always under the visible sandbox label. */}
      {isSandbox && isBuyer && payment.state !== 'confirmed' && (
        <div className="flex flex-wrap gap-2">
          {payment.state === 'awaiting_entitlement' && (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => void advancePayment(payment, 'detected', 0)}
            >
              <Clock3 className="mr-2 size-4" />
              Simulate detected
            </Button>
          )}
          {(payment.state === 'awaiting_entitlement' || payment.state === 'detected') && (
            <Button size="sm" className="rounded-full" onClick={() => void advancePayment(payment, 'confirmed', 1)}>
              <CheckCircle2 className="mr-2 size-4" />
              Simulate confirmation
            </Button>
          )}
          {payment.state === 'detected' && (
            <Typography as="p" className="self-center text-xs text-muted-foreground">
              Simulated detection — a real deployment never shows unconfirmed detection as payment.
            </Typography>
          )}
        </div>
      )}

      {/* Seller-configured payment methods: the buyer picks a rail. */}
      {usesMethodFlow && isBuyer && !order.paymentMethod && (
        <div className="grid gap-2">
          {methodPayment.configError ? (
            <Typography as="p" role="alert" className="text-sm text-amber-300">
              {methodPayment.configError}
            </Typography>
          ) : methodPayment.availableMethods === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading the seller&rsquo;s payment methods…
            </div>
          ) : methodPayment.availableMethods.length === 0 ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              The seller has not set up any payment methods yet, so this order cannot be paid right now. Message the
              seller — once they configure a method in their payment settings, it appears here.
            </Typography>
          ) : (
            <>
              {methodPayment.bitcoinOfferUnavailable && (
                <Typography as="p" className="text-sm text-muted-foreground">
                  {MARKETPLACE_FAILURE_MESSAGES.bitcoinOfferUnavailable}
                </Typography>
              )}
              <Typography as="p" className="text-sm text-muted-foreground">
                Choose how to pay. Every method pays the seller directly — this marketplace never holds funds. The item
                is reserved for you only once a payment starts, and the reservation lapses if the payment isn&rsquo;t
                completed in time.
              </Typography>
              <div className="flex flex-wrap gap-2">
                {methodPayment.availableMethods.includes('bitcoin') && (
                  <Button
                    size="sm"
                    className="rounded-full"
                    disabled={methodPayment.pendingAction !== null}
                    onClick={() => void methodPayment.bind('bitcoin')}
                  >
                    <WalletCards className="mr-2 size-4" />₿ Bitcoin
                  </Button>
                )}
                {methodPayment.availableMethods.includes('stripe') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
                    disabled={methodPayment.pendingAction !== null}
                    onClick={() => void methodPayment.bind('stripe')}
                  >
                    <CreditCard className="mr-2 size-4" />
                    Card (Stripe)
                  </Button>
                )}
                {methodPayment.availableMethods.includes('paypal') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
                    disabled={methodPayment.pendingAction !== null}
                    onClick={() => void methodPayment.bind('paypal')}
                  >
                    <Banknote className="mr-2 size-4" />
                    PayPal
                  </Button>
                )}
              </div>
              {methodPayment.pendingAction === 'bind' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  Setting up the payment…
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Bound bitcoin: the private Paykit request is out; the service confirms independently. */}
      {usesMethodFlow && isBuyer && order.paymentMethod === 'bitcoin' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          The Bitcoin payment request was delivered privately to your wallet via Paykit. This page updates once the
          marketplace independently verifies the payment on-chain.
        </div>
      )}

      {/* Bound stripe: hosted checkout + processor verification. */}
      {usesMethodFlow && isBuyer && order.paymentMethod === 'stripe' && order.fiatCheckoutUrl && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            Pay through the seller&rsquo;s Stripe checkout, then verify — the marketplace checks the payment against the
            seller&rsquo;s own Stripe account.
          </Typography>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" className="rounded-full">
              <a href={order.fiatCheckoutUrl} target="_blank" rel="noopener noreferrer">
                <CreditCard className="mr-2 size-4" />
                Open Stripe checkout
              </a>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={methodPayment.pendingAction !== null}
              onClick={() => void methodPayment.verifyStripe()}
            >
              {methodPayment.pendingAction === 'verify' ? (
                <LoaderCircle className="mr-2 size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 size-4" />
              )}
              I&rsquo;ve paid — verify
            </Button>
          </div>
        </div>
      )}

      {/* Bound paypal: hosted checkout; PayPal's verified notification pays
          the order automatically. The buyer report + seller confirmation
          remain as the fallback when no notification arrives. */}
      {usesMethodFlow && isBuyer && order.paymentMethod === 'paypal' && order.fiatCheckoutUrl && (
        <div className="grid gap-2">
          {order.paymentReportedAt ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              You reported this payment{order.fiatTransactionRef ? ` (ref ${order.fiatTransactionRef})` : ''}. The order
              completes when PayPal&rsquo;s notification arrives or the seller confirms receipt in their PayPal account.
            </Typography>
          ) : (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                Pay through PayPal — this page updates by itself once PayPal confirms the payment to the marketplace,
                usually within seconds. If it doesn&rsquo;t, you can report the payment here as a fallback and the
                seller confirms receipt.
              </Typography>
              <Typography as="p" className="text-xs text-muted-foreground">
                Use this only if automatic confirmation fails. The seller must verify your PayPal transaction ID before
                shipping.
              </Typography>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" className="rounded-full">
                  <a href={order.fiatCheckoutUrl} target="_blank" rel="noopener noreferrer">
                    <Banknote className="mr-2 size-4" />
                    Open PayPal checkout
                  </a>
                </Button>
                <input
                  value={paypalTransactionRef}
                  onChange={(event) => setPaypalTransactionRef(event.target.value)}
                  placeholder="PayPal transaction ID (optional)"
                  className="h-9 max-w-56 rounded-md border bg-transparent px-3 text-sm"
                  aria-label="PayPal transaction ID"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  disabled={methodPayment.pendingAction !== null}
                  onClick={() => void methodPayment.markPaid(paypalTransactionRef)}
                >
                  {methodPayment.pendingAction === 'mark-paid' ? (
                    <LoaderCircle className="mr-2 size-4 animate-spin" />
                  ) : null}
                  I&rsquo;ve paid
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Seller side: the PayPal receipt confirmation is what pays the order. */}
      {usesMethodFlow && !isBuyer && order.paymentMethod === 'paypal' && (
        <div className="grid gap-2">
          {order.paymentReportedAt ? (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                The buyer reported a PayPal payment
                {order.fiatTransactionRef ? ` (ref ${order.fiatTransactionRef})` : ''}. Check your PayPal account;
                confirming receipt marks this order paid.
              </Typography>
              <Button
                size="sm"
                className="w-fit rounded-full"
                disabled={methodPayment.pendingAction !== null}
                onClick={() => void methodPayment.confirmReceived()}
              >
                {methodPayment.pendingAction === 'confirm' ? (
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 size-4" />
                )}
                Confirm payment received
              </Button>
            </>
          ) : (
            <Typography as="p" className="text-sm text-muted-foreground">
              Awaiting the buyer&rsquo;s PayPal payment. PayPal&rsquo;s notification usually completes the order
              automatically; if the buyer reports the payment instead, you will be asked to confirm receipt.
            </Typography>
          )}
        </div>
      )}

      {/* Seller side, stripe: either party may trigger processor verification. */}
      {usesMethodFlow && !isBuyer && order.paymentMethod === 'stripe' && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            The buyer pays through your Stripe checkout. Verification runs against your Stripe account with your
            restricted key — you can trigger it too.
          </Typography>
          <Button
            size="sm"
            variant="secondary"
            className="w-fit rounded-full"
            disabled={methodPayment.pendingAction !== null}
            onClick={() => void methodPayment.verifyStripe()}
          >
            {methodPayment.pendingAction === 'verify' ? (
              <LoaderCircle className="mr-2 size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 size-4" />
            )}
            Check for payment
          </Button>
        </div>
      )}
      {isLocksPaykit && isBuyer && isAwaiting && digitalLock && !locks.correlation && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            Paykit delivers the Bitcoin payment request privately to your wallet. This app never holds wallet keys and
            never confirms a payment itself — the marketplace verifies the Locks entitlement server-side.
          </Typography>
          <Button className="w-fit rounded-full" disabled={locks.isStarting} onClick={() => void locks.start()}>
            {locks.isStarting ? (
              <LoaderCircle className="mr-2 size-4 animate-spin" />
            ) : (
              <WalletCards className="mr-2 size-4" />
            )}
            Request payment in your wallet
          </Button>
        </div>
      )}
      {isLocksPaykit && isBuyer && isAwaiting && digitalLock && locks.correlation && !locks.correlation.registered && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            The payment request was created but its registration with the marketplace did not complete. Retry the
            registration — the same request is reused, nothing is charged twice.
          </Typography>
          <Button
            variant="secondary"
            className="w-fit rounded-full"
            disabled={locks.isStarting}
            onClick={() => void locks.start()}
          >
            Retry registration
          </Button>
        </div>
      )}
      {isLocksPaykit && isBuyer && isAwaiting && locks.correlation?.registered && (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Payment request sent. Check your wallet for the private Paykit request; this page updates once the
            marketplace independently verifies the payment.
          </div>
          {locks.pollExhausted && (
            <Button variant="secondary" size="sm" className="w-fit rounded-full" onClick={locks.resumePolling}>
              Keep checking
            </Button>
          )}
        </div>
      )}

      {/* Digital delivery after server-side confirmation. */}
      {isLocksPaykit && isBuyer && visibleStatus === 'confirmed' && locks.correlation && (
        <div className="grid gap-2 rounded-lg bg-brand/10 p-3">
          <div className="flex items-center gap-2 text-sm text-brand">
            <KeyRound className="size-4" />
            Digital delivery is ready: a short-lived Locks access credential unlocks the purchased content.
          </div>
          {locks.delivery ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <CheckCircle2 className="size-4 text-brand" />
              <span>
                {locks.delivery.fileName} · {locks.delivery.byteSize} bytes · integrity verified
              </span>
              <Button asChild size="sm" variant="secondary" className="rounded-full">
                <a href={locks.delivery.objectUrl} download={locks.delivery.fileName}>
                  <Download className="mr-2 size-4" />
                  Save file
                </a>
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              className="w-fit rounded-full"
              disabled={locks.isUnlocking}
              onClick={() => void locks.unlock()}
            >
              {locks.isUnlocking ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              Unlock content
            </Button>
          )}
        </div>
      )}

      {locks.error && (
        <Typography as="p" role="alert" className="flex items-center gap-2 text-sm text-amber-300">
          <FileWarning className="size-4" />
          {locks.error}
        </Typography>
      )}
    </div>
  );
}
