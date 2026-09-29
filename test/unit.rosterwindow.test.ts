/**
 * Roster CLI window guard (TOG-9791).
 *
 * `scripts/roster.ts` parsed the window with
 * `argv.find((a) => /^\d+$/.test(a)) ?? 7`, so any non-digit arg (`banana`,
 * `2.5`, `--help`) silently fell back to 7 days and exited 0 with a confident
 * report. The script must exit 2 naming the bad value (same guard as
 * `scripts/funnel.ts` and `scripts/voice-reconcile.ts` on origin/main), and
 * `--help` must print usage with exit 0.
 *
 * No database, no token, no network: every case below exits before `openDb`,
 * so TWO_DATABASE_URL is unset on purpose to prove the guard runs first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/roster.ts', import.meta.url).pathname;

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TWO_DATABASE_URL;
  delete env.DISCORD_GUILD_ID;
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help prints usage with exit 0 and needs no database', async () => {
  const out = await cli(['--help']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Usage:/);
  assert.match(out.stdout, /roster\.ts \[days\]/);
});

for (const bad of ['banana', '2.5', '0', '']) {
  test(`bad window ${JSON.stringify(bad)} exits 2 naming the value, never a 7-day report`, async () => {
    const out = await cli([bad]);
    assert.equal(out.code, 2, out.stdout + out.stderr);
    assert.match(out.stdout + out.stderr, /Bad day count/);
    assert.match(out.stdout + out.stderr, new RegExp(JSON.stringify(bad).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '""'));
  });
}

test('a valid window still reaches the database guard (exit 1, not 2)', async () => {
  const out = await cli(['30']);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /TWO_DATABASE_URL is not set/);
});
