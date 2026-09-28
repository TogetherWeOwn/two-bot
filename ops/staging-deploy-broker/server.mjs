#!/usr/bin/env node

// Staging-only deploy broker for the TOG-6911 deploy jobs.
//
// PROBLEM. The merged deploy.yml (PR267) drove the Coolify panel straight from
// Actions with a panel bearer (COOLIFY_TOKEN) plus a caller-supplied
// COOLIFY_APP_UUID. The live panel token carries abilities [read,deploy] and is
// NOT app-scoped, so any job holding it can reach production applications; a
// GitHub environment label is not a resource authorization boundary. Copying
// that bearer into a staging Actions secret is therefore unsafe, and the
// operator refused the host step (2026-09-28 hand-back on TOG-6911).
//
// SHAPE. The panel bearer stays on the host. This broker runs on the host
// (loopback only, systemd unit in this directory) holding the panel bearer,
// and Actions holds only a scoped staging credential (STAGING_BROKER_TOKEN).
// The broker's server-side authority admits exactly one application — the
// two-bot staging app — and rejects everything else:
//
//   * authenticated triggering: every /v1/staging/* route except /healthz
//     requires `Authorization: Bearer <staging token>` (constant-time compare)
//   * caller/resource/commit validation: POST /v1/staging/deploy requires the
//     pinned repo (TogetherWeOwn/two-bot) and a 40-hex merge SHA; any
//     client-supplied app UUID that is not the pinned staging UUID, or any
//     production/staging-excepting target label, is rejected with 403
//   * bounded, redacted responses: deployment-status and app reads return
//     `{status}` only; logs are size-capped and forwarded without secrets;
//     error bodies are static codes, never panel output, never tokens or URLs
//   * no panel bearer in Actions: the workflow speaks only to the broker
//
// BIND. Loopback only (127.0.0.1, ::1, localhost). Anything else refuses to
// start: a deploy authority must never listen on a public interface. The
// two-selfhosted runners share the host's network namespace, so loopback from
// a runner job reaches this broker — reachability is proved by the staging
// Deployment+smoke run itself, which also attests its runner
// (scripts/ci/attest-runner.sh).
//
// PRODUCTION. This broker cannot deploy production: the app UUID is pinned,
// override attempts are rejected, and there is no production route. Production
// stays HOLD until TOG-6903 (deploy.yml deploy-production, panel bearer,
// operator dispatch).
//
// Env (host-only, via systemd LoadCredential — never in Actions):
//   STAGING_BROKER_TOKEN  scoped staging credential (>= 16 chars), required
//   COOLIFY_URL           panel origin, https:// required, required
//   COOLIFY_TOKEN         panel bearer, required
//   STAGING_BROKER_PORT   default 8091
//   STAGING_BROKER_BIND   default 127.0.0.1; must be loopback
//   STAGING_APP_UUID      optional; when set must equal the pinned staging UUID
//                         (a mis-pointed broker refuses to start rather than
//                         serving the wrong app)
//
// Exit codes: 0 serving until SIGTERM/SIGINT, 2 config error. Stdlib only.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const PINNED_STAGING_APP_UUID = "uy4d9ndeygjcem6lgayhxgub";
export const PINNED_REPO = "TogetherWeOwn/two-bot";
export const SERVICE_NAME = "two-staging-broker";
export const DEFAULT_PORT = 8091;
export const DEFAULT_BIND = "127.0.0.1";
export const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_PANEL_BYTES = 512 * 1024;
export const MAX_LOG_LINES = 500;
export const DEFAULT_LOG_LINES = 200;
export const PANEL_TIMEOUT_MS = 60_000;
export const MIN_TOKEN_CHARS = 16;
export const DEPLOYMENT_UUID_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const SHA_RE = /^[0-9a-f]{40}$/i;

export function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

/** Constant-time bearer check. Never throws; missing/mismatched -> false. */
export function checkAuth(header, expected) {
  if (typeof header !== "string" || typeof expected !== "string" || expected === "") return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  if (presented.length !== wanted.length) return false;
  return timingSafeEqual(presented, wanted);
}

export function isLoopback(bind) {
  return LOOPBACK_BINDS.has(String(bind ?? "").trim());
}

