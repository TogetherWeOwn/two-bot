/**
 * TOG-7191: community snapshot + scorecard dry-run on a seeded DB, with evidence.
 *
 * What "dry-run" means here: the two jobs run end to end against a seeded
 * database and a stubbed Discord read path, and the test asserts the exact
 * numbers. Nothing leaves the process: a global fetch trap fails the run on
 * any real network call, and the Discord stub serves the fixture roster.
 *
 * The seed is `test/fixtures/community-scorecard-dryrun.ts` (nine-member
 * roster grounding the three real raid windows, plus five eligible_human
 * messages covering the closed week 2026-08-31..2026-09-07). The test pins:
 *
 *   1. `runRankSnapshotCycle` returns the hand-computed snapshot exactly and
 *      publishes it to the counter, rank and exclusion tables,
 *   2. `runPreviousClosedCommunityWeek` (the `scripts/community-scorecard.ts`
 *      path) returns the hand-computed scorecard exactly and persists the
 *      identical JSON to `community_scorecard_runs`,
 *   3. the dry-run made exactly two Discord reads (one member page, one role
 *      list) and zero real network calls,
 *   4. the three in-scope files expose no send surface (static pin).
 *
 * Runs without Postgres or a token: node:sqlite backs the narrow Db surface
 * both jobs touch. The Postgres-backed `unit.communitysnapshots`,
 * `unit.communityscorecard` and `unit.communityscorecardjob` suites cover the
 * same jobs against the real driver in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { CommunityFactStore, COMMUNITY_FACT_TYPES } from '../src/analytics/communityFacts.ts';
import { runPreviousClosedCommunityWeek } from '../src/analytics/communityScorecard.ts';
import { ANOMALIES, windowBounds } from '../src/analytics/anomalies.ts';
import { RANKS, buildCommunitySnapshot, runRankSnapshotCycle } from '../src/jobs/communitySnapshots.ts';
import type { RawMember } from '../src/discord/rest.ts';
import type { Db, Statement } from '../src/store/db.ts';
import { stubRest } from './helpers/stubRest.ts';
import {
  DRYRUN_CLASSIFIER_VERSION,
  DRYRUN_GUILD,
  DRYRUN_NOW,
  DRYRUN_RAID_GROUNDING,
  DRYRUN_ROSTER,
  DRYRUN_WEEK_END,
  DRYRUN_WEEK_MESSAGES,
  DRYRUN_WEEK_START,
  EXPECTED_SCORECARD,
  EXPECTED_SNAPSHOT,
} from './fixtures/community-scorecard-dryrun.ts';

// --- no-send traps ----------------------------------------------------------
// The scorecard half takes no Discord client at all; the snapshot half reads
// two stubbed endpoints. The fetch trap throws on any real network use;
// silence at the end of the dry-run is the pass.

function installFetchTrap(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error(`TOG-7191: dry-run attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

// --- minimal Db over node:sqlite ---------------------------------------------

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, first_message_at TEXT,
    first_voice_at TEXT, last_active_at TEXT, left_at TEXT,
    inactive_flagged_at TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  db.exec(`CREATE TABLE counter_snapshots (
    guild_id TEXT PRIMARY KEY, human_member_count INTEGER, human_member_count_at TEXT
  )`);
  db.exec(`CREATE TABLE guild_counters (
    guild_id TEXT PRIMARY KEY, human_member_count INTEGER, human_member_count_at TEXT
  )`);
  db.exec(`CREATE TABLE web_contract_meta (
    singleton INTEGER PRIMARY KEY, contract_version TEXT NOT NULL, guild_id TEXT
  )`);
  db.exec(`INSERT INTO web_contract_meta (singleton, contract_version) VALUES (1, '1.0')`);
  db.exec(`CREATE TABLE rank_ladder (
    rank_key TEXT PRIMARY KEY, rank_label TEXT NOT NULL, rank_order INTEGER NOT NULL UNIQUE, role_id TEXT
  )`);
  for (const rank of RANKS) {
    db.prepare(`INSERT INTO rank_ladder (rank_key, rank_label, rank_order) VALUES (?, ?, ?)`)
      .run(rank.key, rank.label, rank.order);
  }
  db.exec(`CREATE TABLE rank_snapshots (
    guild_id TEXT NOT NULL, rank_key TEXT NOT NULL, member_count INTEGER,
    holders_count INTEGER, snapshot_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, rank_key)
  )`);
  db.exec(`CREATE TABLE member_ranks (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL, rank_key TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, member_id)
  )`);
  db.exec(`CREATE TABLE member_exclusions (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, member_id)
  )`);
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
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

// --- seed helpers -------------------------------------------------------------

function rosterMembers(): RawMember[] {
  return DRYRUN_ROSTER.map((m) => ({
    user: { id: m.id, bot: m.bot },
    roles: m.heldRanks.map((rank) => `role-${rank}`),
  }));
}

/** One never-active member inside each of the three real raid windows. */
async function groundRaids(db: Db): Promise<void> {
  for (const [memberId, anomalyId] of Object.entries(DRYRUN_RAID_GROUNDING)) {
    const anomaly = ANOMALIES.find((a) => a.id === anomalyId);
    assert.ok(anomaly, `fixture grounds unknown anomaly ${anomalyId}`);
    const { from } = windowBounds(anomaly);
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, 0)`)
      .run(DRYRUN_GUILD, memberId, from);
  }
}

function stubDiscord(roster: RawMember[]) {
  const roleRows = RANKS.map((rank) => ({ id: `role-${rank.key}`, name: rank.label }));
  return stubRest((path) => {
    if (path.endsWith('/roles')) return roleRows;
    if (path.includes('/members?')) return roster;
    return undefined;
  });
}

// --- the static pin: the in-scope files never send -----------------------------

test('snapshot jobs and scorecard script expose no send surface', () => {
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const snapshotJob = strip(readFileSync(new URL('../src/jobs/communitySnapshots.ts', import.meta.url), 'utf8'));
  const scorecardJob = strip(readFileSync(new URL('../src/jobs/communityScorecard.ts', import.meta.url), 'utf8'));
  const script = strip(readFileSync(new URL('../scripts/community-scorecard.ts', import.meta.url), 'utf8'));

  // The snapshot collector reads the roster and the role list. Those are GETs;
  // a new verb on either job file is a send path and fails here first.
  for (const [name, src] of [['communitySnapshots.ts', snapshotJob], ['communityScorecard.ts', scorecardJob]] as const) {
    const restCalls = [...src.matchAll(/rest\.(\w+)\s*[<(]/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(restCalls)].filter((verb) => verb !== 'get'),
      [],
      `${name} reaches a non-read Discord verb`,
    );
  }
  // The reporting script holds no Discord client at all: it opens the DB,
  // scores the closed week, and prints JSON. (The DISCORD_GUILD_ID env name
  // is fine; what must never appear is client surface.)
  for (const pat of [/DiscordRest/, /discord\.js/i, /discord\.com\/api/, /rest\.\w+\s*[<(]/]) {
    assert.ok(!pat.test(script), `scripts/community-scorecard.ts touches Discord client surface: ${pat}`);
  }
  for (const [name, src] of [['snapshot job', snapshotJob], ['scorecard job', scorecardJob], ['script', script]] as const) {
    for (const pat of [/\.send\s*\(/, /createDM/, /users\.fetch/, /channels\.fetch/, /Webhook/, /\.post\s*\(/, /\.put\s*\(/, /\.patch\s*\(/, /\.delete\s*\(/, /fetch\s*\(/]) {
      assert.ok(!pat.test(src), `${name} reaches a send-shaped API: ${pat}`);
    }
  }
});

// --- the dry-run ------------------------------------------------------------------

test('rank snapshot dry-run: exact snapshot, exact tables, two reads, zero network', async () => {
  const trap = installFetchTrap();
  try {
    const db = openOfflineDb();
    try {
      await groundRaids(db);
      const roster = rosterMembers();
      const { rest, paths } = stubDiscord(roster);

      const res = await runRankSnapshotCycle({
        db, rest, guildId: DRYRUN_GUILD, now: () => DRYRUN_NOW,
      });

      // 1. The returned snapshot equals the hand-computed fixture exactly.
      assert.equal(res.recorded, true);
      assert.equal(res.humanMemberCount, EXPECTED_SNAPSHOT.humanMemberCount);
      assert.equal(res.rankedMemberCount, EXPECTED_SNAPSHOT.rankedMemberCount);
      assert.equal(res.raidAccountsExcluded, EXPECTED_SNAPSHOT.raidAccountsExcluded);
      const rankRoles = RANKS.map((rank) => ({ ...rank, roleId: `role-${rank.key}` }));
      // One window per raid account, in the same anomaly-start order the
      // collector reads them (2025-07-06, 2025-09-12, 2025-12-15): the
      // exclusion order is window order, not roster order.
      const windows = [
        { id: '2025-07-06-raid', excludedMemberIds: new Set(['raid-0']) },
        { id: '2025-09-12-raid', excludedMemberIds: new Set(['raid-2']) },
        { id: '2025-12-15-raid', excludedMemberIds: new Set(['raid-1']) },
      ];
      assert.deepEqual(buildCommunitySnapshot(roster, rankRoles, windows), EXPECTED_SNAPSHOT);

      // 2. The published tables say the same thing: one denominator in both
      //    counter tables, five aggregates, five highest ranks, three raids.
      for (const table of ['counter_snapshots', 'guild_counters']) {
        const row = await db
          .prepare(`SELECT human_member_count, human_member_count_at FROM ${table} WHERE guild_id = ?`)
          .get<{ human_member_count: number; human_member_count_at: string }>(DRYRUN_GUILD);
        assert.deepEqual({ ...row }, { human_member_count: 5, human_member_count_at: DRYRUN_NOW });
      }
      const ranks = await db
        .prepare(`SELECT rank_key, member_count, holders_count, snapshot_at FROM rank_snapshots ORDER BY rank_key`)
        .all<Record<string, unknown>>();
      assert.deepEqual(
        ranks.map((r) => ({ ...r })),
        ['legend', 'member', 'prospect', 'soldier', 'veteran'].map((key) => {
          const expected = EXPECTED_SNAPSHOT.rankRows.find((r) => r.key === key)!;
          return {
            rank_key: key, member_count: expected.memberCount,
            holders_count: expected.holdersCount, snapshot_at: DRYRUN_NOW,
          };
        }),
      );
      const memberRanks = await db
        .prepare(`SELECT member_id, rank_key FROM member_ranks ORDER BY member_id`)
        .all<Record<string, unknown>>();
      assert.deepEqual(
        memberRanks.map((r) => ({ ...r })),
        [
          { member_id: 'alice', rank_key: 'prospect' },
          { member_id: 'bob', rank_key: 'member' },
          { member_id: 'carol', rank_key: 'legend' },
          { member_id: 'dave', rank_key: null },
          { member_id: 'erin', rank_key: 'soldier' },
        ],
      );
      const exclusions = await db
        .prepare(`SELECT member_id FROM member_exclusions WHERE guild_id = ?`)
        .all<{ member_id: string }>(DRYRUN_GUILD);
      assert.deepEqual(
        exclusions.map((r) => r.member_id).sort(),
        [...EXPECTED_SNAPSHOT.excludedMemberIds].sort(),
      );

      // 3. Exactly two Discord reads (one member page, one role list), and the
      //    global fetch trap stayed silent: nothing left the process.
      assert.deepEqual(paths, [
        `/guilds/${DRYRUN_GUILD}/members?limit=1000&after=0`,
        `/guilds/${DRYRUN_GUILD}/roles`,
      ]);
      assert.deepEqual(trap.calls, [], 'dry-run made a network call');

      console.log(`SNAPSHOT_DRYRUN_EVIDENCE ${JSON.stringify({
        humanMemberCount: res.humanMemberCount,
        rankedMemberCount: res.rankedMemberCount,
        raidAccountsExcluded: res.raidAccountsExcluded,
        rankRows: EXPECTED_SNAPSHOT.rankRows.map((r) => `${r.key}:${r.memberCount}/${r.holdersCount}`),
        discordReads: paths.length,
        fetchCalls: trap.calls.length,
      })}`);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});

test('scorecard dry-run: exact scorecard JSON, persisted verbatim, zero network', async () => {
  const trap = installFetchTrap();
  try {
    const db = openOfflineDb();
    try {
      const classifier = new CommunityClassifier(loadCommunityClassifierConfig({
        TWO_COMMUNITY_CLASSIFIER_VERSION: DRYRUN_CLASSIFIER_VERSION,
      }));
      const facts = new CommunityFactStore(db, classifier);
      for (const m of DRYRUN_WEEK_MESSAGES) {
        await facts.record({
          guildId: DRYRUN_GUILD,
          eventType: 'message_created',
          sourceEventId: m.id,
          actorId: m.actorId,
          occurredAt: m.occurredAt,
          source: 'channel:general',
          idempotencyKey: `discord-message:${m.id}`,
          classification: {
            classification: 'eligible_human',
            classifierVersion: DRYRUN_CLASSIFIER_VERSION,
            matchedRule: 'no_exclusion_matched',
          },
          metadata: { channelId: 'general', channelClass: 'human' },
        });
      }
      for (const stream of COMMUNITY_FACT_TYPES) {
        await facts.markStreamCoverage(DRYRUN_GUILD, stream, DRYRUN_WEEK_START, DRYRUN_WEEK_END);
      }

      // The script path: score the previous closed week as of Monday 06:15 UTC.
      const { scorecard, reused, alertEmitted } = await runPreviousClosedCommunityWeek(
        db, DRYRUN_GUILD, DRYRUN_CLASSIFIER_VERSION, { now: new Date(DRYRUN_NOW) },
      );

      // 1. The scorecard equals the hand-computed fixture exactly.
      assert.equal(reused, false);
      assert.equal(alertEmitted, false, 'HOLD emits no alert');
      assert.deepEqual(
        {
          guildId: scorecard.guildId,
          weekStart: scorecard.weekStart,
          weekEnd: scorecard.weekEnd,
          generatedAt: scorecard.generatedAt,
          classifierVersion: scorecard.classifierVersion,
          watermark: scorecard.watermark,
          idempotencyKey: scorecard.idempotencyKey,
          revision: scorecard.revision,
          coverageState: scorecard.coverageState,
          evidenceState: scorecard.evidenceState,
          rawFactCount: scorecard.rawFactCount,
          weeklyActiveHumans: scorecard.weeklyActiveHumans,
          humanMessages: scorecard.humanMessages,
          eligibleJoins: scorecard.eligibleJoins,
          joinSources: scorecard.joinSources,
          eventAttendance: scorecard.eventAttendance,
          botNoise: scorecard.botNoise,
          firstHumanReply: scorecard.firstHumanReply,
          ingestionErrors: scorecard.ingestionErrors,
          intervention: scorecard.intervention,
          recommendationsEnabled: scorecard.recommendationsEnabled,
          killSwitchActive: scorecard.killSwitchActive,
        },
        EXPECTED_SCORECARD,
      );

      // 2. The persisted run is the same JSON verbatim: what the script would
      //    print is what the database holds.
      const stored = await db
        .prepare(`SELECT run_status, scorecard_json FROM community_scorecard_runs WHERE idempotency_key = ?`)
        .get<{ run_status: string; scorecard_json: string }>(EXPECTED_SCORECARD.idempotencyKey);
      assert.equal(stored?.run_status, 'completed');
      assert.deepEqual(JSON.parse(stored!.scorecard_json), JSON.parse(JSON.stringify(scorecard)));

      // 3. Nothing left the process.
      assert.deepEqual(trap.calls, [], 'dry-run made a network call');

      console.log(`SCORECARD_DRYRUN_EVIDENCE ${JSON.stringify({
        rawFactCount: scorecard.rawFactCount,
        weeklyActiveHumans: scorecard.weeklyActiveHumans,
        coverageState: scorecard.coverageState,
        evidenceState: scorecard.evidenceState,
        intervention: scorecard.intervention.code,
        fetchCalls: trap.calls.length,
      })}`);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});
