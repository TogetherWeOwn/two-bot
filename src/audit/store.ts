import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';
import type { AuditChannel, OperationalAuditEvent, OperationalAuditKind } from './events.ts';

export type AuditDeliveryState = 'none' | 'pending' | 'delivering' | 'delivered';

export interface StoredOperationalAudit {
  event: OperationalAuditEvent;
  mirrorChannelId: string | null;
  deliveryState: AuditDeliveryState;
  deliveryAttempts: number;
  deliveryClaimToken: string | null;
  deliveryNonce: string | null;
  deliverySearchBefore: string | null;
  mirrorMessageId: string | null;
  deliveryLastError: string | null;
}

export class OperationalAuditStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async record(event: OperationalAuditEvent, mirrorChannelId: string | null = null): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO operational_audit_log
           (entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
            source_channel_id, destination_channel_id, message_id, action,
            metadata_json, created_at, mirror_channel_id, delivery_state,
            delivery_attempts, delivery_attempted_at, delivery_last_error,
            delivery_lease_until, mirrored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)
         ON CONFLICT (entry_id) DO NOTHING`,
      )
      .run(
        event.entryId,
        event.kind,
        event.guildId,
        event.occurredAt,
        event.actorId ?? null,
        event.targetId ?? null,
        event.sourceChannelId ?? null,
        event.destinationChannelId ?? null,
        event.messageId ?? null,
        event.action ?? null,
        JSON.stringify(event.metadata ?? {}),
        now,
        mirrorChannelId,
        mirrorChannelId ? 'pending' : 'none',
      );
    return result.changes === 1;
  }

  async get(entryId: string): Promise<StoredOperationalAudit | null> {
    const row = await this.db.prepare(`${SELECT_AUDIT} WHERE entry_id = ?`).get<Record<string, unknown>>(entryId);
    return row ? storedAudit(row) : null;
  }

  async claim(entryId: string, leaseMs = AUDIT_DELIVERY_LEASE_MS): Promise<StoredOperationalAudit | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const claimToken = randomUUID();
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'delivering',
                delivery_lease_until = ?,
                delivery_claim_token = ?,
                delivery_nonce = COALESCE(delivery_nonce, ?)
          WHERE entry_id = ?
            AND mirror_channel_id IS NOT NULL
            AND (delivery_state = 'pending'
              OR (delivery_state = 'delivering' AND delivery_lease_until < ?))`,
      )
      .run(leaseUntil, claimToken, deliveryNonce(entryId), entryId, now.toISOString());
    return result.changes === 1 ? await this.get(entryId) : null;
  }

  async claimPending(limit = 25, leaseMs = AUDIT_DELIVERY_LEASE_MS): Promise<StoredOperationalAudit[]> {
    const rows = await this.db
      .prepare(
        `${SELECT_AUDIT}
          WHERE mirror_channel_id IS NOT NULL
            AND (delivery_state = 'pending'
              OR (delivery_state = 'delivering' AND delivery_lease_until < ?))
          ORDER BY created_at, entry_id LIMIT ?`,
      )
      .all<Record<string, unknown>>(new Date().toISOString(), limit);
    const claimed: StoredOperationalAudit[] = [];
    for (const row of rows) {
      const item = await this.claim(String(row.entry_id), leaseMs);
      if (item) claimed.push(item);
    }
    return claimed;
  }

  async authorizeDeliverySend(entryId: string, claimToken: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_lease_until = '9999-12-31T23:59:59.999Z'
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?
            AND delivery_search_before IS NOT NULL
            AND delivery_lease_until IS NOT NULL`,
      )
      .run(entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_send_not_authorized');
  }

  async saveDeliverySearchBefore(entryId: string, claimToken: string, before: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_search_before = COALESCE(delivery_search_before, ?)
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(before, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_search_bound_not_persisted');
  }

  async extendDeliveryLease(
    entryId: string,
    claimToken: string,
    leaseMs = AUDIT_DELIVERY_LEASE_MS,
  ): Promise<void> {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_lease_until = ?
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(leaseUntil, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_lease_not_extended');
  }

  async markDelivered(entryId: string, claimToken: string, messageId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'delivered',
                delivery_attempts = delivery_attempts + 1,
                delivery_attempted_at = ?,
                delivery_last_error = NULL,
                delivery_lease_until = NULL,
                delivery_claim_token = NULL,
                mirror_message_id = ?,
                mirrored_at = ?
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(now, messageId, now, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_ack_not_persisted');
  }

  async markAcknowledgementFailed(
    entryId: string,
    claimToken: string,
    leaseMs = AUDIT_DELIVERY_LEASE_MS,
  ): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_attempts = delivery_attempts + 1,
                delivery_attempted_at = ?,
                delivery_last_error = 'delivery_ack_failed',
                delivery_lease_until = ?
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(now.toISOString(), leaseUntil, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_ack_failure_not_persisted');
  }

  async markDeliveryFailed(entryId: string, claimToken: string, classification: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'pending',
                delivery_attempts = delivery_attempts + 1,
                delivery_attempted_at = ?,
                delivery_last_error = ?,
                delivery_lease_until = NULL,
                delivery_claim_token = NULL
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(new Date().toISOString(), classification.slice(0, 120), entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_failure_not_persisted');
  }
}

const SELECT_AUDIT =
  `SELECT entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
          source_channel_id, destination_channel_id, message_id, action,
          metadata_json, mirror_channel_id, delivery_state, delivery_attempts,
          delivery_claim_token, delivery_nonce, delivery_search_before,
          mirror_message_id, delivery_last_error
     FROM operational_audit_log`;

function storedAudit(row: Record<string, unknown>): StoredOperationalAudit {
  return {
    event: {
      entryId: String(row.entry_id),
      kind: String(row.event_kind) as OperationalAuditKind,
      channel: channelForKind(String(row.event_kind) as OperationalAuditKind),
      guildId: String(row.guild_id),
      occurredAt: toIso(row.occurred_at),
      actorId: nullableString(row.actor_id),
      targetId: nullableString(row.target_id),
      sourceChannelId: nullableString(row.source_channel_id),
      destinationChannelId: nullableString(row.destination_channel_id),
      messageId: nullableString(row.message_id),
      action: nullableString(row.action),
      metadata: parseMetadata(row.metadata_json),
    },
    mirrorChannelId: nullableString(row.mirror_channel_id),
    deliveryState: String(row.delivery_state) as AuditDeliveryState,
    deliveryAttempts: Number(row.delivery_attempts ?? 0),
    deliveryClaimToken: nullableString(row.delivery_claim_token),
    deliveryNonce: nullableString(row.delivery_nonce),
    deliverySearchBefore: nullableString(row.delivery_search_before),
    mirrorMessageId: nullableString(row.mirror_message_id),
    deliveryLastError: nullableString(row.delivery_last_error),
  };
}

function channelForKind(kind: OperationalAuditKind): AuditChannel {
  if (kind.startsWith('voice_')) return 'voice';
  if (kind === 'moderation_action') return 'moderation';
  return 'audit';
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Keep an ambiguous Discord delivery claimed while its bounded reconciliation runs.
 * This exceeds the retry sweep interval and the largest bounded history scan.
 */
export const AUDIT_DELIVERY_LEASE_MS = 5 * 60_000;

/** Discord accepts message nonces up to 25 characters. */
export function deliveryNonce(entryId: string): string {
  return `oa_${createHash('sha256').update(entryId).digest('base64url').slice(0, 22)}`;
}
