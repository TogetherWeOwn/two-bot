/**
 * Discover every scripts/* target in package.json, not a fixed batch list.
 * Run --help with no credentials and refuse network/subprocess I/O in Node.
 * Shell help runs in restricted Bash with an empty PATH, so only builtins
 * can run. Test/lifecycle wrappers are checked as scripts, not by executing
 * node --test or prepare's shell expression. Application/test-runner commands
 * without a scripts/* target are outside this operator-script catalog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const OFFLINE = pathToFileURL(join(ROOT, 'test/helpers/helpOffline.ts')).href;

interface Entry {
  name: string;
  runner: 'node' | 'bash';
  target: string;
  args: string[];
}

function catalog(scripts: Record<string, string>): Entry[] {
  const entries: Entry[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!command.includes('scripts/')) continue;
    const match = /^(node|bash)\s+(?:(--test)\s+)?(scripts\/[\w./-]+)(.*)$/.exec(command);
    assert.ok(match, `${name}: unsupported script command: ${command}`);
    assert.ok(!match[2] || match[1] === 'node', `${name}: --test is only a Node wrapper`);
    const target = match[3];
    assert.ok(!target.split('/').includes('..'), `${name}: target escapes the catalog`);
    let tail = match[4];
    // The prepare hook invokes install-hooks.sh with output suppression. Do
    // not evaluate shell expressions, even when the package.json is trusted.
    if (name === 'prepare') {
      assert.equal(tail.trim(), '>/dev/null 2>&1 || true', 'prepare wrapper changed; update the help test');
      tail = '';
    }
    const args = tail.trim() ? tail.trim().split(/\s+/) : [];
    assert.ok(args.every((arg) => !/["'`$;|&<>\\]/.test(arg)), `${name}: refusing shell syntax`);
    entries.push({ name, runner: match[1] as Entry['runner'], target, args });
  }
  return entries;
}

function checkHelp(entry: Entry, root = ROOT): void {
  assert.ok(existsSync(join(root, entry.target)), `${entry.name}: missing target ${entry.target}`);
  const args = [...entry.args];
  if (!args.includes('--help')) args.push('--help');
  const node = entry.runner === 'node';
  const result = spawnSync(node ? process.execPath : '/bin/bash',
    node ? ['--import', OFFLINE, entry.target, ...args] : ['--restricted', entry.target, ...args], {
      cwd: root,
      env: { PATH: '', LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
  const output = result.stdout ?? '';
  assert.equal(result.error, undefined, `${entry.name}: --help failed: ${result.error?.message}`);
  assert.equal(result.status, 0,
    `${entry.name}: --help exited ${result.status} (${result.signal ?? 'no signal'}): ${(result.stderr ?? '').slice(0, 500)}`);
  assert.match(output, /^usage:\s*\S[^\r\n]*$/im, `${entry.name}: --help printed no non-empty usage line`);
}

function fixture(body: string, check: (entry: Entry, root: string) => void, runner: Entry['runner'] = 'node'): void {
  const root = mkdtempSync(join(tmpdir(), 'two-help-'));
  const target = `scripts/fixture.${runner === 'node' ? 'mjs' : 'sh'}`;
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, target), body);
    check({ name: 'fixture:help', runner, target, args: [] }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('catalog discovery includes new targets, aliases, Bash and wrapper targets', () => {
  assert.deepEqual(catalog({
    start: 'node src/index.ts', test: 'node --test test/*.test.ts', typecheck: 'tsc --noEmit',
    added: 'node scripts/new.ts', alias: 'node scripts/new.ts inventory',
    shell: 'bash scripts/check.sh --selftest',
    wrapper: 'node --test scripts/selftest.mjs',
    prepare: 'bash scripts/install-hooks.sh >/dev/null 2>&1 || true',
  }), [
    { name: 'added', runner: 'node', target: 'scripts/new.ts', args: [] },
    { name: 'alias', runner: 'node', target: 'scripts/new.ts', args: ['inventory'] },
    { name: 'shell', runner: 'bash', target: 'scripts/check.sh', args: ['--selftest'] },
    { name: 'wrapper', runner: 'node', target: 'scripts/selftest.mjs', args: [] },
    { name: 'prepare', runner: 'bash', target: 'scripts/install-hooks.sh', args: [] },
  ]);
});

test('unsupported catalog commands fail by name instead of silently skipping targets', () => {
  assert.throws(() => catalog({ 'bad:command': 'node scripts/a.ts && node scripts/b.ts' }), /bad:command/);
  assert.throws(() => catalog({ 'bad:runner': 'sh scripts/check.sh' }), /bad:runner/);
});

test('help checker accepts a credential-free usage response', () => {
  fixture("console.log('Usage: node scripts/fixture.mjs [--help]');", checkHelp);
});

test('missing help fails by registry name', () => {
  fixture("console.log('nothing to see');", (entry, root) => {
    assert.throws(() => checkHelp(entry, root), /fixture:help: --help printed no non-empty usage line/);
  });
});

test('empty usage and nonzero exits fail by registry name', () => {
  fixture("console.log('Usage: ');", (entry, root) => {
    assert.throws(() => checkHelp(entry, root), /fixture:help: --help printed no non-empty usage line/);
  });
  fixture("console.log('Usage: fixture.mjs'); process.exit(2);", (entry, root) => {
    assert.throws(() => checkHelp(entry, root), /fixture:help: --help exited 2/);
  });
});

test('help network/subprocess attempts fail even when scripts catch the refusal', () => {
  for (const body of [
    "import net from 'node:net'; try { net.connect(443, 'example.invalid'); } catch {}",
    "try { await fetch('https://example.invalid'); } catch {}",
    "import { execSync } from 'node:child_process'; try { execSync('true'); } catch {}",
  ]) {
    fixture(`${body}; console.log('Usage: fixture.mjs');`, (entry, root) => {
      assert.throws(() => checkHelp(entry, root), /fixture:help: --help exited 97/);
    });
  }
});

test('Bash help uses only builtins and cannot invoke external clients', () => {
  fixture("printf '%s\\n' 'Usage: bash scripts/fixture.sh [--help]'", checkHelp, 'bash');
  fixture("/usr/bin/curl https://example.invalid", (entry, root) => {
    assert.throws(() => checkHelp(entry, root), /fixture:help: --help exited/);
  }, 'bash');
});

test('every catalog entry prints usage on --help offline', async (t) => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
  const entries = catalog(scripts);
  assert.ok(entries.length > 0, 'operator-script catalog must not be empty');
  for (const entry of entries) await t.test(`${entry.name} (${entry.target})`, () => checkHelp(entry));
});
