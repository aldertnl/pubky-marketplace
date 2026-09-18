'use client';

import { type ReactNode, useState } from 'react';
import { LockKeyhole, ShieldAlert } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { useEncryptedConversation } from '@/hooks/useEncryptedConversation/useEncryptedConversation';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { EncryptedConversationBody } from '@/organisms/Messaging/EncryptedConversationBody';
import { MarketplaceMessagingEnablePanel } from './MarketplaceMessagingEnableDialog';

/**
 * Provenance of the vendored encrypted transport (pinned commit, checksums,
 * proof coverage, known limitations). Linked from the E2EE label so the
 * "experiment-grade" claim is auditable, not decorative. Exported for the
 * general messages surfaces, which ride the same transport.
 */
export const PAYKIT_WASM_PROVENANCE_URL =
  'https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr22-messaging/docs/ecommerce/paykit-wasm-provenance.md';

/**
 * One end-to-end-encrypted listing conversation (durable commerce modes).
 * Every state shown maps to a real transport fact — see
 * `useEncryptedConversation` for the state semantics. Attachments are NOT
 * offered here: one encrypted message is capped at 1000 bytes including its
 * envelope, which forbids inline images; the encrypted-blob pattern the
 * protocol intends for attachments is future work.
 */
export function MarketplaceEncryptedConversationDialog({
  sellerPubky,
  buyerPubky,
  listingId,
  counterpartyPubky,
  trigger,
}: {
  sellerPubky: string;
  buyerPubky: string;
  listingId: string;
  counterpartyPubky: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { requireAuth } = useRequireAuth();
  const conversation = useEncryptedConversation(sellerPubky, buyerPubky, listingId, open);
  const counterpartyLabel = `${counterpartyPubky.slice(0, 10)}…`;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false);
          return;
        }
        requireAuth(() => setOpen(true));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="border-border bg-popover sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Listing conversation</DialogTitle>
        </DialogHeader>

        <Typography as="p" className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5 shrink-0" aria-hidden />
          End-to-end encrypted · history stored on this device ·{' '}
          <Link href={PAYKIT_WASM_PROVENANCE_URL} target="_blank" rel="noreferrer" className="underline">
            experiment-grade transport
          </Link>
        </Typography>

        {conversation.status === 'loading' && <Skeleton className="h-40 w-full" />}

        {conversation.status === 'needs-enable' && (
          <MarketplaceMessagingEnablePanel
            reconnect={conversation.receiverProvisioned}
            onEnabled={conversation.refresh}
          />
        )}

        {conversation.status === 'not-enrolled' && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center">
            <ShieldAlert className="size-8 text-muted-foreground" aria-hidden />
            <Typography as="p" className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{counterpartyLabel}</span> hasn&apos;t enabled encrypted
              messaging yet. Nothing can be delivered to them until they do — this app will not pretend otherwise.
            </Typography>
          </div>
        )}

        {conversation.status === 'handshaking-initiator' && (
          <EncryptedConversationBody conversation={conversation} counterpartyLabel={counterpartyLabel}>
            <Typography
              as="p"
              role="status"
              className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground"
            >
              Their messenger hasn&apos;t responded yet — messages you send are queued on this device and deliver
              automatically when it does.
            </Typography>
          </EncryptedConversationBody>
        )}

        {conversation.status === 'handshaking-responder' && (
          <EncryptedConversationBody conversation={conversation} counterpartyLabel={counterpartyLabel}>
            <Typography
              as="p"
              role="status"
              className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground"
            >
              Still securing this conversation — messages you send are queued on this device and deliver automatically
              once the encrypted handshake completes.
            </Typography>
          </EncryptedConversationBody>
        )}

        {conversation.status === 'ready' && (
          <EncryptedConversationBody conversation={conversation} counterpartyLabel={counterpartyLabel} />
        )}

        {conversation.status === 'error' && (
          <div className="grid gap-3">
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
              {conversation.errorMessage}
            </div>
            <Button className="w-fit rounded-full" onClick={conversation.refresh}>
              Try again
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
