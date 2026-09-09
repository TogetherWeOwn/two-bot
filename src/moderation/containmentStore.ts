import { createHash } from 'node:crypto';
import type { Db } from '../store/driver.ts';

export type ContainmentIncidentState = 'observe' | 'contain' | 'ignored' | 'stale';

export interface ContainmentEventRow {
  auditEntryId: string;
  guildId: string;
  executorId: string | null;
  action: string;
  targetId: string | null;
  weight: number;
  occurredAt: string;
  state: ContainmentIncidentState;
  reason: string;
}

export interface ContainmentClaim {
  claimed: boolean;
  heat: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class ContainmentStore {
  private db: Db;
  private now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  async claimEvent(row: ContainmentEventRow, windowSeconds: number): Promise<ContainmentClaim> {
    return this.db.transaction(async (tx) => {
      if (tx.kind === 'postgres' && row.executorId) {
        const lock = createHash('sha256').update(`${row.guildId}:${row.executorId}`).digest();
        const high = lock.readInt32BE(0);
        const low = lock.readInt32BE(4);
        await tx.prepare('SELECT pg_advisory_xact_lock(?, ?)').get(high, low);
      }
      const observedMs = this.now();
      const observedAt = iso(observedMs);
      const occurredMs = Date.parse(row.occurredAt);
      const futureLimitMs = observedMs + 5_000;
      const rejectedFuture = row.state === 'observe' && occurredMs > futureLimitMs;
      const state = rejectedFuture ? 'ignored' : row.state;
      const reason = rejectedFuture
        ? 'audit entry is more than 5 seconds in the future; refusing to count it'
        : row.reason;
      const inserted = await tx.prepare(
        `INSERT INTO containment_events
           (audit_entry_id, guild_id, executor_id, action, target_id, weight,
            occurred_at, state, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (audit_entry_id) DO NOTHING`,
      ).run(
        row.auditEntryId,
        row.guildId,
        row.executorId,
        row.action,
        row.targetId,
        row.weight,
        row.occurredAt,
        state,
        reason,
        observedAt,
      );
      if (inserted.changes !== 1) return { claimed: false, heat: 0 };
      if (!row.executorId || state !== 'observe') return { claimed: true, heat: 0 };
      const windowMs = windowSeconds * 1000;
      const events = await tx.prepare(
        `SELECT audit_entry_id, weight, occurred_at
           FROM containment_events
          WHERE guild_id = ? AND executor_id = ? AND state IN ('observe', 'contain')
            AND occurred_at > ? AND occurred_at <= ?
          ORDER BY occurred_at, audit_entry_id`,
      ).all<{ audit_entry_id: string; weight: number; occurred_at: string }>(
        row.guildId,
        row.executorId,
        iso(occurredMs - windowMs),
        iso(Math.min(occurredMs + windowMs, futureLimitMs)),
      );
      let heat = 0;
      let maxHeat = 0;
      let left = 0;
      for (let right = 0; right < events.length; right++) {
        const rightMs = Date.parse(events[right].occurred_at);
        heat += Number(events[right].weight);
        while (left <= right && rightMs - Date.parse(events[left].occurred_at) >= windowMs) {
          heat -= Number(events[left].weight);
          left++;
        }
        if (rightMs >= occurredMs) maxHeat = Math.max(maxHeat, heat);
      }
      return { claimed: true, heat: maxHeat };
    });
  }

  async beginIncident(
    guildId: string,
    executorId: string,
    triggerAuditEntryId: string,
    heat: number,
    windowSeconds: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (tx.kind === 'postgres') {
        const lock = createHash('sha256').update(`incident:${guildId}:${executorId}`).digest();
        await tx.prepare('SELECT pg_advisory_xact_lock(?, ?)').get(lock.readInt32BE(0), lock.readInt32BE(4));
      }
      const now = iso(this.now());
      const active = await tx.prepare(
        `SELECT id FROM containment_incidents
          WHERE guild_id = ? AND executor_id = ?
            AND (state = 'uncertain' OR cooldown_until > ?)
          LIMIT 1`,
      ).get<{ id: string }>(guildId, executorId, now);
      if (active) return false;
      await tx.prepare(
        `INSERT INTO containment_incidents
           (id, guild_id, executor_id, trigger_audit_entry_id, heat, state, started_at, cooldown_until)
         VALUES (?, ?, ?, ?, ?, 'containing', ?, ?)`,
      ).run(
        triggerAuditEntryId,
        guildId,
        executorId,
        triggerAuditEntryId,
        heat,
        now,
        iso(this.now() + windowSeconds * 1000),
      );
      await tx.prepare(
        `UPDATE containment_events SET state = 'contain'
          WHERE audit_entry_id = ?`,
      ).run(triggerAuditEntryId);
      return true;
    });
  }

  async completeIncident(
    id: string,
    state: 'contained' | 'dry_run' | 'refused' | 'uncertain' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE containment_incidents
          SET state = ?, result_json = ?, completed_at = ?
        WHERE id = ?`,
    ).run(state, JSON.stringify(result), iso(this.now()), id);
  }

  async recordJoinRisk(input: {
    eventId: string;
    guildId: string;
    memberId: string;
    accountCreatedAt: string;
    joinedAt: string;
    source: string;
    accountScore: number;
    accountReasons: string[];
    bulkJoinWindow: boolean;
    windowSeconds: number;
    joinThreshold: number;
  }): Promise<{ persisted: boolean; score: number; reasons: string[]; flagged: boolean }> {
    return this.db.transaction(async (tx) => {
      if (tx.kind === 'postgres') {
        const lock = createHash('sha256').update(`joins:${input.guildId}`).digest();
        await tx.prepare('SELECT pg_advisory_xact_lock(?, ?)').get(lock.readInt32BE(0), lock.readInt32BE(4));
      }
      const existing = await tx.prepare(
        'SELECT event_id FROM join_risk_flags WHERE event_id = ?',
      ).get<{ event_id: string }>(input.eventId);
      if (existing) return { persisted: false, score: 0, reasons: [], flagged: false };
      const observedAt = iso(this.now());
      const cutoff = iso(this.now() - input.windowSeconds * 1000);
      const recent = await tx.prepare(
        `SELECT COUNT(*) AS count FROM join_risk_flags
          WHERE guild_id = ? AND created_at > ? AND created_at <= ?`,
      ).get<{ count: number }>(input.guildId, cutoff, observedAt);
      const joinCount = Number(recent?.count ?? 0) + 1;
      const reasons = [...input.accountReasons];
      let score = input.accountScore;
      if (joinCount >= input.joinThreshold) {
        score += 2;
        reasons.push(`${joinCount} joins inside ${input.windowSeconds}s`);
      }
      const flagged = !input.bulkJoinWindow && score >= 3;
      await tx.prepare(
        `INSERT INTO join_risk_flags
           (event_id, guild_id, member_id, account_created_at, joined_at, source, score,
            reasons_json, bulk_join_window, flagged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.eventId,
        input.guildId,
        input.memberId,
        input.accountCreatedAt,
        input.joinedAt,
        input.source,
        score,
        JSON.stringify(reasons),
        input.bulkJoinWindow ? 1 : 0,
        flagged ? 1 : 0,
        observedAt,
      );
      return { persisted: true, score, reasons, flagged };
    });
  }
}

