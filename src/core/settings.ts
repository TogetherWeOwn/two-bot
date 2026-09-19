/**
 * The config store (TOG-3093 slice 1, shipped with slice 2 / TOG-3101).
 *
 * It arrives on slice 2's branch rather than its own because `settings.get` /
 * `settings.set` are the only writers it has: a table with no verb that can
 * reach it is neither testable nor reviewable. What stays on TOG-3100 is the
 * half that is not needed to make those verbs correct - `loadConfig()` reading
 * store-first, the wiring in `src/index.ts`, and the HOT/COLD/ENV-ONLY
 * classification of all 90 env names. Until that lands a stored value is
 * durable, versioned and audited, but the running bot still reads its
 * environment. Nothing here claims otherwise.
 *
 * Settings live in `guild_settings` and the environment is the permanent
 * fallback: a key with no row reads from `process.env` exactly as it did
 * before this file existed. That is deliberate and not a migration step. It
 * means the day this ships nothing changes, the Coolify environment can be
 * emptied one key at a time, and the undo path for the whole admin-dashboard
 * programme is "stop writing rows".
 *
 * Reload is a **poll**, not LISTEN/NOTIFY. `SELECT max(version)` every 15s is
 * one trivial query against an index; NOTIFY needs a dedicated connection with
 * its own reconnect handling, and docs/STACK.md sizes the pool at 5 on purpose.
 * The cost of the choice is that a save takes up to 15s to land, which is the
 * trigger to revisit it.
 *
 * What this file will NOT hold: any key `src/core/settingsCatalog.ts` classes
 * as `env_only`. Those are the secrets, the boot inputs, the network binds and
 * the switches that decide what the website may make the bot do, so a settings
 * write that could set one is a privilege-escalation primitive - see the
 * `admin-config-adr` document on TOG-3093 §2.4, and the CHECK constraints in
 * migrations/0026_guild_settings.sql and 0027_guild_settings_env_only.sql that
 * say the same thing in the schema.
 *
 * That refusal was a bare `TWO_INTERNAL_*` prefix test when this file shipped
 * on PR #125. The TOG-3183 security review showed the prefix is narrower than
 * the set of keys that gate capability - `TWO_MODERATION` co-gates nine
 * moderation verbs from outside the namespace - so the test now delegates to
 * the catalog, which is fail-closed for names it has never heard of.
 */
import type { Db } from '../store/driver.ts';
import { log } from './log.ts';
import { isEnvOnlyKey } from './settingsCatalog.ts';

export { ENV_ONLY_KEY_PREFIXES } from './settingsCatalog.ts';

export class EnvOnlyKeyError extends Error {
  // Assigned in the body, not as a parameter property: tsconfig sets
  // `erasableSyntaxOnly` and Node strips types rather than compiling them, so
  // `constructor(readonly key: string)` is a runtime SyntaxError here.
  // docs/STACK.md, and TOG-3093 ADR §2.5.4.
  readonly key: string;

  constructor(key: string) {
    super(
      `${key} is environment-only and must never be stored in guild_settings. ` +
        `Secrets, boot inputs, network binds and the keys that gate what the ` +
        `website may make the bot do stay in the environment; a settings write ` +
        `that could set one is a privilege-escalation primitive. A key that is ` +
        `simply absent from src/core/settingsCatalog.ts is refused for the same ` +
        `reason - classify it there first ` +
        `(docs/INTERNAL_ACTIONS.md, TOG-3093 ADR §2.4, TOG-3183).`,
    );
    this.name = 'EnvOnlyKeyError';
    this.key = key;
  }
}

/**
 * False for any key that must stay in the environment.
 *
 * Delegates to the catalog so there is exactly one answer to "may this be
 * stored", shared by the write path, the env snapshot and the drift test.
 */
export function isStorableKey(key: string): boolean {
  return !isEnvOnlyKey(key);
}

/** Throws `EnvOnlyKeyError` rather than returning false. For write paths. */
export function assertStorableKey(key: string): void {
  if (!isStorableKey(key)) throw new EnvOnlyKeyError(key);
}

