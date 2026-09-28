/**
 * Shutdown-preflight drain-advice gap coverage (TOG-9146).
 *
 * The e2e suite (`e2e.moderation-shutdown`) proves the gate against a real
 * database: refusal, drain-to-clear through the release paths, override,
 * finished-vs-outstanding states, the enabled short-circuit and the boot
 * wiring. What it never pins is the *drain advice itself* across backlog
 * sizes — the operator-facing text that tells a 3am operator what to drain:
 *
 *   - 0 outstanding: the `clear` verdict, its message and its log line;
 *   - 1 outstanding: the singular refusal names the one member/channel and
 *     carries the three drain bullets, with no plural summary lines;
 *   - many outstanding: the 20-name cap with the "... and N more" remainder
 *     and the exact total in the header.
 *
 * Runs without Postgres or a token:
 *   env -u TWO_TEST_DATABASE_URL node --test test/unit.shutdown-preflight-gaps.test.ts
 *
 * Offline by construction: a stub store (the four reads behind
 * `readOutstandingModerationState`) plus one no-database spawn of the
 * operator script. Nothing here opens a socket or needs Postgres.
 *
 * Relation to TOG-8459: that card owns the exactly-500 `truncated`
 * misreport (the `>= OUTSTANDING_ID_LIMIT` predicate in
 * `readOutstandingModerationState`). Every list in this file stays far
 * below the boundary — pinned structurally by the last test — so this
 * suite can never overlap it.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  MODERATION_DISABLE_OVERRIDE_ENV,
  OUTSTANDING_ID_LIMIT,
  enforceModerationShutdownPreflight,
  evaluateModerationShutdown,
  ModerationShutdownRefusal,
} from '../src/moderation/shutdownPreflight.ts';
import type { OutstandingLockdown, OutstandingUnban } from '../src/moderation/store.ts';

before(() => {
  // Pin the hermetic guarantee: this suite must stay green with no database.
  delete process.env.TWO_TEST_DATABASE_URL;
});

const ROOT = join(import.meta.dirname, '..');
const PREFLIGHT_SCRIPT = join(ROOT, 'scripts', 'moderation-disable-preflight.ts');

const GUILD = '1545644954272137297';
const MANY_UNBANS = 25;
const MANY_LOCKDOWNS = 3;

function unban(i: number): OutstandingUnban {
  return {
    requestId: `req-${i}`,
    guildId: GUILD,
    userId: `9000000000000001${String(i).padStart(2, '0')}`,
    state: 'pending',
    executeAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    reason: 'tempban for raid spam',
  };
}

function lockdown(i: number): OutstandingLockdown {
  return {
    channelId: `9000000000000021${String(i).padStart(2, '0')}`,
    guildId: GUILD,
    reason: 'raid containment',
    lockedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  };
}

type PreflightStore = Parameters<typeof evaluateModerationShutdown>[0]['store'];

function stubStore(
  unbans: OutstandingUnban[],
  unbanCount: number,
  lockdowns: OutstandingLockdown[],
  lockdownCount: number,
): PreflightStore {
  return {
    countOutstandingUnbans: async () => unbanCount,
    listOutstandingUnbans: async () => unbans,
    countActiveLockdowns: async () => lockdownCount,
    listActiveLockdowns: async () => lockdowns,
  };
}

/** Captures what the preflight logged, so the verdict lines can be asserted. */
function recorder() {
  const lines: Array<{ level: 'info' | 'error'; msg: string; fields: Record<string, unknown> }> = [];
  return {
    lines,
    log: {
      info: (msg: string, fields?: Record<string, unknown>) => {
        lines.push({ level: 'info', msg, fields: fields ?? {} });
      },
      error: (msg: string, fields?: Record<string, unknown>) => {
        lines.push({ level: 'error', msg, fields: fields ?? {} });
      },
    },
  };
}

// --- 0 outstanding: the clear verdict ----------------------------------------

