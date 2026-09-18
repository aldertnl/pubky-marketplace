'use client';

import { useEffect, useState } from 'react';
import { Controller, useWatch } from 'react-hook-form';
import { Button } from '@/atoms/Button/Button';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Label } from '@/atoms/Label/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { COMMERCE_REVIEW_EDIT_WINDOW_SECONDS } from '@/config/commerce';
import { FORM_LABEL_CLASSES } from '@/config/forms';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceOrderAction } from '@/hooks/useMarketplaceOrderAction/useMarketplaceOrderAction';
import type { MarketplaceOrderActionData } from '@/hooks/useMarketplaceOrderAction/useMarketplaceOrderAction.types';
import { usePickupOrderActions } from '@/hooks/usePickupOrderActions/usePickupOrderActions';
import { OTHER_CARRIER_ID, SHIPPING_CARRIERS } from '@/libs/commerce/carriers';
import type { CommerceReviewModelSchema } from '@/models/commerce/commerce.schema';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ControlledTextareaField } from '@/molecules/ControlledTextareaField/ControlledTextareaField';
import { MarketplaceStarRating } from '@/molecules/MarketplaceStarRating/MarketplaceStarRating';
import { toast } from '@/molecules/Toaster/use-toast';
import { MarketplacePackingSlipDialog } from '@/organisms/Marketplace/MarketplacePackingSlipDialog';
import { MarketplacePickupRevealDialog } from '@/organisms/Marketplace/MarketplacePickupRevealDialog';
import { MarketplaceShippingLabelDialog } from '@/organisms/Marketplace/MarketplaceShippingLabelDialog';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

