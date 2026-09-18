// Type-only imports are erased at compile time; the WASM module itself is only ever
// loaded through the dynamic import in loadLocksSdk(), never at module scope, so this
// file stays safe to pull into server-rendered module graphs.
import { z } from 'zod';
import { getLocksUrl, getPaykitSetupUrl } from '@/config/commerce';
import { isAppError } from '@/libs/error/error';
import { ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { httpResponseToError, safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { parseResponseOrThrow } from '@/libs/http/response.utils';

type LocksSdkModule = typeof import('locks-sdk-wasm');

/*
 * TRANSPORT DECISION — vendored SDK vs raw HTTP (see docs/ecommerce/locks-sdk-provenance.md):
 *
 * The vendored Locks browser SDK (`vendor/locks-sdk-wasm`) is used for what it can do
 * from ANY deployment: canonical identifier generation (`BundleId.generate()`), pure
 * WASM with no network. Every network route in this service deliberately stays on the
 * Lock Server's documented HTTP contract at the explicitly configured `getLocksUrl()`:
 *
 * 1. The SDK offers NO configured-endpoint mode. Its clients (`Locks.forServer` /
 *    `forCreator` / `forContentLock`) accept only pubkys and resolve the Lock Server's
 *    HTTP endpoint through pkarr (`LocksOptions` configures relays, nothing else).
 *    This app's `locks-paykit` activation is fail-closed on an EXPLICIT
 *    `PUBKY_RUNTIME_LOCKS_URL`; routing payments to whatever endpoint a pkarr record
 *    names would bypass that operator decision.
 * 2. The SDK additionally requires browser-usable domain endpoints in the resolved
 *    records. The composed regtest environment — the only place real payments are
 *    live-verified (`npm run test:marketplace:locks`) — publishes compose-internal
 *    endpoints, so the SDK's viewer surface cannot reach it and the live proof would
 *    be lost.
 * 3. The frontend-session exchange has a third, independent reason: the SDK's
 *    `exchangeFrontendSessionCode` returns an opaque `Session` handle and never
 *    exposes the raw `session_token`/`creator` pair the seller-connect flow consumes.
 *
 * The HTTP surface used here (proof-bundle submission, lifecycle lookups, credential
 * issuance, guarded proxy reads, frontend sessions) is live-verified against the
 * pinned Lock Server revision by `npm run test:marketplace:locks`, which bounds the
 * drift risk the SDK would otherwise eliminate.
 */

const lifecycleSchema = z.object({
  creator: z.string().min(1),
  bundle_id: z.string().min(1).max(128),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'expired']),
  submitted_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failure_message: z.string().nullable(),
});

const accessCredentialSchema = z.object({
  credential: z.string().min(1),
  expires_at: z.string(),
});

const frontendSessionSchema = z.object({
  session_token: z.string().min(1),
  creator: z.string().min(1),
});

export type LocksVerificationLifecycle = z.infer<typeof lifecycleSchema>;
export type LocksAccessCredential = z.infer<typeof accessCredentialSchema>;

/**
 * A Lock Server creator frontend session, exchanged from the one-time `code`
 * the hosted legacy-connect flow appends to `return_to`. The token is creator
 * bearer material — callers keep it in memory only.
 */
export type LocksFrontendSession = z.infer<typeof frontendSessionSchema>;

let sdkModulePromise: Promise<LocksSdkModule> | null = null;

/**
 * Loads and initializes the vendored Locks SDK WASM module exactly once. The dynamic
 * import keeps the ~1.2 MB WASM binary out of every server-rendered and initial-client
 * module graph; it is only fetched when a Locks operation actually runs in the browser.
 */
async function loadLocksSdk(): Promise<LocksSdkModule> {
  sdkModulePromise ??= (async () => {
    const sdk = await import('locks-sdk-wasm');
    await sdk.default();
    return sdk;
  })();
  try {
    return await sdkModulePromise;
  } catch (error) {
    // A failed WASM fetch/instantiation must stay retryable on the next call.
    sdkModulePromise = null;
    throw error;
  }
}

function toLocksError(error: unknown, operation: string): unknown {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return Err.server(ServerErrorCode.UNKNOWN_ERROR, 'Locks SDK call failed.', {
    service: ErrorService.Locks,
    operation,
    cause: error,
    context: { message },
  });
}

export class LocksGatewayService {
  private constructor() {}