test('zero outstanding clears with a message that says nothing is owed', async () => {
  const verdict = await evaluateModerationShutdown({
    enabled: false,
    store: stubStore([], 0, [], 0),
    env: {},
  });

  assert.equal(verdict.decision, 'clear');
  assert.equal(verdict.outstanding?.total, 0);
  assert.match(verdict.message, /nothing is outstanding/);
  assert.match(verdict.message, /no pending unbans, no active lockdowns/);
});

test('the clear verdict logs preflight_clear with zero fields, never a refusal', async () => {
  const { log, lines } = recorder();
  const verdict = await enforceModerationShutdownPreflight({
    enabled: false,
    store: stubStore([], 0, [], 0),
    env: {},
    log,
  });

  assert.equal(verdict.decision, 'clear');
  const clear = lines.find((l) => l.msg === 'moderation_disable_preflight_clear');
  assert.ok(clear, 'the clear path must log its own line');
  assert.equal(clear.level, 'info');
  assert.deepEqual(
    { pendingUnbans: clear.fields.pendingUnbans, activeLockdowns: clear.fields.activeLockdowns },
    { pendingUnbans: 0, activeLockdowns: 0 },
  );
  assert.ok(!lines.some((l) => l.msg === 'moderation_disable_refused'));
});

// --- 1 outstanding: the singular refusal -------------------------------------

test('one pending unban refuses and names exactly that member', async () => {
  const solo = unban(7);
  const verdict = await evaluateModerationShutdown({
    enabled: false,
    store: stubStore([solo], 1, [], 0),
    env: {},
  });

  assert.equal(verdict.decision, 'refused');
  assert.equal(verdict.outstanding?.total, 1);
  assert.match(verdict.message, /owes 1 release\(s\)/);
  assert.match(verdict.message, /1 pending unban/);
  assert.ok(verdict.message.includes(solo.userId), 'the message must name the member');
  assert.ok(verdict.message.includes(GUILD), 'the message must name the guild');
  assert.ok(verdict.message.includes(solo.requestId), 'the message must name the job');
  assert.doesNotMatch(verdict.message, /active lockdown/, 'no lockdown section for a lone unban');
  assert.doesNotMatch(verdict.message, /and \d+ more/, 'a single item needs no remainder line');
});

test('one active lockdown refuses and names exactly that channel', async () => {
  const lock = lockdown(0);
  const verdict = await evaluateModerationShutdown({
    enabled: false,
    store: stubStore([], 0, [lock], 1),
    env: {},
  });

  assert.equal(verdict.decision, 'refused');
  assert.equal(verdict.outstanding?.total, 1);
  assert.match(verdict.message, /owes 1 release\(s\)/);
  assert.match(verdict.message, /1 active lockdown/);
  assert.ok(verdict.message.includes(lock.channelId), 'the message must name the channel');
  assert.doesNotMatch(verdict.message, /pending unban/, 'no unban section for a lone lockdown');
  assert.doesNotMatch(verdict.message, /and \d+ more/, 'a single item needs no remainder line');
});

// --- the drain advice itself ---------------------------------------------------

test('the refusal carries all three drain options', async () => {
  const verdict = await evaluateModerationShutdown({
    enabled: false,
    store: stubStore([unban(1)], 1, [], 0),
    env: {},
  });

  // The three bullets the operator acts on: wait for the drain, do it by
  // hand, or override. If any one goes missing the refusal names the
  // backlog but leaves the operator guessing how to clear it.
  assert.match(verdict.message, /Do one of these:/);
  assert.match(
    verdict.message,
    /let the unban poller and \/unlock drain the backlog/,
    'must point at the automatic drain (poller for unbans, /unlock for lockdowns)',
  );
  assert.match(
    verdict.message,
    /release the members and channels named above by hand/,
    'must name the manual release path',
  );
  assert.ok(
    verdict.message.includes(`${MODERATION_DISABLE_OVERRIDE_ENV}=1`),
    'must name the override env var',
  );
  assert.match(verdict.message, /moderation_disable_stranded/, 'must name the stranded-set log record');
});

// --- many outstanding: the capped, exact advice --------------------------------

