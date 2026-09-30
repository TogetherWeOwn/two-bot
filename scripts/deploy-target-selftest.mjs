#!/usr/bin/env node

// Self-test for the TOG-6911 deploy scripts.
//
// scripts/check-deploy-target.mjs, scripts/wait-for-host-mirror.mjs,
// scripts/wait-for-coolify-deploy.mjs and scripts/smoke-staging-deploy.mjs
// exist so that a deploy job FAILS when there is no target, no panel, or no
// healthy release — never skip-and-passes (TOG-913). A guard that has never
// been observed to fail is indistinguishable from one that cannot fail, so
// this executes each script once per configuration and pins the exit code
// and the reason (in-org precedent: two-web ci/deploy-target-selftest.sh).
//
// Nothing here needs the network, a token, GitHub, or a deploy target. The
// interesting cases are precisely the ones where no target exists. Pure
// functions are imported and asserted in-process; CLI exit codes go through
// spawned node with scrubbed env (every COOLIFY_* value is fake).
//
// What is pinned:
//
//   gate-ready           all vars set                    -> exit 0, names only
//   gate-missing-each    each var unset in turn          -> exit 1, names it
//   gate-blank           whitespace credential           -> exit 1
//   gate-usage           unknown flag / missing --env    -> exit 2
//   mirror-valid-zero    valid SHA, 0s delay             -> exit 0, fast
//   mirror-bad-sha       non-hex MERGE_SHA               -> exit 2
//   mirror-bad-delay     negative MIRROR_POLL_SECONDS    -> exit 2
//   trigger-pure         URL building, status predicates, arg validation
//   smoke-pure           log normalization, ready-line + freshness logic
//   workflow-uses-guard  deploy.yml calls all four scripts
//   workflow-has-no-skip no step gated on secrets/target presence
//
// Usage: node scripts/deploy-target-selftest.mjs
// Exit: 0 all green, 1 a case failed. Stdlib only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  findMissing as gateFindMissing,
  parseArgs as gateParseArgs,
} from "./check-deploy-target.mjs";
import {
  DEFAULT_POLL_SECONDS as MIRROR_DEFAULT,
  parseOptions as mirrorParseOptions,
  settleMessage,
  sleep as mirrorSleep,
} from "./wait-for-host-mirror.mjs";
import {
  apiGetJson,
  appHealthy,
  deployUrl,
  deploymentTerminal,
  parseArgs as triggerParseArgs,
  summarizeDeployResponse,
} from "./wait-for-coolify-deploy.mjs";
import {
  findBotRecords,
  findReadyLines,
  jsonCandidates,
  maxTimestampMs,
  normalizeLogPayload,
  parseArgs as smokeParseArgs,
} from "./smoke-staging-deploy.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/deploy-target-selftest.mjs");
  process.exit(0);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "deploy.yml");

// Fake panel values. Never contacted: every case that would reach the
// network lives in deploy.yml, not here. The redaction case asserts the
// credential value never appears in output.
const FAKE = {
  COOLIFY_URL: "https://panel.example.invalid",
  COOLIFY_TOKEN: "NOT-A-REAL-TOKEN-Z9Q8",
  TWO_BOT_STAGING_APP_UUID: "app-uuid-not-real-0001",
  TWO_BOT_PRODUCTION_APP_UUID: "app-uuid-not-real-0002",
};

const GATE = join(ROOT, "scripts", "check-deploy-target.mjs");
const MIRROR = join(ROOT, "scripts", "wait-for-host-mirror.mjs");

function scrubbedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of ["COOLIFY_URL", "COOLIFY_TOKEN", "COOLIFY_APP_UUID"]) delete env[name];
  return { ...env, ...overrides };
}

function runGate(args, extraEnv = {}) {
  return spawnSync(process.execPath, [GATE, ...args], {
    env: scrubbedEnv({ ...FAKE, COOLIFY_APP_UUID: FAKE.TWO_BOT_STAGING_APP_UUID, ...extraEnv }),
    encoding: "utf8",
  });
}

