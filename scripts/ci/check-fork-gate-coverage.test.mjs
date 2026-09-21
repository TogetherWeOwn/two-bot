import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDirectory, checkWorkflow } from './check-fork-gate-coverage.mjs';

const baseRef = '${{ github.event.pull_request.base.sha || github.sha }}';
const headRepo = '${{ github.event.pull_request.head.repo.full_name }}';
const bootstrapIf = "${{ hashFiles('scripts/ci/refuse-fork-pr.sh') == '' }}";
const fixture = `name: coverage-fixture
on:
  pull_request:
jobs:
  fork-gate:
    runs-on: [self-hosted, two-selfhosted]
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${baseRef}
          persist-credentials: false
      - name: Refuse fork pull requests
        env:
          PR_HEAD_REPO: ${headRepo}
        run: ./scripts/ci/refuse-fork-pr.sh
  check:
    needs: fork-gate
    runs-on: [self-hosted, two-selfhosted]
    steps:
      - run: 'true'
`;

function replace(text, before, after) {
  assert.equal(text.split(before).length, 2, `mutation target must occur exactly once: ${before}`);
  return text.replace(before, after);
}
function rejected(text, reason) {
  try {
    assert.match(checkWorkflow(text).problems.join('\n'), reason);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(error.message, reason);
  }
}
function candidate(t, files) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), 'fork-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return root;
}

test('block mapping, scalar, inline array and inline map PR triggers are checked', () => {
  for (const trigger of ['on: pull_request', 'on: [push, pull_request]', 'on: {push: {}, pull_request: {}}', '"on": [pull_request_target]']) {
    assert.deepEqual(checkWorkflow(replace(fixture, 'on:\n  pull_request:', trigger)), { checked: true, problems: [] });
  }
  assert.deepEqual(checkWorkflow(fixture), { checked: true, problems: [] });
});

test('push-only workflows are not required to have a fork gate', () => {
  assert.deepEqual(checkWorkflow('on: [push, schedule]\njobs: {}'), { checked: false, problems: [] });
});

test('needs supports scalar, flow and block sequences with exact job IDs', () => {
  for (const needs of ['fork-gate # actual edge', '[fork-gate, other]', '\n      - fork-gate\n      - other']) {
    assert.deepEqual(checkWorkflow(replace(fixture, 'needs: fork-gate', `needs: ${needs}`)).problems, []);
  }
});

test('default success and explicit success preserve dependency refusal', () => {
  for (const condition of ['true', 'success()', '${{ success() }}']) {
    assert.deepEqual(checkWorkflow(replace(fixture, '    needs: fork-gate', `    needs: fork-gate\n    if: ${condition}`)).problems, []);
  }
});

test('immutable bootstrap checkout is allowed before the guard', () => {
  const checkout = `      - uses: actions/checkout@v5
        if: ${bootstrapIf}
        with:
          ref: ${'a'.repeat(40)}
          persist-credentials: false
`;
  const withBootstrap = replace(fixture, '      - name: Refuse fork pull requests', checkout + '      - name: Refuse fork pull requests');
  assert.deepEqual(checkWorkflow(withBootstrap).problems, []);
  rejected(replace(withBootstrap, 'a'.repeat(40), 'main'), /immutable reviewed SHA/);
  rejected(replace(withBootstrap, bootstrapIf, '${{ always() }}'), /immutable reviewed SHA/);
});

