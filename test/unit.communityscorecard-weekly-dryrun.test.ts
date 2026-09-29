/**
 * TOG-8294: `scripts/community-scorecard.ts --dry-run` prints the weekly
 * scorecard with zero side effects.
 *
 * The script path is `runPreviousClosedCommunityWeek(..., { dryRun: true })`
 * with migrations skipped at open. This test proves the acceptance on a
 * seeded offline DB (node:sqlite facade, no Postgres, no network):
 *
 *   1. two dry-run calls return byte-identical JSON (generatedAt is pinned to
 *      the closed-week end, so output is deterministic),
 *   2. `community_scorecard_runs` and `community_scorecard_alerts` stay empty
 *      and no write statement (`run`/`exec`) is issued during either call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { COMMUNITY_FACT_TYPES } from '../src/analytics/communityFacts.ts';
import { runPreviousClosedCommunityWeek } from '../src/analytics/communityScorecard.ts';
import type { Db, Statement } from '../src/store/db.ts';

const GUILD = 'dryrun-guild';
const NOW = '2026-09-07T06:15:00.000Z';
const WEEK_START = '2026-08-31T00:00:00.000Z';
const WEEK_END = '2026-09-07T00:00:00.000Z';
const CLASSIFIER_VERSION = 'community-test-v1';

// --- minimal Db over node:sqlite, with a write counter ------------------------

let writes = 0;

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      writes++;
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE community_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, event_type TEXT NOT NULL,
    source_event_id TEXT NOT NULL, actor_id TEXT, occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
    classifier_version TEXT NOT NULL, classification TEXT NOT NULL,
    matched_rule TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  )`);
  db.exec(`CREATE TABLE community_stream_heartbeats (
    guild_id TEXT NOT NULL, stream TEXT NOT NULL, covered_from TEXT NOT NULL,
    covered_through TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, stream)
  )`);
  db.exec(`CREATE TABLE community_scorecard_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, week_start TEXT NOT NULL,
    week_end TEXT NOT NULL, classifier_version TEXT NOT NULL, watermark INTEGER NOT NULL,
    input_count INTEGER NOT NULL, input_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL, run_status TEXT NOT NULL, coverage_state TEXT NOT NULL,
    evidence_state TEXT NOT NULL, scorecard_json TEXT NOT NULL,
    intervention_code TEXT NOT NULL, generated_at TEXT NOT NULL,
    UNIQUE (guild_id, week_start, classifier_version, revision)
  )`);
  db.exec(`CREATE TABLE community_scorecard_alerts (
    guild_id TEXT NOT NULL, week_start TEXT NOT NULL, alert_key TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (guild_id, alert_key)
  )`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { writes++; db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

async function seed(db: Db): Promise<void> {
  const messages = [
    { id: 'msg-1', actor: 'dryrun-user-1', at: '2026-09-02T12:00:00.000Z' },
    { id: 'msg-2', actor: 'dryrun-user-2', at: '2026-09-03T12:00:00.000Z' },
  ];
  for (const m of messages) {
    await db
      .prepare(`INSERT INTO community_facts
        (guild_id, event_type, source_event_id, actor_id, occurred_at, source,
         classifier_version, classification, matched_rule, metadata, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        GUILD, 'message_created', m.id, m.actor, m.at, 'channel:general',
        CLASSIFIER_VERSION, 'eligible_human', 'no_exclusion_matched',
        JSON.stringify({ channelId: 'general', channelClass: 'human' }),
        `discord-message:${m.id}`,
      );
  }
  for (const stream of COMMUNITY_FACT_TYPES) {
    await db
      .prepare(`INSERT INTO community_stream_heartbeats
        (guild_id, stream, covered_from, covered_through, updated_at)
        VALUES (?, ?, ?, ?, ?)`)
      .run(GUILD, stream, WEEK_START, WEEK_END, NOW);
  }
}

async function rowCount(db: Db, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>();
  return Number(row?.n ?? 0);
}

// --- the proof -----------------------------------------------------------------

test('weekly dry-run twice: identical output, zero DB writes', async () => {
  const db = openOfflineDb();
  try {
    await seed(db);
    writes = 0; // seeding is setup; the dry-runs below must not write.

    const first = await runPreviousClosedCommunityWeek(db, GUILD, CLASSIFIER_VERSION, {
      now: new Date(NOW), dryRun: true,
    });
    const second = await runPreviousClosedCommunityWeek(db, GUILD, CLASSIFIER_VERSION, {
      now: new Date(NOW), dryRun: true,
    });

    // 1. Byte-identical output across both runs.
    assert.equal(first.reused, false);
    assert.equal(second.reused, false);
    assert.equal(first.alertEmitted, false);
    assert.equal(second.alertEmitted, false);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    // The pin that makes determinism possible: generatedAt is the closed-week
    // end, not wall-clock time.
    assert.equal(first.scorecard.generatedAt, WEEK_END);
    assert.equal(first.scorecard.weekStart, WEEK_START);
    assert.equal(first.scorecard.weekEnd, WEEK_END);

    // 2. Zero side effects: no run row, no alert row, no write statement.
    assert.equal(await rowCount(db, 'community_scorecard_runs'), 0);
    assert.equal(await rowCount(db, 'community_scorecard_alerts'), 0);
    assert.equal(writes, 0, 'dry-run issued a DB write');

    console.log(`WEEKLY_DRYRUN_EVIDENCE ${JSON.stringify({
      rawFactCount: first.scorecard.rawFactCount,
      coverageState: first.scorecard.coverageState,
      intervention: first.scorecard.intervention.code,
      identical: JSON.stringify(second) === JSON.stringify(first),
      runRows: 0,
      alertRows: 0,
      writes,
    })}`);
  } finally {
    await db.close();
  }
});
