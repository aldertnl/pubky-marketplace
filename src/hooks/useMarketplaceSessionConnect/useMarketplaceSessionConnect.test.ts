import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '@/controllers/auth/auth';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { copyToClipboard } from '@/libs/utils/utils';
import type { CommerceMarketplaceSession } from '@/stores/commerce/commerce.types';
import { useMarketplaceSessionConnect } from './useMarketplaceSessionConnect';

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

const SESSION: CommerceMarketplaceSession = {
  pubky: 'z'.repeat(52),
  capabilities: '/pub/pubky.app/:rw',
  expiresAt: '2026-08-22T00:00:00.000Z',
  issuedAt: '2026-08-21T00:00:00.000Z',
};

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: { beginMarketplaceSessionConnect: vi.fn(), hasFullHomeserverGrant: vi.fn(() => true) },
}));

vi.mock('@/controllers/auth/auth', () => ({
  AuthController: {
    beginBridgedCommerceSessionFlow: vi.fn(),
    // The hook routes cancellation through the controller; the mock applies
    // the same net effect (the flow is freed) so cancel assertions hold.
    releaseAuthFlow: vi.fn((cancel: () => void) => cancel()),
  },
}));

vi.mock('@/libs/utils/utils', async () => {
  const actual = await vi.importActual<typeof import('@/libs/utils/utils')>('@/libs/utils/utils');
  return { ...actual, copyToClipboard: vi.fn().mockResolvedValue(undefined) };
});

/**
 * A controllable stand-in for one single-use session flow: the test decides
 * when the signer "approves" (resolve) or the flow fails (reject).
 */
function createDeferredFlow(url: string) {
  let resolveSession!: (session: CommerceMarketplaceSession) => void;
  let rejectSession!: (error: unknown) => void;
  const pending = new Promise<CommerceMarketplaceSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  const flow = {
    authorizationUrl: url,
    awaitSession: vi.fn(() => pending),
    cancel: vi.fn(),
  };
  return { flow, resolveSession, rejectSession };
}

