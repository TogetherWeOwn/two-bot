// Check candidate workflow DATA with the trusted policy, not candidate scripts.
// YAML 1.2 keeps `on` a string; a line parser missed inline triggers, .yaml
// files, commented-out edges and job conditions that override failed needs.
// Parser API: https://eemeli.org/yaml/v2/#documents
// needs/if: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, visit } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = 'fork-gate';
const GUARD = './scripts/ci/refuse-fork-pr.sh';
const BASE_REF = '${{ github.event.pull_request.base.sha || github.sha }}';
const HEAD_REPO = '${{ github.event.pull_request.head.repo.full_name }}';
const HEAD_REF = '${{ github.event.pull_request.head.sha || github.sha }}';
// Reviewed action migrations must land in the trusted base before a candidate
// changes versions. Only these exact identities alias the existing gate shape.
const ACTION_ALIASES = new Map([
  ['actions/checkout@v7', 'actions/checkout@v5'],
  ['actions/setup-node@v7', 'actions/setup-node@v4'],
]);
const canonicalAction = (uses) => ACTION_ALIASES.get(uses) ?? uses;
const TAIL = [
  { uses: 'actions/setup-node@v4', with: { 'node-version': '24' } },
  { run: 'npm ci --ignore-scripts --prefix scripts/ci' },
  {
    uses: 'actions/checkout@v5',
    with: { ref: HEAD_REF, path: 'candidate', 'sparse-checkout': '.github/workflows', 'persist-credentials': false },
  },
  { run: './scripts/ci/refuse-fork-pr.test.sh "$GITHUB_WORKSPACE/candidate"' },
];
const map = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, keys) => Object.keys(value).every((key) => keys.includes(key));

export function parseWorkflow(text) {
  const doc = parseDocument(text, {
    version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
    stringKeys: true, merge: false, resolveKnownTags: false, customTags: [],
  });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join('; '));
  }
  if (doc.directives.yaml.version !== '1.2') throw new Error('YAML 1.2 is required');
  // Reject aliases explicitly, including self-reference (which conversion may
  // preserve as a cycle rather than count as expansion).
  visit(doc, { Alias() { throw new Error('YAML aliases are unsupported'); } });
  return doc.toJS({ maxAliasCount: 0 });
}

function events(on) {
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : map(on) ? Object.keys(on) : [];
  if (!names.length || names.some((name) => typeof name !== 'string' || !/^[a-z_]+$/.test(name))) {
    throw new Error('unsupported or missing on: trigger declaration');
  }
  return names;
}

function checkout(step, ref) {
  return map(step) && keysWithin(step, ['name', 'uses', 'with']) &&
    canonicalAction(step.uses) === 'actions/checkout@v5' && map(step.with) &&
    keysWithin(step.with, ['ref', 'persist-credentials']) &&
    step.with.ref === ref && step.with['persist-credentials'] === false;
}

function gateProblems(gate) {
  const errors = [];
  // This is intentionally a small accepted policy shape, not a shell analyzer.
  // Conditions, custom shells/env, services or earlier candidate steps could
  // skip, mask or precede the refusal. New shapes need an explicit policy update.
  if (!map(gate) || !keysWithin(gate, ['runs-on', 'timeout-minutes', 'steps']) || !Array.isArray(gate.steps)) {
    return ['fork-gate must be an unconditional steps job without env/defaults/services or error overrides'];
  }
  const steps = gate.steps;
  if (!checkout(steps[0], BASE_REF)) errors.push('fork-gate must first check out the trusted base with credentials disabled');
  // Land these policy files independently before introducing the workflow.
  // A candidate-selected bootstrap SHA is not a trust anchor, even if immutable.
  // Once the policy is on main, the base checkout is the only policy source.
  if (canonicalAction(steps[1]?.uses) === 'actions/checkout@v5') errors.push('bootstrap checkouts are forbidden; land policy on the base first');
  const guard = steps[1];
  if (!map(guard) || !keysWithin(guard, ['name', 'env', 'run']) || typeof guard.run !== 'string' || guard.run.trim() !== GUARD ||
      !map(guard.env) || !keysWithin(guard.env, ['PR_HEAD_REPO']) || guard.env.PR_HEAD_REPO !== HEAD_REPO) {
    errors.push('fork-gate must run the trusted refusal unconditionally before any other steps');
  }
  // Validate the WHOLE tail, not just the refusal prefix. Exact shapes retain
  // implicit success(), disallow shell/env/error overrides, and require the
  // trusted checker to read candidate data without executing candidate code.
  if (steps.length !== 2 + TAIL.length) errors.push('fork-gate must contain exactly the six trusted policy steps');
  for (const [index, expected] of TAIL.entries()) {
    const step = steps[index + 2];
    if (!map(step)) {
      errors.push(`fork-gate step ${index + 3}: missing trusted candidate-coverage step`);
      continue;
    }
    const { name, ...actual } = step;
    if (typeof actual.uses === 'string') actual.uses = canonicalAction(actual.uses);
    if (typeof actual.run === 'string') actual.run = actual.run.trim();
    if (!isDeepStrictEqual(actual, expected)) {
      errors.push(`fork-gate step ${index + 3}: must use the trusted candidate-coverage step with default success() and no overrides`);
    }
  }
  return errors;
}