/**
 * A stored JSON value rendered the way the environment would have carried it,
 * because every reader in `src/` was written against an environment string.
 *
 * Booleans become `'1'`/`'0'` rather than `'true'`/`'false'`: every boolean env
 * var in this codebase is tested with `=== '1'` or `!== '0'`, so `'true'` would
 * store cleanly, read back cleanly, and silently mean off.
 */
export function toEnvString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  // Id lists are comma-separated in the environment and stay that way here, so
  // the UI can store a real array without every reader learning a second shape.
  if (Array.isArray(value)) return value.map((v) => toEnvString(v) ?? '').join(',');
  return JSON.stringify(value);
}

export interface SettingRow {
  guildId: string;
  key: string;
  value: unknown;
  version: string;
}

export interface SettingsStoreOptions {
  /** How often the version poll runs. Default 15s (TOG-3093 ADR §2.1). */
  pollSeconds?: number;
  /** Injectable for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * In-memory cache over `guild_settings`, refreshed by a version poll.
 *
 * Reads are synchronous and never touch the database, because the callers are
 * gateway handlers on a hot path. Staleness is bounded by `pollSeconds`.
 */
export class SettingsStore {
  private readonly pollMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  /** guildId -> key -> value, as stored (JSON, not the env rendering). */
  private cache = new Map<string, Map<string, unknown>>();
  /** Highest `version` the cache has seen. `0` means "nothing loaded yet". */
  private version = 0n;
  /**
   * Rows the cache was built from. Half of the change detector, not a statistic.
   *
   * `max(version)` alone cannot see a delete: the version lived in the row, so
   * removing it leaves the maximum over what is left exactly where it was unless
   * the deleted row happened to hold it. See `refreshIfChanged()`.
   */
  private rowCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: (() => void)[] = [];
  private readonly db: Db;

  constructor(db: Db, opts: SettingsStoreOptions = {}) {
    this.db = db;
    this.pollMs = (opts.pollSeconds ?? 15) * 1000;
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
  }

  /** Called after every refresh that actually changed something. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Fill the cache from the database. Call once before reading. */
  async load(): Promise<void> {
    const rows = await this.db
      .prepare(`SELECT guild_id, key, value, version FROM guild_settings`)
      .all<{ guild_id: string; key: string; value: unknown; version: string | number }>();

    const next = new Map<string, Map<string, unknown>>();
    let max = 0n;
    for (const r of rows) {
      let byKey = next.get(r.guild_id);
      if (!byKey) {
        byKey = new Map();
        next.set(r.guild_id, byKey);
      }
      byKey.set(r.key, r.value);
      const v = BigInt(r.version);
      if (v > max) max = v;
    }
    this.cache = next;
    this.version = max;
    this.rowCount = rows.length;
  }

