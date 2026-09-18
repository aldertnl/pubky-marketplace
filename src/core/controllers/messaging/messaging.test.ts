import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { MessagingApplication } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { getCommerceAdapterMode } from '@/config/commerce';
import type { Pubky } from '@/models/models.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { MessagingController } from './messaging';

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getCommerceAdapterMode: vi.fn(() => 'unavailable'),
}));

const OWNER = 'o'.repeat(52) as Pubky;
const FOLLOWED = 'f'.repeat(52);
const FOLLOWER = 'g'.repeat(52);
const MUTUAL = 'm'.repeat(52);
const SELLER = 's'.repeat(52);

const commerceModeMock = vi.mocked(getCommerceAdapterMode);

function mockAuth(pubky: Pubky | null) {
  vi.spyOn(useAuthStore, 'getState').mockReturnValue({
    ...useAuthStore.getState(),
    currentUserPubky: pubky,
    selectCurrentUserPubky: () => {
      if (!pubky) throw new Error('No current user');
      return pubky;
    },
  });
}

function mockFollowGraph(perReach: Record<'following' | 'followers', string[] | Error>) {
  return vi.spyOn(UserStreamApplication, 'getOrFetchStreamSlice').mockImplementation(async ({ streamId }) => {
    const reach = String(streamId).endsWith(':following') ? 'following' : 'followers';
    const outcome = perReach[reach];
    if (outcome instanceof Error) throw outcome;
    return { nextPageIds: outcome as Pubky[], cacheMissUserIds: [], skip: undefined, isExhausted: false };
  });
}

describe('MessagingController inbox naming set', () => {
  let syncCounterpartiesSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(OWNER);
    commerceModeMock.mockReturnValue('unavailable');
    syncCounterpartiesSpy = vi.spyOn(MessagingApplication, 'syncCounterparties').mockResolvedValue();
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(0);
  });

  it('names follows and followers, deduped, with the owner excluded', async () => {
    mockFollowGraph({ following: [FOLLOWED, MUTUAL, String(OWNER)], followers: [FOLLOWER, MUTUAL] });

    await MessagingController.syncInbox();

    expect(syncCounterpartiesSpy).toHaveBeenCalledOnce();
    const [owner, candidates] = syncCounterpartiesSpy.mock.calls[0];
    expect(owner).toBe(OWNER);
    expect([...(candidates as string[])].sort()).toEqual([FOLLOWED, FOLLOWER, MUTUAL].sort());
  });

  it('skips marketplace sources entirely when no durable commerce mode is configured', async () => {
    const ordersSpy = vi.spyOn(CommerceApplication, 'getMarketplaceOrders');
    const offersSpy = vi.spyOn(CommerceApplication, 'getMarketplaceOffers');
    mockFollowGraph({ following: [FOLLOWED], followers: [] });

    await MessagingController.syncInbox();

    expect(ordersSpy).not.toHaveBeenCalled();
    expect(offersSpy).not.toHaveBeenCalled();
    expect(syncCounterpartiesSpy).toHaveBeenCalledWith(OWNER, [FOLLOWED]);
  });

  it('adds marketplace order/offer participants when the durable service is configured', async () => {
    commerceModeMock.mockReturnValue('transaction-service');
    vi.spyOn(CommerceApplication, 'getMarketplaceOrders').mockResolvedValue([
      { buyerPubky: OWNER, sellerPubky: SELLER } as Awaited<
        ReturnType<typeof CommerceApplication.getMarketplaceOrders>
      >[number],
    ]);
    vi.spyOn(CommerceApplication, 'getMarketplaceOffers').mockResolvedValue([]);
    mockFollowGraph({ following: [FOLLOWED], followers: [] });

    await MessagingController.syncInbox();

    const [, candidates] = syncCounterpartiesSpy.mock.calls[0];
    expect([...(candidates as string[])].sort()).toEqual([FOLLOWED, SELLER].sort());
  });

  it('degrades to the remaining sources when one follow-graph read fails', async () => {
    mockFollowGraph({ following: new Error('nexus unreachable'), followers: [FOLLOWER] });

    await MessagingController.syncInbox();

    expect(syncCounterpartiesSpy).toHaveBeenCalledWith(OWNER, [FOLLOWER]);
  });

  it('refreshes the device-local unread fact into the store after the pass', async () => {
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(3);
    mockFollowGraph({ following: [], followers: [] });

    await MessagingController.syncInbox();

    expect(useMessagingStore.getState().unreadConversations).toBe(3);
  });
});

describe('MessagingController unread and read-state facts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMessagingStore.getState().setUnreadConversations(0);
  });

  it('reports 0 unread and clears the store when signed out', async () => {
    mockAuth(null);
    useMessagingStore.getState().setUnreadConversations(5);
    const countSpy = vi.spyOn(MessagingApplication, 'getUnreadConversationCount');

    await expect(MessagingController.refreshUnreadCount()).resolves.toBe(0);

    expect(countSpy).not.toHaveBeenCalled();
    expect(useMessagingStore.getState().unreadConversations).toBe(0);
  });

  it('marks a conversation read and refreshes the unread fact', async () => {
    mockAuth(OWNER);
    const markSpy = vi.spyOn(MessagingApplication, 'markConversationRead').mockResolvedValue();
    vi.spyOn(MessagingApplication, 'getUnreadConversationCount').mockResolvedValue(1);

    await MessagingController.markConversationRead(`dm:${FOLLOWED}`);

    expect(markSpy).toHaveBeenCalledWith(OWNER, `dm:${FOLLOWED}`);
    expect(useMessagingStore.getState().unreadConversations).toBe(1);
  });

  // Regression: conversation ids contain a colon, which the commerce entityId
  // normalizer rejects — history reads must accept BOTH local id shapes.
  it('accepts both conversation id shapes and rejects anything else', async () => {
    mockAuth(OWNER);
    const getSpy = vi.spyOn(MessagingApplication, 'getConversationMessages').mockResolvedValue([]);
    const marketplaceId = `conversation:${SELLER}_${OWNER}_0033GVVN22HJ0FYQGZZS8R2BFC`;

    await expect(MessagingController.getConversationMessages(marketplaceId)).resolves.toEqual([]);
    await expect(MessagingController.getConversationMessages(`dm:${FOLLOWED}`)).resolves.toEqual([]);
    expect(getSpy).toHaveBeenCalledWith(OWNER, marketplaceId);
    expect(getSpy).toHaveBeenCalledWith(OWNER, `dm:${FOLLOWED}`);

    await expect(MessagingController.getConversationMessages('listing:not-a-conversation')).rejects.toThrow(
      /conversation id/,
    );
    await expect(MessagingController.getConversationMessages('dm:short')).rejects.toThrow(/conversation id/);
  });
});
