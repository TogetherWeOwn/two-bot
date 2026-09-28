/**
 * TOG-6496: internal-actions hosts non-live acceptance with mock transport.
 *
 * The gap (scan 2026-09-27): scripts/internal-actions-host.ts,
 * scripts/internal-actions-host-real.ts and scripts/internal-actions-acceptance.ts
 * had zero test-file references. The acceptance harness only measures a running
 * deployment, so nothing proved the mock-transport host boots, serves the
 * TOG-3093 settings path, or that the real-transport host refuses without an
 * explicit flag.
 *
 * WHAT IT PROVES, against scratch Postgres only (no token, no live Discord,
 * no live guild writes):
 *   1. the mock host boots offline on --help (no env, no database, no network);
 *   2. the mock host boots for real against a scratch schema with the mock
 *      Discord transport, and a signed settings.get answers the documented
 *      shape { ok:true, result:{key,value:null,source:'unset'}, request_id };
 *      the boot line names discord:'mock' on loopback, never discord.com;
 *   3. the real-transport host refuses without --live (exit 2) BEFORE reading
 *      credentials or contacting Discord; --help stays flag-free;
 *   4. the acceptance harness refuses without credentials (exit 2) before any
 *      request.
 *
 * WHAT IT DOES NOT PROVE. A gateway login, the staging-token path, or the live
 * acceptance run (docs/STAGING.md, scripts/run-real-acceptance.sh): those need
 * a real guild and stay manual.
 *
 * Hermetic: child processes run with a scrubbed environment (PATH plus the
 * TWO_HOST_* variables each test sets) so no live credential can leak in; the
 * boot child never reads DISCORD_* at all. Prints `host-boot` /
 * `host-settings-get` lines a reviewer can see.
 *
 * Reviewer acceptance: delete the --live guard in
 * scripts/internal-actions-host-real.ts and the refusal test goes red (FATAL
 * TWO_HOST_DB instead of the --live refusal); delete the SettingsStore wiring
 * in scripts/internal-actions-host.ts and the boot test answers 403
 * action_not_allowed instead of 200.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from '../src/internal/signing.ts';

// NOTE: ./helpers/testDb.ts throws at module scope without TWO_TEST_DATABASE_URL,
// so it is imported lazily inside the boot test only. The four hermetic tests
// above must run with no database at all.

const run = promisify(execFile);
const ROOT = resolve(fileURLToPath(import.meta.url), '..');
const MOCK_HOST = resolve(ROOT, '../scripts/internal-actions-host.ts');
const REAL_HOST = resolve(ROOT, '../scripts/internal-actions-host-real.ts');
const ACCEPTANCE = resolve(ROOT, '../scripts/internal-actions-acceptance.ts');

const KEY_ID = 'web-staging';
const KEY = 'TWO_RAID_JOIN_THRESHOLD'; // hot, catalogued: the guard lets it through

/** No credential may reach a child: PATH plus the variables each test sets. */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    assert.ok(
      !/TOKEN|SECRET|KEY|DATABASE|DISCORD|STAGING|E2E|PASSWORD/i.test(`${k}=${env[k]}`),
      `scrubbed env leaked a credential-looking variable: ${k}`,
    );
  }
  return { ...env, ...extra };
}

async function cli(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [script, ...args], { cwd: ROOT, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the mock host boots offline on --help', async () => {
  const out = await cli(MOCK_HOST, ['--help'], scrubbedEnv());
  assert.equal(out.code, 0, `--help must boot with no credential; stderr: ${out.stderr}`);
  assert.match(out.stdout, /usage:.*internal-actions-host\.ts/);
});

test('the real host refuses without --live before credentials or network', async () => {
  const out = await cli(REAL_HOST, [], scrubbedEnv());
  assert.equal(out.code, 2, `refusal must be exit 2; got ${out.code}: ${out.stdout}${out.stderr}`);
  assert.match(out.stdout + out.stderr, /--live/, 'the refusal must name the flag');
  // The guard runs before any env() read: with required variables missing a
  // later check would report FATAL TWO_HOST_DB instead.
  assert.ok(!/FATAL/.test(out.stdout + out.stderr), 'refused for the missing flag, not for a credential');
  assert.ok(!/acceptance_host_ready/.test(out.stdout), 'nothing booted');
});

