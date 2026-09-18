import { getOrCreateWrappingKey } from '@/libs/crypto/messaging-keyring';
import { buildWrapAad, WRAP_VERSION_AES_GCM_256, wrapPayload } from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import type { AppDatabase } from './franky';

/**
 * Data migration for DB version 4 → 5: wraps the two messaging key-material
 * columns (`commerce_messaging_receivers.noise_secret`,
 * `commerce_messaging_links.snapshot`) in place with AES-GCM-256 under the
 * non-extractable keyring key, AAD-bound to table + row id. The Dexie schema
 * itself is unchanged between those versions (the wrap format rides in the
 * existing `Uint8Array` columns plus the non-indexed `wrap_version` field),
 * so the bump only marks this data pass.
 *
 * IDEMPOTENT by construction: rows already at `wrap_version: 1` are skipped,
 * so a crash mid-pass simply resumes on the next run (see the versions-match
 * sweep in `runInitialize`). Runs BEFORE any messaging read can hand out a
 * legacy row in the upgraded build.
 *
 * FAIL CLOSED: any failure (WebCrypto/IDB unavailable, write error) throws —
 * an upgrade that cannot wrap must not continue with known-plaintext secrets.
 */
export async function migrateMessagingSecretsToWrappedStorage(database: AppDatabase): Promise<void> {
  const receivers = await database.commerce_messaging_receivers.toArray();
  const links = await database.commerce_messaging_links.toArray();
  const legacyReceivers = receivers.filter((row) => row.wrap_version !== WRAP_VERSION_AES_GCM_256);
  const legacyLinks = links.filter((row) => row.wrap_version !== WRAP_VERSION_AES_GCM_256);
  if (legacyReceivers.length === 0 && legacyLinks.length === 0) return;

  try {
    const key = await getOrCreateWrappingKey();
    for (const receiver of legacyReceivers) {
      const wrapped = await wrapPayload(
        key,
        buildWrapAad('commerce_messaging_receivers', receiver.id),
        receiver.noise_secret,
      );
      await database.commerce_messaging_receivers.put({
        ...receiver,
        noise_secret: wrapped,
        wrap_version: WRAP_VERSION_AES_GCM_256,
      });
    }
    for (const link of legacyLinks) {
      const wrapped = await wrapPayload(key, buildWrapAad('commerce_messaging_links', link.id), link.snapshot);
      await database.commerce_messaging_links.put({
        ...link,
        snapshot: wrapped,
        wrap_version: WRAP_VERSION_AES_GCM_256,
      });
    }
    Logger.info('Wrapped legacy plaintext messaging secrets at rest (DB 4 → 5)', {
      receivers: legacyReceivers.length,
      links: legacyLinks.length,
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Failed to wrap legacy plaintext messaging secrets at rest; refusing to continue with them unencrypted.',
      { service: ErrorService.Local, operation: 'migrateMessagingSecretsToWrappedStorage', cause: error },
    );
  }
}
