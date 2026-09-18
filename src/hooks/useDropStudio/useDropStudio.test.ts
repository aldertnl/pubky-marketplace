import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { readOwnDropIndex } from './drop-index';
import { buildDropRecord, useDropStudio } from './useDropStudio';
import { type DropStudioData, dropStudioSchema } from './useDropStudio.types';

const SELLER = vi.hoisted(() => 'y'.repeat(52));

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

const listingsFixture = vi.hoisted(() => [
  {
    id: `${'y'.repeat(52)}:item1`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item1',
    record: {
      title: 'Numbered print',
      media: [
        {
          id: 'media1',
          type: 'image',
          url: `pubky://${'y'.repeat(52)}/pub/pubky.app/marketplace/v1/media/media1`,
        },
      ],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 4_500,
    sync_status: 'synced',
    updated_at: 0,
  },
]);

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => listingsFixture,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'y'.repeat(52) }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingProjection: vi.fn(),
    ensureListingRegistered: vi.fn(),
    syncListingRegistration: vi.fn(),
    publishDrop: vi.fn(),
    syncDropRegistration: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const validFormData: DropStudioData = {
  title: 'Winter capsule',
  description: 'One hundred numbered pieces.',
  listingIds: ['item1'],
  startsAtLocal: '2099-01-01T10:00',
  endsAtLocal: '2099-01-02T10:00',
  totalQuantity: '100',
  perBuyerLimit: '2',
  stockDisplay: 'exact',
};

async function fillValidForm(form: ReturnType<typeof useDropStudio>['form']) {
  await act(async () => {
    for (const [name, value] of Object.entries(validFormData)) {
      form.setValue(name as keyof DropStudioData, value as never, { shouldValidate: true });
    }
  });
}

describe('dropStudioSchema — composer validation mirrors the record contract', () => {
  const base = validFormData;

  it('accepts a complete, in-bounds drop', () => {
    expect(dropStudioSchema.safeParse(base).success).toBe(true);
  });

  it('requires a title, a launch time, and at least one listing', () => {
    const result = dropStudioSchema.safeParse({ ...base, title: '  ', startsAtLocal: '', listingIds: [] });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map(({ path }) => path.join('.'));
    expect(paths).toContain('title');
    expect(paths).toContain('startsAtLocal');
    expect(paths).toContain('listingIds');
  });

  it('rejects a per-buyer limit above the total quantity', () => {
    const result = dropStudioSchema.safeParse({ ...base, totalQuantity: '5', perBuyerLimit: '6' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]?.message).toBe('The per-buyer limit cannot exceed the total quantity.');
  });

  it('rejects an end time at or before the launch time', () => {
    const result = dropStudioSchema.safeParse({ ...base, endsAtLocal: base.startsAtLocal });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]?.message).toBe('The end time must be after the launch time.');
  });

  it('rejects out-of-contract caps with plain-language bounds', () => {
    const tooMany = dropStudioSchema.safeParse({ ...base, totalQuantity: '1000001' });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error!.issues[0]?.message).toBe('Total quantity can be at most 1,000,000.');

    const tooGreedy = dropStudioSchema.safeParse({ ...base, perBuyerLimit: '101' });
    expect(tooGreedy.success).toBe(false);
    expect(tooGreedy.error!.issues.map(({ message }) => message)).toContain('Per-buyer limit can be at most 100.');
  });

  it('accepts an empty end time — the drop runs until sell-out or cancel', () => {
    expect(dropStudioSchema.safeParse({ ...base, endsAtLocal: '' }).success).toBe(true);
  });
});