const GATE_ARGS = [
  "--env-name",
  "staging",
  "--credential-env",
  "COOLIFY_TOKEN",
  "--require-env",
  "COOLIFY_URL",
  "--require-env",
  "TWO_BOT_STAGING_APP_UUID",
];

// --- check-deploy-target.mjs -------------------------------------------------

test("gate-ready: all vars set exits 0, prints names only", () => {
  const run = runGate(GATE_ARGS);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /READY deploy-target \(staging\)/);
  assert.match(run.stdout, /COOLIFY_TOKEN/);
  assert.doesNotMatch(run.stdout + run.stderr, /NOT-A-REAL-TOKEN-Z9Q8/);
});

for (const missing of ["COOLIFY_TOKEN", "COOLIFY_URL", "TWO_BOT_STAGING_APP_UUID"]) {
  test(`gate-missing: unset ${missing} exits 1 and names it`, () => {
    const env = { ...FAKE, COOLIFY_APP_UUID: FAKE.TWO_BOT_STAGING_APP_UUID };
    delete env[missing === "COOLIFY_TOKEN" ? "COOLIFY_TOKEN" : missing];
    // COOLIFY_APP_UUID is the script-facing alias; map the staging UUID case.
    if (missing === "TWO_BOT_STAGING_APP_UUID") env.COOLIFY_APP_UUID = "";
    const run = spawnSync(process.execPath, [GATE, ...GATE_ARGS], {
      env: scrubbedEnv(env),
      encoding: "utf8",
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /FAIL deploy-target \(staging\)/);
    assert.match(run.stderr, new RegExp(missing));
    assert.match(run.stderr, /TOG-913/);
  });
}

test("gate-blank: whitespace credential exits 1", () => {
  const run = runGate(GATE_ARGS, { COOLIFY_TOKEN: "  \n " });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /FAIL deploy-target/);
});

