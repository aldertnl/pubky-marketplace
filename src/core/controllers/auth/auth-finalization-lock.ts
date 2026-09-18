export const AUTH_FINALIZATION_LOCK_NAME = 'pubky-auth-finalization-v1';

let fallbackTail: Promise<void> = Promise.resolve();

function withInProcessLock<T>(callback: () => Promise<T>): Promise<T> {
  const run = fallbackTail.then(callback, callback);
  fallbackTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function withAuthFinalizationLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    let callbackStarted = false;
    try {
      return await locks.request(AUTH_FINALIZATION_LOCK_NAME, { mode: 'exclusive' }, async () => {
        callbackStarted = true;
        return await callback();
      });
    } catch (error) {
      if (callbackStarted) {
        throw error;
      }
    }
  }

  return await withInProcessLock(callback);
}
