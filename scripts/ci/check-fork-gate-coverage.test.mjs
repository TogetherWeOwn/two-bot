import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stringify } from 'yaml';
import { checkDirectory, checkWorkflow, parseWorkflow } from './check-fork-gate-coverage.mjs';

const baseRef = '${{ github.event.pull_request.base.sha || github.sha }}';
const headRepo = '${{ github.event.pull_request.head.repo.full_name }}';
const bootstrapIf = "${{ hashFiles('scripts/ci/refuse-fork-pr.sh') == '' }}";
const fixture = readFileSync(new URL('./fixtures/fork-policy/.github/workflows/ci.yml', import.meta.url), 'utf8');

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

for (const checkoutVersion of ['v5', 'v7']) {
  for (const nodeVersion of ['v4', 'v7']) {
    test(`accepts reviewed checkout ${checkoutVersion} and setup-node ${nodeVersion} without changing gate shape`, () => {
      const workflow = parseWorkflow(fixture);
      workflow.jobs['fork-gate'].steps[0].uses = `actions/checkout@${checkoutVersion}`;
      workflow.jobs['fork-gate'].steps[2].uses = `actions/setup-node@${nodeVersion}`;
      workflow.jobs['fork-gate'].steps[4].uses = `actions/checkout@${checkoutVersion}`;
      assert.deepEqual(checkWorkflow(stringify(workflow)).problems, []);
    });
  }
}

for (const index of [0, 2, 4]) {
  test(`rejects unreviewed action identities at gate step ${index + 1}`, () => {
    for (const version of ['v99', 'main', '${{ github.ref }}', 'v7-malicious']) {
      const workflow = parseWorkflow(fixture);
      const step = workflow.jobs['fork-gate'].steps[index];
      step.uses = step.uses.replace(/@v\d+$/, `@${version}`);
      rejected(stringify(workflow), index === 0 ? /trusted base/ : /candidate-coverage step/);
    }
  });
}

test('reviewed v7 actions do not admit gate step overrides', () => {
  for (const index of [0, 2, 4]) {
    for (const override of [
      { if: 'always()' }, { 'continue-on-error': true },
      { env: { NODE_OPTIONS: '--import ./candidate/preload.mjs' } },
      { with: { ref: 'main', 'persist-credentials': true } },
    ]) {
      const workflow = parseWorkflow(fixture);
      const steps = workflow.jobs['fork-gate'].steps;
      steps[0].uses = 'actions/checkout@v7';
      steps[2].uses = 'actions/setup-node@v7';
      steps[4].uses = 'actions/checkout@v7';
      Object.assign(steps[index], override);
      rejected(stringify(workflow), index === 0 ? /trusted base/ : /candidate-coverage step/);
    }
  }
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

test('rejects all candidate-selected bootstrap identities, including old immutable policies', () => {
  for (const ref of ['main', 'a'.repeat(40), '1b0d5dc620e7cd479587b26028ef35367b2efe05', 'ac9153f05cb888ff2cb23588e275ad53efc48433']) {
    const checkout = `      - uses: actions/checkout@v5
        if: ${bootstrapIf}
        with:
          ref: ${ref}
          persist-credentials: false
`;
    rejected(replace(fixture, '      - name: Refuse fork pull requests', checkout + '      - name: Refuse fork pull requests'), /bootstrap checkouts are forbidden/);
  }
});

for (const [name, mutate, reason] of [
  ['always tail after refusal', (steps) => steps.push({ if: 'always()', run: 'printf harmless' }), /exactly the six/],
  ['ordinary extra tail', (steps) => steps.push({ run: 'printf harmless' }), /exactly the six/],
  ['missing coverage execution', (steps) => steps.pop(), /candidate-coverage step/],
  ['no-op coverage execution', (steps) => { steps[5].run = 'true'; }, /candidate-coverage step/],
  ['coverage only named in a comment', (steps) => { steps[5].run = 'true # ./scripts/ci/refuse-fork-pr.test.sh "$GITHUB_WORKSPACE/candidate"'; }, /candidate-coverage step/],
  ['coverage runs on base not candidate', (steps) => { steps[5].run = './scripts/ci/refuse-fork-pr.test.sh'; }, /candidate-coverage step/],
  ['candidate script execution', (steps) => { steps[5].run = './candidate/scripts/ci/refuse-fork-pr.test.sh "$GITHUB_WORKSPACE/candidate"'; }, /candidate-coverage step/],
  ['candidate overwrites policy checkout', (steps) => { steps[4].with.path = '.'; }, /candidate-coverage step/],
  ['candidate checkout substituted with base', (steps) => { steps[4].with.ref = baseRef; }, /candidate-coverage step/],
  ['candidate install executes lifecycle scripts', (steps) => { steps[3].run = 'npm ci --prefix candidate'; }, /candidate-coverage step/],
  ['coverage steps reordered', (steps) => { [steps[4], steps[5]] = [steps[5], steps[4]]; }, /candidate-coverage step/],
]) {
  test(`fails closed: ${name}`, () => {
    const workflow = parseWorkflow(fixture);
    mutate(workflow.jobs['fork-gate'].steps);
    rejected(stringify(workflow), reason);
  });
}

for (let index = 2; index < 6; index++) {
  for (const override of [
    { if: 'always()' }, { if: '${{ failure() }}' }, { if: '${{ !cancelled() }}' }, { if: false },
    { 'continue-on-error': true }, { env: { NODE_OPTIONS: '--import ./candidate/preload.mjs' } },
    { shell: 'bash {0} || true' }, { 'working-directory': 'candidate' },
  ]) {
    test(`rejects tail step ${index + 1} override ${JSON.stringify(override)}`, () => {
      const workflow = parseWorkflow(fixture);
      Object.assign(workflow.jobs['fork-gate'].steps[index], override);
      rejected(stringify(workflow), /candidate-coverage step/);
    });
  }
}

test('display names and block-scalar trailing newlines do not change the policy', () => {
  const workflow = parseWorkflow(fixture);
  for (const step of workflow.jobs['fork-gate'].steps) {
    step.name = 'Descriptive name';
    if (step.run) step.run += '\n';
  }
  assert.deepEqual(checkWorkflow(stringify(workflow)).problems, []);
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
  ['checkout a different repository', `          ref: ${baseRef}`, `          ref: ${baseRef}\n          repository: stranger/two-bot`, /trusted base/],
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