describe('useMarketplaceSessionConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
  });

  it('starts idle with no URL and no error', () => {
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
    expect(result.current.errorMessage).toBeNull();
    expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
  });

  it('starts the bridged single-approval flow when the homeserver grant is not full', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());

    expect(AuthController.beginBridgedCommerceSessionFlow).toHaveBeenCalledTimes(1);
    expect(CommerceController.beginMarketplaceSessionConnect).not.toHaveBeenCalled();
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=full');
  });

  it('exposes requestsFullGrant so rendered copy and the started flow share one decision', () => {
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    const { result, rerender } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.requestsFullGrant).toBe(true);

    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(true);
    rerender();
    expect(result.current.requestsFullGrant).toBe(false);
  });

  it('never auto-starts the bridged flow: mounting with a narrow grant requests no URL', () => {
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');
    expect(AuthController.beginBridgedCommerceSessionFlow).not.toHaveBeenCalled();
  });

  it('flag off: starts the legacy empty-capability connect even with a narrow grant', async () => {
    process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN = 'false';
    const { resetRuntimeConfigForTests } = await import('@/libs/runtime-config/runtime-config');
    resetRuntimeConfigForTests();
    try {
      const { flow } = createDeferredFlow('pubkyauth:///?caps=empty');
      vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
      vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
      const { result } = renderHook(() => useMarketplaceSessionConnect());

      expect(result.current.requestsFullGrant).toBe(false);
      act(() => result.current.start());

      expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(1);
      expect(AuthController.beginBridgedCommerceSessionFlow).not.toHaveBeenCalled();
      expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=empty');
    } finally {
      delete process.env.PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN;
      resetRuntimeConfigForTests();
    }
  });

  it('frees a cancelled bridged flow THROUGH the controller so retry mints a fresh URL', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.cancel());

    expect(AuthController.releaseAuthFlow).toHaveBeenCalledWith(flow.cancel);
    expect(result.current.status).toBe('idle');
  });

  it('treats a controller-cancelled (superseded) flow as control flow: idle, not error', async () => {
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=full');
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');

    // A sign-in ceremony (or another start elsewhere) frees THIS flow through
    // the controller while the hook still points at it — that rejection is
    // control flow, not a failure.
    const canceledError = new Error('Auth flow canceled');
    canceledError.name = 'AuthFlowCanceled';
    rejectSession(canceledError);

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('');
  });

  it('a joined flow exposes the honest joined state — never awaiting with an empty URL', async () => {
    let resolveSession!: (session: CommerceMarketplaceSession) => void;
    const pending = new Promise<CommerceMarketplaceSession>((resolve) => {
      resolveSession = resolve;
    });
    // What AuthController.beginBridgedCommerceSessionFlow returns when a
    // direct sign-in ceremony is already in flight: no URL of its own.
    const joinedFlow = {
      authorizationUrl: '',
      joined: true,
      awaitSession: vi.fn(() => pending),
      cancel: vi.fn(),
    };
    vi.mocked(CommerceController.hasFullHomeserverGrant).mockReturnValue(false);
    vi.mocked(AuthController.beginBridgedCommerceSessionFlow).mockReturnValue(joinedFlow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());

    expect(result.current.status).toBe('joined');
    expect(result.current.authorizationUrl).toBe('');

    // The join still settles through the shared ceremony: one approval on the
    // other surface connects this session too.
    resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(onConnected).toHaveBeenCalledWith(SESSION);
  });

  it('exposes the authorization URL while awaiting and reports connected once the signer approves', async () => {
    const { flow, resolveSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=first');

    resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(onConnected).toHaveBeenCalledWith(SESSION);
    // The single-use URL is dead after resolution and must never be re-shown.
    expect(result.current.authorizationUrl).toBe('');
  });

  it('surfaces static failure copy and retries with a FRESH flow', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(first.flow)
      .mockReturnValueOnce(second.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    first.rejectSession(new Error('Relay timed out'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('The approval expired before it was completed. Try again.');
    expect(result.current.errorMessage).not.toContain('Relay timed out');
    expect(result.current.authorizationUrl).toBe('');

    act(() => result.current.start());
    expect(CommerceController.beginMarketplaceSessionConnect).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('awaiting');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');
  });

  it('surfaces the flow timeout as a visible, retryable error instead of awaiting forever', async () => {
    const timedOut = createDeferredFlow('pubkyauth:///?caps=first');
    const fresh = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(timedOut.flow)
      .mockReturnValueOnce(fresh.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    // The service-level timeout rejects awaitSession after SESSION_FLOW_TIMEOUT_MS.
    timedOut.rejectSession(
      new Error('The connect request expired before it was approved. Start again to get a fresh QR code.'),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBe('The approval expired before it was completed. Try again.');
    expect(result.current.errorMessage).not.toContain('expired before it was approved');

    act(() => result.current.start());
    expect(result.current.status).toBe('awaiting');
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');
  });

  it('reports an error when the flow cannot even start (e.g. non-durable mode)', () => {
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockImplementation(() => {
      throw new Error('The marketplace transaction service is not enabled in this deployment.');
    });
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toBe('Could not start the marketplace session.');
    expect(result.current.errorMessage).not.toContain('transaction service is not enabled');
  });

  it('cancel frees the flow, returns to idle, and drops the detached rejection silently', async () => {
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(flow.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.authorizationUrl).toBe('');

    // The freed flow rejecting afterwards is control flow, not a failure.
    rejectSession(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(result.current.errorMessage).toBeNull();
  });

  it('maps thrown sentinel failures to static copy and keeps the error message static', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_session';
    const { flow, rejectSession } = createDeferredFlow('pubkyauth:///?caps=sentinel');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    rejectSession(
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'sessionConnect',
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorMessage).toBeTypeOf('string');
    expect(result.current.errorMessage).not.toContain(sentinel);
  });

  it('a superseding start cancels the previous flow and ignores its late rejection', async () => {
    const first = createDeferredFlow('pubkyauth:///?caps=first');
    const second = createDeferredFlow('pubkyauth:///?caps=second');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect)
      .mockReturnValueOnce(first.flow)
      .mockReturnValueOnce(second.flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.start());
    expect(first.flow.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.authorizationUrl).toBe('pubkyauth:///?caps=second');

    first.rejectSession(new Error('flow freed'));
    await act(async () => {});
    expect(result.current.status).toBe('awaiting');

    second.resolveSession(SESSION);
    await waitFor(() => expect(result.current.status).toBe('connected'));
  });

  it('ignores an approval arriving after cancellation instead of connecting invisibly', async () => {
    const { flow, resolveSession } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const onConnected = vi.fn();
    const { result } = renderHook(() => useMarketplaceSessionConnect({ onConnected }));

    act(() => result.current.start());
    act(() => result.current.cancel());

    resolveSession(SESSION);
    await act(async () => {});
    expect(result.current.status).toBe('idle');
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('cancels the in-flight flow on unmount', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result, unmount } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    unmount();

    expect(flow.cancel).toHaveBeenCalledTimes(1);
  });

  it('copies the authorization URL only while one exists', async () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).not.toHaveBeenCalled();

    act(() => result.current.start());
    await act(() => result.current.copyAuthUrl());
    expect(copyToClipboard).toHaveBeenCalledWith({ text: 'pubkyauth:///?caps=first' });
  });

  it('opens the deeplink for same-device Ring and clears the opening state when the page hides', () => {
    const { flow } = createDeferredFlow('pubkyauth:///?caps=first');
    vi.mocked(CommerceController.beginMarketplaceSessionConnect).mockReturnValue(flow);
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, href: '' };
    Object.defineProperty(window, 'location', { configurable: true, value: mockLocation });
    const { result } = renderHook(() => useMarketplaceSessionConnect());

    act(() => result.current.start());
    act(() => result.current.openInRing());
    expect(mockLocation.href).toBe('pubkyauth:///?caps=first');
    expect(result.current.isOpeningRing).toBe(true);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.isOpeningRing).toBe(false);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });
});
