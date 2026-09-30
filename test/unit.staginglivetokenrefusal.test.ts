/**
 * TOG-10009: every remaining staging proof script refuses a live-shaped token
 * and a non-test database host before opening any connection.
 *
 * WHY THIS EXISTS. scripts/staging-automations-proof.ts read the LIVE variable
 * name (TWO_DATABASE_URL) with no token identity check, so a staging run that
 * inherited the wrong shell could write proof rows to live. scripts/
 * staging-temp-voice-demo.ts guarded the DB host (TOG-9656) but accepted any
 * token, and scripts/staging-voice-occupant.ts checked neither. The restart/
 * rota pattern refuses both before any network or datastore effect; these
 * three scripts now do the same, and this file is the offline half of that
 * proof that CI runs.
 *
 * WHAT IT PROVES, by spawning each script as a child process with synthetic
 * live-shaped tokens (base64 of the application id, no secret anywhere):
 *   1. a live-shaped token is refused before any Discord or database
 *      connection, even when the database URL is also bad (token wins);
 *   2. a staging-shaped token with a non-test database host is refused by
 *      the test-db guard before any connection;
 *   3. --help still boots offline with a scrubbed environment (guards must
 *      not block usage).
 *
 * WHAT IT DOES NOT PROVE. The full login + Discord round trip is not
 * exercised: the synthetic tokens are inert fixture shapes, so a staging
 * token that passes the guard fails later at Discord authentication. That
 * ordering (guard passes, network rejects) is the point: refusal happens
 * before contact, never after.
 *
 * Hermetic: child `node` processes only, each killed after 30s. No token, no
 * database, no Discord, no network. Prints `refusal` lines a reviewer sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_ID,
} from '../src/staging/spec.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '..');
const AUTOMATIONS = resolve(ROOT, '../scripts/staging-automations-proof.ts');
const TEMP_VOICE = resolve(ROOT, '../scripts/staging-temp-voice-demo.ts');
const OCCUPANT = resolve(ROOT, '../scripts/staging-voice-occupant.ts');

// Shaped like a bot token so checkStagingToken identifies it; built at
// runtime so no token-shaped literal sits in the repo.
const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.fake.fake`;
const LIVE_TOKEN = tokenFor(LIVE_BOT_APPLICATION_ID);
const STAGING_TOKEN = tokenFor(STAGING_BOT_APPLICATION_ID);
const UNKNOWN_TOKEN = tokenFor('123456789012345678');
// A production-shaped host: never contacted, refused by the host guard.
const BAD_DB = 'postgres://u@db.internal:5432/two_bot_staging';
// Synthetic snowflake channel: valid argv, never a live channel.
const CHANNEL = '190000000000000001';

/**
 * Enough environment for node to boot, nothing else. In particular no
 * DISCORD_*, TWO_*, DATABASE_*, TOKEN, SECRET or KEY variables survive, so a
 * script that touches credentials before reading argv fails its case.
 */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extra };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    if (k in extra) continue;
    assert.ok(
      !/TOKEN|SECRET|KEY|DATABASE|DISCORD|STAGING|E2E|PASSWORD/i.test(`${k}=${env[k]}`),
      `scrubbed env leaked a credential-looking variable: ${k}`,
    );
  }
  return env;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [script, ...args], { cwd: ROOT, env, timeout: 30_000 }, (err, stdout, stderr) => {
      resolvePromise({
        code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

test('automations-proof refuses a live-shaped token before any connection', async () => {
  const result = await runScript(AUTOMATIONS, [], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN,
    TWO_TEST_DATABASE_URL: BAD_DB,
  }));
  console.log(`refusal automations-proof live-token exit=${result.code}`);
  assert.notEqual(result.code, 0, 'a live token must not boot the proof');
  assert.match(result.stderr, /LIVE bot/, 'refusal names the live bot');
  assert.match(result.stderr, /Nothing was contacted/, 'refusal happens before any connection');
});

test('automations-proof refuses an unknown token before any connection', async () => {
  const result = await runScript(AUTOMATIONS, [], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: UNKNOWN_TOKEN,
    TWO_TEST_DATABASE_URL: BAD_DB,
  }));
  console.log(`refusal automations-proof unknown-token exit=${result.code}`);
  assert.notEqual(result.code, 0, 'an unknown token must not boot the proof');
  assert.match(result.stderr, /Nothing was contacted/, 'refusal happens before any connection');
});

test('automations-proof refuses a non-test database host with a staging token', async () => {
  const result = await runScript(AUTOMATIONS, [], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: STAGING_TOKEN,
    TWO_TEST_DATABASE_URL: BAD_DB,
  }));
  console.log(`refusal automations-proof bad-db exit=${result.code}`);
  assert.notEqual(result.code, 0, 'a non-test database host must not boot the proof');
  assert.match(result.stderr, /not an isolated test database/, 'the host guard refuses first');
});

test('temp-voice-demo refuses a live-shaped token before any connection', async () => {
  const result = await runScript(TEMP_VOICE, ['create'], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN,
    TWO_TEST_DATABASE_URL: BAD_DB,
  }));
  console.log(`refusal temp-voice-demo live-token exit=${result.code}`);
  assert.notEqual(result.code, 0, 'a live token must not boot the demo');
  assert.match(result.stderr, /LIVE bot/, 'refusal names the live bot');
  assert.match(result.stderr, /Nothing was contacted/, 'refusal happens before any connection');
});

test('temp-voice-demo refuses a non-test database host with a staging token', async () => {
  const result = await runScript(TEMP_VOICE, ['create'], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: STAGING_TOKEN,
    TWO_TEST_DATABASE_URL: BAD_DB,
  }));
  console.log(`refusal temp-voice-demo bad-db exit=${result.code}`);
  assert.notEqual(result.code, 0, 'a non-test database host must not boot the demo');
  assert.match(result.stderr, /not an isolated test database/, 'the host guard refuses first');
});

test('voice-occupant refuses a live-shaped token before opening the gateway', async () => {
  const result = await runScript(OCCUPANT, [CHANNEL], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN,
  }));
  console.log(`refusal voice-occupant live-token exit=${result.code}`);
  assert.notEqual(result.code, 0, 'a live token must not open the gateway');
  assert.match(result.stderr, /LIVE bot/, 'refusal names the live bot');
  assert.match(result.stderr, /Nothing was contacted/, 'refusal happens before any connection');
});

test('voice-occupant refuses an unknown token before opening the gateway', async () => {
  const result = await runScript(OCCUPANT, [CHANNEL], scrubbedEnv({
    DISCORD_STAGING_BOT_TOKEN: UNKNOWN_TOKEN,
  }));
  console.log(`refusal voice-occupant unknown-token exit=${result.code}`);
  assert.notEqual(result.code, 0, 'an unknown token must not open the gateway');
  assert.match(result.stderr, /Nothing was contacted/, 'refusal happens before any connection');
});

test('all three scripts still boot offline on --help with no credentials', async () => {
  for (const [name, script, args] of [
    ['automations-proof', AUTOMATIONS, ['--help']],
    ['temp-voice-demo', TEMP_VOICE, ['--help']],
    ['voice-occupant', OCCUPANT, ['--help']],
  ] as const) {
    const result = await runScript(script, [...args], scrubbedEnv());
    console.log(`refusal ${name} --help exit=${result.code}`);
    assert.equal(result.code, 0, `${name} --help must boot with no credential; stderr: ${result.stderr}`);
    assert.match(result.stdout, /^usage:/im, `${name} --help prints a usage line`);
  }
});
