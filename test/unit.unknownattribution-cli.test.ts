/**
 * TOG-8293: the unknown-attribution CLI contract, hermetic.
 *
 * The unit test pins the arithmetic; this pins the script around it: the
 * seeded reviewer path prints a % figure with no database, flipping the
 * threshold flips the verdict AND the exit code, bad inputs exit 2, and the
 * live path without TWO_DATABASE_URL exits 1 with guidance. Every case runs
 * the real `scripts/unknown-attribution.ts` as a subprocess - a drift between
 * the documented commands and what the script accepts reds here.
 *
 * No database, no token, no network: `--seed` never opens one, and the live
 * cases assert the missing-URL guard before any connection is attempted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/unknown-attribution.ts', import.meta.url).pathname;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The child must not inherit a database URL: the seeded cases prove the
 *  reviewer path needs none, and the live case proves its absence exits 1. */
async function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.TWO_DATABASE_URL;
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('seeded demo prints a % figure and passes under the default tripwire', async () => {
  const out = await cli(['--seed']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /SEEDED DEMO/);
  assert.match(out.stdout, /TOTAL\s+10\s+4\s+40%/);
  assert.match(out.stdout, /Result: PASS - 40% unknown is within the 50% tripwire/);
});

test('flipping the threshold to 25 flags the same seeded data', async () => {
  const out = await cli(['--seed', '--max-unknown=25']);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /Result: FAIL - 40% unknown exceeds the 25% tripwire/);
});

test('the threshold also flips via TWO_UNKNOWN_THRESHOLD', async () => {
  const out = await cli(['--seed'], { TWO_UNKNOWN_THRESHOLD: '25' });
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /unknown share <= 25%/);
});

test('a bad threshold exits 2, never a verdict on a made-up tripwire', async () => {
  for (const bad of ['bogus', '101', '-1']) {
    const out = await cli(['--seed', `--max-unknown=${bad}`]);
    assert.equal(out.code, 2, `${bad}: ${out.stdout + out.stderr}`);
    assert.match(out.stdout + out.stderr, /Bad --max-unknown/);
  }
});

test('a bad week count exits 2', async () => {
  const out = await cli(['--seed', 'bogus']);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /Bad week count/);
});

test('the live path without TWO_DATABASE_URL exits 1 with guidance', async () => {
  const out = await cli([]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /TWO_DATABASE_URL is not set/);
});
