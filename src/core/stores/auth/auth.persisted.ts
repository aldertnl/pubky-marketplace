import { AUTH_PERSIST_KEY } from '@/stores/persistedKeys';

type PersistedAuthState = {
  currentUserPubky?: unknown;
  sessionExport?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function hasPersistedAuthIdentity(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_PERSIST_KEY);
    if (!raw) return false;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    const state = (parsed as { state?: unknown }).state;
    if (!state || typeof state !== 'object') return false;

    const authState = state as PersistedAuthState;
    return isNonEmptyString(authState.sessionExport) || isNonEmptyString(authState.currentUserPubky);
  } catch {
    return false;
  }
}
