import { getOrCreateWrappingKey } from '@/libs/crypto/messaging-keyring';
import {
  buildWrapAad,
  isUnwrapAuthenticationError,
  unwrapPayload,
  WRAP_VERSION_AES_GCM_256,
  wrapPayload,
} from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingLinkModel,
  CommerceMessagingMessageModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
} from '@/models/messaging/messaging.models';
import type {
  CommerceMessagingConversationModelSchema,
  CommerceMessagingLinkModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
  CommerceMessagingReceiverModelSchema,
} from '@/models/messaging/messaging.schema';

const RECEIVERS_TABLE = 'commerce_messaging_receivers';
const LINKS_TABLE = 'commerce_messaging_links';

/**
 * Account-scoped Dexie persistence for encrypted marketplace messaging.
 *
 * Everything here is DEVICE-LOCAL by design. The receiver Noise secret and
 * link snapshots are key material, encrypted AT REST by this service:
 * wrapped with AES-GCM-256 under a non-extractable CryptoKey from the
 * messaging keyring (`@/libs/crypto/messaging-keyring`), AAD-bound to their
 * table + row id (`@/libs/crypto/secret-wrapping`). Reads unwrap on the way
 * out, so nothing outside this service sees the wrapping. Message bodies
 * are local plaintext history. None of it syncs anywhere, and none of it
 * may enter logs, telemetry, or projections.
 *
 * Failure posture: writes FAIL CLOSED (no wrapping key → AppError, never a
 * plaintext write); a row whose ciphertext fails authentication (lost key,
 * tampered/transplanted row) is treated as LOST — reads return `null`/skip
 * it, so the existing re-enable and re-handshake affordances take over.
 * `wrap_version` is TRI-STATE on read: 1 unwraps; absent/0 is legacy
 * plaintext from before the 4 → 5 migration (the migration wraps those rows
 * in place on upgrade and reads tolerate them until then); ANY OTHER value
 * (corrupted or future format) is treated as LOST exactly like an
 * authentication failure — feeding unwrappable bytes into the Noise binding
 * as plaintext key material is never an option.
 */
export class LocalMessagingService {
  private constructor() {}