  /**
   * Generates a canonical Locks bundle id through the vendored SDK. Bundle ids are
   * Crockford base32 identifiers validated by the Lock Server; callers must never
   * mint their own (upstream guidance: no hand-written substitutes for Locks
   * canonicalization or identifiers).
   */
  static async generateBundleId(): Promise<string> {
    try {
      const sdk = await loadLocksSdk();
      return sdk.BundleId.generate().toString();
    } catch (error) {
      throw toLocksError(error, 'generateBundleId');
    }
  }

  static async submitPaykitProof({
    creatorPubky,
    readerPubky,
    bundleId,
    lockResource,
    criterionId,
  }: {
    creatorPubky: string;
    readerPubky: string;
    bundleId: string;
    lockResource: string;
    criterionId: string;
  }): Promise<LocksVerificationLifecycle> {
    if (!lockResource.startsWith(`pubky://${creatorPubky}/`)) {
      throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Locks resource owner does not match the creator.', {
        service: ErrorService.Locks,
        operation: 'submitPaykitProof',
        context: { ownerMatches: false },
      });
    }
    const url = `${getLocksUrl()}/proof-bundles`;
    return await this.postLifecycle(url, {
      submitted_proof_bundle: {
        version: 1,
        bundle_id: bundleId,
        pubky_lock_resource: toLocksResource(lockResource),
        reader_public_key: withPubkyPrefix(readerPubky),
        proofs: [
          {
            criterion_id: criterionId,
            verifier_type: 'paykit-payment',
            payload: {},
          },
        ],
      },
    });
  }

  static async lookupVerification(creatorPubky: string, bundleId: string): Promise<LocksVerificationLifecycle> {
    const url = `${getLocksUrl()}/verification-task-lookups`;
    return await this.postLifecycle(url, {
      creator: withPubkyPrefix(creatorPubky),
      bundle_id: bundleId,
    });
  }

  static async issueAccessCredential(creatorPubky: string, bundleId: string): Promise<LocksAccessCredential> {
    const url = `${getLocksUrl()}/access-credentials`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creator: withPubkyPrefix(creatorPubky), bundle_id: bundleId }),
      },
      ErrorService.Locks,
      'issueAccessCredential',
    );
    if (!response.ok) throw httpResponseToError(response, ErrorService.Locks, 'issueAccessCredential', url);
    // Access credentials are bearer material — no body excerpt on parse failure.
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Locks, 'issueAccessCredential', url);
    const parsed = accessCredentialSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Locks returned an invalid access credential response.', {
        service: ErrorService.Locks,
        operation: 'issueAccessCredential',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static async fetchGuardedContent(relativePath: string, credential: string): Promise<Blob> {
    const safePath = relativePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `${getLocksUrl()}/priv-resources/content/${safePath}`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${credential}` } },
      ErrorService.Locks,
      'fetchGuardedContent',
    );
    if (!response.ok) throw httpResponseToError(response, ErrorService.Locks, 'fetchGuardedContent', url);
    return await response.blob();
  }

  /**
   * Exchanges the hosted legacy-connect completion (`code` + the caller's own
   * `state`, delivered to `return_to`) for a creator frontend session. This is
   * the client's proof that the Lock Server actually holds creator authority
   * for the signed-in seller — the setup UI must not claim "connected" from
   * anything weaker.
   */
  static async createFrontendSession(code: string, state: string): Promise<LocksFrontendSession> {
    const url = `${getLocksUrl()}/frontend-sessions`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state }),
      },
      ErrorService.Locks,
      'createFrontendSession',
    );
    if (!response.ok) throw httpResponseToError(response, ErrorService.Locks, 'createFrontendSession', url);
    // Frontend session_token is creator bearer material — no body excerpt.
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Locks, 'createFrontendSession', url);
    const parsed = frontendSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Locks returned an invalid frontend session response.', {
        service: ErrorService.Locks,
        operation: 'createFrontendSession',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static buildPaykitSetupUrl(returnTo: string, state: string): string {
    const url = new URL(getPaykitSetupUrl());
    url.searchParams.set('return_to', returnTo);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private static async postLifecycle(url: string, body: Record<string, unknown>): Promise<LocksVerificationLifecycle> {
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      ErrorService.Locks,
      'postLifecycle',
    );
    if (!response.ok) throw httpResponseToError(response, ErrorService.Locks, 'postLifecycle', url);
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Locks, 'postLifecycle', url);
    const parsed = lifecycleSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Locks returned an invalid lifecycle response.', {
        service: ErrorService.Locks,
        operation: 'postLifecycle',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }
}

function withPubkyPrefix(pubky: string): string {
  return pubky.startsWith('pubky') ? pubky : `pubky${pubky}`;
}

function toLocksResource(resource: string): string {
  return resource.startsWith('pubky://') ? `pubky${resource.slice('pubky://'.length)}` : resource;
}
