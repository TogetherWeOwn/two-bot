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
//     `{status}` only; logs cross only as scrubbed text (raw strings) or
//     key-redacted JSON (objects: sensitive names redacted, every string
//     value scrubbed) — objects must stay structured because the smoke
//     parses the ready-line JSON out of the message text; message-less
//     scalars are dropped; output is byte-capped. Deployment-status reads
//     serve only IDs this broker process issued (a restart clears the set,
//     failing in-flight polls red rather than leaking foreign reads);
//     error bodies are static codes, never panel output, never tokens or URLs
//   * no panel bearer in Actions: the workflow speaks only to the broker
//
// BIND. Loopback only (127.0.0.1, ::1, localhost). Anything else refuses to
// start: a deploy authority must never listen on a public interface. Deploy
// jobs run on ubuntu-latest (public repo, #304), so hosted runners reach this
// broker over public HTTPS through the host's TLS-terminating reverse proxy
// (reverse-proxy.Caddyfile.example in this directory), which forwards at root
// to the loopback bind. The first green staging Deployment+smoke over that
// public origin IS the reachability proof (a broker the runner cannot reach
// fails the job red, TOG-913, never silently); the workflow's "Attest the
// runner" step records the hosted runner the proof ran from.
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

// Panel log payloads are credential-adjacent: the container's own log lines
// can embed token-shaped text (a fake bot token survived the handler verbatim
// — TOG-9053 finding 2), and unrelated panel fields rode along in the same
// response body. Line/size caps bound the volume but redact nothing, so the
// handler shapes logs before they cross the broker boundary, scrubbing every
// string against the host credentials the broker holds plus generic
// token/webhook/bearer shapes. Secrets never touch a regex character class
// (they are replaced by index search), and the placeholder is fixed so a
// secret's length is not leaked either.
//
// Shape contract (fixed by the smoke's parser, broker-smoke.mjs):
//   * raw strings pass through as scrubbed, capped text — the smoke extracts
//     the bot's ready-line JSON out of the message text itself;
//   * JSON objects keep their STRUCTURE but sensitive keys
//     (token/secret/password/bearer/authorization/cookie/session/api[_-]key,
//     webhook path segments, ssh/private-key material) are replaced by the
//     placeholder and every remaining string value is scrubbed;
//   * JSON scalars (numbers, booleans, nulls) carry no message and are
//     dropped — nothing to smoke-parse, nothing to leak.
// Output is byte-capped so one chatty container cannot push an unbounded
// redacted blob at the runner. Never throws.
export const LOG_TS_KEYS = ["timestamp", "ts", "time", "_ts", "created_at"];
export const LOG_PAYLOAD_KEYS = ["logs", "data", "output", "lines", "result"];
export const MAX_LOG_MESSAGE_CHARS = 4096;
export const MAX_SHAPED_LOG_BYTES = 64 * 1024;
export const SECRET_PLACEHOLDER = "[redacted]";

const GENERIC_SECRET_RES = [
  /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
  /mfa\.[A-Za-z0-9_-]{20,}/g,
  /xox[bpas]-[A-Za-z0-9-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-(live|test)-[A-Za-z0-9]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{20,}/g,
  /Bearer [A-Za-z0-9._~+/=-]{8,}/g,
];

// Object keys whose VALUE is sensitive regardless of shape (matched
// case-insensitively by substring). `headers`/`auth` ride along because a
// logged fetch-options object nests the bearer one level down.
const SENSITIVE_KEY_RES = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /bearer/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /api[-_]?key/i,
  /webhook/i,
  /private[-_]?key/i,
  /headers?/i,
  /\bauth\b/i,
];

/** Scrub known host credentials and generic secret shapes from one string. */
export function scrubSecrets(text, secrets) {
  let out = String(text ?? "");
  if (Array.isArray(secrets)) {
    for (const secret of secrets) {
      if (typeof secret !== "string" || secret.length < 4) continue;
      let at = out.indexOf(secret);
      while (at !== -1) {
        out = out.slice(0, at) + SECRET_PLACEHOLDER + out.slice(at + secret.length);
        at = out.indexOf(secret, at + SECRET_PLACEHOLDER.length);
      }
    }
  }
  for (const re of GENERIC_SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, SECRET_PLACEHOLDER);
  }
  return out;
}

