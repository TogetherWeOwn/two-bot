/**
 * TOG-8671: the two staging-automations-proof registry entries boot offline
 * on `--help`.
 *
 * WHY THIS EXISTS. scripts/staging-automations-proof.ts (366 lines) and
 * scripts/staging-automations-proof-state.ts (53) had no package.json entry,
 * no CI refs, and the proof script exited 2 without credentials before ever
 * reading argv. A registry entry nobody has watched boot is not a registry
 * entry. These cases spawn each entry with a scrubbed environment (no Discord
 * token, no database URL, no secrets of any kind) and require exit 0 plus a
 * usage line naming the script.
 *
 * Hermetic: child `node` processes only, each killed after 30s. No DB, no
 * Discord, no network. Fixtures/scratch only; no live guild writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The TOG-8671 entries this card registers. */
const ENTRIES = [
  'staging:automations-proof',
  'staging:automations-state',
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

test('automations-proof entries exist and target real files', () => {
  const scripts = readScripts();
  for (const name of ENTRIES) {
    const command = scripts[name];
    assert.ok(command, `package.json is missing the ${name} entry`);
    const target = extractTarget(command);
    assert.ok(existsSync(resolve(ROOT, target)), `${name} points at missing file ${target}`);
  }
});

test('each automations-proof entry prints usage on --help with no credentials', async (t) => {
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