test("gate-usage: unknown flag exits 2", () => {
  const run = runGate(["--env-name", "staging", "--bogus", "x"]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
});

test("gate-usage: missing --env-name exits 2", () => {
  const run = runGate(["--credential-env", "COOLIFY_TOKEN"]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
});

test("gate unit: findMissing treats blank as missing", () => {
  const lookup = (name) => ({ A: "x", B: "  ", C: "" }[name]);
  assert.deepEqual(gateFindMissing(["A", "B", "C", "D"], lookup), ["B", "C", "D"]);
});

test("gate unit: parseArgs collects repeatable --require-env", () => {
  const parsed = gateParseArgs(["--env-name", "prod", "--credential-env", "TOK", "--require-env", "A", "--require-env", "B"]);
  assert.deepEqual(parsed, { envName: "prod", credentialEnv: "TOK", requireEnv: ["A", "B"] });
});

// --- wait-for-host-mirror.mjs ------------------------------------------------

test("mirror-valid-zero: valid SHA with 0s delay exits 0 fast", () => {
  const started = Date.now();
  const run = spawnSync(process.execPath, [MIRROR], {
    env: scrubbedEnv({ MERGE_SHA: "a".repeat(40), MIRROR_POLL_SECONDS: "0" }),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /MIRROR-SETTLE: waiting 0s/);
  assert.match(run.stdout, /aaaaaaaaaaaa/);
  assert.ok(Date.now() - started < 10_000, "zero-delay settle must not sleep");
});

test("mirror-bad-sha: non-hex MERGE_SHA exits 2", () => {
  const run = spawnSync(process.execPath, [MIRROR], {
    env: scrubbedEnv({ MERGE_SHA: "not-a-sha" }),
    encoding: "utf8",
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /Invalid MERGE_SHA/);
});

test("mirror-bad-delay: negative MIRROR_POLL_SECONDS exits 2", () => {
  const run = spawnSync(process.execPath, [MIRROR], {
    env: scrubbedEnv({ MERGE_SHA: "b".repeat(40), MIRROR_POLL_SECONDS: "-5" }),
    encoding: "utf8",
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /Invalid MIRROR_POLL_SECONDS/);
});

test("mirror unit: parseOptions defaults to just over one interval", () => {
  assert.equal(mirrorParseOptions("c".repeat(40), undefined).seconds, MIRROR_DEFAULT);
  assert.ok(MIRROR_DEFAULT >= 120, "default must cover the ~2min mirror interval");
  assert.throws(() => mirrorParseOptions("short", undefined), /Invalid MERGE_SHA/);
  assert.throws(() => mirrorParseOptions("d".repeat(40), "x"), /Invalid MIRROR_POLL_SECONDS/);
});

test("mirror unit: settleMessage names the commit and the reason", () => {
  const msg = settleMessage("e".repeat(40), 150);
  assert.match(msg, /eeeeeeeeeeee/);
  assert.match(msg, /not github\.com/);
});

test("mirror unit: sleep resolves", async () => {
  await mirrorSleep(1);
});

// --- wait-for-coolify-deploy.mjs (pure, no network) --------------------------

test("trigger unit: deployUrl is a bearer-header trigger, never token-in-URL", () => {
  const url = deployUrl("https://panel.example.invalid", "uuid-1");
  assert.equal(url, "https://panel.example.invalid/api/v1/deploy?uuid=uuid-1&force=true");
  assert.doesNotMatch(url, /NOT-A-REAL-TOKEN/);
});

test("trigger unit: summarizeDeployResponse reads the first deployment", () => {
  assert.equal(
    summarizeDeployResponse({ deployments: [{ deployment_uuid: "dep-1" }, { deployment_uuid: "dep-2" }] }),
    "dep-1",
  );
  assert.equal(summarizeDeployResponse({}), "");
  assert.equal(summarizeDeployResponse(null), "");
});

test("trigger unit: deploymentTerminal only on finished/failed/cancelled", () => {
  assert.equal(deploymentTerminal("finished"), true);
  assert.equal(deploymentTerminal("failed"), true);
  assert.equal(deploymentTerminal("cancelled"), true);
  assert.equal(deploymentTerminal("queued"), false);
  assert.equal(deploymentTerminal("running"), false);
  assert.equal(deploymentTerminal(""), false);
});

test("trigger unit: appHealthy requires running:healthy, rejects bare running", () => {
  assert.equal(appHealthy("running:healthy"), true);
  assert.equal(appHealthy("running"), false);
  assert.equal(appHealthy("running:unhealthy"), false);
  assert.equal(appHealthy("exited:unhealthy"), false);
  assert.equal(appHealthy(""), false);
  assert.equal(appHealthy(null), false);
});

test("trigger unit: parseArgs fails closed on missing env", () => {
  const lookup = () => "";
  assert.throws(() => triggerParseArgs(["--env-name", "staging"], lookup), /Missing COOLIFY_URL, COOLIFY_TOKEN, COOLIFY_APP_UUID/);
  assert.throws(() => triggerParseArgs([], lookup), /Missing required --env-name/);
  assert.throws(() => triggerParseArgs(["--env-name", "s", "--bogus", "x"], lookup), /Unknown argument/);
});

test("trigger unit: parseArgs strips a trailing panel slash", () => {
  const lookup = (name) => ({ COOLIFY_URL: "https://panel.example.invalid/", COOLIFY_TOKEN: "t", COOLIFY_APP_UUID: "u" }[name]);
  const parsed = triggerParseArgs(["--env-name", "staging"], lookup);
  assert.equal(parsed.panelUrl, "https://panel.example.invalid");
});

test("trigger unit: apiGetJson is exported for the panel reads", () => {
  assert.equal(typeof apiGetJson, "function");
});

// --- smoke-staging-deploy.mjs (pure, no network) -----------------------------

test("smoke unit: normalizeLogPayload handles string, array and object shapes", () => {
  assert.deepEqual(normalizeLogPayload('a\nb'), [
    { text: "a", ts: null },
    { text: "b", ts: null },
  ]);
  assert.deepEqual(normalizeLogPayload(["x", 42, null]), [{ text: "x", ts: null }]);
  assert.deepEqual(
    normalizeLogPayload({ logs: [{ message: "m", timestamp: "2026-09-28T09:40:00.000Z" }] }),
    [{ text: "m", ts: "2026-09-28T09:40:00.000Z" }],
  );
  assert.deepEqual(normalizeLogPayload({ nope: 1 }), []);
});

test("smoke unit: findBotRecords parses embedded bot JSON, skips noise", () => {
  const lines = normalizeLogPayload(
    'prefix {"ts":"2026-09-28T09:41:00.000Z","level":"info","msg":"ready","user":"Owen","guilds":1} suffix\nnot json\n{"msg":"other"}\n{"level":"info"}\n',
  );
  const records = findBotRecords(lines);
  assert.equal(records.length, 2);
  assert.equal(records[0].record.msg, "ready");
  assert.equal(records[0].tsMs, Date.parse("2026-09-28T09:41:00.000Z"));
  assert.equal(records[1].record.msg, "other");
});

test("smoke unit: findReadyLines requires guilds >= 1", () => {
  const records = [
    { record: { msg: "ready", guilds: 1 }, tsMs: 1 },
    { record: { msg: "ready", guilds: 0 }, tsMs: 2 },
    { record: { msg: "ready" }, tsMs: 3 },
    { record: { msg: "health_listening" }, tsMs: 4 },
  ];
  assert.deepEqual(findReadyLines(records), [records[0]]);
});

test("smoke unit: maxTimestampMs takes the max, NaN when none", () => {
  assert.equal(maxTimestampMs([{ tsMs: 5 }, { tsMs: NaN }, { tsMs: 9 }]), 9);
  assert.ok(Number.isNaN(maxTimestampMs([])));
  assert.ok(Number.isNaN(maxTimestampMs([{ tsMs: NaN }])));
});

test("smoke unit: jsonCandidates finds nested objects", () => {
  const found = jsonCandidates('a {"x": {"y": 1}} b');
  assert.ok(found.includes('{"x": {"y": 1}}'));
});

test("smoke unit: parseArgs requires --since and valid env", () => {
  const lookup = (name) => ({ COOLIFY_URL: "https://p.invalid", COOLIFY_TOKEN: "t", COOLIFY_APP_UUID: "u" }[name]);
  const parsed = smokeParseArgs(["--env-name", "staging", "--since", "2026-09-28T09:40:00.000Z"], lookup);
  assert.equal(parsed.sinceMs, Date.parse("2026-09-28T09:40:00.000Z"));
  assert.throws(() => smokeParseArgs(["--env-name", "s"], lookup), /Missing required --since/);
  assert.throws(() => smokeParseArgs(["--env-name", "s", "--since", "yesterday"], lookup), /Invalid --since/);
  assert.throws(
    () => smokeParseArgs(["--env-name", "s", "--since", "2026-09-28T09:40:00.000Z"], () => ""),
    /Missing COOLIFY_URL, COOLIFY_TOKEN, COOLIFY_APP_UUID/,
  );
});

// --- deploy.yml wiring (the TOG-913 shape) -----------------------------------

test("workflow-uses-guard: deploy.yml calls all four deploy scripts", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  for (const script of [
    "scripts/check-deploy-target.mjs",
    "scripts/wait-for-host-mirror.mjs",
    "scripts/wait-for-coolify-deploy.mjs",
    "scripts/smoke-staging-deploy.mjs",
  ]) {
    assert.match(workflow, new RegExp(script.replace(/\./g, "\\."), "m"), `${script} must be called from deploy.yml`);
  }
});

test("workflow-has-no-skip: no step gated on secrets or target presence", () => {
  // The TOG-913 defect shape is an `if:` that branches on a secret or a
  // guard output (ready == 'true'), letting a missing target sail through
  // as a pass. Passing secrets via `env:` is proper secret-passing, not a
  // skip branch — only `if:` lines are suspect. Job-level `if:` on
  // `github.event_name` / `needs.*.result` (event routing, staging-before-
  // production chaining) is the intended gating and is not flagged.
  const workflow = readFileSync(WORKFLOW, "utf8");
  const gated = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("if:") && /secrets\.|steps\.\w+\.outputs/.test(line));
  assert.deepEqual(gated, [], `no step may branch on secret/target presence, found: ${gated.join("; ")}`);
  assert.doesNotMatch(workflow, /continue-on-error/, "deploy steps must not swallow failures");
});
