import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parseDocument} from 'yaml';
import normalize from './normalize-release.cjs';

const repo = {owner: 'TogetherWeOwn', repo: 'two-bot'};
const branch = 'release-please--branches--main--components--two-bot';
const pr = {number: 368, headBranchName: branch};
const prefix = 'https://github.com/TogetherWeOwn/two-bot';
const oldHeading = `## [0.2.0](${prefix}/compare/v0.1.0...v0.2.0) (2026-09-30)`;
const fixedHeading = `## [0.2.0](${prefix}/releases/tag/v0.2.0) (2026-09-30)`;
const notes = '\n\n### Added\n\n* new feature ([abc123](https://github.com/TogetherWeOwn/two-bot/commit/abc123))\n\n### Fixed\n\n* bug fix\n';
const header = JSON.parse(readFileSync(new URL('../../release-please-config.json', import.meta.url))).packages['.']['pull-request-header'];

function fixture({tagStatus = 404, changelog = `# Changelog\n\n${oldHeading}${notes}`, body} = {}) {
  const state = {
    current: {state: 'open', base: {ref: 'main'}, head: {sha: 'generated-head', ref: branch, repo: {full_name: 'TogetherWeOwn/two-bot'}},
      body: body ?? `${header}\n---\n\n${oldHeading}${notes}\n---\nRefs: TOG-9865`},
    changelog,
  };
  const calls = [];
  const wrap = (name, run) => async (args) => {calls.push({name, args}); return run(args);};
  const github = {rest: {
    pulls: {
      get: wrap('pr.get', () => ({data: structuredClone(state.current)})),
      update: wrap('pr.update', ({body}) => {state.current.body = body; return {data: state.current};}),
    },
    repos: {
      getContent: wrap('content.get', () => ({data: {type: 'file', encoding: 'base64', sha: 'blob-sha', content: Buffer.from(state.changelog).toString('base64')}})),
      createOrUpdateFileContents: wrap('content.put', ({content}) => {state.changelog = Buffer.from(content, 'base64').toString('utf8'); return {data: {commit: {sha: 'normalized-head'}}};}),
    },
    git: {getRef: wrap('ref.get', () => {
      if (tagStatus !== 200) throw Object.assign(new Error(`HTTP ${tagStatus}`), {status: tagStatus});
      return {data: {ref: 'refs/tags/v0.1.0'}};
    })},
  }};
  return {state, calls, github};
}
const writes = (f) => f.calls.filter(({name}) => ['content.put', 'pr.update'].includes(name));

// Mirrors the generator's header/notes/footer shape, with no network or database.
test('repairs the seed URL in both outputs without changing release notes or markers', async () => {
  const f = fixture();
  const original = structuredClone(f.state);
  await normalize({...f, repo, pr});
  assert.equal(f.state.changelog, original.changelog.replace(oldHeading, fixedHeading));
  assert.equal(f.state.current.body, original.current.body.replace(oldHeading, fixedHeading));
  assert.deepEqual(f.calls.map(({name}) => name), ['pr.get', 'content.get', 'ref.get', 'content.put', 'pr.update']);
  assert.equal(f.calls[1].args.ref, 'generated-head');
  assert.equal(f.calls[3].args.branch, branch);
  assert.equal(f.calls[3].args.sha, 'blob-sha');
  assert.match(f.calls[3].args.message, /^chore\(release\):/);
  assert.match(f.calls[3].args.message, /Co-Authored-By: Paperclip <noreply@paperclip.ing>$/);
});

test('second invocation is a no-op; another release-please regeneration is repaired again', async () => {
  const f = fixture();
  const original = structuredClone(f.state);
  await normalize({...f, repo, pr});
  f.calls.length = 0;
  await normalize({...f, repo, pr});
  assert.equal(writes(f).length, 0);
  Object.assign(f.state, original);
  f.calls.length = 0;
  await normalize({...f, repo, pr});
  assert.equal(writes(f).length, 2);
});

test('a real seed tag keeps both compare links and makes no writes', async () => {
  const f = fixture({tagStatus: 200});
  const before = structuredClone(f.state);
  await normalize({...f, repo, pr});
  assert.deepEqual(f.state, before);
  assert.equal(writes(f).length, 0);
});

test('later release comparisons are untouched', async () => {
  const heading = oldHeading.replaceAll('0.2.0', '0.3.0').replace('v0.1.0...', 'v0.2.0...');
  const f = fixture({changelog: `${heading}${notes}`, body: `${header}\n---\n${heading}${notes}\n---\nRefs: TOG-9865`});
  await normalize({...f, repo, pr});
  assert.equal(writes(f).length, 0);
  assert.equal(f.calls.some(({name}) => name === 'ref.get'), false);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} is a failure, not evidence of a missing tag`, async () => {
    const f = fixture({tagStatus: status});
    await assert.rejects(normalize({...f, repo, pr}), {status});
    assert.equal(writes(f).length, 0);
  });
}

test('recovers if a prior run committed the changelog but failed the body update', async () => {
  const f = fixture({changelog: `# Changelog\n\n${fixedHeading}${notes}`});
  await normalize({...f, repo, pr});
  assert.deepEqual(writes(f).map(({name}) => name), ['pr.update']);
  assert.ok(f.state.current.body.includes(fixedHeading));
});