/**
 * Recursively shape one JSON-decoded value from a log line: objects keep
 * their keys (key names scrubbed, sensitive names redacted, every string
 * scrubbed), arrays are mapped, strings are scrubbed and capped, scalars
 * pass through (the caller drops message-less top-level scalars).
 * Depth-capped so a hostile nested payload cannot recurse the broker into a
 * stack overflow: the cutoff applies BEFORE any type-specific handling, so
 * over-depth JSON-in-string leaves and arrays cross as the placeholder, never
 * verbatim — a late cutoff after the string branch would return over-depth
 * leaves raw, bypassing key redaction and credential scrubbing for deeply
 * nested secrets (TOG-9053 finding 2).
 */
export function shapeLogValue(value, secrets, depth = 0) {
  if (depth > 10) return SECRET_PLACEHOLDER;
  if (typeof value === "string") {
    // JSON-in-strings decodes before shaping: a log message carrying the
    // bot's ready-line record as escaped JSON must come out as a redacted
    // OBJECT the caller's single JSON.stringify can encode once — returning
    // a stringified blob here would double-encode when nested inside a
    // {message} wrapper and hide the ready line from the smoke's
    // jsonCandidates parser. Unparseable text falls through to scrubbed raw.
    // (Depth is already bounded above, so decoding here cannot recurse past
    // the cap: shapeLogValue re-checks depth on entry.)
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const decoded = JSON.parse(trimmed);
        if (decoded !== null && typeof decoded === "object") {
          return shapeLogValue(decoded, secrets, depth + 1);
        }
      } catch {
        // Not JSON — fall through to raw scrubbed text.
      }
    }
    return scrubSecrets(value, secrets).slice(0, MAX_LOG_MESSAGE_CHARS);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => shapeLogValue(entry, secrets, depth + 1));
  }
  const shaped = {};
  for (const [key, entry] of Object.entries(value)) {
    // Keys are untrusted panel text, not trusted schema: a credential
    // smuggled in as a property NAME would otherwise cross verbatim, since
    // both branches below used to emit `key` as-is (TOG-9053 finding 2).
    // Sensitivity is judged on the raw key; the emitted name is scrubbed.
    const safeKey = scrubSecrets(key, secrets);
    if (SENSITIVE_KEY_RES.some((re) => re.test(key))) {
      shaped[safeKey] = SECRET_PLACEHOLDER;
    } else {
      shaped[safeKey] = shapeLogValue(entry, secrets, depth + 1);
    }
  }
  return shaped;
}

/**
 * Shape one raw panel log item. Strings pass as scrubbed text; JSON text
 * re-encodes redacted (structure preserved for the smoke's ready-line
 * parser); non-text items are JSON-decoded when they are objects, and
 * message-less scalars return null (dropped, not forwarded). Never throws.
 */
export function shapeLogItem(item, secrets) {
  const secretList = Array.isArray(secrets) ? secrets : [];
  if (typeof item === "string") {
    const trimmed = item.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const decoded = JSON.parse(trimmed);
        if (decoded !== null && typeof decoded === "object") {
          return { message: JSON.stringify(shapeLogValue(decoded, secretList)) };
        }
      } catch {
        // Not JSON — fall through to raw scrubbed text.
      }
    }
    return { message: scrubSecrets(item, secretList).slice(0, MAX_LOG_MESSAGE_CHARS) };
  }
  if (item !== null && typeof item === "object") {
    return { message: JSON.stringify(shapeLogValue(item, secretList)) };
  }
  return null;
}

