import {
  Address,
  AuthFlowKind,
  AuthToken,
  Capabilities,
  Client,
  Keypair,
  Pubky,
  PublicKey,
  resolvePubky,
  Session,
  Signer,
} from '@synonymdev/pubky';
import type { TKeypairParams } from '@/application/auth/auth.types';
import { CAPABILITIES, capabilitiesMatchFullGrant } from '@/config/app';
import {
  getDefaultHttpRelay,
  getDeployEnv,
  getHomeserver,
  getHomeserverUrl,
  getPkarrRelays,
  getTestnet,
  isStagingHomeserverDeploy,
} from '@/config/network';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError } from '@/libs/error/error.http';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpMethod, HttpStatusCode } from '@/libs/http/http.types';
import { signRootAuthToken } from '@/libs/identity/auth-token';
import { Identity } from '@/libs/identity/identity';
import { Logger } from '@/libs/logger/logger';
import type { Pubky as TPubkyModel } from '@/models/models.types';
import type {
  TGenerateAuthTokenFlowResult,
  TGenerateAuthUrlResult,
  THomeserverRestoreSessionParams,
  THomeserverSessionResult,
  THomeserverSignUpParams,
  TSignupTokenVerificationStatus,
} from '@/services/homeserver/homeserver.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { extractStatusCode, handleError } from './error.utils';
import type {
  TGenerateSignupAuthUrlParams,
  THomeserverFetchParams,
  THomeserverListAllParams,
  THomeserverListParams,
  THomeserverPublicKeyParams,
  THomeserverRequestParams,
  THomeserverUserEvent,
  TOwnedSessionPath,
  TPutBlobParams,
} from './homeserver.types';
import {
  assertOk,
  bytesToBase64,
  capabilitiesGrantWrite,
  createCancelableAuthApproval,
  getOwnedResponse,
  isHttpUrl,
  parseResponseOrUndefined,
  PUBKY_PREFIX,
  resolveOwnedSessionPath,
  toSdkPath,
} from './homeserver.utils';

// The single sign-in grant lives in `@/config/app` (as `CAPABILITIES`) so the
// step-up re-approval dialog can render the exact requested string beside the
// QR without importing this service module.
const PUB_PATH_PREFIX = '/pub/' as const;
const PRIV_PATH_PREFIX = '/priv/' as const;
/** Paths the current session owns outright: its own public and private trees. */
const OWNED_PATH_PREFIXES = [PUB_PATH_PREFIX, PRIV_PATH_PREFIX] as const;
/** The private subtree cross-device watchlist sync writes to. */
export const PRIVATE_APP_DATA_PATH = '/priv/pubky.app/' as const;
/** Default limit for list operations */
const LIST_DEFAULT_LIMIT = 500;
/** Attempts to hydrate the session right after a direct homeserver signup. */
const SIGNUP_SESSION_RESTORE_ATTEMPTS = 3;
/** Base delay between signup session restore attempts (multiplied by attempt number). */
const SIGNUP_SESSION_RESTORE_DELAY_MS = 1500;

type HomeserverSdkUserEvent = THomeserverUserEvent & {
  free(): void;
};

export class HomeserverService {
  private constructor() {}

  private static pubkySdk: Pubky | null = null;

  /**
   * Gets the Pubky SDK singleton.
   */
  private static getPubkySdk(): Pubky {
    if (!this.pubkySdk) {
      if (getTestnet()) {
        this.pubkySdk = Pubky.testnet();
      } else {
        const client = new Client({ pkarr: { relays: getPkarrRelays() } });
        this.pubkySdk = Pubky.withClient(client);
      }
    }
    return this.pubkySdk;
  }

  private static resolveOwnedSessionPath(url: string): TOwnedSessionPath | null {
    const session = useAuthStore.getState().selectSession();
    return resolveOwnedSessionPath({ url, session, ownedPathPrefixes: OWNED_PATH_PREFIXES });
  }

  /** Whether an authenticated session object currently exists (restored sessions included). */
  static hasActiveSession(): boolean {
    return useAuthStore.getState().selectSession() !== null;
  }

  /**
   * Whether the CURRENT session's granted capabilities allow writing `path`.
   *
   * Reads `session.info.capabilities` — the homeserver's own statement of what
   * this session may do — so callers can gate features on facts instead of
   * probing for 403s. Legacy Ring sessions approved before the grant widened
   * to include `/priv/pubky.app/:rw` return `false` for private paths until
   * the user re-approves.
   *
   * Returns `false` when no session exists.
   */
  static canCurrentSessionWrite(path: string): boolean {
    const session = useAuthStore.getState().selectSession();
    const capabilities = session?.info?.capabilities;
    if (!capabilities) return false;
    return capabilitiesGrantWrite(capabilities, path);
  }

