import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceChatMessage } from '@/libs/commerce/messaging-contracts';
import { MARKETPLACE_CHAT_MESSAGE_KIND } from '@/libs/commerce/messaging-contracts';
import { PUBKY_APP_DM_KIND, type PubkyAppDmMessage } from '@/libs/messaging/dm-contracts';
import { CommerceMessagingConversationModel, CommerceMessagingOutboxModel } from '@/models/messaging/messaging.models';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { type MessagingLinkState, PaykitMessagingService } from '@/services/paykit/paykit-messaging';
import { MessagingApplication } from './messaging';

const OWNER = 'a'.repeat(52);
const OTHER_OWNER = 'b'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const CONVERSATION_ID = `conversation:${COUNTERPARTY}_${OWNER}_L1`;
const LISTING_REF = `listing:${COUNTERPARTY}:L1`;

const READY: MessagingLinkState = { status: 'ready' };
const HANDSHAKING: MessagingLinkState = { status: 'handshaking', role: 'initiator' };

function chatInput(body: string) {
  return { conversationId: CONVERSATION_ID, listingRef: LISTING_REF, body };
}

function chatMessage(body: string, eventId = crypto.randomUUID()): MarketplaceChatMessage {
  return {
    version: 1,
    kind: MARKETPLACE_CHAT_MESSAGE_KIND,
    event_id: eventId,
    conversation_id: CONVERSATION_ID,
    listing_ref: LISTING_REF,
    sent_at: 1_787_565_600_000,
    body,
  };
}

function dmMessage(body: string, eventId = crypto.randomUUID()): PubkyAppDmMessage {
  return { version: 1, kind: PUBKY_APP_DM_KIND, event_id: eventId, sent_at: 1_787_565_600_000, body };
}

function mockLinkState(state: MessagingLinkState) {
  return vi.spyOn(PaykitMessagingService, 'ensureLink').mockResolvedValue(state);
}

function mockChatSend() {
  return vi
    .spyOn(PaykitMessagingService, 'sendChatMessage')
    .mockImplementation(async (_owner, _counterparty, input) => chatMessage(input.body, input.eventId));
}

function mockDmSend() {
  return vi
    .spyOn(PaykitMessagingService, 'sendDmMessage')
    .mockImplementation(async (_owner, _counterparty, input) => dmMessage(input.body, input.eventId));
}

