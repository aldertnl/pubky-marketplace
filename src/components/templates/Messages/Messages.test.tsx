// Intentional import order — mock factories rely on stable aliases.

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import type { UseEncryptedConversationReturn } from '@/hooks/useEncryptedConversation/useEncryptedConversation.types';
import { Messages } from './Messages';
import { MessagesConversation } from './MessagesConversation';

const OWNER = 'o'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);

const inboxView = vi.hoisted(() => ({
  conversations: [] as unknown[],
}));

const dmView = vi.hoisted(() => ({
  status: 'ready' as string,
  thread: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/messages',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: 'o'.repeat(52) }),
}));

vi.mock('@/hooks/useEncryptedInbox/useEncryptedInbox', () => ({
  useEncryptedInbox: () => ({
    status: 'ready',
    conversations: inboxView.conversations,
    receiverProvisioned: true,
    errorMessage: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useDmConversation/useDmConversation', () => ({
  useDmConversation: (): UseEncryptedConversationReturn => ({
    status: dmView.status as UseEncryptedConversationReturn['status'],
    errorMessage: null,
    thread: dmView.thread as UseEncryptedConversationReturn['thread'],
    receiverProvisioned: true,
    draft: '',
    setDraft: vi.fn(),
    bodyBudgetBytes: 862,
    draftBytes: 0,
    isSending: false,
    sendError: null,
    send: vi.fn(async () => 'queued' as const),
    cancelQueued: vi.fn(async () => {}),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUserDetails/useUserDetails', () => ({
  useUserDetails: () => ({ userDetails: { name: 'Satoshi Nakamoto' }, isLoading: false }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

function dmSummary(overrides: Partial<MessagingConversationSummary>): MessagingConversationSummary {
  const conversationId = `dm:${COUNTERPARTY}`;
  return {
    id: `${OWNER}:${conversationId}`,
    owner_id: OWNER,
    conversation_id: conversationId,
    kind: 'dm',
    listing_ref: null,
    counterparty_pubky: COUNTERPARTY,
    last_message_at: 100,
    last_read_at: null,
    created_at: 50,
    updated_at: 100,
    lastMessage: null,
    lastQueued: null,
    ...overrides,
  };
}

describe('Messages inbox previews', () => {
  beforeEach(() => {
    inboxView.conversations = [];
    dmView.status = 'ready';
    dmView.thread = [];
  });

  it('prefixes the preview with "Queued:" when the newest item is still queued on this device', () => {
    inboxView.conversations = [
      dmSummary({
        lastMessage: {
          id: `${OWNER}:m1`,
          owner_id: OWNER,
          conversation_id: `dm:${COUNTERPARTY}`,
          listing_ref: null,
          counterparty_pubky: COUNTERPARTY,
          direction: 'sent',
          body: 'sent a while ago',
          sent_at: 1_787_562_000_000,
          recorded_at: 100,
        },
        lastQueued: {
          id: '00000000-0000-4000-8000-000000000042',
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'dm',
          conversation_id: null,
          listing_ref: null,
          body: 'not sent yet',
          queued_at: 200,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        },
      }),
    ];

    render(<Messages />);

    expect(screen.getByText('Queued: not sent yet')).toBeInTheDocument();
  });

  it('keeps the honest "You:" preview when the newest item was actually sent', () => {
    inboxView.conversations = [
      dmSummary({
        lastMessage: {
          id: `${OWNER}:m1`,
          owner_id: OWNER,
          conversation_id: `dm:${COUNTERPARTY}`,
          listing_ref: null,
          counterparty_pubky: COUNTERPARTY,
          direction: 'sent',
          body: 'the newest message',
          sent_at: 1_787_562_000_000,
          recorded_at: 300,
        },
        lastQueued: {
          id: '00000000-0000-4000-8000-000000000043',
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'dm',
          conversation_id: null,
          listing_ref: null,
          body: 'older queued row',
          queued_at: 200,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        },
      }),
    ];

    render(<Messages />);

    expect(screen.getByText('You: the newest message')).toBeInTheDocument();
  });
});

describe('MessagesConversation pending-handshake composer', () => {
  beforeEach(() => {
    dmView.status = 'handshaking-initiator';
    dmView.thread = [];
  });

  it('keeps the composer enabled and shows the honest queue banner while waiting for the counterparty', () => {
    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Their messenger hasn't responded yet — messages you send are queued on this device and deliver automatically when it does.",
      ),
    ).toBeInTheDocument();
  });

  it('keeps the composer enabled while answering an inbound handshake', () => {
    dmView.status = 'handshaking-responder';

    render(<MessagesConversation counterpartyPubky={COUNTERPARTY} />);

    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(
      screen.getByText(
        'Still securing this conversation — messages you send are queued on this device and deliver automatically once the encrypted handshake completes.',
      ),
    ).toBeInTheDocument();
  });
});
