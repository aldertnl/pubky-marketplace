/**
 * Custody for the messaging at-rest wrapping key.
 *
 * A single AES-GCM-256 CryptoKey, generated on first use as
 * NON-EXTRACTABLE (the raw key bytes can never leave WebCrypto into JS),
 * persisted in its own tiny IndexedDB database — separate from the main
 * Dexie database so this module stays free of database-layer cycles
 * (the main database's migrations depend on this key). Same design as the
 * sibling product's proven WebKeyStore, adapted to this repo's layering:
 * pure AEAD helpers live in `./secret-wrapping`; services compose both.
 *
 * FAIL CLOSED, always: if WebCrypto or IndexedDB is unavailable, every
 * operation throws an `Err.database` AppError — there is NO plaintext
 * fallback. Losing this key (profile wipe without the database, targeted
 * deletion) makes every wrapped row unrecoverable; the service layer
 * treats such rows as lost and the user re-enables messaging.
 */

import { DB_NAME } from '@/config/database';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';

const KEYRING_DB_NAME = `${DB_NAME}-messaging-keyring`;
const KEYRING_DB_VERSION = 1;
const KEYRING_STORE_NAME = 'wrapping-key';
const WRAPPING_KEY_RECORD_ID = 'wrapping-key';

let cachedKey: CryptoKey | null = null;
let keyringDbPromise: Promise<IDBDatabase> | null = null;
let wrappingKeyPromise: Promise<CryptoKey> | null = null;

/**
 * Fail-closed precondition for every custody operation: AES-GCM wrapping
 * needs `crypto.subtle`, IVs need a CSPRNG, and persistence needs IDB.
 * Throws an AppError (never returns a degraded mode) when any is missing.
 */
function assertMessagingCryptoAvailable(operation: string): void {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.subtle !== 'object' || crypto.subtle === null) {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'WebCrypto (crypto.subtle) is unavailable; messaging key custody cannot operate and never falls back to plaintext.',
      { service: ErrorService.Local, operation },
    );
  }
  if (typeof crypto.getRandomValues !== 'function') {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'crypto.getRandomValues is unavailable; messaging key custody cannot operate without a CSPRNG.',
      { service: ErrorService.Local, operation },
    );
  }
  if (typeof indexedDB === 'undefined') {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'IndexedDB is unavailable; the messaging wrapping key has nowhere to persist.',
      { service: ErrorService.Local, operation },
    );
  }
}

function openKeyringDb(): Promise<IDBDatabase> {
  keyringDbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(KEYRING_DB_NAME, KEYRING_DB_VERSION);
    request.onerror = () => {
      // A failed open must stay retryable on the next call.
      keyringDbPromise = null;
      reject(request.error ?? new Error('Failed to open the messaging keyring database'));
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEYRING_STORE_NAME)) {
        request.result.createObjectStore(KEYRING_STORE_NAME);
      }
    };
  });
  return keyringDbPromise;
}

function isUsableWrappingKey(candidate: unknown): candidate is CryptoKey {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as CryptoKey).type === 'secret' &&
    (candidate as CryptoKey).algorithm?.name === 'AES-GCM' &&
    Array.isArray((candidate as CryptoKey).usages) &&
    (candidate as CryptoKey).usages.includes('encrypt') &&
    (candidate as CryptoKey).usages.includes('decrypt')
  );
}

/**
 * Loads the persisted wrapping key, generating and persisting a fresh
 * NON-EXTRACTABLE AES-GCM-256 key on first use. The resolved key is cached
 * in memory for the session (one IDB read per load, zero per wrap).
 *
 * Creation is race-proof in both directions: the whole load-or-create is
 * single-flighted behind one module-level promise (two concurrent in-tab
 * first-use callers share it, so exactly one key is ever generated per
 * tab), and the read + write run inside ONE `readwrite` transaction as
 * get-then-`add` — a `ConstraintError` means another tab won the create
 * race, in which case this caller re-reads and adopts the STORED key
 * (persisting its own would orphan every row wrapped under the winner).
 * When the platform offers Web Locks, the create path additionally runs
 * inside a named lock for hard cross-tab exclusion.
 *
 * Throws (fail closed) when WebCrypto/IDB is unavailable or persistence
 * fails — callers must never see a "keyless" mode.
 */
export async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!wrappingKeyPromise) {
    const pending = loadOrCreateWrappingKey().then((key) => {
      cachedKey = key;
      return key;
    });
    // A failed load stays retryable on the next call — but only clear the
    // slot if no newer attempt has already taken it.
    pending.catch(() => {
      if (wrappingKeyPromise === pending) wrappingKeyPromise = null;
    });
    wrappingKeyPromise = pending;
  }
  return wrappingKeyPromise;
}

