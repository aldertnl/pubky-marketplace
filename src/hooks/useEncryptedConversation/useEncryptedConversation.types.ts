import type {
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';

/**
 * The truthful states of one encrypted conversation surface. Every state maps
 * to a real transport fact — none of them claims delivery or readiness that
 * has not happened:
 *
 * - `loading`               — resolving local status; nothing known yet.
 * - `needs-enable`          — no live `/pub/paykit/:rw` session here and
 *                             silent restore failed. Either messaging was
 *                             never enabled, or the homeserver cookie expired
 *                             or was revoked (sessions persist in localStorage
 *                             and restore across tabs and reloads while the
 *                             cookie holds) — a fresh Ring approval is needed.
 * - `not-enrolled`          — the counterparty has published no receiver
 *                             marker: encrypted messaging cannot reach them,
 *                             and the UI says so instead of faking delivery.
 * - `handshaking-initiator` — our handshake invitation is queued on the
 *                             homeservers. Noise XX needs the counterparty's
 *                             runtime to answer before ANY message can be
 *                             sent — but the composer stays OPEN: messages
 *                             queue device-locally (labeled "Queued", never
 *                             sent) and deliver automatically once the
 *                             counterparty answers.
 * - `handshaking-responder` — an inbound handshake is being answered; the
 *                             final round needs the initiator online again.
 *                             The composer stays open with the same honest
 *                             queue-until-ready behavior.
 * - `ready`                 — the Encrypted Link is established; sending and
 *                             receiving are live.
 * - `error`                 — a real transport failure, with its message.
 */
export type EncryptedConversationStatus =
  | 'loading'
  | 'needs-enable'
  | 'not-enrolled'
  | 'handshaking-initiator'
  | 'handshaking-responder'
  | 'ready'
  | 'error';

/**
 * One item of the rendered thread, discriminated by its honest delivery
 * state: `sent` wraps a real history row (direction `sent` or `received` —
 * the binding actually carried it), `queued` wraps a device-local outbox row
 * that has NOT been sent yet and is delivered automatically once the link is
 * ready. When a queued row flushes, the real sent record replaces it in the
 * next load — the merge never shows both.
 */
export type ConversationThreadItem =
  | { deliveryState: 'sent'; message: CommerceMessagingMessageModelSchema }
  | { deliveryState: 'queued'; queued: CommerceMessagingOutboxModelSchema };

/**
 * What actually happened to a composed message: `delivered` — the binding
 * sent it over the ready link; `queued` — nothing was sent, the message
 * waits device-locally and delivers automatically; `failed` — neither
 * happened (validation or transport error; the draft is kept).
 */
export type EncryptedSendOutcome = 'delivered' | 'queued' | 'failed';

export interface UseEncryptedConversationReturn {
  status: EncryptedConversationStatus;
  /** Real failure message when `status === 'error'`. */
  errorMessage: string | null;
  /**
   * The merged thread: device-local history (oldest first), then this
   * conversation's queued rows (queue order). Queued items are rendered
   * distinctly and never as sent.
   */
  thread: ConversationThreadItem[];
  /** True when a receiver key already exists on this device (reconnect vs first enable copy). */
  receiverProvisioned: boolean;
  /** Composer draft, kept on send failure so nothing typed is lost. */
  draft: string;
  setDraft: (draft: string) => void;
  /** Serialized byte budget for the body in this conversation, and the draft's current cost. */
  bodyBudgetBytes: number;
  draftBytes: number;
  /** True while a send is in flight. */
  isSending: boolean;
  /** Send failure message from the last attempt, cleared on the next attempt. */
  sendError: string | null;
  send: () => Promise<EncryptedSendOutcome>;
  /** Deletes one still-queued message (no-op once it actually flushed). */
  cancelQueued: (id: string) => Promise<void>;
  /** Re-runs status resolution (used after the enable dialog completes). */
  refresh: () => void;
}
