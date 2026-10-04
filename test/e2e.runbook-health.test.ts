/**
 * End-to-end: the RUNBOOK "Is it alive?" section, executed (TOG-5689).
 *
 * unit.health.test.ts pins the handler's logic against fake probes and
 * e2e.health.test.ts pins that src/index.ts wires the real gateway and the
 * real database into those probes. Neither asserts what the runbook actually
 * tells the operator to look for: the `{"msg":"ready"}` line shape, the
 * health-before-ready ordering, and one-JSON-object-per-line logs. This runs
 * scripts/health-check.ts - the same entry point an operator runs - against
 * the mock-Discord harness and asserts its report is green.
 *
 * Needs Postgres like every other e2e file: TWO_TEST_DATABASE_URL, with the
 * bot landed in a private schema via PGOPTIONS (the e2e.health.test.ts shape).
 * The two host-only checks (systemctl, journalctl) are asserted SKIPPED with
 * their reasons, which is the acceptance on TOG-5689 for checks that cannot
 * run against the mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthCheck } from '../scripts/health-check.ts';
import { openTestDb, TEST_PG_URL } from './helpers/testDb.ts';

test('the runbook health check passes against the mock harness', { timeout: 180_000 }, async (t) => {
  const harness = await openTestDb(import.meta.filename);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;

  const report = await runHealthCheck({
    databaseUrl: TEST_PG_URL,
    extraEnv: { PGOPTIONS: `-c search_path=${schema}` },
  });

  const failures = report.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(
    failures,
    [],
    `health check reported failures:\n${failures.map((c) => `  ${c.id}: ${c.detail}`).join('\n')}`,
  );
  assert.equal(report.passed, true);
});

test('every documented runnable check ran and passed', { timeout: 180_000 }, async (t) => {
  const harness = await openTestDb(import.meta.filename);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;

  const report = await runHealthCheck({
    databaseUrl: TEST_PG_URL,
    extraEnv: { PGOPTIONS: `-c search_path=${schema}` },
  });

  // The RUNBOOK "Is it alive?" checks, by the ids scripts/health-check.ts
  // reports them under. If the runbook gains a check, this list must grow -
  // that is the conversation this test is for.
  const runnable = [
    'bot-process-stays-up',
    'liveness-200-ok',
    'gateway-ready',
    'ready-line',
    'health-before-ready',
    'readiness-200-ok',
    'logs-jsonl',
    'clean-sigterm-shutdown',
    'port-released',
  ];
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  for (const id of runnable) {
    // Include the check's detail (the boot-attempt history + exit tail on a
    // stays-up/liveness failure): run 36369915601's `check ... did not pass`
    // with no detail cost a whole CI round trip to interpret.
    const got = byId.get(id);
    assert.equal(got?.status, 'pass', `check ${id} did not pass: ${got?.detail ?? '(no such check)'}`);
  }
});

test('host-only checks are skipped with reasons, not silently dropped', { timeout: 180_000 }, async (t) => {
  const harness = await openTestDb(import.meta.filename);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;

  const report = await runHealthCheck({
    databaseUrl: TEST_PG_URL,
    extraEnv: { PGOPTIONS: `-c search_path=${schema}` },
  });

  const skips = report.checks.filter((c) => c.status === 'skip');
  const byId = new Map(skips.map((c) => [c.id, c.detail]));
  assert.ok(byId.has('systemctl-status'), 'systemctl must be listed as skipped');
  assert.ok(byId.has('journalctl-tail'), 'journalctl must be listed as skipped');
  for (const [id, detail] of byId) {
    assert.ok(detail.length > 0, `skip ${id} needs a reason`);
  }
  // Skips must not flip the verdict: they are documented gaps, not failures.
  assert.equal(report.passed, true);
});
