'use client';

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { CAPABILITIES } from '@/config/app';
import { useMarketplaceSessionConnect } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect';
import { Logger } from '@/libs/logger/logger';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { toast } from '@/molecules/Toaster/use-toast';

/**
 * The in-app UX for establishing a marketplace transaction-service session
 * (durable modes only). Mirrors the sign-in precedent: the `pubkyauth://`
 * authorization URL renders as a QR for a cross-device Pubky Ring scan, and
 * as a deeplink/copy affordance for same-device Ring.
 *
 * Every open starts a FRESH flow and closing cancels it — AuthTokens are
 * single-use, so a failed or abandoned flow's QR is never shown again. On
 * approval the controller mirrors the session facts into the commerce store,
 * which is what makes the dependent durable-mode surfaces refetch.
 */
export function MarketplaceSessionConnectDialog({
  triggerLabel = 'Connect marketplace session',
  onConnected,
}: {
  triggerLabel?: string;
  onConnected?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const session = useMarketplaceSessionConnect({
    onConnected: () => {
      toast({
        title: 'Purchases approved in Pubky Ring',
        description: 'This session stays on this device across tabs and restarts until it expires or you sign out.',
      });
      setOpen(false);
      void onConnected?.();
    },
  });

  // Referencing `session.start`/`session.cancel` directly keeps the effect
  // dependency-stable: both are useCallback-memoized in the hook.
  const { start, cancel } = session;
  useEffect(() => {
    if (open) {
      start();
      return;
    }
    cancel();
  }, [open, start, cancel]);

  const copyUrl = async () => {
    try {
      await session.copyAuthUrl();
      toast({ variant: 'info', title: 'Authorization link copied' });
    } catch (error) {
      Logger.error('Failed to copy the marketplace authorization link', { error });
      toast({ variant: 'error', description: 'Could not copy to clipboard' });
    }
  };

  // Which consent is being requested is decided ONCE by the hook (it also
  // picks the flow `start()` begins) — never re-evaluate it here, or the
  // copy could describe a different approval than the QR requests.
  const requestsFullGrant = session.requestsFullGrant;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-full">
          <KeyRound className="mr-2 size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>Approve purchases in Pubky Ring</DialogTitle>
        </DialogHeader>

        <Typography as="p" className="text-sm text-muted-foreground">
          {requestsFullGrant
            ? 'Approving with Pubky Ring signs you in to Shop with the full permission list and lets this marketplace place orders, bids, and offers as you. Nothing is charged until you pay.'
            : 'Approving with Pubky Ring lets this marketplace place orders, bids, and offers as you. Nothing is charged until you pay. The approval stays on this device across tabs and restarts until it expires or you sign out.'}
        </Typography>
        <Typography as="p" className="text-sm text-muted-foreground">
          {requestsFullGrant
            ? 'Ring will show the full permission list — that is correct. This is the first Shop-scoped approval; it was not covered by signing in on pubky.app.'
            : 'Ring will show an empty permission list — that is correct. This approval only proves your identity to the marketplace service; it grants no read or write access to anything on your homeserver.'}
        </Typography>
        {requestsFullGrant && (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <code className="block break-all font-sans text-xs" data-cy="session-connect-requested-capabilities">
              {CAPABILITIES}
            </code>
            <Typography as="p" className="mt-1 text-xs text-muted-foreground">
              Pubky Ring will show this exact permission list — compare it before approving.
            </Typography>
          </div>
        )}

        {session.status === 'error' ? (
          <div className="grid gap-3">
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
              {session.errorMessage}
            </div>
            <Button className="w-fit rounded-full" onClick={session.start}>
              <RefreshCw className="mr-2 size-4" />
              Try again
            </Button>
          </div>
        ) : session.status === 'joined' ? (
          // The approval lives on another surface (e.g. a sign-in in
          // progress), which holds the only scannable URL. No QR, Copy, or
          // Open here — approving there settles this session too.
          <div role="status" className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            An approval is already in progress on another surface. Approve it there — it also connects this
            marketplace session.
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <button
              type="button"
              className="group relative flex size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2"
              onClick={() => void copyUrl()}
              disabled={!session.authorizationUrl}
              aria-label="Copy authorization link"
            >
              <QrCodeSlot
                isLoading={session.status !== 'awaiting'}
                isExpired={false}
                url={session.authorizationUrl}
                generatingLabel="Generating QR Code..."
                clickToReloadLabel="Click to reload"
                activeQrHasHoverEffect
              />
            </button>

            {session.status === 'awaiting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin" />
                Waiting for approval on your signer…
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={session.openInRing}
                disabled={!session.authorizationUrl || session.isOpeningRing}
                aria-busy={session.isOpeningRing}
              >
                {session.isOpeningRing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Smartphone className="mr-2 size-4" />
                )}
                {session.isOpeningRing ? 'Opening Pubky Ring...' : 'Open in Pubky Ring'}
              </Button>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => void copyUrl()}
                disabled={!session.authorizationUrl}
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
