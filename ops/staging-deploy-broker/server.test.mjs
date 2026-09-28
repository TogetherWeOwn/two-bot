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
//                           when the panel leaks extra fields; no error body
//                           anywhere contains the panel token or panel URL
//   logs-bounded            lines=0 / lines=9999 -> 400; valid -> passthrough
//   routing                 unknown path -> 404, wrong method -> 405
//
// Usage: node --test ops/staging-deploy-broker/server.test.mjs
// Exit: 0 all green, 1 a case failed. Stdlib only.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  checkAuth,
  createHandler,
  parseConfig,
  parseLogLines,
  PINNED_REPO,
  PINNED_STAGING_APP_UUID,
  shapeStatus,
  validateDeployBody,
} from "./server.mjs";

const BROKER_TOKEN = "staging-broker-token-fake-0123456789";
const PANEL_TOKEN = "PANEL-BEARER-FAKE-abcdef-0123456789";
const PANEL_URL = "https://panel.example.invalid";
const GOOD_SHA = "a".repeat(40);

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
async function boot(stub) {
  const calls = [];
  const panel = async (args) => {
    calls.push(args);
    return stub(args);
  };
  const server = createServer(createHandler(testConfig(), panel));
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
  assert.doesNotMatch(text, new RegExp(BROKER_TOKEN), "broker token never appears in a broker response");
  return { status, json };
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
  const srv = await boot(() => ({
    status: "running:healthy",
    uuid: PINNED_STAGING_APP_UUID,
    git_repository: "git@135.148.42.223:/srv/git/two-bot.git",
    internal_secret: "should-never-leave",
  }));
  t.after(srv.close);
  const app = assertRedacted(t, await req(srv.base, "/v1/staging/app"));
  assert.equal(app.status, 200);
  assert.deepEqual(app.json, { status: "running:healthy" });
  const dep = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/dep-abc123"));
  assert.equal(dep.status, 200);
  assert.deepEqual(dep.json, { status: "running:healthy" });
  const badId = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/abc"));
  assert.equal(badId.status, 400);
  const traversal = assertRedacted(t, await req(srv.base, "/v1/staging/deployments/%2e%2e%2fetc"));
  assert.ok([400, 404].includes(traversal.status), "encoded traversal never reaches the panel");
});

test("redaction unit: shapeStatus keeps status only", () => {
  assert.deepEqual(shapeStatus({ status: "finished", token: "x", url: "y" }), { status: "finished" });
  assert.deepEqual(shapeStatus(null), { status: "" });
});

test("logs-bounded: out-of-range lines is 400, valid passes through", async (t) => {
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
  assert.deepEqual(ok.json, { logs: [{ message: "line" }] });
});

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
