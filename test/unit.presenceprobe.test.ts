/**
 * The internal presence instrument (TOG-469).
 *
 * Two halves, and the FIRST one is the point of the issue:
 *
 *  1. Containment. `presence_probe` is never rendered, never published, never
 *     in `web_v1`, and the bot never asks for a presence intent. These are
 *     asserted against the actual files, so the way this instrument fails -
 *     someone quietly wiring it to a page because the number was sitting there
 *     - is a red build rather than a discovery on the live site.
 *  2. That the thing collects and reads back correctly, including the trigger
 *     that would reopen TOG-75 option A.
 *
 * Runs on SQLite with no services, which is deliberate: migration 0004 is
 * written in portable SQL specifically so these tests apply THE SHIPPING FILE
 * rather than a hand-copied schema. A containment guarantee that only runs
 * when someone remembers to start a Postgres is not a guarantee.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../src/store/db.ts';
import { INTENTS, intents } from '../src/discord/client.ts';
import { WEB_CONTRACT_VIEWS } from '../src/store/webContract.ts';
import {
  runProbeCycle,
  recordReading,
  readSeries,
  lastBotFloorAt,
  fetchPresenceCount,
  countBotFloor,
  PRESENCE_PROBE_INTERVAL_MS,
} from '../src/jobs/presenceProbe.ts';
import { stubRest } from './helpers/stubRest.ts';
import {
  evaluateTrigger,
  dailyPeaks,
  latestBotFloor,
  REOPEN_PEAK_THRESHOLD,
  REOPEN_REQUIRED_DAYS,
  REOPEN_WINDOW_DAYS,
  type PresenceReading,
} from '../src/analytics/presence.ts';
import { renderPresenceReport } from '../src/analytics/presenceReport.ts';

const ROOT = join(import.meta.dirname, '..');
const MIGRATION = join(ROOT, 'migrations', '0004_presence_probe.sql');
const GUILD = '326474832151838730';

/** Read every file under a directory, recursively, as [relativePath, text]. */
function readTree(dir: string, exts: string[]): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(full);
        continue;
      }
      if (!exts.some((e) => entry.endsWith(e))) continue;
      out.push([full.slice(ROOT.length + 1), readFileSync(full, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Containment. The reason this issue exists.
// ---------------------------------------------------------------------------

describe('presence probe containment', () => {
  test('no gateway presence intent is requested', () => {
    // The literal check first: whatever discord.js calls the bit, the source
    // of client.ts must not name it. This catches an import that a numeric
    // comparison would sail past.
    const src = readFileSync(join(ROOT, 'src', 'discord', 'client.ts'), 'utf8');
    assert.ok(
      !/GuildPresences|GatewayIntentBits\.GuildPresences/.test(src),
      'src/discord/client.ts names a presence intent - TOG-469 explicitly forbids this. ' +
        'If this instrument seems to need it, the issue has been misread.',
    );

    // And the value check: ticket transcripts require MessageContent, while
    // automod must not add a duplicate intent or introduce GuildPresences.
    assert.equal(intents(false).length, 6, 'the default intent list changed - see client.ts');
    assert.equal(intents(true).length, 6, 'automod must reuse the existing MessageContent intent');
    assert.equal(INTENTS.length, 6, 'the intent list changed - see client.ts intent rationale');
  });

  test('the table is not readable through the web_v1 contract', () => {
    // The website's whole surface is sql/web_v1.sql. If the table is not named
    // there, no view can select from it.
    for (const [path, text] of readTree(join(ROOT, 'sql'), ['.sql'])) {
      assert.ok(
        !text.includes('presence_probe'),
        `${path} mentions presence_probe. Nothing in sql/ may read this table - ` +
          `it is the instrument TOG-469 requires never reach a page.`,
      );
    }

    // Belt and braces: the contract's view list is what the grant script grants
    // and the verify script proves. A new view here would need a new entry, so
    // pinning the list makes "I added a small view" impossible to do quietly.
    assert.deepEqual([...WEB_CONTRACT_VIEWS], [
      'contract_meta',
      'live_counts',
      'rank_counts',
      'members',
      'member_milestones',
      'upcoming_events',
      'next_event',
      'funnel_daily',
      'funnel_by_source',
    ]);
  });

  test('only the collector, the reader and the migration know the table exists', () => {
    // Every other reference is a rendering path waiting to happen. Keeping the
    // blast radius to three files is what makes the rule above enforceable.
    const allowed = new Set([
      join('migrations', '0004_presence_probe.sql'),
      join('src', 'jobs', 'presenceProbe.ts'),
      join('scripts', 'presence-trend.ts'),
      join('test', 'unit.presenceprobe.test.ts'),
      join('test', 'helpers', 'testDb.ts'),
      // The role verifier names every bot-owned table so a specific denial is
      // proven in addition to the relation census. It has no rendering path.
      join('src', 'store', 'webRoleCheck.ts'),
    ]);
    // The BARE identifier only. `\b` on both sides deliberately does not match
    // `presence_probe_enabled` (a log event name) or `0004_presence_probe.sql`
    // (a path) - both are fine to mention anywhere, and a check that flagged
    // them would get relaxed by the first person it annoyed. What must stay
    // rare is the token as a table name, which is the only form that can read
    // rows out.
    const asTableName = /\bpresence_probe\b/;
    const offenders: string[] = [];
    for (const dir of ['src', 'scripts', 'test', 'migrations', 'sql']) {
      for (const [path, text] of readTree(join(ROOT, dir), ['.ts', '.sql'])) {
        if (allowed.has(path)) continue;
        if (asTableName.test(text)) offenders.push(path);
      }
    }
    assert.deepEqual(offenders, [], `unexpected references to presence_probe: ${offenders}`);
  });

  test('the stored row has no per-member column and no derived human estimate', async () => {
    const db = await openDb(':memory:');
    try {
      await db.exec(readFileSync(MIGRATION, 'utf8'));
      const cols = (
        await db.prepare(`SELECT name FROM pragma_table_info('presence_probe')`).all<{
          name: string;
        }>()
      ).map((r) => r.name);

      // Exactly these four. A member id would break the aggregate-only promise
      // that makes this acceptable at all; a `human_estimate` column would be a
      // stored guess that someone eventually publishes. See migration 0004.
      assert.deepEqual(cols.sort(), [
        'approximate_presence_count',
        'bot_floor',
        'guild_id',
        'observed_at',
      ]);
    } finally {
      await db.close();
    }
  });

  test('the cadence is hourly, not the 60s counter job', () => {
    // docs/WEBSITE_CONTRACT.md §5 - the 60s refresh feeds a page and this must
    // never share it.
    assert.equal(PRESENCE_PROBE_INTERVAL_MS, 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 2. Collection.
// ---------------------------------------------------------------------------

describe('presence probe collection', () => {
  let db: Db;

  before(async () => {
    db = await openDb(':memory:');
    await db.exec(readFileSync(MIGRATION, 'utf8'));
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('DELETE FROM presence_probe');
  });

  test('the presence read asks for counts and takes no intent', async () => {
    const { rest, paths } = stubRest(() => ({
      approximate_presence_count: 41,
      approximate_member_count: 107,
    }));
    const n = await fetchPresenceCount(rest, GUILD);
    assert.equal(n, 41);
    // `with_counts=true` is the entire mechanism: it is what makes this an
    // aggregate on a REST response instead of a per-member gateway stream.
    assert.deepEqual(paths, [`/guilds/${GUILD}?with_counts=true`]);
  });

  test('a guild response without the field is null, never zero', async () => {
    const { rest } = stubRest(() => ({ approximate_member_count: 107 }));
    assert.equal(await fetchPresenceCount(rest, GUILD), null);
  });

  test('the bot floor is a count and carries no member ids', async () => {
    const members = [
      { user: { id: '1', bot: true } },
      { user: { id: '2', bot: true } },
      { user: { id: '3' } },
      { user: { id: '4', bot: false } },
    ];
    const { rest } = stubRest((p) => (p.startsWith(`/guilds/${GUILD}/members`) ? members : []));
    const floor = await countBotFloor(rest, GUILD);

    assert.equal(floor, 2);
    // The value handed back is a number. Not a list we might later log, not an
    // object with ids hanging off it. This is the aggregate-only promise, held
    // at the one place member data enters the process.
    assert.equal(typeof floor, 'number');
    assert.ok(!JSON.stringify(floor).includes('1'), 'no member id may survive the count');
  });

  test('a failed presence read writes nothing at all', async () => {
    const { rest } = stubRest(() => undefined); // 404 everywhere
    const res = await runProbeCycle({ db, rest, guildId: GUILD, now: () => '2026-08-25T10:00:00.000Z' });

    assert.equal(res.recorded, false);
    assert.deepEqual(await readSeries(db, GUILD), []);
    // A gap must stay a gap. If a failed read wrote a row, a dead collector
    // would be indistinguishable from a quiet night - which is the exact thing
    // this instrument measures.
  });

  test('the bot floor is scanned once, then left null until it ages out', async () => {
    const members = Array.from({ length: 107 }, (_, i) => ({
      user: { id: String(i), bot: i < 23 },
    }));
    let memberCalls = 0;
    const { rest } = stubRest((p) => {
      if (p.startsWith(`/guilds/${GUILD}/members`)) {
        memberCalls++;
        return members;
      }
      return { approximate_presence_count: 27 };
    });

    const cycle = (iso: string) =>
      runProbeCycle({ db, rest, guildId: GUILD, now: () => iso, botFloorMaxAgeMs: 86_400_000 });

    const first = await cycle('2026-08-25T10:00:00.000Z');
    assert.equal(first.botFloor, 23, 'the floor from IDENTIFIERS.md, re-derived live');
    assert.equal(memberCalls, 1);

    // An hour later: presence again, but no second member listing.
    const second = await cycle('2026-08-25T11:00:00.000Z');
    assert.equal(second.botFloor, null);
    assert.equal(memberCalls, 1, 'the roster does not move hourly; do not page it hourly');

    // A day later it has aged out.
    const third = await cycle('2026-08-26T11:00:00.000Z');
    assert.equal(third.botFloor, 23);
    assert.equal(memberCalls, 2);

    const series = await readSeries(db, GUILD);
    assert.equal(series.length, 3);
    assert.deepEqual(series.map((r) => r.presence), [27, 27, 27]);
    assert.deepEqual(series.map((r) => r.botFloor), [23, null, 23]);
    // A reader wanting "the floor" takes the newest one it actually saw.
    assert.equal(latestBotFloor(series), 23);
    assert.equal(await lastBotFloorAt(db, GUILD), '2026-08-26T11:00:00.000Z');
  });

  test('a failed member listing still keeps the presence reading', async () => {
    const { rest } = stubRest((p) =>
      p.startsWith(`/guilds/${GUILD}/members`) ? undefined : { approximate_presence_count: 30 },
    );
    const res = await runProbeCycle({ db, rest, guildId: GUILD, now: () => '2026-08-25T10:00:00.000Z' });

    assert.equal(res.recorded, true);
    assert.equal(res.presence, 30);
    assert.equal(res.botFloor, null);
    assert.equal((await readSeries(db, GUILD)).length, 1);
  });

  test('the count constraint rejects a negative reading', async () => {
    await assert.rejects(
      recordReading(db, GUILD, {
        observedAt: '2026-08-25T10:00:00.000Z',
        presence: -1,
        botFloor: null,
      }),
    );
  });

  test('a replayed cycle at the same instant does not double-count', async () => {
    const r: PresenceReading = {
      observedAt: '2026-08-25T10:00:00.000Z',
      presence: 27,
      botFloor: 23,
    };
    await recordReading(db, GUILD, r);
    await recordReading(db, GUILD, r);
    assert.equal((await readSeries(db, GUILD)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. The trigger. TOG-469's numbers, decided once, in code.
// ---------------------------------------------------------------------------

/** `n` readings a day for `days` days ending at 2026-08-25, peaking at peaks[i]. */
function series(peaks: number[], opts: { floor?: number | null } = {}): PresenceReading[] {
  const end = Date.parse('2026-08-25T12:00:00.000Z');
  const out: PresenceReading[] = [];
  peaks.forEach((peak, i) => {
    const dayStart = end - (peaks.length - 1 - i) * 86_400_000;
    // A low reading and the day's peak, so dailyPeaks has something to pick from.
    out.push({
      observedAt: new Date(dayStart - 6 * 3_600_000).toISOString(),
      presence: Math.max(0, peak - 12),
      // `?? 23` would swallow an explicit null, which is the case one test needs.
      botFloor: i === 0 ? (opts.floor === undefined ? 23 : opts.floor) : null,
    });
    out.push({ observedAt: new Date(dayStart).toISOString(), presence: peak, botFloor: null });
  });
  return out;
}

const NOW = '2026-08-25T23:00:00.000Z';

describe('presence trigger', () => {
  test('the constants are TOG-469s, not something drifted', () => {
    assert.equal(REOPEN_PEAK_THRESHOLD, 45);
    assert.equal(REOPEN_WINDOW_DAYS, 14);
    assert.equal(REOPEN_REQUIRED_DAYS, 3);
  });

  test('a thin series declines to answer rather than saying no', () => {
    const v = evaluateTrigger(series([20, 22, 19]), { now: NOW });
    assert.equal(v.status, 'insufficient_data');
    assert.equal(v.daysObserved, 3);
    // This matters: "we looked and it is small" and "we have barely looked"
    // are different sentences, and only the first one may keep C standing.
  });

  test('the numbers we actually have keep option C closed', () => {
    // 27 against a 23 bot floor was the single observation the TOG-75 decision
    // rested on. Ten days of it is that decision, now on a series.
    const v = evaluateTrigger(series([27, 26, 29, 25, 24, 28, 27, 30, 26, 27]), { now: NOW });
    assert.equal(v.status, 'closed');
    assert.equal(v.qualifyingDays, 0);
    assert.equal(v.peak, 30);
    assert.equal(v.botFloor, 23);
    assert.match(v.reason, /option C stands/);
  });

  test('one busy night is not "sustains"', () => {
    const v = evaluateTrigger(series([27, 26, 61, 25, 24, 28, 27, 30, 26, 27]), { now: NOW });
    assert.equal(v.status, 'closed');
    assert.equal(v.qualifyingDays, 1);
    assert.equal(v.peak, 61);
    // A LAN party is not a community that got bigger. This is precisely the
    // one-reading failure the instrument exists to prevent, so a spike must not
    // be able to reopen the question either.
  });

  test('two qualifying days is still short of the rule', () => {
    const v = evaluateTrigger(series([27, 46, 29, 25, 48, 28, 27, 30, 26, 27]), { now: NOW });
    assert.equal(v.qualifyingDays, 2);
    assert.equal(v.status, 'closed');
  });

  test('three qualifying days with no live site is armed, not fired', () => {
    const v = evaluateTrigger(series([27, 46, 29, 25, 48, 28, 47, 30, 26, 27]), { now: NOW });
    assert.equal(v.qualifyingDays, 3);
    assert.equal(v.status, 'armed');
    assert.equal(v.webV1Live, false);
    assert.match(v.reason, /web_v1 to be live/);
    // Both halves or nothing. A number alone must never reopen A.
  });

  test('both halves hold and it fires, pointing at the controls already written', () => {
    const v = evaluateTrigger(series([27, 46, 29, 25, 48, 28, 47, 30, 26, 27]), {
      now: NOW,
      webV1Live: true,
    });
    assert.equal(v.status, 'fires');
    assert.match(v.reason, /controls 1-5/);
    assert.match(v.reason, /do not re-derive/);
  });

  test('qualifying days outside the window do not count', () => {
    // Three big days three weeks ago, quiet since. The window is trailing.
    const old = series([50, 51, 52, 20, 20, 20, 20, 20, 20, 20]).map((r) => ({
      ...r,
      observedAt: new Date(Date.parse(r.observedAt) - 20 * 86_400_000).toISOString(),
    }));
    const recent = series([20, 21, 19, 22, 20, 21, 20, 19, 22, 20]);
    const v = evaluateTrigger([...old, ...recent], { now: NOW });
    assert.equal(v.status, 'closed');
    assert.equal(v.qualifyingDays, 0);
    assert.ok(v.peak !== null && v.peak < 45);
  });

  test('daily peak, not daily mean', () => {
    const days = dailyPeaks([
      { observedAt: '2026-08-25T02:00:00.000Z', presence: 4, botFloor: null },
      { observedAt: '2026-08-25T20:00:00.000Z', presence: 46, botFloor: null },
    ]);
    assert.equal(days.length, 1);
    assert.equal(days[0].peak, 46);
    assert.equal(days[0].low, 4);
    assert.equal(days[0].qualifies, true);
    // A mean of 25 would hide the only number the decision cares about.
  });
});

// ---------------------------------------------------------------------------
// 4. The report a human reads.
// ---------------------------------------------------------------------------

describe('presence report', () => {
  test('it says what it is, every time it is printed', () => {
    const readings = series([27, 26, 29, 25, 24, 28, 27, 30, 26, 27]);
    const verdict = evaluateTrigger(readings, { now: NOW });
    const text = renderPresenceReport(readings, { guildId: GUILD, verdict });

    assert.match(text, /INTERNAL ONLY, never published/);
    assert.match(text, /trigger *CLOSED/);
    assert.match(text, /bot floor *23/);
    // The one derived number, and its caveat, always travel together.
    assert.match(text, /humans \(rough\)/);
    assert.match(text, /Never publish this number/);
  });

  test('with no floor observed there is no human estimate at all', () => {
    const readings = series([27, 26, 29, 25, 24, 28, 27, 30, 26, 27], { floor: null });
    const verdict = evaluateTrigger(readings, { now: NOW });
    const text = renderPresenceReport(readings, { guildId: GUILD, verdict });

    assert.match(text, /bot floor *never observed/);
    assert.ok(!text.includes('humans (rough)'), 'no floor means no subtraction, not a guess');
  });

  test('an empty series explains itself instead of printing a blank table', () => {
    const verdict = evaluateTrigger([], { now: NOW });
    const text = renderPresenceReport([], { guildId: GUILD, verdict });
    assert.match(text, /No readings yet/);
    assert.match(text, /presence_probe_enabled/);
  });
});