test('the real host --help stays flag-free', async () => {
  const out = await cli(REAL_HOST, ['--help'], scrubbedEnv());
  assert.equal(out.code, 0, `--help needs no flag and no credential; stderr: ${out.stderr}`);
  assert.match(out.stdout, /--live/);
});

test('the acceptance harness refuses without credentials before any request', async () => {
  const out = await cli(ACCEPTANCE, [], scrubbedEnv());
  assert.equal(out.code, 2, `misconfigured run must be exit 2; got ${out.code}: ${out.stdout}${out.stderr}`);
  assert.match(out.stdout + out.stderr, /TWO_ACCEPT_KEY_ID/, 'the refusal must name the missing credential');
});

interface HostReady {
  msg: string;
  url: string;
  schema: string;
  channelKey: string;
  keyId: string;
  discord: string;
}

test('the mock host boots on mock transport; signed settings.get answers the documented shape', { timeout: 120_000 }, async (t) => {
  const { openTestDb, TEST_PG_URL } = await import('./helpers/testDb.ts');
  const harness = await openTestDb(import.meta.filename);
  t.after(() => harness.cleanup());
  const secret = randomBytes(24).toString('hex');
  const child: ChildProcess = spawn(process.execPath, [MOCK_HOST], {
    cwd: ROOT,
    env: scrubbedEnv({
      TWO_HOST_DB: TEST_PG_URL,
      TWO_HOST_SCHEMA: harness.schema,
      TWO_HOST_SECRET: secret,
      TWO_HOST_PORT: '0',
    }),
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  let transcript = '';
  const ready = await new Promise<HostReady>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mock host never became ready: ${transcript.slice(-2000)}`)),
      60_000,
    );
    child.stdout?.on('data', (c) => {
      transcript += String(c);
      for (const line of String(c).split('\n')) {
        try {
          const parsed = JSON.parse(line) as HostReady;
          if (parsed?.msg === 'acceptance_host_ready') {
            clearTimeout(timer);
            resolvePromise(parsed);
          }
        } catch {
          /* log lines are not the boot line */
        }
      }
    });
    child.stderr?.on('data', (c) => {
      transcript += String(c);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock host exited ${code} before ready: ${transcript.slice(-2000)}`));
    });
  });

  console.log(`host-boot url=${ready.url} schema=${ready.schema} discord=${ready.discord}`);
  assert.equal(ready.discord, 'mock', 'the mock host must serve the mock transport');
  assert.ok(ready.url.startsWith('http://127.0.0.1:'), `loopback only, got ${ready.url}`);
  assert.ok(!transcript.includes('discord.com'), 'no live Discord host touched');
  assert.equal(ready.schema, harness.schema, 'the host isolated its tables in the scratch schema');

  // One safe read action: settings.get is naturally idempotent, needs no
  // idempotency key, and never reaches Discord -- the TOG-3093 path with no
  // host-proof until this file.
  const body = { action: 'settings.get', key: KEY };
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(ready.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-two-key-id': KEY_ID,
      'x-two-timestamp': timestamp,
      'x-two-nonce': nonce,
      'x-two-signature': sign(secret, timestamp, nonce, raw),
    },
    body: raw,
  });
  const answered = (await res.json()) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string };
    request_id: string;
  };
  console.log(`host-settings-get status=${res.status} ok=${answered.ok} result=${JSON.stringify(answered.result)}`);
  assert.equal(res.status, 200, `settings.get must serve, not refuse: ${JSON.stringify(answered)}`);
  assert.equal(answered.ok, true);
  assert.deepEqual(answered.result, { key: KEY, value: null, source: 'unset' });
  assert.match(answered.request_id, /^[0-9A-Z]{26}$/, 'every response carries the join-key request id');
});
