/**
 * Raid-account removal: the decisions.
 *
 * Three things have to be true before anybody points this at a live server, and
 * none of them are obvious from reading the code:
 *
 *   1. A dry run cannot contact Discord. Not "does not by convention" — the
 *      tests below hand the dry run a remover that explodes if it is called.
 *   2. Re-running the same input never removes anybody twice, including across
 *      a process kill and including when a dry run is interleaved between two
 *      execute runs.
 *   3. A systemic failure stops the run instead of repeating itself thirty
 *      times. Thirty identical 403s is not a log, it is noise with an operator
 *      who has stopped reading it.
 *
 * The audit log is exercised against a real file on disk, because the property
 * that matters — a killed run leaves a readable record — is a property of the
 * file, not of the object that wrote it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { KickResult, MemberRemover } from '../src/discord/kick.ts';
import {
  AUDIT_SCHEMA_VERSION,
  crossCheck,
  fileAuditSink,
  isTerminal,
  parseIdList,
  readAuditContext,
  readAuditLog,
  removeAccounts,
  type AuditRecord,
} from '../src/moderation/raidRemoval.ts';

const ID = (n: number) => String(100000000000000000n + BigInt(n));
const ids = (n: number) => Array.from({ length: n }, (_, i) => ID(i));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'two-raid-remove-'));
}

/** A remover that answers from a script, and records who it was asked about. */
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

const explodingRemover: MemberRemover = {
  async kick(): Promise<KickResult> {
    throw new Error('a dry run reached the network');
  },
};

const noPrior = { done: new Set<string>(), lines: 0, unparseable: 0 };

