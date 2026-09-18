'use client';

import { useEffect, useState } from 'react';
import { getLocksUrl } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';

/**
 * The pending connect `state` nonce. localStorage on purpose: the hosted
 * legacy-connect flow completes in the tab the Lock Server redirects, which
 * is not necessarily the tab that initiated it, so per-tab sessionStorage
 * cannot carry the nonce across. The value is a random nonce (it also appears
 * in the redirect URL), never bearer material.
 */
const LOCKS_CONNECT_STATE_STORAGE_KEY = 'marketplace:locks-connect-state';

/**
 * Seller-side Lock Server connection: opens the hosted legacy-connect flow
 * and, when the Lock Server redirects back with a one-time `code`, exchanges
 * it for a creator frontend session. `connectedCreator` is therefore a REAL
 * completion signal — the Lock Server proved it holds creator authority for
 * the approved identity — never an optimistic assumption. The session token
 * itself stays in memory and is not (yet) used further by the app.
 */
export function useMarketplaceLocksConnect() {
  const [connectedCreator, setConnectedCreator] = useState<string | null>(null);
  const [isExchanging, setIsExchanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openConnect = () => {
    const state = crypto.randomUUID().replaceAll('-', '');
    window.localStorage.setItem(LOCKS_CONNECT_STATE_STORAGE_KEY, state);
    const url = new URL('/connect', getLocksUrl());
    url.searchParams.set('return_to', `${window.location.origin}${window.location.pathname}`);
    url.searchParams.set('state', state);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return;
    const pending = window.localStorage.getItem(LOCKS_CONNECT_STATE_STORAGE_KEY);
    if (pending !== state) {
      setError('The Locks connect completion did not match a connect request from this app.');
      return;
    }
    let active = true;
    setIsExchanging(true);
    CommerceController.createLocksFrontendSession(code, state)
      .then((session) => {
        if (!active) return;
        window.localStorage.removeItem(LOCKS_CONNECT_STATE_STORAGE_KEY);
        setConnectedCreator(session.creator.replace(/^pubky/, ''));
        // Drop the one-time code from the address bar so a reload does not
        // retry an already-consumed completion.
        window.history.replaceState(null, '', window.location.pathname);
      })
      .catch(() => {
        if (active) setError('The Lock Server rejected the connect completion. Start the connection again.');
      })
      .finally(() => {
        if (active) setIsExchanging(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { openConnect, connectedCreator, isExchanging, error };
}