test('many outstanding names the first twenty and summarises the rest exactly', async () => {
  const unbans = Array.from({ length: MANY_UNBANS }, (_, i) => unban(i));
  const locks = Array.from({ length: MANY_LOCKDOWNS }, (_, i) => lockdown(i));
  const verdict = await evaluateModerationShutdown({
    enabled: false,
    store: stubStore(unbans, MANY_UNBANS, locks, MANY_LOCKDOWNS),
    env: {},
  });

  assert.equal(verdict.decision, 'refused');
  assert.equal(verdict.outstanding?.total, MANY_UNBANS + MANY_LOCKDOWNS);
  assert.match(verdict.message, new RegExp(`owes ${MANY_UNBANS + MANY_LOCKDOWNS} release\\(s\\)`));
  assert.match(verdict.message, new RegExp(`${MANY_UNBANS} pending unban`));
  assert.match(verdict.message, new RegExp(`${MANY_LOCKDOWNS} active lockdown`));

  // The human-readable list caps at twenty names; the remainder is exact,
  // derived from the COUNT(*) rather than the capped list.
  for (let i = 0; i < 20; i++) assert.ok(verdict.message.includes(`req-${i}`), `req-${i} must be named`);
  for (let i = 20; i < MANY_UNBANS; i++) {
    assert.ok(!verdict.message.includes(`req-${i}`), `req-${i} must be summarised, not named`);
  }
  assert.match(verdict.message, new RegExp(`\\.\\.\\. and ${MANY_UNBANS - 20} more`));

  // Three lockdowns fit under the cap, so every channel is named.
  for (const lock of locks) assert.ok(verdict.message.includes(lock.channelId));
});

test('the many-case refusal throws and logs the stranded set', async () => {
  const unbans = Array.from({ length: MANY_UNBANS }, (_, i) => unban(i));
  const locks = Array.from({ length: MANY_LOCKDOWNS }, (_, i) => lockdown(i));
  const { log, lines } = recorder();

  const error = await enforceModerationShutdownPreflight({
    enabled: false,
    store: stubStore(unbans, MANY_UNBANS, locks, MANY_LOCKDOWNS),
    env: {},
    log,
  }).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(error instanceof ModerationShutdownRefusal, `expected a refusal, got ${String(error)}`);
  assert.equal(error.outstanding.total, MANY_UNBANS + MANY_LOCKDOWNS);
  const refused = lines.find((l) => l.msg === 'moderation_disable_refused');
  assert.ok(refused, 'the refusal must be logged, not only thrown');
  assert.equal(refused.level, 'error');
  assert.equal(refused.fields.pendingUnbans, MANY_UNBANS);
  assert.equal(refused.fields.activeLockdowns, MANY_LOCKDOWNS);
  assert.equal((refused.fields.strandedUnbans as unknown[]).length, MANY_UNBANS);
  assert.equal((refused.fields.strandedLockdowns as unknown[]).length, MANY_LOCKDOWNS);
});

// --- non-duplication pin: TOG-8459 owns the =500 boundary ----------------------

test('every list in this suite stays below the truncation boundary', () => {
  // TOG-8459 owns the exactly-OUTSTANDING_ID_LIMIT `truncated` misreport.
  // This suite pins the drain-advice paths only; if a list here ever
  // reaches the cap, this fails and the new case belongs on TOG-8459.
  for (const n of [0, 1, MANY_UNBANS, MANY_LOCKDOWNS]) {
    assert.ok(n < OUTSTANDING_ID_LIMIT, `list size ${n} must stay below the ${OUTSTANDING_ID_LIMIT} cap`);
  }
});

// --- the operator script's advice surface ---------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runPreflight(env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PREFLIGHT_SCRIPT],
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

test('the disable-preflight script without a database exits 2, never 0', async () => {
  // "Could not tell" must never read as "clear": exit 2 is the script's
  // drain-advice equivalent of refusing to answer.
  const r = await runPreflight({ TWO_DATABASE_URL: undefined });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /TWO_DATABASE_URL/);
});