export function checkWorkflow(text) {
  const workflow = parseWorkflow(text);
  if (!map(workflow)) throw new Error('workflow must be a mapping');
  const triggers = events(workflow.on);
  if (!triggers.some((event) => event === 'pull_request' || event === 'pull_request_target')) {
    return { checked: false, problems: [] };
  }
  const problems = [];
  if ('env' in workflow || 'defaults' in workflow) {
    problems.push('workflow-wide env/defaults are unsupported for the trusted gate; set them on dependent jobs');
  }
  if (!map(workflow.jobs) || !Object.keys(workflow.jobs).length) {
    return { checked: true, problems: [...problems, 'missing or unsupported jobs mapping'] };
  }
  const jobs = workflow.jobs;
  if (!Object.hasOwn(jobs, GATE)) problems.push('pull-request workflow has no fork-gate job');
  else problems.push(...gateProblems(jobs[GATE]));

  for (const [name, job] of Object.entries(jobs)) {
    if (name === GATE) continue;
    if (!map(job)) {
      problems.push(`job ${name}: unsupported job shape`);
      continue;
    }
    const needs = typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || needs.some((need) => typeof need !== 'string') || !needs.includes(GATE)) {
      problems.push(`job ${name}: needs must contain the actual fork-gate dependency`);
    }
    // `always()`/`failure()`/`!cancelled()` can run after refusal. Reject other
    // expressions too until we can prove they require success, not by substring.
    if ('if' in job && ![true, 'success()', '${{ success() }}'].includes(job.if)) {
      problems.push(`job ${name}: unsupported if condition; must preserve the default success() gate`);
    }
  }
  return { checked: true, problems };
}

export function checkDirectory(candidateRoot) {
  const problems = [];
  const checked = [];
  try {
    for (const dir of [join(candidateRoot, '.github'), join(candidateRoot, '.github', 'workflows')]) {
      if (!lstatSync(dir).isDirectory()) throw new Error('workflow directories must not be symlinks');
    }
    const workflowDir = join(candidateRoot, '.github', 'workflows');
    for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      try {
        const path = join(workflowDir, file);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('workflow must be a regular file of at most 1 MiB');
        const result = checkWorkflow(readFileSync(path, 'utf8'));
        if (result.checked) checked.push(file);
        problems.push(...result.problems.map((problem) => `${file}: ${problem}`));
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
      }
    }
  } catch (error) {
    problems.push(error.message);
  }
  if (!checked.length) problems.push('no pull-request workflow examined');
  return { checked, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('usage: node check-fork-gate-coverage.mjs [candidate-root]');
  const result = checkDirectory(resolve(process.argv[2] ?? root));
  for (const problem of result.problems) console.error(`coverage: ${problem}`);
  if (result.problems.length) process.exitCode = 1;
  else for (const file of result.checked) console.log(`  ok  ${file} routes every job through ${GATE}`);
}
