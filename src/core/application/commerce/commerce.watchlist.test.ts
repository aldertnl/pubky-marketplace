import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { capabilitiesGrantWrite } from '@/services/homeserver/homeserver.utils';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { CommerceApplication } from './commerce';

const OWNER = 'o'.repeat(52);
const SELLER = 's'.repeat(52);
const WATCHLIST_URL = `pubky://${OWNER}/priv/pubky.app/marketplace/v1/watchlist.json`;

const httpError = (statusCode: number) =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.BAD_REQUEST,
    message: `HTTP ${statusCode}`,
    service: ErrorService.Homeserver,
    operation: 'test',
    context: { statusCode },
  });

const notFoundError = () =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.NOT_FOUND,
    message: 'HTTP 404',
    service: ErrorService.Homeserver,
    operation: 'test',
    context: { statusCode: 404 },
  });

describe('capabilitiesGrantWrite (session-fact capability gating)', () => {
  it('grants /priv writes for the widened app grant and for root sessions', () => {
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw', '/priv/pubky.app/:rw'], '/priv/pubky.app/')).toBe(true);
    expect(capabilitiesGrantWrite(['/:rw'], '/priv/pubky.app/')).toBe(true);
  });

  it('refuses /priv writes for the legacy public-only grant', () => {
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw', '/pub/paykit/:rw'], '/priv/pubky.app/')).toBe(false);
  });

  it('refuses read-only scopes and empty capability lists', () => {
    expect(capabilitiesGrantWrite(['/priv/pubky.app/:r'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite([], '/priv/pubky.app/')).toBe(false);
  });

  it('does not let a sibling scope leak across directories', () => {
    expect(capabilitiesGrantWrite(['/priv/other.app/:rw'], '/priv/pubky.app/')).toBe(false);
    expect(capabilitiesGrantWrite(['/pub/pubky.app/:rw'], '/pub/pubky.application/')).toBe(false);
  });
});

describe('CommerceApplication.syncWatchlist capability gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips without touching the network when no session exists', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns needs_reauth from session facts alone (no probing) when the grant lacks /priv', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('needs_reauth');
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('flips to needs_reauth when the actual write is refused with 403', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([
      { id: `${OWNER}|${SELLER}:boots_01`, owner_id: OWNER, listing_id: `${SELLER}:boots_01`, created_at: 100 },
    ]);
    vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([]);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(httpError(403));

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('needs_reauth');
    expect(put).toHaveBeenCalledOnce();
  });

  it('pulls, merges remote-only watches into Dexie, and pushes nothing when the merge equals remote', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({
      schemaVersion: 1,
      recordType: 'watchlist',
      ownerPubky: OWNER,
      revision: 2,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      items: [{ listingOwnerPubky: SELLER, listingId: 'boots_01', watchedAtMs: 100 }],
      tombstones: [],
    });
    vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([]);
    vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([]);
    const apply = vi.spyOn(LocalCommerceService, 'applyWatchlistState').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
    expect(apply).toHaveBeenCalledWith(OWNER, new Map([[`${SELLER}:boots_01`, 100]]), new Map());
    expect(put).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(`watchlist|${OWNER}`);
  });

  it('pushes the merged document (revision bumped, tombstone carried) when local changed', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({
      schemaVersion: 1,
      recordType: 'watchlist',
      ownerPubky: OWNER,
      revision: 2,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      items: [{ listingOwnerPubky: SELLER, listingId: 'boots_01', watchedAtMs: 100 }],
      tombstones: [],
    });
    // Local: boots_01 was unwatched AFTER the remote watch, and boots_02 is new.
    vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([
      { id: `${OWNER}|${SELLER}:boots_02`, owner_id: OWNER, listing_id: `${SELLER}:boots_02`, created_at: 300 },
    ]);
    vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([
      { id: `${OWNER}|${SELLER}:boots_01`, owner_id: OWNER, listing_id: `${SELLER}:boots_01`, removed_at: 200 },
    ]);
    const apply = vi.spyOn(LocalCommerceService, 'applyWatchlistState').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
    // The merge changed nothing locally (local already is the merged state).
    expect(apply).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      WATCHLIST_URL,
      expect.objectContaining({
        recordType: 'watchlist',
        revision: 3,
        createdAt: '2025-01-01T00:00:00.000Z',
        items: [{ listingOwnerPubky: SELLER, listingId: 'boots_02', watchedAtMs: 300 }],
        tombstones: [{ listingOwnerPubky: SELLER, listingId: 'boots_01', removedAtMs: 200 }],
      }),
    );
  });

  it('publishes nothing when there is no remote document and nothing local to sync', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(LocalCommerceService, 'getFavorites').mockResolvedValue([]);
    vi.spyOn(LocalCommerceService, 'getWatchTombstones').mockResolvedValue([]);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('synced');
    expect(put).not.toHaveBeenCalled();
  });

  it('reports error (outbox stays pending) on a non-auth failure', async () => {
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(httpError(500));
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob');

    expect(await CommerceApplication.syncWatchlist(OWNER)).toBe('error');
    expect(complete).not.toHaveBeenCalled();
  });
});