test('repairs only the file when the body is already correct', async () => {
  const f = fixture({body: `${header}\n---\n${fixedHeading}${notes}\n---\nRefs: TOG-9865`});
  await normalize({...f, repo, pr});
  assert.deepEqual(writes(f).map(({name}) => name), ['content.put']);
});

test('file write failure propagates, and no body write follows it', async () => {
  const f = fixture();
  f.github.rest.repos.createOrUpdateFileContents = async () => {throw Object.assign(new Error('conflict'), {status: 409});};
  await assert.rejects(normalize({...f, repo, pr}), {status: 409});
  assert.equal(f.calls.some(({name}) => name === 'pr.update'), false);
});

test('body write failure propagates instead of allowing check dispatch', async () => {
  const f = fixture();
  f.github.rest.pulls.update = async () => {throw Object.assign(new Error('denied'), {status: 403});};
  await assert.rejects(normalize({...f, repo, pr}), {status: 403});
});

for (const mutation of [
  (current) => {current.state = 'closed';},
  (current) => {current.base.ref = 'other';},
  (current) => {current.head.ref = 'main';},
  (current) => {current.head.repo.full_name = 'outside/two-bot';},
]) {
  test('refuses a closed, wrong-base, wrong-branch or fork PR', async () => {
    const f = fixture();
    mutation(f.state.current);
    await assert.rejects(normalize({...f, repo, pr}), /non-release PR/);
    assert.equal(writes(f).length, 0);
    assert.equal(f.calls.length, 1);
  });
}

test('refuses unexpected generator output before making any API calls', async () => {
  const f = fixture();
  await assert.rejects(normalize({...f, repo, pr: {...pr, headBranchName: 'main'}}), /Unexpected release-please/);
  await assert.rejects(normalize({...f, repo, pr: {...pr, number: '368'}}), /Unexpected release-please/);
  assert.equal(f.calls.length, 0);
});

test('refuses an unrelated repository comparison without looking up its tag', async () => {
  const f = fixture({changelog: oldHeading.replace('TogetherWeOwn', 'outside')});
  await assert.rejects(normalize({...f, repo, pr}), /comparison repository/);
  assert.equal(writes(f).length, 0);
  assert.equal(f.calls.some(({name}) => name === 'ref.get'), false);
});

test('persistent header complies with the PR template and does not claim checks ran', () => {
  for (const section of ['Summary', 'Changes', 'Testing']) assert.ok(header.includes(`## ${section}\n`));
  assert.ok(header.includes('Metadata-only release; no local runtime test applies.'));
  assert.ok(header.includes('must be green on the exact head'));
  assert.equal(header.includes('\n---\n'), false); // Keep release-please delimiters parseable.
});

test('workflow runs main-owned normalization before dispatch, with immutable action pins', () => {
  const workflow = parseDocument(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')).toJS();
  const job = workflow.jobs['release-please'];
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  const steps = job.steps;
  assert.equal(steps[0].id, 'release');
  assert.equal(steps[1].uses, 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
  assert.deepEqual(steps[1].with, {ref: '${{ github.sha }}', 'persist-credentials': false});
  assert.match(steps[2].uses, /^actions\/github-script@[a-f0-9]{40}$/);
  assert.equal(steps[1].if, "steps.release.outputs.prs_created == 'true'");
  assert.equal(steps[2].if, steps[1].if);
  assert.equal(steps[2].env.PR_JSON, '${{ steps.release.outputs.pr }}');
  assert.ok(steps[2].with.script.includes('JSON.parse(process.env.PR_JSON)'));
  assert.equal(workflow.jobs['dispatch-checks'].needs, 'release-please');
  assert.equal(workflow.jobs['dispatch-checks'].if, "needs.release-please.outputs.prs_created == 'true'");
  assert.ok(workflow.jobs['dispatch-checks'].steps[0].run.includes('gh workflow run ci.yml --ref "$HEAD_BRANCH"'));
  const ci = readFileSync(new URL('./run-check-job.sh', import.meta.url), 'utf8');
  const install = ci.indexOf('npm ci --ignore-scripts --prefix scripts/ci');
  const regression = ci.indexOf('node --test scripts/ci/normalize-release.test.mjs');
  assert.ok(install >= 0 && regression > install); // This job cannot reuse fork-gate's runner.
});