function collect(): { sink: (r: AuditRecord) => void; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return { sink: (r) => records.push(r), records };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('a dry run contacts nobody, even when a remover is sitting right there', async () => {
  const { sink, records } = collect();
  const summary = await removeAccounts({
    ids: ids(5),
    execute: false,
    remover: explodingRemover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });

  assert.equal(summary.total, 5);
  assert.equal(summary.attempted, 0);
  assert.equal(summary.counts.would_kick, 5);
  assert.equal(records.length, 5);
  assert.ok(records.every((r) => r.outcome === 'would_kick' && r.mode === 'dry-run'));
});

test('execute without a remover refuses to start rather than doing half a job', async () => {
  await assert.rejects(
    () =>
      removeAccounts({
        ids: ids(1),
        execute: true,
        remover: null,
        sink: () => {},
        prior: noPrior,
        reason: 'r',
        runId: 'run-1',
      }),
    /requires a MemberRemover/,
  );
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

test('execute kicks each id once, in order, and records one line each', async () => {
  const remover = fakeRemover(() => ({}));
  const { sink, records } = collect();
  const summary = await removeAccounts({
    ids: ids(3),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });

  assert.deepEqual(remover.asked, ids(3));
  assert.equal(summary.counts.kicked, 3);
  assert.equal(records.length, 3);
  assert.ok(records.every((r) => r.mode === 'execute' && r.action === 'kick' && r.v === AUDIT_SCHEMA_VERSION));
});

test('an account that is already gone is a terminal outcome, not a failure', async () => {
  const remover = fakeRemover((_id, i) =>
    i === 1 ? { outcome: 'already_gone', status: 404, detail: 'not a member' } : {},
  );
  const { sink } = collect();
  const summary = await removeAccounts({
    ids: ids(3),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });

  assert.equal(summary.counts.kicked, 2);
  assert.equal(summary.counts.already_gone, 1);
  assert.equal(summary.aborted, false);
});

// ---------------------------------------------------------------------------
// Re-running
// ---------------------------------------------------------------------------

test('re-running the same input asks Discord about nobody who is already done', async () => {
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const target = ids(4);

  const first = fakeRemover(() => ({}));
  await removeAccounts({
    ids: target,
    execute: true,
    remover: first,
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-1',
  });
  assert.equal(first.asked.length, 4);

  const second = fakeRemover(() => ({}));
  const summary = await removeAccounts({
    ids: target,
    execute: true,
    remover: second,
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-2',
  });

  assert.deepEqual(second.asked, [], 'the second run must issue no requests at all');
  assert.equal(summary.skippedDone, 4);
  assert.equal(summary.attempted, 0);

  // And it did not re-stamp four settled lines into the log.
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
});

test('a dry run between two execute runs cannot re-arm an account that is already kicked', async () => {
  // The trap this pins: if `readAuditLog` took the *last* record per id rather
  // than "was there ever a terminal one", the dry run's `would_kick` line would
  // mask the earlier `kicked` and the third run would kick a second time.
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const target = ids(2);

  await removeAccounts({
    ids: target,
    execute: true,
    remover: fakeRemover(() => ({})),
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-1',
  });

  // Someone runs the dry run again to see where things stand. It appends.
  await removeAccounts({
    ids: target,
    execute: false,
    remover: null,
    sink: fileAuditSink(auditPath),
    prior: { done: new Set(), lines: 0, unparseable: 0 },
    reason: 'r',
    runId: 'run-2',
  });
  assert.ok(readFileSync(auditPath, 'utf8').includes('would_kick'));

  const third = fakeRemover(() => ({}));
  await removeAccounts({
    ids: target,
    execute: true,
    remover: third,
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-3',
  });
  assert.deepEqual(third.asked, []);
});

test('a kick that succeeded but whose audit line was lost costs one 404, never a second removal', async () => {
  // The one window idempotency-by-log cannot cover: the process dies between
  // the successful DELETE and the fsync. Kick is idempotent at Discord, so the
  // retry converges instead of double-acting. This is why it is a kick.
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const target = ids(3);

  // Run 1 removed all three but only line 1 reached disk.
  const sink = fileAuditSink(auditPath);
  sink({
    v: AUDIT_SCHEMA_VERSION,
    ts: '2026-08-25T00:00:00.000Z',
    runId: 'run-1',
    memberId: target[0]!,
    action: 'kick',
    mode: 'execute',
    outcome: 'kicked',
    status: 204,
    detail: 'removed',
    attempts: 1,
  });

  const second = fakeRemover(() => ({ outcome: 'already_gone', status: 404, detail: 'not a member' }));
  const summary = await removeAccounts({
    ids: target,
    execute: true,
    remover: second,
    sink,
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-2',
  });

  assert.deepEqual(second.asked, [target[1], target[2]]);
  assert.equal(summary.counts.already_gone, 2);
  assert.equal(summary.counts.kicked, undefined, 'nobody was removed a second time');
  assert.equal(readAuditLog(auditPath).done.size, 3);
});

// ---------------------------------------------------------------------------
// Failing safely
// ---------------------------------------------------------------------------

test('three consecutive failures end the run, and the rest are left for a re-run', async () => {
  const remover = fakeRemover(() => ({
    outcome: 'forbidden',
    status: 403,
    detail: 'missing Kick Members',
  }));
  const { sink, records } = collect();
  const summary = await removeAccounts({
    ids: ids(30),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });

  assert.equal(summary.aborted, true);
  assert.equal(remover.asked.length, 3, 'it must not grind through all thirty');
  assert.equal(records.length, 3);
  assert.equal(summary.notAttempted.length, 27);
  assert.match(summary.abortReason!, /consecutive failures/);
});

test('a success resets the failure counter — intermittent trouble is not an abort', async () => {
  // fail, fail, ok, fail, fail, ok, ... never three in a row.
  const remover = fakeRemover((_id, i) =>
    i % 3 === 2 ? {} : { outcome: 'failed', status: 500, detail: 'server error' },
  );
  const { sink } = collect();
  const summary = await removeAccounts({
    ids: ids(9),
    execute: true,
    remover,
    sink,
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
  });

  assert.equal(summary.aborted, false);
  assert.equal(summary.attempted, 9);
  assert.equal(summary.counts.kicked, 3);
  assert.equal(summary.counts.failed, 6);
});

test('an aborted run resumes exactly where it stopped, and re-tries what failed', async () => {
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const target = ids(10);

  // Run 1: two go through, then the permission is revoked mid-run.
  const first = fakeRemover((_id, i) =>
    i < 2 ? {} : { outcome: 'forbidden', status: 403, detail: 'missing Kick Members' },
  );
  const a = await removeAccounts({
    ids: target,
    execute: true,
    remover: first,
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-1',
  });
  assert.equal(a.aborted, true);
  assert.equal(first.asked.length, 5, '2 kicked then 3 forbidden');

  // Run 2, same command, permission restored.
  const second = fakeRemover(() => ({}));
  const b = await removeAccounts({
    ids: target,
    execute: true,
    remover: second,
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-2',
  });

  assert.equal(b.skippedDone, 2, 'the two that succeeded are skipped');
  assert.deepEqual(second.asked, target.slice(2), 'the three 403s are retried, not abandoned');
  assert.equal(b.aborted, false);
  assert.equal(readAuditLog(auditPath).done.size, 10);
});

test('rate limiting is reported per account and is retryable on the next run', async () => {
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const target = ids(2);

  await removeAccounts({
    ids: target,
    execute: true,
    remover: fakeRemover((_id, i) =>
      i === 0 ? {} : { outcome: 'rate_limited', status: 429, detail: 'still rate limited' },
    ),
    sink: fileAuditSink(auditPath),
    prior: readAuditLog(auditPath),
    reason: 'r',
    runId: 'run-1',
  });

  const prior = readAuditLog(auditPath);
  assert.equal(prior.done.size, 1);
  assert.equal(prior.done.has(target[1]!), false, 'a rate-limited account is not done');
});

// ---------------------------------------------------------------------------
// The audit log as a file
// ---------------------------------------------------------------------------

test('every line lands on disk as it happens, so a killed run is still readable', async () => {
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');

  // The sink is called synchronously per account, so reading the file from
  // inside onRecord sees everything up to and including that account.
  const seen: number[] = [];
  await removeAccounts({
    ids: ids(4),
    execute: true,
    remover: fakeRemover(() => ({})),
    sink: fileAuditSink(auditPath),
    prior: noPrior,
    reason: 'r',
    runId: 'run-1',
    onRecord: () => {
      seen.push(readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).length);
    },
  });
  assert.deepEqual(seen, [1, 2, 3, 4]);

  const first = JSON.parse(readFileSync(auditPath, 'utf8').split('\n')[0]!) as AuditRecord;
  assert.equal(first.action, 'kick');
  assert.equal(first.outcome, 'kicked');
  assert.equal(first.status, 204);
  assert.ok(Date.parse(first.ts) > 0, 'the timestamp is a real instant');
  assert.equal(first.memberId, ID(0));
});

test('a torn last line from a kill is tolerated, counted, and does not lose the good lines', () => {
  const dir = scratch();
  const auditPath = join(dir, 'audit.jsonl');
  const good = {
    v: 1,
    ts: '2026-08-25T00:00:00.000Z',
    runId: 'r',
    memberId: ID(0),
    action: 'kick',
    mode: 'execute',
    outcome: 'kicked',
    status: 204,
    detail: 'removed',
    attempts: 1,
  };
  writeFileSync(auditPath, JSON.stringify(good) + '\n');
  appendFileSync(auditPath, '{"v":1,"ts":"2026-08-25T00:00:01.000Z","memb');

  const prior = readAuditLog(auditPath);
  assert.equal(prior.done.size, 1);
  assert.equal(prior.done.has(ID(0)), true);
  assert.equal(prior.unparseable, 1);
});

test('a missing audit log is an empty history, not an error', () => {
  const prior = readAuditLog(join(scratch(), 'nope.jsonl'));
  assert.equal(prior.done.size, 0);
  assert.equal(prior.lines, 0);
});

test('only kicked and already_gone are terminal', () => {
  assert.equal(isTerminal('kicked'), true);
  assert.equal(isTerminal('already_gone'), true);
  for (const o of ['would_kick', 'forbidden', 'rate_limited', 'failed', 'skipped_done']) {
    assert.equal(isTerminal(o), false, `${o} must stay retryable`);
  }
});

// ---------------------------------------------------------------------------
// The target list
// ---------------------------------------------------------------------------

test('the output of `raid-list.ts --ids` parses, comments and all', () => {
  const p = parseIdList(
    ['# produced 2026-08-25 by scripts/raid-list.ts --ids', '', ID(1), `${ID(2)}  # 2025-12-15 raid`, ID(3), ''].join(
      '\n',
    ),
  );
  assert.deepEqual(p.ids, [ID(1), ID(2), ID(3)]);
  assert.deepEqual(p.rejected, []);
});

test('a repeated id is counted once and reported, so a bad paste is visible', () => {
  const p = parseIdList([ID(1), ID(2), ID(1)].join('\n'));
  assert.deepEqual(p.ids, [ID(1), ID(2)]);
  assert.deepEqual(p.duplicates, [ID(1)]);
});

test('a line that is not a snowflake is rejected with its line number, never dropped', () => {
  const p = parseIdList([ID(1), 'sneaky_username', '42'].join('\n'));
  assert.deepEqual(p.ids, [ID(1)]);
  assert.deepEqual(p.rejected, [
    { line: 2, value: 'sneaky_username' },
    { line: 3, value: '42' },
  ]);
});

test('JSON target lists work too: a bare array, or an object with ids, or objects with an id', () => {
  assert.deepEqual(parseIdList(JSON.stringify([ID(1), ID(2)])).ids, [ID(1), ID(2)]);
  assert.deepEqual(parseIdList(JSON.stringify({ ids: [ID(1)] })).ids, [ID(1)]);
  assert.deepEqual(parseIdList(JSON.stringify([{ member_id: ID(3) }, { id: ID(4) }])).ids, [ID(3), ID(4)]);
});

test('an empty list is an error, not a run that removes nobody and reports success', () => {
  assert.throws(() => parseIdList('   '), /empty/);
  assert.throws(() => parseIdList('# only a comment\n'), /no ids|empty/i);
});

test('pointing it at the committed server audit says why that file cannot be a target list', () => {
  // It is the only committed JSON under data/ and it is the obvious wrong
  // reach. Its own `note` field says it holds no member identities.
  const audit = JSON.stringify({
    note: 'No message content and no member identities are in this file.',
    summary: { members: { human_members: 84 } },
    channels: [],
    roles: [],
  });
  assert.throws(() => parseIdList(audit, 'data/server-audit-2026-08-19.json'), /no member identities/);
});

// ---------------------------------------------------------------------------
// The cross-check
// ---------------------------------------------------------------------------

test('the committed audit is read for the envelope it can honestly give', () => {
  const ctx = readAuditContext(fileURLToPath(new URL('../data/server-audit-2026-08-19.json', import.meta.url)));
  assert.ok(ctx, 'data/server-audit-2026-08-19.json is committed and must stay readable');
  assert.equal(ctx.guildId, '326474832151838730');
  assert.equal(ctx.humanMembers, 84);
  assert.equal(ctx.stuckAtRulesScreening, 31);
});

test('a list bigger than the pending-at-the-gate count is flagged, because every raid account was pending', () => {
  const ctx = { collectedAt: '2026-08-19', guildId: 'g', humanMembers: 84, stuckAtRulesScreening: 31 };
  assert.deepEqual(crossCheck(ctx, 30), []);
  assert.deepEqual(crossCheck(ctx, 31), []);
  assert.match(crossCheck(ctx, 40)[0]!, /at least 9 of these are not explained/);
  assert.match(crossCheck(ctx, 200)[0]!, /cannot be right/);
});

test('a target guild that is not the audited guild is called out before anything happens', () => {
  const ctx = { collectedAt: '2026-08-19', guildId: '326474832151838730', humanMembers: 84, stuckAtRulesScreening: 31 };
  assert.deepEqual(crossCheck(ctx, 10, '326474832151838730'), []);
  assert.match(crossCheck(ctx, 10, '999999999999999999')[0]!, /not the guild this audit describes/);
});