  /**
   * One cheap query, and a full refetch only when the answer moved.
   *
   * The query is `max(version)` **and** `count(*)`, because neither alone sees
   * every change. Found on staging (TOG-3100): deleting `TWO_RAID_JOIN_THRESHOLD`
   * while a second key was stored left `max(version)` exactly where it was - the
   * deleted row was not the one holding the maximum - so the running bot kept
   * serving a value that was no longer in the table, and kept serving it until
   * the next unrelated save. `settings.set()` does burn a `nextval` on delete,
   * which looks like it covers this and cannot: the number it allocates is
   * discarded along with the row, so nothing observable moves.
   *
   * The pair is sufficient, and the argument is short. Versions are only ever
   * issued by one monotonic sequence. If the stored set changed, then either a
   * row was inserted or updated - taking a version strictly greater than every
   * one issued before, so `max` rises - or the change was deletions only, so
   * `count` falls. A change that both adds and removes still raises `max`. So
   * both unchanged means nothing changed.
   *
   * Returns true when the cache changed, which is what the tests assert on and
   * what drives the change log line.
   */
  async refreshIfChanged(): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT COALESCE(max(version), 0) AS v, count(*) AS n FROM guild_settings`)
      .get<{ v: string | number; n: string | number }>();
    const latest = BigInt(row?.v ?? 0);
    const rows = Number(row?.n ?? 0);
    // `!==` rather than `>`, so a restored backup with a lower sequence reloads
    // too. A lower max means rows went away, which is a real change.
    if (latest === this.version && rows === this.rowCount) return false;

    const before = this.version;
    const beforeRows = this.rowCount;
    await this.load();
    for (const fn of this.listeners) fn();
    // Both counts, not just the versions: on a pure delete the versions are
    // identical and the row count is the only thing that moved, so a line
    // carrying versions alone would read as a reload that reloaded nothing.
    log.info('settings_reloaded', {
      fromVersion: String(before),
      toVersion: String(this.version),
      fromKeys: beforeRows,
      keys: this.size(),
    });
    return true;
  }

  /** Start the version poll. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      this.refreshIfChanged().catch((err) => {
        // A settings poll that throws must not take the bot down: the cache it
        // failed to refresh is still serving the last good values, and the
        // environment is still behind that.
        log.error('settings_poll_failed', { err: String(err) });
      });
    }, this.pollMs);
    // The poll must never be the reason the process stays alive.
    this.timer.unref?.();
    log.info('settings_poll_started', { pollSeconds: this.pollMs / 1000 });
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** Rows currently cached, across all guilds. */
  size(): number {
    let n = 0;
    for (const byKey of this.cache.values()) n += byKey.size;
    return n;
  }

  currentVersion(): string {
    return String(this.version);
  }

  /** The stored JSON value, or undefined when the key falls through to env. */
  get(guildId: string, key: string): unknown {
    return this.cache.get(guildId)?.get(key);
  }

  /**
   * The cached settings for one guild, rendered as environment strings.
   *
   * This is what `loadConfig()` reads through. Values that render to undefined
   * (JSON null, a non-finite number) are omitted rather than stored as empty,
   * so they fall through to the environment instead of masking it with "".
   */
  envSnapshot(guildId: string | null): Map<string, string> {
    const out = new Map<string, string>();
    if (guildId === null) return out;
    for (const [key, value] of this.cache.get(guildId) ?? []) {
      if (!isStorableKey(key)) continue; // belt and braces; the schema refuses these
      const s = toEnvString(value);
      if (s !== undefined) out.set(key, s);
    }
    return out;
  }

  /**
   * Write one setting and its audit row in one transaction, bumping the global
   * version so every process's next poll picks it up.
   *
   * `value === null` deletes the row, which hands the key back to the
   * environment. That is the documented way to undo a setting, so it gets the
   * same audit row as any other change.
   */
  async set(guildId: string, key: string, value: unknown, actor: string): Promise<void> {
    assertStorableKey(key);
    if (!actor) throw new Error('settings writes must name an actor');

    await this.db.transaction(async (tx) => {
      const prev = await tx
        .prepare(`SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?`)
        .get<{ value: unknown }>(guildId, key);

      if (value === null) {
        // No `nextval` here. There used to be one, with a comment claiming it
        // was what made other processes notice the delete, and it was not: the
        // number it allocated went nowhere, because the row that would have
        // carried it is the row being removed. What actually makes a delete
        // visible is the row count in `refreshIfChanged()`.
        await tx.prepare(`DELETE FROM guild_settings WHERE guild_id = ? AND key = ?`).run(guildId, key);
      } else {
        await tx
          .prepare(
            `INSERT INTO guild_settings (guild_id, key, value, version, updated_at, updated_by)
             VALUES (?, ?, ?::jsonb, nextval('guild_settings_version_seq'), now(), ?)
             ON CONFLICT (guild_id, key) DO UPDATE
               SET value = EXCLUDED.value,
                   version = EXCLUDED.version,
                   updated_at = EXCLUDED.updated_at,
                   updated_by = EXCLUDED.updated_by`,
          )
          .run(guildId, key, JSON.stringify(value), actor);
      }

      await tx
        .prepare(
          `INSERT INTO guild_settings_audit (guild_id, key, old_value, new_value, actor, at)
           VALUES (?, ?, ?::jsonb, ?::jsonb, ?, now())`,
        )
        .run(
          guildId,
          key,
          prev === undefined ? null : JSON.stringify(prev.value),
          value === null ? null : JSON.stringify(value),
          actor,
        );
    });
  }
}