  static currentSessionHasFullGrant(): boolean {
    const capabilities = useAuthStore.getState().selectSession()?.info?.capabilities;
    if (!capabilities) return false;
    return capabilitiesMatchFullGrant(capabilities);
  }

  /**
   * Introspect AuthToken bytes, refuse anything other than Shop's full grant,
   * POST them to `/session` via WASM `Client.fetch`, and hydrate a `Session`
   * from the SessionInfo body. Homeserver `AlreadyUsed` (or a lost 2xx) is
   * recovered with GET `/session` when a cookie already exists.
   *
   * Bytes are not logged, persisted, or placed in error context.
   */
  static async signInWithFullGrantAuthToken(authTokenBytes: Uint8Array): Promise<Session> {
    let publicKeyZ32: string;
    try {
      const token = AuthToken.fromBytes(authTokenBytes);
      if (!capabilitiesMatchFullGrant(token.capabilities)) {
        throw Err.validation(
          ValidationErrorCode.INVALID_INPUT,
          'This approval does not include the full Shop permission list. Scan again from Shop.',
          {
            service: ErrorService.Homeserver,
            operation: 'signInWithFullGrantAuthToken',
          },
        );
      }
      publicKeyZ32 = token.publicKey.z32();
    } catch (error) {
      if (error instanceof AppError) throw error;
      return handleError({
        error,
        additionalContext: { operation: 'signInWithFullGrantAuthToken' },
      });
    }

    const sessionUrl = `https://_pubky.${publicKeyZ32}/session`;
    const client = this.getPubkySdk().client;
    const fetchInit = { credentials: 'include' as const };

    let postResponse: Response | undefined;
    try {
      postResponse = await client.fetch(sessionUrl, {
        method: 'POST',
        body: authTokenBytes as BodyInit,
        ...fetchInit,
      });
    } catch {
      postResponse = undefined;
    }

    if (postResponse?.ok) {
      try {
        const body = new Uint8Array(await postResponse.arrayBuffer());
        return await this.restoreSession({ sessionExport: bytesToBase64(body) });
      } catch {
        throw Err.auth(
          AuthErrorCode.UNAUTHORIZED,
          'Sign-in failed. Scan again.',
          {
            service: ErrorService.Homeserver,
            operation: 'signInWithFullGrantAuthToken',
            context: { stage: 'restore-after-post' },
          },
        );
      }
    }

    let getResponse: Response | undefined;
    try {
      getResponse = await client.fetch(sessionUrl, { method: 'GET', ...fetchInit });
    } catch {
      getResponse = undefined;
    }

    if (getResponse?.ok) {
      try {
        const body = new Uint8Array(await getResponse.arrayBuffer());
        return await this.restoreSession({ sessionExport: bytesToBase64(body) });
      } catch {
        throw Err.auth(AuthErrorCode.UNAUTHORIZED, 'Sign-in failed. Scan again.', {
          service: ErrorService.Homeserver,
          operation: 'signInWithFullGrantAuthToken',
          context: { stage: 'restore-after-get' },
        });
      }
    }

    throw Err.auth(AuthErrorCode.UNAUTHORIZED, 'Sign-in failed. Scan again.', {
      service: ErrorService.Homeserver,
      operation: 'signInWithFullGrantAuthToken',
      context: { stage: 'no-session' },
    });
  }

  /**
   * Gets a signer for the homeserver
   * @param keypair - The keypair to get a signer for
   * @returns The signer
   */
  private static getSigner(keypair: Keypair): Signer {
    const pubkySdk = this.getPubkySdk();
    return pubkySdk.signer(keypair);
  }

  /**
   * Resolves the key's homeserver from its PKARR record.
   * @returns The homeserver public key, or `null` when the record is provably absent
   * @throws When the lookup itself failed (relay/network error) — absence NOT proven
   */
  private static async resolveHomeserverRecord({ publicKey }: THomeserverPublicKeyParams) {
    try {
      const pubkySdk = this.getPubkySdk();
      const homeserver = await pubkySdk.getHomeserverOf(publicKey);
      return homeserver ?? null;
    } catch (error) {
      return handleError({
        error,
        additionalContext: { publicKey: publicKey?.z32?.() },
      });
    }
  }

