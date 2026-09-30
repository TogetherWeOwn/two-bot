#!/usr/bin/env node

// Self-test for the TOG-6911 deploy scripts.
//
// scripts/check-deploy-target.mjs, scripts/wait-for-host-mirror.mjs,
// scripts/broker-deploy.mjs and scripts/broker-smoke.mjs exist so that a
// deploy job FAILS when there is no broker target, no broker, or no healthy
// release — never skip-and-passes (TOG-913). A guard that has never been
// observed to fail is indistinguishable from one that cannot fail, so this
// executes each script once per configuration and pins the exit code and the
// reason (in-org precedent: two-web ci/deploy-target-selftest.sh).
//
// TRANSPORT (2026-09-28 correction). Actions holds NO panel bearer: staging
// goes through the staging-only broker (ops/staging-deploy-broker/server.mjs)
// with the scoped STAGING_BROKER_TOKEN, and the broker's own hermetic suite
// (ops/staging-deploy-broker/server.test.mjs) pins its server-side authority.
// The retired panel-bearer clients (wait-for-coolify-deploy.mjs,
// smoke-staging-deploy.mjs) remain in the tree for the post-TOG-6903
// production broker path but are NOT wired into any job: deploy.yml must
// reference no panel bearer and no caller-supplied app UUID in staging.
//
// Nothing here needs the network, a token, GitHub, or a deploy target. The
// interesting cases are precisely the ones where no target exists. Pure
// functions are imported and asserted in-process; CLI exit codes go through
// spawned node with scrubbed env (every STAGING_BROKER_* value is fake).
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
//   broker-trigger-pure  staging-only refusal, status predicates, arg validation
//   broker-url-policy    https-only off loopback, no creds, no path, both clients
//   broker-smoke-pure    log normalization, ready-line + freshness logic
//   workflow-uses-guard  deploy.yml calls the broker scripts, never the panel ones
//   workflow-no-panel    staging carries no panel bearer / caller app UUID
//   workflow-broker-url  staging gate requires STAGING_BROKER_URL
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
  appHealthy as brokerAppHealthy,
  brokerJson,
  deploymentTerminal as brokerDeploymentTerminal,
  parseArgs as brokerTriggerParseArgs,
  resolveBrokerUrl as brokerTriggerResolveUrl,
} from "./broker-deploy.mjs";
import {
  findBotRecords,
  findReadyLines,
  jsonCandidates,
  maxTimestampMs,
  normalizeLogPayload,
  parseArgs as brokerSmokeParseArgs,
  resolveBrokerUrl as brokerSmokeResolveUrl,
} from "./broker-smoke.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "deploy.yml");

// Fake broker values. Never contacted: every case that would reach the
// network lives in deploy.yml, not here. The redaction case asserts the
// credential value never appears in output.
const FAKE = {
  STAGING_BROKER_TOKEN: "NOT-A-REAL-TOKEN-Z9Q8",
  STAGING_BROKER_URL: "http://127.0.0.1:8091",
  MERGE_SHA: "a".repeat(40),
};

const GATE = join(ROOT, "scripts", "check-deploy-target.mjs");
const MIRROR = join(ROOT, "scripts", "wait-for-host-mirror.mjs");

function scrubbedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of [
    "COOLIFY_URL", "COOLIFY_TOKEN", "COOLIFY_APP_UUID",
    "TWO_BOT_STAGING_APP_UUID", "TWO_BOT_PRODUCTION_APP_UUID",
    "STAGING_BROKER_TOKEN", "STAGING_BROKER_URL", "MERGE_SHA",
  ]) delete env[name];
  return { ...env, ...overrides };
}

function runGate(args, extraEnv = {}) {
  return spawnSync(process.execPath, [GATE, ...args], {
    env: scrubbedEnv({ ...FAKE, ...extraEnv }),
    encoding: "utf8",
  });
}

const GATE_ARGS = [
  "--env-name",
  "staging",
  "--credential-env",
  "STAGING_BROKER_TOKEN",
  "--require-env",
  "STAGING_BROKER_URL",
  "--require-env",
  "MERGE_SHA",
];

// --- check-deploy-target.mjs -------------------------------------------------

test("gate-ready: all vars set exits 0, prints names only", () => {
  const run = runGate(GATE_ARGS);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /READY deploy-target \(staging\)/);
  assert.match(run.stdout, /STAGING_BROKER_TOKEN/);
  assert.doesNotMatch(run.stdout + run.stderr, /NOT-A-REAL-TOKEN-Z9Q8/);
});

