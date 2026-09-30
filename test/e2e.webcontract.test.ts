/**
 * The `web_v1` contract, checked against a real Postgres.
 *
 * These are the promises docs/WEBSITE_CONTRACT.md makes to the website team,
 * written as assertions so that breaking one is a red build rather than a
 * conversation six weeks later about why the landing page says 0.
 *
 * The ones that matter most, and are the easiest to break by accident:
 *
 *   - live_counts returns EXACTLY ONE ROW even when nothing has ever been
 *     collected. An empty table must still answer.
 *   - a count is NULL, never 0, when we do not know it - including when we knew
 *     it yesterday and the collector has since died.
 *   - rank_counts returns all five ranks even with no data, so the ladder never
 *     looks shorter than it is.
 *   - the milestone whitelist. A new event type must not appear on a public
 *     profile page just because someone started emitting it.
 *   - the website's role can read the views and NOTHING else.
 *
 * Run with TWO_TEST_DATABASE_URL pointing at an isolated Postgres database.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import type { Db } from '../src/store/db.ts';
import {
  applyWebContract,
  WEB_CONTRACT_VERSION,
  WEB_CONTRACT_VIEWS,
} from '../src/store/webContract.ts';
import { provisionWebRole, dropWebRole } from '../src/store/webRole.ts';
import { runWebRoleChecks, summarise } from '../src/store/webRoleCheck.ts';

const GUILD = '700000000000000001';
const ISO = (d: Date) => d.toISOString();
const agoMinutes = (n: number) => ISO(new Date(Date.now() - n * 60_000));
const inMinutes = (n: number) => ISO(new Date(Date.now() + n * 60_000));

describe('web_v1 contract', () => {
  let t: TestDb;
  let db: Db;
  let web: string;

  before(async () => {
    t = await openTestDb(import.meta.filename);
    db = t.db;
    const applied = await applyWebContract(db);
    web = applied.webSchema;
    assert.equal(web, t.webSchema);
  });

  after(async () => {
    await t.cleanup();
  });

  beforeEach(async () => {
    await t.reset();
  });

  // -------------------------------------------------------------------------
  // The views exist, and only the views exist
  // -------------------------------------------------------------------------

  test('every documented view exists, and nothing undocumented does', async () => {
    const rows = await db
      .prepare(`SELECT table_name FROM information_schema.views WHERE table_schema = ?`)
      .all<{ table_name: string }>(web);
    const present = rows.map((r) => r.table_name).sort();
    assert.deepEqual(present, [...WEB_CONTRACT_VIEWS].sort());
  });

  test('applying the contract twice is a no-op', async () => {
    // A view that cannot be re-applied is a view whose next deploy fails at
    // 3am rather than in CI.
    await applyWebContract(db);
    await applyWebContract(db);
    const rows = await db
      .prepare(`SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema = ?`)
      .get<{ n: number }>(web);
    assert.equal(rows?.n, WEB_CONTRACT_VIEWS.length);
  });

  test('contract_meta reports the version this build implements', async () => {
    const row = await db
      .prepare(`SELECT contract_version FROM ${web}.contract_meta`)
      .get<{ contract_version: string }>();
    assert.equal(row?.contract_version, WEB_CONTRACT_VERSION);
  });

  // -------------------------------------------------------------------------
  // live_counts: one row, always; null, never 0
  // -------------------------------------------------------------------------

  test('live_counts returns one all-null row when nothing has ever been collected', async () => {
    const rows = await db.prepare(`SELECT * FROM ${web}.live_counts`).all();
    assert.equal(rows.length, 1, 'the landing page must always get a row to render');
    assert.equal(rows[0].human_member_count, null);
    assert.equal(rows[0].online_count, null);
    assert.equal(rows[0].counts_updated_at, null);
    assert.equal(rows[0].online_updated_at, null);
  });

  test('live_counts publishes a fresh reading', async () => {
    await db
      .prepare(
        `INSERT INTO guild_counters (guild_id, human_member_count, human_member_count_at, online_count, online_count_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(GUILD, 84, agoMinutes(1), 26, agoMinutes(1));

    const row = await db.prepare(`SELECT * FROM ${web}.live_counts`).get();
    assert.equal(row?.human_member_count, 84);
    assert.equal(row?.online_count, 26);
  });

  test('an online count older than 15 minutes goes null, and keeps its timestamp', async () => {
    const readAt = agoMinutes(20);
    await db
      .prepare(
        `INSERT INTO guild_counters (guild_id, human_member_count, human_member_count_at, online_count, online_count_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(GUILD, 84, agoMinutes(1), 26, readAt);

    const row = await db.prepare(`SELECT * FROM ${web}.live_counts`).get();
    // Not 0, and not a stale 26 presented as current.
    assert.equal(row?.online_count, null);
    assert.equal(row?.human_member_count, 84, 'membership does not go stale at presence speed');
    // The website still needs to be able to say when we last knew.
    assert.equal(row?.online_updated_at, readAt);
  });

  test('a member count older than 24 hours goes null', async () => {
    const readAt = agoMinutes(25 * 60);
    await db
      .prepare(
        `INSERT INTO guild_counters (guild_id, human_member_count, human_member_count_at)
         VALUES (?, ?, ?)`,
      )
      .run(GUILD, 84, readAt);

    const row = await db.prepare(`SELECT * FROM ${web}.live_counts`).get();
    assert.equal(row?.human_member_count, null, 'a day-old count must not be published as current');
    assert.equal(row?.counts_updated_at, readAt);
  });

  test('a count cannot be stored without the time it was read', async () => {
    // The zero rule enforced in the schema: an undated count can never be aged
    // out, so it would be published as fresh forever.
    await assert.rejects(
      () =>
        db
          .prepare(`INSERT INTO guild_counters (guild_id, human_member_count) VALUES (?, ?)`)
          .run(GUILD, 84),
      /guild_counters_members_dated/,
    );
  });

  // -------------------------------------------------------------------------
  // rank_counts
  // -------------------------------------------------------------------------

  test('rank_counts returns all five ranks in ladder order with no data at all', async () => {
    const rows = await db.prepare(`SELECT * FROM ${web}.rank_counts`).all();
    assert.deepEqual(
      rows.map((r) => r.rank_key),
      ['prospect', 'member', 'soldier', 'veteran', 'legend'],
    );
    // Null, not 0. "Nobody is a Legend" and "we have not counted" are different
    // answers and the ladder must not conflate them.
    for (const r of rows) {
      assert.equal(r.member_count, null);
      assert.equal(r.holders_count, null);
    }
  });

  test('rank_counts exposes both readings, and ages them out together', async () => {
    const fresh = agoMinutes(5);
    await db
      .prepare(
        `INSERT INTO rank_snapshots (guild_id, rank_key, member_count, holders_count, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(GUILD, 'legend', 6, 6, fresh);
    await db
      .prepare(
        `INSERT INTO rank_snapshots (guild_id, rank_key, member_count, holders_count, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(GUILD, 'prospect', 10, 51, agoMinutes(25 * 60));

    const rows = await db.prepare(`SELECT * FROM ${web}.rank_counts`).all();
    const byKey = new Map(rows.map((r) => [r.rank_key as string, r]));

    assert.equal(byKey.get('legend')?.member_count, 6);
    assert.equal(byKey.get('legend')?.holders_count, 6);
    // The stacking ranks are why holders_count exists at all: 51 people hold
    // Prospect, but only 10 have it as their highest rank.
    assert.equal(byKey.get('prospect')?.member_count, null, 'a day-old snapshot is not current');
    assert.equal(byKey.get('prospect')?.holders_count, null);
    // Still returned, still in place on the ladder.
    assert.equal(byKey.get('soldier')?.rank_order, 3);
  });

  // -------------------------------------------------------------------------
  // members
  // -------------------------------------------------------------------------

  test('members excludes bots, keeps leavers, and precomputes tenure', async () => {
    const joined = ISO(new Date(Date.now() - 10 * 86_400_000));
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', joined, 0);
    await db
      .prepare(
        `INSERT INTO members (guild_id, member_id, joined_at, left_at, is_bot) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(GUILD, '222', joined, agoMinutes(60), 0);
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '999', joined, 1);

    const rows = await db.prepare(`SELECT * FROM ${web}.members ORDER BY member_id`).all();
    assert.deepEqual(
      rows.map((r) => r.member_id),
      ['111', '222'],
      'bots must never reach a member-facing view',
    );
    assert.equal(rows[0].tenure_days, 10);
    assert.equal(rows[0].is_current_member, true);
    // Someone who left stays in the view. Dropping them would quietly flatter
    // our retention numbers.
    assert.equal(rows[1].is_current_member, false);
    assert.equal(rows[0].rank_key, null, 'no rank role is a real state, not an error');
  });

  test('members surfaces the highest rank when one is recorded', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', agoMinutes(60), 0);
    await db
      .prepare(`INSERT INTO member_ranks (guild_id, member_id, rank_key, updated_at) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', 'soldier', agoMinutes(5));

    const row = await db.prepare(`SELECT * FROM ${web}.members`).get();
    assert.equal(row?.rank_key, 'soldier');
  });

  test('members excludes the same raid accounts as live and rank counts', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, 'human', agoMinutes(60), 0);
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, 'raid', agoMinutes(60), 0);
    await db
      .prepare(
        `INSERT INTO member_exclusions (guild_id, member_id, reason, updated_at)
         VALUES (?, ?, 'raid', ?)`,
      )
      .run(GUILD, 'raid', agoMinutes(5));

    const rows = await db.prepare(`SELECT member_id FROM ${web}.members ORDER BY member_id`).all();
    assert.deepEqual(rows.map((row) => row.member_id), ['human']);
  });

  test('members exposes no name, avatar or activity column', async () => {
    // §4 of the contract, enforced by what the website CAN read rather than by
    // what it chooses to render. Cheapest place to enforce a rule is the place
    // where breaking it is impossible.
    const cols = (
      await db
        .prepare(`SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'members'`)
        .all<{ column_name: string }>(web)
    ).map((r) => r.column_name);

    assert.deepEqual(cols.sort(), [
      'is_current_member',
      'joined_at',
      'member_id',
      'rank_key',
      'tenure_days',
    ]);
    for (const banned of ['username', 'nickname', 'avatar', 'last_active_at', 'first_message_at']) {
      assert.ok(!cols.includes(banned), `${banned} must not be in the contract`);
    }
  });

  // -------------------------------------------------------------------------
  // member_milestones
  // -------------------------------------------------------------------------

  test('member_milestones publishes the whitelist and drops everything else', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', agoMinutes(600), 0);

    const insert = db.prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    await insert.run('member_join', '111', GUILD, agoMinutes(600), 'invite:aB3xY9', null, 'k1');
    // Emitted, recorded, and deliberately NOT published: "first message at
    // 14:02" does not belong on a public profile.
    await insert.run('first_message', '111', GUILD, agoMinutes(500), 'channel:1', null, 'k2');
    await insert.run('voice_session_start', '111', GUILD, agoMinutes(400), 'channel:2', null, 'k3');
    await insert.run('member_leave', '111', GUILD, agoMinutes(100), 'unknown', null, 'k4');

    const rows = await db
      .prepare(`SELECT * FROM ${web}.member_milestones ORDER BY occurred_at`)
      .all();
    assert.deepEqual(
      rows.map((r) => r.milestone),
      ['joined', 'left'],
    );
  });

  test('member_milestones carries the new rank on a rank change', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', agoMinutes(600), 0);
    await db
      .prepare(
        `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('rank_changed', '111', GUILD, agoMinutes(200), 'job:ranks', '{"rank_key":"veteran"}', 'k5');

    const row = await db.prepare(`SELECT * FROM ${web}.member_milestones`).get();
    assert.equal(row?.milestone, 'rank_changed');
    assert.equal(row?.detail, 'veteran');
  });

  test('malformed metadata costs one null, not the query', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', agoMinutes(600), 0);
    await db
      .prepare(
        `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, metadata, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('rank_changed', '111', GUILD, agoMinutes(200), 'job:ranks', 'not json{', 'k6');

    // One bad row must not turn a page into a 500.
    const row = await db.prepare(`SELECT * FROM ${web}.member_milestones`).get();
    assert.equal(row?.detail, null);
  });

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  test('next_event returns zero rows when nothing is scheduled', async () => {
    const rows = await db.prepare(`SELECT * FROM ${web}.next_event`).all();
    assert.equal(rows.length, 0, 'the designed empty state must be reachable in production');
  });

  test('next_event is the soonest upcoming one, and past or cancelled ones are gone', async () => {
    const insert = db.prepare(
      `INSERT INTO scheduled_events (guild_id, event_id, name, starts_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    await insert.run(GUILD, 'e1', 'Sunday Squad', inMinutes(60), 'scheduled', agoMinutes(1));
    await insert.run(GUILD, 'e2', 'Later', inMinutes(600), 'scheduled', agoMinutes(1));
    await insert.run(GUILD, 'e3', 'Yesterday', agoMinutes(600), 'completed', agoMinutes(1));
    await insert.run(GUILD, 'e4', 'Called off', inMinutes(30), 'cancelled', agoMinutes(1));
    await insert.run(GUILD, 'e5', 'Too far out', inMinutes(200 * 24 * 60), 'scheduled', agoMinutes(1));

    const next = await db.prepare(`SELECT * FROM ${web}.next_event`).get();
    assert.equal(next?.name, 'Sunday Squad');

    const upcoming = await db.prepare(`SELECT * FROM ${web}.upcoming_events`).all();
    assert.deepEqual(
      upcoming.map((r) => r.event_id),
      ['e1', 'e2'],
    );
  });

  test('an event happening right now is still the next event', async () => {
    await db
      .prepare(
        `INSERT INTO scheduled_events (guild_id, event_id, name, starts_at, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(GUILD, 'e1', 'In progress', agoMinutes(10), 'active', agoMinutes(1));

    const next = await db.prepare(`SELECT * FROM ${web}.next_event`).get();
    assert.equal(next?.name, 'In progress');
  });

  // -------------------------------------------------------------------------
  // funnel
  // -------------------------------------------------------------------------

  test('funnel_daily aggregates by day and excludes bots', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', '2026-08-01T10:00:00.000Z', 0);
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '999', '2026-08-01T10:00:00.000Z', 1);

    const insert = db.prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    await insert.run('member_join', '111', GUILD, '2026-08-01T10:00:00.000Z', 'invite:aB3xY9', 'f1');
    await insert.run('member_join', '999', GUILD, '2026-08-01T11:00:00.000Z', 'invite:aB3xY9', 'f2');
    await insert.run('first_message', '111', GUILD, '2026-08-01T12:00:00.000Z', 'channel:1', 'f3');
    await insert.run('member_leave', '111', GUILD, '2026-08-02T10:00:00.000Z', 'unknown', 'f4');

    const rows = await db.prepare(`SELECT * FROM ${web}.funnel_daily ORDER BY day`).all();
    assert.deepEqual(
      rows.map((r) => r.day),
      ['2026-08-01', '2026-08-02'],
    );
    assert.equal(Number(rows[0].joins), 1, 'the bot join must not be counted');
    assert.equal(Number(rows[0].first_messages), 1);
    assert.equal(Number(rows[0].net_change), 1);
    assert.equal(Number(rows[1].net_change), -1);
  });

  test('funnel_by_source keeps unknown as itself', async () => {
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '111', '2026-08-01T10:00:00.000Z', 0);
    await db
      .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
      .run(GUILD, '222', '2026-08-01T10:00:00.000Z', 0);

    const insert = db.prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    await insert.run('member_join', '111', GUILD, '2026-08-01T10:00:00.000Z', 'invite:aB3xY9', 's1');
    await insert.run('member_join', '222', GUILD, '2026-08-01T11:00:00.000Z', 'unknown', 's2');

    const rows = await db.prepare(`SELECT * FROM ${web}.funnel_by_source ORDER BY source`).all();
    assert.deepEqual(
      rows.map((r) => r.source),
      ['invite:aB3xY9', 'unknown'],
    );
  });

  test('rank_counts keeps rank_order 1-5 on an empty database', async () => {
    // TOG-7762: the ladder is keyed by rank_key and sorted by rank_order, so
    // the website sorts by the number and never alphabetically. A drift that
    // renumbers or reorders the ladder must red here, not on a page.
    const rows = await db.prepare(`SELECT rank_key, rank_order FROM ${web}.rank_counts`).all();
    assert.deepEqual(
      rows.map((r) => [r.rank_key, r.rank_order]),
      [
        ['prospect', 1],
        ['member', 2],
        ['soldier', 3],
        ['veteran', 4],
        ['legend', 5],
      ],
    );
  });

  test('funnel_by_source preserves every documented source value verbatim', async () => {
    // TOG-7762: docs/EVENTS.md §source names invite:<code>, ambiguous:a+b,
    // vanity, unknown and web:one_click. The view passes source through
    // untouched - a label, a fold of unknown into a real code, or a dropped
    // value would silently rewrite the dashboard's rows.
    for (const id of ['111', '222', '333', '444', '555']) {
      await db
        .prepare(`INSERT INTO members (guild_id, member_id, joined_at, is_bot) VALUES (?, ?, ?, ?)`)
        .run(GUILD, id, '2026-08-01T10:00:00.000Z', 0);
    }

    const insert = db.prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, source, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    await insert.run('member_join', '111', GUILD, '2026-08-01T10:00:00.000Z', 'invite:aB3xY9', 'v1');
    await insert.run('member_join', '222', GUILD, '2026-08-01T11:00:00.000Z', 'ambiguous:aB3xY9+cD4eZ1', 'v2');
    await insert.run('member_join', '333', GUILD, '2026-08-01T12:00:00.000Z', 'vanity', 'v3');
    await insert.run('member_join', '444', GUILD, '2026-08-01T13:00:00.000Z', 'unknown', 'v4');
    await insert.run('member_join', '555', GUILD, '2026-08-01T14:00:00.000Z', 'web:one_click', 'v5');

    const rows = await db.prepare(`SELECT * FROM ${web}.funnel_by_source ORDER BY source`).all();
    assert.deepEqual(
      rows.map((r) => r.source),
      ['ambiguous:aB3xY9+cD4eZ1', 'invite:aB3xY9', 'unknown', 'vanity', 'web:one_click'],
    );
  });

  // -------------------------------------------------------------------------
  // The role. "and nothing else", attempted rather than asserted.
  // -------------------------------------------------------------------------

  describe('the website role', () => {
    // Named after the test schema so a parallel run cannot collide, and so a
    // leaked role from a crashed run is obviously test debris.
    const role = `${'two_web_ro_test'}_${Math.abs(hash(import.meta.filename))}`;
    const password = 'not-a-real-password-only-this-process-ever-sees-it';
    let admin: pg.Client;

    before(async () => {
      admin = new pg.Client({ connectionString: TEST_PG_URL });
      await admin.connect();
      await admin.query(`SET search_path TO ${t.schema}`);
    });

    after(async () => {
      try {
        await dropWebRole(admin, role, [web]);
      } finally {
        await admin.end();
      }
    });

    test('is granted the contract and nothing else', async (ctx) => {
      const can = await admin.query<{ ok: boolean }>(
        `SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      if (!can.rows[0]?.ok) {
        // Say so rather than pass quietly. A skipped permission check that
        // looks like a green tick is exactly the failure this repo keeps
        // finding.
        ctx.skip('test database user has neither CREATEROLE nor SUPERUSER');
        return;
      }

      await provisionWebRole(admin, {
        role,
        password,
        botSchema: t.schema!,
        webSchema: web,
      });

      const url = new URL(TEST_PG_URL);
      url.username = role;
      url.password = password;
      const asWeb = new pg.Client({ connectionString: url.toString() });
      await asWeb.connect();

      try {
        const who = await asWeb.query<{ u: string }>(`SELECT current_user AS u`);
        assert.equal(who.rows[0].u, role, 'verifying with the wrong role proves nothing');

        const results = await runWebRoleChecks(asWeb, {
          botSchema: t.schema!,
          webSchema: web,
        });
        const pending = results.find((r) => r.name === `cannot read ${t.schema}.capture_pending_joins`);
        assert.ok(pending, 'expected a named denial check for pending capture observations');
        assert.equal(pending.ok, true);
        const retained = results.find((r) => r.name === `cannot read ${t.schema}.capture_retained_growth`);
        assert.ok(retained, 'expected a named denial check for retained capture growth');
        assert.equal(retained.ok, true);
        const failures = results.filter((r) => !r.ok);
        assert.deepEqual(
          failures.map((f) => `${f.name}: ${f.detail}`),
          [],
        );
        const { passed } = summarise(results);
        assert.ok(passed >= WEB_CONTRACT_VIEWS.length, 'expected every view to be checked');
      } finally {
        await asWeb.end();
      }
    });

    test('the config-store write probe fails when the grant is actually there', async (ctx) => {
      // The mutation for the check above. Give the role a real INSERT on
      // guild_settings and leave `default_transaction_read_only` exactly as
      // provisioned - which is the state that matters, because it is what a
      // careless GRANT would produce in production.
      //
      // Before TOG-3100 the probe ran inside the read-only default and reported
      // "refused (25006)", so this grant would have been invisible: the website
      // role would have held INSERT on the table that decides how the bot
      // behaves at the next poll, and the check that exists to catch that would
      // have been green. A session GUC is not a privilege, and the probe now
      // clears it before measuring.
      const can = await admin.query<{ ok: boolean }>(
        `SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      if (!can.rows[0]?.ok) {
        ctx.skip('test database user has neither CREATEROLE nor SUPERUSER');
        return;
      }

      await provisionWebRole(admin, { role, password, botSchema: t.schema!, webSchema: web });
      // USAGE as well as INSERT. The tests run in a named schema that nobody has
      // USAGE on, so a table grant alone is refused before Postgres ever looks
      // at it - and a mutation that the schema boundary swallows would prove
      // nothing about the table probe. Production's bot schema is `public`,
      // where USAGE is already granted, so this is the faithful mirror.
      await admin.query(`GRANT USAGE ON SCHEMA ${t.schema} TO ${role}`);
      await admin.query(`GRANT INSERT ON ${t.schema}.guild_settings TO ${role}`);

      const url = new URL(TEST_PG_URL);
      url.username = role;
      url.password = password;
      const asWeb = new pg.Client({ connectionString: url.toString() });
      await asWeb.connect();

      try {
        const ro = await asWeb.query<{ s: string }>(
          `SELECT current_setting('default_transaction_read_only') AS s`,
        );
        assert.equal(ro.rows[0].s, 'on', 'the mutation must not also remove the read-only default');

        const results = await runWebRoleChecks(asWeb, { botSchema: t.schema!, webSchema: web });
        const store = results.find((r) => r.name === 'cannot write the config store');
        assert.ok(store, 'the config-store probe must still be in the list');
        assert.equal(store.ok, false, 'a real INSERT grant must fail the probe');
        assert.match(store.detail, /SUCCEEDED once the read-only default was cleared/);
      } finally {
        await asWeb.end();
        await admin.query(`REVOKE INSERT ON ${t.schema}.guild_settings FROM ${role}`);
        await admin.query(`REVOKE USAGE ON SCHEMA ${t.schema} FROM ${role}`);
      }
    });
  });
});

/** Small stable hash, so the role name is the same across a rerun. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
