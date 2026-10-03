import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildDashboard, recentWeeks, type MemberRow } from '../src/analytics/dashboard.ts';
import type { Db, Statement } from '../src/store/driver.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const JOINS = [
  { member_id: 'previous-a', occurred_at: '2026-09-21T00:00:00.000Z', source: 'invite:a' },
  { member_id: 'previous-b', occurred_at: '2026-09-27T23:59:59.999Z', source: 'invite:b' },
  { member_id: 'current', occurred_at: '2026-09-28T00:00:00.000Z', source: 'invite:a' },
];
const MEMBERS: MemberRow[] = JOINS.map((e) => ({
  member_id: e.member_id,
  joined_at: e.occurred_at,
  join_source: e.source,
  gate_cleared_at: null,
  first_message_at: null,
  first_voice_at: null,
  last_active_at: null,
  left_at: null,
}));
const LEAVES = [
  { occurred_at: '2026-09-27T12:00:00.000Z' },
  { occurred_at: '2026-09-29T12:00:00.000Z' },
];

/** Fixed read-only rows: no database connection or live service is used. */
function fakeDb(empty = false): Db {
  const statement = (sql: string): Statement => ({
    async all<T>(): Promise<T[]> {
      if (empty) return [];
      if (sql.includes('FROM members')) return MEMBERS as T[];
      if (sql.includes("event_type = 'member_join'")) return JOINS as T[];
      if (sql.includes("event_type = 'member_leave'")) return LEAVES as T[];
      return [];
    },
    async get<T>(): Promise<T | undefined> { return undefined; },
    async run() { throw new Error('dashboard must not write'); },
  });
  const db: Db = {
    prepare: statement,
    exec: async () => { throw new Error('dashboard must not write'); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    close: async () => {},
  };
  return db;
}

test('one chart week preserves both headline weeks and keeps chart/cohort depth at one', async () => {
  const four = await buildDashboard(fakeDb(), { now: NOW, weeks: 4, anomalies: [] });
  const one = await buildDashboard(fakeDb(), { now: NOW, weeks: 1, anomalies: [] });
  assert.deepEqual(one.thisWeek, { start: '2026-09-28', joins: 1, leaves: 1, net: 0 });
  assert.deepEqual(one.lastWeek, { start: '2026-09-21', joins: 2, leaves: 1, net: 1 });
  assert.deepEqual(one.thisWeek, four.thisWeek);
  assert.deepEqual(one.lastWeek, four.lastWeek);
  assert.deepEqual(one.weeks, four.weeks.slice(-1));
  assert.deepEqual(one.cohorts, four.cohorts.slice(-1));
});

test('empty one-week history still labels last week with the previous Monday', async () => {
  const d = await buildDashboard(fakeDb(true), { now: NOW, weeks: 1, anomalies: [] });
  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 0, leaves: 0, net: 0 });
  assert.deepEqual(d.lastWeek, { start: '2026-09-21', joins: 0, leaves: 0, net: 0 });
  assert.equal(d.weeks.length, 1);
  assert.equal(d.cohorts.length, 1);
});

test('default and 26-week histories keep their depth and the same headline numbers', async () => {
  const defaults = await buildDashboard(fakeDb(), { now: NOW, anomalies: [] });
  const explicit = await buildDashboard(fakeDb(), { now: NOW, weeks: 12, anomalies: [] });
  const extended = await buildDashboard(fakeDb(), { now: NOW, weeks: 26, anomalies: [] });
  assert.deepEqual(defaults, explicit);
  assert.equal(defaults.weeks.length, 12);
  assert.equal(defaults.cohorts.length, 12);
  assert.equal(extended.weeks.length, 26);
  assert.equal(extended.cohorts.length, 26);
  assert.deepEqual(extended.weeks.slice(-12), defaults.weeks);
  assert.deepEqual(extended.cohorts.slice(-12), defaults.cohorts);
  assert.deepEqual(extended.thisWeek, defaults.thisWeek);
  assert.deepEqual(extended.lastWeek, defaults.lastWeek);
  assert.deepEqual(recentWeeks(NOW, 1), ['2026-09-28']);
});

for (const weeks of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
  test(`buildDashboard rejects ${weeks} before preparing a database query`, async () => {
    let prepares = 0;
    const db = fakeDb();
    db.prepare = () => {
      prepares++;
      throw new Error('unexpected database query');
    };
    await assert.rejects(buildDashboard(db, { now: NOW, weeks }), {
      name: 'RangeError', message: 'weeks must be a positive integer',
    });
    assert.equal(prepares, 0);
    assert.throws(() => recentWeeks(NOW, weeks), {
      name: 'RangeError', message: 'weeks must be a positive integer',
    });
  });
}

for (const args of [
  ['--weeks', '0'], ['--weeks', '-1'], ['--weeks', '1.5'],
  ['--weeks', 'NaN'], ['--weeks', 'Infinity'], ['--weeks', '-Infinity'],
  ['--weeks', 'invalid'], ['--weeks'], ['--weeks', '--json'],
]) {
  test(`dashboard CLI rejects ${args.join(' ')} before opening a database`, () => {
    // A non-URL is a sentinel, never a connection target. No inherited DB/token env.
    const result = spawnSync(process.execPath, ['scripts/dashboard.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, TWO_DATABASE_URL: 'not-a-database-url' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'dashboard: weeks must be a positive integer');
  });
}