for (const missing of ["STAGING_BROKER_TOKEN", "STAGING_BROKER_URL", "MERGE_SHA"]) {
  test(`gate-missing: unset ${missing} exits 1 and names it`, () => {
    const env = { ...FAKE };
    delete env[missing];
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
  const run = runGate(GATE_ARGS, { STAGING_BROKER_TOKEN: "  \n " });
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

// --- broker-deploy.mjs (pure, no network) ----------------------------------

test("broker unit: rejects non-staging env names", () => {
  const lookup = () => "";
  assert.throws(() => brokerTriggerParseArgs(["--env-name", "production"], lookup), /staging only/);
  assert.throws(() => brokerTriggerParseArgs([], lookup), /Missing required --env-name/);
  assert.throws(() => brokerTriggerParseArgs(["--env-name", "s", "--bogus", "x"], lookup), /Unknown argument/);
});

test("broker unit: parseArgs fails closed on missing token or SHA", () => {
  const lookup = () => "";
  assert.throws(
    () => brokerTriggerParseArgs(["--env-name", "staging"], lookup),
    /Missing STAGING_BROKER_TOKEN, MERGE_SHA/,
  );
  assert.throws(
    () => brokerTriggerParseArgs(["--env-name", "staging"], (n) => ({ STAGING_BROKER_TOKEN: "t" })[n] ?? ""),
    /MERGE_SHA/,
  );
});

test("broker unit: parseArgs accepts a valid SHA and pins repo staging-only", () => {
  const sha = "b".repeat(40);
  const lookup = (name) => ({ STAGING_BROKER_TOKEN: "t", MERGE_SHA: sha }[name] ?? "");
  const parsed = brokerTriggerParseArgs(["--env-name", "staging"], lookup);
  assert.equal(parsed.sha, sha);
  assert.equal(parsed.brokerUrl, "http://127.0.0.1:8091");
  const withUrl = brokerTriggerParseArgs(["--env-name", "staging"], (name) =>
    name === "STAGING_BROKER_URL" ? "http://127.0.0.1:8091/" : lookup(name),
  );
  assert.equal(withUrl.brokerUrl, "http://127.0.0.1:8091");
});

test("broker unit: resolveBrokerUrl is fail-closed and identical in both clients", () => {
  // Deploy jobs run on ubuntu-latest (public repo, #304): the broker is
  // reached over public HTTPS through the host proxy. Plaintext off loopback
  // would send the broker token unencrypted; credentials-in-URL would leak it
  // into logs; a path prefix would 404 every absolute broker route. All three
  // refuse before any request is sent. Both clients carry the same policy
  // (duplicated, stdlib-only, no shared module), so both resolvers must agree
  // on every case.
  for (const resolve of [brokerTriggerResolveUrl, brokerSmokeResolveUrl]) {
    assert.equal(resolve(""), "http://127.0.0.1:8091");
    assert.equal(resolve(undefined), "http://127.0.0.1:8091");
    assert.equal(resolve("http://127.0.0.1:8091"), "http://127.0.0.1:8091");
    assert.equal(resolve("http://127.0.0.1:8091/"), "http://127.0.0.1:8091");
    assert.equal(resolve("http://[::1]:8091"), "http://[::1]:8091");
    assert.equal(resolve("https://broker.example.invalid"), "https://broker.example.invalid");
    assert.throws(() => resolve("http://broker.example.invalid"), /https/);
    assert.throws(() => resolve("ftp://broker.example.invalid/x"), /http\(s\)/);
    assert.throws(() => resolve("not-a-url"), /http\(s\)/);
    assert.throws(
      () => resolve("https://user:pass@broker.example.invalid"),
      /credential-in-URL/,
    );
    assert.throws(
      () => resolve("https://broker.example.invalid/prefix"),
      /bare origin/,
    );
    assert.throws(
      () => resolve("https://broker.example.invalid?x=1"),
      /bare origin/,
    );
  }
});

test("broker unit: deploymentTerminal only on finished/failed/cancelled", () => {
  assert.equal(brokerDeploymentTerminal("finished"), true);
  assert.equal(brokerDeploymentTerminal("failed"), true);
  assert.equal(brokerDeploymentTerminal("cancelled"), true);
  assert.equal(brokerDeploymentTerminal("queued"), false);
  assert.equal(brokerDeploymentTerminal("running"), false);
  assert.equal(brokerDeploymentTerminal(""), false);
});

test("broker unit: appHealthy requires running:healthy, rejects bare running", () => {
  assert.equal(brokerAppHealthy("running:healthy"), true);
  assert.equal(brokerAppHealthy("running"), false);
  assert.equal(brokerAppHealthy("running:unhealthy"), false);
  assert.equal(brokerAppHealthy("exited:unhealthy"), false);
  assert.equal(brokerAppHealthy(""), false);
  assert.equal(brokerAppHealthy(null), false);
});

test("broker unit: brokerJson helper is exported for the broker reads", () => {
  assert.equal(typeof brokerJson, "function");
});

// --- broker-smoke.mjs (pure, no network) -------------------------------------

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
  const lookup = (name) => ({ STAGING_BROKER_TOKEN: "t" }[name] ?? "");
  const parsed = brokerSmokeParseArgs(["--env-name", "staging", "--since", "2026-09-28T09:40:00.000Z"], lookup);
  assert.equal(parsed.sinceMs, Date.parse("2026-09-28T09:40:00.000Z"));
  assert.throws(() => brokerSmokeParseArgs(["--env-name", "staging"], lookup), /Missing required --since/);
  assert.throws(() => brokerSmokeParseArgs(["--env-name", "staging", "--since", "yesterday"], lookup), /Invalid --since/);
  assert.throws(
    () => brokerSmokeParseArgs(["--env-name", "staging", "--since", "2026-09-28T09:40:00.000Z"], () => ""),
    /Missing STAGING_BROKER_TOKEN/,
  );
  assert.throws(() => brokerSmokeParseArgs(["--env-name", "production", "--since", "2026-09-28T09:40:00.000Z"], lookup), /staging only/);
});

// --- deploy.yml wiring (the TOG-913 shape) -----------------------------------

test("workflow-uses-guard: deploy.yml calls the broker deploy scripts", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  for (const script of [
    "scripts/check-deploy-target.mjs",
    "scripts/wait-for-host-mirror.mjs",
    "scripts/broker-deploy.mjs",
    "scripts/broker-smoke.mjs",
  ]) {
    assert.match(workflow, new RegExp(script.replace(/\./g, "\\."), "m"), `${script} must be called from deploy.yml`);
  }
});

