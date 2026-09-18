'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSingleApprovalSignInEnabled } from '@/config/app';
import { AuthController } from '@/controllers/auth/auth';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { Logger } from '@/libs/logger/logger';
import { copyToClipboard } from '@/libs/utils/utils';
import { AUTH_FLOW_CANCELED_ERROR_NAME } from '@/services/homeserver/error.utils';
import type {
  MarketplaceSessionConnectStatus,
  UseMarketplaceSessionConnectOptions,
  UseMarketplaceSessionConnectReturn,
} from './useMarketplaceSessionConnect.types';

type ActiveFlow =
  | ReturnType<typeof CommerceController.beginMarketplaceSessionConnect>
  | ReturnType<typeof AuthController.beginBridgedCommerceSessionFlow>;

/**
 * Drives the interactive marketplace session-connect flow (durable modes
 * only): a fresh `pubkyauth://` URL for the user's signer, a pending
 * approval, cancellation, and retry. AuthToken flows are single-use, so
 * `start()` always begins a NEW flow — after an error or cancellation the
 * previous URL is dead and is never re-shown.
 *
 * Cancellation is detected by identity, not by error shape: `cancel()` and
 * `start()` first detach the current flow, so a rejection arriving from a
 * detached flow is dropped silently instead of being surfaced as a failure.
 */
export function useMarketplaceSessionConnect(
  options: UseMarketplaceSessionConnectOptions = {},
): UseMarketplaceSessionConnectReturn {
  const [status, setStatus] = useState<MarketplaceSessionConnectStatus>('idle');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOpeningRing, setIsOpeningRing] = useState(false);
  const activeFlowRef = useRef<ActiveFlow | null>(null);
  const onConnectedRef = useRef(options.onConnected);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  // Keep the latest callback without making `start` depend on its identity.
  useEffect(() => {
    onConnectedRef.current = options.onConnected;
  });

  const removeVisibilityHandler = useCallback(() => {
    if (visibilityHandlerRef.current) {
      document.removeEventListener('visibilitychange', visibilityHandlerRef.current);
      visibilityHandlerRef.current = null;
    }
  }, []);

  const detachActiveFlow = useCallback(() => {
    const flow = activeFlowRef.current;
    activeFlowRef.current = null;
    // Route through the controller: when this flow is still the tracked
    // active flow, the ceremony guard is torn down with it, so a retry mints
    // a FRESH single-use URL instead of joining the cancelled ceremony and
    // re-showing its dead QR. Untracked (empty-capability) flows degrade to
    // the plain cancel.
    if (flow) AuthController.releaseAuthFlow(flow.cancel);
  }, []);

  /**
   * The ONE decision of which consent this dialog asks for, computed here so
   * the rendered copy and the flow `start()` actually begins can never
   * diverge (the dialog renders this value; it must not re-evaluate it).
   */
  const requestsFullGrant = isSingleApprovalSignInEnabled() && !CommerceController.hasFullHomeserverGrant();

  const start = useCallback(() => {
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setErrorMessage(null);

    let flow: ActiveFlow;
    try {
      flow = requestsFullGrant
        ? AuthController.beginBridgedCommerceSessionFlow()
        : CommerceController.beginMarketplaceSessionConnect();
    } catch (error) {
      Logger.error('Failed to start the marketplace session flow', { error });
      setAuthorizationUrl('');
      setErrorMessage(
        marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.sessionStart),
      );
      setStatus('error');
      return;
    }

    activeFlowRef.current = flow;
    // A JOINED flow's approval lives on another surface (e.g. a sign-in in
    // progress): that surface holds the only scannable URL, so this hook
    // exposes the honest `joined` state — never `awaiting` with an empty URL
    // (a blank, un-scannable QR with Copy/Open dead). The join still settles
    // through the same awaitSession below.
    if ('joined' in flow && flow.joined) {
      setAuthorizationUrl('');
      setStatus('joined');
    } else {
      setAuthorizationUrl(flow.authorizationUrl);
      setStatus('awaiting');
    }

    flow
      .awaitSession()
      .then((session) => {
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        setAuthorizationUrl('');
        setStatus('connected');
        onConnectedRef.current?.(session);
      })
      .catch((error: unknown) => {
        // A detached flow (cancelled or superseded) rejects as a side effect
        // of being freed — that is control flow, not a failure to report.
        if (activeFlowRef.current !== flow) return;
        activeFlowRef.current = null;
        // The CONTROLLER can also free this flow out from under the hook: a
        // sign-in ceremony or a second start() anywhere supersedes it via
        // `AuthController.cancelActiveAuthFlow`. The SDK canceled error that
        // rejection carries is control flow too — the superseded flow ends
        // idle, never error, and surfaces no toast.
        if (
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          (error as { name?: unknown }).name === AUTH_FLOW_CANCELED_ERROR_NAME
        ) {
          setAuthorizationUrl('');
          setStatus('idle');
          return;
        }
        Logger.error('Marketplace session flow failed', { error });
        setAuthorizationUrl('');
        setErrorMessage(
          marketplaceFailureMessage(marketplaceErrorCode(error), MARKETPLACE_FAILURE_MESSAGES.sessionTimeout, error),
        );
        setStatus('error');
      });
  }, [detachActiveFlow, removeVisibilityHandler, requestsFullGrant]);

  const cancel = useCallback(() => {
    detachActiveFlow();
    removeVisibilityHandler();
    setIsOpeningRing(false);
    setAuthorizationUrl('');
    setErrorMessage(null);
    setStatus('idle');
  }, [detachActiveFlow, removeVisibilityHandler]);

  const copyAuthUrl = useCallback(async () => {
    if (!authorizationUrl) return;
    await copyToClipboard({ text: authorizationUrl });
  }, [authorizationUrl]);

  const openInRing = useCallback(() => {
    if (!authorizationUrl) return;
    removeVisibilityHandler();
    setIsOpeningRing(true);
    const onVisibilityChange = () => {
      if (document.hidden) {
        removeVisibilityHandler();
        setIsOpeningRing(false);
      }
    };
    visibilityHandlerRef.current = onVisibilityChange;
    document.addEventListener('visibilitychange', onVisibilityChange, { once: true });
    window.location.href = authorizationUrl;
  }, [authorizationUrl, removeVisibilityHandler]);

  useEffect(() => {
    return () => {
      // Unmount cancels outright: unlike sign-in, nothing global consumes the
      // approval — without a mounted dialog the session would connect
      // invisibly, and the single-use flow is cheap to restart.
      detachActiveFlow();
      removeVisibilityHandler();
    };
  }, [detachActiveFlow, removeVisibilityHandler]);

  return {
    status,
    authorizationUrl,
    errorMessage,
    requestsFullGrant,
    start,
    cancel,
    copyAuthUrl,
    openInRing,
    isOpeningRing,
  };
}
