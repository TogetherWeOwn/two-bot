import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';
import type { AuditChannel, OperationalAuditEvent, OperationalAuditKind } from './events.ts';

export type AuditDeliveryState = 'none' | 'pending' | 'delivering' | 'delivered' | 'quarantined';

export interface StoredOperationalAudit {
  event: OperationalAuditEvent;
  mirrorChannelId: string | null;
  deliveryState: AuditDeliveryState;
  deliveryAttempts: number;
  deliveryClaimToken: string | null;
  deliveryNonce: string | null;
  deliverySearchBefore: string | null;
  mirrorMessageId: string | null;
  mirrorCheckedAt: string | null;
  deliveryLastError: string | null;
}

export class OperationalAuditStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async record(event: OperationalAuditEvent, mirrorChannelId: string | null = null): Promise<boolean> {
    const now = new Date().toISOString();
    const incomingMetadata = event.metadata ?? {};
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
        JSON.stringify(incomingMetadata),
        now,
        mirrorChannelId,
        mirrorChannelId ? 'pending' : 'none',
      );
    if (result.changes === 1) return true;

    // The moderation service and the bot-executor-gated Discord audit event use
    // one stable entry id. Whichever arrives second may only fill metadata the
    // first observation did not know; every identity and delivery field remains
    // owned by the original insert.
    if (event.kind !== 'moderation_action' || incomingMetadata.origin !== 'moderation_service') return false;
    const existing = await this.db.prepare(
      `SELECT guild_id, event_kind, action, metadata_json
         FROM operational_audit_log WHERE entry_id = ?`,
    ).get<Record<string, unknown>>(event.entryId);
    if (!existing || String(existing.guild_id) !== event.guildId || String(existing.event_kind) !== event.kind) return false;
    if (nullableString(existing.action) !== (event.action ?? null)) return false;
    const existingMetadata = parseMetadata(existing.metadata_json);
    if (existingMetadata.origin !== 'moderation_service') return false;
    const merged = mergeMissingMetadata(existingMetadata, incomingMetadata);
    const existingJson = String(existing.metadata_json);
    const mergedJson = JSON.stringify(merged);
    if (mergedJson === existingJson) return false;
    await this.db.prepare(
      `UPDATE operational_audit_log SET metadata_json = ?
        WHERE entry_id = ? AND guild_id = ? AND event_kind = ?
          AND action IS NOT DISTINCT FROM ?
          AND metadata_json = ?`,
    ).run(
      mergedJson,
      event.entryId,
      event.guildId,
      event.kind,
      event.action ?? null,
      existingJson,
    );
    return false;
  }

  async get(entryId: string): Promise<StoredOperationalAudit | null> {
    const row = await this.db.prepare(`${SELECT_AUDIT} WHERE entry_id = ?`).get<Record<string, unknown>>(entryId);
    return row ? storedAudit(row) : null;
  }

  /**
   * Emergency kill switch (TOG-3187). Row presence means every mirror send and
   * every pending-row retry must stop now, without a redeploy. Read before
   * each `channel.send`, so the effect is per-message and not per-batch.
   */
  async isDeliveryHalted(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS halted FROM audit_kill_switch WHERE id = 1`)
      .get<{ halted: number }>();
    return Boolean(row);
  }

  /** Engage the kill switch. Idempotent: the first engagement wins the record. */
  async engageDeliveryHalt(engagedBy: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO audit_kill_switch (id, engaged_at, engaged_by)
         VALUES (1, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(now, engagedBy);
    return result.changes === 1;
  }

  /** Disengage the kill switch. Idempotent. Held rows resume on the next sweep. */
  async disengageDeliveryHalt(): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM audit_kill_switch WHERE id = 1`)
      .run();
    return result.changes === 1;
  }

  /** Who engaged the switch and when, for runbooks and dashboards. */
  async deliveryHaltState(): Promise<{ engagedAt: string; engagedBy: string } | null> {
    const row = await this.db
      .prepare(`SELECT engaged_at, engaged_by FROM audit_kill_switch WHERE id = 1`)
      .get<Record<string, unknown>>();
    return row ? { engagedAt: toIso(row.engaged_at), engagedBy: String(row.engaged_by) } : null;
  }

  /**
   * Release a claimed row back to `pending` because the kill switch stopped
   * delivery before Discord was asked anything. Not `markDeliveryFailed`:
   * nothing was attempted, so the attempt count must not move, and the
   * recovery boundary must be cleared - it was only written in preparation
   * for a send that this same call guarantees never happened, so leaving it
   * would fail the row closed as `discord_marker_missing` on the next pass
   * instead of resuming it (TOG-3187: disengaging must not skip held rows).
   */
  async holdDeliveryForHalt(entryId: string, claimToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'pending',
                delivery_lease_until = NULL,
                delivery_claim_token = NULL,
                delivery_search_before = NULL,
                delivery_last_error = 'audit_kill_switch_held'
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(entryId, claimToken);
    return result.changes === 1;
  }

  async claim(entryId: string, leaseMs = AUDIT_DELIVERY_LEASE_MS): Promise<StoredOperationalAudit | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const claimToken = randomUUID();
    // The row is returned from the same UPDATE that wins the claim. A separate
    // unfenced re-read here would let a racing claimant replace the token
    // between the write and the read, so both callers could observe the
    // replacement claimant's token instead of their own (TOG-2223 #6).
    const row = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'delivering',
                delivery_lease_until = ?,
                delivery_claim_token = ?,
                delivery_nonce = COALESCE(delivery_nonce, ?)
          WHERE entry_id = ?
            AND mirror_channel_id IS NOT NULL
            AND (delivery_state = 'pending'
              OR (delivery_state = 'delivering' AND delivery_lease_until < ?))
          RETURNING entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
                    source_channel_id, destination_channel_id, message_id, action,
                    metadata_json, mirror_channel_id, delivery_state, delivery_attempts,
                    delivery_claim_token, delivery_nonce, delivery_search_before,
                    mirror_message_id, mirror_checked_at, delivery_last_error`,
      )
      .get<Record<string, unknown>>(leaseUntil, claimToken, deliveryNonce(entryId), entryId, now.toISOString());
    return row ? storedAudit(row) : null;
  }

  async claimPending(limit = 25, leaseMs = AUDIT_DELIVERY_LEASE_MS): Promise<StoredOperationalAudit[]> {
    const rows = await this.db
      .prepare(
        `${SELECT_AUDIT}
          WHERE mirror_channel_id IS NOT NULL
            AND (delivery_state = 'pending'
              OR (delivery_state = 'delivering' AND delivery_lease_until < ?))
          ORDER BY CASE WHEN delivery_attempted_at IS NULL THEN 0 ELSE 1 END,
                   delivery_attempted_at,
                   created_at,
                   entry_id LIMIT ?`,
      )
      .all<Record<string, unknown>>(new Date().toISOString(), limit);
    const claimed: StoredOperationalAudit[] = [];
    for (const row of rows) {
      const item = await this.claim(String(row.entry_id), leaseMs);
      if (item) claimed.push(item);
    }
    return claimed;
  }

  async prepareDeliverySend(
    entryId: string,
    claimToken: string,
    before: string,
    leaseMs = AUDIT_DELIVERY_LEASE_MS,
  ): Promise<void> {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_search_before = COALESCE(delivery_search_before, ?),
                delivery_lease_until = ?
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?
            AND delivery_lease_until IS NOT NULL`,
      )
      .run(before, leaseUntil, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_send_not_prepared');
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
                mirror_checked_at = NULL,
                mirrored_at = ?
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(now, messageId, now, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_ack_not_persisted');
  }

  async selectDeliveredForReconciliation(
    limit = 10,
    minimumIntervalMs = AUDIT_MIRROR_RECHECK_MS,
  ): Promise<StoredOperationalAudit[]> {
    const cutoff = new Date(Date.now() - minimumIntervalMs).toISOString();
    const rows = await this.db.prepare(
      `${SELECT_AUDIT}
        WHERE delivery_state = 'delivered'
          AND mirror_channel_id IS NOT NULL
          AND mirror_message_id IS NOT NULL
          AND (mirror_checked_at IS NULL OR mirror_checked_at < ?)
        ORDER BY CASE WHEN mirror_checked_at IS NULL THEN 0 ELSE 1 END,
                 mirror_checked_at, mirrored_at, entry_id LIMIT ?`,
    ).all<Record<string, unknown>>(cutoff, limit);
    return rows.map(storedAudit);
  }

  async checkpointMirrorCheck(
    entryId: string,
    mirrorMessageId: string,
    expectedCheckedAt: string | null,
    checkedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE operational_audit_log SET mirror_checked_at = ?
        WHERE entry_id = ? AND delivery_state = 'delivered' AND mirror_message_id = ?
          AND mirror_checked_at IS NOT DISTINCT FROM ?`,
    ).run(checkedAt, entryId, mirrorMessageId, expectedCheckedAt);
    return result.changes === 1;
  }

  /**
   * Fail closed when a delivered mirror can no longer be read back at all - a
   * permanent authorization loss (e.g. a revoked ReadMessageHistory grant)
   * looks identical to a transient fetch hiccup unless the caller has already
   * classified it, so this never runs on its own: the caller decides when the
   * error is definite rather than retryable (TOG-2240).
   */
  async quarantineDeliveredMirrorUnreadable(
    entryId: string,
    mirrorMessageId: string,
    expectedCheckedAt: string | null,
    checkedAt: string,
    classification: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE operational_audit_log
          SET delivery_state = 'quarantined', delivery_last_error = ?, mirror_checked_at = ?
        WHERE entry_id = ? AND delivery_state = 'delivered' AND mirror_message_id = ?
          AND mirror_checked_at IS NOT DISTINCT FROM ?`,
    ).run(classification.slice(0, 120), checkedAt, entryId, mirrorMessageId, expectedCheckedAt);
    return result.changes === 1;
  }

  async quarantineDeliveredMirrorWithEvidence(
    entryId: string,
    mirrorMessageId: string,
    expectedCheckedAt: string | null,
    checkedAt: string,
    classification: 'mirror_deleted' | 'mirror_edited',
    evidence: OperationalAuditEvent,
    /** Test-only fault injection proving transition/evidence atomicity. */
    afterTransition?: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'quarantined', delivery_last_error = ?, mirror_checked_at = ?
          WHERE entry_id = ? AND delivery_state = 'delivered' AND mirror_message_id = ?
            AND mirror_checked_at IS NOT DISTINCT FROM ?`,
      ).run(classification, checkedAt, entryId, mirrorMessageId, expectedCheckedAt);
      if (result.changes !== 1) return false;
      await afterTransition?.();

      const metadata = evidence.metadata ?? {};
      const inserted = await tx.prepare(
        `INSERT INTO operational_audit_log
           (entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
            source_channel_id, destination_channel_id, message_id, action,
            metadata_json, created_at, mirror_channel_id, delivery_state,
            delivery_attempts, delivery_attempted_at, delivery_last_error,
            delivery_lease_until, mirrored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'none', 0, NULL, NULL, NULL, NULL)
         ON CONFLICT (entry_id) DO NOTHING`,
      ).run(
        evidence.entryId,
        evidence.kind,
        evidence.guildId,
        evidence.occurredAt,
        evidence.actorId ?? null,
        evidence.targetId ?? null,
        evidence.sourceChannelId ?? null,
        evidence.destinationChannelId ?? null,
        evidence.messageId ?? null,
        evidence.action ?? null,
        JSON.stringify(metadata),
        checkedAt,
      );
      if (inserted.changes === 1) return true;

      const existing = await tx.prepare(
        `SELECT event_kind, guild_id, source_channel_id, message_id, metadata_json
           FROM operational_audit_log WHERE entry_id = ?`,
      ).get<Record<string, unknown>>(evidence.entryId);
      if (
        !existing
        || String(existing.event_kind) !== evidence.kind
        || String(existing.guild_id) !== evidence.guildId
        || nullableString(existing.source_channel_id) !== (evidence.sourceChannelId ?? null)
        || nullableString(existing.message_id) !== (evidence.messageId ?? null)
      ) throw new Error('audit_mirror_tamper_evidence_conflict');
      const existingMetadata = parseMetadata(existing.metadata_json);
      const mergedJson = JSON.stringify(mergeMissingMetadata(existingMetadata, metadata));
      const existingJson = String(existing.metadata_json);
      if (mergedJson !== existingJson) {
        await tx.prepare(
          `UPDATE operational_audit_log SET metadata_json = ?
            WHERE entry_id = ? AND metadata_json = ?`,
        ).run(mergedJson, evidence.entryId, existingJson);
      }
      return true;
    });
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

  async markDeliveryFailed(
    entryId: string,
    claimToken: string,
    classification: string,
    clearSearchBefore = false,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'pending',
                delivery_attempts = delivery_attempts + 1,
                delivery_attempted_at = ?,
                delivery_last_error = ?,
                delivery_lease_until = NULL,
                delivery_claim_token = NULL,
                delivery_search_before = CASE WHEN ? = 1 THEN NULL ELSE delivery_search_before END
          WHERE entry_id = ?
            AND delivery_state = 'delivering'
            AND delivery_claim_token = ?`,
      )
      .run(new Date().toISOString(), classification.slice(0, 120), clearSearchBefore ? 1 : 0, entryId, claimToken);
    if (result.changes !== 1) throw new Error('audit_delivery_failure_not_persisted');
  }

  async quarantineDelivery(entryId: string, claimToken: string, classification: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_audit_log
            SET delivery_state = 'quarantined',
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
    if (result.changes !== 1) throw new Error('audit_delivery_quarantine_not_persisted');
  }

  async eraseMember(memberId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const result = await tx
        .prepare(`DELETE FROM operational_audit_log WHERE actor_id = ? OR target_id = ?`)
        .run(memberId, memberId);
      return result.changes;
    });
  }
}

const SELECT_AUDIT =
  `SELECT entry_id, event_kind, guild_id, occurred_at, actor_id, target_id,
          source_channel_id, destination_channel_id, message_id, action,
          metadata_json, mirror_channel_id, delivery_state, delivery_attempts,
          delivery_claim_token, delivery_nonce, delivery_search_before,
          mirror_message_id, mirror_checked_at, delivery_last_error
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
    mirrorCheckedAt: nullableString(row.mirror_checked_at),
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

function mergeMissingMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in merged) || merged[key] === null || merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Keep an ambiguous Discord delivery claimed while its bounded reconciliation runs.
 * This exceeds the retry sweep interval and the largest bounded history scan.
 */
export const AUDIT_DELIVERY_LEASE_MS = 5 * 60_000;
/** Delivered mirrors are revisited at most hourly during the 30-second retry sweep. */
export const AUDIT_MIRROR_RECHECK_MS = 60 * 60_000;

/** Discord accepts message nonces up to 25 characters. */
export function deliveryNonce(entryId: string): string {
  return `oa_${createHash('sha256').update(entryId).digest('base64url').slice(0, 22)}`;
}
