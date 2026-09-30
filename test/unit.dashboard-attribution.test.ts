import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, countBySource, labelSource } from '../src/analytics/dashboard.ts';
import type { Db } from '../src/store/driver.ts';

const NOW = new Date('2026-03-02T12:00:00.000Z');
// Joins land strictly inside the current window: dashboard windows are
// [weekStart, generatedAt), so a join stamped exactly at `now` reads as the future.
const AT = new Date(NOW.getTime() - 1).toISOString();
const SOURCES = [
  { source: 'ambiguous', label: 'Ambiguous invite', unattributed: true },
  { source: 'ambiguous:a+b', label: 'Ambiguous invite', unattributed: true },
  { source: 'invite:a', label: 'Invite a', unattributed: false },
  { source: 'vanity', label: 'Vanity URL', unattributed: false },
];

for (const { source, label, unattributed } of SOURCES) {
  test(`dashboard source classification: ${source}`, () => {
    assert.deepEqual(labelSource(source), { label, unattributed });
    assert.deepEqual(countBySource([source, source]), [
      { source, label, unattributed, joins: 2 },
    ]);
  });
}

/** Only dashboard read queries; no database, migrations, tokens or network. */
function fakeDb(sources: string[]): Db {
  const members = sources.map((source, i) => ({
    member_id: String(i),
    joined_at: AT,
    join_source: source,
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: null,
    last_active_at: null,
    left_at: null,
  }));
  const joins = members.map((m) => ({
    member_id: m.member_id,
    occurred_at: m.joined_at,
    source: m.join_source,
  }));
  const db: Db = {
    prepare: (sql) => ({
      async all<T>(): Promise<T[]> {
        if (sql.includes('FROM members')) return members as T[];
        if (sql.includes("event_type = 'member_join'")) return joins as T[];
        return [];
      },
      async get<T>(): Promise<T | undefined> { return undefined; },
      async run() { throw new Error('dashboard must not write'); },
    }),
    async exec() { throw new Error('dashboard must not write'); },
    async transaction() { throw new Error('dashboard must not write'); },
    async close() {},
  };
  return db;
}

for (const sources of [
  ['ambiguous', 'ambiguous:a+b', 'ambiguous:a+b'],
  ['ambiguous', 'unknown', 'backfill:log:member-join'],
]) {
  test(`unattributed dashboard joins remain counted: ${sources.join(', ')}`, async () => {
    const d = await buildDashboard(fakeDb(sources), { now: NOW, weeks: 2, anomalies: [] });
    assert.equal(d.thisWeek.joins, sources.length);
    assert.equal(d.thisWeek.net, sources.length);
    assert.equal(d.realHumans, sources.length);
    assert.equal(d.sourcesAllTime.reduce((n, row) => n + row.joins, 0), sources.length);
    assert.deepEqual(d.weeks.at(-1)!.bySource, d.sourcesAllTime);
    assert.ok(d.sourcesAllTime.every((row) => row.unattributed));
    assert.ok(d.caveats.some((c) => c.includes('No join has a known invite source yet')));
    assert.ok(d.caveats.some((c) => c.includes('ambiguous')));
    assert.ok(d.caveats.every((c) => !c.includes('Every join on record was imported')));
    for (const row of JSON.parse(JSON.stringify(d)).sourcesAllTime) {
      assert.deepEqual(Object.keys(row).sort(), ['joins', 'label', 'source', 'unattributed']);
    }
    const ambiguous = d.sourcesAllTime.find((row) => row.label === 'Ambiguous invite')!;
    assert.equal(ambiguous.joins, sources.filter((s) => s.startsWith('ambiguous')).length);
    assert.equal(ambiguous.source, [...new Set(sources.filter((s) => s.startsWith('ambiguous')))].sort().join(', '));
  });
}

for (const source of ['invite:a', 'vanity']) {
  test(`known ${source} suppresses the no-known-source caveat`, async () => {
    const d = await buildDashboard(fakeDb(['ambiguous:a+b', source]), {
      now: NOW, weeks: 2, anomalies: [],
    });
    assert.equal(d.thisWeek.joins, 2);
    assert.equal(d.sourcesAllTime.filter((row) => !row.unattributed).length, 1);
    assert.ok(d.caveats.every((c) => !c.includes('No join has a known invite source yet')));
  });
}
