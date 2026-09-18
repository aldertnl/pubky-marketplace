import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingController } from '@/controllers/messaging/messaging';
import type {
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
} from '@/models/messaging/messaging.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useDmConversation } from './useDmConversation';

const OWNER = 'o'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const CONVERSATION_ID = `dm:${COUNTERPARTY}`;

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000 };
});

vi.mock('@/stores/messaging/messaging.store', () => ({
  useMessagingStore: (selector: (state: { enabledPubky: string | null }) => unknown) =>
    selector({ enabledPubky: null }),
}));

vi.mock('@/controllers/messaging/messaging', () => ({
  MessagingController: {
    getConversationMessages: vi.fn(),
    getQueuedConversationMessages: vi.fn(),
    markConversationRead: vi.fn(),
    getMessagingStatus: vi.fn(),
    openDmConversation: vi.fn(),
    pollDmConversation: vi.fn(),
    sendOrQueueDmMessage: vi.fn(),
    cancelQueuedMessage: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

function historyRow(id: string, body: string, recordedAt: number): CommerceMessagingMessageModelSchema {
  return {
    id: `${OWNER}:${id}`,
    owner_id: OWNER,
    conversation_id: CONVERSATION_ID,
    listing_ref: null,
    counterparty_pubky: COUNTERPARTY,
    direction: 'sent',
    body,
    sent_at: 1_756_627_200_000,
    recorded_at: recordedAt,
  };
}

function queuedRow(body: string, queuedAt: number): CommerceMessagingOutboxModelSchema {
  return {
    id: crypto.randomUUID(),
    owner_pubky: OWNER,
    counterparty_pubky: COUNTERPARTY,
    kind: 'dm',
    conversation_id: null,
    listing_ref: null,
    body,
    queued_at: queuedAt,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
  };
}

describe('useDmConversation queued-message behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MessagingController.getConversationMessages).mockResolvedValue([]);
    vi.mocked(MessagingController.getQueuedConversationMessages).mockResolvedValue([]);
    vi.mocked(MessagingController.markConversationRead).mockResolvedValue();
    vi.mocked(MessagingController.getMessagingStatus).mockResolvedValue({
      sessionActive: true,
      receiverProvisioned: true,
    });
    vi.mocked(MessagingController.openDmConversation).mockResolvedValue({
      state: { status: 'handshaking', role: 'initiator' },
      counterpartyPubky: COUNTERPARTY,
    });
    vi.mocked(MessagingController.cancelQueuedMessage).mockResolvedValue();
  });

  it('merges queued rows after the sent history, each honestly discriminated', async () => {
    vi.mocked(MessagingController.getConversationMessages).mockResolvedValue([
      historyRow('m1', 'delivered earlier', 10),
    ]);
    vi.mocked(MessagingController.getQueuedConversationMessages).mockResolvedValue([queuedRow('still waiting', 20)]);

    const { result } = renderHook(() => useDmConversation(COUNTERPARTY, true));

    await waitFor(() => expect(result.current.status).toBe('handshaking-initiator'));
    expect(result.current.thread).toHaveLength(2);
    expect(result.current.thread[0]).toMatchObject({
      deliveryState: 'sent',
      message: { body: 'delivered earlier' },
    });
    expect(result.current.thread[1]).toMatchObject({ deliveryState: 'queued', queued: { body: 'still waiting' } });
  });

  it('send reports "queued" while the handshake is pending, and toasts only the first time', async () => {
    const row = queuedRow('queued send', 30);
    vi.mocked(MessagingController.sendOrQueueDmMessage).mockResolvedValue({ delivered: false, queued: row });

    const { result } = renderHook(() => useDmConversation(COUNTERPARTY, true));
    await waitFor(() => expect(result.current.status).toBe('handshaking-initiator'));

    act(() => result.current.setDraft('queued send'));
    let outcome: string = '';
    await act(async () => {
      outcome = await result.current.send();
    });
    expect(outcome).toBe('queued');
    expect(MessagingController.sendOrQueueDmMessage).toHaveBeenCalledWith(COUNTERPARTY, 'queued send');
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({ description: 'Queued — will deliver automatically' });
    // The draft cleared — the message is safely queued, nothing was lost.
    expect(result.current.draft).toBe('');

    act(() => result.current.setDraft('second queued send'));
    await act(async () => {
      await result.current.send();
    });
    expect(toast).toHaveBeenCalledOnce();
  });

  it('send reports "delivered" when the link was ready and the binding actually sent it', async () => {
    vi.mocked(MessagingController.sendOrQueueDmMessage).mockResolvedValue({
      delivered: true,
      message: {
        version: 1,
        kind: 'pubky_app.dm.v0',
        event_id: crypto.randomUUID(),
        sent_at: 1_756_627_200_000,
        body: 'live',
      },
    });

    const { result } = renderHook(() => useDmConversation(COUNTERPARTY, true));
    await waitFor(() => expect(result.current.status).toBe('handshaking-initiator'));

    act(() => result.current.setDraft('live'));
    let outcome: string = '';
    await act(async () => {
      outcome = await result.current.send();
    });
    expect(outcome).toBe('delivered');
    expect(toast).not.toHaveBeenCalled();
  });

  it('cancelQueued deletes the row and reloads the merged thread', async () => {
    const row = queuedRow('cancel me', 40);
    vi.mocked(MessagingController.getQueuedConversationMessages).mockResolvedValue([row]);

    const { result } = renderHook(() => useDmConversation(COUNTERPARTY, true));
    await waitFor(() => expect(result.current.thread).toHaveLength(1));

    vi.mocked(MessagingController.getQueuedConversationMessages).mockResolvedValue([]);
    await act(async () => {
      await result.current.cancelQueued(row.id);
    });

    expect(MessagingController.cancelQueuedMessage).toHaveBeenCalledWith(row.id);
    expect(result.current.thread).toHaveLength(0);
  });
});
