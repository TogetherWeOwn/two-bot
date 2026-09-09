/**
 * Durable state for the automations feature (TOG-1648): custom commands,
 * scheduled messages and per-channel stickies.
 *
 * Same discipline as src/internal/store.ts, which this is modelled on:
 * NOTHING HERE DECIDES ANYTHING. Every method is one SQL statement or a
 * straight row mapping, validation lives in the service layer, and the audit
 * row records ids and outcomes, never message content written by members
 * (the bot does not read message content at all - see docs/PRIVACY.md).
 *
 * `template` and `body` columns do hold admin-authored text, deliberately:
 * that is the thing the bot is about to say, not a thing a member said.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';

export interface AutomationCommandRow {
  guildId: string;
  name: string;
  description: string;
  template: string;
  textTrigger: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ScheduledMessageRow {
  id: string;
  guildId: string;
  channelId: string;
  body: string;
  nextRunAt: string;
  intervalSeconds: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastMessageId: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  claimToken: string | null;
  claimedAt: string | null;
}

export interface StickyMessageRow {
  guildId: string;
  channelId: string;
  body: string;
  debounceSeconds: number;
  enabled: boolean;
  lastMessageId: string | null;
  lastPostedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  claimToken: string | null;
  claimedAt: string | null;
}

export interface AutomationAuditInput {
  guildId: string;
  /** NULL for system actors: the scheduler, the sticky re-poster. */
  actorId: string | null;
  action: string;
  targetKey: string | null;
  outcome: string;
  reason?: string;
}

function mapCommand(r: Record<string, unknown>): AutomationCommandRow {
  return {
    guildId: String(r.guild_id),
    name: String(r.name),
    description: String(r.description),
    template: String(r.template),
    textTrigger: r.text_trigger === null || r.text_trigger === undefined ? null : String(r.text_trigger),
    enabled: !!r.enabled,
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedBy: String(r.updated_by),
    updatedAt: String(r.updated_at),
  };
}

function mapScheduled(r: Record<string, unknown>): ScheduledMessageRow {
  return {
    id: String(r.id),
    guildId: String(r.guild_id),
    channelId: String(r.channel_id),
    body: String(r.body),
    nextRunAt: String(r.next_run_at),
    intervalSeconds:
      r.interval_seconds === null || r.interval_seconds === undefined
        ? null
        : Number(r.interval_seconds),
    enabled: !!r.enabled,
    lastRunAt: r.last_run_at === null || r.last_run_at === undefined ? null : String(r.last_run_at),
    lastMessageId:
      r.last_message_id === null || r.last_message_id === undefined ? null : String(r.last_message_id),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedBy: String(r.updated_by),
    updatedAt: String(r.updated_at),
    claimToken: r.claim_token === null || r.claim_token === undefined ? null : String(r.claim_token),
    claimedAt: r.claimed_at === null || r.claimed_at === undefined ? null : String(r.claimed_at),
  };
}

function mapSticky(r: Record<string, unknown>): StickyMessageRow {
  return {
    guildId: String(r.guild_id),
    channelId: String(r.channel_id),
    body: String(r.body),
    debounceSeconds: Number(r.debounce_seconds),
    enabled: !!r.enabled,
    lastMessageId:
      r.last_message_id === null || r.last_message_id === undefined ? null : String(r.last_message_id),
    lastPostedAt:
      r.last_posted_at === null || r.last_posted_at === undefined ? null : String(r.last_posted_at),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedBy: String(r.updated_by),
    updatedAt: String(r.updated_at),
    claimToken: r.claim_token === null || r.claim_token === undefined ? null : String(r.claim_token),
    claimedAt: r.claimed_at === null || r.claimed_at === undefined ? null : String(r.claimed_at),
  };
}

