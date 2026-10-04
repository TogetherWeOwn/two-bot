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
    current: {number: pr.number, state: 'open', labels: [{name: 'autorelease: pending'}], base: {ref: 'main'},
      head: {sha: 'generated-head', ref: branch, repo: {full_name: 'TogetherWeOwn/two-bot'}},
      body: body ?? `${header}\n---\n\n${oldHeading}${notes}\n---\nRefs: TOG-9865`},
    changelog,
    candidates: null,
  };
  const calls = [];
  const wrap = (name, run) => async (args) => {calls.push({name, args}); return run(args);};
  const github = {rest: {
    pulls: {
      list: wrap('pr.list', () => ({data: state.candidates ?? [structuredClone(state.current)]})),
      get: wrap('pr.get', () => ({data: structuredClone(state.current)})),
      update: wrap('pr.update', ({body}) => {state.current.body = body; return {data: state.current};}),
    },
    repos: {
      getContent: wrap('content.get', () => ({data: {type: 'file', encoding: 'base64', sha: 'blob-sha', content: Buffer.from(state.changelog).toString('base64')}})),
      createOrUpdateFileContents: wrap('content.put', ({content}) => {
        state.changelog = Buffer.from(content, 'base64').toString('utf8');
        state.current.head.sha = 'normalized-head';
        return {data: {commit: {sha: state.current.head.sha}}};
      }),
    },
    git: {getRef: wrap('ref.get', () => {
      if (tagStatus !== 200) throw Object.assign(new Error(`HTTP ${tagStatus}`), {status: tagStatus});
      return {data: {ref: 'refs/tags/v0.1.0'}};
    })},
  }};
  github.paginate = async (method, args) => (await method(args)).data;
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
  (current) => {current.labels = [];},
  (current) => {current.labels = [{name: 'autorelease: tagged'}];},
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

const workflow = parseDocument(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')).toJS();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the checked-in Actions script and gates, not just the standalone helper.
// Models github-script's default JSON result and needs' default success condition:
// https://github.com/actions/github-script/tree/v9#reading-step-results
async function workflowRun(f, {generatedPr = pr} = {}) {
  const values = {'steps.release.outputs.pr': generatedPr ? JSON.stringify(generatedPr) : '',
    'steps.release.outputs.prs_created': generatedPr ? 'true' : 'false'};
  const resolve = (expression) => {
    const match = expression.match(/^\$\{\{ (.+) \}\}$/);
    assert.ok(match, `Unexpected output expression: ${expression}`);
    return values[match[1]] ?? '';
  };
  const gate = (condition) => !condition || condition.split(' && ').every((part) => {
    const match = part.match(/^(.+) (!=|==) '([^']*)'$/);
    assert.ok(match, `Unexpected condition: ${part}`);
    return match[2] === '==' ? (values[match[1]] ?? '') === match[3] : (values[match[1]] ?? '') !== match[3];
  });
  f.dispatched = [];
  for (const step of workflow.jobs['release-please'].steps.slice(1)) {
    if (!gate(step.if) || !step.with.script) continue;
    const run = new AsyncFunction('require', 'github', 'context', 'process', step.with.script);
    const result = await run((path) => {
      assert.equal(path, './scripts/ci/normalize-release.cjs');
      return normalize;
    }, f.github, {repo}, {env: {PR_JSON: resolve(step.env.PR_JSON)}});
    values[`steps.${step.id}.outputs.result`] = JSON.stringify(result);
  }
  for (const [name, expression] of Object.entries(workflow.jobs['release-please'].outputs)) {
    values[`needs.release-please.outputs.${name}`] = resolve(expression);
  }
  const dispatch = workflow.jobs['dispatch-checks'];
  if (gate(dispatch.if)) {
    const releasePr = JSON.parse(resolve(dispatch.steps[0].env.PR_JSON));
    f.dispatched.push({pr: releasePr, head: f.state.current.head.sha});
  }
}

