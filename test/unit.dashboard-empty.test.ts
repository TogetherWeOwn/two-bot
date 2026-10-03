/**
 * Dashboard empty-state and new-guild exploratory ([TOG-7200](/TOG/issues/TOG-7200)).
 *
 * `buildDashboard` + `renderHtml` on a fresh/empty database must not crash, must
 * render honest zeros (never NaN/undefined/Infinity), and must tell the reader
 * what to run next instead of reading as "a dead server".
 *
 * Runs without Postgres or a token: an in-memory `Db` stub returns empty tables,
 * deliberately - not Postgres - so the empty path is checked on every run,
 * including environments without a database. The populated arithmetic lives in
 * test/unit.dashboard.test.ts; what fails here is a crash, a leaked
 * NaN/undefined, or a missing guidance banner on the empty path.
 *
 * Two cases:
 *   1. truly empty: no members, no events, no snapshot - `memberCountSource`
 *      is 'none' and the "Fresh database" banner shows.
 *   2. new guild: members on file, no events yet (bot just deployed) - the
 *      live funnel wins, still no crash and still no NaN.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../src/analytics/dashboard.ts';
import { renderHtml } from '../src/analytics/render.ts';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';

const NOW = new Date('2026-03-02T12:00:00.000Z'); // a Monday

interface EmptySeed {
  members?: Array<Record<string, unknown>>;
}

/** In-memory stand-in for the dashboard's read queries. Empty unless seeded. */
function fakeDb(seed: EmptySeed = {}): Db {
  const members = seed.members ?? [];
  const statement = (sql: string): Statement => ({
    async get<T>(..._params: unknown[]): Promise<T | undefined> {
      return undefined;
    },
    async all<T>(..._params: unknown[]): Promise<T[]> {
      if (sql.includes('FROM members')) return members.map((r) => ({ ...r })) as T[];
      return [] as T[];
    },
    async run(): Promise<RunResult> {
      throw new Error('fakeDb: the dashboard never writes');
    },
  });
  const db: Db = {
    prepare: (sql: string) => statement(sql),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return db;
}

/** No NaN, undefined, or Infinity anywhere in the rendered page. */
function assertNoLeaks(html: string): void {
  assert.doesNotMatch(html, /NaN/, 'empty page must never print NaN');
  assert.doesNotMatch(html, /undefined/, 'empty page must never print undefined');
  assert.doesNotMatch(html, /Infinity/, 'empty page must never print Infinity');
}

/** Self-contained: no external requests, same rule as the populated path. */
function assertSelfContained(html: string): void {
  assert.equal(/<(script|link|img|iframe)\b/i.test(html), false);
  assert.equal(/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), false);
}

