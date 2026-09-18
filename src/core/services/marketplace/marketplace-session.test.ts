import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '@/libs/error/error';
import { Logger } from '@/libs/logger/logger';
import {
  MARKETPLACE_SESSION_STORAGE_KEY,
  MarketplaceSessionService,
  SESSION_FLOW_TIMEOUT_MS,
} from './marketplace-session';

const PUBKY = 'y'.repeat(52);
const TOKEN = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const TOKEN_C = 'C'.repeat(43);

const config = vi.hoisted(() => ({
  mode: 'transaction-service' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

const authTokenFlow = vi.hoisted(() => ({
  awaitToken: vi.fn(),
  cancelAuthFlow: vi.fn(),
}));

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: {
    generateAuthTokenFlow: () => ({
      authorizationUrl: 'pubkyauth:///?relay=http%3A%2F%2Flocalhost%2Finbox&secret=s',
      awaitToken: authTokenFlow.awaitToken,
      cancelAuthFlow: authTokenFlow.cancelAuthFlow,
    }),
  },
}));

function sessionResponse(expiresAt: string, token = TOKEN): Response {
  return new Response(JSON.stringify({ token, pubky: PUBKY, capabilities: '', expires_at: expiresAt }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

function inOneDay(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

/** Simulates a page reload: the in-memory session dies, localStorage survives. */
function dropMemoryOnly() {
  const persisted = window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
  MarketplaceSessionService.clearSession();
  if (persisted !== null) {
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, persisted);
  }
}

describe('MarketplaceSessionService', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    MarketplaceSessionService.clearSession();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs raw AuthToken bytes and stores the issued session in memory', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));

    const info = await MarketplaceSessionService.establishWithAuthToken(bytes, PUBKY);

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/auth/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }),
    );
    expect(info).toEqual({
      pubky: PUBKY,
      capabilities: '',
      expiresAt: expect.any(String),
      issuedAt: expect.any(String),
    });
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN, pubky: PUBKY });
  });

  it('never hands the bearer token to callers of the session flow', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    authTokenFlow.awaitToken.mockResolvedValueOnce({ toBytes: () => new Uint8Array([9, 9, 9]), publicKey: { z32: () => PUBKY } });

    const flow = MarketplaceSessionService.beginSessionFlow();
    const info = await flow.awaitSession();

    expect(info).not.toHaveProperty('token');
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });

  it('persists the session to localStorage only — never sessionStorage or IndexedDB', async () => {
    const sessionSetItemSpy = vi.spyOn(window.sessionStorage, 'setItem');
    const indexedDbOpenSpy = vi.spyOn(indexedDB, 'open');
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));

    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);

    const persisted = window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toMatchObject({ token: TOKEN, pubky: PUBKY });
    expect(sessionSetItemSpy).not.toHaveBeenCalled();
    expect(indexedDbOpenSpy).not.toHaveBeenCalled();
    sessionSetItemSpy.mockRestore();
    indexedDbOpenSpy.mockRestore();
  });

  it('restores a persisted session for the matching account across a simulated reload', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);

    dropMemoryOnly();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();

    const info = MarketplaceSessionService.restorePersistedSession(PUBKY);

    expect(info).toMatchObject({ pubky: PUBKY });
    expect(info).not.toHaveProperty('token');
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN, pubky: PUBKY });
  });

  it('drops a persisted session that belongs to another account', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    dropMemoryOnly();

    expect(MarketplaceSessionService.restorePersistedSession('z'.repeat(52))).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('drops a persisted session that is past the expiry margin or malformed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T13:00:00.000Z'));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    dropMemoryOnly();

    vi.setSystemTime(new Date('2026-08-20T12:59:31.000Z'));
    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, 'not json');
    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('refuses to restore outside durable modes even when a blob is persisted', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    dropMemoryOnly();
    config.mode = 'sandbox';

    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('treats a session as absent once it reaches the expiry margin, and re-establishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T13:00:00.000Z', TOKEN));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN });

    // 30s before the server-side expiry the client already refuses to use it.
    vi.setSystemTime(new Date('2026-08-20T12:59:31.000Z'));
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T14:00:00.000Z', TOKEN_B));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([2]), PUBKY);
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN_B });
  });

  it('clears the session from memory AND localStorage on demand', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).not.toBeNull();

    MarketplaceSessionService.clearSession();

    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('times out an unapproved flow with a retryable error and frees the underlying auth flow', async () => {
    vi.useFakeTimers();
    authTokenFlow.awaitToken.mockReturnValueOnce(new Promise(() => {})); // never approved

    const flow = MarketplaceSessionService.beginSessionFlow();
    const pending = flow.awaitSession();
    const outcome = expect(pending).rejects.toMatchObject({
      name: 'AppError',
      code: 'REQUEST_TIMEOUT',
      message: expect.stringContaining('expired before it was approved'),
    });

    await vi.advanceTimersByTimeAsync(SESSION_FLOW_TIMEOUT_MS);
    await outcome;
    expect(authTokenFlow.cancelAuthFlow).toHaveBeenCalled();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('does not fire the timeout once the exchange already succeeded', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    authTokenFlow.awaitToken.mockResolvedValueOnce({ toBytes: () => new Uint8Array([7]), publicKey: { z32: () => PUBKY } });

    const flow = MarketplaceSessionService.beginSessionFlow();
    const info = await flow.awaitSession();
    await vi.advanceTimersByTimeAsync(SESSION_FLOW_TIMEOUT_MS + 1_000);

    expect(info).toMatchObject({ pubky: PUBKY });
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN });
  });

  it('rejects establishment when the service refuses the auth token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'The auth token is invalid.' } }), { status: 401 }),
    );

    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_TOKEN',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('fails closed outside transaction-service mode', async () => {
    config.mode = 'sandbox';

    expect(() => MarketplaceSessionService.beginSessionFlow()).toThrowError();
    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks 401 already-used without putting the body in error context', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('The auth token has already been used.', { status: 401 }),
    );

    const error = await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY).catch(
      (caught) => caught,
    );

    expect(error).toMatchObject({ code: 'INVALID_TOKEN', context: { statusCode: 401, alreadyUsed: true } });
    expect(JSON.stringify(error)).not.toContain('already been used');
  });

  it('treats 401 already-used as success when this client already holds a bearer for the same pubky', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('The auth token has already been used.', { status: 401 }),
    );

    const info = await MarketplaceSessionService.redeemAuthTokenAfterHomeserver(
      new Uint8Array([2]),
      PUBKY,
      Date.now(),
    );

    expect(info.pubky).toBe(PUBKY);
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: TOKEN, pubky: PUBKY });
  });

  it('rejects a 401 already-used when this client holds NO bearer — never a silent success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('The auth token has already been used.', { status: 401 }),
    );

    // Lost-201 self-race without a bearer (or a third party spent the bytes):
    // the redemption must fail so the caller surfaces a marketplace reconnect
    // approval instead of believing the session exists.
    await expect(
      MarketplaceSessionService.redeemAuthTokenAfterHomeserver(new Uint8Array([2]), PUBKY, Date.now()),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN', context: { statusCode: 401, alreadyUsed: true } });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects a 401 already-used when the held bearer belongs to a DIFFERENT pubky', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('The auth token has already been used.', { status: 401 }),
    );

    const other = 'z'.repeat(52);
    await expect(
      MarketplaceSessionService.redeemAuthTokenAfterHomeserver(new Uint8Array([2]), other, Date.now()),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN', context: { statusCode: 401, alreadyUsed: true } });
  });

  it('retries a 5xx marketplace POST with the same bytes and succeeds', async () => {
    const bytes = new Uint8Array([1]);
    vi.spyOn(await import('@/libs/utils/utils'), 'sleep').mockResolvedValue(undefined);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(sessionResponse(inOneDay()));

    const info = await MarketplaceSessionService.redeemAuthTokenAfterHomeserver(bytes, PUBKY, Date.now());

    expect(info.pubky).toBe(PUBKY);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(bytes);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(bytes);
  });

  it('stops retrying after the 60s token-resolution deadline', async () => {
    vi.spyOn(await import('@/libs/utils/utils'), 'sleep').mockResolvedValue(undefined);
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status: 503 }));

    await expect(
      MarketplaceSessionService.redeemAuthTokenAfterHomeserver(new Uint8Array([1]), PUBKY, Date.now() - 61_000),
    ).rejects.toMatchObject({ category: 'server' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('notifies onSessionEnded with expired, rejected, and cleared reasons', async () => {
    const reasons: string[] = [];
    const unsubscribe = MarketplaceSessionService.onSessionEnded((event) => {
      reasons.push(event.reason);
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T13:00:00.000Z'));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
    vi.setSystemTime(new Date('2026-08-20T12:59:31.000Z'));
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    await Promise.resolve();
    expect(reasons).toEqual(['expired']);

    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T13:00:00.000Z'));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([2]), PUBKY);
    MarketplaceSessionService.clearSession('rejected');
    await Promise.resolve();
    expect(reasons).toEqual(['expired', 'rejected']);

    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T13:00:00.000Z'));
    await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([3]), PUBKY);
    MarketplaceSessionService.clearSession();
    await Promise.resolve();
    expect(reasons).toEqual(['expired', 'rejected', 'cleared']);

    MarketplaceSessionService.clearSession();
    await Promise.resolve();
    expect(reasons).toEqual(['expired', 'rejected', 'cleared']);
    unsubscribe();
  });

  it('does not put a truncated session-mint body into error context, logs, or cause', async () => {
    const truncated = `{"token":"${TOKEN}","pubky":"${PUBKY}","capabilities":"","expires_at":"`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(truncated, { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const loggerError = vi.spyOn(Logger, 'error');

    const error = (await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toMatchObject({ name: 'AppError', category: 'server', code: 'INVALID_RESPONSE' });
    expect(error.message).not.toContain(TOKEN);
    // The context is the statusCode ONLY — the pickup-parser precedent
    // (single-approval.md §7.8): no body excerpt, no extras.
    expect(error.context).toEqual({ statusCode: 201 });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(TOKEN);
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    loggerError.mockRestore();
  });

  it('rejects trailing garbage even when a well-formed session object is a prefix', async () => {
    const expiresAt = inOneDay();
    const body = `${JSON.stringify({ token: TOKEN, pubky: PUBKY, capabilities: '', expires_at: expiresAt })}<!DOCTYPE html>`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(body, { status: 201, headers: { 'content-type': 'application/json' } }),
    );

    const error = (await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY).catch(
      (caught: unknown) => caught,
    )) as AppError;
    expect(error).toMatchObject({ name: 'AppError', code: 'INVALID_RESPONSE' });
    expect(error.message).not.toContain('<!DOCTYPE');
    expect(JSON.stringify(error.context)).not.toContain(TOKEN);
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects concatenated session objects (attacker prefix + truncated genuine)', async () => {
    const expiresAt = inOneDay();
    const attacker = JSON.stringify({
      token: TOKEN_C,
      pubky: PUBKY,
      capabilities: '',
      expires_at: expiresAt,
    });
    const truncatedGenuine = `{"token":"${TOKEN}","pubky":"${PUBKY}","capabilities":"","expires_at":"`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(`${attacker}${truncatedGenuine}`, { status: 201, headers: { 'content-type': 'application/json' } }),
    );

    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects trailing HTML/CSS whose braces would have fooled a last-brace salvage', async () => {
    const expiresAt = inOneDay();
    const genuine = JSON.stringify({ token: TOKEN, pubky: PUBKY, capabilities: '', expires_at: expiresAt });
    const body = `${genuine}<style>.x{color:red}</style><script>if(true){void 0}</script>`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(body, { status: 201, headers: { 'content-type': 'application/json' } }),
    );

    const error = (await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY).catch(
      (caught: unknown) => caught,
    )) as AppError;
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(error.message).not.toContain('color:red');
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.context)).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects a truncated nested field structurally, not because the wire format is flat', async () => {
    // A future nested capabilities object must still fail closed mid-token:
    // JSON.parse of the whole body is what makes truncation structural.
    const truncatedNested = `{"token":"${TOKEN}","pubky":"${PUBKY}","capabilities":{"scope":"rw","extra":"`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(truncatedNested, { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const error = (await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY).catch(
      (caught: unknown) => caught,
    )) as AppError;
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.context)).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects a session minted for a different pubky than the requesting account', async () => {
    const other = 'z'.repeat(52);
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay()));
    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), other)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects a session token that is not the 32-byte url-safe-base64 wire form', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token: 'ATTACKER', pubky: PUBKY, capabilities: '', expires_at: inOneDay() }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
  });

  it('rejects a leading-garbage session-fixation body (attacker object after junk)', async () => {
    const expiresAt = inOneDay();
    const attackerToken = 'C'.repeat(43);
    const attacker = JSON.stringify({
      token: attackerToken,
      pubky: PUBKY,
      capabilities: '',
      expires_at: expiresAt,
    });
    const truncatedGenuine = `{"token":"${TOKEN}","pubky":"${PUBKY}","capabilities":"","expires_at":"`;
    const body = `junk${attacker}${truncatedGenuine}`;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(body, { status: 201, headers: { 'content-type': 'application/json' } }),
    );

    await expect(MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_RESPONSE',
    });
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });
});
