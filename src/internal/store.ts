/**
 * The durable state behind POST /internal/actions.
 * docs/INTERNAL_ACTIONS.md §4 and §6. Tables in migrations/0002.
 *
 * Everything here was in-process until TOG-37 put the bot on Postgres. The
 * difference that matters is not persistence for its own sake - it is that a
 * bot restart no longer forgets:
 *
 *   * which nonces it has seen (a restart used to re-open a ≤240s replay
 *     window), and
 *   * which operations it has already carried out (without which a retried
 *     announcement is a second announcement).
 *
 * NOTHING IN THIS FILE WRITES A REQUEST BODY TO THE DATABASE. The idempotency
 * row stores a sha256 of the body so a reused key carrying different content
 * can be rejected, and a result object this process built. One of our request
 * bodies carries a live member OAuth token, so "store the request for
 * debugging" is not a thing that may be added here later. A test asserts it.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../store/driver.ts';

/** How long a nonce is remembered. Twice the ±120s skew window. §1. */
export const NONCE_TTL_SECONDS = 240;

/**
 * How long an `in_flight` claim is honoured before another request may take
 * it over.
 *
 * This is a crash-recovery valve, not a timeout: if the process dies between
 * claiming a key and recording the result, the row would otherwise pin that
 * operation as permanently in-flight and the website could never retry it.
 * 60s is far outside any action's own budget (the longest is 2s), so a live
 * request is never stolen from itself.
 */
export const CLAIM_STALE_SECONDS = 60;

export interface StoredResult {
  outcome: string;
  result: Record<string, unknown>;
}

export type IdempotencyClaim =
  /** This request owns the operation and should carry it out. */
  | { state: 'claimed' }
  /** Already done. Return the stored result and make no Discord call. */
  | { state: 'replayed'; stored: StoredResult }
  /** A previous attempt is still running. The caller should retry shortly. */
  | { state: 'in_flight' }
  /** Same key, different body. A caller bug, and never retryable. */
  | { state: 'mismatch' };

export interface AuditRow {
  requestId: string;
  keyId: string | null;
  action: string | null;
  idempotencyKey: string | null;
  outcome: string;
  code: string | null;
  status: number;
  reason: string | null;
  durationMs: number;
}

/** sha256 of the raw bytes we received. Never the bytes themselves. */
export function requestHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface InternalActionStoreOptions {
  /** Injectable clock, milliseconds. Tests use it to age rows. */
  now?: () => number;
  nonceTtlSeconds?: number;
  claimStaleSeconds?: number;
}

export class InternalActionStore {
  private db: Db;
  private now: () => number;
  private nonceTtlMs: number;
  private claimStaleMs: number;
  /** Last nonce sweep, so we do not delete-by-range on every single request. */
  private lastSweptAt = 0;

  constructor(db: Db, opts: InternalActionStoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.nonceTtlMs = (opts.nonceTtlSeconds ?? NONCE_TTL_SECONDS) * 1000;
    this.claimStaleMs = (opts.claimStaleSeconds ?? CLAIM_STALE_SECONDS) * 1000;
  }

  // --- replay guard ---------------------------------------------------------

  /**
   * Record a nonce for this caller. False means it was already used and still
   * inside the TTL, which is a replay.
   *
   * Check-and-insert is one statement on purpose. Two processes doing "SELECT
   * then INSERT" would both pass the check; `ON CONFLICT DO NOTHING ...
   * RETURNING` makes the database pick the winner, and the losing side gets no
   * row back. That is the same idiom EventStore.record() uses, and it is the
   * reason this is safe now that the bot is not the only writer.
   */
  async offerNonce(keyId: string, nonce: string): Promise<boolean> {
    const t = this.now();
    await this.sweepNonces(t);

    const won = await this.db
      .prepare(
        `INSERT INTO internal_nonces (key_id, nonce, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (key_id, nonce) DO NOTHING
         RETURNING nonce`,
      )
      .get<{ nonce: string }>(keyId, nonce, iso(t));
    if (won) return true;

    // A row exists. It is only a replay if it is still inside the TTL - an
    // expired row that the sweep has not reached yet must not reject a
    // legitimately fresh nonce.
    const row = await this.db
      .prepare(`SELECT seen_at FROM internal_nonces WHERE key_id = ? AND nonce = ?`)
      .get<{ seen_at: string }>(keyId, nonce);
    if (row && t - Date.parse(row.seen_at) >= this.nonceTtlMs) {
      await this.db
        .prepare(`UPDATE internal_nonces SET seen_at = ? WHERE key_id = ? AND nonce = ?`)
        .run(iso(t), keyId, nonce);
      return true;
    }
    return false;
  }

  /**
   * Drop expired nonces. Throttled to once per quarter-TTL because it is a
   * ranged DELETE and the alternative is an extra write on every request; the
   * table's ceiling is the rate limit over one TTL either way, a few hundred
   * rows.
   */
  async sweepNonces(nowMs = this.now(), force = false): Promise<number> {
    if (!force && nowMs - this.lastSweptAt < this.nonceTtlMs / 4) return 0;
    this.lastSweptAt = nowMs;
    const res = await this.db
      .prepare(`DELETE FROM internal_nonces WHERE seen_at < ?`)
      .run(iso(nowMs - this.nonceTtlMs));
    return res.changes;
  }

