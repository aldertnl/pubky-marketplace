'use client';

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { CAPABILITIES } from '@/config/app';
import { useStepUpReauth } from '@/hooks/useStepUpReauth/useStepUpReauth';
import { Logger } from '@/libs/logger/logger';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { toast } from '@/molecules/Toaster/use-toast';

/**
 * The shared step-up re-approval affordance (docs/ecommerce/step-up-approval.md,
 * Option C) for scope-gated features — watchlist sync and portable receipts
 * today. Mirrors the sign-in / session-connect precedent: the `pubkyauth://`
 * authorization URL renders as a QR for a cross-device Pubky Ring scan, and
 * as a deeplink/copy affordance for same-device Ring.
 *
 * Every open starts a FRESH flow and closing cancels it — auth flows are
 * single-use, so a failed or abandoned flow's QR is never shown again. On
 * approval the controller swaps the auth-store session for the widened
 * (superset-grant) one, which is what makes watchlist sync, receipts, and
 * messaging cookie-resume capable without a reload.
 */
export function MarketplaceReauthDialog({
  triggerLabel,
  onReauthenticated,
}: {
  triggerLabel: string;
  onReauthenticated?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const reauth = useStepUpReauth({
    onReauthenticated: async () => {
      toast({
        title: 'Signed in again with full permissions',
        description: 'Watchlist sync, portable receipts, and messaging now work in this session.',
      });
      setOpen(false);
      await onReauthenticated?.();
    },
  });

  // Referencing `reauth.start`/`reauth.cancel` directly keeps the effect
  // dependency-stable: both are useCallback-memoized in the hook.
  const { start, cancel } = reauth;
  useEffect(() => {
    if (open) {
      start();
      return;
    }
    cancel();
  }, [open, start, cancel]);

  const copyUrl = async () => {
    try {
      await reauth.copyAuthUrl();
      toast({ variant: 'info', title: 'Authorization link copied' });
    } catch (error) {
      Logger.error('Failed to copy the re-authentication link', { error });
      toast({ variant: 'error', description: 'Could not copy to clipboard' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" className="rounded-full">
          <KeyRound className="mr-2 size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>Sign in again with full permissions</DialogTitle>
        </DialogHeader>

        <Typography as="p" className="text-sm text-muted-foreground">
          Approving with your signer (Pubky Ring) signs you in again with the app&apos;s full permission list — public
          app data, encrypted messaging, and private storage. Your account and data stay exactly as they are; only the
          session&apos;s permissions widen, so watchlist sync, portable receipts, and messaging all work.
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          Ring will show the full permission list — that is correct. This approval replaces your current session for
          the same identity; it does not create a new account.
        </Typography>

        {/* The exact requested capability string, verbatim from the single
            `CAPABILITIES` constant the flow is generated with — Ring displays
            the same list at approval time, so the user can compare the two
            (docs/ecommerce/step-up-approval.md, QR/phish-swap row). */}
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <code className="block break-all font-mono text-xs" data-cy="reauth-requested-capabilities">
            {CAPABILITIES}
          </code>
          <Typography as="p" className="mt-1 text-xs text-muted-foreground">
            Pubky Ring will show this exact permission list — compare it before approving.
          </Typography>
        </div>

        {reauth.status === 'error' ? (
          <div className="grid gap-3">
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
              {reauth.errorMessage}
            </div>
            <Button className="w-fit rounded-full" onClick={reauth.start}>
              <RefreshCw className="mr-2 size-4" />
              Try again
            </Button>
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <button
              type="button"
              className="group relative flex size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2"
              onClick={() => void copyUrl()}
              disabled={!reauth.authorizationUrl}
              aria-label="Copy authorization link"
            >
              <QrCodeSlot
                isLoading={reauth.status !== 'awaiting'}
                isExpired={false}
                url={reauth.authorizationUrl}
                generatingLabel="Generating QR Code..."
                clickToReloadLabel="Click to reload"
                activeQrHasHoverEffect
              />
            </button>

            {reauth.status === 'awaiting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin" />
                Waiting for approval on your signer…
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={reauth.openInRing}
                disabled={!reauth.authorizationUrl || reauth.isOpeningRing}
                aria-busy={reauth.isOpeningRing}
              >
                {reauth.isOpeningRing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Smartphone className="mr-2 size-4" />
                )}
                {reauth.isOpeningRing ? 'Opening Pubky Ring...' : 'Open in Pubky Ring'}
              </Button>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => void copyUrl()}
                disabled={!reauth.authorizationUrl}
              >
                <Copy className="mr-2 size-4" />
                Copy link
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