  static async getReceiver(ownerId: string): Promise<CommerceMessagingReceiverModelSchema | null> {
    const row = await CommerceMessagingReceiverModel.findById(ownerId);
    if (!row) return null;
    if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
      const secret = await this.unwrapSecretField(RECEIVERS_TABLE, row.id, row.noise_secret, 'getReceiver');
      if (!secret) return null;
      return { ...row, noise_secret: secret };
    }
    if (this.isUnknownWrapVersion(row.wrap_version, RECEIVERS_TABLE, 'getReceiver')) return null;
    return row;
  }

  static async upsertReceiver(receiver: CommerceMessagingReceiverModelSchema): Promise<void> {
    const wrapped = await this.wrapSecretField(RECEIVERS_TABLE, receiver.id, receiver.noise_secret, 'upsertReceiver');
    await CommerceMessagingReceiverModel.upsert({
      ...receiver,
      noise_secret: wrapped,
      wrap_version: WRAP_VERSION_AES_GCM_256,
    });
  }

  static async getLink(ownerId: string, counterpartyPubky: string): Promise<CommerceMessagingLinkModelSchema | null> {
    const row = await CommerceMessagingLinkModel.findById(this.linkId(ownerId, counterpartyPubky));
    if (!row) return null;
    if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
      const snapshot = await this.unwrapSecretField(LINKS_TABLE, row.id, row.snapshot, 'getLink');
      if (!snapshot) return null;
      return { ...row, snapshot };
    }
    if (this.isUnknownWrapVersion(row.wrap_version, LINKS_TABLE, 'getLink')) return null;
    return row;
  }

  static async getLinksByOwner(ownerId: string): Promise<CommerceMessagingLinkModelSchema[]> {
    const rows = await CommerceMessagingLinkModel.findByOwner(ownerId);
    const links: CommerceMessagingLinkModelSchema[] = [];
    for (const row of rows) {
      if (row.wrap_version === WRAP_VERSION_AES_GCM_256) {
        // An unrecoverable link is skipped (lost): inbox sync simply never
        // probes that counterparty from local state again.
        const snapshot = await this.unwrapSecretField(LINKS_TABLE, row.id, row.snapshot, 'getLinksByOwner');
        if (!snapshot) continue;
        links.push({ ...row, snapshot });
      } else if (this.isUnknownWrapVersion(row.wrap_version, LINKS_TABLE, 'getLinksByOwner')) {
        continue;
      } else {
        links.push(row);
      }
    }
    return links;
  }

  static async upsertLink(link: Omit<CommerceMessagingLinkModelSchema, 'id'>): Promise<void> {
    const id = this.linkId(link.owner_id, link.counterparty_pubky);
    const wrapped = await this.wrapSecretField(LINKS_TABLE, id, link.snapshot, 'upsertLink');
    await CommerceMessagingLinkModel.upsert({
      ...link,
      id,
      snapshot: wrapped,
      wrap_version: WRAP_VERSION_AES_GCM_256,
    });
  }

  static async deleteLink(ownerId: string, counterpartyPubky: string): Promise<void> {
    await CommerceMessagingLinkModel.deleteById(this.linkId(ownerId, counterpartyPubky));
  }

  /**
   * Persists a fresh link snapshot for an existing row. Callers MUST persist
   * any received messages BEFORE calling this — the binding's read checkpoint
   * advances past returned messages, so an old snapshot is the only way to
   * re-read them after a crash.
   */
  static async updateLinkSnapshot(
    ownerId: string,
    counterpartyPubky: string,
    snapshot: Uint8Array,
    status: CommerceMessagingLinkModelSchema['status'],
    now: number,
  ): Promise<void> {
    const current = await this.getLink(ownerId, counterpartyPubky);
    if (!current) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'No messaging link row exists for this counterparty.', {
        service: ErrorService.Local,
        operation: 'updateLinkSnapshot',
      });
    }
    const id = this.linkId(ownerId, counterpartyPubky);
    const wrapped = await this.wrapSecretField(LINKS_TABLE, id, snapshot, 'updateLinkSnapshot');
    await CommerceMessagingLinkModel.upsert({
      ...current,
      snapshot: wrapped,
      wrap_version: WRAP_VERSION_AES_GCM_256,
      status,
      updated_at: now,
    });
  }

  static async getConversationsByOwner(ownerId: string): Promise<CommerceMessagingConversationModelSchema[]> {
    return await CommerceMessagingConversationModel.findByOwner(ownerId);
  }

  static async getConversation(
    ownerId: string,
    conversationId: string,
  ): Promise<CommerceMessagingConversationModelSchema | null> {
    return await CommerceMessagingConversationModel.findById(`${ownerId}:${conversationId}`);
  }

  /**
   * Creates the conversation row if absent; bumps `last_message_at`/`updated_at`
   * if newer. The read checkpoint (`last_read_at`) is owned by
   * `markConversationRead` and is never touched here.
   */
  static async touchConversation(
    conversation: Omit<CommerceMessagingConversationModelSchema, 'id' | 'created_at' | 'last_read_at'>,
  ): Promise<void> {
    const id = `${conversation.owner_id}:${conversation.conversation_id}`;
    const current = await CommerceMessagingConversationModel.findById(id);
    if (!current) {
      await CommerceMessagingConversationModel.upsert({
        ...conversation,
        id,
        last_read_at: null,
        created_at: conversation.updated_at,
      });
      return;
    }
    await CommerceMessagingConversationModel.upsert({
      ...current,
      last_message_at: latest(current.last_message_at, conversation.last_message_at),
      updated_at: Math.max(current.updated_at, conversation.updated_at),
    });
  }

  /**
   * Moves the device-local read checkpoint forward (never backward). Called
   * when the conversation surface is actually showing its messages.
   */
  static async markConversationRead(ownerId: string, conversationId: string, now: number): Promise<void> {
    const current = await CommerceMessagingConversationModel.findById(`${ownerId}:${conversationId}`);
    if (!current) return;
    if (current.last_read_at !== null && current.last_read_at >= now) return;
    await CommerceMessagingConversationModel.upsert({ ...current, last_read_at: now });
  }

  /**
   * Honest device-local unread: conversations holding at least one RECEIVED
   * message persisted after the read checkpoint. Counts only messages that
   * already arrived on this device — it can never claim knowledge of
   * undelivered mail sitting on a homeserver.
   */
  static async countUnreadConversations(ownerId: string): Promise<number> {
    const conversations = await CommerceMessagingConversationModel.findByOwner(ownerId);
    let unread = 0;
    for (const conversation of conversations) {
      const checkpoint = conversation.last_read_at ?? 0;
      const messages = await CommerceMessagingMessageModel.findByConversation(ownerId, conversation.conversation_id);
      if (messages.some((message) => message.direction === 'received' && message.recorded_at > checkpoint)) {
        unread += 1;
      }
    }
    return unread;
  }

  static async getMessages(ownerId: string, conversationId: string): Promise<CommerceMessagingMessageModelSchema[]> {
    return await CommerceMessagingMessageModel.findByConversation(ownerId, conversationId);
  }

  /**
   * Idempotent by construction: the row id is `${owner}:${event_id}` (the
   * sender-minted envelope UUID), so a replayed delivery (expected after a
   * snapshot restore) overwrites itself instead of duplicating.
   */
  static async upsertMessage(eventId: string, message: Omit<CommerceMessagingMessageModelSchema, 'id'>): Promise<void> {
    await CommerceMessagingMessageModel.upsert({ ...message, id: `${message.owner_id}:${eventId}` });
  }

  // --- queued-message outbox -------------------------------------------------
  // Device-local plaintext rows for messages composed while the Encrypted
  // Link was not ready. Same at-rest posture as history (see the schema file
  // header); cleared with every other table on sign-out (`clearDatabase()`).

  static async enqueueOutboxMessage(row: CommerceMessagingOutboxModelSchema): Promise<void> {
    await CommerceMessagingOutboxModel.upsert(row);
  }

  /** Queued rows toward one counterparty, oldest first — the flush order. */
  static async getQueuedMessages(
    ownerPubky: string,
    counterpartyPubky: string,
  ): Promise<CommerceMessagingOutboxModelSchema[]> {
    return await CommerceMessagingOutboxModel.findByOwnerAndCounterparty(ownerPubky, counterpartyPubky);
  }

  /** All of one account's queued rows, oldest first. */
  static async getQueuedMessagesByOwner(ownerPubky: string): Promise<CommerceMessagingOutboxModelSchema[]> {
    return await CommerceMessagingOutboxModel.findByOwner(ownerPubky);
  }

  /**
   * Deletes one queued row, but only when it belongs to `ownerPubky` —
   * account isolation for cancel and flush alike. A missing row is a no-op
   * (it was already delivered or cancelled).
   */
  static async deleteOutboxMessage(ownerPubky: string, id: string): Promise<void> {
    const row = await CommerceMessagingOutboxModel.findById(id);
    if (!row || row.owner_pubky !== ownerPubky) return;
    await CommerceMessagingOutboxModel.deleteById(id);
  }

  /** Records one failed flush attempt on a queued row (attempts, time, error). */
  static async recordOutboxFailure(ownerPubky: string, id: string, error: string, now: number): Promise<void> {
    const row = await CommerceMessagingOutboxModel.findById(id);
    if (!row || row.owner_pubky !== ownerPubky) return;
    await CommerceMessagingOutboxModel.upsert({
      ...row,
      attempts: row.attempts + 1,
      last_attempt_at: now,
      last_error: error,
    });
  }

  private static linkId(ownerId: string, counterpartyPubky: string): string {
    return `${ownerId}:${counterpartyPubky}`;
  }

  /**
   * Tri-state `wrap_version` guard: `1` is handled by the unwrap path and
   * absent/0 is legacy plaintext — both return false here. ANY OTHER value
   * (a corrupted or future format marker) means the row's bytes are NOT
   * plaintext key material and cannot be unwrapped by this build, so the row
   * is treated as LOST exactly like an authentication failure: never served
   * to the Noise binding. Logs `{operation, table}` only — never row bytes.
   */
  private static isUnknownWrapVersion(wrapVersion: number | undefined, table: string, operation: string): boolean {
    if (wrapVersion === undefined || wrapVersion === 0 || wrapVersion === WRAP_VERSION_AES_GCM_256) return false;
    Logger.warn('A messaging row carries an unknown wrap_version; treating it as lost', { operation, table });
    return true;
  }

  /**
   * Wraps a secret field for at-rest storage under a fresh IV, AAD-bound to
   * its table + row id. FAIL CLOSED: with no working wrapping key this
   * throws — a plaintext write is never an option.
   */
  private static async wrapSecretField(
    table: string,
    rowId: string,
    plaintext: Uint8Array,
    operation: string,
  ): Promise<Uint8Array> {
    try {
      const key = await getOrCreateWrappingKey();
      return await wrapPayload(key, buildWrapAad(table, rowId), plaintext);
    } catch (error) {
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to wrap a messaging secret for at-rest storage.', {
        service: ErrorService.Local,
        operation,
        cause: error,
      });
    }
  }

  /**
   * Unwraps a stored secret field. Returns `null` when the ciphertext fails
   * authentication (lost wrapping key, tampered or transplanted row): the
   * row is unrecoverable and callers treat it as absent so the existing
   * re-enable/re-handshake affordances take over. Environmental failures
   * (WebCrypto/IDB unavailable) THROW — fail closed, never silent data loss.
   */
  private static async unwrapSecretField(
    table: string,
    rowId: string,
    wrapped: Uint8Array,
    operation: string,
  ): Promise<Uint8Array | null> {
    try {
      const key = await getOrCreateWrappingKey();
      return await unwrapPayload(key, buildWrapAad(table, rowId), wrapped);
    } catch (error) {
      if (isUnwrapAuthenticationError(error)) {
        Logger.warn('A wrapped messaging secret is unrecoverable (lost key or tampered row); treating it as lost', {
          operation,
          table,
        });
        return null;
      }
      if (isAppError(error)) throw error;
      throw Err.database(DatabaseErrorCode.QUERY_FAILED, 'Failed to unwrap a messaging secret from at-rest storage.', {
        service: ErrorService.Local,
        operation,
        cause: error,
      });
    }
  }
}

function latest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