for (const failedWrite of ['createOrUpdateFileContents', 'update']) {
  test(`workflow recovers ${failedWrite} failure on unchanged generation and dispatches repaired head`, async () => {
    const f = fixture();
    const endpoint = failedWrite === 'update' ? f.github.rest.pulls : f.github.rest.repos;
    const original = endpoint[failedWrite];
    endpoint[failedWrite] = async () => {throw Object.assign(new Error('transient failure'), {status: 500});};
    await assert.rejects(workflowRun(f), {status: 500});
    assert.deepEqual(f.dispatched, []);
    assert.ok(f.state.current.body.includes(oldHeading)); // Generator sees its unchanged candidate.
    assert.equal(f.state.changelog.includes(fixedHeading), failedWrite === 'update');
    endpoint[failedWrite] = original;
    f.calls.length = 0;
    await workflowRun(f, {generatedPr: null}); // prs_created=false; PR output absent.
    assert.ok(f.state.changelog.includes(fixedHeading));
    assert.ok(f.state.current.body.includes(fixedHeading));
    assert.deepEqual(f.dispatched, [{pr, head: f.state.current.head.sha}]);
    assert.equal(f.calls[0].name, 'pr.list');
    assert.deepEqual(f.calls[0].args, {...repo, state: 'open', base: 'main', head: `${repo.owner}:${branch}`, per_page: 100});
    assert.deepEqual(writes(f).map(({name}) => name), failedWrite === 'update' ? ['pr.update'] : ['content.put', 'pr.update']);
  });
}

test('unchanged corrected PR is still dispatched without additional writes', async () => {
  const f = fixture();
  await workflowRun(f);
  f.calls.length = 0;
  await workflowRun(f, {generatedPr: null});
  assert.equal(writes(f).length, 0);
  assert.deepEqual(f.dispatched, [{pr, head: f.state.current.head.sha}]);
});

test('no open release PR means no normalization writes or check dispatch', async () => {
  const f = fixture();
  f.state.candidates = [];
  await workflowRun(f, {generatedPr: null});
  assert.equal(writes(f).length, 0);
  assert.deepEqual(f.dispatched, []);
});

test('ambiguous recovery and discovery errors fail before dispatch', async () => {
  const f = fixture();
  f.state.candidates = [f.state.current, {...f.state.current, number: 369}];
  await assert.rejects(workflowRun(f, {generatedPr: null}), /Ambiguous/);
  assert.deepEqual(f.dispatched, []);
  f.github.paginate = async () => {throw Object.assign(new Error('denied'), {status: 403});};
  await assert.rejects(workflowRun(f, {generatedPr: null}), {status: 403});
  assert.equal(writes(f).length, 0);
  assert.deepEqual(f.dispatched, []);
});

for (const mutation of [
  (current) => {current.state = 'closed';},
  (current) => {current.base.ref = 'other';},
  (current) => {current.head.ref = 'main';},
  (current) => {current.head.repo.full_name = 'outside/two-bot';},
  (current) => {current.labels = [];},
]) {
  test('recovered PR is revalidated before any write or dispatch', async () => {
    const f = fixture();
    mutation(f.state.current);
    await assert.rejects(workflowRun(f, {generatedPr: null}), /non-release PR/);
    assert.equal(writes(f).length, 0);
    assert.deepEqual(f.dispatched, []);
  });
}

test('workflow runs main-owned normalization before dispatch, with immutable action pins', () => {
  const job = workflow.jobs['release-please'];
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  const steps = job.steps;
  assert.equal(steps[0].id, 'release');
  assert.equal(steps[1].uses, 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09');
  assert.deepEqual(steps[1].with, {ref: '${{ github.sha }}', 'persist-credentials': false});
  assert.match(steps[2].uses, /^actions\/github-script@[a-f0-9]{40}$/);
  assert.equal(steps[1].if, undefined);
  assert.equal(steps[2].if, undefined);
  assert.equal(steps[2].env.PR_JSON, '${{ steps.release.outputs.pr }}');
  assert.deepEqual(job.outputs, {pr: '${{ steps.normalize.outputs.result }}'});
  assert.equal(workflow.jobs['dispatch-checks'].needs, 'release-please');
  const dispatch = workflow.jobs['dispatch-checks'].steps[0];
  assert.equal(dispatch.env.PR_JSON, '${{ needs.release-please.outputs.pr }}');
  for (const filename of ['ci.yml', 'secret-scan.yml', 'pr-lint.yml']) {
    assert.ok(dispatch.run.includes(`gh workflow run ${filename} --ref "$HEAD_BRANCH"`));
  }
  const ci = readFileSync(new URL('./run-check-job.sh', import.meta.url), 'utf8');
  const install = ci.indexOf('npm ci --ignore-scripts --prefix scripts/ci');
  const regression = ci.indexOf('node --test scripts/ci/normalize-release.test.mjs');
  assert.ok(install >= 0 && regression > install); // This job cannot reuse fork-gate's runner.
});