export function readCredentialFile(dir, name) {
  if (!dir) return "";
  try {
    const { readFileSync } = process.getBuiltinModule("node:fs");
    return readFileSync(`${dir}/${name}`, "utf8").trim();
  } catch {
    return "";
  }
}

export function parseConfig(env) {
  // systemd LoadCredential lands as FILES under $CREDENTIALS_DIRECTORY, not
  // env vars (deploy/two-bot.service model). Files win when present; the env
  // fallback is for local smoke only and is never used on the host.
  const credDir = String(env.CREDENTIALS_DIRECTORY ?? "").trim();
  const brokerToken = (readCredentialFile(credDir, "staging_broker_token") || String(env.STAGING_BROKER_TOKEN ?? "")).trim();
  if (brokerToken === "" || brokerToken.length < MIN_TOKEN_CHARS) {
    throw new Error(
      `Invalid STAGING_BROKER_TOKEN: required, at least ${MIN_TOKEN_CHARS} chars (scoped staging credential, host-only)`,
    );
  }
  const panelUrl = String(env.COOLIFY_URL ?? "").trim().replace(/\/+$/, "");
  if (!panelUrl.startsWith("https://")) {
    throw new Error("Invalid COOLIFY_URL: required, must be an https:// origin (the panel bearer never travels over plaintext)");
  }
  const panelToken = (readCredentialFile(credDir, "coolify_token") || String(env.COOLIFY_TOKEN ?? "")).trim();
  if (panelToken === "") {
    throw new Error("Invalid COOLIFY_TOKEN: required (panel bearer, host-only via LoadCredential)");
  }
  const rawPort = String(env.STAGING_BROKER_PORT ?? String(DEFAULT_PORT)).trim();
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid STAGING_BROKER_PORT ${JSON.stringify(env.STAGING_BROKER_PORT ?? "")}: expected 1-65535`);
  }
  const bind = String(env.STAGING_BROKER_BIND ?? DEFAULT_BIND).trim();
  if (!isLoopback(bind)) {
    throw new Error(
      `Invalid STAGING_BROKER_BIND ${JSON.stringify(bind)}: the broker binds loopback only (a deploy authority must never listen publicly)`,
    );
  }
  const override = String(env.STAGING_APP_UUID ?? "").trim();
  if (override !== "" && override !== PINNED_STAGING_APP_UUID) {
    throw new Error(
      "Invalid STAGING_APP_UUID: when set it must equal the pinned two-bot staging app — refusing to serve a re-pointed broker",
    );
  }
  return { brokerToken, panelUrl, panelToken, port, bind, appUuid: PINNED_STAGING_APP_UUID };
}

/**
 * Validate a POST /v1/staging/deploy body. Returns { sha, repo }.
 * Rejects arbitrary app UUIDs and production targets with 403; malformed
 * repo/sha with 400. Never echoes secrets — error bodies are static codes.
 */
export function validateDeployBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "bad_request");
  }
  for (const key of ["appUuid", "app_uuid", "uuid", "applicationUuid", "application_uuid"]) {
    if (body[key] !== undefined && String(body[key]) !== PINNED_STAGING_APP_UUID) {
      throw httpError(403, "forbidden");
    }
  }
  for (const key of ["env", "envName", "env_name", "environment", "target"]) {
    if (body[key] !== undefined && String(body[key]).toLowerCase() !== "staging") {
      throw httpError(403, "forbidden");
    }
  }
  if (typeof body.repo !== "string" || body.repo !== PINNED_REPO) {
    throw httpError(400, "bad_request");
  }
  if (typeof body.sha !== "string" || !SHA_RE.test(body.sha.trim())) {
    throw httpError(400, "bad_request");
  }
  return { sha: body.sha.trim().toLowerCase(), repo: PINNED_REPO };
}

/** Shape panel deployment/app reads down to a redacted {status}. */
export function shapeStatus(panelJson) {
  return { status: String(panelJson?.status ?? "").slice(0, 64) };
}

export function parseLogLines(query) {
  const raw = String(query.get("lines") ?? String(DEFAULT_LOG_LINES)).trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LOG_LINES) {
    throw httpError(400, "bad_request");
  }
  return n;
}

export async function panelRequest({ panelUrl, panelToken, method, path, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${panelUrl}/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${panelToken}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw httpError(502, "bad_gateway");
    const text = await res.text();
    if (text.length > maxBytes) throw httpError(502, "bad_gateway");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error?.code === "bad_gateway" || error?.status === 502) throw httpError(502, "bad_gateway");
    throw httpError(502, "bad_gateway");
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        reject(httpError(400, "bad_request"));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, "bad_request"));
      }
    });
    req.on("error", () => reject(httpError(400, "bad_request")));
  });
}

export function createHandler(config, panel = panelRequest) {
  const base = { panelUrl: config.panelUrl, panelToken: config.panelToken };
  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://broker.local");
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/healthz") {
        send(res, 200, { ok: true, service: SERVICE_NAME });
        return;
      }

      if (!checkAuth(req.headers.authorization, config.brokerToken)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/staging/deploy") {
        const validated = validateDeployBody(await readBody(req));
        const shortSha = validated.sha.slice(0, 12);
        const panelJson = await panel({
          ...base,
          method: "POST",
          path: `deploy?uuid=${encodeURIComponent(config.appUuid)}&force=true`,
          timeoutMs: PANEL_TIMEOUT_MS,
          maxBytes: MAX_PANEL_BYTES,
        });
        const list = Array.isArray(panelJson?.deployments) ? panelJson.deployments : [];
        const deploymentUuid = String(list[0]?.deployment_uuid ?? "");
        if (!DEPLOYMENT_UUID_RE.test(deploymentUuid)) throw httpError(502, "bad_gateway");
        process.stdout.write(`BROKER: deploy queued for staging app ${config.appUuid.slice(0, 8)} sha ${shortSha} (deployment ${deploymentUuid.slice(0, 12)}).\n`);
        send(res, 200, { deployment_uuid: deploymentUuid });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/staging/app") {
        const panelJson = await panel({
          ...base,
          method: "GET",
          path: `applications/${config.appUuid}`,
          timeoutMs: PANEL_TIMEOUT_MS,
          maxBytes: MAX_PANEL_BYTES,
        });
        send(res, 200, shapeStatus(panelJson));
        return;
      }

      const depMatch = /^\/v1\/staging\/deployments\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (req.method === "GET" && depMatch) {
        if (!DEPLOYMENT_UUID_RE.test(depMatch[1])) throw httpError(400, "bad_request");
        const panelJson = await panel({
          ...base,
          method: "GET",
          path: `deployments/${depMatch[1]}`,
          timeoutMs: PANEL_TIMEOUT_MS,
          maxBytes: MAX_PANEL_BYTES,
        });
        send(res, 200, shapeStatus(panelJson));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/staging/logs") {
        const lines = parseLogLines(url.searchParams);
        const panelJson = await panel({
          ...base,
          method: "GET",
          path: `applications/${config.appUuid}/logs?lines=${lines}`,
          timeoutMs: PANEL_TIMEOUT_MS,
          maxBytes: MAX_PANEL_BYTES,
        });
        send(res, 200, typeof panelJson === "string" ? { logs: panelJson } : panelJson);
        return;
      }

      if (
        (pathname === "/v1/staging/deploy" && req.method !== "POST") ||
        ((pathname === "/v1/staging/app" || pathname === "/v1/staging/logs" ||
          pathname.startsWith("/v1/staging/deployments/")) && req.method !== "GET")
      ) {
        send(res, 405, { error: "method_not_allowed" });
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code =
        status === 400 ? "bad_request"
        : status === 401 ? "unauthorized"
        : status === 403 ? "forbidden"
        : status === 404 ? "not_found"
        : status === 405 ? "method_not_allowed"
        : status === 413 ? "payload_too_large"
        : status === 502 ? "bad_gateway"
        : "bad_gateway";
      try {
        send(res, status > 500 ? 502 : status, { error: code });
      } catch {
        try { res.destroy(); } catch { /* already gone */ }
      }
    }
  };
}

async function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
  const server = createServer(createHandler(config));
  server.listen(config.port, config.bind, () => {
    process.stdout.write(
      `BROKER: ${SERVICE_NAME} listening on ${config.bind}:${config.port} for staging app ${config.appUuid.slice(0, 8)} (repo ${PINNED_REPO}).\n`,
    );
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) await main();
