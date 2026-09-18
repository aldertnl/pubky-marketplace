import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, MESSAGING_WRAP_BASE_DB_VERSION } from '@/database/franky/franky';
import { migrateMessagingSecretsToWrappedStorage } from '@/database/franky/franky.migrations';
import {
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from '@/libs/crypto/messaging-keyring';
import { buildWrapAad, unwrapPayload, WRAP_IV_BYTES, WRAP_VERSION_AES_GCM_256 } from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import type {
  CommerceMessagingLinkModelSchema,
  CommerceMessagingReceiverModelSchema,
} from '@/models/messaging/messaging.schema';

const OWNER = 'a'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);

/** A receiver row as version 4 wrote it: plaintext secret, no wrap_version. */
function legacyReceiverRow(): CommerceMessagingReceiverModelSchema {
  return {
    id: OWNER,
    noise_secret: new Uint8Array(32).fill(7),
    noise_public_key: 'n'.repeat(52),
    receiver_path: 'marketplace/wallet',
    marker_published: true,
    created_at: 1,
    updated_at: 1,
  };
}

/** A link row as version 4 wrote it: plaintext snapshot, no wrap_version. */
function legacyLinkRow(): CommerceMessagingLinkModelSchema {
  return {
    id: `${OWNER}:${COUNTERPARTY}`,
    owner_id: OWNER,
    counterparty_pubky: COUNTERPARTY,
    role: 'initiator',
    status: 'established',
    local_receiver_path: 'marketplace/wallet',
    remote_receiver_path: 'marketplace/wallet',
    remote_noise_public_key: 'p'.repeat(52),
    snapshot: new Uint8Array([9, 8, 7, 6]),
    created_at: 1,
    updated_at: 1,
  };
}

/** Creates a database exactly as the version-4 build did (full schema, plaintext rows). */
async function seedLegacyV4Database(name: string): Promise<{ receiver: Uint8Array; snapshot: Uint8Array }> {
  const legacy = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION);
  const seeded = { receiver: legacyReceiverRow().noise_secret, snapshot: legacyLinkRow().snapshot };
  await legacy.initialize();
  await legacy.commerce_messaging_receivers.put(legacyReceiverRow());
  await legacy.commerce_messaging_links.put(legacyLinkRow());
  // A non-messaging row, to prove the upgrade does not wipe unrelated state.
  await legacy.user_counts.put({ id: OWNER, followers: 3 } as never);
  legacy.close();
  return seeded;
}

describe('migrateMessagingSecretsToWrappedStorage (DB 4 → 5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('upgrades a version-4 database in place: no wipe, plaintext rows wrapped, unwrap round-trips', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    const seeded = await seedLegacyV4Database(name);

    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    const result = await upgraded.initialize();

    expect(result.wasDbReset).toBe(false);
    // Unrelated state survived — this was NOT the delete-and-recreate path.
    await expect(upgraded.user_counts.get(OWNER)).resolves.toMatchObject({ followers: 3 });

    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    expect(receiver.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
    expect([...receiver.noise_secret]).not.toEqual([...seeded.receiver]);

    const link = (await upgraded.commerce_messaging_links.get(`${OWNER}:${COUNTERPARTY}`))!;
    expect(link.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    expect([...link.snapshot]).not.toEqual([...seeded.snapshot]);

    // The wrapped rows unwrap back to the exact seeded plaintext under the
    // keyring key with the table+row-id AAD.
    const key = await getOrCreateWrappingKey();
    const unwrappedSecret = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_receivers', OWNER),
      receiver.noise_secret,
    );
    expect([...unwrappedSecret]).toEqual([...seeded.receiver]);
    const unwrappedSnapshot = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_links', `${OWNER}:${COUNTERPARTY}`),
      link.snapshot,
    );
    expect([...unwrappedSnapshot]).toEqual([...seeded.snapshot]);
    upgraded.close();
  });

  it('is idempotent: a second pass leaves the wrapped bytes untouched', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    await upgraded.initialize();

    const before = (await upgraded.commerce_messaging_receivers.get(OWNER))!.noise_secret;
    await migrateMessagingSecretsToWrappedStorage(upgraded);
    await migrateMessagingSecretsToWrappedStorage(upgraded);
    const after = (await upgraded.commerce_messaging_receivers.get(OWNER))!.noise_secret;
    expect([...after]).toEqual([...before]);
    upgraded.close();
  });

  it('heals a crash-interrupted upgrade on the next initialize (versions-match sweep)', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    const seeded = await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    await upgraded.initialize();

    // Simulate a row that stayed plaintext because the first pass crashed:
    // the DB is already at the new version, so only the sweep can reach it.
    await upgraded.commerce_messaging_receivers.put(legacyReceiverRow());
    const result = await upgraded.initialize();

    expect(result.wasDbReset).toBe(false);
    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    const key = await getOrCreateWrappingKey();
    const unwrapped = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_receivers', OWNER),
      receiver.noise_secret,
    );
    expect([...unwrapped]).toEqual([...seeded.receiver]);
    upgraded.close();
  });

  it('fails closed when WebCrypto is unavailable — never continues with plaintext', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);

    dropCachedWrappingKeyForTests();
    const { subtle: _subtle, ...rest } = globalThis.crypto;
    vi.stubGlobal('crypto', rest);

    await expect(upgraded.initialize()).rejects.toSatisfy((error) => isAppError(error));
    // The plaintext row is still there, unread by this build — not wiped, not "migrated".
    vi.unstubAllGlobals();
    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBeUndefined();
    upgraded.close();
    await resetMessagingKeyringForTests();
  });
});