test("workflow-no-panel: staging carries no panel bearer or caller app UUID", () => {
  // The 2026-09-28 correction: the live panel token is NOT app-scoped, so no
  // staging step may read COOLIFY_TOKEN, COOLIFY_URL or a caller-supplied app
  // UUID. Staging speaks to the broker with STAGING_BROKER_TOKEN only (the
  // production HOLD job is allowed its own PRODUCTION_BROKER_TOKEN gate names).
  const workflow = readFileSync(WORKFLOW, "utf8");
  const staging = workflow.split("deploy-production:")[0];
  assert.doesNotMatch(staging, /COOLIFY_TOKEN/, "staging must not reference the panel bearer");
  assert.doesNotMatch(staging, /COOLIFY_APP_UUID/, "staging must not take a caller-supplied app UUID");
  assert.doesNotMatch(staging, /TWO_BOT_STAGING_APP_UUID/, "staging must not take a caller-supplied app UUID");
  assert.doesNotMatch(staging, /COOLIFY_URL/, "staging must not reference the panel URL");
  assert.doesNotMatch(staging, /wait-for-coolify-deploy/, "staging must not call the retired panel client");
  assert.doesNotMatch(staging, /smoke-staging-deploy/, "staging must not call the retired panel client");
  assert.match(staging, /STAGING_BROKER_TOKEN/, "staging gates and triggers carry the scoped broker credential");
  assert.match(staging, /MERGE_SHA/, "staging trigger pins the merge commit for broker validation");
});

test("workflow-broker-url: staging gate requires STAGING_BROKER_URL", () => {
  // Deploy jobs run on ubuntu-latest (public repo, #304), so host loopback is
  // unreachable from the runner. The clients fall back to the loopback
  // default only when STAGING_BROKER_URL is empty/unset (local smoke); in CI
  // the gate must require the public https:// origin, or a missing secret
  // would send the trigger at unreachable loopback and fail confusingly
  // instead of naming the missing secret (TOG-913).
  const workflow = readFileSync(WORKFLOW, "utf8");
  const staging = workflow.split("deploy-production:")[0];
  assert.match(staging, /--require-env STAGING_BROKER_URL/, "staging gate must require the broker origin");
  assert.match(staging, /STAGING_BROKER_URL: \$\{\{ secrets\.STAGING_BROKER_URL \}\}/, "staging passes the broker origin from secrets");
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
