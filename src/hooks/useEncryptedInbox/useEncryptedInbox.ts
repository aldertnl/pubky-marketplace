'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { getCommercePollIntervalMs } from '@/config/commerce';
import { MessagingController } from '@/controllers/messaging/messaging';
import { getErrorMessage } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';

export type EncryptedInboxStatus = 'loading' | 'needs-enable' | 'ready' | 'error';

export interface UseEncryptedInboxReturn {
  status: EncryptedInboxStatus;
  /** Device-local conversation list — readable even without a live session. */
  conversations: MessagingConversationSummary[];
  /** True when a receiver key exists on this device (reconnect vs first-enable copy). */
  receiverProvisioned: boolean;
  errorMessage: string | null;
  refresh: () => void;
}

/**
 * The encrypted inbox (durable modes): lists device-local conversations and —
 * while a messaging session is live — runs the bounded sync pass that
 * advances pending handshakes, answers queued inbound handshakes from known
 * counterparties, and receives new messages. Sync runs only while this
 * surface is mounted and visible, resumes on focus, and stops on unmount; no
 * background polling.
 *
 * Local history stays readable without a session (it is on this device); the
 * `needs-enable` status only gates live sending/receiving.
 */
export function useEncryptedInbox(): UseEncryptedInboxReturn {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const enabledPubky = useMessagingStore((state) => state.enabledPubky);
  const [status, setStatus] = useState<EncryptedInboxStatus>('loading');
  const [conversations, setConversations] = useState<MessagingConversationSummary[]>([]);
  const [receiverProvisioned, setReceiverProvisioned] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!currentUserPubky) {
      setStatus('loading');
      setConversations([]);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let syncing = false;

    const loadConversations = async () => {
      const next = await MessagingController.getConversations();
      if (!cancelled) setConversations(next);
    };

    const sync = async () => {
      if (cancelled || document.hidden || syncing) return;
      syncing = true;
      try {
        const messagingStatus = await MessagingController.getMessagingStatus();
        if (cancelled) return;
        setReceiverProvisioned(messagingStatus.receiverProvisioned);
        if (!messagingStatus.sessionActive) {
          await loadConversations();
          if (!cancelled) setStatus('needs-enable');
          return;
        }
        await MessagingController.syncInbox();
        await loadConversations();
        if (!cancelled) setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        Logger.error('Encrypted inbox sync failed', { error });
        setErrorMessage(getErrorMessage(error));
        setStatus('error');
      } finally {
        syncing = false;
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void sync();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void sync();
    timer = window.setInterval(() => void sync(), getCommercePollIntervalMs());

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [currentUserPubky, enabledPubky, refreshNonce]);

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return { status, conversations, receiverProvisioned, errorMessage, refresh };
}
