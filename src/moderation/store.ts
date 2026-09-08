import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * How long a claimed moderation idempotency row (or a `running` unban job) is
 * honoured before another process may take it over.
 *
 * Same reasoning as CLAIM_STALE_SECONDS in internal/store.ts: a crash between
 * claim and result must not pin the key forever, and the window is far outside
 * any moderation verb's own budget. At-most-once inside a living process; a
 * bounded, logged window across a crash.
 */
export const MODERATION_CLAIM_STALE_SECONDS = 60;

export interface ModerationAuditRow {
  requestId: string;
  guildId: string;
  actorId: string;
  action: string;
  targetId?: string | null;
  channelId?: string | null;
  reason: string;
  outcome: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduledUnban {
  guildId: string;
  userId: string;
  reason: string;
}

export interface StoredModerationResult {
  outcome: string;
  result: Record<string, unknown>;
}

export type ModerationClaim =
  | { state: 'claimed' }
  | { state: 'replayed'; stored: StoredModerationResult }
  | { state: 'in_flight' }
  | { state: 'mismatch' };

export interface LockdownRecord {
  channelId: string;
  guildId: string;
  priorAllow: string;
  priorDeny: string;
  reason: string;
}

export class ModerationStore {
  private db: Db;
  private now: () => number;
  private claimStaleMs: number;

  constructor(db: Db, now: () => number = Date.now, claimStaleSeconds = MODERATION_CLAIM_STALE_SECONDS) {
    this.db = db;
    this.now = now;
    this.claimStaleMs = claimStaleSeconds * 1000;
  }

  // --- idempotency ---------------------------------------------------------
  //
  // One atomic claim per (guild, key) BEFORE any Discord mutation. The old
  // check-then-act against moderation_audit let two concurrent requests for
  // one key both pass the check, and an audit-write failure after Discord
  // succeeded left nothing behind, so a retry re-banned (TOG-1659 High 3).

  /**
   * Claim the operation named by `(guildId, idempotencyKey)`, or report what
   * happened to it last time. `hash` binds the key to one request content, so
   * a reused key carrying a different body is a caller bug we can name.
   */
  async claim(
    guildId: string,
    idempotencyKey: string,
    action: string,
    hash: string,
  ): Promise<ModerationClaim> {
    const t = this.now();

    const won = await this.db
      .prepare(
        `INSERT INTO moderation_idempotency
           (guild_id, idempotency_key, action, request_hash, state, claimed_at)
         VALUES (?, ?, ?, ?, 'in_flight', ?)
         ON CONFLICT (guild_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
      )
      .get<{ idempotency_key: string }>(guildId, idempotencyKey, action, hash, iso(t));
    if (won) return { state: 'claimed' };

    const row = await this.db
      .prepare(
        `SELECT action, request_hash, state, outcome, result_json, claimed_at
           FROM moderation_idempotency
          WHERE guild_id = ? AND idempotency_key = ?`,
      )
      .get<{
        action: string;
        request_hash: string;
        state: string;
        outcome: string | null;
        result_json: string | null;
        claimed_at: string;
      }>(guildId, idempotencyKey);
    // Deleted between our INSERT losing and this SELECT - a failed attempt
    // releasing its claim. Treat it as still running; the caller retries.
    if (!row) return { state: 'in_flight' };

    if (row.request_hash !== hash) return { state: 'mismatch' };

    if (row.state === 'done') {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
      } catch {
        parsed = {};
      }
      return { state: 'replayed', stored: { outcome: row.outcome ?? 'unknown', result: parsed } };
    }

    // in_flight. Only take it over if the holder is old enough to be a corpse.
    if (t - Date.parse(row.claimed_at) < this.claimStaleMs) return { state: 'in_flight' };
    const taken = await this.db
      .prepare(
        `UPDATE moderation_idempotency SET claimed_at = ?
          WHERE guild_id = ? AND idempotency_key = ? AND state = 'in_flight' AND claimed_at < ?`,
      )
      .run(iso(t), guildId, idempotencyKey, iso(t - this.claimStaleMs));
    return taken.changes === 1 ? { state: 'claimed' } : { state: 'in_flight' };
  }

  /** Record the result, so a retry replays it instead of acting again. */
  async complete(
    guildId: string,
    idempotencyKey: string,
    stored: StoredModerationResult,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE moderation_idempotency
            SET state = 'done', outcome = ?, result_json = ?, completed_at = ?
          WHERE guild_id = ? AND idempotency_key = ?`,
      )
      .run(stored.outcome, JSON.stringify(stored.result), iso(this.now()), guildId, idempotencyKey);
  }