for (const [name, before, after, reason] of [
  ['removed edge', '    needs: fork-gate\n', '', /actual fork-gate dependency/],
  ['comment masquerading as edge', 'needs: fork-gate', 'needs: [] # fork-gate', /actual fork-gate dependency/],
  ['similar job name', 'needs: fork-gate', 'needs: not-fork-gate', /actual fork-gate dependency/],
  ['always condition', '    needs: fork-gate', '    needs: fork-gate\n    if: always()', /unsupported if/],
  ['failure condition', '    needs: fork-gate', '    needs: fork-gate\n    if: ${{ failure() }}', /unsupported if/],
  ['negated cancelled condition', '    needs: fork-gate', '    needs: fork-gate\n    if: ${{ !cancelled() }}', /unsupported if/],
  ['vacuous success condition', '    needs: fork-gate', '    needs: fork-gate\n    if: ${{ always() || success() }}', /unsupported if/],
  ['skippable gate', '  fork-gate:\n', '  fork-gate:\n    if: false\n', /unconditional steps job/],
  ['ignored gate failure', '  fork-gate:\n', '  fork-gate:\n    continue-on-error: true\n', /unconditional steps job/],
  ['gate event override', '  fork-gate:\n', '  fork-gate:\n    env: {GITHUB_EVENT_NAME: push}\n', /unconditional steps job/],
  ['workflow shell override', 'jobs:\n', 'defaults: {run: {shell: "bash {0} || true"}}\njobs:\n', /workflow-wide env\/defaults/],
  ['candidate checkout before refusal', baseRef, '${{ github.event.pull_request.head.sha }}', /trusted base/],
  ['base ref in a comment', `ref: ${baseRef}`, `ref: main # ${baseRef}`, /trusted base/],
  ['checkout a different repository', '          persist-credentials: false', '          persist-credentials: false\n          repository: stranger/two-bot', /trusted base/],
  ['guard only named in comment', 'run: ./scripts/ci/refuse-fork-pr.sh', 'run: true # ./scripts/ci/refuse-fork-pr.sh', /trusted refusal/],
  ['conditional refusal', '        run: ./scripts/ci/refuse-fork-pr.sh', '        if: false\n        run: ./scripts/ci/refuse-fork-pr.sh', /trusted refusal/],
  ['ignored refusal failure', '        run: ./scripts/ci/refuse-fork-pr.sh', '        continue-on-error: true\n        run: ./scripts/ci/refuse-fork-pr.sh', /trusted refusal/],
  ['wrong origin expression', headRepo, '${{ github.repository }}', /trusted refusal/],
  ['missing trigger', 'on:\n  pull_request:\n', '', /trigger declaration/],
  ['duplicate mapping key', '    needs: fork-gate', '    needs: fork-gate\n    needs: []', /unique/],
  ['unknown tag', 'needs: fork-gate', 'needs: !unknown fork-gate', /Unresolved tag/],
  ['alias', 'needs: fork-gate', 'needs: &edges [*edges]', /alias/],
  ['non-1.2 YAML', 'name: coverage-fixture', '%YAML 1.1\n---\nname: coverage-fixture', /YAML 1.2/],
]) {
  test(`fails closed: ${name}`, () => rejected(replace(fixture, before, after), reason));
}

test('enumerates .yml and .yaml; ungated inline trigger is not invisible', (t) => {
  const root = candidate(t, { 'ci.yml': fixture, 'extra.yaml': 'on: [push, pull_request]\njobs: {unguarded: {runs-on: ubuntu-latest, steps: []}}' });
  const result = checkDirectory(root);
  assert.deepEqual(result.checked, ['ci.yml', 'extra.yaml']);
  assert.match(result.problems.join('\n'), /extra.yaml: pull-request workflow has no fork-gate/);
});

test('rejects malformed workflow data even if no PR event could be parsed', (t) => {
  const root = candidate(t, { 'ci.yml': fixture, 'broken.yml': 'on: [' });
  assert.match(checkDirectory(root).problems.join('\n'), /broken.yml/);
});

test('empty coverage fails rather than silently passing', (t) => {
  const root = candidate(t, { 'push.yml': 'on: push\njobs: {}' });
  assert.match(checkDirectory(root).problems.join('\n'), /no pull-request workflow examined/);
});

test('workflow symlinks are not followed', (t) => {
  const root = candidate(t, { 'ci.yml': fixture });
  symlinkSync('ci.yml', join(root, '.github/workflows/alias.yaml'));
  assert.match(checkDirectory(root).problems.join('\n'), /alias.yaml: workflow must be a regular file/);
});

test('trusted CLI checks candidate data, never executes candidate scripts', (t) => {
  const root = candidate(t, { 'ci.yml': fixture });
  const marker = join(root, 'candidate-code-ran');
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci/check-fork-gate-coverage.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const checker = join(dirname(fileURLToPath(import.meta.url)), 'check-fork-gate-coverage.mjs');
  const run = () => spawnSync(process.execPath, [checker, root], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0);
  writeFileSync(join(root, '.github/workflows/ci.yml'), replace(fixture, 'needs: fork-gate', 'needs: [] # fork-gate'));
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /actual fork-gate dependency/);
  assert.equal(existsSync(marker), false);
});
