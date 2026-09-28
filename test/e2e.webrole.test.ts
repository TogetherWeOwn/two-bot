/**
 * TOG-6492 acceptance for scripts/provision-web-role.ts and
 * scripts/verify-web-role.ts, through the real CLIs.
 *
 * WHY THIS EXISTS. test/e2e.webcontract.test.ts already exercises
 * `provisionWebRole` / `runWebRoleChecks` as library calls, and CI's
 * run-postgres-job.sh already *runs* both scripts — but nothing executes the
 * two scripts themselves and asserts on what they did. A typo in a flag
 * default, a `console.log` that swallows the exit code, or a grant the script
 * forgot to issue would all stay green. These tests spawn the real scripts
 * against a scratch schema and assert: the grant list equals the contract
 * (every view SELECT-only, zero grants on the bot schema, read-only default),
 * `verify-web-role` exits 0, and a real over-grant makes it exit non-zero.
 *
 * Fixture (one scratch schema, never live/staging):
 *   migrations + applyWebContract -> 9 views in <schema>_web_v1
 *   provision CLI --role two_web_ro_cli_test
 *     -> CONNECT + USAGE + SELECT on exactly the 9 views, REVOKE ALL on the
 *        bot schema, default_transaction_read_only=on, CONNECTION LIMIT 20
 *   over-grant mutation -> USAGE on the bot schema + INSERT on guild_settings
 *     -> verify CLI must FAIL naming 'cannot write the config store'
 *
 * Reproduce by hand (reviewer path): point TWO_DATABASE_URL at a scratch DB
 * with PGOPTIONS="-c search_path=<schema>", run migrate + web:views, then
 * `TWO_WEB_RO_PASSWORD=x node scripts/provision-web-role.ts --role <r>
 * --bot-schema <schema> --web-schema <schema>_web_v1` and compare
 * `SELECT table_schema, table_name, privilege_type
 *    FROM information_schema.role_table_grants WHERE grantee = '<r>'`
 * against WEB_CONTRACT_VIEWS; then
 * `TWO_DATABASE_URL=... TWO_WEB_RO_PASSWORD=x
 *  node scripts/verify-web-role.ts --role <r> ...` and expect 0 failed.
 *
 * REVIEWER: to see the over-grant test fail, delete the
 * `REVOKE ALL ON ALL TABLES IN SCHEMA` statement in src/store/webRole.ts —
 * the grant-list test then reports the leaked bot-schema rows — or change a
 * `mustFailOnPrivilege` probe to `mustFail` and watch the config-store
 * mutation pass on the read-only default instead of failing on the grant.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { applyWebContract, WEB_CONTRACT_VIEWS } from '../src/store/webContract.ts';
import { dropWebRole } from '../src/store/webRole.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const PROVISION = new URL('../scripts/provision-web-role.ts', import.meta.url).pathname;
const VERIFY = new URL('../scripts/verify-web-role.ts', import.meta.url).pathname;

// Fixed name, scoped to this file's scratch schema: node --test runs each file
// once, so no parallel run can collide, and a leaked role from a crashed run
// is obviously test debris. provision-web-role is idempotent, and it REVOKEs
// the whole bot schema on every run, so a stale over-grant cannot survive a
// re-run either.
const ROLE = 'two_web_ro_cli_test';
const PASSWORD = 'cli-acceptance-throwaway-only-ci-ever-sees-it';

let harness: TestDb;
let admin: pg.Client;
let dbEnv: Record<string, string>;
let flags: string[];

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const applied = await applyWebContract(harness.db);
  assert.equal(applied.webSchema, harness.webSchema);

  admin = new pg.Client({ connectionString: TEST_PG_URL });
  await admin.connect();
  await admin.query(`SET search_path TO ${harness.schema}`);

  dbEnv = {
    TWO_DATABASE_URL: TEST_PG_URL,
    PGOPTIONS: `-c search_path=${harness.schema}`,
  };
  flags = [
    '--role', ROLE,
    '--bot-schema', harness.schema,
    '--web-schema', harness.webSchema,
  ];
});

after(async () => {
  // Guarded: if `before` failed halfway (no database, no CREATEROLE), the
  // cleanup must not throw a second error that masks the real one.
  if (typeof admin !== 'undefined' && admin) {
    try {
      await dropWebRole(admin, ROLE, [harness.webSchema]);
    } finally {
      await admin.end();
    }
  }
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

interface CliResult {
  code: number;
  output: string;
}

async function cli(script: string, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  try {
    const result = await run('node', [script, ...args], {
      cwd: REPO,
      env: { ...process.env, ...dbEnv, TWO_WEB_RO_PASSWORD: PASSWORD, ...extraEnv },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** The CLI needs CREATEROLE; say so loudly instead of passing quietly. */
async function requireCreateRole(ctx: { skip: (msg?: string) => void }): Promise<boolean> {
  const can = await admin.query<{ ok: boolean }>(
    `SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user`,
  );
  if (!can.rows[0]?.ok) {
    ctx.skip('test database user has neither CREATEROLE nor SUPERUSER');
    return false;
  }
  return true;
}