  /**
   * Give the key back after a failed attempt. A failed attempt made no
   * lasting change at Discord, so there is nothing to be idempotent about
   * except the claims themselves - the caller is told `retryable` and a
   * retry must be a real second attempt, not a cached error.
   */
  async release(guildId: string, idempotencyKey: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM moderation_idempotency
          WHERE guild_id = ? AND idempotency_key = ? AND state = 'in_flight'`,
      )
      .run(guildId, idempotencyKey);
  }

  // --- audit ---------------------------------------------------------------

  async recordAudit(row: ModerationAuditRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_audit
         (request_id, guild_id, actor_id, action, target_id, channel_id, reason,
          outcome, idempotency_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(
      row.requestId,
      row.guildId,
      row.actorId,
      row.action,
      row.targetId ?? null,
      row.channelId ?? null,
      row.reason,
      row.outcome,
      row.idempotencyKey,
      JSON.stringify(row.metadata ?? {}),
      iso(this.now()),
    );
  }

  // --- warnings ------------------------------------------------------------

  async addWarning(guildId: string, userId: string, actorId: string, reason: string, requestId: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_warnings
         (id, guild_id, user_id, actor_id, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
    ).run(randomUUID(), guildId, userId, actorId, reason, requestId, iso(this.now()));
  }

  // --- scheduled unbans ----------------------------------------------------

  /**
   * Persist a pending unban job. Written BEFORE the Discord ban (TOG-1659
   * High 2): a crash after the ban still leaves a job that will fire, so the
   * worst case is an unban for a ban the moderator can re-apply, never a
   * permanent ban the moderator asked to be temporary.
   *
   * The partial unique index `uq_moderation_pending_unban` keeps one pending
   * job per (guild, user), so a second tempban of the same user - or an
   * extension - moves this job's expiry instead of forking a second one.
   */
  async scheduleUnban(guildId: string, userId: string, executeAt: string, reason: string, requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Retire any pending job for this (guild, user) first: the unique
      // index would otherwise reject the insert for a still-banned user.
      await tx.prepare(
        `UPDATE moderation_scheduled_unbans
            SET state = 'superseded', completed_at = ?
          WHERE guild_id = ? AND user_id = ? AND state = 'pending'`,
      ).run(iso(this.now()), guildId, userId);
      await tx.prepare(
        `INSERT INTO moderation_scheduled_unbans
           (guild_id, user_id, execute_at, reason, request_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(guildId, userId, executeAt, reason, requestId, iso(this.now()));
    });
  }

  /**
   * Atomically move due `pending` jobs (and `running` jobs whose claim went
   * stale) into `running`, returning exactly the rows this caller won.
   *
   * The old SELECT-then-act let two overlapping `runDueUnbans()` sweeps
   * process the same job - a double unban and a double audit row
   * (TOG-1659 High 4). The UPDATE ... RETURNING is the claim: whichever
   * process's update lands first owns the row, and the other sees nothing.
   */
  async claimDueUnbans(limit = 25): Promise<Array<ScheduledUnban & { requestId: string }>> {
    const t = iso(this.now());
    const rows = await this.db
      .prepare(
        `UPDATE moderation_scheduled_unbans
            SET state = 'running', claimed_at = ?
          WHERE request_id IN (
            SELECT request_id FROM moderation_scheduled_unbans
             WHERE (state = 'pending' AND execute_at <= ?)
                OR (state = 'running' AND claimed_at < ?)
             ORDER BY execute_at ASC
             LIMIT ?
          )
          RETURNING request_id, guild_id, user_id, reason`,
      )
      .all<{ request_id: string; guild_id: string; user_id: string; reason: string }>(
        t, t, iso(this.now() - this.claimStaleMs), limit,
      );
    return rows.map((row) => ({
      requestId: row.request_id,
      guildId: row.guild_id,
      userId: row.user_id,
      reason: row.reason,
    }));
  }

  async completeUnban(requestId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE moderation_scheduled_unbans
          SET state = 'done', completed_at = ?
        WHERE request_id = ?`,
    ).run(iso(this.now()), requestId);
  }

  /** A job that failed goes back to pending, so the next sweep retries it. */
  async requeueUnban(requestId: string): Promise<void> {
    await this.db.prepare(
      `UPDATE moderation_scheduled_unbans
          SET state = 'pending'
        WHERE request_id = ? AND state = 'running'`,
    ).run(requestId);
  }

  // --- lockdowns -----------------------------------------------------------

  /**
   * Remember exactly what the @everyone overwrite was before Owen denied
   * SendMessages. `priorAllow`/`priorDeny` are the full bitmasks as decimal
   * strings, taken from a read of the channel BEFORE any write, so unlock can
   * put the channel back bit-for-bit instead of guessing (TOG-1659 High 1).
   */
  async recordLockdown(record: LockdownRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO moderation_lockdowns
         (channel_id, guild_id, prior_allow, prior_deny, reason, locked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE
         SET prior_allow = excluded.prior_allow,
             prior_deny  = excluded.prior_deny,
             reason      = excluded.reason,
             locked_at   = excluded.locked_at`,
    ).run(record.channelId, record.guildId, record.priorAllow, record.priorDeny, record.reason, iso(this.now()));
  }

  /**
   * Take and delete the stored pre-lockdown overwrite. Null when this channel
   * has no recorded lockdown - the caller must fall back to a minimal, safe
   * restore (clear only the SendMessages deny) rather than inventing state.
   */
  async takeLockdown(channelId: string): Promise<LockdownRecord | null> {
    const row = await this.db
      .prepare(
        `DELETE FROM moderation_lockdowns
          WHERE channel_id = ?
          RETURNING channel_id, guild_id, prior_allow, prior_deny, reason`,
      )
      .get<{ channel_id: string; guild_id: string; prior_allow: string; prior_deny: string; reason: string }>(channelId);
    if (!row) return null;
    return {
      channelId: row.channel_id,
      guildId: row.guild_id,
      priorAllow: row.prior_allow,
      priorDeny: row.prior_deny,
      reason: row.reason,
    };
  }
}
