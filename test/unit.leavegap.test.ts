/**
 * Member_leave backfill gap analysis (TOG-8305).
 *
 * Read-only: classifyLeaveGaps() takes rows, fetchLeaveGapFeeds() takes a
 * narrow Db that the read test below fakes in-memory (the fake also proves
 * the sweep never writes). The CLI cases run the real `scripts/leave-gap.ts`
 * as a subprocess - a drift between the documented commands and what the
 * script accepts reds here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildSeedGapData,
  classifyLeaveGaps,
  fetchLeaveGapFeeds,
  formatLeaveGapReport,
  type GapJoin,
  type GapLeave,
  type RosterMember,
} from '../src/analytics/memberLeaveGap.ts';
import { ANOMALIES } from '../src/analytics/anomalies.ts';
import type { Db } from '../src/store/driver.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/leave-gap.ts', import.meta.url).pathname;

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TWO_DATABASE_URL;
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_BOT_TOKEN;
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const G = 'g1';
const join = (memberId: string | null, occurredAt: string, source = 'backfill:log:join-leave-log'): GapJoin => ({
  guildId: G,
  memberId,
  occurredAt,
  source,
});
const leave = (memberId: string | null, occurredAt: string): GapLeave => ({
  guildId: G,
  memberId,
  occurredAt,
});
const onRoster = (memberId: string | null): RosterMember => ({ guildId: G, memberId });

// --- the five shapes ---------------------------------------------------------

test('present members with no leave row are correct, not a gap', () => {
  const r = classifyLeaveGaps([join('m', '2025-06-01T10:00:00.000Z')], [], [onRoster('m')]);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.present, 1);
  assert.equal(r.resolved, 0);
});

test('departed members with a leave row are resolved, whatever else is missing', () => {
  const r = classifyLeaveGaps(
    [join('m', '2025-06-01T10:00:00.000Z')],
    [leave('m', '2025-06-10T10:00:00.000Z')],
    [],
  );
  assert.equal(r.gaps.length, 0);
  assert.equal(r.resolved, 1);
});

test('last join before the log floor reads as pre-coverage with an earliest-possible fill', () => {
  const r = classifyLeaveGaps(
    [join('m', '2023-01-15T10:00:00.000Z')],
    [],
    [],
    { logFloor: '2024-01-01T00:00:00.000Z' },
  );
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].kind, 'pre-coverage');
  assert.deepEqual(r.gaps[0].fills, [
    {
      occurredAt: '2023-01-15T10:00:00.000Z',
      bound: 'earliest-possible',
      note: 'leave predates scanned log history: the instant is unknowable',
    },
  ]);
});

test('last join inside history with no leave reads as log-miss, floor-unknown without a floor', () => {
  const withFloor = classifyLeaveGaps(
    [join('m', '2025-06-15T10:00:00.000Z')],
    [],
    [],
    { logFloor: '2024-01-01T00:00:00.000Z' },
  );
  assert.equal(withFloor.gaps[0].kind, 'log-miss');
  assert.match(withFloor.gaps[0].detail, /inside scanned history/);

  const noFloor = classifyLeaveGaps([join('m', '2025-06-15T10:00:00.000Z')], [], []);
  assert.equal(noFloor.gaps[0].kind, 'log-miss');
  assert.match(noFloor.gaps[0].detail, /log floor unknown/);
});

test('raid-window joins read as residue, never as organic churn', () => {
  const r = classifyLeaveGaps(
    [join('m', '2025-07-06T21:00:00.000Z')],
    [],
    [],
    { logFloor: '2024-01-01T00:00:00.000Z', anomalies: ANOMALIES },
  );
  assert.equal(r.gaps[0].kind, 'raid-residue');
  assert.match(r.gaps[0].detail, /not.*organic|never auto-fill|cleanup/i);
});

test('rejoins fill one leave per inter-join gap plus the final departure', () => {
  const r = classifyLeaveGaps(
    [join('m', '2024-05-01T10:00:00.000Z'), join('m', '2024-09-01T10:00:00.000Z')],
    [],
    [],
  );
  assert.equal(r.gaps[0].kind, 'rejoin-gap');
  assert.equal(r.gaps[0].joinsSeen, 2);
  assert.deepEqual(
    r.gaps[0].fills.map((f) => f.bound),
    ['earliest-possible', 'earliest-possible'],
  );
  // Each fill stamps the join it bounds: distinct instants, so the
  // occurred_at-keyed idempotency key keeps them as distinct rows.
  assert.deepEqual(
    r.gaps[0].fills.map((f) => f.occurredAt),
    ['2024-05-01T10:00:00.000Z', '2024-09-01T10:00:00.000Z'],
  );
  assert.match(r.gaps[0].fills[0].note, /necessarily before the rejoin/);
});

test('malformed timestamps and memberless rows are skipped, never paired somewhere', () => {
  const r = classifyLeaveGaps(
    [join(null, '2025-06-01T10:00:00.000Z'), join('m', 'garbage')],
    [leave(null, '2025-06-10T10:00:00.000Z')],
    [onRoster(null)],
  );
  assert.equal(r.skipped, 4);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.present, 0);
  assert.equal(r.resolved, 0);
});

// --- timestamp spellings must not change chronology ---------------------------

for (const { label, spellings, kind } of [
  {
    label: 'before coverage',
    spellings: ['2026-08-31T22:30:00.000Z', '2026-09-01T00:30:00+02:00', '2026-08-31T17:30:00-05:00'],
    kind: 'pre-coverage',
  },
  {
    label: 'at coverage start',
    spellings: ['2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00Z', '2026-08-31T19:00:00-05:00'],
    kind: 'log-miss',
  },
  {
    label: 'after coverage start',
    spellings: ['2026-09-01T00:30:00.000Z', '2026-09-01T02:30:00+02:00', '2026-08-31T19:30:00-05:00'],
    kind: 'log-miss',
  },
]) {
  test(`coverage classification uses instants for equivalent spellings ${label}`, () => {
    for (const logFloor of ['2026-09-01T00:00:00.000Z', '2026-09-01T02:00:00+02:00', '2026-08-31T19:00:00-05:00']) {
      for (const at of spellings) {
        const r = classifyLeaveGaps([join('m', at)], [], [], { logFloor });
        assert.equal(r.gaps[0].kind, kind, `${at} against ${logFloor}`);
        assert.equal(r.gaps[0].lastJoinAt, at);
        assert.equal(r.gaps[0].fills[0].occurredAt, at);
        assert.equal(r.gaps[0].fills[0].bound, 'earliest-possible');
      }
    }
  });
}

for (const { label, spellings, kind } of [
  {
    label: 'before raid start',
    spellings: ['2025-07-05T23:59:59.999Z', '2025-07-06T01:59:59.999+02:00'],
    kind: 'log-miss',
  },
  {
    label: 'at inclusive raid start',
    spellings: ['2025-07-06T00:00:00.000Z', '2025-07-05T19:00:00-05:00'],
    kind: 'raid-residue',
  },
  {
    label: 'inside raid',
    spellings: ['2025-07-06T23:30:00.000Z', '2025-07-07T01:30:00+02:00'],
    kind: 'raid-residue',
  },
  {
    label: 'at exclusive raid end',
    spellings: ['2025-07-07T00:00:00.000Z', '2025-07-06T19:00:00-05:00'],
    kind: 'log-miss',
  },
]) {
  test(`raid classification uses instants for equivalent spellings ${label}`, () => {
    for (const at of spellings) {
      const r = classifyLeaveGaps([join('m', at)], [], [], { anomalies: ANOMALIES });
      assert.equal(r.gaps[0].kind, kind, at);
    }
  });
}

test('offset joins with reversed string order yield chronological bounded fills and lastJoinAt', () => {
  const variants = [
    ['2026-08-31T22:30:00.000Z', '2026-08-31T23:00:00.000Z'],
    ['2026-09-01T00:30:00+02:00', '2026-08-31T18:00:00-05:00'],
  ];
  assert.ok(variants[1][0] > variants[1][1], 'offset spellings reverse instant order');
  for (const [earlier, later] of variants) {
    for (const input of [[earlier, later], [later, earlier]]) {
      const r = classifyLeaveGaps(input.map((at) => join('m', at)), [], []);
      const gap = r.gaps[0];
      assert.equal(gap.kind, 'rejoin-gap');
      assert.equal(gap.joinsSeen, 2);
      assert.equal(gap.lastJoinAt, later);
      assert.deepEqual(gap.fills.map((f) => f.occurredAt), [earlier, later]);
      assert.deepEqual(gap.fills.map((f) => f.bound), ['earliest-possible', 'earliest-possible']);
      assert.equal(gap.fills[0].note, `provably present at ${earlier}, gone sometime after - and necessarily before the rejoin at ${later}`);
      assert.ok(gap.detail.includes(`left again after ${later}`));
    }
  }
});

test('gap members sort by last join instant with member id breaking equivalent-spelling ties', () => {
  const r = classifyLeaveGaps([
    join('a-later', '2026-08-31T18:00:00-05:00'),
    join('z-earlier', '2026-09-01T00:30:00+02:00'),
    join('b-tied', '2026-08-31T22:30:00.000Z'),
  ], [], []);
  assert.deepEqual(r.gaps.map((g) => g.memberId), ['b-tied', 'z-earlier', 'a-later']);
});

test('empty and malformed leave timestamps do not resolve a valid epoch join', () => {
  const r = classifyLeaveGaps(
    [join('m', '1970-01-01T00:00:00.000Z'), join('empty', '')],
    [leave('m', ''), leave('m', 'not-a-time')],
    [],
    { logFloor: '1970-01-01T01:00:00+01:00' },
  );
  assert.equal(r.skipped, 3);
  assert.equal(r.resolved, 0);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].kind, 'log-miss');
});

// --- the seeded reviewer fixture ---------------------------------------------

test('seeded gaps cover every path: 4 gaps, 1 present, 1 resolved, 3 skipped', () => {
  const seed = buildSeedGapData();
  const r = classifyLeaveGaps(seed.joins, seed.leaves, seed.roster, {
    logFloor: seed.logFloor,
    anomalies: ANOMALIES,
  });
  assert.deepEqual(
    r.gaps.map((g) => g.kind).sort(),
    ['log-miss', 'pre-coverage', 'raid-residue', 'rejoin-gap'],
  );
  assert.equal(r.present, 1);
  assert.equal(r.resolved, 1);
  assert.equal(r.skipped, 3);
  // Every proposed fill is bounded THAT-not-WHEN, never a bare timestamp.
  for (const g of r.gaps) {
    assert.ok(g.fills.length >= 1);
    for (const f of g.fills) assert.equal(f.bound, 'earliest-possible');
    assert.ok(g.detail.length > 0);
  }
  // No two fills for one member share a timestamp: occurred_at-keyed
  // idempotency would merge them and a departure would vanish.
  for (const g of r.gaps) {
    assert.equal(new Set(g.fills.map((f) => f.occurredAt)).size, g.fills.length);
  }
});

test('the report names every gap once, with counts, fills, and the unexecuted rule', () => {
  const seed = buildSeedGapData();
  const r = classifyLeaveGaps(seed.joins, seed.leaves, seed.roster, {
    logFloor: seed.logFloor,
    anomalies: ANOMALIES,
  });
  const text = formatLeaveGapReport(r, 'heading');
  assert.match(text, /gone from the roster \(4\)/);
  for (const kind of ['pre-coverage', 'log-miss', 'raid-residue', 'rejoin-gap']) {
    assert.match(text, new RegExp(`kind=${kind}`), `${kind} appears`);
    assert.match(text, new RegExp(`${kind}: 1`), `${kind} counted`);
  }
  assert.match(text, /present with no leave row \(correct, not a gap\): 1/);
  assert.match(text, /departed with a leave row \(resolved\): 1/);
  assert.match(text, /proposed fill rows if a future card executes: 5/);
  assert.match(text, /Proposed fill rule \(NOT executed/);
  assert.match(text, /never WHEN/);
  assert.match(text, /Dry-run first/);
  // The whole point: no bare null anywhere in the reviewer-facing output.
  assert.doesNotMatch(text, /null/i);
});

// --- the read path: SELECT only, over a fake ---------------------------------

interface CannedRows {
  joins: Array<{ guild_id: string; member_id: string | null; occurred_at: string; source: string }>;
  leaves: Array<{ guild_id: string; member_id: string | null; occurred_at: string }>;
}

/** In-memory stand-in for Postgres: canned rows, and a write ledger proving none happen. */
function fakeDb(canned: CannedRows, writes: string[]): Db {
  return {
    prepare(sql: string) {
      const rows = sql.includes('member_join') ? canned.joins : canned.leaves;
      return {
        async get<T>(..._params: unknown[]): Promise<T | undefined> {
          return rows[0] as unknown as T | undefined;
        },
        async all<T>(..._params: unknown[]): Promise<T[]> {
          return [...rows] as unknown as T[];
        },
        async run(..._params: unknown[]) {
          writes.push(sql);
          return { changes: 0 };
        },
      };
    },
    async exec(sql: string) {
      writes.push(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(fakeDb(canned, writes));
    },
    async close() {},
  };
}

test('fetchLeaveGapFeeds reads the two feeds and never writes', async () => {
  const writes: string[] = [];
  const db = fakeDb(
    {
      joins: [
        { guild_id: 'g', member_id: 'm', occurred_at: '2025-06-01T10:00:00.000Z', source: 'backfill:log:x' },
        // No member: passed through here, filtered by the classifier.
        { guild_id: 'g', member_id: null, occurred_at: '2025-06-01T10:00:00.000Z', source: 'backfill:log:x' },
      ],
      leaves: [{ guild_id: 'g', member_id: 'm', occurred_at: '2025-06-10T10:00:00.000Z' }],
    },
    writes,
  );
  const { joins, leaves } = await fetchLeaveGapFeeds(db);
  assert.deepEqual(joins, [
    { guildId: 'g', memberId: 'm', occurredAt: '2025-06-01T10:00:00.000Z', source: 'backfill:log:x' },
    { guildId: 'g', memberId: null, occurredAt: '2025-06-01T10:00:00.000Z', source: 'backfill:log:x' },
  ]);
  assert.deepEqual(leaves, [{ guildId: 'g', memberId: 'm', occurredAt: '2025-06-10T10:00:00.000Z' }]);
  assert.deepEqual(writes, []);
  for (const sql of ['member_join', 'member_leave'] as const) {
    void sql;
  }
});

// --- the CLI contract ----------------------------------------------------------

test('leave-gap --help documents the sweep without credentials', async () => {
  const out = await cli(['--help']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /leave-gap/);
  assert.match(out.stdout, /--seed/);
  assert.match(out.stdout, /--floor/);
  assert.match(out.stdout, /Read-only/);
});

test('leave-gap --seed prints the seeded report with no DB and no token', async () => {
  const out = await cli(['--seed']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /SEEDED DEMO/);
  assert.match(out.stdout, /gone from the roster \(4\)/);
  assert.match(out.stdout, /Proposed fill rule \(NOT executed/);
});

test('leave-gap rejects a bad day count with exit 2', async () => {
  const out = await cli(['zero']);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /Bad day count/);
});

test('leave-gap rejects a bad floor with exit 3', async () => {
  const out = await cli(['--floor=not-a-date']);
  assert.equal(out.code, 3, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /Bad --floor/);
});
