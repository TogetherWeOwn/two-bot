/**
 * Funnel CLI contract (TOG-7838).
 *
 * `node scripts/funnel.ts abc` used to crash with an unhandled
 * `RangeError: Invalid time value` - `Number('abc')` is NaN, and NaN days
 * makes `new Date(...).toISOString()` throw. The guard below pins the
 * contract sibling scripts already keep (voice-reconcile's "Bad day count",
 * unknown-attribution's "Bad week count", attribution's "Bad window"): a bad
 * day count exits 2 with a usage line on stderr, before any database is
 * touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/funnel.ts', import.meta.url).pathname;

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

// Note: `-3` is deliberately absent - like the sibling scripts, an arg starting
// with `-` is treated as a flag, so it falls back to the default window.
for (const bad of ['abc', '0', '2.5']) {
  test(`a bad day count ("${bad}") exits 2 with a usage line, never a stack trace`, async () => {
    const out = await cli([bad]);
    assert.equal(out.code, 2, out.stdout + out.stderr);
    assert.match(out.stdout + out.stderr, /Bad day count/);
    assert.doesNotMatch(out.stdout + out.stderr, /RangeError/);
  });
}

test('a missing database still exits 1 with guidance on a valid window', async () => {
  const out = await cli([]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /TWO_DATABASE_URL is not set/);
});