describe('MessagingApplication queued-message outbox', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([CommerceMessagingOutboxModel.clear(), CommerceMessagingConversationModel.clear()]);
  });

  it('queues the message device-locally while the link is still handshaking (nothing is sent)', async () => {
    mockLinkState(HANDSHAKING);
    const sendSpy = mockChatSend();

    const outcome = await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('hold this'));

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error('unreachable');
    expect(outcome.queued).toMatchObject({
      owner_pubky: OWNER,
      counterparty_pubky: COUNTERPARTY,
      kind: 'chat',
      conversation_id: CONVERSATION_ID,
      listing_ref: LISTING_REF,
      body: 'hold this',
      attempts: 0,
      last_error: null,
    });
    expect(sendSpy).not.toHaveBeenCalled();
    const rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows).toHaveLength(1);
  });

  it('rejects an oversized body at queue time with the same error a live send throws', async () => {
    mockLinkState(HANDSHAKING);
    const sendSpy = mockChatSend();

    await expect(
      MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('x'.repeat(2000))),
    ).rejects.toThrow(/Message is too long/);

    expect(sendSpy).not.toHaveBeenCalled();
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('sends directly — no outbox row — when the link is ready', async () => {
    mockLinkState(READY);
    const sendSpy = mockChatSend();

    const outcome = await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('live send'));

    expect(outcome.delivered).toBe(true);
    if (!outcome.delivered) throw new Error('unreachable');
    expect(outcome.message.body).toBe('live send');
    expect(sendSpy).toHaveBeenCalledOnce();
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('queues DM sends while pending and flushes them through the real DM send method', async () => {
    mockLinkState(HANDSHAKING);
    const dmSpy = mockDmSend();

    const outcome = await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'dm in waiting');
    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error('unreachable');
    expect(outcome.queued).toMatchObject({ kind: 'dm', conversation_id: null, listing_ref: null });

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);
    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(dmSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY, { body: 'dm in waiting', eventId: outcome.queued.id });
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('flushes queued rows in queue order and deletes each only after its send succeeded', async () => {
    mockLinkState(HANDSHAKING);
    const queued: string[] = [];
    for (const body of ['first', 'second', 'third']) {
      const outcome = await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput(body));
      if (outcome.delivered) throw new Error('unreachable');
      queued.push(outcome.queued.id);
    }
    const sendSpy = mockChatSend();

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);

    expect(result).toEqual({ delivered: 3, remaining: 0 });
    expect(sendSpy.mock.calls.map(([, , input]) => input.body)).toEqual(['first', 'second', 'third']);
    // The queue-time UUID rode along as the envelope event id (idempotent replay).
    expect(sendSpy.mock.calls.map(([, , input]) => input.eventId)).toEqual(queued);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('stops at the first failed send, records the error, and a later flush resumes from that row', async () => {
    mockLinkState(HANDSHAKING);
    for (const body of ['first', 'second', 'third']) {
      await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput(body));
    }
    const sendSpy = vi
      .spyOn(PaykitMessagingService, 'sendChatMessage')
      .mockImplementationOnce(async (_owner, _counterparty, input) => chatMessage(input.body, input.eventId))
      .mockRejectedValueOnce(new Error('homeserver write failed'));

    const firstPass = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);

    expect(firstPass).toEqual({ delivered: 1, remaining: 2 });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const remaining = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(remaining.map(({ body }) => body)).toEqual(['second', 'third']);
    expect(remaining[0]).toMatchObject({ attempts: 1, last_error: 'homeserver write failed' });
    expect(remaining[0].last_attempt_at).not.toBeNull();
    // The row behind the failure was never attempted — order is preserved.
    expect(remaining[1]).toMatchObject({ attempts: 0, last_error: null });

    mockChatSend();
    const secondPass = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);
    expect(secondPass).toEqual({ delivered: 2, remaining: 0 });
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('two concurrent flushes share one pass — every message is sent exactly once', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('only once'));
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendSpy = vi
      .spyOn(PaykitMessagingService, 'sendChatMessage')
      .mockImplementation(async (_owner, _counterparty, input) => {
        await gate;
        return chatMessage(input.body, input.eventId);
      });

    const firstFlush = MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);
    const secondFlush = MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);
    releaseSend();
    const [first, second] = await Promise.all([firstFlush, secondFlush]);

    expect(first).toEqual({ delivered: 1, remaining: 0 });
    expect(second).toEqual({ delivered: 1, remaining: 0 });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('cancelQueuedMessage removes a still-queued row', async () => {
    mockLinkState(HANDSHAKING);
    const outcome = await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('changed my mind'));
    if (outcome.delivered) throw new Error('unreachable');

    await MessagingApplication.cancelQueuedMessage(OWNER, outcome.queued.id);

    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it("one owner's flush never touches another owner's rows toward the same counterparty", async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('owner A message'));
    await MessagingApplication.sendOrQueueDmMessage(OTHER_OWNER, COUNTERPARTY, 'owner B message');
    const chatSpy = mockChatSend();
    const dmSpy = mockDmSend();

    const result = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY);

    expect(result).toEqual({ delivered: 1, remaining: 0 });
    expect(chatSpy).toHaveBeenCalledOnce();
    expect(chatSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY, expect.objectContaining({ body: 'owner A message' }));
    expect(dmSpy).not.toHaveBeenCalled();
    const otherRows = await LocalMessagingService.getQueuedMessages(OTHER_OWNER, COUNTERPARTY);
    expect(otherRows.map(({ body }) => body)).toEqual(['owner B message']);
  });

  it('queues behind older stuck rows even when the link is ready, so thread order never lies', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('stuck first'));
    mockLinkState(READY);
    vi.spyOn(PaykitMessagingService, 'sendChatMessage').mockRejectedValue(new Error('still failing'));

    const outcome = await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('composed later'));

    expect(outcome.delivered).toBe(false);
    const rows = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
    expect(rows.map(({ body }) => body)).toEqual(['stuck first', 'composed later']);
  });

  it('pollConversation flushes queued rows the moment the link reports ready', async () => {
    mockLinkState(READY);
    vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);
    const flushSpy = vi.spyOn(MessagingApplication, 'flushOutbox');
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('poll delivers me'));
    mockLinkState(READY);
    mockChatSend();

    const { state, flushed } = await MessagingApplication.pollConversation(OWNER, COUNTERPARTY);

    expect(state).toEqual(READY);
    expect(flushed).toBe(1);
    expect(flushSpy).toHaveBeenCalledWith(OWNER, COUNTERPARTY);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('pollConversation does not flush while the handshake is still pending', async () => {
    mockLinkState(HANDSHAKING);
    const flushSpy = vi.spyOn(MessagingApplication, 'flushOutbox');

    const { flushed } = await MessagingApplication.pollConversation(OWNER, COUNTERPARTY);

    expect(flushed).toBe(0);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('opening a conversation (listing or DM) flushes when it finds the link already ready', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('open delivers me'));
    mockLinkState(READY);
    mockChatSend();
    await MessagingApplication.openConversation(OWNER, COUNTERPARTY, CONVERSATION_ID, LISTING_REF);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);

    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'dm open delivers me');
    mockLinkState(READY);
    mockDmSend();
    await MessagingApplication.openDmConversation(OWNER, COUNTERPARTY);
    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('syncCounterparties flushes per counterparty that reaches ready, before receiving', async () => {
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'sync delivers me');
    vi.spyOn(PaykitMessagingService, 'probeCounterparty').mockResolvedValue(READY);
    vi.spyOn(PaykitMessagingService, 'receiveMessages').mockResolvedValue([]);
    mockDmSend();

    await MessagingApplication.syncCounterparties(OWNER, [COUNTERPARTY]);

    await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(0);
  });

  it('getConversations exposes the newest queued row so previews can say "Queued"', async () => {
    await LocalMessagingService.touchConversation({
      owner_id: OWNER,
      conversation_id: CONVERSATION_ID,
      kind: 'listing',
      listing_ref: LISTING_REF,
      counterparty_pubky: COUNTERPARTY,
      last_message_at: null,
      updated_at: 100,
    });
    mockLinkState(HANDSHAKING);
    await MessagingApplication.sendOrQueueMessage(OWNER, COUNTERPARTY, chatInput('newest and queued'));

    const [summary] = await MessagingApplication.getConversations(OWNER);

    expect(summary.lastMessage).toBeNull();
    expect(summary.lastQueued).toMatchObject({ body: 'newest and queued', kind: 'chat' });
  });
});
