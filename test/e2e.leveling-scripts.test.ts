import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openTestDb } from './helpers/testDb.ts';
import { LIVE_GUILD_ID } from '../src/staging/spec.ts';

const run = promisify(execFile);
const REPO = new URL('..', import.meta.url).pathname;
const IMPORT_SCRIPT = new URL('../scripts/levels-import-mee6.ts', import.meta.url).pathname;
const REWARDS_SCRIPT = new URL('../scripts/levels-role-rewards.ts', import.meta.url).pathname;
const STAGING_GUILD_ID = '1545644954272137297';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-leveling-scripts-'));
  dirs.push(dir);
  const exportPath = join(dir, 'mee6.json');
  writeFileSync(exportPath, JSON.stringify([{ id: '100000000000000001', xp: 100 }]));
  return { exportPath };
}

async function runScript(script: string, args: string[], dbEnv: Record<string, string>) {
  try {
    const result = await run('node', [script, ...args], {
      cwd: REPO,
      env: { ...process.env, ...dbEnv },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('leveling operator scripts default-deny the live guild before opening the database', async () => {
  const { exportPath } = fixture();
  const unreachableDb = { TWO_DATABASE_URL: 'postgres://127.0.0.1:1/must-not-connect' };
  const imported = await runScript(
    IMPORT_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--file', exportPath],
    unreachableDb,
  );
  const rewards = await runScript(
    REWARDS_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--set', '5:400000000000000005'],
    unreachableDb,
  );

  assert.equal(imported.code, 2, imported.output);
  assert.equal(rewards.code, 2, rewards.output);
  assert.match(imported.output, /Refusing live guild/);
  assert.match(rewards.output, /Refusing live guild/);
  assert.doesNotMatch(imported.output + rewards.output, /ECONNREFUSED|database/i);
});

test('the explicit live rollout override works only when supplied', async (t) => {
  const { exportPath } = fixture();
  const harness = await openTestDb(`${import.meta.filename}_override`);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  const dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };
  const imported = await runScript(
    IMPORT_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--file', exportPath, '--allow-live-guild', '--apply'],
    dbEnv,
  );
  const rewards = await runScript(
    REWARDS_SCRIPT,
    [
      '--guild',
      LIVE_GUILD_ID,
      '--set',
      '5:400000000000000005',
      '--allow-live-guild',
    ],
    dbEnv,
  );

  assert.equal(imported.code, 0, imported.output);
  assert.equal(rewards.code, 0, rewards.output);
  assert.equal(
    Number((await harness.db.prepare(`SELECT xp FROM member_levels WHERE guild_id = ?`).get<{ xp: number }>(LIVE_GUILD_ID))?.xp),
    100,
  );
  assert.equal(
    Number((await harness.db.prepare(`SELECT level FROM level_role_rewards WHERE guild_id = ?`).get<{ level: number }>(LIVE_GUILD_ID))?.level),
    5,
  );
});

test('staging remains accepted without the live rollout override', async (t) => {
  const { exportPath } = fixture();
  const harness = await openTestDb(`${import.meta.filename}_staging`);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  const result = await runScript(
    IMPORT_SCRIPT,
    ['--guild', STAGING_GUILD_ID, '--file', exportPath, '--apply'],
    {
      TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
      PGOPTIONS: `-c search_path=${schema}`,
    },
  );

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /"inserted": 1/);
});

test('an unknown subcommand word is a usage error, never an import (TOG-9912)', async () => {
  const { exportPath } = fixture();
  // Unreachable on purpose: the unknown word must fail before the guild is
  // parsed and before the database opens, so a typo of `inventory` plus
  // `--apply` can never become a write.
  const unreachableDb = { TWO_DATABASE_URL: 'postgres://127.0.0.1:1/must-not-connect' };
  const variants = [
    ['inventroy', '--guild', STAGING_GUILD_ID, '--file', exportPath, '--apply'],
    ['--guild', STAGING_GUILD_ID, '--file', exportPath, '--apply', 'inventroy'],
    ['--guild', STAGING_GUILD_ID, '--file', exportPath, 'import', 'inventroy', '--apply'],
    ['import', '--guild', STAGING_GUILD_ID, '--file', exportPath, '--apply', 'extra'],
  ];
  for (const args of variants) {
    const result = await runScript(IMPORT_SCRIPT, args, unreachableDb);
    assert.equal(result.code, 2, `args [${args.join(' ')}]: ${result.output}`);
    assert.match(result.output, /Unknown subcommand "inventroy"|Unknown subcommand "extra"/);
    assert.doesNotMatch(result.output, /ECONNREFUSED|database/i);
  }
});

test('a typo of a write-intent flag, a bad pool size and a bad guild are usage errors, never a silent dry run (TOG-9913)', async () => {
  const { exportPath } = fixture();
  // Unreachable on purpose: every case must fail before the database opens.
  // A typo'd --apply that fell through to the import would exit 0 with a
  // dry-run manifest while the operator believes the write happened.
  const unreachableDb = { TWO_DATABASE_URL: 'postgres://127.0.0.1:1/must-not-connect' };
  const cases: Array<{ args: string[]; env?: Record<string, string>; match: RegExp }> = [
    {
      args: ['--guild', STAGING_GUILD_ID, '--file', exportPath, '--aply'],
      match: /Unknown flag "--aply"/,
    },
    {
      args: ['--guild', STAGING_GUILD_ID, '--file', exportPath, '--apply', '--allow-lowerx'],
      match: /Unknown flag "--allow-lowerx"/,
    },
    {
      args: ['--guild', 'not-a-snowflake', '--file', exportPath],
      match: /--guild must be a Discord snowflake/,
    },
    {
      args: ['--guild', STAGING_GUILD_ID, '--file', exportPath],
      env: { TWO_DB_POOL_MAX: 'abc' },
      match: /TWO_DB_POOL_MAX must be a positive integer/,
    },
  ];
  for (const { args, env, match } of cases) {
    const result = await runScript(IMPORT_SCRIPT, args, { ...unreachableDb, ...env });
    assert.equal(result.code, 2, `args [${args.join(' ')}]: ${result.output}`);
    assert.match(result.output, match);
    assert.match(result.output, /Usage:/);
    // No manifest (silent success), no connection attempt, no stack trace.
    assert.doesNotMatch(result.output, /"mode"|ECONNREFUSED|^\s+at\s/m);
  }
});

test('the import writes nothing without --apply, and inventory reads the live guild', async (t) => {
  const { exportPath } = fixture();
  const harness = await openTestDb(`${import.meta.filename}_dryrun`);
  t.after(() => harness.cleanup());
  const schema = (await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>())!.s;
  const dbEnv = {
    TWO_DATABASE_URL: process.env.TWO_TEST_DATABASE_URL!,
    PGOPTIONS: `-c search_path=${schema}`,
  };

  const dry = await runScript(
    IMPORT_SCRIPT,
    ['--guild', STAGING_GUILD_ID, '--file', exportPath],
    dbEnv,
  );
  assert.equal(dry.code, 0, dry.output);
  const manifest = JSON.parse(dry.output.slice(dry.output.indexOf('{')));
  assert.equal(manifest.mode, 'dry-run');
  assert.equal(manifest.rowsWritten, 1);
  assert.equal(manifest.totalXpAfterProjected, 100);
  assert.equal(manifest.totalXpAfterMeasured, null);
  assert.equal(
    Number(
      (await harness.db.prepare(`SELECT COUNT(*) AS c FROM member_levels`).get<{ c: number }>())?.c,
    ),
    0,
    'dry run must not write',
  );

  // Read-only inventory is exempt from the live fence: taking stock of live
  // member_levels before an import is what it exists for.
  const live = await runScript(IMPORT_SCRIPT, ['inventory', '--guild', LIVE_GUILD_ID], dbEnv);
  assert.equal(live.code, 0, live.output);
  assert.match(live.output, /"memberRows": 0/);
});
