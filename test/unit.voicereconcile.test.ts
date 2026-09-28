/**
 * Voice open-half reconciliation (TOG-8289).
 *
 * A voice session is two halves - a `voice_session_start` row and a
 * `voice_session_end` row - and restarts, pre-TOG-6122 server leaves, and bad
 * end rows orphan one half, leaving a NULL where a duration should be. The
 * sweep pairs halves per (guild, member) in time order and recovers a
 * duration wherever the stored rows allow it; what cannot be recovered stays
 * listed with an explicit reason, never a silent NULL.
 *
 * No database, no token, no network: reconcileVoiceHalves() takes rows, and
 * fetchVoiceHalves() takes a narrow Db that the read test below fakes
 * in-memory (the fake also proves the sweep never writes). The CLI cases run
 * the real `scripts/voice-reconcile.ts` as a subprocess - a drift between the
 * documented commands and what the script accepts reds here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildSeedHalves,
  fetchVoiceHalves,
  formatReconcileReport,
  reconcileVoiceHalves,
  type HalfEnd,
  type HalfStart,
  type LeaveRow,
} from '../src/analytics/voiceReconcile.ts';
import type { Db } from '../src/store/driver.ts';

const G = 'g1';
const start = (memberId: string, occurredAt: string, channel = 'ch-a'): HalfStart => ({
  guildId: G,
  memberId,
  occurredAt,
  channel,
});
const end = (
  memberId: string,
  occurredAt: string,
  partial: Partial<HalfEnd> = {},
): HalfEnd => ({
  guildId: G,
  memberId,
  occurredAt,
  channel: 'ch-a',
  startKnown: true,
  startedAt: null,
  durationSeconds: null,
  ...partial,
});
const leave = (memberId: string, occurredAt: string): LeaveRow => ({
  guildId: G,
  memberId,
  occurredAt,
});

// --- the three resolvable shapes --------------------------------------------

test('restart loss: an unknown-start end pairs with the start row on file', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z')],
    [end('m', '2026-09-20T11:00:00.000Z', { startKnown: false })],
    [],
  );
  assert.equal(r.resolved.length, 1);
  assert.deepEqual(r.resolved[0], {
    guildId: G,
    memberId: 'm',
    channel: 'ch-a',
    startAt: '2026-09-20T10:00:00.000Z',
    endAt: '2026-09-20T11:00:00.000Z',
    durationSeconds: 3600,
    resolution: 'restart-gap',
  });
  assert.equal(r.unresolvable.length, 0);
});

test('server leave: a pre-TOG-6122 leave closes the open session', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z')],
    [],
    [leave('m', '2026-09-20T10:10:00.000Z')],
  );
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0]!.resolution, 'server-leave');
  assert.equal(r.resolved[0]!.durationSeconds, 600);
  assert.equal(r.unresolvable.length, 0);
});

test('a leave older than the open start proves nothing and is ignored', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z')],
    [],
    [leave('m', '2026-09-20T09:00:00.000Z')],
  );
  assert.equal(r.resolved.length, 0);
  // The start is still open - flagged, not dropped.
  assert.equal(r.unresolvable.length, 1);
  assert.equal(r.unresolvable[0]!.reason, 'still-open');
});

test('bad end row: a known-start end with no duration recomputes from startedAt', () => {
  const r = reconcileVoiceHalves(
    [],
    [
      end('m', '2026-09-20T10:30:00.000Z', {
        startedAt: '2026-09-20T10:00:00.000Z',
        durationSeconds: null,
      }),
    ],
    [],
  );
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0]!.resolution, 'metadata-recompute');
  assert.equal(r.resolved[0]!.durationSeconds, 1800);
  assert.equal(r.unresolvable.length, 0);
});

test('a negative duration is unusable, so the row falls back to startedAt', () => {
  const r = reconcileVoiceHalves(
    [],
    [
      end('m', '2026-09-20T10:30:00.000Z', {
        startedAt: '2026-09-20T10:00:00.000Z',
        durationSeconds: -5,
      }),
    ],
    [],
  );
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0]!.resolution, 'metadata-recompute');
  assert.equal(r.resolved[0]!.durationSeconds, 1800);
});

test('an end stamped before its recorded start clamps to 0 with a note', () => {
  const r = reconcileVoiceHalves(
    [],
    [
      end('m', '2026-09-20T10:00:00.000Z', {
        startedAt: '2026-09-20T10:05:00.000Z',
        durationSeconds: null,
      }),
    ],
    [],
  );
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0]!.durationSeconds, 0);
  assert.match(r.resolved[0]!.note ?? '', /clock skew/);
});

test('a known start with no usable row timestamp falls back to the start on file', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z')],
    [end('m', '2026-09-20T11:00:00.000Z', { startedAt: 'garbage', durationSeconds: null })],
    [],
  );
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0]!.resolution, 'restart-gap');
  assert.equal(r.resolved[0]!.durationSeconds, 3600);
  assert.match(r.resolved[0]!.note ?? '', /no usable startedAt/);
});

// --- healthy sessions are counted, not swept ---------------------------------

test('a clean pair counts as complete and lists nothing', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z')],
    [
      end('m', '2026-09-20T10:30:00.000Z', {
        startedAt: '2026-09-20T10:00:00.000Z',
        durationSeconds: 1800,
      }),
    ],
    [],
  );
  assert.equal(r.complete, 1);
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 0);
});

// --- the four flagged shapes --------------------------------------------------

test('a lone start stays flagged as still-open, never zero-filled', () => {
  const r = reconcileVoiceHalves([start('m', '2026-09-20T10:00:00.000Z')], [], []);
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 1);
  assert.equal(r.unresolvable[0]!.reason, 'still-open');
  assert.equal(r.unresolvable[0]!.endAt, null);
  assert.match(r.unresolvable[0]!.detail, /may be in voice right now/);
});

test('a second start supersedes the first; the instant stays unknowable', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T10:00:00.000Z'), start('m', '2026-09-20T11:00:00.000Z', 'ch-b')],
    [],
    [],
  );
  const sup = r.unresolvable.find((u) => u.reason === 'superseded');
  assert.ok(sup, 'the replaced start is flagged superseded');
  assert.equal(sup.startAt, '2026-09-20T10:00:00.000Z');
  assert.equal(sup.endAt, '2026-09-20T11:00:00.000Z');
  assert.match(sup.detail, /unknowable/);
  // The replacing start itself is still open.
  assert.ok(r.unresolvable.some((u) => u.reason === 'still-open'));
});

test('an unknown-start end with no start anywhere is flagged, not guessed', () => {
  const r = reconcileVoiceHalves(
    [],
    [end('m', '2026-09-20T11:00:00.000Z', { startKnown: false })],
    [],
  );
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 1);
  assert.equal(r.unresolvable[0]!.reason, 'no-start-on-file');
  assert.equal(r.unresolvable[0]!.startAt, null);
});

test('a known-start end with nothing to recompute from is a bad end row', () => {
  const r = reconcileVoiceHalves(
    [],
    [end('m', '2026-09-20T11:00:00.000Z', { startedAt: null, durationSeconds: null })],
    [],
  );
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 1);
  assert.equal(r.unresolvable[0]!.reason, 'bad-end-row');
});

// --- pairing discipline --------------------------------------------------------

test('pairing only runs forwards: an end older than every start stays orphaned', () => {
  const r = reconcileVoiceHalves(
    [start('m', '2026-09-20T12:00:00.000Z')],
    [end('m', '2026-09-20T11:00:00.000Z', { startKnown: false })],
    [],
  );
  // Pairing backwards would invent causality, so the end stays orphaned and
  // the start stays open - two flagged halves, zero resolutions.
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 2);
  assert.ok(r.unresolvable.some((u) => u.reason === 'no-start-on-file'));
  assert.ok(r.unresolvable.some((u) => u.reason === 'still-open'));
});

test('members never pair across each other', () => {
  const r = reconcileVoiceHalves(
    [start('a', '2026-09-20T10:00:00.000Z')],
    [end('b', '2026-09-20T11:00:00.000Z', { startKnown: false })],
    [],
  );
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 2);
});

test('a channel move at one instant closes the old session, opens the new one', () => {
  const r = reconcileVoiceHalves(
    [
      start('m', '2026-09-20T10:00:00.000Z'),
      start('m', '2026-09-20T11:00:00.000Z', 'ch-b'),
    ],
    [
      end('m', '2026-09-20T11:00:00.000Z', {
        startedAt: '2026-09-20T10:00:00.000Z',
        durationSeconds: 3600,
      }),
    ],
    [],
  );
  // Ends sort before starts at equal timestamps (the live adapter leaves the
  // old channel before joining the new one): the end closes the first session
  // as a complete, and the new start stays open - no supersede.
  assert.equal(r.complete, 1);
  assert.equal(r.resolved.length, 0);
  assert.deepEqual(
    r.unresolvable.map((u) => u.reason),
    ['still-open'],
  );
});

test('malformed timestamps are skipped, never paired somewhere', () => {
  const r = reconcileVoiceHalves(
    [start('m', 'garbage')],
    [end('', '2026-09-20T11:00:00.000Z', { startKnown: false })],
    [],
  );
  assert.equal(r.skipped, 2);
  assert.equal(r.resolved.length, 0);
  assert.equal(r.unresolvable.length, 0);
});

// --- the seeded reviewer fixture ------------------------------------------------

test('seeded halves cover every path: 3 resolved, 3 flagged, 2 complete', () => {
  const seed = buildSeedHalves(new Date('2026-09-28T12:00:00.000Z'));
  const r = reconcileVoiceHalves(seed.starts, seed.ends, seed.leaves);
  assert.deepEqual(
    r.resolved.map((s) => s.resolution).sort(),
    ['metadata-recompute', 'restart-gap', 'server-leave'],
    'a restart loss, a server leave, and a metadata recompute',
  );
  assert.deepEqual(
    r.unresolvable.map((u) => u.reason).sort(),
    ['no-start-on-file', 'still-open', 'superseded'],
  );
  assert.equal(r.complete, 2);
  // The two lists partition the open halves: nothing silently NULL.
  for (const s of r.resolved) assert.ok(Number.isFinite(s.durationSeconds) && s.durationSeconds >= 0);
  for (const u of r.unresolvable) assert.ok(u.detail.length > 0);
});

test('the report names every open half once, with a duration or a reason', () => {
  const seed = buildSeedHalves(new Date('2026-09-28T12:00:00.000Z'));
  const text = formatReconcileReport(reconcileVoiceHalves(seed.starts, seed.ends, seed.leaves), 'heading');
  assert.match(text, /Resolved with a duration \(3\):/);
  assert.match(text, /Unresolvable with a reason \(3\):/);
  assert.match(text, /2 complete session\(s\) with clean durations \(not listed\)/);
  assert.match(text, /restart-gap/);
  assert.match(text, /server-leave/);
  assert.match(text, /metadata-recompute/);
  assert.match(text, /reason=no-start-on-file/);
  assert.match(text, /reason=still-open/);
  assert.match(text, /reason=superseded/);
  // The whole point: no bare NULL anywhere in the reviewer-facing output.
  assert.doesNotMatch(text, /null/i);
});

// --- the read path: SELECT only, over a fake -------------------------------------

interface CannedRows {
  starts: Array<{ guild_id: string; member_id: string | null; occurred_at: string; source: string }>;
  ends: Array<{
    guild_id: string;
    member_id: string | null;
    occurred_at: string;
    source: string;
    metadata: string | null;
  }>;
  leaves: Array<{ guild_id: string; member_id: string | null; occurred_at: string }>;
}

/** In-memory stand-in for Postgres: canned rows, and a write ledger proving none happen. */
function fakeDb(canned: CannedRows, writes: string[]): Db {
  return {
    prepare(sql: string) {
      const rows = sql.includes('voice_session_start')
        ? canned.starts
        : sql.includes('voice_session_end')
          ? canned.ends
          : canned.leaves;
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

test('fetchVoiceHalves reads the three feeds, strips channel: and never writes', async () => {
  const writes: string[] = [];
  const db = fakeDb(
    {
      starts: [
        { guild_id: 'g', member_id: 'm', occurred_at: '2026-09-20T10:00:00.000Z', source: 'channel:ch-a' },
        // No member: filtered, never paired.
        { guild_id: 'g', member_id: null, occurred_at: '2026-09-20T10:00:00.000Z', source: 'channel:ch-a' },
      ],
      ends: [
        {
          guild_id: 'g',
          member_id: 'm',
          occurred_at: '2026-09-20T11:00:00.000Z',
          source: 'channel:ch-a',
          metadata: JSON.stringify({ startKnown: false }),
        },
        // Unreadable metadata is not evidence of an unknown start.
        {
          guild_id: 'g',
          member_id: 'm2',
          occurred_at: '2026-09-20T11:00:00.000Z',
          source: 'plain-source',
          metadata: 'not-json{{{',
        },
      ],
      leaves: [{ guild_id: 'g', member_id: 'm', occurred_at: '2026-09-20T10:10:00.000Z' }],
    },
    writes,
  );
  const { starts, ends, leaves } = await fetchVoiceHalves(db);
  assert.deepEqual(starts, [
    { guildId: 'g', memberId: 'm', occurredAt: '2026-09-20T10:00:00.000Z', channel: 'ch-a' },
  ]);
  assert.deepEqual(ends, [
    {
      guildId: 'g',
      memberId: 'm',
      occurredAt: '2026-09-20T11:00:00.000Z',
      channel: 'ch-a',
      startKnown: false,
      startedAt: null,
      durationSeconds: null,
    },
    {
      guildId: 'g',
      memberId: 'm2',
      occurredAt: '2026-09-20T11:00:00.000Z',
      channel: 'plain-source',
      startKnown: true,
      startedAt: null,
      durationSeconds: null,
    },
  ]);
  assert.deepEqual(leaves, [{ guildId: 'g', memberId: 'm', occurredAt: '2026-09-20T10:10:00.000Z' }]);
  // Read-only by design: the sweep has no write path to get wrong.
  assert.deepEqual(writes, []);
});

// --- the CLI contract --------------------------------------------------------------

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/voice-reconcile.ts', import.meta.url).pathname;

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TWO_DATABASE_URL;
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('seeded demo prints every open half resolved or flagged, no database', async () => {
  const out = await cli(['--seed']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /SEEDED DEMO/);
  assert.match(out.stdout, /Resolved with a duration \(3\):/);
  assert.match(out.stdout, /Unresolvable with a reason \(3\):/);
  assert.match(out.stdout, /2 complete session\(s\)/);
});

test('--help boots with no database and no credentials', async () => {
  const out = await cli(['--help']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /voice-reconcile/);
});

test('a bad day count exits 2, never a report on a made-up window', async () => {
  const out = await cli(['bogus']);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /Bad day count/);
});

test('the live path without TWO_DATABASE_URL exits 1 with guidance', async () => {
  const out = await cli([]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /TWO_DATABASE_URL is not set/);
});