  // --- idempotency ----------------------------------------------------------

  /**
   * Claim an operation, or find out what happened to it last time.
   *
   * The four answers are the four things that can be true, and the caller must
   * handle all of them - see §2's `in_progress` row. The order of the checks
   * below is deliberate: a body mismatch is reported before a stored result,
   * because a caller reusing a key for a different operation has a bug and
   * silently handing back the *other* operation's result would hide it.
   */
  async claim(
    keyId: string,
    idempotencyKey: string,
    action: string,
    hash: string,
  ): Promise<IdempotencyClaim> {
    const t = this.now();

    const won = await this.db
      .prepare(
        `INSERT INTO internal_idempotency
           (key_id, idempotency_key, action, request_hash, state, claimed_at)
         VALUES (?, ?, ?, ?, 'in_flight', ?)
         ON CONFLICT (key_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
      )
      .get<{ idempotency_key: string }>(keyId, idempotencyKey, action, hash, iso(t));
    if (won) return { state: 'claimed' };

    const row = await this.read(keyId, idempotencyKey);
    // Deleted between our INSERT losing and this SELECT - a failed attempt
    // releasing its row. Treat it as still running; the caller retries.
    if (!row) return { state: 'in_flight' };

    if (row.request_hash !== hash) return { state: 'mismatch' };

    if (row.state === 'done') {
      return {
        state: 'replayed',
        stored: {
          outcome: row.outcome ?? 'unknown',
          result: parseResult(row.result_json),
        },
      };
    }

    // in_flight. Only take it over if the holder is old enough to be a corpse.
    if (t - Date.parse(row.claimed_at) < this.claimStaleMs) return { state: 'in_flight' };

    const taken = await this.db
      .prepare(
        `UPDATE internal_idempotency SET claimed_at = ?
         WHERE key_id = ? AND idempotency_key = ? AND state = 'in_flight' AND claimed_at < ?`,
      )
      .run(iso(t), keyId, idempotencyKey, iso(t - this.claimStaleMs));
    // changes = 0 means somebody else reclaimed it first, or it completed
    // while we were deciding. Either way it is not ours.
    return taken.changes === 1 ? { state: 'claimed' } : { state: 'in_flight' };
  }

  /** Record the result, so a retry replays it instead of acting again. */
  async complete(
    keyId: string,
    idempotencyKey: string,
    stored: StoredResult,
  ): Promise<void> {
    const t = this.now();
    await this.db
      .prepare(
        `UPDATE internal_idempotency
            SET state = 'done', outcome = ?, result_json = ?, completed_at = ?
          WHERE key_id = ? AND idempotency_key = ?`,
      )
      .run(stored.outcome, JSON.stringify(stored.result), iso(t), keyId, idempotencyKey);
  }

  /**
   * Give the key back after a failed attempt.
   *
   * We delete rather than store the failure. The website is told `retryable`
   * for exactly the errors where a second attempt might work, and a retry that
   * got a cached 502 back would make that promise a lie. A failed attempt made
   * no lasting change at Discord, so there is nothing to be idempotent about.
   */
  async release(keyId: string, idempotencyKey: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM internal_idempotency
          WHERE key_id = ? AND idempotency_key = ? AND state = 'in_flight'`,
      )
      .run(keyId, idempotencyKey);
  }

  private read(keyId: string, idempotencyKey: string) {
    return this.db
      .prepare(
        `SELECT action, request_hash, state, outcome, result_json, claimed_at
           FROM internal_idempotency WHERE key_id = ? AND idempotency_key = ?`,
      )
      .get<{
        action: string;
        request_hash: string;
        state: string;
        outcome: string | null;
        result_json: string | null;
        claimed_at: string;
      }>(keyId, idempotencyKey);
  }

  // --- audit ----------------------------------------------------------------

  /**
   * One row per request, accepted or rejected. §4.
   *
   * Best-effort by construction: the caller must not let an audit failure turn
   * a completed Discord action into a 500 the website will retry. The throw is
   * swallowed at the call site and the structured stdout line still happens,
   * so a database outage degrades the audit trail rather than the endpoint.
   */
  async recordAudit(row: AuditRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO internal_action_log
           (request_id, key_id, action, idempotency_key, outcome, code, status, reason, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO NOTHING`,
      )
      .run(
        row.requestId,
        row.keyId,
        row.action,
        row.idempotencyKey,
        row.outcome,
        row.code,
        row.status,
        row.reason,
        row.durationMs,
        iso(this.now()),
      );
  }

  // --- event_key -> discord event id ---------------------------------------

  /** The Discord scheduled event we created for this key, if any. */
  async discordEventId(guildId: string, eventKey: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT discord_event_id FROM internal_discord_events
          WHERE guild_id = ? AND event_key = ?`,
      )
      .get<{ discord_event_id: string }>(guildId, eventKey);
    return row?.discord_event_id ?? null;
  }

  /** Remember the mapping. Idempotent, so a repeat create cannot fork it. */
  async rememberDiscordEvent(guildId: string, eventKey: string, discordEventId: string): Promise<void> {
    const t = iso(this.now());
    await this.db
      .prepare(
        `INSERT INTO internal_discord_events
           (guild_id, event_key, discord_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, event_key)
           DO UPDATE SET discord_event_id = excluded.discord_event_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, eventKey, discordEventId, t, t);
  }
}

function parseResult(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
