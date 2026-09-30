import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const config = join(repo, '.gitleaks.toml');
const ignore = join(repo, '.gitleaksignore');
const history = [
  {commit: '8afbcc916a567b9a459efc77e41e2ac93feddb3d', lines: [525]},
  {commit: '407017d0481dc806c164121503a770c0d8391f2a', lines: [561, 627, 640]},
];
const fixturePath = 'ops/staging-deploy-broker/server.test.mjs';
const fingerprints = history.flatMap(({commit, lines}) => lines.map((line) => `${commit}:${fixturePath}:private-key:${line}`));
const scanner = process.env.GITLEAKS_BIN || 'gitleaks';

// Construct public, unusable marker blocks at runtime so this test's own source
// does not introduce another private-key finding into the repository history.
const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
const begin = `-----BEGIN ${label}-----`;
const end = `-----END ${label}-----`;
const short = 'const shortPem = `' + begin + '\\n${"X".repeat(100)}\\n' + end + '`;';
const long = 'const overlongPem = `' + begin + '\\n${"X".repeat(6000)}\\n' + end + '`;';
const synthetic = `${short}\n${long}\n`;
const fabricatedPem = `${begin}\nMIIE${'A1b2C3d4E5f6+/78'.repeat(8)}\n${end}\n`;

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function scan(cwd, logOpts, ignorePath = ignore) {
  const args = ['git', '.', '--config', config, '--redact', '--no-banner', '--exit-code', '1',
    '--report-format', 'json', '--report-path', '-', '--log-opts', logOpts];
  // null exercises the workflow's default .gitleaksignore discovery from the
  // repository working directory instead of supplying an explicit path.
  if (ignorePath !== null) args.push('--gitleaks-ignore-path', ignorePath);
  const result = spawnSync(scanner, args, {cwd, encoding: 'utf8', timeout: 30_000});
  assert.ok([0, 1].includes(result.status), `Scanner failed: ${result.error || result.stderr}`);
  return {status: result.status, findings: JSON.parse(result.stdout)};
}

function expectFindings(result, count) {
  assert.equal(result.status, count ? 1 : 0);
  assert.equal(result.findings.length, count);
  for (const finding of result.findings) assert.equal(finding.RuleID, 'private-key');
}

test('gitleaks exception clears only the inspected historical finding', async (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.RUNNER_TEMP || tmpdir();
  const root = mkdtempSync(join(scratch, 'gitleaks-regression-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const emptyIgnore = join(root, 'empty.ignore');
  writeFileSync(emptyIgnore, '');
  const entries = readFileSync(ignore, 'utf8').split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(entries, fingerprints);
  // Gitleaks always loads source/.gitleaksignore in addition to the explicit
  // ignore-path flag. A no-checkout shared clone isolates the control without
  // temporarily deleting the real ignore file or copying all Git objects.
  const historicalRepo = join(root, 'historical');
  git(root, 'clone', '--quiet', '--shared', '--no-checkout', repo, historicalRepo);
  const objects = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    {cwd: repo, encoding: 'utf8', input: history.map(({commit}) => commit).join('\n') + '\n'});
  assert.equal(objects.status, 0, objects.stderr);
  const available = new Set(objects.stdout.trim().split('\n'));

  for (const {commit, lines} of history) {
    // These hashes belong to an unmerged branch, not main's squash history.
    // Once that branch disappears, there is no historical finding to suppress;
    // skip only that hash's controls, never the fresh-commit/adjacency tests.
    const skip = available.has(`${commit} commit`) ? false : 'Historical branch commit no longer fetched';
    const range = `${commit}^..${commit}`;
    const expected = fingerprints.filter((entry) => entry.startsWith(`${commit}:`)).sort();

    await t.test(`${commit.slice(0, 8)}: historical control reports the inspected fingerprints`, {skip}, () => {
      const result = scan(historicalRepo, range, emptyIgnore);
      expectFindings(result, lines.length);
      assert.deepEqual(result.findings.map((finding) => finding.Fingerprint).sort(), expected);
    });

    await t.test(`${commit.slice(0, 8)}: workflow default ignore discovery clears the inspected findings`, {skip}, () => {
      expectFindings(scan(repo, range, null), 0);
    });

    for (const [name, change] of [
      ['commit', (entry) => entry.replace(commit, '0'.repeat(40))],
      ['path', (entry) => entry.replace(fixturePath, 'other.test.mjs')],
      ['rule', (entry) => entry.replace('private-key', 'other-rule')],
      ['line', (entry) => entry.replace(/:(\d+)$/, (_, line) => `:${Number(line) + 1}`)],
    ]) {
      await t.test(`${commit.slice(0, 8)}: a different ${name} does not suppress the findings`, {skip}, () => {
        const changedIgnore = join(root, `${commit}-${name}.ignore`);
        writeFileSync(changedIgnore, fingerprints.map((entry) => entry.startsWith(`${commit}:`) ? change(entry) : entry).join('\n') + '\n');
        expectFindings(scan(historicalRepo, range, changedIgnore), lines.length);
      });
    }
  }

  function fixture(name, content) {
    const cwd = join(root, name);
    mkdirSync(dirname(join(cwd, fixturePath)), {recursive: true});
    // Same path and line as the known finding, but a different commit. All
    // subprocess writes are confined to disposable Git repositories in scratch.
    writeFileSync(join(cwd, fixturePath), '\n'.repeat(524) + content);
    git(cwd, 'init', '--quiet');
    git(cwd, 'add', fixturePath);
    git(cwd, '-c', 'user.name=Gitleaks regression', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `test: ${name}`);
    return cwd;
  }

  for (const [name, content, count] of [
    ['copied synthetic fixture', synthetic, 1],
    ['standalone fabricated PEM', fabricatedPem, 1],
    ['synthetic fixture before fabricated PEM', synthetic + fabricatedPem, 2],
    ['short synthetic template before fabricated PEM', short + '\n' + fabricatedPem, 1],
    ['fabricated PEM before synthetic fixture', fabricatedPem + synthetic, 2],
  ]) {
    await t.test(name, () => {
      const cwd = fixture(name.replaceAll(' ', '-'), content);
      const baseline = scan(cwd, '--all', emptyIgnore);
      expectFindings(baseline, count);
      const result = scan(cwd, '--all');
      expectFindings(result, count);
      assert.deepEqual(result.findings.map((finding) => finding.Fingerprint),
        baseline.findings.map((finding) => finding.Fingerprint));
      assert.ok(result.findings.every((finding) => !fingerprints.includes(finding.Fingerprint)));
    });
  }
});
