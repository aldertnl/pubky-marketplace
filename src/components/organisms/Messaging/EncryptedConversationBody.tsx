'use client';

import { type ReactNode } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import type {
  ConversationThreadItem,
  UseEncryptedConversationReturn,
} from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { cn } from '@/libs/utils/utils';

/**
 * The shared thread + composer of one end-to-end-encrypted conversation:
 * message bubbles from device-local history, queued-but-not-yet-sent bubbles
 * (honestly labeled "Queued", cancellable, never shown as sent), the live
 * byte-budget composer, and the honest storage disclosure. Used by the
 * marketplace listing conversation dialog and the general DM conversation
 * page — both ride the same Encrypted Link transport, so the body is one
 * component with the context-specific copy passed in. The composer is always
 * available: while the handshake is pending, sends queue device-locally and
 * deliver automatically once the link is ready.
 */
export function EncryptedConversationBody({
  conversation,
  counterpartyLabel,
  composerPlaceholder = 'Is this still available?',
  emptyPrompt = 'Ask about condition, shipping, or item details. Do not share payment credentials.',
  children,
}: {
  conversation: UseEncryptedConversationReturn;
  counterpartyLabel: string;
  composerPlaceholder?: string;
  emptyPrompt?: string;
  children?: ReactNode;
}) {
  const overBudget = conversation.draftBytes > conversation.bodyBudgetBytes;

  return (
    <>
      <div aria-live="polite" className="max-h-80 space-y-3 overflow-y-auto rounded-xl border bg-card/50 p-4">
        {conversation.thread.length ? (
          conversation.thread.map((item) =>
            item.deliveryState === 'sent' ? (
              <SentThreadBubble key={item.message.id} item={item} />
            ) : (
              <QueuedThreadBubble key={item.queued.id} item={item} onCancel={conversation.cancelQueued} />
            ),
          )
        ) : (
          <Typography as="p" className="py-8 text-center text-sm text-muted-foreground">
            {emptyPrompt || `No messages yet with ${counterpartyLabel}.`}
          </Typography>
        )}
      </div>

      {children}

      <div className="grid gap-1">
        <label htmlFor="encrypted-message-body" className="text-sm font-medium">
          Message
        </label>
        <textarea
          id="encrypted-message-body"
          rows={3}
          value={conversation.draft}
          onChange={(event) => conversation.setDraft(event.target.value)}
          placeholder={composerPlaceholder}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1"
        />
        <Typography
          as="p"
          overrideDefaults
          aria-live="polite"
          className={cn('text-right text-xs', overBudget ? 'text-destructive' : 'text-muted-foreground')}
        >
          {conversation.draftBytes} / {conversation.bodyBudgetBytes} bytes
        </Typography>
      </div>

      {conversation.sendError && (
        <Typography as="p" role="alert" className="text-sm text-destructive">
          {conversation.sendError}
        </Typography>
      )}

      <div className="flex items-center justify-between gap-3">
        <Typography as="p" overrideDefaults className="text-xs text-muted-foreground">
          No attachments here: one encrypted message is capped at 1,000 bytes, too small for images.
        </Typography>
        <Button
          className="rounded-full"
          onClick={() => void conversation.send()}
          disabled={conversation.isSending || !conversation.draft.trim() || overBudget}
          aria-busy={conversation.isSending}
        >
          {conversation.isSending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
          {conversation.isSending ? 'Sending…' : 'Send'}
        </Button>
      </div>

      <Typography as="p" overrideDefaults className="text-xs text-muted-foreground">
        Messages travel as ciphertext; no service operator can read them. History and the local encryption keys live
        only in this browser — clearing site data deletes them, and no other device can show this conversation.
      </Typography>
    </>
  );
}

function SentThreadBubble({ item }: { item: Extract<ConversationThreadItem, { deliveryState: 'sent' }> }) {
  const mine = item.message.direction === 'sent';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2 text-sm',
          mine ? 'bg-brand text-primary-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        <Typography as="p" overrideDefaults className="text-sm break-words whitespace-pre-wrap">
          {item.message.body}
        </Typography>
      </div>
    </div>
  );
}

/**
 * A message queued on this device, NOT yet sent: muted bubble, an explicit
 * "Queued" label (with a retry note once a flush attempt actually failed),
 * and a cancel affordance. When the flush delivers it, the real sent record
 * replaces this bubble — it never silently turns into a sent style.
 */
function QueuedThreadBubble({
  item,
  onCancel,
}: {
  item: Extract<ConversationThreadItem, { deliveryState: 'queued' }>;
  onCancel: (id: string) => Promise<void>;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        <div className="rounded-2xl border border-dashed bg-secondary/50 px-4 py-2 text-sm text-secondary-foreground">
          <Typography as="p" overrideDefaults className="text-sm break-words whitespace-pre-wrap">
            {item.queued.body}
          </Typography>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{item.queued.last_error !== null ? 'Queued — last attempt failed, will retry' : 'Queued'}</span>
          <button
            type="button"
            aria-label="Cancel queued message"
            onClick={() => void onCancel(item.queued.id)}
            className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