  /**
   * Resolve PKARR homeserver; on staging, require it matches this deploy's homeserver.
   *
   * An absent record is rejected the same way as a mismatched one: absence cannot
   * prove the key belongs here, both outcomes are deterministic (retrying the
   * lookup cannot change them), and fail-open would re-enable the prod-key
   * force-republish this guard exists to prevent (#2126). This also means a key
   * whose just-published record has not yet propagated to our relays is rejected
   * until it propagates. Only a lookup that itself failed (relay/network error)
   * throws a retryable server error instead.
   */
  static async assertUserHomeserverAllowed({ publicKey }: THomeserverPublicKeyParams): Promise<void> {
    if (!isStagingHomeserverDeploy()) {
      return;
    }

    const homeserver = await this.resolveHomeserverRecord({ publicKey });
    const configuredHomeserver = getHomeserver();
    const resolvedHomeserver = homeserver ? homeserver.z32() : null;
    if (resolvedHomeserver !== configuredHomeserver) {
      const context = {
        configuredHomeserver,
        resolvedHomeserver,
        publicKey: publicKey.z32(),
      };
      // An expected user mistake (prod key on a staging deploy), not a system
      // fault — constructed directly rather than via the Err factory so every
      // occurrence does not emit an error log plus a Sentry error event.
      Logger.info(`Rejected sign-in: key is not linked to this ${getDeployEnv()} homeserver`, context);
      throw new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.WRONG_ENVIRONMENT_HOMESERVER,
        message: `This key is not linked to this ${getDeployEnv()} deploy homeserver.`,
        service: ErrorService.Homeserver,
        operation: 'assertUserHomeserverAllowed',
        context,
      });
    }
  }

  /**
   * Signs up a new user in the homeserver
   * @param keypair - The keypair to sign up with
   * @param signupToken - The signup token to use
   * @returns The session
   */
  static async signUp({ keypair, signupToken }: THomeserverSignUpParams): Promise<THomeserverSessionResult> {
    if (isStagingHomeserverDeploy()) {
      return await this.signUpViaHomeserverUrl({ keypair, signupToken });
    }

    try {
      const homeserverPublicKey = PublicKey.from(getHomeserver());
      const signer = this.getSigner(keypair);
      const session = await signer.signup(homeserverPublicKey, signupToken);

      Logger.debug('Signup successful', { session });

      return { session };
    } catch (error) {
      return handleError({
        error,
        additionalContext: { signupTokenProvided: Boolean(signupToken) },
        statusCode: HttpStatusCode.INTERNAL_SERVER_ERROR,
        alwaysUseHomeserverError: true,
      });
    }
  }

  /**
   * Staging signup that bypasses PKARR resolution of the homeserver key.
   *
   * `signer.signup()` builds `https://<homeserver-z32>/signup` and needs the
   * homeserver's OWN PKARR record to carry an HTTPS endpoint for that bare-key
   * hostname. The staging homeserver's record does not resolve that way (the
   * same reason {@link verifySignupToken} already uses {@link getHomeserverUrl}
   * directly), so browser-key signups died with "No HTTPS endpoints found in
   * PKARR record" while everything else — which rides `_pubky.<user>` URLs —
   * kept working.
   *
   * This path replicates what `signer.signup()` does, without that lookup:
   * 1. Sign a root-capability AuthToken locally (see `libs/identity/auth-token`)
   *    and POST it to `{homeserverUrl}/signup?signup_token=…`. The response body
   *    is the serialized SessionInfo and the session cookie is set by the browser.
   * 2. Force-publish the user's `_pubky` record pointing at this homeserver
   *    (required by {@link assertUserHomeserverAllowed} and by Nexus).
   * 3. Hydrate a Session from the signup response (retried briefly: the
   *    hydration revalidates via `_pubky.<user>`, which needs the record from
   *    step 2 to propagate to the relays).
   *
   * Retry safety: the invite is consumed by a successful POST in step 1. If a
   * later step fails, the thrown error is retryable, and a retried call whose
   * POST is rejected (token already used) recovers by signing in to the
   * now-existing account instead of failing — so retries never strand a
   * consumed invite or a half-created account.
   */
  private static async signUpViaHomeserverUrl({
    keypair,
    signupToken,
  }: THomeserverSignUpParams): Promise<THomeserverSessionResult> {
    const url = `${getHomeserverUrl()}/signup?signup_token=${encodeURIComponent(signupToken)}`;
    const errorParams = { service: ErrorService.Homeserver, operation: 'signUpViaHomeserverUrl' };

    let response: Response;
    try {
      response = await this.getPubkySdk().client.fetch(url, {
        method: HttpMethod.POST,
        // The token owns its exact-length buffer; passed as ArrayBuffer because
        // this tsconfig's BodyInit does not accept Uint8Array<ArrayBufferLike>.
        body: signRootAuthToken(keypair.secret()).buffer as ArrayBuffer,
        credentials: 'include',
      });
    } catch (error) {
      // The homeserver was never reached, so the invite was not consumed — retryable.
      throw Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, 'Could not reach the homeserver to sign up.', {
        ...errorParams,
        cause: error,
      });
    }

    if (!response.ok) {
      const recovered = await this.trySignInExistingAccount(keypair);
      if (recovered) {
        Logger.info('Signup token already consumed but account exists; recovered via sign-in');
        return recovered;
      }
      throw Err.auth(AuthErrorCode.INVALID_TOKEN, 'The homeserver rejected the invite code.', {
        ...errorParams,
        context: { statusCode: response.status },
      });
    }

    const sessionInfoBytes = new Uint8Array(await response.arrayBuffer());
    Logger.debug('Direct homeserver signup succeeded', { publicKey: keypair.publicKey.z32() });

    // From here on the invite is spent: only throw RETRYABLE errors (see doc comment).
    try {
      await this.getSigner(keypair).pkdns.publishHomeserverForce(PublicKey.from(getHomeserver()));
    } catch (error) {
      throw Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, 'Signed up, but publishing your key record failed.', {
        ...errorParams,
        cause: error,
      });
    }

    const session = await this.restoreSignupSession(sessionInfoBytes, errorParams);
    return { session };
  }

  /**
   * Hydrate a Session from a `/signup` response body (serialized SessionInfo —
   * the exact payload `session.export()` base64-encodes). Restoration
   * revalidates against `_pubky.<user>`, so brief retries absorb relay
   * propagation of the just-published user record.
   */
  private static async restoreSignupSession(
    sessionInfoBytes: Uint8Array,
    errorParams: { service: ErrorService; operation: string },
  ): Promise<Session> {
    const sessionExport = bytesToBase64(sessionInfoBytes);

    let lastError: unknown;
    for (let attempt = 1; attempt <= SIGNUP_SESSION_RESTORE_ATTEMPTS; attempt++) {
      try {
        return await this.getPubkySdk().restoreSession(sessionExport);
      } catch (error) {
        lastError = error;
        Logger.warn('Signup session restore attempt failed', { attempt, error });
        if (attempt < SIGNUP_SESSION_RESTORE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, SIGNUP_SESSION_RESTORE_DELAY_MS * attempt));
        }
      }
    }

    throw Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, 'Signed up, but could not establish your session yet.', {
      ...errorParams,
      cause: lastError,
    });
  }

  /**
   * Recovery for a signup POST rejected because the invite was already consumed
   * by a previous attempt that died mid-flight: if this keypair's account exists,
   * publish its record and sign in. Returns `null` when the account does not
   * exist (i.e. the invite was genuinely invalid). Publishing before knowing the
   * account exists is harmless — a fresh onboarding keypair with no account just
   * leaves an inert record pointing here.
   */
  private static async trySignInExistingAccount(keypair: Keypair): Promise<THomeserverSessionResult | null> {
    try {
      const signer = this.getSigner(keypair);
      await signer.pkdns.publishHomeserverForce(PublicKey.from(getHomeserver()));
      const session = await signer.signin();
      return { session };
    } catch (error) {
      Logger.debug('No existing account to recover during signup', { error });
      return null;
    }
  }

  /**
   * Verifies a signup token (invite code) against the homeserver.
   *
   * Performs a GET to the homeserver's `/signup_tokens/<token>` endpoint. This is a
   * homeserver-root endpoint that cannot be reached via the homeserver pubkey (its PKARR
   * record has no resolvable HTTPS endpoint), so the explicit {@link getHomeserverUrl} is used.
   *
   * A definitive homeserver response distinguishes valid, used, and unknown tokens, whereas
   * a failure to reach the homeserver is surfaced as a thrown error so callers can tell
   * verification outcomes apart from "couldn't verify right now".
   *
   * @param signupToken - The signup token / invite code to verify
   * @returns `'valid'` when the token exists and is unused, `'used'` when already redeemed,
   *   `'invalid'` when the homeserver does not recognise the token (404).
   * @throws When the homeserver could not be reached (network error, timeout, DNS/PKARR failure)
   *   or returns an unexpected status.
   */
  static async verifySignupToken(signupToken: string): Promise<TSignupTokenVerificationStatus> {
    const url = `${getHomeserverUrl()}/signup_tokens/${encodeURIComponent(signupToken)}`;
    try {
      const response = await this.getPubkySdk().client.fetch(url, { method: HttpMethod.GET });
      Logger.debug('Signup token verification response', { status: response.status });

      if (response.status === HttpStatusCode.NOT_FOUND) {
        return 'invalid';
      }

      if (!response.ok) {
        throw new Error(`Signup token verification failed with status ${response.status}`);
      }

      const text = await response.text();
      let data: { status?: string };
      try {
        data = JSON.parse(text) as { status?: string };
      } catch {
        Logger.warn('Signup token verification returned a non-JSON body', { status: response.status });
        return 'invalid';
      }
      if (data.status === 'valid') {
        return 'valid';
      }
      if (data.status === 'used') {
        return 'used';
      }

      Logger.warn('Unexpected signup token verification payload', { status: data.status });
      return 'invalid';
    } catch (error) {
      Logger.warn('Signup token verification could not reach the homeserver');
      throw error;
    }
  }

  /**
   * Signs in a user to the homeserver.
   *
   * If signin fails due to missing homeserver records, this method will attempt to republish
   * the homeserver and return `undefined` to signal the caller should retry the signin.
   *
   * @param keypair - The keypair to sign in with
   * @returns The session result, or `undefined` if homeserver was republished and caller should retry
   */
  static async signIn({ keypair }: TKeypairParams): Promise<THomeserverSessionResult | undefined> {
    const signer = this.getSigner(keypair);

    if (isStagingHomeserverDeploy()) {
      // Fail closed on staging: an inconclusive PKARR lookup must never migrate an
      // unverified key to the configured staging homeserver.
      await this.assertUserHomeserverAllowed({ publicKey: keypair.publicKey });
    } else {
      // Lookup-failure hardening: self-heal (republish) only a PROVABLY ABSENT
      // record (e.g. expired from the DHT). A failed lookup throws instead —
      // republishing on a transient error could overwrite an existing record
      // that points at another homeserver. NOTE: the signin-failure branch
      // below still republishes a PRESENT record (long-standing stale-record
      // migration self-heal); narrowing that is a separate product decision.
      const homeserverRecord = await this.resolveHomeserverRecord({ publicKey: keypair.publicKey });
      if (homeserverRecord === null) {
        return await this.republishConfiguredHomeserver({
          signer,
          keypair,
          originalError: 'homeserver record absent from PKARR',
        });
      }
    }

    try {
      const session = await signer.signin();
      return { session };
    } catch (signinError) {
      return await this.republishConfiguredHomeserver({ signer, keypair, originalError: signinError });
    }
  }

  private static async republishConfiguredHomeserver({
    signer,
    keypair,
    originalError,
  }: {
    signer: Signer;
    keypair: Keypair;
    originalError: unknown;
  }): Promise<undefined> {
    try {
      const homeserverPublicKey = PublicKey.from(getHomeserver());
      await signer.pkdns.publishHomeserverForce(homeserverPublicKey);
      Logger.debug('Republish homeserver successful', { pubky: Identity.pubkyFromKeypair(keypair) });
      return undefined;
    } catch (republishError) {
      return handleError({
        error: republishError,
        additionalContext: { pubky: Identity.pubkyFromKeypair(keypair), originalSigninError: String(originalError) },
        statusCode: HttpStatusCode.UNAUTHORIZED,
      });
    }
  }

  /**
   * Generates an authentication URL for the homeserver
   * @param caps - The capabilities to use
   * @returns The authentication URL and approval promise
   */
  static async generateAuthUrl(caps?: Capabilities): Promise<TGenerateAuthUrlResult> {
    const capabilities: Capabilities = caps || CAPABILITIES;

    try {
      const pubkySdk = this.getPubkySdk();
      const flow = pubkySdk.startAuthFlow(capabilities, AuthFlowKind.signin(), getDefaultHttpRelay());
      const approval = createCancelableAuthApproval(flow);

      return {
        authorizationUrl: flow.authorizationUrl,
        awaitApproval: approval.awaitApproval,
        cancelAuthFlow: approval.cancel,
      };
    } catch (error) {
      return handleError({ error, additionalContext: { capabilities, relay: getDefaultHttpRelay() } });
    }
  }

  /**
   * Starts an authentication-only Pubky auth flow whose approval yields an `AuthToken` —
   * a signed, time-bound proof of key ownership — instead of a homeserver session.
   *
   * Used to authenticate the user to external Pubky-verified services (e.g. the
   * Marketplace Transaction Service, which verifies the token bytes with `pubky-common`).
   * The capability set is empty on purpose: the token proves identity only and grants
   * no homeserver access.
   *
   * @returns The authorization URL to show the signer, a lazy `awaitToken`, and a cancel
   */
  /**
   * @param capabilities Optional capability string shown verbatim on the
   * signer. Empty (the default) requests a plain sign-in token; a scoped
   * string (e.g. the Paykit claim scope) yields a token carrying exactly
   * those capabilities, which some verifiers require and check exactly.
   */
  static generateAuthTokenFlow(capabilities: Capabilities = ''): TGenerateAuthTokenFlowResult {
    try {
      const pubkySdk = this.getPubkySdk();
      const flow = pubkySdk.startAuthFlow(capabilities, AuthFlowKind.signin(), getDefaultHttpRelay());
      const authorizationUrl = flow.authorizationUrl;
      let freed = false;
      const free = () => {
        if (freed) return;
        freed = true;
        try {
          flow.free();
        } catch {
          // Ignore double-free or already-finalized WASM objects.
        }
      };
      const awaitToken = async () => {
        try {
          return await flow.awaitToken();
        } finally {
          free();
        }
      };
      return { authorizationUrl, awaitToken, cancelAuthFlow: free };
    } catch (error) {
      return handleError({ error, additionalContext: { relay: getDefaultHttpRelay() } });
    }
  }

  /**
   * Generates an authentication signup URL for the homeserver.
   *
   * Temporary hack to create a signup deeplink from the signin url still using the old pubky sdk.
   * The new sdk will handle the creation of the signup deeplink out of the box.
   * But until then, we need to use this hack.
   * @param inviteCode InviteCode to the homeserver
   * @param caps - The capabilities to use
   * @returns The authentication URL and approval promise
   */
  static async generateSignupAuthUrl({
    inviteCode,
    caps,
  }: TGenerateSignupAuthUrlParams): Promise<TGenerateAuthUrlResult> {
    const res = await this.generateAuthUrl(caps);
    const url = URL.parse(res.authorizationUrl);
    if (!url) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Invalid authorization URL format', {
        service: ErrorService.Homeserver,
        operation: 'generateSignupAuthUrl',
        context: { authorizationUrl: res.authorizationUrl },
      });
    }
    url.host = 'signup';
    url.pathname = '';
    url.searchParams.set('hs', getHomeserver());
    url.searchParams.set('st', inviteCode);
    res.authorizationUrl = url.toString();
    return res;
  }

  /**
   * Logs out a user from the homeserver
   * @param session - The authenticated Session to sign out
   * @returns Void
   */
  static async logout({ session }: THomeserverSessionResult) {
    try {
      await session.signout();
    } catch (error) {
      return handleError({ error, additionalContext: { url: 'signout' } });
    }
  }

  private static async fetch({ url, options }: THomeserverFetchParams): Promise<Response> {
    try {
      const pubkySdk = this.getPubkySdk();
      const httpBridge = pubkySdk.client;
      // Resolve pubky identifiers to transport URLs before fetching
      const resolvedUrl = url.startsWith(PUBKY_PREFIX) ? resolvePubky(url) : url;
      const response = await httpBridge.fetch(resolvedUrl, {
        method: options?.method,
        body: options?.body as BodyInit | undefined,
        credentials: 'include',
      });

      Logger.debug('Response from homeserver', { response });

      return response;
    } catch (error) {
      return handleError({ error, additionalContext: { url, method: options?.method } });
    }
  }

  /**
   * Performs a request against the homeserver.
   *
   * Sends a JSON payload when provided and throws if the response is not OK.
   * Note: Under the hood this uses `fetch` with `credentials: 'include'`.
   *
   * @param {HttpMethod} method - HTTP method to use (e.g. PUT, POST, DELETE).
   * @param {string} url - Pubky URL.
   * @param {Record<string, unknown>} [bodyJson] - JSON body to serialize and send.
   */
  static async request<T>({ method, url, bodyJson }: THomeserverRequestParams): Promise<T> {
    const owned = this.resolveOwnedSessionPath(url);

    // Handle owned session paths
    if (owned) {
      const { session, path } = owned;

      switch (method) {
        case HttpMethod.GET: {
          const response = await getOwnedResponse({ session, path, url });
          return (await parseResponseOrUndefined<T>({ response })) as T;
        }
        case HttpMethod.PUT:
          await session.storage
            .putJson(toSdkPath(path), bodyJson ?? {})
            .catch((error) => handleError({ error, additionalContext: { url, method } }));
          return undefined as T;
        case HttpMethod.DELETE:
          await session.storage
            .delete(toSdkPath(path))
            .catch((error) => handleError({ error, additionalContext: { url, method } }));
          return undefined as T;
      }
    }

    // Non-owned: only GET allowed on non-HTTP URLs
    if (method !== HttpMethod.GET && !isHttpUrl(url)) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        `Authenticated writes must target an owned ${PUB_PATH_PREFIX}* or ${PRIV_PATH_PREFIX}* path for the current session.`,
        {
          service: ErrorService.Homeserver,
          operation: 'request',
          context: { url, method, statusCode: HttpStatusCode.BAD_REQUEST },
        },
      );
    }

    // Handle public requests
    const pubkySdk = this.getPubkySdk();
    const fetchPromise =
      method === HttpMethod.GET
        ? isHttpUrl(url)
          ? pubkySdk.client.fetch(url)
          : pubkySdk.publicStorage.get(url as Address)
        : this.fetch({ url, options: { method, body: bodyJson ? JSON.stringify(bodyJson) : undefined } });

    const response = await fetchPromise.catch((error) => handleError({ error, additionalContext: { url, method } }));

    await assertOk({ response, url, operation: 'request' });

    return method === HttpMethod.GET ? ((await parseResponseOrUndefined<T>({ response })) as T) : (undefined as T);
  }

  /**
   * Uploads binary data to the homeserver using PUT.
   *
   * Intended for blob contents (e.g., avatars). Throws if the response is not OK.
   * Note: Uses `fetch` with `credentials: 'include'`.
   *
   * @param {string} url - Pubky URL.
   * @param {Uint8Array} blob - Raw bytes of the blob to upload.
   */
  static async putBlob({ url, blob }: TPutBlobParams) {
    const owned = this.resolveOwnedSessionPath(url);
    if (owned) {
      try {
        await owned.session.storage.putBytes(toSdkPath(owned.path), blob);
        return;
      } catch (error) {
        return handleError({ error, additionalContext: { url, method: HttpMethod.PUT } });
      }
    }

    if (!isHttpUrl(url)) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        `Blob uploads must target an owned ${PUB_PATH_PREFIX}* path for the current session.`,
        {
          service: ErrorService.Homeserver,
          operation: 'putBlob',
          context: { url, statusCode: HttpStatusCode.BAD_REQUEST },
        },
      );
    }

    const response = await this.fetch({ url, options: { method: HttpMethod.PUT, body: blob } });
    await assertOk({ response, url, operation: 'putBlob' });
  }

  /**
   * Lists files in a directory from the homeserver.
   *
   * Supports pagination with cursor and optional filtering.
   *
   * @param {string} baseDirectory - Base directory path to list files from.
   * @param {string} [cursor] - Optional cursor for pagination.
   * @param {boolean} [reverse=false] - Whether to list in reverse order.
   * @param {number} [limit=500] - Maximum number of files to return.
   * @returns {Promise<string[]>} Array of file URLs.
   */
  static async list({
    baseDirectory,
    cursor,
    reverse = false,
    limit = LIST_DEFAULT_LIMIT,
  }: THomeserverListParams): Promise<string[]> {
    const pubkySdk = this.getPubkySdk();
    try {
      const owned = this.resolveOwnedSessionPath(baseDirectory);
      if (owned) {
        const dirPath = owned.path.endsWith('/') ? owned.path : (`${owned.path}/` as TOwnedSessionPath['path']);
        const files = await owned.session.storage.list(toSdkPath(dirPath), cursor ?? null, reverse, limit, false);
        Logger.debug('List successful', { baseDirectory, filesCount: files.length });
        return files;
      }

      const files = await pubkySdk.publicStorage.list(baseDirectory as Address, cursor ?? null, reverse, limit, false);
      Logger.debug('List successful', { baseDirectory, filesCount: files.length });
      return files;
    } catch (error) {
      // 404 here is not an error: missing directory means empty list. Bypass handleError to avoid Sentry capture.
      if (extractStatusCode(error) === HttpStatusCode.NOT_FOUND) {
        Logger.warn('[homeserver:list]', { outcome: 'fallback', reason: 'not_found', baseDirectory });
        return [];
      }
      return handleError({ error, additionalContext: { url: baseDirectory, baseDirectory } });
    }
  }

  /**
   * Lists ALL files under a base directory by paginating with a cursor until exhausted.
   *
   * A single `list` call is page-limited and must use a finite limit: non-finite values
   * (e.g. Infinity) coerce to 0 at the SDK's WASM boundary and silently return an empty
   * page. Paginating with the SDK cursor ("start after this URL") is the only reliable
   * way to enumerate an entire directory.
   *
   * @param {string} baseDirectory - Base directory path to list all files from.
   * @returns {Promise<string[]>} Array of every file URL under the directory.
   */
  static async listAll({ baseDirectory }: THomeserverListAllParams): Promise<string[]> {
    const files: string[] = [];
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.list({ baseDirectory, cursor, limit: LIST_DEFAULT_LIMIT });
      files.push(...batch);

      if (batch.length < LIST_DEFAULT_LIMIT) {
        return files;
      }

      cursor = batch[batch.length - 1];
    }
  }

  /**
   * Deletes a file from the homeserver.
   *
   * @param {string} url - Pubky URL of the file to delete.
   */
  static async delete(url: string) {
    await this.request({ method: HttpMethod.DELETE, url });
    Logger.debug('Delete successful', { url });
  }

  /**
   * Fetches a resource from the homeserver.
   *
   * @param {string} url - Pubky URL to fetch.
   * @returns {Promise<Response>} The fetch response.
   */
  static async get(url: string): Promise<Response> {
    const pubkySdk = this.getPubkySdk();
    try {
      if (isHttpUrl(url)) {
        return await pubkySdk.client.fetch(url);
      }

      const owned = this.resolveOwnedSessionPath(url);
      if (owned) {
        return await getOwnedResponse({ session: owned.session, path: owned.path, url });
      }

      return await pubkySdk.publicStorage.get(url as Address);
    } catch (error) {
      return handleError({ error, additionalContext: { url, method: HttpMethod.GET } });
    }
  }

  /**
   * Checks whether a homeserver resource exists without treating an expected 404 as an error.
   * Storage SDK probes return a boolean; plain HTTP URLs retain explicit response handling.
   */
  static async exists(url: string): Promise<boolean> {
    const pubkySdk = this.getPubkySdk();

    try {
      if (isHttpUrl(url)) {
        const response = await pubkySdk.client.fetch(url);
        if (response.status === HttpStatusCode.NOT_FOUND) return false;
        await assertOk({ response, url, operation: 'exists' });
        return true;
      }

      const owned = this.resolveOwnedSessionPath(url);
      return owned
        ? await owned.session.storage.exists(toSdkPath(owned.path))
        : await pubkySdk.publicStorage.exists(url as Address);
    } catch (error) {
      return handleError({
        error,
        additionalContext: { url, method: HttpMethod.GET, operation: 'exists' },
      });
    }
  }

  /**
   * Restore an authenticated Session from a previous `session.export()` snapshot.
   */
  static async restoreSession({ sessionExport }: THomeserverRestoreSessionParams): Promise<Session> {
    try {
      const pubkySdk = this.getPubkySdk();
      return await pubkySdk.restoreSession(sessionExport);
    } catch (error) {
      return handleError({
        error,
        additionalContext: { sessionExport: Boolean(sessionExport) },
      });
    }
  }

  /**
   * Generates a signup token for dev/test environments.
   * Calls the server-side API route to keep admin credentials secure.
   *
   * @security Admin credentials are never exposed to the client.
   * The actual token generation happens server-side via /api/dev/signup-token.
   */
  static async generateSignupToken() {
    // Allow in development or when Cypress is running (for E2E tests in production builds)
    const isCypressRunning = typeof window !== 'undefined' && 'Cypress' in window;
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && !isCypressRunning) {
      throw Err.validation(
        ValidationErrorCode.INVALID_INPUT,
        'generateSignupToken is only available in non-production environments.',
        {
          service: ErrorService.Homeserver,
          operation: 'generateSignupToken',
          context: { isProduction, isCypressRunning },
        },
      );
    }

    // Call server-side API route to generate token (keeps admin credentials secure)
    const response = await fetch('/api/dev/signup-token', {
      method: 'GET',
    });

    if (!response.ok) {
      throw httpResponseToError(response, ErrorService.Homeserver, 'generateSignupToken', '/api/dev/signup-token');
    }

    const data = await response.json();
    if (!data.token) {
      throw Err.server(ServerErrorCode.UNKNOWN_ERROR, 'No token received from server', {
        service: ErrorService.Homeserver,
        operation: 'generateSignupToken',
      });
    }

    return data.token;
  }

  /**
   * Subscribe to homeserver `/events-stream` for a user's pub directory subtree (SDK SSE wrapper).
   * Used for mute-list sync; callers own {@link ReadableStreamDefaultReader} lifecycle.
   */
  static async subscribeUserEventStreamForPath(params: {
    userZ32: TPubkyModel;
    cursor: string | null;
    pathPrefix: string;
  }): Promise<ReadableStream<THomeserverUserEvent>> {
    try {
      const pubkySdk = this.getPubkySdk();
      const pk = PublicKey.from(params.userZ32);
      const stream = (await pubkySdk
        .eventStreamForUser(pk, params.cursor)
        .path(params.pathPrefix)
        .live()
        .subscribe()) as ReadableStream<HomeserverSdkUserEvent>;

      return this.normalizeUserEventStream(stream);
    } catch (error) {
      return handleError({
        error,
        additionalContext: { pathPrefix: params.pathPrefix },
      });
    }
  }

  private static normalizeUserEventStream(
    stream: ReadableStream<HomeserverSdkUserEvent>,
  ): ReadableStream<THomeserverUserEvent> {
    const reader = stream.getReader();

    return new ReadableStream<THomeserverUserEvent>({
      async pull(controller) {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        try {
          controller.enqueue({
            cursor: value.cursor,
            eventType: value.eventType,
          });
        } finally {
          try {
            value.free();
          } catch {
            // Ignore WASM dispose errors.
          }
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    });
  }
}