/**
 * Validate a line-level timestamp before it crosses the boundary. A timestamp
 * is metadata, not message text: it must parse as an actual date (the smoke's
 * own definition of a usable timestamp is Date.parse-finite, broker-smoke.mjs
 * findBotRecords) and must not carry credential text. Anything else — a panel
 * token smuggled into a timestamp field, a non-date string — is dropped by
 * returning null, so the pair ships without a timestamp (TOG-9053 finding 2).
 * Genuine timestamps are re-emitted in canonical ISO form, since the smoke's
 * advancing-timestamps check only needs a parseable date. Never throws.
 *
 * Order matters (TOG-9053 finding 2): the length cap and the credential check
 * both run on the FULL original value, before parsing and before any slicing.
 * Truncating first would let `Date.parse` accept a date prefix with a
 * credential smuggled in a trailing comment, then slice the suffix off before
 * the secret check — leaking the credential's prefix in the emitted
 * timestamp. Overlong metadata is rejected, not truncated.
 */
export function shapeTimestamp(value, secrets) {
  // Numeric epochs carry no text by construction: pass finite values through
  // (the smoke normalizes them to strings itself).
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  if (value.length > 64) return null;
  if (scrubSecrets(value, secrets) !== value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Shape a panel logs payload into { logs: [{message}, ...] }. Top-level
 * timestamp metadata (Coolify's per-line ts wrappers) is preserved on the
 * pair ONLY when it validates as a real timestamp via shapeTimestamp — the
 * smoke falls back to embedded record timestamps first. Output is capped at
 * MAX_SHAPED_LOG_BYTES. Never throws.
 */
export function shapeLogs(panelJson, secrets) {
  const secretList = Array.isArray(secrets) ? secrets : [];
  let items = [];
  if (typeof panelJson === "string") {
    items = panelJson.split("\n");
  } else if (Array.isArray(panelJson)) {
    items = panelJson;
  } else if (panelJson !== null && typeof panelJson === "object") {
    for (const key of LOG_PAYLOAD_KEYS) {
      if (panelJson[key] !== undefined) {
        const inner = panelJson[key];
        items = Array.isArray(inner) ? inner : String(inner ?? "").split("\n");
        break;
      }
    }
  }
  const shaped = [];
  let bytes = 0;
  for (const item of items) {
    const pair = shapeLogItem(item, secretList);
    if (pair === null) continue;
    let timestamp = null;
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      for (const key of LOG_TS_KEYS) {
        const shaped = shapeTimestamp(item[key], secretList);
        if (shaped !== null) {
          timestamp = shaped;
          break;
        }
      }
    }
    const out = timestamp === null ? pair : { ...pair, timestamp };
    // Budget counts WIRE bytes (JSON encoding included), not just message
    // text: {"message":"..."} roughly triples short lines, so a message-only
    // budget would let the response run ~3x past the cap.
    const size = Buffer.byteLength(JSON.stringify(out), "utf8") + 1; // +1 for the comma separator
    if (bytes + size > MAX_SHAPED_LOG_BYTES) break;
    bytes += size;
    shaped.push(out);
  }
  return { logs: shaped };
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
  // Deployment UUIDs this process queued via POST /v1/staging/deploy. Status
  // reads serve ONLY these IDs: the panel bearer is broad, so handing a
  // caller-supplied ID straight to `deployments/<id>` would read foreign
  // (production) deployments as {status:"finished"} with 200 (TOG-9053
  // finding 4). Unknown IDs get the static 404 unknown_deployment without
  // touching the panel. A broker restart clears the set, so in-flight polls
  // fail naming the unknown deployment (TOG-913 red, never silently) rather
  // than resuming against a deployment this process never issued.
  const issuedDeployments = new Set();
  const hostSecrets = () => [config.panelToken, config.brokerToken, config.panelUrl];
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
        issuedDeployments.add(deploymentUuid);
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
        // Scoped read: only deployments this broker process queued. A
        // well-formed foreign ID never reaches the panel — it gets the static
        // unknown_deployment, so a production deployment UUID cannot be probed
        // through the staging broker.
        if (!issuedDeployments.has(depMatch[1])) {
          send(res, 404, { error: "unknown_deployment" });
          return;
        }
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
        // Redacted, allowlist-shaped logs: raw panel text never crosses the
        // broker boundary (TOG-9053 finding 2).
        send(res, 200, shapeLogs(panelJson, hostSecrets()));
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