export function MarketplaceOrderActions({
  order,
  isBuyer,
  canEditReview,
  actOnOrder,
  onChanged,
}: {
  order: MarketplaceOrder;
  isBuyer: boolean;
  /**
   * `review.update` only exists on the durable service (the sandbox has no
   * review editing), so the edit affordance is withheld in sandbox mode
   * instead of failing after a click. Within the mode, the button further
   * requires the caller's own review to still be inside the service's
   * 24-hour edit window.
   */
  canEditReview: boolean;
  actOnOrder: (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>;
  /** Reloads the timeline after a pickup-path command (the same refetch `actOnOrder` performs). */
  onChanged?: () => Promise<void> | void;
}) {
  const reloadOrders = onChanged ?? (() => undefined);
  const [open, setOpen] = useState(false);
  // Read once per mount (render must stay pure, so the clock is sampled in an
  // effect): the affordance freezes at page entry rather than vanishing
  // mid-view, and the service enforces the real boundary on submit anyway.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);
  const action = useMarketplaceOrderAction(order, actOnOrder);
  const actionType = useWatch({ control: action.form.control, name: 'action' });
  const carrierChoice = useWatch({ control: action.form.control, name: 'carrierChoice' });

  // Seller-side half of the D2 amount-band consent, read honestly from the
  // service when the buyer opens the review dialog: `true` renders the
  // opt-in, `false` renders the truthful "seller has not enabled" note, and
  // `null` (sandbox / read failed) renders nothing — never a dead checkbox.
  const [sellerBandConsent, setSellerBandConsent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || actionType !== 'review' || !isBuyer) return;
    let active = true;
    CommerceController.getMarketplaceBandConsent(order.sellerPubky)
      .then((consent) => {
        if (active) setSellerBandConsent(consent);
      })
      .catch(() => {
        if (active) setSellerBandConsent(null);
      });
    return () => {
      active = false;
    };
  }, [open, actionType, isBuyer, order.sellerPubky]);

  // The local-first copy of the user's own published review record: its
  // publication + attestation state backs the verified-status line below.
  const [ownReviewRecord, setOwnReviewRecord] = useState<CommerceReviewModelSchema | null>(null);
  const ownReviewerPubkyForRecord = isBuyer ? order.buyerPubky : order.sellerPubky;
  const hasOwnReview = order.reviews?.some(({ reviewerPubky }) => reviewerPubky === ownReviewerPubkyForRecord);
  useEffect(() => {
    if (!hasOwnReview) return;
    let active = true;
    CommerceController.getOwnMarketplaceReview(order.id)
      .then((record) => {
        if (active) setOwnReviewRecord(record);
      })
      .catch(() => {
        if (active) setOwnReviewRecord(null);
      });
    return () => {
      active = false;
    };
  }, [hasOwnReview, order.id, order.revision]);

  const begin = (next: MarketplaceOrderActionData['action'], overrides?: Partial<MarketplaceOrderActionData>) => {
    action.setAction(next, overrides);
    setOpen(true);
  };

  const ownReviewerPubky = isBuyer ? order.buyerPubky : order.sellerPubky;
  const ownReview = order.reviews?.find(({ reviewerPubky }) => reviewerPubky === ownReviewerPubky);
  // Mirrors the service's boundary exactly: the edit is refused only once
  // `now` moves PAST created_at + window, so `<=` here matches `>` there.
  const isOwnReviewEditable =
    ownReview !== undefined &&
    nowMs !== null &&
    nowMs <= Date.parse(ownReview.createdAt) + COMMERCE_REVIEW_EDIT_WINDOW_SECONDS * 1000;

  // Local pickup (Wave 7, §A6): the pickup path has its own commands and its
  // own exits; shipped orders behave exactly as before.
  const isPickup = order.fulfillment === 'pickup';
  const pickup = usePickupOrderActions(order, reloadOrders);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [termsBlocked, setTermsBlocked] = useState(false);
  // The unilateral exits (§A3): a post-payment terms change, or the bounded
  // withdrawal window (first reveal stamped, no handover confirm yet).
  const unilateralCancelOpen = Boolean(order.pickupTermsChanged) || Boolean(order.firstRevealedAt);
  const canReveal =
    isBuyer && isPickup && order.receiptId !== null && !['completed', 'cancelled', 'refunded_external', 'closed'].includes(order.state);

  const submit = async () => {
    // Pickup cancellations keep the reason field but run the pickup-aware
    // flow: the service either cancels outright (unilateral exit) or
    // degrades to the ordinary cancel_requested, and each outcome gets its
    // own honest copy (§7.2).
    if (isPickup && actionType === 'cancel') {
      if (!(await action.form.trigger('reason'))) return;
      const outcome = await pickup.cancelOrder(action.form.getValues('reason'));
      if (outcome === 'cancelled') {
        toast({
          title: 'Order cancelled',
          description:
            'Cancelling moved no money. If you already paid, the refund is arranged with the seller and recorded as external evidence.',
        });
        setOpen(false);
      } else if (outcome === 'cancel_requested') {
        toast({
          variant: 'warning',
          description: 'Instant cancellation was not available; your cancellation request now awaits the seller.',
        });
        setOpen(false);
      }
      return;
    }
    if (await action.submit()) setOpen(false);
  };

  const confirmHandover = async () => {
    const outcome = await pickup.confirmHandover();
    if (outcome === 'confirmed') setHandoverOpen(false);
    if (outcome === 'terms_blocked') setTermsBlocked(true);
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* Cancellation (order.cancel_request / order.cancel_approve) is now
            implemented by BOTH engines — the sandbox and the durable service —
            so the affordance is no longer mode-gated. Pickup orders add
            `ready_for_pickup` to the cancellable states (§A6). */}
        {isBuyer &&
          (['pending_payment', 'paid', 'processing'].includes(order.state) ||
            (isPickup && order.state === 'ready_for_pickup')) && (
            <Button size="sm" variant="secondary" className="rounded-full" onClick={() => begin('cancel')}>
              Cancel order
            </Button>
          )}
        {canReveal && <MarketplacePickupRevealDialog order={order} />}
        {/* The handover confirm belongs to EITHER party — whoever is standing
            there with the item taps confirm (§A6). */}
        {isPickup && ['paid', 'ready_for_pickup'].includes(order.state) && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={pickup.isActing}
            onClick={() => {
              setTermsBlocked(false);
              setHandoverOpen(true);
            }}
          >
            Confirm handover
          </Button>
        )}
        {!isBuyer && isPickup && order.state === 'paid' && (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={pickup.isActing}
            onClick={() => void pickup.markReady()}
          >
            Mark ready for pickup
          </Button>
        )}
        {/* Pickup orders never ship: no tracking, no label (§A6). */}
        {!isBuyer && !isPickup && ['paid', 'processing'].includes(order.state) && (
          <>
            <Button size="sm" className="rounded-full" onClick={() => begin('ship')}>
              Add tracking
            </Button>
            <MarketplaceShippingLabelDialog order={order} actOnOrder={actOnOrder} />
          </>
        )}
        {/* The print affordance is HIDDEN on pickup orders, not
            shown-with-note (§A5) — nothing about a pickup order needs paper.
            The dialog's note-only branch stays as the fallback for any mixed
            case that could still reach it. */}
        {!isBuyer && !isPickup && ['paid', 'processing', 'shipped', 'delivered', 'completed'].includes(order.state) && (
          <MarketplacePackingSlipDialog order={order} />
        )}
        {isBuyer && order.state === 'shipped' && (
          <Button
            size="sm"
            className="rounded-full"
            onClick={() => void actOnOrder(order, 'fulfillment.confirm_delivery', {})}
          >
            Confirm delivery
          </Button>
        )}
        {isBuyer && ['delivered', 'completed'].includes(order.state) && !order.returnRequest && (
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => begin('return')}>
            Request return
          </Button>
        )}
        {!isBuyer && order.state === 'cancel_requested' && (
          <Button size="sm" className="rounded-full" onClick={() => void actOnOrder(order, 'order.cancel_approve', {})}>
            Approve cancellation
          </Button>
        )}
        {!isBuyer && order.state === 'return_requested' && (
          <Button size="sm" className="rounded-full" onClick={() => void actOnOrder(order, 'return.approve', {})}>
            Approve return
          </Button>
        )}
        {!isBuyer && order.state === 'return_approved' && (
          <Button size="sm" className="rounded-full" onClick={() => void actOnOrder(order, 'return.receive', {})}>
            Mark return received
          </Button>
        )}
        {!isBuyer && ['return_received', 'cancelled'].includes(order.state) && !order.externalRefund && (
          <Button size="sm" className="rounded-full" onClick={() => begin('refund')}>
            Record external refund
          </Button>
        )}
        {['delivered', 'completed'].includes(order.state) &&
          !order.reviews?.some(({ reviewerPubky }) =>
            isBuyer ? reviewerPubky === order.buyerPubky : reviewerPubky === order.sellerPubky,
          ) && (
            <Button size="sm" variant="secondary" className="rounded-full" onClick={() => begin('review')}>
              Leave review
            </Button>
          )}
        {canEditReview && ownReview && isOwnReviewEditable && (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => begin('review_edit', { rating: String(ownReview.rating), text: ownReview.text })}
          >
            Edit review
          </Button>
        )}
      </div>

      {ownReview && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="own-review-status">
          {reviewRecordStatus(ownReviewRecord)}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>{actionTitle(actionType, isPickup)}</DialogTitle>
          </DialogHeader>
          {isPickup && actionType === 'cancel' && (
            <Typography as="p" className="text-sm text-muted-foreground">
              This requests a cancellation — cancelling moves no money. If you already paid, the refund is arranged
              with the seller and recorded as external evidence.{' '}
              {unilateralCancelOpen
                ? 'The seller changed the pickup terms after you paid, or you have seen the meeting point and the handover is not confirmed yet — so this completes immediately, with no seller approval needed, and it does not count against the seller.'
                : 'It completes immediately only if the seller changes the pickup terms after you paid, or once you have seen the meeting point (before the handover is confirmed); otherwise the seller is asked to approve.'}
            </Typography>
          )}
          {['cancel', 'return'].includes(actionType) && (
            <ControlledTextareaField
              name="reason"
              control={action.form.control}
              label="Reason"
              placeholder="Describe what happened"
            />
          )}
          {actionType === 'ship' && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="ship-carrier-select" className={FORM_LABEL_CLASSES}>
                  Carrier
                </Label>
                <Controller
                  name="carrierChoice"
                  control={action.form.control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="ship-carrier-select" className="h-11 w-full rounded-md border px-3">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SHIPPING_CARRIERS.map((carrier) => (
                          <SelectItem key={carrier.id} value={carrier.id}>
                            {carrier.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              {carrierChoice === OTHER_CARRIER_ID && (
                <ControlledInputField name="carrier" control={action.form.control} label="Carrier name" />
              )}
              <ControlledInputField name="trackingNumber" control={action.form.control} label="Tracking number" />
            </>
          )}
          {['return', 'refund'].includes(actionType) && (
            <ControlledInputField name="amount" control={action.form.control} label="Amount (USD)" />
          )}
          {actionType === 'refund' && (
            <ControlledInputField
              name="transactionId"
              control={action.form.control}
              label={externalRefundReferenceLabel(order.paymentMethod)}
            />
          )}
          {['review', 'review_edit'].includes(actionType) && (
            <>
              <Controller
                name="rating"
                control={action.form.control}
                render={({ field }) => <MarketplaceStarRatingInput value={field.value} onChange={field.onChange} />}
              />
              <ControlledTextareaField name="text" control={action.form.control} label="Review" />
            </>
          )}
          {actionType === 'review' && isBuyer && sellerBandConsent === true && (
            <Controller
              name="allowAmountBand"
              control={action.form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  label="Include an approximate price range"
                  description="Your review's purchase attestation will carry a coarse order-of-magnitude band (never the exact amount). This seller has allowed it; it is included only if you opt in too."
                />
              )}
            />
          )}
          {actionType === 'review' && isBuyer && sellerBandConsent === false && (
            <p className="text-xs text-muted-foreground">
              This seller has not enabled price-range sharing, so your review&apos;s attestation will not carry an
              amount band.
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="rounded-full" onClick={submit} disabled={isPickup && actionType === 'cancel' && pickup.isActing}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The pickup handover confirm (§A6). The review-hook copy names the
          risk before confirm; the seller-attested wording states the
          reputation asymmetry; a seller-actor confirm refused during an
          unresolved terms change gets the explanation, not an error toast. */}
      <Dialog open={handoverOpen} onOpenChange={setHandoverOpen}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Confirm the handover</DialogTitle>
          </DialogHeader>
          {termsBlocked ? (
            <Typography as="p" role="alert" className="text-sm text-muted-foreground">
              You changed the pickup terms after this order was paid. Until the buyer has seen the change, only the
              buyer can confirm the handover — this keeps their instant-cancel exit open.
            </Typography>
          ) : (
            <Typography as="p" className="text-sm text-muted-foreground">
              {isBuyer
                ? 'Only confirm once the item is in your hands.'
                : 'Confirm only once the buyer has left with the item. A handover you confirm yourself counts toward your reputation only once the order completes without a dispute — the buyer\u2019s confirm counts right away.'}
            </Typography>
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => setHandoverOpen(false)}>
              {termsBlocked ? 'Close' : 'Not yet'}
            </Button>
            {!termsBlocked && (
              <Button className="rounded-full" disabled={pickup.isActing} onClick={() => void confirmHandover()}>
                Confirm handover
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MarketplaceStarRatingInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label className={FORM_LABEL_CLASSES}>Rating</Label>
      <div role="radiogroup" aria-label="Rating" className="flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5].map((rating) => {
          const ratingValue = String(rating);
          return (
            <label
              key={ratingValue}
              className="relative cursor-pointer rounded-full border border-border/70 px-3 py-2 transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2"
            >
              <input
                type="radio"
                name="rating"
                value={ratingValue}
                checked={value === ratingValue}
                tabIndex={value === ratingValue ? 0 : -1}
                onChange={() => onChange(ratingValue)}
                aria-label={`${rating} ${rating === 1 ? 'star' : 'stars'}`}
                className="sr-only"
              />
              <span aria-hidden="true">
                <MarketplaceStarRating rating={rating} size="sm" />
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The truthful publication/verification state of the user's own review.
 * "Verified" means exactly: the published record embeds a purchase
 * attestation whose Ed25519 signature verifies against its issuer pubky and
 * whose claims bind to this record — nothing more.
 */
function reviewRecordStatus(record: CommerceReviewModelSchema | null): string {
  if (record === null) {
    return 'Your review is saved with the marketplace service. The public publication status will appear when its durable record is available.';
  }
  if (record.sync_status === 'pending') {
    return 'Your review is saved; publishing the public record to your homeserver is still pending and will retry.';
  }
  if (record.attestation_verified && record.attestation_iss !== null) {
    return `Verified purchase — your published review embeds a purchase attestation signed by attestor ${record.attestation_iss.slice(0, 8)}….`;
  }
  return 'Your review record is published, but its embedded attestation did not verify.';
}

function externalRefundReferenceLabel(paymentMethod: MarketplaceOrder['paymentMethod']): string {
  switch (paymentMethod) {
    case 'bitcoin':
      return 'External Bitcoin transaction reference';
    case 'paypal':
      return 'PayPal transaction reference';
    case 'stripe':
      return 'Stripe payment reference';
    default:
      return 'External payment reference';
  }
}

function actionTitle(action: MarketplaceOrderActionData['action'], isPickup = false): string {
  switch (action) {
    case 'cancel':
      return isPickup ? 'Cancel this pickup order' : 'Request cancellation';
    case 'ship':
      return 'Add shipment tracking';
    case 'return':
      return 'Request a return';
    case 'refund':
      return 'Record external refund';
    case 'review':
      return 'Leave a review';
    case 'review_edit':
      return 'Edit your review';
  }
}
