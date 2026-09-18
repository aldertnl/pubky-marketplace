'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCommercePollIntervalMs } from '@/config/commerce';
import { MessagingController } from '@/controllers/messaging/messaging';
import { bodyByteSize, chatMessageBodyBudget } from '@/libs/commerce/messaging-contracts';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MessagingLinkState } from '@/services/paykit/paykit-messaging';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import type {
  ConversationThreadItem,
  EncryptedConversationStatus,
  EncryptedSendOutcome,
  UseEncryptedConversationReturn,
} from './useEncryptedConversation.types';

/**
 * Drives one encrypted listing conversation while its surface is OPEN:
 * resolves enablement, opens/advances the Encrypted Link, receives messages,
 * and sends — or, while the handshake is still pending, QUEUES the message
 * device-locally for automatic delivery (the composer is never blocked on
 * the counterparty's runtime; queued items render honestly as "Queued",
 * never as sent). Polling is bounded and abortable by construction — it runs
 * only while `active` is true AND the page is visible, resumes on focus, and
 * stops on unmount. There is no background polling.
 */
export function useEncryptedConversation(
  sellerPubky: string,
  buyerPubky: string,
  listingId: string,
  active: boolean,
): UseEncryptedConversationReturn {
  const enabledPubky = useMessagingStore((state) => state.enabledPubky);
  const [status, setStatus] = useState<EncryptedConversationStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThreadItem[]>([]);
  const [receiverProvisioned, setReceiverProvisioned] = useState(false);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // The "your message is queued" toast fires once per surface, not per send.
  const queuedToastShownRef = useRef(false);

  const conversationId = useMemo(
    () => buildMarketplaceConversationAggregateId(sellerPubky, buyerPubky, listingId),
    [sellerPubky, buyerPubky, listingId],
  );
  const listingRef = useMemo(
    () => buildMarketplaceListingAggregateId(sellerPubky, listingId),
    [sellerPubky, listingId],
  );
  const bodyBudgetBytes = useMemo(
    () => chatMessageBodyBudget(conversationId, listingRef),
    [conversationId, listingRef],
  );
  const draftBytes = useMemo(() => bodyByteSize(draft.trim()), [draft]);

  const loadThread = useCallback(async () => {
    try {
      const [history, queued] = await Promise.all([
        MessagingController.getConversationMessages(conversationId),
        MessagingController.getQueuedConversationMessages(conversationId),
      ]);
      setThread([
        ...history.map((message) => ({ deliveryState: 'sent' as const, message })),
        ...queued.map((row) => ({ deliveryState: 'queued' as const, queued: row })),
      ]);
      if (history.length > 0) {
        // The surface is open and showing these rows: advance the device-local
        // read checkpoint so the unread badge stays honest.
        await MessagingController.markConversationRead(conversationId);
      }
    } catch (error) {
      Logger.warn('Failed to load local conversation history', { error });
    }
  }, [conversationId]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let timer: number | null = null;

    const applyLinkState = (state: MessagingLinkState) => {
      if (cancelled) return;
      if (state.status === 'ready') setStatus('ready');
      else if (state.status === 'not-enrolled') setStatus('not-enrolled');
      else setStatus(state.role === 'initiator' ? 'handshaking-initiator' : 'handshaking-responder');
    };

    const poll = async () => {
      if (cancelled || document.hidden) return;
      try {
        const { state, received, flushed } = await MessagingController.pollConversation(
          sellerPubky,
          buyerPubky,
          listingId,
        );
        applyLinkState(state);
        // A flush turned queued rows into real sent history — reload so the
        // queued bubbles are replaced by their sent records.
        if (received.length > 0 || flushed > 0) await loadThread();
      } catch (error) {
        if (cancelled) return;
        Logger.error('Encrypted conversation poll failed', { error });
        setErrorMessage(getErrorMessage(error));
        setStatus('error');
      }
    };

    const begin = async () => {
      setStatus('loading');
      setErrorMessage(null);
      await loadThread();
      try {
        const messagingStatus = await MessagingController.getMessagingStatus();
        if (cancelled) return;
        setReceiverProvisioned(messagingStatus.receiverProvisioned);
        if (!messagingStatus.sessionActive) {
          setStatus('needs-enable');
          return;
        }
        const opened = await MessagingController.openConversation(sellerPubky, buyerPubky, listingId);
        applyLinkState(opened.state);
        // Opening flushes queued rows when the link is ready — show the result.
        if (opened.state.status === 'ready') await loadThread();
      } catch (error) {
        if (cancelled) return;
        Logger.error('Failed to open the encrypted conversation', { error });
        setErrorMessage(getErrorMessage(error));
        setStatus('error');
        return;
      }
      // Poll only while this surface stays open and visible; a hidden tab
      // pauses (the visibility listener resumes it on focus).
      timer = window.setInterval(() => void poll(), getCommercePollIntervalMs());
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void begin();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, enabledPubky, refreshNonce, sellerPubky, buyerPubky, listingId, loadThread]);

  const send = useCallback(async (): Promise<EncryptedSendOutcome> => {
    const body = draft.trim();
    if (!body || isSending) return 'failed';
    if (draftBytes > bodyBudgetBytes) {
      setSendError(`Message is ${draftBytes - bodyBudgetBytes} bytes over the encrypted transport limit.`);
      return 'failed';
    }
    setIsSending(true);
    setSendError(null);
    try {
      const outcome = await MessagingController.sendOrQueueMessage(sellerPubky, buyerPubky, listingId, body);
      setDraft('');
      await loadThread();
      if (!outcome.delivered && !queuedToastShownRef.current) {
        queuedToastShownRef.current = true;
        toast({ description: 'Queued — will deliver automatically' });
      }
      return outcome.delivered ? 'delivered' : 'queued';
    } catch (error) {
      Logger.error('Failed to send an encrypted message', { error });
      // The draft is kept: a failed send loses nothing the user typed.
      setSendError(getErrorMessage(error));
      return 'failed';
    } finally {
      setIsSending(false);
    }
  }, [draft, isSending, draftBytes, bodyBudgetBytes, sellerPubky, buyerPubky, listingId, loadThread]);

  const cancelQueued = useCallback(
    async (id: string) => {
      try {
        await MessagingController.cancelQueuedMessage(id);
        await loadThread();
      } catch (error) {
        Logger.warn('Failed to cancel a queued message', { error });
      }
    },
    [loadThread],
  );

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return {
    status,
    errorMessage,
    thread,
    receiverProvisioned,
    draft,
    setDraft,
    bodyBudgetBytes,
    draftBytes,
    isSending,
    sendError,
    send,
    cancelQueued,
    refresh,
  };
}
