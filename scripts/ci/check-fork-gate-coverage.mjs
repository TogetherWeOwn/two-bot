// Asserts that the fork gate is actually wired into every workflow a pull
// request can trigger (TOG-3103).
//
// scripts/ci/refuse-fork-pr.sh proves it refuses. This proves it is reached.
// Those are different failures and only one of them is visible in a diff: a
// job added without `needs: fork-gate` looks exactly like a job with it.
//
// Deliberately a line parser rather than a YAML dependency. docs/STACK.md
// makes four runtime dependencies a stated goal, and the shapes below are
// fixed by GitHub's own schema - jobs at two spaces, keys at four.
//
// This does NOT try to understand YAML in general. Every assertion it makes is
// one it can make wrongly only by being too strict, never by being too lax:
// an unusual but valid spelling fails the check and somebody teaches it the
// spelling, which is the direction a security assertion should fail in.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowDir = join(root, '.github', 'workflows');

const GATE = 'fork-gate';
const GUARD = './scripts/ci/refuse-fork-pr.sh';
const BASE_REF = '${{ github.event.pull_request.base.sha || github.sha }}';

const problems = [];
const checked = [];

/** Split a workflow into `{ name, body }` per top-level job (two-space key). */
function parseJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return null;

  const jobs = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (!match) continue;
    const end = lines.findIndex((l, j) => j > i && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
    jobs.push({
      name: match[1],
      body: lines.slice(i, end === -1 ? lines.length : end).join('\n'),
    });
  }
  return jobs;
}

for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.yml')).sort()) {
  const text = readFileSync(join(workflowDir, file), 'utf8');

  // Only workflows a pull request can trigger are in scope. A push- or
  // schedule-only workflow never runs a fork's ref.
  if (!/^ {2}pull_request(_target)?:/m.test(text)) continue;
  checked.push(file);

  const jobs = parseJobs(text);
  if (!jobs || jobs.length === 0) {
    problems.push(`${file}: no jobs: block could be parsed`);
    continue;
  }

  const gate = jobs.find((j) => j.name === GATE);
  if (!gate) {
    problems.push(`${file}: triggers on pull_request but has no \`${GATE}\` job`);
    continue;
  }
  if (!gate.body.includes(GUARD)) {
    problems.push(`${file}: the ${GATE} job does not run ${GUARD}`);
  }
  if (!gate.body.includes(BASE_REF)) {
    problems.push(
      `${file}: the ${GATE} job does not check out the base commit ` +
        `(expected \`ref: ${BASE_REF}\`). Without it the fork supplies the guard that judges the fork.`,
    );
  }

  for (const job of jobs) {
    if (job.name === GATE) continue;
    const needs = /^ {4}needs:\s*(.+)$/m.exec(job.body);
    if (!needs) {
      problems.push(`${file}: job \`${job.name}\` has no \`needs:\`, so it runs even when ${GATE} refuses`);
      continue;
    }
    if (!needs[1].includes(GATE)) {
      problems.push(
        `${file}: job \`${job.name}\` declares \`needs: ${needs[1].trim()}\`, which does not include ${GATE}`,
      );
    }
  }
}

// A coverage check that examined nothing would pass silently, and that is the
// shape this whole file exists to prevent.
if (checked.length === 0) {
  console.error('coverage: no workflow triggers on pull_request, so this check examined nothing');
  process.exit(1);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`coverage: ${p}`);
  process.exit(1);
}

for (const file of checked) console.log(`  ok  ${file} routes every job through ${GATE}`);
