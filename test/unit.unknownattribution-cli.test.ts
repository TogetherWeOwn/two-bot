import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const scriptUrl = new URL('../scripts/unknown-attribution.ts', import.meta.url).href;
const dbUrl = new URL('../src/store/db.ts', import.meta.url).href;

function runReport(snapshotUpdatedAt: string | null): string {
  // Run the real CLI with only its database import replaced. No socket or
  // inherited database/Discord credential can reach this child process.
  // https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { TWO_DATABASE_URL: 'fixture-not-a-database' },
    input: `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-07T12:00:00.000Z') });
      process.argv = [process.execPath, 'unknown-attribution.ts', '2'];
      let closed = false;
      globalThis.fixtureDb = {
        prepare(sql) {
          if (sql.includes('invite_snapshots')) {
            return { get: async () => ({ t: ${JSON.stringify(snapshotUpdatedAt)} }) };
          }
          if (sql.includes('SELECT recorded_at AS at FROM events')) {
            return { all: async () => [] };
          }
          assert.match(sql, /SELECT occurred_at, source FROM events/);
          return { all: async () => [
            { occurred_at: '2026-09-03T10:00:00.000Z', source: 'unknown' },
            { occurred_at: '2026-09-02T10:00:00.000Z', source: 'backfill:log:member-join' },
          ] };
        },
        close: async () => { closed = true; },
      };
      const hooks = registerHooks({
        load(url, context, nextLoad) {
          if (url === ${JSON.stringify(dbUrl)}) {
            return {
              format: 'module', shortCircuit: true,
              source: [
                'export async function openDb(url) {',
                "if (url !== 'fixture-not-a-database') throw new Error('Unexpected database URL');",
                'return globalThis.fixtureDb; }',
              ].join(' '),
            };
          }
          return nextLoad(url, context);
        },
      });
      try {
        await import(${JSON.stringify(scriptUrl)});
        assert.equal(closed, true);
      } finally {
        hooks.deregister();
        mock.timers.reset();
      }
    `,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('refresh-only snapshot changes cannot relabel an unknown join as pre-tracking', () => {
  const before = runReport('2026-09-01T00:00:00.000Z');
  const after = runReport('2026-09-06T00:00:00.000Z');
  assert.equal(after, before);
  // joins unknown rate pre-track downtime unexplained
  assert.match(after, /TOTAL\s+2\s+2\s+100%\s+1\s+0\s+1/);
  assert.match(after, /1\s+pre-tracking/);
  assert.match(after, /1\s+unexplained/);
  assert.match(after, /first-capture boundary unavailable - only backfill sources are pre-tracking/);
  assert.doesNotMatch(after, /no capture run on file yet/);
});

test('missing snapshot rows keep the same conservative report and backfill classification', () => {
  assert.equal(runReport(null), runReport('2026-09-06T00:00:00.000Z'));
});
