/**
 * TOG-6472 batch 1: every newly registered moderation/live-cleanup/raid/role/
 * audit/backfill/dedupe npm entry boots offline on `--help`.
 *
 * WHY THIS EXISTS. A 2026-09-27 scan found ~30 scripts/*.ts with no npm entry.
 * Batch 1 registers the 13 operator scripts (moderation, live-cleanup, raid,
 * role, audit, backfill/dedupe). The fix registers them in package.json, but a
 * registry entry nobody has watched boot is not a registry entry: a typo in
 * the target, a top-level `env()` that exits before the help flag is read, or
 * a script that touches the DB before reading argv would all sit green until a
 * reviewer tripped over them. These cases spawn each entry with a scrubbed
 * environment (no Discord token, no database URL, no secrets of any kind) and
 * require exit 0 plus a usage line naming the script.
 *
 * Hermetic: child `node` processes only, each killed after 30s. No DB, no
 * Discord, no network. The scrubbed env proves `--help` needs no credential;
 * if a script ever reads one before checking argv, its case goes red here.
 *
 * Follows the batch-2 pattern in test/unit.scriptregistryhelp.test.ts
 * (TOG-6473); kept as a separate file so each batch owns its entry list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The 13 batch-1 entries this card registers. */
const ENTRIES = [
  'raid:list',
  'raid:remove',
  'roles:consolidation',
  'events:dedupe',
  'audit:report',
  'cleanup:audit-visibility',
  'cleanup:derive-pins',
  'cleanup:drift-diff',
  'cleanup:live',
  'cleanup:live-rollback',
  'guild:clean-slate',
  'guild:clean-slate-rollback',
  'channels:game-access',
] as const;

function readScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** First `scripts/<file>` path in a registry command. */
function extractTarget(command: string): string {
  const m = /\bnode\s+(?:--\S+(?:=\S+)?\s+)*?(scripts\/[^\s"'`]+)/.exec(command);
  assert.ok(m, `entry has no node scripts/<x> target: ${command}`);
  return m[1].replace(/[),;>&|]+$/, '');
}

/**
 * Enough environment for node to boot, nothing else. In particular no
 * DISCORD_*, TWO_*, DATABASE_*, TOKEN, SECRET or KEY variables survive, so a
 * script that touches credentials before reading argv fails its case.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
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
  return env;
}

test('batch-1 entries exist and target real files', () => {
  const scripts = readScripts();
  for (const name of ENTRIES) {
    const command = scripts[name];
    assert.ok(command, `package.json is missing the ${name} entry`);
    const target = extractTarget(command);
    assert.ok(existsSync(resolve(ROOT, target)), `${name} points at missing file ${target}`);
  }
});

test('each batch-1 entry prints usage on --help with no credentials', async (t) => {
  const scripts = readScripts();
  const env = scrubbedEnv();
  for (const name of ENTRIES) {
    await t.test(name, () => {
      const command = scripts[name];
      assert.ok(command, `package.json is missing the ${name} entry`);
      const tokens = command.split(/\s+/).filter((s) => s.length > 0);
      assert.ok(tokens[0] === 'node', `${name} must run under node, got: ${command}`);
      for (const token of tokens) {
        assert.ok(
          !/["'`$;|&<>\\]/.test(token),
          `${name} has shell syntax, refusing to split: ${command}`,
        );
      }
      const argv = [...tokens.slice(1)];
      if (!argv.includes('--help')) argv.push('--help');
      let stdout: string;
      try {
        stdout = execFileSync('node', argv, {
          cwd: ROOT,
          env,
          timeout: 30_000,
          encoding: 'utf8',
        });
      } catch (err) {
        const status = err instanceof Error && 'status' in err ? (err as { status: unknown }).status : '?';
        const stderr =
          err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
        assert.fail(`${name} --help exited ${String(status)} with scrubbed env. stderr: ${stderr.slice(0, 500)}`);
      }
      const target = extractTarget(command);
      const basename = target.split('/').pop() as string;
      assert.ok(
        /^usage:/im.test(stdout),
        `${name} --help printed no usage line. output: ${stdout.slice(0, 500)}`,
      );
      assert.ok(
        stdout.includes(basename),
        `${name} --help usage names no script file (expected ${basename}). output: ${stdout.slice(0, 500)}`,
      );
    });
  }
});