async function loadOrCreateWrappingKey(): Promise<CryptoKey> {
  assertMessagingCryptoAvailable('getOrCreateWrappingKey');
  try {
    // Hard cross-tab exclusion when available: two tabs racing first use
    // (e.g. the boot sweep) serialize on this lock, so the loser's read
    // below sees the winner's key. Falls back cleanly to the get-then-add
    // guard when Web Locks is unavailable.
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      return await locks.request(KEYRING_DB_NAME, () => readOrAddWrappingKey());
    }
    return await readOrAddWrappingKey();
  } catch (error) {
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Failed to load or create the messaging wrapping key; refusing to operate without it.',
      { service: ErrorService.Local, operation: 'getOrCreateWrappingKey', cause: error },
    );
  }
}

/**
 * The read-modify-write behind {@link getOrCreateWrappingKey}: get-then-`add`
 * (never `put`) inside ONE `readwrite` transaction, so a concurrent creator
 * in another tab surfaces as a `ConstraintError` instead of silently
 * overwriting the stored key. The unusable-record heal path deletes the dead
 * record first and still `add`s, keeping that same adoption guard. The fresh
 * key is generated BEFORE the transaction opens — an awaited WebCrypto call
 * between two requests would let the transaction auto-commit and close.
 */
function readOrAddWrappingKey(): Promise<CryptoKey> {
  return (async () => {
    const db = await openKeyringDb();
    const generated = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    return new Promise<CryptoKey>((resolve, reject) => {
      const transaction = db.transaction(KEYRING_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(KEYRING_STORE_NAME);

      const adoptExistingOrAdd = (existing: unknown) => {
        if (isUsableWrappingKey(existing)) {
          resolve(existing);
          return;
        }
        if (existing !== undefined) {
          // A record that is not a usable AES-GCM key can never unwrap
          // anything; replace it rather than failing every row read forever.
          // `delete` then `add` (NOT `put`): clearing the dead record first
          // keeps the cross-tab adoption guard below intact — a racing tab
          // whose `add` lands between our delete and our add still surfaces
          // as a ConstraintError, and we adopt its key instead of clobbering
          // it (which a blind `put` would do, orphaning its wrapped rows).
          Logger.warn('Messaging keyring held an unusable record; replacing it with a fresh wrapping key');
          store.delete(WRAPPING_KEY_RECORD_ID);
        }
        const addRequest = store.add(generated, WRAPPING_KEY_RECORD_ID);
        addRequest.onsuccess = () => resolve(generated);
        addRequest.onerror = (event) => {
          if (addRequest.error?.name !== 'ConstraintError') {
            reject(addRequest.error ?? new Error('Failed to persist the messaging wrapping key'));
            return;
          }
          // Another tab won the create race between our read and this add.
          // Keep the transaction alive (a request error aborts it by default)
          // and adopt the stored key — NEVER persist ours.
          event.preventDefault();
          const rereadRequest = store.get(WRAPPING_KEY_RECORD_ID);
          rereadRequest.onsuccess = () => {
            if (isUsableWrappingKey(rereadRequest.result)) {
              resolve(rereadRequest.result);
            } else {
              reject(new Error('Messaging keyring create race lost, but the winning record is unusable'));
            }
          };
          rereadRequest.onerror = () =>
            reject(rereadRequest.error ?? new Error('Messaging keyring re-read after a lost create race failed'));
        };
      };

      const getRequest = store.get(WRAPPING_KEY_RECORD_ID);
      getRequest.onsuccess = () => adoptExistingOrAdd(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error ?? new Error('Messaging keyring read failed'));
    });
  })();
}

/**
 * Deletes the wrapping key and its database. Best-effort: called from
 * `clearDatabase()` on sign-out/account switch, where every wrapped row is
 * being wiped anyway — a key that outlives its ciphertexts protects nothing,
 * so a deletion failure is logged, never fatal.
 */
export async function deleteWrappingKeyStore(): Promise<void> {
  cachedKey = null;
  wrappingKeyPromise = null;
  if (keyringDbPromise) {
    try {
      (await keyringDbPromise).close();
    } catch {
      // Closing is hygiene; deletion below is the operation that matters.
    }
    keyringDbPromise = null;
  }
  if (typeof indexedDB === 'undefined') return;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(KEYRING_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Failed to delete the messaging keyring database'));
      request.onblocked = () => resolve();
    });
  } catch (error) {
    Logger.warn('Could not delete the messaging keyring database', { error });
  }
}

/**
 * Test seam: drops the in-memory cache AND the persisted key, simulating a
 * lost wrapping key (profile wipe without the main database). Never used in
 * production — sign-out goes through {@link deleteWrappingKeyStore}.
 */
export async function resetMessagingKeyringForTests(): Promise<void> {
  await deleteWrappingKeyStore();
}

/**
 * Test seam: drops ONLY the in-memory cache, simulating a browser reload
 * (the persisted key survives and must be reloaded). Never used in production.
 */
export function dropCachedWrappingKeyForTests(): void {
  cachedKey = null;
}
