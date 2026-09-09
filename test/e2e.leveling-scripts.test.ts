import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { openSqlite } from '../src/store/sqliteDriver.ts';
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
  const dbPath = join(dir, 'two.db');
  const exportPath = join(dir, 'mee6.json');
  writeFileSync(exportPath, JSON.stringify([{ id: '100000000000000001', xp: 100 }]));
  return { dbPath, exportPath };
}

async function runScript(script: string, args: string[], dbPath: string) {
  try {
    const result = await run('node', [script, ...args], {
      cwd: REPO,
      env: { ...process.env, TWO_DATABASE_URL: '', TWO_DB_PATH: dbPath },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('leveling operator scripts default-deny the live guild before opening the database', async () => {
  const { dbPath, exportPath } = fixture();
  const imported = await runScript(
    IMPORT_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--file', exportPath],
    dbPath,
  );
  const rewards = await runScript(
    REWARDS_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--set', '5:400000000000000005'],
    dbPath,
  );

  assert.equal(imported.code, 2, imported.output);
  assert.equal(rewards.code, 2, rewards.output);
  assert.match(imported.output, /Refusing live guild/);
  assert.match(rewards.output, /Refusing live guild/);
  assert.equal(existsSync(dbPath), false, 'refusal must happen before the database is opened');
});

test('the explicit live rollout override works only when supplied', async () => {
  const { dbPath, exportPath } = fixture();
  const imported = await runScript(
    IMPORT_SCRIPT,
    ['--guild', LIVE_GUILD_ID, '--file', exportPath, '--allow-live-guild'],
    dbPath,
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
    dbPath,
  );

  assert.equal(imported.code, 0, imported.output);
  assert.equal(rewards.code, 0, rewards.output);
  const db = await openSqlite(dbPath);
  assert.equal(
    Number((await db.prepare(`SELECT xp FROM member_levels WHERE guild_id = ?`).get<{ xp: number }>(LIVE_GUILD_ID))?.xp),
    100,
  );
  assert.equal(
    Number((await db.prepare(`SELECT level FROM level_role_rewards WHERE guild_id = ?`).get<{ level: number }>(LIVE_GUILD_ID))?.level),
    5,
  );
  await db.close();
});

test('staging remains accepted without the live rollout override', async () => {
  const { dbPath, exportPath } = fixture();
  const result = await runScript(
    IMPORT_SCRIPT,
    ['--guild', STAGING_GUILD_ID, '--file', exportPath],
    dbPath,
  );

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /"inserted": 1/);
});