describe('dashboard empty-state (fresh database)', () => {
  test('empty tables build honest zeros, not nulls dressed as numbers', async () => {
    const d = await buildDashboard(fakeDb(), { now: NOW, weeks: 4, anomalies: [] });
    assert.equal(d.memberCountSource, 'none');
    assert.equal(d.memberCountAsOf, null);
    assert.equal(d.guildId, null);
    assert.deepEqual(d.thisWeek, { start: '2026-03-02', joins: 0, leaves: 0, net: 0 });
    assert.deepEqual(d.lastWeek, { start: '2026-02-23', joins: 0, leaves: 0, net: 0 });
    assert.equal(d.active7d, 0);
    assert.equal(d.active30d, 0);
    assert.equal(d.humansInServer, 0);
    assert.equal(d.realHumans, 0);
    assert.equal(d.joinedNeverSpoke, 0);
    assert.equal(d.avgVoiceSessionSeconds, null);
    assert.equal(d.measuredVoiceSessions, 0);
    assert.equal(d.excludedUnknownStarts, 0);
    assert.equal(d.retentionOverall.d1, null);
    assert.equal(d.retentionOverall.d7, null);
    assert.equal(d.retentionOverall.d30, null);
    assert.equal(d.gateOverall, null);
    assert.deepEqual(d.sourcesAllTime, []);
    assert.deepEqual(d.channels, []);
    for (const w of d.weeks) {
      assert.equal(w.joins, 0);
      assert.equal(w.leaves, 0);
      assert.equal(w.net, 0);
      assert.equal(w.setAside, 0);
    }
    for (const c of d.cohorts) {
      assert.equal(c.size, 0);
      assert.equal(c.d1, null);
      assert.equal(c.d7, null);
      assert.equal(c.d30, null);
      assert.equal(c.gate, null);
    }
  });

  test('empty page renders the fresh banner and next steps, never bare zeros', async () => {
    const d = await buildDashboard(fakeDb(), { now: NOW, weeks: 4, anomalies: [] });
    const html = renderHtml(d);
    assert.ok(html.startsWith('<!doctype html>'));
    assertNoLeaks(html);
    assertSelfContained(html);
    // Empty sections describe missing records, not a dead server.
    assert.ok(html.includes('No joins recorded this week. Last week: 0'));
    assert.ok(html.includes('No joins on record'), 'sources section names the empty log');
    assert.ok(html.includes('No cohort'), 'cohort table says nobody joined');
    assert.ok(html.includes('not measured'), 'gate tile says unmeasured, never 0%');
    assert.ok(html.includes('No channel activity'), 'channel section names its empty state');
    assert.ok(html.includes('audit:collect'), 'the channel section names its next command');
    assert.ok(
      d.caveats.some((c) => c.includes('No join has a known invite source yet')),
      'the invite caveat fires on empty',
    );
  });

  test('empty-state copy explains missing data and names each next command', async () => {
    const d = await buildDashboard(fakeDb(), { now: NOW, weeks: 4, anomalies: [] });
    const html = renderHtml(d);
    const notice = html.match(/<div class="notice" role="status">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(notice, 'the empty page has an accessible guidance banner');
    const compactMarkup = (markup: string) => markup.replace(/\s+/g, ' ').trim();
    assert.equal(
      compactMarkup(notice),
      '<strong>Fresh database — no community data recorded yet.</strong> ' +
        'Zeros mean no activity has been recorded; dashes mean a metric is not available yet. ' +
        'They do not mean the server is empty. Keep the bot running to collect activity, ' +
        'or run <code>npm run backfill</code> to import member history. Run ' +
        '<code>npm run audit:collect</code> for a channel snapshot, then ' +
        '<code>npm run dashboard</code> to refresh this page.',
    );
    assert.deepEqual(
      [...html.matchAll(/<p class="empty" role="status">([\s\S]*?)<\/p>/g)].map((m) => compactMarkup(m[1])),
      [
        'No joins on record yet. Keep the bot running to record new joins, or run ' +
          '<code>npm run backfill</code> to import join history. Then run <code>npm run dashboard</code> to refresh this section.',
        'No cohorts to show — no member joins are recorded for this 4-week window.',
        'No channel activity data yet. Run <code>npm run audit:collect</code> to collect a server snapshot, ' +
          'then <code>npm run dashboard</code> to refresh this section.',
      ],
    );
    assert.ok(html.includes('not measured yet — check the rules gate with npm run backfill'));
    assert.doesNotMatch(html, /Run the bot once|Every section below reads zero|nobody joined/);
  });

  test('snapshot census does not show the fresh-database banner', async () => {
    const d = await buildDashboard(fakeDb(), {
      now: NOW,
      weeks: 4,
      anomalies: [],
      channelSnapshot: {
        collected_at: NOW.toISOString(),
        channels: [],
        members: { human_members: 5, stuck_at_rules_screening: 1 },
      },
    });
    assert.equal(d.memberCountSource, 'snapshot');
    assert.equal(d.realHumans, 4);
    const html = renderHtml(d);
    assert.ok(!html.includes('Fresh database'));
    assert.ok(html.includes('snapshot 2026-03-02, not live'));
    assertNoLeaks(html);
  });

  test('new guild: members on file but no events yet still renders clean', async () => {
    const d = await buildDashboard(
      fakeDb({
        members: [
          {
            member_id: 'new1',
            joined_at: '2026-03-01T10:00:00.000Z',
            join_source: null,
            gate_cleared_at: null,
            first_message_at: null,
            first_voice_at: null,
            last_active_at: null,
            left_at: null,
          },
        ],
      }),
      { now: NOW, weeks: 4, anomalies: [] },
    );
    assert.equal(d.memberCountSource, 'funnel', 'one live row beats no snapshot');
    assert.equal(d.humansInServer, 1);
    assert.equal(d.realHumans, 1);
    assert.equal(d.joinedNeverSpoke, 1);
    const html = renderHtml(d);
    assert.ok(!html.includes('Fresh database'), 'a live row never shows the fresh-database banner');
    assertNoLeaks(html);
    assertSelfContained(html);
  });
});