async function provision(): Promise<CliResult> {
  return cli(PROVISION, flags);
}

async function verify(): Promise<CliResult> {
  // Deliberately no TWO_WEB_RO_DATABASE_URL: this exercises the path the
  // reviewer uses, building the role URL out of TWO_DATABASE_URL plus the
  // password, and never printing either.
  return cli(VERIFY, flags);
}

test('provision-web-role grants exactly the contract views, and nothing else', async (ctx) => {
  if (!(await requireCreateRole(ctx))) return;

  const out = await provision();
  assert.equal(out.code, 0, `provision CLI failed:\n${out.output}`);
  assert.match(out.output, new RegExp(`reads\\s+${harness.webSchema}`));
  assert.match(out.output, new RegExp(`denied\\s+${harness.schema}`));

  // The grant list, read back from the catalogue: exactly one SELECT per
  // contract view, and not one privilege anywhere on the bot's own tables.
  const grants = await admin.query<{ table_schema: string; table_name: string; privilege_type: string }>(
    `SELECT table_schema, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = $1
      ORDER BY 1, 2, 3`,
    [ROLE],
  );
  const rows = grants.rows.map((r) => `${r.table_schema}.${r.table_name}:${r.privilege_type}`);
  assert.deepEqual(
    rows,
    [...WEB_CONTRACT_VIEWS].sort().map((v) => `${harness.webSchema}.${v}:SELECT`),
  );

  const role = await admin.query<{ connlimit: number; config: string[] | null }>(
    `SELECT rolconnlimit AS connlimit, rolconfig AS config FROM pg_roles WHERE rolname = $1`,
    [ROLE],
  );
  assert.equal(role.rows[0]?.connlimit, 20, 'the website role must stay connection-capped');
  assert.ok(
    (role.rows[0]?.config ?? []).some((c) => c === 'default_transaction_read_only=on'),
    `read-only default missing from rolconfig: ${JSON.stringify(role.rows[0]?.config)}`,
  );
});

test('provision-web-role is idempotent: a second run updates, still exact', async (ctx) => {
  if (!(await requireCreateRole(ctx))) return;

  const first = await provision();
  assert.equal(first.code, 0, `first provision failed:\n${first.output}`);
  const second = await provision();
  assert.equal(second.code, 0, `second provision failed:\n${second.output}`);
  assert.match(second.output, /\(updated\)/, 'the second run must report an update, not a create');

  const grants = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = $2 AND privilege_type = 'SELECT'`,
    [ROLE, harness.webSchema],
  );
  assert.equal(grants.rows[0]?.n, WEB_CONTRACT_VIEWS.length);
});

test('verify-web-role passes through the real CLI after a clean provision', async (ctx) => {
  if (!(await requireCreateRole(ctx))) return;

  const p = await provision();
  assert.equal(p.code, 0, `provision CLI failed:\n${p.output}`);

  const v = await verify();
  assert.equal(v.code, 0, `verify CLI failed:\n${v.output}`);
  const summary = /(\d+) passed, (\d+) failed/.exec(v.output);
  assert.ok(summary, `no pass/fail summary in verify output:\n${v.output}`);
  assert.equal(Number(summary[2]), 0, 'verify must report zero failures');
  assert.ok(
    Number(summary[1]) >= WEB_CONTRACT_VIEWS.length,
    `expected at least one check per view, got ${summary[1]} passed`,
  );
});

test('an over-granted INSERT on guild_settings fails verify through the real CLI', async (ctx) => {
  // The mutation for the checks above. A real INSERT on the config store —
  // the table that decides how the bot behaves at the next poll — with the
  // read-only default left exactly as provisioned, which is the state a
  // careless GRANT would produce in production.
  if (!(await requireCreateRole(ctx))) return;

  const p = await provision();
  assert.equal(p.code, 0, `provision CLI failed:\n${p.output}`);

  // USAGE as well as INSERT: this file's bot schema grants USAGE to nobody,
  // so a table grant alone would be refused at the schema boundary and the
  // mutation would prove nothing about the table probe. Production's bot
  // schema is `public`, where USAGE is already granted.
  await admin.query(`GRANT USAGE ON SCHEMA ${harness.schema} TO ${ROLE}`);
  await admin.query(`GRANT INSERT ON ${harness.schema}.guild_settings TO ${ROLE}`);
  try {
    const v = await verify();
    assert.notEqual(v.code, 0, `verify CLI passed with a real INSERT grant:\n${v.output}`);
    assert.match(v.output, /FAIL\s+cannot write the config store/, 'the config-store probe must be the failure');
    assert.match(v.output, /[1-9]\d* failed/, 'the summary must count the failure');
  } finally {
    await admin.query(`REVOKE INSERT ON ${harness.schema}.guild_settings FROM ${ROLE}`);
    await admin.query(`REVOKE USAGE ON SCHEMA ${harness.schema} FROM ${ROLE}`);
  }
});
