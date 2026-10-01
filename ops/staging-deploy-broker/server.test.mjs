#!/usr/bin/env node

// Hermetic tests for the staging-only deploy broker (server.mjs, TOG-6911).
//
// Nothing here needs the network, a panel token, GitHub, or a deploy target:
// the tests boot the REAL request handler with a STUB panel function on a
// loopback ephemeral port and drive it over HTTP. The stub records what the
// broker asked the panel to do, so the pinning ("server-side authority admits
// only the staging app") is observed, not assumed.
//
// What is pinned:
//
//   config-rejects-*        non-https panel URL, public bind, re-pointed app
//                           UUID, short token -> parseConfig throws
//   healthz-open            GET /healthz answers without auth
//   auth-*                  missing/garbage/short bearer -> 401 on every
//                           protected route; error bodies carry static codes
//   deploy-validation       wrong repo / bad sha -> 400; foreign appUuid or
//                           production env label -> 403; valid body -> 200 and
//                           the stub panel saw the PINNED staging UUID
//   deploy-no-client-uuid   a body carrying the pinned UUID itself still
//                           deploys the pinned app (client value never steers)
//   redaction               app/deployment reads return {status} ONLY, even
//                           when the panel leaks extra fields; deployment
//                           reads serve only IDs this broker issued (foreign
//                           IDs 404 without reaching the panel); no error body
//                           anywhere contains the panel token or panel URL
//   logs-bounded            lines=0 / lines=9999 -> 400; valid -> shaped
//   logs-redaction          fake bot-token + sensitive panel fields never
//                           cross the boundary; ready-line JSON structure
//                           survives for the smoke parser
//   routing                 unknown path -> 404, wrong method -> 405
//
// Usage: node --test ops/staging-deploy-broker/server.test.mjs
// Exit: 0 all green, 1 a case failed. Stdlib only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import { findBotRecords, findReadyLines, normalizeLogPayload } from "../../scripts/broker-smoke.mjs";

import {
  applyPemContext,
  checkAuth,
  createHandler,
  extractJsonCandidates,
  parseConfig,
  parseLogLines,
  PINNED_REPO,
  PINNED_STAGING_APP_UUID,
  redactPemBlock,
  scrubSecrets,
  SECRET_PLACEHOLDER,
  shapeEmbeddedText,
  shapeLogs,
  shapeLogItem,
  shapeLogValue,
  shapeStatus,
  shapeTimestamp,
  validateDeployBody,
} from "./server.mjs";

const BROKER_TOKEN = "staging-broker-token-fake-0123456789";
const PANEL_TOKEN = "PANEL-BEARER-FAKE-abcdef-0123456789";
const PANEL_URL = "https://panel.example.invalid";
const GOOD_SHA = "a".repeat(40);
// Marker labels are synthetic; constructing them avoids scanner false positives.
const PEM_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PEM_END = "-----END RSA " + "PRIVATE KEY-----";

function testConfig() {
  return {
    brokerToken: BROKER_TOKEN,
    panelUrl: PANEL_URL,
    panelToken: PANEL_TOKEN,
    port: 0,
    bind: "127.0.0.1",
    appUuid: PINNED_STAGING_APP_UUID,
  };
}

/** Boot the real handler with a stub panel. Returns { base, calls, close }. */
async function boot(stub, config = testConfig()) {
  const calls = [];
  const panel = async (args) => {
    calls.push(args);
    return stub(args);
  };
  const server = createServer(createHandler(config, panel));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function req(base, path, { method = "GET", token = BROKER_TOKEN, body = undefined } = {}) {
  const headers = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON is itself a finding */
  }
  return { status: res.status, json, text };
}

function assertRedacted(t, { status, json, text }) {
  assert.ok(json !== null, "every broker response is JSON");
  assert.doesNotMatch(text, /PANEL-BEARER-FAKE/, "panel bearer never appears in a broker response");
  assert.doesNotMatch(text, /panel\.example\.invalid/, "panel URL never appears in a broker response");
  // Literal inclusion, never a built-from-value RegExp: partial manual
  // escaping (e.g. dots only) trips the incomplete-escaping check (TOG-9053).
  assert.ok(!text.includes(BROKER_TOKEN), "broker token never appears in a broker response");
  return { status, json, text };
}

// --- config ----------------------------------------------------------------

test("config-rejects: non-https panel URL refuses to start", () => {
  assert.throws(
    () => parseConfig({ STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: "http://panel.example.invalid", COOLIFY_TOKEN: "t" }),
    /https/,
  );
});

test("config-rejects: public bind refuses to start", () => {
  assert.throws(
    () => parseConfig({ STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: "t", STAGING_BROKER_BIND: "0.0.0.0" }),
    /loopback/,
  );
});

test("config-rejects: re-pointed app UUID refuses to start", () => {
  assert.throws(
    () => parseConfig({ STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: "t", STAGING_APP_UUID: "production-app-uuid" }),
    /pinned/,
  );
});

test("config-rejects: short broker token refuses to start", () => {
  assert.throws(
    () => parseConfig({ STAGING_BROKER_TOKEN: "short", COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: "t" }),
    /STAGING_BROKER_TOKEN/,
  );
});

test("config-accepts: matching STAGING_APP_UUID override starts", () => {
  const config = parseConfig({
    STAGING_BROKER_TOKEN: BROKER_TOKEN,
    COOLIFY_URL: PANEL_URL,
    COOLIFY_TOKEN: "t",
    STAGING_APP_UUID: PINNED_STAGING_APP_UUID,
  });
  assert.equal(config.appUuid, PINNED_STAGING_APP_UUID);
});

test("auth unit: checkAuth rejects missing, malformed and short bearers", () => {
  assert.equal(checkAuth(undefined, BROKER_TOKEN), false);
  assert.equal(checkAuth("Basic abc", BROKER_TOKEN), false);
  assert.equal(checkAuth("Bearer short", BROKER_TOKEN), false);
  assert.equal(checkAuth(`Bearer ${BROKER_TOKEN}`, BROKER_TOKEN), true);
});

// --- auth + routing ---------------------------------------------------------

test("healthz-open: GET /healthz answers without auth", async (t) => {
  const srv = await boot(() => ({}));
  t.after(srv.close);
  const { status, json } = await req(srv.base, "/healthz", { token: null });
  assert.equal(status, 200);
  assert.equal(json.service, "two-staging-broker");
});

test("auth-required: protected routes 401 without or with a bad bearer", async (t) => {
  const srv = await boot(() => ({}));
  t.after(srv.close);
  for (const path of ["/v1/staging/app", "/v1/staging/logs", "/v1/staging/deployments/dep-1"]) {
    for (const token of [null, "garbage", "short"]) {
      const out = assertRedacted(t, await req(srv.base, path, { token }));
      assert.equal(out.status, 401, `${path} with token ${token}`);
      assert.equal(out.json.error, "unauthorized");
    }
  }
  const out = assertRedacted(
    t,
    await req(srv.base, "/v1/staging/deploy", { method: "POST", token: null, body: { repo: PINNED_REPO, sha: GOOD_SHA } }),
  );
  assert.equal(out.status, 401);
  assert.deepEqual(srv.calls, [], "unauthenticated deploy must never reach the panel");
});

test("routing: unknown path 404, wrong method 405", async (t) => {
  const srv = await boot(() => ({}));
  t.after(srv.close);
  const notFound = assertRedacted(t, await req(srv.base, "/v1/production/deploy"));
  assert.equal(notFound.status, 404);
  const wrongMethod = assertRedacted(t, await req(srv.base, "/v1/staging/app", { method: "POST", body: {} }));
  assert.equal(wrongMethod.status, 405);
});

// --- deploy validation ------------------------------------------------------