export class AutomationStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // --- custom commands ------------------------------------------------------

  listCommands(guildId: string): Promise<AutomationCommandRow[]> {
    return this.db
      .prepare(`SELECT * FROM automation_commands WHERE guild_id = ? ORDER BY name`)
      .all(guildId)
      .then((rows) => rows.map(mapCommand));
  }

  async getCommand(guildId: string, name: string): Promise<AutomationCommandRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM automation_commands WHERE guild_id = ? AND name = ?`)
      .get(guildId, name);
    return row ? mapCommand(row) : null;
  }

  /** Find the enabled command a `!trigger` first word matches, if any. */
  async findTextTrigger(guildId: string, trigger: string): Promise<AutomationCommandRow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM automation_commands
          WHERE guild_id = ? AND enabled = TRUE AND lower(text_trigger) = lower(?)`,
      )
      .get(guildId, trigger);
    return row ? mapCommand(row) : null;
  }

  /** Find any definition holding a text trigger, including a disabled one. */
  async getCommandByTextTrigger(guildId: string, trigger: string): Promise<AutomationCommandRow | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM automation_commands
          WHERE guild_id = ? AND lower(text_trigger) = lower(?)`,
      )
      .get(guildId, trigger);
    return row ? mapCommand(row) : null;
  }

  /**
   * Serialize every capacity-changing command write for one guild. The caller
   * checks the final name set while holding this scope. Postgres uses a
   * transaction-scoped advisory lock so unrelated guilds remain independent;
   * SQLite's BEGIN IMMEDIATE transaction supplies the same safety while that
   * rollback path remains supported.
   */
  async withCommandCapacity<T>(
    guildId: string,
    fn: (store: AutomationStore) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      if (tx.kind === 'postgres') {
        await tx.prepare(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`).get(
          `automation_commands:${guildId}`,
        );
      }
      return fn(new AutomationStore(tx));
    });
  }

  /**
   * Insert a command only when the name is unused. Imports use this so an
   * existing admin-authored command cannot be replaced between a check and the
   * write. Returns false on any name conflict.
   */
  async createCommand(row: AutomationCommandRow): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO automation_commands
           (guild_id, name, description, template, text_trigger, enabled,
            created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, name) DO NOTHING`,
      )
      .run(
        row.guildId,
        row.name,
        row.description,
        row.template,
        row.textTrigger,
        row.enabled ? 1 : 0,
        row.createdBy,
        row.createdAt,
        row.updatedBy,
        row.updatedAt,
      );
    return result.changes > 0;
  }

  /**
   * Update only when the definition still matches the importer's snapshot.
   * This keeps default non-overwrite imports from racing an admin edit.
   */
  async updateCommandIfUnchanged(
    row: AutomationCommandRow,
    expected: Pick<AutomationCommandRow, 'description' | 'template' | 'textTrigger' | 'enabled' | 'updatedAt'>,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_commands SET
           description = ?, template = ?, text_trigger = ?, enabled = ?,
           updated_by = ?, updated_at = ?
         WHERE guild_id = ? AND name = ?
           AND description = ? AND template = ?
           AND text_trigger IS NOT DISTINCT FROM ?
           AND enabled = ? AND updated_at = ?`,
      )
      .run(
        row.description, row.template, row.textTrigger, row.enabled ? 1 : 0,
        row.updatedBy, row.updatedAt, row.guildId, row.name,
        expected.description, expected.template, expected.textTrigger,
        expected.enabled ? 1 : 0, expected.updatedAt,
      );
    return result.changes > 0;
  }

  /**
   * Upsert a command definition. The caller has already validated shape; the
   * unique partial index on (guild_id, lower(text_trigger)) is the last line
   * of defence against two commands claiming one trigger word.
   */
  async putCommand(row: AutomationCommandRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO automation_commands
           (guild_id, name, description, template, text_trigger, enabled,
            created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, name) DO UPDATE SET
           description = excluded.description,
           template    = excluded.template,
           text_trigger = excluded.text_trigger,
           enabled     = excluded.enabled,
           updated_by  = excluded.updated_by,
           updated_at  = excluded.updated_at`,
      )
      .run(
        row.guildId,
        row.name,
        row.description,
        row.template,
        row.textTrigger,
        row.enabled ? 1 : 0,
        row.createdBy,
        row.createdAt,
        row.updatedBy,
        row.updatedAt,
      );
  }

  async deleteCommand(guildId: string, name: string): Promise<boolean> {
    const r = await this.db
      .prepare(`DELETE FROM automation_commands WHERE guild_id = ? AND name = ?`)
      .run(guildId, name);
    return r.changes > 0;
  }

  /** Every enabled command across every guild - what a re-register sweeps. */
  listEnabledCommands(): Promise<AutomationCommandRow[]> {
    return this.db
      .prepare(`SELECT * FROM automation_commands WHERE enabled = TRUE ORDER BY guild_id, name`)
      .all()
      .then((rows) => rows.map(mapCommand));
  }

  // --- scheduled messages ---------------------------------------------------

  async getScheduled(guildId: string, id: string): Promise<ScheduledMessageRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM scheduled_messages WHERE guild_id = ? AND id = ?`)
      .get(guildId, id);
    return row ? mapScheduled(row) : null;
  }

  async resolveScheduledId(guildId: string, idOrPrefix: string): Promise<string | null> {
    const rows = await this.db
      .prepare(
        `SELECT id FROM scheduled_messages
          WHERE guild_id = ? AND (id = ? OR id LIKE ?)
          ORDER BY id LIMIT 2`,
      )
      .all<{ id: string }>(guildId, idOrPrefix, `${idOrPrefix}%`);
    if (rows.length !== 1) return null;
    return String(rows[0]?.id);
  }

  listScheduled(guildId: string): Promise<ScheduledMessageRow[]> {
    return this.db
      .prepare(`SELECT * FROM scheduled_messages WHERE guild_id = ? ORDER BY next_run_at`)
      .all(guildId)
      .then((rows) => rows.map(mapScheduled));
  }

  /**
   * Atomically lease due rows before any outbound post. Postgres locks each
   * candidate inside the UPDATE statement and skips rows another scheduler has
   * already claimed; SQLite serialises writes and uses the portable fallback.
   */
  claimDueScheduled(
    guildId: string,
    nowIso: string,
    claimToken: string,
    leaseUntilIso: string,
    limit = 10,
  ): Promise<ScheduledMessageRow[]> {
    const locked = this.db.kind === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';
    return this.db
      .prepare(
        `WITH due AS (
           SELECT id FROM scheduled_messages
            WHERE guild_id = ? AND enabled = TRUE AND next_run_at <= ?
            ORDER BY next_run_at
            LIMIT ?${locked}
         )
         UPDATE scheduled_messages
            SET next_run_at = ?, claim_token = ?, claimed_at = ?
          WHERE guild_id = ? AND id IN (SELECT id FROM due)
            AND next_run_at <= ?
          RETURNING *`,
      )
      .all(guildId, nowIso, limit, leaseUntilIso, claimToken, nowIso, guildId, nowIso)
      .then((rows) => rows.map(mapScheduled));
  }

  async retryScheduled(guildId: string, id: string, claimToken: string, nextRunAtIso: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scheduled_messages
            SET next_run_at = ?, claim_token = NULL, claimed_at = NULL
          WHERE guild_id = ? AND id = ? AND claim_token = ?`,
      )
      .run(nextRunAtIso, guildId, id, claimToken);
    return result.changes > 0;
  }

  async putScheduled(row: ScheduledMessageRow): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO scheduled_messages
           (id, guild_id, channel_id, body, next_run_at, interval_seconds, enabled,
            last_run_at, last_message_id, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           channel_id       = excluded.channel_id,
           body             = excluded.body,
           next_run_at      = excluded.next_run_at,
           interval_seconds = excluded.interval_seconds,
           enabled          = excluded.enabled,
           updated_by       = excluded.updated_by,
           updated_at       = excluded.updated_at,
           claim_token      = NULL,
           claimed_at       = NULL
         WHERE scheduled_messages.guild_id = excluded.guild_id`,
      )
      .run(
        row.id,
        row.guildId,
        row.channelId,
        row.body,
        row.nextRunAt,
        row.intervalSeconds,
        row.enabled ? 1 : 0,
        row.lastRunAt,
        row.lastMessageId,
        row.createdBy,
        row.createdAt,
        row.updatedBy,
        row.updatedAt,
      );
    return result.changes > 0;
  }

  /**
   * Record a run and compute what happens next, in one read-modify-write the
   * database serialises per row: a one-shot row disables itself (its next run
   * would be never); a recurring row advances from the run time, so a bot that
   * was down for an hour does not fire a burst of catch-up posts.
   *
   * Computing `next_run_at` in TypeScript rather than SQL keeps the statement
   * portable across the SQLite and Postgres drivers (`?` placeholders, no
   * dialect date maths).
   */
  async markScheduledRun(
    guildId: string,
    id: string,
    ranAtIso: string,
    messageId: string | null,
    claimToken: string,
  ): Promise<ScheduledMessageRow | null> {
    const current = await this.getScheduled(guildId, id);
    if (!current) return null;
    const nextRunAt = current.intervalSeconds
      ? new Date(Date.parse(ranAtIso) + current.intervalSeconds * 1000).toISOString()
      : current.nextRunAt;
    const row = await this.db
      .prepare(
        `UPDATE scheduled_messages SET
           last_run_at     = ?,
           last_message_id = ?,
           enabled         = CASE WHEN interval_seconds IS NULL THEN FALSE ELSE TRUE END,
           next_run_at     = ?,
           claim_token     = NULL,
           claimed_at      = NULL
         WHERE guild_id = ? AND id = ? AND claim_token = ?
         RETURNING *`,
      )
      .get(ranAtIso, messageId, nextRunAt, guildId, id, claimToken);
    return row ? mapScheduled(row) : null;
  }

  async deleteScheduled(guildId: string, id: string): Promise<boolean> {
    const r = await this.db
      .prepare(`DELETE FROM scheduled_messages WHERE guild_id = ? AND id = ?`)
      .run(guildId, id);
    return r.changes > 0;
  }

  // --- stickies --------------------------------------------------------------

  async getSticky(guildId: string, channelId: string): Promise<StickyMessageRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM sticky_messages WHERE guild_id = ? AND channel_id = ?`)
      .get(guildId, channelId);
    return row ? mapSticky(row) : null;
  }

  listStickies(guildId: string): Promise<StickyMessageRow[]> {
    return this.db
      .prepare(`SELECT * FROM sticky_messages WHERE guild_id = ? ORDER BY channel_id`)
      .all(guildId)
      .then((rows) => rows.map(mapSticky));
  }

  async putSticky(row: StickyMessageRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sticky_messages
           (guild_id, channel_id, body, debounce_seconds, enabled,
            last_message_id, last_posted_at, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, channel_id) DO UPDATE SET
           body             = excluded.body,
           debounce_seconds = excluded.debounce_seconds,
           enabled          = excluded.enabled,
           updated_by       = excluded.updated_by,
           updated_at       = excluded.updated_at,
           claim_token      = NULL,
           claimed_at       = NULL`,
      )
      .run(
        row.guildId,
        row.channelId,
        row.body,
        row.debounceSeconds,
        row.enabled ? 1 : 0,
        row.lastMessageId,
        row.lastPostedAt,
        row.createdBy,
        row.createdAt,
        row.updatedBy,
        row.updatedAt,
      );
  }

  /**
   * Claim one sticky re-post window. The timestamp update is the lock: only one
   * concurrent activity can move the old value and receive the row.
   */
  async claimStickyPost(
    guildId: string,
    channelId: string,
    claimToken: string,
    claimedAtIso: string,
    cutoffIso: string,
    expiredClaimCutoffIso: string,
  ): Promise<StickyMessageRow | null> {
    const row = await this.db
      .prepare(
        `UPDATE sticky_messages
            SET claim_token = ?, claimed_at = ?
          WHERE guild_id = ? AND channel_id = ? AND enabled = TRUE
            AND (claim_token IS NULL OR claimed_at <= ?)
            AND (last_posted_at IS NULL OR last_posted_at <= ?)
          RETURNING *`,
      )
      .get(
        claimToken, claimedAtIso, guildId, channelId,
        expiredClaimCutoffIso, cutoffIso,
      );
    return row ? mapSticky(row) : null;
  }

  async deleteSticky(guildId: string, channelId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`DELETE FROM sticky_messages WHERE guild_id = ? AND channel_id = ?`)
      .run(guildId, channelId);
    return r.changes > 0;
  }

  /** After posting a fresh sticky, remember which message to un-stick next time. */
  async recordStickyPost(
    guildId: string,
    channelId: string,
    messageId: string | null,
    postedAtIso: string,
    claimToken: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sticky_messages SET
           last_message_id = ?, last_posted_at = ?, claim_token = NULL, claimed_at = NULL
          WHERE guild_id = ? AND channel_id = ? AND claim_token = ?`,
      )
      .run(messageId, postedAtIso, guildId, channelId, claimToken);
    return result.changes > 0;
  }

  /** Release only the claim this activity acquired, preserving a newer claim. */
  async releaseStickyPost(
    guildId: string,
    channelId: string,
    claimToken: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sticky_messages SET claim_token = NULL, claimed_at = NULL
          WHERE guild_id = ? AND channel_id = ? AND claim_token = ?`,
      )
      .run(guildId, channelId, claimToken);
  }

  // --- audit ------------------------------------------------------------------

  async audit(row: AutomationAuditInput, atIso: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO automation_audit_log (id, guild_id, actor_id, action, target_key, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        row.guildId,
        row.actorId,
        row.action,
        row.targetKey ?? null,
        row.outcome,
        row.reason ?? null,
        atIso,
      );
  }
}