describe('buildDropRecord', () => {
  it('builds a contract-valid record with the listing\u2019s first image as teaser media', () => {
    const result = buildDropRecord(SELLER, validFormData, listingsFixture as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toMatchObject({
      recordType: 'drop',
      ownerPubky: SELLER,
      revision: 1,
      format: 'fcfs',
      listingIds: ['item1'],
      totalQuantity: 100,
      perBuyerLimit: 2,
      stockDisplay: 'exact',
      media: [`pubky://${SELLER}/pub/pubky.app/marketplace/v1/media/media1`],
    });
    expect(result.record.startsAt).toBe(new Date('2099-01-01T10:00').toISOString());
    expect(result.record.endsAt).toBe(new Date('2099-01-02T10:00').toISOString());
    expect(result.record.dropId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('omits endsAt entirely when the seller sets no end', () => {
    const result = buildDropRecord(SELLER, { ...validFormData, endsAtLocal: '' }, listingsFixture as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('endsAt' in result.record).toBe(false);
  });

  it('maps contract violations to readable per-field messages', () => {
    const result = buildDropRecord(
      SELLER,
      { ...validFormData, totalQuantity: '1', perBuyerLimit: '5' },
      listingsFixture as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((message) => message.startsWith('perBuyerLimit:'))).toBe(true);
  });
});

describe('useDropStudio — two-truth publish state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: `listing:${SELLER}_item1`,
      serverRevision: 1,
    } as never);
    vi.mocked(CommerceController.publishDrop).mockResolvedValue(undefined as never);
    vi.mocked(CommerceController.syncDropRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);
  });

  it('reports record ✓ and service ✓ separately on a clean publish, remembering the drop id', async () => {
    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });

    expect(CommerceController.publishDrop).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledTimes(1);
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'ok' });
    expect(result.current.publishedDropId).not.toBeNull();
    expect(readOwnDropIndex(SELLER)).toEqual([result.current.publishedDropId]);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledWith(SELLER, result.current.publishedDropId);
  });

  it('record ok + sync failed → retry affordance re-runs ONLY the sync', async () => {
    vi.mocked(CommerceController.syncDropRegistration).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The homeserver fetch failed.' },
    } as never);

    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'failed' });
    // The record is a fact on the homeserver, so the id is already indexed.
    expect(readOwnDropIndex(SELLER)).toHaveLength(1);

    await act(async () => {
      await result.current.retrySync();
    });
    expect(CommerceController.publishDrop).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncDropRegistration).toHaveBeenCalledTimes(2);
    expect(result.current.publishStatus).toEqual({ record: 'ok', sync: 'ok' });
  });

  it('record PUT failure never attempts the sync and never indexes the id', async () => {
    vi.mocked(CommerceController.publishDrop).mockRejectedValue(
      Object.assign(new Error('The homeserver refused the record.'), { name: 'AppError' }),
    );

    const { result } = renderHook(() => useDropStudio());
    await fillValidForm(result.current.form);

    await act(async () => {
      await result.current.publish();
    });

    expect(result.current.publishStatus).toEqual({ record: 'failed', sync: 'idle' });
    expect(result.current.publishedDropId).toBeNull();
    expect(result.current.publishErrors).toEqual(['The homeserver refused the record.']);
    expect(CommerceController.syncDropRegistration).not.toHaveBeenCalled();
    expect(readOwnDropIndex(SELLER)).toEqual([]);
  });

  it('an invalid form never reaches the controller', async () => {
    const { result } = renderHook(() => useDropStudio());

    await act(async () => {
      await result.current.publish();
    });

    expect(CommerceController.publishDrop).not.toHaveBeenCalled();
    expect(result.current.publishStatus).toEqual({ record: 'idle', sync: 'idle' });
  });

  it('checks registration for newly selected listings and heals through the register affordance', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockResolvedValueOnce(null) // selection check → unregistered
      .mockResolvedValueOnce(null) // after ensureListingRegistered → still missing
      .mockResolvedValueOnce({ aggregateId: `listing:${SELLER}_item1`, serverRevision: 1 } as never);
    vi.mocked(CommerceController.ensureListingRegistered).mockResolvedValue(undefined as never);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({ ok: true, revision: 1 } as never);

    const { result } = renderHook(() => useDropStudio());
    await act(async () => {
      result.current.form.setValue('listingIds', ['item1'], { shouldValidate: true });
    });
    await waitFor(() => expect(result.current.registration.item1).toBe('unregistered'));

    await act(async () => {
      await result.current.registerListing('item1');
    });

    expect(CommerceController.ensureListingRegistered).toHaveBeenCalledTimes(1);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledWith(SELLER, 'item1');
    expect(result.current.registration.item1).toBe('registered');
  });
});