test("deploy-validation: wrong repo or bad sha is 400 and never reaches the panel", async (t) => {
  const srv = await boot(() => ({}));
  t.after(srv.close);
  for (const body of [
    { repo: "TogetherWeOwn/two-web", sha: GOOD_SHA },
    { repo: PINNED_REPO, sha: "not-a-sha" },
    { repo: PINNED_REPO },
    { sha: GOOD_SHA },
    "not-json",
  ]) {
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/deploy", { method: "POST", body }));
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(srv.calls, []);
});

test("deploy-validation: foreign appUuid or production label is 403", async (t) => {
  const srv = await boot(() => ({}));
  t.after(srv.close);
  const bases = { repo: PINNED_REPO, sha: GOOD_SHA };
  for (const body of [
    { ...bases, appUuid: "cangagerae31txrk2vfvzzyq" },
    { ...bases, uuid: "anything-else" },
    { ...bases, env: "production" },
    { ...bases, environment: "production" },
    { ...bases, target: "production" },
  ]) {
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/deploy", { method: "POST", body }));
    assert.equal(out.status, 403, JSON.stringify(body));
  }
  assert.deepEqual(srv.calls, [], "rejected deploys must never reach the panel");
});

test("deploy-no-client-uuid: valid body deploys the PINNED staging app", async (t) => {
  const srv = await boot(() => ({ deployments: [{ deployment_uuid: "dep-staging-1" }] }));
  t.after(srv.close);
  for (const body of [
    { repo: PINNED_REPO, sha: GOOD_SHA },
    { repo: PINNED_REPO, sha: GOOD_SHA.toUpperCase(), appUuid: PINNED_STAGING_APP_UUID, env: "staging" },
  ]) {
    const { status, json } = await req(srv.base, "/v1/staging/deploy", { method: "POST", body });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(json.deployment_uuid, "dep-staging-1");
  }
  assert.equal(srv.calls.length, 2);
  for (const call of srv.calls) {
    assert.match(call.path, new RegExp(`uuid=${PINNED_STAGING_APP_UUID}`), "panel trigger carries the pinned UUID, never a client value");
    assert.doesNotMatch(call.path, /cangagerae31txrk2vfvzzyq/, "production UUID can never be steered through the broker");
    assert.equal(call.method, "POST");
  }
});

// --- redaction + bounds -----------------------------------------------------

test("redaction: app and deployment reads return {status} only", async (t) => {
  const srv = await boot((args) =>
    args.method === "POST"
      ? { deployments: [{ deployment_uuid: "dep-issued-redact-1" }] }
      : {
          status: "running:healthy",
          uuid: PINNED_STAGING_APP_UUID,
          git_repository: "git@135.148.42.223:/srv/git/two-bot.git",
          internal_secret: "should-never-leave",
        },
  );
  t.after(srv.close);
  const app = assertRedacted(t, await req(srv.base, "/v1/staging/app"));
  assert.equal(app.status, 200);
  assert.deepEqual(app.json, { status: "running:healthy" });
  // Deployment reads serve only IDs this broker process queued via POST
  // /v1/staging/deploy (TOG-9053 finding 4): boot a deploy first, then read
  // exactly that ID. The deploy stub below answers the trigger shape; the app
  // stub above already handles /v1/staging/app.
  const queued = await req(srv.base, "/v1/staging/deploy", {
    method: "POST",
    body: { repo: PINNED_REPO, sha: GOOD_SHA },
  });
  assert.equal(queued.status, 200);
  const issuedId = queued.json.deployment_uuid;
  assert.ok(issuedId, "trigger must return a deployment id");
  const dep = assertRedacted(t, await req(srv.base, `/v1/staging/deployments/${issuedId}`));
  assert.equal(dep.status, 200);
  assert.deepEqual(dep.json, { status: "running:healthy" });
  const badId = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/abc"));
  assert.equal(badId.status, 400);
  const traversal = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/%2e%2e%2fetc"));
  assert.ok([400, 404].includes(traversal.status), "encoded traversal never reaches the panel");
});

test("deployment-scope: well-formed foreign IDs 404 without reaching the panel", async (t) => {
  // TOG-9053 finding 4: the panel bearer is broad, so a caller-supplied ID
  // that is merely well-formed must NOT be forwarded to `deployments/<id>` —
  // a foreign (production) deployment UUID would otherwise come back as
  // {status:"finished"} with 200. Unknown IDs get the static
  // unknown_deployment and the panel is never called.
  let panelCalls = 0;
  const srv = await boot((args) => {
    panelCalls += 1;
    return { status: "finished", uuid: "foreign-production-app" };
  });
  t.after(srv.close);
  const foreign = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/dep-foreign-prod-9"));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, { error: "unknown_deployment" });
  assert.equal(panelCalls, 0, "foreign deployment read must never reach the panel");
  assert.equal(srv.calls.length, 0);
});

test("redaction unit: shapeStatus keeps status only", () => {
  assert.deepEqual(shapeStatus({ status: "finished", token: "x", url: "y" }), { status: "finished" });
  assert.deepEqual(shapeStatus(null), { status: "" });
});

test("logs-bounded: out-of-range lines is 400, valid returns shaped logs", async (t) => {
  const srv = await boot((args) => {
    assert.match(args.path, /logs\?lines=200$/);
    return { logs: [{ message: "line" }] };
  });
  t.after(srv.close);
  for (const path of ["/v1/staging/logs?lines=0", "/v1/staging/logs?lines=9999", "/v1/staging/logs?lines=many"]) {
    const out = assertRedacted(t, await req(srv.base, path));
    assert.equal(out.status, 400, path);
  }
  const ok = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(ok.status, 200);
  // Shaped: the panel object crosses as key-redacted JSON text the smoke can
  // still parse (ready-line structure survives), never as the raw object.
  assert.deepEqual(ok.json, { logs: [{ message: '{"message":"line"}' }] });
});

// --- TOG-9053 finding 2 regression -------------------------------------------
// Fake sensitive values. Nothing here is a credential: every value is
// synthetic and labeled fake, and each stays UNDER the gitleaks/tokenleak
// trip shapes by construction — the fake "bot token" is an mfa.-style string
// of 38 chars (the repo rules trip at 80-100; the BROKER's own scrub shape
// trips at 20+, which is the point: the broker must catch MORE than the
// repo-wide sweep). Verified against the shapes, not assumed: if the repo
// rules ever widen, the tokenleak suite names this file, and this test's
// doesNotMatch assertions would go vacuous — the calibration below guards it.
const FAKE_SENSITIVE_PANEL_TOKEN = "PANEL-BEARER-FAKE-abcdef-0123456789";
const FAKE_BOT_TOKEN_TEXT = "mfa.FAKE-NOT-A-REAL-TOKEN-abcdef-0123456789";

test("logs-redaction: fake bot-token text and sensitive panel fields never cross", async (t) => {
  // Calibration: the fixture MUST trip the broker's generic scrub shape, or
  // the scrub assertions below prove nothing.
  assert.match(scrubSecrets(`leaked ${FAKE_BOT_TOKEN_TEXT} end`, []), /\[redacted\]/);
  const fakeBotTokenText = `bot logged token ${FAKE_BOT_TOKEN_TEXT} and bearer Bearer ${FAKE_SENSITIVE_PANEL_TOKEN}`;
  const srv = await boot(() => ({
    status: "finished",
    uuid: "foreign-production-app",
    internal_secret: "panel-field-should-never-leave",
    coolify_token_echo: FAKE_SENSITIVE_PANEL_TOKEN,
    logs: [
      { message: fakeBotTokenText, timestamp: "2026-09-30T03:00:00.000Z" },
      { message: '{"ts":"2026-09-30T03:01:00.000Z","msg":"ready","user":"FakeBot","guilds":1}', timestamp: "2026-09-30T03:01:00.000Z" },
      { message: "plain line, no secrets" },
      { token: "object-token-value-should-never-leave", message: "has sensitive key" },
      42,
      null,
    ],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  // The exact sensitive values are gone, everywhere in the response.
  // Literal inclusion, never a built-from-value RegExp: FAKE values are
  // constant but arbitrary text, so only complete escaping (via a literal)
  // satisfies the CodeQL incomplete-escaping check (TOG-9053).
  assert.ok(!text.includes(FAKE_BOT_TOKEN_TEXT), "fake bot token text must be scrubbed");
  assert.ok(!text.includes(FAKE_SENSITIVE_PANEL_TOKEN), "panel bearer value must be scrubbed");
  assert.doesNotMatch(text, /internal_secret/, "sensitive panel field name must not cross");
  assert.doesNotMatch(text, /panel-field-should-never-leave/, "sensitive panel field value must not cross");
  assert.doesNotMatch(text, /coolify_token_echo/, "echoed credential field name must not cross");
  assert.doesNotMatch(text, /foreign-production-app/, "foreign app UUID must not cross in logs");
  assert.doesNotMatch(text, /object-token-value-should-never-leave/, "sensitive object value must be redacted");
  assert.ok(out.json.logs.length >= 3, "benign lines must survive redaction");
  // The smoke's ready-line JSON structure survives: a {msg:"ready",guilds:1}
  // record is still parseable out of some message in the response.
  const messages = out.json.logs.map((entry) => entry.message).join("\n");
  assert.match(messages, /"msg":"ready"/, "ready-line structure must survive shaping");
  assert.match(messages, /"guilds":1/, "ready-line guilds must survive shaping");
  assert.match(messages, /plain line, no secrets/, "plain text lines pass through scrubbed");
});

// --- TOG-9053 re-review: over-depth + timestamp bypass regressions ---------
// Both fixtures go through the REAL handler with a STUB panel (fake values
// only, nothing live). The gitleaks allowlist names this file's fake-token
// shapes; the calibration above keeps the scrub assertions non-vacuous.

function nestWrappers(inner, levels) {
  let out = inner;
  for (let i = 0; i < levels; i += 1) out = { wrap: out };
  return out;
}

test("logs-redaction: panel token in a timestamp field never crosses", async (t) => {
  const secretTimestamp = `config.panelToken is ${PANEL_TOKEN}`;
  const srv = await boot(() => ({
    logs: [
      { message: "plain line", timestamp: secretTimestamp },
      { message: "other line", ts: 1759200000000 },
    ],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes(PANEL_TOKEN), "panel token smuggled into a timestamp field must not cross");
  const [first, second] = out.json.logs;
  assert.ok(!("timestamp" in first), "non-timestamp value in a timestamp field is dropped from the pair");
  // Object items cross as one JSON message (the smoke's parser shape); the
  // smuggled timestamp text survives inside it ONLY scrubbed.
  assert.equal(JSON.parse(first.message).timestamp, "config.panelToken is [redacted]");
  assert.equal(JSON.parse(first.message).message, "plain line", "benign message text survives timestamp rejection");
  assert.equal(second.timestamp, 1759200000000, "numeric epochs are credential-free and pass through");
});

test("logs-redaction: over-depth nested secret never crosses verbatim", async (t) => {
  const nested = nestWrappers({ password: FAKE_SENSITIVE_PANEL_TOKEN }, 12);
  const srv = await boot(() => ({ logs: [nested] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes(FAKE_SENSITIVE_PANEL_TOKEN), "over-depth nested secret must not cross verbatim");
});

test("logs-redaction: credential-bearing object keys never cross", async (t) => {
  // The configured panel credential smuggled in as a PROPERTY NAME must not
  // survive in the wire response: both shaping branches used to emit `key`
  // verbatim, so the whole bearer crossed as JSON text (TOG-9053 finding 2).
  const srv = await boot(() => ({
    logs: [{ message: "key probe", [PANEL_TOKEN]: "ordinary value" }],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes(PANEL_TOKEN), "credential text in a property name must not cross");
  assert.ok(!text.includes("PANEL-BEARER-FAKE-abcdef"), "credential prefix in a property name must not cross");
});

test("logs-redaction: over-depth JSON-in-string leaves and arrays cross redacted", async (t) => {
  // The depth cutoff applies BEFORE type-specific handling: 11 wrappers put
  // the leaf at depth 11, where the old string branch returned raw scrubbed
  // text before the cutoff — and an arbitrary password is no known token
  // shape, so it crossed unchanged (TOG-9053 finding 2).
  const leaf = '{"password":"ordinary-db-password"}';
  const srv = await boot(() => ({
    logs: [nestWrappers(leaf, 11), nestWrappers(["ordinary-db-password-array"], 11)],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("ordinary-db-password"), "over-depth JSON-in-string leaf must not cross raw");
  assert.ok(!text.includes("ordinary-db-password-array"), "over-depth array leaf must not cross raw");
  assert.ok(text.includes("[redacted]"), "over-depth leaves cross as the placeholder");
});

test("logs-redaction: credential-bearing timestamp metadata is rejected whole", async (t) => {
  // Date.parse accepts a date prefix with a credential smuggled in a trailing
  // comment; truncating BEFORE the secret check then sliced the suffix off and
  // leaked the credential's prefix in the emitted timestamp (TOG-9053
  // finding 2). Length and secret checks now run on the full original value.
  const leakyTs = `Wed, 30 Sep 2026 03:00:00 GMT (${PANEL_TOKEN})`;
  const srv = await boot(() => ({ logs: [{ message: "ts probe", timestamp: leakyTs }] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes(PANEL_TOKEN), "credential in timestamp metadata must not cross");
  assert.ok(!text.includes("PANEL-BEARER-FAKE-abcdef"), "credential prefix in timestamp metadata must not cross");
  // Object items cross as one JSON message: the leaky timestamp survives
  // inside it ONLY scrubbed (message-text pattern), while the pair-level
  // metadata field — the reviewer's actual leak path — is dropped whole.
  const pair = out.json.logs[0];
  assert.ok(!("timestamp" in pair), "leaky timestamp metadata is dropped from the pair");
  const embedded = JSON.parse(pair.message);
  assert.equal(embedded.message, "ts probe", "benign message text survives timestamp rejection");
  assert.equal(
    embedded.timestamp,
    `Wed, 30 Sep 2026 03:00:00 GMT (${SECRET_PLACEHOLDER})`,
    "embedded timestamp survives only scrubbed, never with credential text",
  );
});

test("logs-redaction: prefixed JSON secrets redact, benign prefixed records pass through", async (t) => {
  // One boundary policy across raw, wrapped and embedded inputs (TOG-9053
  // finding 2): a prefixed structured record carries the same secret fields
  // as whole-string JSON. Fixtures are synthetic and scanner-safe (plain
  // words, no high-entropy shapes); nothing here is a credential.
  const rawPrefixed = 'INFO {"password":"ordinary-db-password"}';
  const wrappedPrefixed = { message: 'INFO {"password":"ordinary-db-password"}' };
  const benignPrefixed = 'INFO {"ts":"2026-09-30T03:01:00.000Z","msg":"ready","guilds":1}';
  const srv = await boot(() => ({ logs: [rawPrefixed, wrappedPrefixed, benignPrefixed] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("ordinary-db-password"), "prefixed password value must not cross raw or wrapped");
  assert.ok(text.includes("[redacted]"), "prefixed secret crosses only as the placeholder");
  // Benign prefixed smoke records stay readable: no redaction fires, so the
  // line falls through to scrubbed raw text byte-identical.
  const [rawMsg, wrappedMsg, benignMsg] = out.json.logs.map((entry) => entry.message);
  assert.equal(rawMsg, `INFO {"password":"${SECRET_PLACEHOLDER}"}`, "raw prefixed record shapes in place");
  assert.equal(JSON.parse(wrappedMsg).message, rawMsg, "wrapped prefixed record matches the raw policy");
  assert.equal(benignMsg, benignPrefixed, "benign prefixed record passes through byte-identical");
  // The smoke finds the embedded ready record through its own brace-matching.
  assert.match(benignMsg, /"msg":"ready"/, "ready-line structure survives prefixing");
  assert.match(benignMsg, /"guilds":1/, "ready-line guilds survive prefixing");
});

test("logs-redaction: private-key markers redact short, overlong and incomplete", async (t) => {
  // The BEGIN marker is sensitive even when END is beyond any match window
  // or absent (TOG-9053 finding 2). Synthetic marker blocks: 'X'/'Y' runs,
  // no key material, scanner-safe by construction.
  const shortPem = `${PEM_BEGIN}\n${"X".repeat(100)}\n${PEM_END}`;
  const overlongPem = `${PEM_BEGIN}\n${"X".repeat(6000)}\n${PEM_END}`;
  const incompletePem = `partial dump ${PEM_BEGIN}\n${"Y".repeat(50)}`;
  const srv = await boot(() => ({ logs: [shortPem, overlongPem, incompletePem] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("X".repeat(20)), "no private-key body text crosses, however long");
  assert.ok(!text.includes("Y".repeat(20)), "no incomplete key-block body crosses");
  assert.ok(!text.includes("BEGIN RSA PRIVATE KEY"), "key marker labels never cross");
  assert.equal(out.json.logs.length, 3, "all three marker lines still return a (redacted) message");
});

test("logs-redaction: quoted-brace JSON secrets redact through the handler", async (t) => {
  // The exact shape naive brace counting misaligned: a `}` inside a quoted
  // value ended the span early, JSON.parse failed, and the password crossed
  // as "scrubbed raw" (TOG-9053 finding 2). Scanner-safe: plain words only.
  const srv = await boot(() => ({ logs: ['INFO {"note":"a}b","password":"ordinary-db-password"}'] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("ordinary-db-password"), "quoted-brace password must not cross");
  assert.match(text, /a\}b/, "benign quoted-brace content survives");
});

test("logs-redaction: incomplete PEM with JSON suffix dies whole, never reshaped", async (t) => {
  // PEM redacts FIRST, before JSON parsing: an incomplete block whose END
  // marker is beyond this string still dies to end-of-string, so embedded
  // JSON in the suffix never survives to be shaped and re-emitted
  // (TOG-9053 finding 2). Scanner-safe: plain words only.
  const srv = await boot(() => ({
    logs: [`leak ${PEM_BEGIN} {"password":"ordinary-db-password"}`],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("ordinary-db-password"), "JSON in an incomplete PEM suffix must not resurface");
  assert.ok(!text.includes("BEGIN RSA PRIVATE KEY"), "key marker labels never cross");
});

test("logs-redaction: multiline key block split across log lines never crosses", async (t) => {
  // The generic scrub's PEM rule only protects blocks that are WHOLE when
  // scrubbed; shaping lines in isolation orphaned the body from its marker.
  // PEM context runs BEFORE per-line shaping (TOG-9053 finding 2).
  // Synthetic: 'X' runs, no key material, scanner-safe by construction.
  const srv = await boot(() => ({
    logs: [
      `pre ${PEM_BEGIN}`,
      `line ${"X".repeat(60)} line`,
      `line ${"X".repeat(60)} line ${PEM_END} post`,
    ],
  }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.json);
  assert.ok(!text.includes("X".repeat(20)), "no split key-block body crosses");
  assert.ok(!text.includes("BEGIN RSA PRIVATE KEY"), "key marker labels never cross");
  assert.equal(out.json.logs.length, 3, "all three lines still return a (redacted) message");
});

test("logs-redaction unit: extractJsonCandidates is quote-aware", () => {
  // A `}` inside a double-quoted JSON value (with backslash escapes) does not
  // close a record — naive brace counting misaligned the span, JSON.parse
  // failed, and the password crossed as "scrubbed raw" (TOG-9053 finding 2).
  assert.deepEqual(extractJsonCandidates('{"note":"a}b","k":1}'), [[0, 20]]);
  assert.deepEqual(extractJsonCandidates('{"note":"a\\"b}c","k":1}'), [[0, 23]]);
  assert.deepEqual(extractJsonCandidates("a}b{c}"), [[3, 6]]);
});

test("logs-redaction unit: shapeEmbeddedText shapes every span in one pass", () => {
  // Shaping only the first differing span left secret siblings raw; the
  // string-vs-string equality check let a whitespace-formatted benign span
  // hide the secrets behind it. Sibling spans now shape together in document
  // order while benign records stay byte-identical (TOG-9053 finding 2).
  assert.equal(
    shapeEmbeddedText('{"a":1} tail {"password":"ordinary-db-password"}', []),
    `{"a":1} tail {"password":"${SECRET_PLACEHOLDER}"}`,
  );
  const benign = '{ "a" : 1 } then {"b":2}';
  assert.equal(shapeEmbeddedText(benign, []), '{"a":1} then {"b":2}', "benign records retain their data after canonicalization");
  assert.equal(shapeEmbeddedText("plain line", []), "plain line");
  // Over-depth spans cross as the placeholder, never raw: the old code
  // discarded a non-object shaped result and fell through to raw text,
  // leaking depth-11 payloads (TOG-9053 finding 2).
  assert.equal(shapeEmbeddedText('{"a":1}', [], 10), SECRET_PLACEHOLDER);
  // Gap text carries no parseable record, so it is scrubbed, not shaped: a
  // token-shape leak next to a benign record still dies.
  assert.equal(
    shapeEmbeddedText(`leak ${FAKE_BOT_TOKEN_TEXT} {"a":1}`, []),
    `leak ${SECRET_PLACEHOLDER} {"a":1}`,
  );
});

test("logs-redaction unit: redactPemBlock redacts to end when END is absent", () => {
  assert.equal(redactPemBlock("clean line"), "clean line");
  assert.equal(redactPemBlock(`pre ${PEM_BEGIN} X`), `pre ${SECRET_PLACEHOLDER}`);
  assert.equal(
    redactPemBlock(`a ${PEM_BEGIN} X ${PEM_END} z`),
    `a ${SECRET_PLACEHOLDER} z`,
  );
});

test("logs-redaction unit: applyPemContext carries blocks across entries", () => {
  // BEGIN/body/END arriving as separate log entries: lines fully inside the
  // region collapse to the placeholder; an entry that opens a block keeps its
  // pre-marker text; non-string entries inside a region collapse too
  // (structure is expendable, secrecy is not). Never throws (TOG-9053 finding 2).
  assert.deepEqual(applyPemContext(["clean line"]), ["clean line"]);
  assert.deepEqual(applyPemContext([`a ${PEM_BEGIN} X ${PEM_END} z`]), [
    `a ${SECRET_PLACEHOLDER} z`,
  ]);
  assert.deepEqual(
    applyPemContext([`pre ${PEM_BEGIN}`, "body-line", `tail ${PEM_END} post`]),
    [`pre ${SECRET_PLACEHOLDER}`, SECRET_PLACEHOLDER, `${SECRET_PLACEHOLDER} post`],
  );
  assert.deepEqual(applyPemContext([PEM_BEGIN, { token: "x" }, PEM_END]), [
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
    SECRET_PLACEHOLDER,
  ]);
});

test("logs-redaction unit: extractJsonCandidates matches the smoke brace policy", () => {
  // Broker and smoke must agree on what counts as a structured record.
  assert.deepEqual(extractJsonCandidates('INFO {"a":1} tail'), [[5, 12]]);
  assert.deepEqual(extractJsonCandidates("no braces here"), []);
  assert.deepEqual(extractJsonCandidates('{"x":{"y":1}}'), [
    [0, 13],
    [5, 12],
  ]);
  // Benign prefixed records shape to themselves (byte-identical passthrough).
  const benign = 'INFO {"ts":"2026-09-30T03:01:00.000Z","msg":"ready","guilds":1}';
  assert.equal(shapeLogValue(benign, []), benign);
  // Sensitive spans differ and shape in place.
  assert.equal(
    shapeLogValue('INFO {"password":"ordinary-db-password"}', []),
    `INFO {"password":"${SECRET_PLACEHOLDER}"}`,
  );
});

test("logs-redaction unit: shapeTimestamp validates dates, drops leaky values", () => {
  assert.equal(shapeTimestamp("2026-09-30T03:00:00.000Z", []), "2026-09-30T03:00:00.000Z");
  assert.equal(shapeTimestamp(1759200000000, []), 1759200000000);
  assert.equal(shapeTimestamp(`token ${PANEL_TOKEN}`, [PANEL_TOKEN]), null);
  assert.equal(shapeTimestamp("not a date", []), null);
  assert.equal(shapeTimestamp(null, []), null);
});

test("logs-redaction unit: shapeLogValue redacts sensitive keys, scrubs strings", () => {
  const shaped = shapeLogValue(
    {
      msg: "ready",
      guilds: 1,
      token: "live-value",
      nested: { api_key: "live-value", safe: "ok" },
      list: [{ password: "live-value" }, "plain"],
    },
    [],
  );
  assert.equal(shaped.msg, "ready");
  assert.equal(shaped.guilds, 1);
  assert.equal(shaped.token, SECRET_PLACEHOLDER);
  assert.equal(shaped.nested.api_key, SECRET_PLACEHOLDER);
  assert.equal(shaped.nested.safe, "ok");
  assert.equal(shaped.list[0].password, SECRET_PLACEHOLDER);
  assert.equal(shaped.list[1], "plain");
  // Known host credential embedded mid-string is scrubbed by index search.
  assert.equal(
    scrubSecrets(`prefix ${PANEL_TOKEN} suffix`, [PANEL_TOKEN]),
    `prefix ${SECRET_PLACEHOLDER} suffix`,
  );
  assert.equal(scrubSecrets("nothing secret here", [PANEL_TOKEN]), "nothing secret here");
  // Generic token shape is scrubbed even when the exact value is unknown.
  assert.doesNotMatch(
    scrubSecrets("leaked mfa.abcdefghijklmnopqrstuvwxyz0123456789", []),
    /mfa\.abcdef/,
  );
});

test("logs-redaction unit: shapeLogItem drops message-less scalars", () => {
  assert.equal(shapeLogItem(42, []), null);
  assert.equal(shapeLogItem(null, []), null);
  assert.equal(shapeLogItem(true, []), null);
  // Arrays re-encode redacted (each entry shaped) — still structured data the
  // smoke can parse, never raw panel text. Only message-less SCALARS drop.
  assert.deepEqual(shapeLogItem([1, { token: "x" }], []).message, '[1,{"token":"[redacted]"}]');
  const text = shapeLogItem("plain line", []);
  assert.deepEqual(text, { message: "plain line" });
  // JSON text re-encodes redacted, structure preserved.
  const json = shapeLogItem('{"msg":"ready","guilds":1,"token":"x"}', []);
  assert.deepEqual(JSON.parse(json.message), { msg: "ready", guilds: 1, token: SECRET_PLACEHOLDER });
});

test("logs-redaction unit: shapeLogs caps output and wraps payload keys", () => {
  const big = shapeLogs({ logs: Array.from({ length: 5000 }, (_, i) => `line ${i}`) }, []);
  assert.ok(JSON.stringify(big).length <= 64 * 1024, "shaped output stays within the wire-byte cap");
  const wrapped = shapeLogs({ data: ["a"] }, []);
  assert.deepEqual(wrapped, { logs: [{ message: "a" }] });
  const empty = shapeLogs({ nope: 1 }, []);
  assert.deepEqual(empty, { logs: [] });
});

// --- TOG-9053: residual boundary cases at 407017d0 ---------------------------
// Marker labels and plain-word bodies are synthetic, never key material.
const READY_RECORD = { ts: "2026-09-30T03:01:00.000Z", msg: "ready", user: "FakeBot", guilds: 1 };

const residualLogCases = [
  {
    name: "unmatched quote in prose does not hide structured secrets",
    logs: ['INFO user typed " then {"password":"ordinary-db-password"}'],
    denied: "ordinary-db-password",
  },
  {
    name: "duplicate keys never preserve an overwritten cleartext value",
    logs: ['INFO {"password":"ordinary-db-password","password":"[redacted]"}'],
    denied: "ordinary-db-password",
  },
  {
    name: "prefixed arrays shape JSON-in-string secrets",
    logs: [`INFO ${JSON.stringify([JSON.stringify({ password: "ordinary-db-password" })])}`],
    denied: "ordinary-db-password",
  },
  {
    name: "END-only bounded tails redact preceding body entries",
    logs: ["synthetic-tail-body", PEM_END],
    denied: "synthetic-tail-body",
  },
  {
    name: "complete block and reopened block in one entry retain context",
    logs: [`${PEM_BEGIN} synthetic-first-body ${PEM_END} ${PEM_BEGIN}`, "synthetic-reopened-body", PEM_END],
    denied: "synthetic-reopened-body",
  },
  {
    name: "active block close and reopen in one entry retain context",
    logs: [PEM_BEGIN, `synthetic-first-body ${PEM_END} ${PEM_BEGIN}`, "synthetic-reopened-body", PEM_END],
    denied: "synthetic-reopened-body",
  },
  {
    name: "JSON-escaped marker spaces retain cross-entry context",
    logs: [JSON.stringify({ message: PEM_BEGIN }).replace("RSA ", "RSA\\u0020"), "synthetic-escaped-body", PEM_END],
    denied: "synthetic-escaped-body",
  },
];

for (const fixture of residualLogCases) {
  test(`logs-redaction residual: ${fixture.name}`, async (t) => {
    // Raw and object-wrapped entry representations must share the boundary.
    for (const logs of [fixture.logs, fixture.logs.map((message) => ({ message }))]) {
      const srv = await boot(() => ({ logs: [...logs, JSON.stringify(READY_RECORD)] }));
      t.after(srv.close);
      const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs?lines=2"));
      assert.equal(out.status, 200);
      assert.ok(!out.text.includes(fixture.denied), `${fixture.denied} never crosses`);
      assert.ok(out.text.includes(SECRET_PLACEHOLDER), "redaction is observed, not an empty response");
      const records = findBotRecords(normalizeLogPayload(out.json));
      assert.equal(findReadyLines(records).length, 1, "the actual smoke parser still finds the ready record");
    }
  });
}

test("logs-redaction residual: deeply nested objects and embedded spans return 200, not stack overflow", async (t) => {
  const deepJson = '{"wrap":'.repeat(12000) + '"synthetic-deep-body"' + "}".repeat(12000);
  const fixtures = [JSON.parse(deepJson), `INFO ${deepJson}`];
  for (const fixture of fixtures) {
    const srv = await boot(() => ({ logs: [fixture, JSON.stringify(READY_RECORD)] }));
    t.after(srv.close);
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
    assert.equal(out.status, 200);
    assert.ok(!out.text.includes("synthetic-deep-body"), "depth cutoff redacts the leaf");
    assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
  }
});

test("logs-redaction residual: over-budget PEM inspection fails closed", () => {
  const logs = ["x".repeat(512 * 1024), "synthetic-unexamined-body"];
  assert.deepEqual(applyPemContext(logs), [SECRET_PLACEHOLDER, SECRET_PLACEHOLDER]);
});

test("logs-redaction residual: multiple PEM spans and unmatched END are all redacted", () => {
  assert.equal(
    redactPemBlock(`pre ${PEM_BEGIN} synthetic-first-body ${PEM_END} middle ${PEM_BEGIN} synthetic-second-body ${PEM_END} post`),
    `pre ${SECRET_PLACEHOLDER} middle ${SECRET_PLACEHOLDER} post`,
  );
  assert.equal(redactPemBlock(`synthetic-tail-body ${PEM_END} post`), `${SECRET_PLACEHOLDER} post`);
});

test("logs-redaction residual: canonicalized benign records preserve smoke timestamps and guilds", () => {
  const line = `INFO ${JSON.stringify(READY_RECORD, null, 2)} then {"a":1,"a":2}`;
  const logs = shapeLogs({ logs: [line, { message: JSON.stringify(READY_RECORD, null, 2) }] }, []);
  const records = findReadyLines(findBotRecords(normalizeLogPayload(logs)));
  assert.equal(records.length, 2);
  for (const { record } of records) {
    assert.equal(record.guilds, 1);
    assert.equal(record.ts, READY_RECORD.ts);
  }
  assert.ok(!JSON.stringify(logs).includes('"a":1'), "duplicate-key original bytes do not cross");
});

// --- PR291 exact-head review at 443e1be1 ------------------------------------
// All inputs are synthetic. HTTP cases use only the real handler + stub panel;
// smoke assertions call the actual parser, not a regex approximation.

test("exact-head status: allowlisted values survive, credential-bearing and unknown values do not", () => {
  for (const status of ["queued", "in_progress", "finished", "failed", "cancelled", "running", "running:healthy", "running:unhealthy", "exited:unhealthy"]) {
    assert.deepEqual(shapeStatus({ status }, [PANEL_TOKEN]), { status });
  }
  for (const status of [PANEL_TOKEN, BROKER_TOKEN, PANEL_URL, "running:healthy arbitrary suffix", "finished\n", "x".repeat(100), 42, {}, ["finished"]]) {
    assert.deepEqual(shapeStatus({ status }, [PANEL_TOKEN, BROKER_TOKEN, PANEL_URL]), { status: "" });
  }
  // A host credential can itself look like a legitimate status, including a
  // short credential substring: check secrets BEFORE admitting the value.
  assert.deepEqual(shapeStatus({ status: "finished" }, ["finished"]), { status: "" });
  assert.deepEqual(shapeStatus({ status: "running:healthy" }, ["run"]), { status: "" });
});

test("exact-head status: app and issued-deployment responses never return host credentials", async (t) => {
  let panelStatus = "running:healthy";
  const srv = await boot(({ method }) => method === "POST"
    ? { deployments: [{ deployment_uuid: "dep-exact-head-status" }] }
    : { status: panelStatus });
  t.after(srv.close);
  const queued = await req(srv.base, "/v1/staging/deploy", {
    method: "POST", body: { repo: PINNED_REPO, sha: GOOD_SHA },
  });
  assert.equal(queued.status, 200);
  const paths = ["/v1/staging/app", `/v1/staging/deployments/${queued.json.deployment_uuid}`];
  for (const value of [PANEL_TOKEN, BROKER_TOKEN, PANEL_URL, `running:healthy ${PANEL_TOKEN}`, `finished ${"x".repeat(100)} ${PANEL_TOKEN}`]) {
    panelStatus = value;
    for (const path of paths) {
      const out = assertRedacted(t, await req(srv.base, path));
      assert.equal(out.status, 200);
      assert.deepEqual(out.json, { status: "" }, "untrusted status is rejected whole, never truncated");
    }
  }
  for (const value of ["running:healthy", "finished", "failed", "cancelled"]) {
    panelStatus = value;
    for (const path of paths) assert.deepEqual((await req(srv.base, path)).json, { status: value });
  }
});

test("exact-head logs: unfinished JSON-like prefixes cannot hide later password records", async (t) => {
  const fixtures = [
    'INFO { " then {"password":"ordinary-db-password"}',
    'INFO [ " then {"password":"ordinary-db-password"}',
    'INFO { then {"password":"ordinary-db-password"}',
    'INFO {invalid "password":"ordinary-db-password"}',
  ];
  for (const fixture of fixtures) {
    for (const item of [fixture, { message: fixture }]) {
      const srv = await boot(() => ({ logs: [item, JSON.stringify(READY_RECORD)] }));
      t.after(srv.close);
      const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
      assert.equal(out.status, 200);
      assert.ok(!out.text.includes("ordinary-db-password"), "ambiguous fragments fail closed, not raw fallback");
      assert.ok(out.text.includes(SECRET_PLACEHOLDER));
      assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
    }
  }
});

test("exact-head logs: fail-closed fragments preserve preceding valid smoke records and ordinary quotes", () => {
  const ready = `INFO ${JSON.stringify(READY_RECORD)}`;
  const shaped = shapeEmbeddedText(`${ready} then { " then {"password":"ordinary-db-password"}`, []);
  assert.equal(shaped, `${ready} then ${SECRET_PLACEHOLDER}`);
  assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(shaped))).length, 1);
  assert.equal(shapeEmbeddedText('ordinary prose with an unfinished " quote', []), 'ordinary prose with an unfinished " quote');
  assert.equal(shapeEmbeddedText(`pre ${SECRET_PLACEHOLDER} post`, []), `pre ${SECRET_PLACEHOLDER} post`);
});

test("exact-head logs: structured database URLs never expose userinfo through the handler", async (t) => {
  const url = "postgresql://bot:ordinary-db-password@dbhost.invalid/db";
  const structured = { TWO_DATABASE_URL: url };
  const srv = await boot(() => ({ logs: [
    structured,
    JSON.stringify(structured),
    `INFO ${JSON.stringify(structured)}`,
    { message: `INFO ${JSON.stringify(structured)}` },
    { nested: { connection: url }, other: ["redis://:ordinary-db-password@dbhost.invalid/0"] },
    { message: "mysql://bot:ordinary%2Ddb%2Dpassword@dbhost.invalid/db" },
    JSON.stringify(READY_RECORD),
  ] }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  assert.ok(!out.text.includes("ordinary-db-password"));
  assert.ok(!out.text.includes("ordinary%2Ddb%2Dpassword"));
  assert.equal(JSON.parse(out.json.logs[0].message).TWO_DATABASE_URL, SECRET_PLACEHOLDER);
  assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
});

test("exact-head logs: credential URL scrubbing is scheme-independent and keeps credential-free URLs", () => {
  for (const url of [
    "postgresql://bot:ordinary-db-password@dbhost.invalid/db",
    "postgres://bot:ordinary%2Ddb%2Dpassword@dbhost.invalid/db",
    "redis://:ordinary-db-password@dbhost.invalid/0",
    "mysql://bot:ordinary-db-password@[::1]:3306/db",
    "https://bot:ordinary-db-password@dbhost.invalid/",
    "custom+db://ordinary-db-password@dbhost.invalid/db",
  ]) {
    assert.equal(scrubSecrets(`pre ${url} post`, []), `pre ${SECRET_PLACEHOLDER} post`);
  }
  assert.equal(scrubSecrets("postgresql://dbhost.invalid/db", []), "postgresql://dbhost.invalid/db");
  assert.equal(scrubSecrets("https://docs.example.invalid/guide", []), "https://docs.example.invalid/guide");
});

test("exact-head smoke: raw and supported prefixed text wrappers yield the same ready record", async (t) => {
  const line = `INFO ${JSON.stringify(READY_RECORD)}`;
  const items = [line, ...["message", "output", "log", "line", "text", "content"].map((key) => ({
    [key]: line, password: "ordinary-db-password",
  })), { message: JSON.stringify({ output: line }) }];
  const srv = await boot(() => ({ logs: items }));
  t.after(srv.close);
  const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
  assert.equal(out.status, 200);
  assert.ok(!out.text.includes("ordinary-db-password"));
  for (const pair of out.json.logs) {
    const records = findReadyLines(findBotRecords(normalizeLogPayload({ logs: [pair] })));
    assert.equal(records.length, 1, "actual smoke parser must find wrapped prefixed ready records");
    assert.deepEqual(records[0].record, READY_RECORD);
    assert.equal(records[0].tsMs, Date.parse(READY_RECORD.ts));
  }
});

test("exact-head smoke: wrapper decoding retains fallback timestamps and has a depth limit", () => {
  const timestamp = READY_RECORD.ts;
  const message = JSON.stringify({ output: 'INFO {"msg":"ready","guilds":1}' });
  const records = findReadyLines(findBotRecords(normalizeLogPayload({ logs: [{ message, timestamp }] })));
  assert.equal(records.length, 1);
  assert.equal(records[0].tsMs, Date.parse(timestamp));
  let deep = `INFO ${JSON.stringify(READY_RECORD)}`;
  for (let i = 0; i < 12; i += 1) deep = JSON.stringify({ message: deep });
  assert.deepEqual(findBotRecords(normalizeLogPayload(deep)), [], "over-depth wrappers are not unboundedly decoded");
});

// --- PR291 findings 1-3 at 67fe0f14 ------------------------------------------
// Synthetic credentials only; every regression drives the real HTTP handler
// against a stub panel. The deployment tests also observe stdout and subsequent
// status reads, so rejection must precede logging AND issued-ID storage.

for (const fixture of [
  { name: "panel credential as the ID", id: PANEL_TOKEN, config: testConfig() },
  { name: "panel credential inside the ID", id: `dep-${PANEL_TOKEN}-suffix`, config: testConfig() },
  { name: "broker credential as the ID", id: BROKER_TOKEN, config: testConfig() },
  { name: "short panel credential inside the ID", id: "dep-fake-run-suffix", config: { ...testConfig(), panelToken: "run" } },
  ...[
    "gh" + "p_" + "A".repeat(24),
    "xox" + "b-" + "a".repeat(20),
    "sk-" + "live-" + "a".repeat(20),
    "AK" + "IA" + "A".repeat(16),
  ].map((id, index) => ({ name: `generic credential shape ${index}`, id, config: testConfig() })),
]) {
  test(`review-67fe0f14 deploy: rejects ${fixture.name} before emission or storage`, async (t) => {
    const srv = await boot(({ method }) => method === "POST"
      ? { deployments: [{ deployment_uuid: fixture.id }] }
      : { status: "finished" }, fixture.config);
    t.after(srv.close);
    const writes = [];
    const originalWrite = process.stdout.write;
    const stdout = t.mock.method(process.stdout, "write", (chunk, ...args) => {
      // Preserve test-runner output/IPC; observe only the broker's own line.
      if (!String(chunk).startsWith("BROKER:")) return originalWrite.call(process.stdout, chunk, ...args);
      writes.push(String(chunk));
      return true;
    });
    let queued;
    try {
      queued = await req(srv.base, "/v1/staging/deploy", {
        method: "POST", body: { repo: PINNED_REPO, sha: GOOD_SHA },
      });
    } finally {
      stdout.mock.restore();
    }
    assert.equal(queued.status, 502, "credential-bearing IDs fail closed with a static error");
    assert.deepEqual(queued.json, { error: "bad_gateway" });
    assert.ok(!queued.text.includes(fixture.id.slice(0, 12)), "no ID prefix crosses the response");
    assert.deepEqual(writes, [], "no queued-deployment line or credential prefix is logged");
    const polled = await req(srv.base, `/v1/staging/deployments/${fixture.id}`);
    assert.equal(polled.status, 404, "rejected ID was never stored as issued");
    assert.deepEqual(polled.json, { error: "unknown_deployment" });
    assert.equal(srv.calls.length, 1, "rejected ID cannot trigger a panel status read");
  });
}

test("review-67fe0f14 deploy: ordinary IDs still queue, log and permit scoped polling", async (t) => {
  const id = "dep-fake-safe-1";
  const srv = await boot(({ method }) => method === "POST"
    ? { deployments: [{ deployment_uuid: id }] }
    : { status: "finished" });
  t.after(srv.close);
  const writes = [];
  const originalWrite = process.stdout.write;
  const stdout = t.mock.method(process.stdout, "write", (chunk, ...args) => {
    if (!String(chunk).startsWith("BROKER:")) return originalWrite.call(process.stdout, chunk, ...args);
    writes.push(String(chunk));
    return true;
  });
  let queued;
  try {
    queued = await req(srv.base, "/v1/staging/deploy", {
      method: "POST", body: { repo: PINNED_REPO, sha: GOOD_SHA },
    });
  } finally {
    stdout.mock.restore();
  }
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.json, { deployment_uuid: id });
  assert.equal(writes.length, 1, "ordinary queued-deployment log survives");
  assert.ok(writes[0].includes(id.slice(0, 12)));
  const polled = await req(srv.base, `/v1/staging/deployments/${id}`);
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.json, { status: "finished" });
  assert.equal(srv.calls.length, 2);
});

// RFC 3986 userinfo permits every sub-delimiter, including the apostrophe.
// Exercise each in both username and password, through decoded objects,
// JSON-in-strings, prefixed JSON, and raw/wrapped prose (no sensitive key).
for (const delimiter of "!$&'()*+,;=") {
  test(`review-67fe0f14 logs: URI userinfo sub-delimiter ${JSON.stringify(delimiter)} never crosses`, async (t) => {
    const url = `postgresql://bo${delimiter}t:pa${delimiter}ssword@dbhost.invalid/db`;
    assert.ok(new URL(url).password !== "", "fixture contains valid URI userinfo");
    const structured = { TWO_DATABASE_URL: url };
    const raw = `connected ${url} end`;
    const safeUrl = "postgresql://dbhost.invalid/db";
    const srv = await boot(() => ({ logs: [
      structured,
      JSON.stringify(structured),
      `INFO ${JSON.stringify(structured)}`,
      { message: `INFO ${JSON.stringify(structured)}` },
      raw,
      { message: raw },
      safeUrl,
      JSON.stringify(READY_RECORD),
    ] }));
    t.after(srv.close);
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
    assert.equal(out.status, 200);
    const messages = out.json.logs.map(({ message }) => message);
    assert.deepEqual(messages.slice(0, 6), [
      JSON.stringify({ TWO_DATABASE_URL: SECRET_PLACEHOLDER }),
      JSON.stringify({ TWO_DATABASE_URL: SECRET_PLACEHOLDER }),
      `INFO ${JSON.stringify({ TWO_DATABASE_URL: SECRET_PLACEHOLDER })}`,
      JSON.stringify({ message: `INFO ${JSON.stringify({ TWO_DATABASE_URL: SECRET_PLACEHOLDER })}` }),
      `connected ${SECRET_PLACEHOLDER} end`,
      JSON.stringify({ message: `connected ${SECRET_PLACEHOLDER} end` }),
    ], "userinfo is removed whole in every representation, never just a password prefix");
    assert.equal(messages[6], safeUrl, "credential-free URL is preserved");
    assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
  });
}

for (const panelToken of [
  "panel-prefix{rest-of-fake-credential",
  "panel-prefix[rest-of-fake-credential",
  "panel-prefix{rest}of-fake-credential",
  "panel-prefix[rest]of-fake-credential",
  'panel-prefix{"rest-of-fake-credential',
  'panel-prefix["rest-of-fake-credential',
  'panel-prefix"{rest-of-fake-credential',
  "panel-prefix'{rest-of-fake-credential",
]) {
  test(`review-67fe0f14 logs: delimiter-bearing known credential ${JSON.stringify(panelToken)} redacts whole`, async (t) => {
    const config = parseConfig({
      STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: panelToken,
    });
    assert.equal(config.panelToken, panelToken, "synthetic delimiter-bearing host token is accepted");
    assert.equal(scrubSecrets(panelToken, [panelToken]), SECRET_PLACEHOLDER, "whole-token scrub control");
    const raw = `pre ${panelToken} post`;
    const structured = { connection: panelToken };
    const srv = await boot(() => ({ logs: [
      panelToken,
      raw,
      { message: raw },
      structured,
      JSON.stringify(structured),
      `INFO ${JSON.stringify(structured)}`,
      { message: `INFO ${JSON.stringify(structured)}` },
      JSON.stringify(READY_RECORD),
    ] }), config);
    t.after(srv.close);
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
    assert.equal(out.status, 200);
    assert.ok(!out.text.includes("panel-prefix"), "known credential prefix must never cross after a scan splits it");
    assert.deepEqual(out.json.logs.slice(0, 7).map(({ message }) => message), [
      SECRET_PLACEHOLDER,
      `pre ${SECRET_PLACEHOLDER} post`,
      JSON.stringify({ message: `pre ${SECRET_PLACEHOLDER} post` }),
      JSON.stringify({ connection: SECRET_PLACEHOLDER }),
      JSON.stringify({ connection: SECRET_PLACEHOLDER }),
      `INFO ${JSON.stringify({ connection: SECRET_PLACEHOLDER })}`,
      JSON.stringify({ message: `INFO ${JSON.stringify({ connection: SECRET_PLACEHOLDER })}` }),
    ], "complete known credentials redact before any JSON delimiter can divide them");
    assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
  });
}

// --- PR291 findings 1-4 at 8f2dac86 ------------------------------------------

for (const panelToken of ["password-fixture-panel-credential", "pass", "s"]) {
  test(`review-8f2dac86 logs: raw sensitive keys survive scan masking (${panelToken.length} chars)`, async (t) => {
    const config = parseConfig({
      STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: panelToken,
    });
    const key = panelToken.startsWith("password") ? panelToken : panelToken + "_secret";
    const object = { password: "ordinary-db-value", [key]: "another-db-value" };
    const srv = await boot(() => ({ logs: [
      object,
      JSON.stringify(object),
      `INFO ${JSON.stringify(object)}`,
      { message: `INFO ${JSON.stringify(object)}` },
      `INFO ${JSON.stringify([object])}`,
    ] }), config);
    t.after(srv.close);
    const out = await req(srv.base, "/v1/staging/logs");
    assert.equal(out.status, 200);
    assert.ok(!out.text.includes("ordinary-db-value"));
    assert.ok(!out.text.includes("another-db-value"));
    assert.ok(out.json.logs.every(({ message }) => message.includes(SECRET_PLACEHOLDER)));
  });
}

for (const panelToken of ["r", "ru", "run"]) {
  test(`review-8f2dac86 logs: every accepted short panel credential redacts (${panelToken.length} chars)`, async (t) => {
    const config = parseConfig({
      STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: panelToken,
    });
    const srv = await boot(() => ({ logs: [
      `value=${panelToken}`,
      { value: panelToken },
      `INFO ${JSON.stringify({ value: panelToken })}`,
    ] }), config);
    t.after(srv.close);
    const out = await req(srv.base, "/v1/staging/logs");
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.logs.map(({ message }) => message), [
      `value=${SECRET_PLACEHOLDER}`,
      JSON.stringify({ value: SECRET_PLACEHOLDER }),
      `INFO ${JSON.stringify({ value: SECRET_PLACEHOLDER })}`,
    ]);
  });
}

test("review-8f2dac86 logs: configured credentials redact as unions of original spans", async (t) => {
  const config = { ...testConfig(), panelToken: "shared-fake-panel-credential", brokerToken: "prefix-shared-fake-panel-credential-suffix" };
  const srv = await boot(() => ({ logs: [
    config.brokerToken,
    { value: config.brokerToken },
    `INFO ${JSON.stringify({ value: config.brokerToken })}`,
  ] }), config);
  t.after(srv.close);
  const out = await req(srv.base, "/v1/staging/logs", { token: config.brokerToken });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.logs.map(({ message }) => message), [
    SECRET_PLACEHOLDER,
    JSON.stringify({ value: SECRET_PLACEHOLDER }),
    `INFO ${JSON.stringify({ value: SECRET_PLACEHOLDER })}`,
  ]);
  for (const secrets of [["abcde", "defgh"], ["defgh", "abcde"]]) {
    assert.equal(scrubSecrets("abcdefgh abcdefgh", secrets), `${SECRET_PLACEHOLDER} ${SECRET_PLACEHOLDER}`);
  }
  assert.equal(scrubSecrets("aaaaa", ["aaa"]), SECRET_PLACEHOLDER, "self-overlapping matches merge");
  const generic = "gh" + "p_" + "A".repeat(24);
  assert.equal(scrubSecrets(generic, ["AAAA"]), SECRET_PLACEHOLDER, "known-secret matches cannot break a generic match");
});

// --- PR291 findings 1, 3 and 6 at 617910d9 -----------------------------------

for (const wrap of ["raw", "message", "connection"]) {
  test(`review-617910d9 logs: generic credential coverage survives delimiters (${wrap})`, async (t) => {
    const uri = "postgresql://bot:pa[ss]word@dbhost.invalid/db";
    assert.equal(decodeURIComponent(new URL(uri).password), "pa[ss]word");
    assert.equal(scrubSecrets(uri, []), SECRET_PLACEHOLDER);
    const item = wrap === "raw" ? uri : { [wrap]: uri };
    const srv = await boot(() => ({ logs: [item, JSON.stringify(READY_RECORD)] }));
    t.after(srv.close);
    const out = assertRedacted(t, await req(srv.base, "/v1/staging/logs"));
    assert.equal(out.status, 200);
    const expected = wrap === "raw" ? SECRET_PLACEHOLDER : JSON.stringify({ [wrap]: SECRET_PLACEHOLDER });
    assert.equal(out.json.logs[0].message, expected, "no username/password fragments cross the handler");
    assert.equal(findReadyLines(findBotRecords(normalizeLogPayload(out.json))).length, 1);
  });
}

for (const panelToken of ["{", "[", '"', ":", "}", "]"]) {
  test(`review-617910d9 logs: framing credentials cannot hide sensitive-key policy (${panelToken})`, async (t) => {
    const config = parseConfig({
      STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: panelToken,
    });
    const object = { password: "ordinary-db-value" };
    const srv = await boot(() => ({ logs: [
      object, JSON.stringify(object), `INFO ${JSON.stringify(object)}`,
      { message: `INFO ${JSON.stringify(object)}` }, `INFO ${JSON.stringify([object])}`,
      `INFO ${JSON.stringify(object).slice(0, -1)}`,
    ] }), config);
    t.after(srv.close);
    const out = await req(srv.base, "/v1/staging/logs");
    assert.equal(out.status, 200);
    assert.ok(!out.text.includes("ordinary-db-value"));
    assert.ok(out.json.logs.every(({ message }) => message.includes(SECRET_PLACEHOLDER)));
  });
}

test("review-617910d9 scrubber: dot-free known credentials have bounded matching cost", () => {
  // Isolate the synchronous scan; a regression must fail within a timeout,
  // not hang the suite. Synthetic, 64 KiB input; no live-service load probe.
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { scrubSecrets, SECRET_PLACEHOLDER } from ${JSON.stringify(new URL("./server.mjs", import.meta.url).href)};
    const secret = "A".repeat(32);
    scrubSecrets(secret, [secret]);
    const start = performance.now();
    assert.equal(scrubSecrets(secret.repeat(2048), [secret]), SECRET_PLACEHOLDER);
    const elapsedMs = performance.now() - start;
    console.log(JSON.stringify({ elapsedMs }));
    assert.ok(elapsedMs < 1000, "64 KiB scan must complete under one second");
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(run.error, undefined, "isolated scan must not time out");
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

// --- PR291 finding 2 at d883a973 --------------------------------------------

for (const [name, panelToken, password] of [
  ["quote", '"', "db-value}credential-tail"],
  ["escape", "\\", 'db-value"}credential-tail'],
]) {
  test(`review-d883a973 logs: masked ${name} cannot expose quoted password suffixes`, async (t) => {
    const config = parseConfig({
      STAGING_BROKER_TOKEN: BROKER_TOKEN, COOLIFY_URL: PANEL_URL, COOLIFY_TOKEN: panelToken,
    });
    const object = { password, note: "ordinary" };
    const json = JSON.stringify(object);
    const srv = await boot(() => ({ logs: [
      object, json, `INFO ${json}`, { message: `INFO ${json}` },
      `INFO ${JSON.stringify([object])}`,
      `INFO ${json.slice(0, -1)}`,
    ] }), config);
    t.after(srv.close);
    const out = await req(srv.base, "/v1/staging/logs");
    assert.equal(out.status, 200);
    assert.equal(out.json.logs.length, 6);
    assert.ok(!out.text.includes("db-value"), "no sensitive prefix crosses any representation");
    assert.ok(!out.text.includes("credential-tail"), "no sensitive suffix crosses masked quote/escape framing");
    assert.ok(out.json.logs.every(({ message }) => message.includes(SECRET_PLACEHOLDER)));
  });
}

test("logs-bounded unit: parseLogLines clamps to 1..500", () => {
  assert.equal(parseLogLines(new URLSearchParams("")), 200);
  assert.equal(parseLogLines(new URLSearchParams("lines=50")), 50);
  assert.throws(() => parseLogLines(new URLSearchParams("lines=0")), /bad_request/);
  assert.throws(() => parseLogLines(new URLSearchParams("lines=501")), /bad_request/);
});

test("deploy-validation unit: validateDeployBody pins repo and sha", () => {
  assert.deepEqual(validateDeployBody({ repo: PINNED_REPO, sha: GOOD_SHA }), { sha: GOOD_SHA, repo: PINNED_REPO });
  assert.throws(() => validateDeployBody(null), /bad_request/);
  assert.throws(() => validateDeployBody({ repo: "x", sha: GOOD_SHA }), /bad_request/);
  assert.throws(() => validateDeployBody({ repo: PINNED_REPO, sha: GOOD_SHA, appUuid: "other" }), /forbidden/);
  assert.throws(() => validateDeployBody({ repo: PINNED_REPO, sha: GOOD_SHA, env: "production" }), /forbidden/);
});
