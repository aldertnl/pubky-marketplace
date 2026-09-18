import { z } from 'zod';
import { getCommerceAdapterMode, getMarketplaceUrl, isDurableCommerceMode } from '@/config/commerce';
import { commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode, TimeoutErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError, safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { isAppError, isRetryable } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { sleep } from '@/libs/utils/utils';
import { HomeserverService } from '@/services/homeserver/homeserver';

/**
 * Treat a session as expired slightly before the server does, so a request
 * never departs with a token that dies in flight.
 */
const SESSION_EXPIRY_MARGIN_MS = 30_000;

/**
 * Upper bound on one connect attempt (QR shown → signer approval → token
 * exchange). Without it a flow whose relay channel silently died keeps the
 * dialog in "waiting for approval" forever — the wedge a tester hit by
 * scanning stale QRs. On timeout the flow is freed and the caller gets a
 * visible, retryable error; the QR from a timed-out flow is dead by design
 * (AuthTokens are single-use), so retry always mints a fresh one.
 */
export const SESSION_FLOW_TIMEOUT_MS = 120_000;

/** Dual-POST marketplace retries stop this long after `awaitToken()` resolved. */
export const MARKETPLACE_TOKEN_RETRY_DEADLINE_MS = 60_000;

/** `localStorage` key for the persisted session (see the class docs for the storage contract). */
export const MARKETPLACE_SESSION_STORAGE_KEY = 'pubky.marketplace.session.v1';

/**
 * Opaque session bearer as issued by `POST /v1/auth/sessions`: 32 random
 * bytes, URL-safe base64 without padding (43 characters). See
 * marketplace-service `auth.rs` (`URL_SAFE_NO_PAD.encode([u8; 32])`).
 */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sessionResponseSchema = z.object({
  token: z.string().regex(SESSION_TOKEN_PATTERN),
  pubky: commercePubkySchema,
  capabilities: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});

/** Session facts safe to hand to callers — never includes the bearer token. */
export type MarketplaceSessionInfo = {
  pubky: string;
  capabilities: string;
  expiresAt: string;
  /** Client clock when this bearer was established or restored; last-write-wins key. */
  issuedAt: string;
};

export type MarketplaceSessionEndedReason = 'expired' | 'rejected' | 'cleared';

export type MarketplaceSessionEndedEvent = {
  reason: MarketplaceSessionEndedReason;
  issuedAt: string;
};

export type MarketplaceSessionFlow = {
  authorizationUrl: string;
  awaitSession: () => Promise<MarketplaceSessionInfo>;
  cancel: () => void;
};

type StoredMarketplaceSession = {
  token: string;
  pubky: string;
  capabilities: string;
  expiresAtMs: number;
  expiresAt: string;
  issuedAt: string;
};

/**
 * Holds the Marketplace Transaction Service session for the signed-in browser
 * session: in memory for request use, mirrored to `localStorage` so reloads,
 * new tabs, and browser restarts do not force a fresh signer approval.
 *
 * Storage contract (a deliberate, documented loosening of the original
 * memory-only rule — see `docs/ecommerce/service-auth.md`; widened from
 * per-tab `sessionStorage` to `localStorage` on user decision: signer
 * approval is a rare ceremony, and the service-side TTL — not tab lifetime —
 * bounds the token):
 *  - The opaque bearer token plus its facts (pubky, capabilities, expiry) are
 *    written ONLY to `localStorage` under {@link MARKETPLACE_SESSION_STORAGE_KEY}.
 *    It survives tabs and restarts until the service TTL expires or the user
 *    signs out.
 *  - Never IndexedDB, never cookies, never logged.
 *  - Restore is account-scoped: {@link restorePersistedSession} validates the
 *    stored blob and drops it unless its pubky matches the account whose app
 *    session was just restored. Sign-out (and account switch, which funnels
 *    through the same cleanup) clears it via
 *    `CommerceApplication.clearMarketplaceSession()`.
 *  - A restored token the service no longer accepts surfaces as a 401, which
 *    clears the session and re-shows the reconnect affordance — expiry is the
 *    service's call, not this cache's.
 *
 * Establishment (per `docs/ecommerce/service-auth.md`): the Pubky auth flow
 * yields an `AuthToken` after the user approves on their signer; the raw
 * postcard bytes are POSTed to `/v1/auth/sessions`, which verifies them with
 * `pubky-common` and answers with an opaque session token plus TTL. AuthTokens
 * are single-use, so an expired session cannot be refreshed silently — it
 * requires a fresh signer approval through {@link beginSessionFlow}.
 */
export class MarketplaceSessionService {
  private constructor() {}

  private static session: StoredMarketplaceSession | null = null;
  private static sessionEndedListeners = new Set<(event: MarketplaceSessionEndedEvent) => void>();

  /**
   * Fires after the in-memory session is dropped (TTL margin, 401/mismatch, or
   * explicit clear). Controllers subscribe; this service never touches stores.
   */
  static onSessionEnded(listener: (event: MarketplaceSessionEndedEvent) => void): () => void {
    this.sessionEndedListeners.add(listener);
    return () => {
      this.sessionEndedListeners.delete(listener);
    };
  }

  /**
   * Starts the interactive session flow. Returns the authorization URL to show
   * on the user's signer (QR/deeplink) and a lazy `awaitSession` that resolves
   * once the user approves and the transaction service issues a session.
   * `awaitSession` rejects with a retryable timeout error after
   * {@link SESSION_FLOW_TIMEOUT_MS} so an abandoned or dead-relay flow can
   * never hold the UI in an awaiting state forever.
   */
  static beginSessionFlow(): MarketplaceSessionFlow {
    this.assertTransactionServiceMode('beginSessionFlow');
    const flow = HomeserverService.generateAuthTokenFlow();
    return {
      authorizationUrl: flow.authorizationUrl,
      awaitSession: async () => {
        const authToken = await this.withFlowTimeout(flow.awaitToken(), flow.cancelAuthFlow);
        return await this.establishWithAuthToken(authToken.toBytes(), authToken.publicKey.z32());
      },
      cancel: flow.cancelAuthFlow,
    };
  }

  static async withFlowTimeout<T>(pending: Promise<T>, cancelFlow: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Free the WASM flow so the relay wait cannot linger; the rejection
        // below is what the caller surfaces.
        cancelFlow();
        reject(
          Err.timeout(
            TimeoutErrorCode.REQUEST_TIMEOUT,
            'The connect request expired before it was approved. Start again to get a fresh QR code.',
            {
              service: ErrorService.Marketplace,
              operation: 'awaitSession',
              context: { timeoutMs: SESSION_FLOW_TIMEOUT_MS },
            },
          ),
        );
      }, SESSION_FLOW_TIMEOUT_MS);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Exchanges signed AuthToken bytes for a transaction-service session and
   * stores it in memory, replacing any previous session. `expectedPubky` is
   * the requesting account (the AuthToken signer); a response for any other
   * pubky is rejected.
   */
  static async establishWithAuthToken(
    authTokenBytes: Uint8Array,
    expectedPubky: string,
  ): Promise<MarketplaceSessionInfo> {
    this.assertTransactionServiceMode('establishWithAuthToken');
    const url = `${getMarketplaceUrl()}/v1/auth/sessions`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: authTokenBytes as BodyInit,
      },
      ErrorService.Marketplace,
      'establishWithAuthToken',
    );
    if (!response.ok) {
      if (response.status >= 500) {
        throw httpResponseToError(response, ErrorService.Marketplace, 'establishWithAuthToken', url);
      }
      const alreadyUsed = response.status === 401 ? await this.responseSaysAuthTokenAlreadyUsed(response) : false;
      throw Err.auth(AuthErrorCode.INVALID_TOKEN, 'The marketplace service rejected the auth token.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status, alreadyUsed },
      });
    }
    const raw = await this.parseSessionMintBody(response);
    const parsed = sessionResponseSchema.safeParse(toCamelCaseWire(raw));
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid session response.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
    if (parsed.data.pubky !== expectedPubky) {
      throw Err.auth(AuthErrorCode.FORBIDDEN, 'Marketplace returned a session for a different account.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
    const { token, pubky, capabilities, expiresAt } = parsed.data;
    const issuedAt = new Date().toISOString();
    this.session = { token, pubky, capabilities, expiresAt, expiresAtMs: Date.parse(expiresAt), issuedAt };
    this.writePersistedSession(parsed.data);
    Logger.info('Established marketplace transaction session', { pubky, expiresAt });
    return this.toPublicInfo(this.session);
  }

  /**
   * Marketplace half of the single-approval ceremony: same bytes, retries until
   * 60s after token resolution, 401 already-used is success when this client
   * already holds a bearer for the same pubky.
   */
  static async redeemAuthTokenAfterHomeserver(
    authTokenBytes: Uint8Array,
    expectedPubky: string,
    tokenResolvedAtMs: number,
  ): Promise<MarketplaceSessionInfo> {
    this.assertTransactionServiceMode('redeemAuthTokenAfterHomeserver');
    const deadline = tokenResolvedAtMs + MARKETPLACE_TOKEN_RETRY_DEADLINE_MS;
    for (;;) {
      try {
        return await this.establishWithAuthToken(authTokenBytes, expectedPubky);
      } catch (error) {
        if (this.isAuthTokenAlreadyUsedError(error)) {
          const existing = this.bearerForPubky(expectedPubky);
          if (existing) return this.toPublicInfo(existing);
          throw error;
        }
        const retryable = isAppError(error) && isRetryable(error);
        if (!retryable || Date.now() >= deadline) {
          throw error;
        }
        await sleep(250);
      }
    }
  }

  private static bearerForPubky(expectedPubky: string): StoredMarketplaceSession | null {
    const memory = this.getActiveSession();
    if (memory?.pubky === expectedPubky) return memory;
    this.restorePersistedSession(expectedPubky);
    const restored = this.getActiveSession();
    if (restored?.pubky === expectedPubky) return restored;
    return null;
  }

  private static isAuthTokenAlreadyUsedError(error: unknown): boolean {
    return isAppError(error) && error.context?.alreadyUsed === true && error.context?.statusCode === 401;
  }

  private static async responseSaysAuthTokenAlreadyUsed(response: Response): Promise<boolean> {
    try {
      const text = await response.text();
      return /already been used/i.test(text);
    } catch {
      return false;
    }
  }

  /**
   * Restores a persisted session from `localStorage` for the given account.
   * Called once the app's own session restore has identified who is signed in
   * (`AuthController.restorePersistedSession`). Anything that does not
   * validate — malformed blob, wrong account, already past the expiry margin,
   * non-durable mode — removes the stored value and returns null, so a stale
   * token can never outlive its checks.
   */
  static restorePersistedSession(expectedPubky: string): MarketplaceSessionInfo | null {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return null;
    const raw = this.readStorage();
    if (raw === null) return null;

    const parsed = sessionResponseSchema.safeParse(this.parseJson(raw));
    if (!parsed.success || parsed.data.pubky !== expectedPubky) {
      this.removePersistedSession();
      return null;
    }
    const { token, pubky, capabilities, expiresAt } = parsed.data;
    const expiresAtMs = Date.parse(expiresAt);
    if (Date.now() >= expiresAtMs - SESSION_EXPIRY_MARGIN_MS) {
      this.removePersistedSession();
      return null;
    }

    const issuedAt = new Date().toISOString();
    this.session = { token, pubky, capabilities, expiresAt, expiresAtMs, issuedAt };
    Logger.info('Restored marketplace transaction session', { pubky, expiresAt });
    return this.toPublicInfo(this.session);
  }

  /**
   * Returns the stored session (including the bearer token) when still valid,
   * dropping it once it reaches the expiry margin. Transport-layer use only.
   */
  static getActiveSession(): StoredMarketplaceSession | null {
    if (!this.session) return null;
    if (Date.now() >= this.session.expiresAtMs - SESSION_EXPIRY_MARGIN_MS) {
      this.clearSession('expired');
      return null;
    }
    return this.session;
  }

  /** Drops the session from memory AND storage. Called on sign-out and on server-side 401. */
  static clearSession(reason: MarketplaceSessionEndedReason = 'cleared'): void {
    const ended = this.session;
    this.session = null;
    this.removePersistedSession();
    if (!ended) return;
    this.notifySessionEnded({ reason, issuedAt: ended.issuedAt });
  }

  private static toPublicInfo(session: StoredMarketplaceSession): MarketplaceSessionInfo {
    return {
      pubky: session.pubky,
      capabilities: session.capabilities,
      expiresAt: session.expiresAt,
      issuedAt: session.issuedAt,
    };
  }

  private static notifySessionEnded(event: MarketplaceSessionEndedEvent): void {
    const listeners = [...this.sessionEndedListeners];
    queueMicrotask(() => {
      for (const listener of listeners) listener(event);
    });
  }

  // localStorage access is wrapped because browsers can refuse it (disabled
  // storage, private-mode quirks); a session that cannot persist is still a
  // working in-memory session, so persistence failures only log.
  private static writePersistedSession(session: z.infer<typeof sessionResponseSchema>): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      Logger.warn('Could not persist the marketplace session; it will last until the next reload only.');
    }
  }

  private static removePersistedSession(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(MARKETPLACE_SESSION_STORAGE_KEY);
    } catch {
      // Removal failing means storage is unavailable, so nothing persisted either.
    }
  }

  private static readStorage(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Reads the `/v1/auth/sessions` body WITHOUT the generic
   * `parseResponseOrThrow`: that helper used to embed a body excerpt in error
   * context (`responseText`), which the factories log to the console — and this
   * body BEGINS with the freshly minted bearer token.
   *
   * Strict `JSON.parse` of the entire body only. A previous "lenient salvage"
   * that sliced from the first `{` to the last `}` accepted a prepended
   * attacker object (session fixation). Prefix salvage of a balanced object
   * starting at byte 0 would still accept a concatenated attacker object
   * followed by the truncated genuine body. The cost of failing closed is a
   * rare second Ring approval when a proxy mangles the bytes.
   *
   * Mid-token truncation fails closed because `JSON.parse` requires the whole
   * text to be one complete value — including if a future nested field adds
   * extra braces. Do not restore brace-slicing salvage.
   */
  private static async parseSessionMintBody(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an unreadable session response.', {
        service: ErrorService.Marketplace,
        operation: 'establishWithAuthToken',
        context: { statusCode: response.status },
      });
    }
  }

  private static parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private static assertTransactionServiceMode(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Marketplace transaction-service sessions are disabled.', {
        service: ErrorService.Marketplace,
        operation,
      });
    }
  }
}
