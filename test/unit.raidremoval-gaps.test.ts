/**
 * Raid-removal gap coverage (TOG-9138).
 *
 * The engine suites (`unit.raidremoval`, `e2e.raidremove`, `unit.kickclient`)
 * cover the happy paths thoroughly. What they never touch:
 *
 *   - the JSON target-list error branches (malformed JSON, a JSON object with
 *     no ids, an empty array, the `memberIds` / `memberId` / numeric shapes);
 *   - the audit-context null paths (`readAuditContext` on missing, malformed
 *     or member-less files) and the audit-log accounting (`lines`,
 *     non-terminal lines, non-string fields, non-ENOENT rethrow);
 *   - engine details the acceptance calls out: the `reason` passthrough, the
 *     status/detail/attempts carried into the audit line, a custom
 *     `maxConsecutiveFailures`, `onRecord` for the skipped path, the exact
 *     `notAttempted` identities, and the `now()` injection;
 *   - the list script's offline-reachable paths (`--help` with no database,
 *     the no-`TWO_DATABASE_URL` refusal);
 *   - the killswitch-off contract: neither `src/moderation/raidRemoval.ts`
 *     nor `scripts/raid-remove.ts` consults `TWO_MODERATION`, and executing
 *     with the killswitch unset or off still kicks. This is deliberate — the
 *     script acts on an operator-typed `--execute --expect N` under the
 *     TOG-411 authorisation, not on the bot runtime's killswitch — and it is
 *     distinct from TOG-8458, which pinned the *automatic* containment path
 *     (boot refusal in `src/index.ts`) rather than this manual tool.
 *
 * Offline by construction: fakes, temp files and two no-database spawns.
 * Nothing here opens a socket or needs Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KickResult, MemberRemover } from '../src/discord/kick.ts';
import {
  parseIdList,
  readAuditContext,
  readAuditLog,
  removeAccounts,
  type AuditRecord,
} from '../src/moderation/raidRemoval.ts';

const ROOT = join(import.meta.dirname, '..');
const LIST_SCRIPT = join(ROOT, 'scripts', 'raid-list.ts');

const ID = (n: number) => String(100000000000000000n + BigInt(n));
const ids = (n: number) => Array.from({ length: n }, (_, i) => ID(i));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'two-raid-gaps-'));
}

function fakeRemover(plan: (id: string, i: number) => Partial<KickResult>): MemberRemover & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    async kick(memberId: string): Promise<KickResult> {
      const i = asked.length;
      asked.push(memberId);
      return { outcome: 'kicked', status: 204, detail: 'removed', attempts: 1, ...plan(memberId, i) };
    },
  };
}

const noPrior = { done: new Set<string>(), lines: 0, unparseable: 0 };

function collect(): { sink: (r: AuditRecord) => void; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return { sink: (r) => records.push(r), records };
}

// ---------------------------------------------------------------------------
// The target list: JSON branches
// ---------------------------------------------------------------------------

test('a target list that looks like JSON but does not parse says so', () => {
  assert.throws(() => parseIdList('{"ids": ["1234567890123456789"', 'targets'), /looks like JSON but does not parse/);
});

test('a JSON object with no ids array is refused, not read as an empty list', () => {
  assert.throws(() => parseIdList(JSON.stringify({ foo: 1 }), 'targets'), /expected a JSON array of ids/);
  assert.throws(() => parseIdList(JSON.stringify({ ids: 'nope' }), 'targets'), /expected a JSON array of ids/);
});

test('an empty JSON array is an error, not a run that removes nobody', () => {
  assert.throws(() => parseIdList('[]', 'targets'), /contains no ids/);
});

test('the alternate JSON shapes all parse: memberIds, memberId fields, numbers', () => {
  assert.deepEqual(parseIdList(JSON.stringify({ memberIds: [ID(1)] })).ids, [ID(1)]);
  assert.deepEqual(parseIdList(JSON.stringify([{ memberId: ID(2) }, { id: ID(3) }])).ids, [ID(2), ID(3)]);
  assert.deepEqual(parseIdList(JSON.stringify([ID(4)])).ids, [ID(4)]);
});

test('JSON entries that are not snowflakes are rejected with line numbers, never dropped', () => {
  // Note: entries that stringify to '' (null ids, missing fields) are skipped
  // by the same `if (!value) continue` rule as blank text lines, not rejected.
  const p = parseIdList(JSON.stringify([ID(1), 'sneaky_username', { id: 'bogus' }, { id: null }]));
  assert.deepEqual(p.ids, [ID(1)]);
  assert.deepEqual(p.rejected, [
    { line: 2, value: 'sneaky_username' },
    { line: 3, value: 'bogus' },
  ]);
});

// ---------------------------------------------------------------------------
// The audit log: accounting and null paths
// ---------------------------------------------------------------------------

test('readAuditContext returns null instead of throwing on anything unreadable', () => {
  const dir = scratch();
  assert.equal(readAuditContext(join(dir, 'missing.json')), null);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(readAuditContext(bad), null);
  const arr = join(dir, 'arr.json');
  writeFileSync(arr, '[]');
  assert.equal(readAuditContext(arr), null);
  const thin = join(dir, 'thin.json');
  writeFileSync(thin, JSON.stringify({ summary: {} }));
  assert.equal(readAuditContext(thin), null);
  const thinner = join(dir, 'thinner.json');
  writeFileSync(thinner, JSON.stringify({ summary: { members: {} } }));
  assert.equal(readAuditContext(thinner), null);
});

test('readAuditLog rethrows a non-ENOENT failure instead of calling it empty history', () => {
  // A directory is readable-but-not-a-file: surfacing the error beats
  // pretending no previous run ever settled anything.
  assert.throws(() => readAuditLog(scratch()), /EISDIR/);
});

test('readAuditLog counts lines and only settles terminal outcomes with string ids', () => {
  const dir = scratch();
  const path = join(dir, 'audit.jsonl');
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    path,
    [
      line({ memberId: ID(0), outcome: 'kicked' }),
      line({ memberId: ID(1), outcome: 'would_kick' }),
      line({ memberId: ID(2), outcome: 'forbidden' }),
      line({ memberId: 42, outcome: 'kicked' }),
      line({ memberId: ID(3) }),
      '',
      '{"torn": true, "memberId": "',
    ].join('\n'),
  );
  const prior = readAuditLog(path);
  assert.deepEqual([...prior.done], [ID(0)]);
  assert.equal(prior.lines, 6);
  assert.equal(prior.unparseable, 1);
});

// ---------------------------------------------------------------------------
// The engine: passthrough details
// ---------------------------------------------------------------------------

test('the reason reaches the remover verbatim for every account', async () => {
  const seen: [string, string][] = [];
  const remover: MemberRemover = {
    async kick(memberId: string, reason: string): Promise<KickResult> {
      seen.push([memberId, reason]);
      return { outcome: 'kicked', status: 204, detail: 'removed', attempts: 1 };
    },
  };
  const { sink } = collect();
  await removeAccounts({
    ids: ids(2),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'Raid account removal (TOG-411). Never posted, never joined voice.',
    runId: 'run-1',
  });
  assert.deepEqual(seen, [
    [ID(0), 'Raid account removal (TOG-411). Never posted, never joined voice.'],
    [ID(1), 'Raid account removal (TOG-411). Never posted, never joined voice.'],
  ]);
});

test('a failed result carries its status, detail and attempts into the audit line', async () => {
  const remover = fakeRemover(() => ({ outcome: 'forbidden', status: 403, detail: 'missing Kick Members' }));
  const { sink, records } = collect();
  const summary = await removeAccounts({
    ids: ids(4),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });
  assert.equal(summary.aborted, true);
  assert.equal(records.length, 3);
  for (const r of records) {
    assert.equal(r.outcome, 'forbidden');
    assert.equal(r.status, 403);
    assert.equal(r.detail, 'missing Kick Members');
    assert.equal(r.attempts, 1);
    assert.equal(r.mode, 'execute');
  }
  assert.equal(summary.counts.forbidden, 3);
});

test('a custom maxConsecutiveFailures is honored in both directions', async () => {
  const failing = () =>
    fakeRemover(() => ({ outcome: 'failed', status: 500, detail: 'server error' }));

  const hair = failing();
  const a = await removeAccounts({
    ids: ids(5),
    execute: true,
    remover: hair,
    sink: () => {},
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
    maxConsecutiveFailures: 1,
  });
  assert.equal(a.aborted, true);
  assert.equal(hair.asked.length, 1);

  const patient = failing();
  const b = await removeAccounts({
    ids: ids(5),
    execute: true,
    remover: patient,
    sink: () => {},
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
    maxConsecutiveFailures: 10,
  });
  assert.equal(b.aborted, false);
  assert.equal(patient.asked.length, 5);
});

test('the skipped path reports through onRecord and names the exact leftovers on abort', async () => {
  const seen: AuditRecord[] = [];
  const summary = await removeAccounts({
    ids: ids(6),
    execute: true,
    remover: fakeRemover(() => ({ outcome: 'forbidden', status: 403, detail: 'no' })),
    sink: () => {},
    prior: { done: new Set([ID(0)]), lines: 1, unparseable: 0 },
    reason: 'r',
    runId: 'run-1',
    onRecord: (r) => seen.push(r),
  });
  assert.equal(summary.skippedDone, 1);
  assert.equal(summary.counts.skipped_done, 1);
  const skipped = seen.filter((r) => r.outcome === 'skipped_done');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.memberId, ID(0));
  assert.equal(skipped[0]!.attempts, 0);
  assert.equal(skipped[0]!.mode, 'execute');
  // ID(0) skipped; ID(1..3) record three consecutive failures and trip the
  // abort; ID(4..5) are never reached.
  assert.deepEqual(summary.notAttempted, [ID(4), ID(5)]);
});

test('the injected clock stamps every record', async () => {
  const { sink, records } = collect();
  await removeAccounts({
    ids: ids(3),
    execute: false,
    remover: null,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(records.length, 3);
  assert.ok(records.every((r) => r.ts === '2026-01-01T00:00:00.000Z'));
  assert.ok(records.every((r) => r.runId === 'run-1'));
});

// ---------------------------------------------------------------------------
// The list script's offline-reachable paths
// ---------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runList(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LIST_SCRIPT, ...args],
      { cwd: ROOT, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function offlineEnv(): Record<string, string | undefined> {
  return {
    TWO_DATABASE_URL: undefined,
    DISCORD_TOKEN: undefined,
    DISCORD_BOT_TOKEN: undefined,
    DISCORD_GUILD_ID: undefined,
    TWO_MODERATION: undefined,
  };
}

test('raid-list --help boots with no database, no token and no killswitch', async () => {
  const r = await runList(['--help'], offlineEnv());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Read-only raid-account list/);
  assert.match(r.stdout, /Kicks, bans, messages and writes nothing/);
});

test('raid-list without a database refuses instead of listing half a roster', async () => {
  const r = await runList([], offlineEnv());
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /TWO_DATABASE_URL is not set/);
});

// ---------------------------------------------------------------------------
// Killswitch-off behavior (relates TOG-8458 without duplicating it)
// ---------------------------------------------------------------------------

test('the removal engine and script take no killswitch input', () => {
  // TOG-8458 pinned the automatic containment path to the TWO_MODERATION
  // killswitch (boot refusal in src/index.ts). This tool is the opposite
  // direction: a manual, operator-typed --execute under the TOG-411
  // authorisation. If a killswitch check ever lands here, this fails and
  // whoever adds it has to argue for it alongside TOG-411.
  for (const rel of ['src/moderation/raidRemoval.ts', 'scripts/raid-remove.ts']) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(!text.includes('TWO_MODERATION'), `${rel} must not consult the moderation killswitch`);
    assert.ok(!text.includes('moderationCfg'), `${rel} must not take the bot runtime moderation config`);
  }
});

test('execute kicks the same accounts with the killswitch unset and with it off', async () => {
  const saved = process.env.TWO_MODERATION;
  try {
    for (const value of [undefined, '0', '']) {
      if (value === undefined) delete process.env.TWO_MODERATION;
      else process.env.TWO_MODERATION = value;
      const remover = fakeRemover(() => ({}));
      const { sink, records } = collect();
      const summary = await removeAccounts({
        ids: ids(2),
        execute: true,
        remover,
        sink,
        prior: noPrior,
        reason: 'r',
        runId: 'run-1',
      });
      assert.deepEqual(remover.asked, ids(2), `killswitch=${String(value)} must not change behavior`);
      assert.equal(summary.counts.kicked, 2);
      assert.equal(records.length, 2);
    }
  } finally {
    if (saved === undefined) delete process.env.TWO_MODERATION;
    else process.env.TWO_MODERATION = saved;
  }
});
