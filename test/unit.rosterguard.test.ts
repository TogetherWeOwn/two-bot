/**
 * Roster CLI config guard (TOG-9792).
 *
 * `scripts/roster.ts` scoped its member query to `WHERE guild_id = ?` with an
 * empty string when DISCORD_GUILD_ID was unset, then exited 0 with the
 * empty-state backfill hint - actively misleading when the data exists and the
 * query just scoped to a guild that can never match. The script must exit 1
 * naming the variable instead, the same guard `scripts/reengagement.ts` uses.
 *
 * No database, no token, no network: TWO_DATABASE_URL is a dummy so the guild
 * guard is reached, and the script exits before opening the DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const SCRIPT = new URL('../scripts/roster.ts', import.meta.url).pathname;

async function cli(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run('node', [SCRIPT], { cwd: REPO, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('unset DISCORD_GUILD_ID exits 1 naming the variable, never the empty-state hint', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, TWO_DATABASE_URL: 'sqlite::memory:' };
  delete env.DISCORD_GUILD_ID;
  const out = await cli(env);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /DISCORD_GUILD_ID is not set/);
  assert.ok(
    !(out.stdout + out.stderr).includes('No joins recorded'),
    'a config error must not print the empty-state backfill hint',
  );
});
