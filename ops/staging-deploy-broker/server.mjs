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

// Exact deployment states and container-state/health vocabulary only. Unknown
// panel text is not a status and must never be echoed or truncated into one.
const PANEL_STATUS_RE = /^(?:queued|in_progress|finished|failed|cancelled|(?:running|restarting|starting|exited|stopped|unknown)(?::(?:healthy|unhealthy|unknown))?)$/;

/** Shape panel reads to {status}; reject host credentials even if allowlisted. */
export function shapeStatus(panelJson, secrets = []) {
  const status = panelJson?.status;
  if (typeof status !== "string" || status.trim() !== status || !PANEL_STATUS_RE.test(status)) return { status: "" };
  if (Array.isArray(secrets) && secrets.some((secret) => typeof secret === "string" && secret !== "" && status.includes(secret))) {
    return { status: "" };
  }
  return { status };
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
//     the bot's ready-line JSON out of the message text itself; strings with
//     an embedded {...} record (e.g. a log prefix like `INFO {...}`) get that
//     record shaped in place with the same brace-matching the smoke uses, so
//     prefixed structured secrets redact exactly like whole-string JSON while
//     benign prefixed records retain their data in canonical JSON;
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
  // A private-key BEGIN marker is sensitive even when its END marker is
  // beyond the match window or absent entirely (chunked/incomplete key
  // blocks, larger keys): the lazy match runs to the first END marker, or —
  // when there is none — to the end of the string, and this runs inside
  // scrubSecrets, BEFORE the per-message output truncation below (TOG-9053
  // finding 2). Trailing text on the same line as an unterminated marker is
  // redacted with it: fail closed.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{20,}/g,
  /Bearer [A-Za-z0-9._~+/=-]{8,}/g,
  // URI userinfo is a credential regardless of scheme or property name (e.g.
  // TWO_DATABASE_URL). Redact the whole URL, including percent-encoded values;
  // credential-free URLs retain their text. This also covers raw log prose.
  // Apostrophes are valid userinfo sub-delimiters (RFC 3986), not a boundary
  // before the @. After userinfo, quotes can still delimit surrounding prose.
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#"<>]+@[^\s"'<>]*/g,
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

/** Match every accepted host credential against ORIGINAL bytes, including overlaps. */
function knownSecretSpans(text, secrets) {
  const spans = [];
  if (Array.isArray(secrets)) {
    for (const secret of secrets) {
      if (typeof secret !== "string" || secret === "") continue;
      let at = text.indexOf(secret);
      while (at !== -1) {
        spans.push([at, at + secret.length]);
        at = text.indexOf(secret, at + 1);
      }
    }
  }
  return spans;
}

function mergeSpans(spans) {
  const merged = [];
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [start, end] of spans) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Scrub all credential spans together; one replacement must not hide another. */
export function scrubSecrets(text, secrets) {
  const original = String(text ?? "");
  const spans = knownSecretSpans(original, secrets);
  for (const re of GENERIC_SECRET_RES) {
    re.lastIndex = 0;
    for (const match of original.matchAll(re)) spans.push([match.index, match.index + match[0].length]);
  }
  return redactSpans(original, mergeSpans(spans));
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
/**
 * Yield the [start, end) spans of {...} and [...] records embedded in text —
 * the brace-matching the smoke uses to find bot records (broker-smoke.mjs
 * jsonCandidates), so broker and smoke agree on what counts as a structured
 * record. The broker additionally shapes [...] spans (a superset the smoke
 * ignores): a prefixed array of JSON-in-string values carries the same secret
 * fields as whole-string JSON and must not cross unshaped (TOG-9053
 * finding 2). Ordered outermost-first (siblings in document order): shaping
 * the outermost parseable span first lets the recursive policy redact nested
 * secrets AND outer key names together; innermost-first would stop after the
 * inner span and leave a sensitive outer key name behind as raw text.
 *
 * Quote-aware: a `}` inside a double-quoted JSON string (with backslash
 * escapes) does not close a record — naive brace counting misaligns the span,
 * JSON.parse fails, and the password crosses as "scrubbed raw" (TOG-9053
 * finding 2). Quote state belongs to candidates, not prefixes: an unmatched
 * quote in prose must not suppress records that follow, so an opener with an
 * empty stack always starts a fresh candidate (a `{`/`[` inside a real JSON
 * string necessarily has a non-empty stack). Never throws.
 */
function scanJsonCandidates(text) {
  const out = [];
  const stack = []; // { index, closer }
  const s = String(text ?? "");
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    // Prose quotes outside a candidate never affect JSON quote state.
    if (c === '"' && stack.length > 0) {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") stack.push({ index: i, closer: c === "{" ? "}" : "]" });
    else if ((c === "}" || c === "]") && stack.length > 0 && stack[stack.length - 1].closer === c) {
      const { index: start } = stack.pop();
      out.push([start, i + 1]);
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  return { spans: out, incompleteAt: stack[0]?.index ?? null };
}

export function extractJsonCandidates(text) {
  return scanJsonCandidates(text).spans;
}

/**
 * Shape every {...} or [...] record embedded in a string in one pass.
 * Every parseable span is canonicalized from the bounded shaped result:
 * decoded equality cannot prove original bytes safe when duplicate keys exist.
 * Gaps are scrubbed as text; over-depth spans cross as the placeholder, never
 * raw. No unbounded decoded value is stringified (TOG-9053). Never throws.
 */
export function shapeEmbeddedText(value, secrets, depth = 0) {
  const secretList = Array.isArray(secrets) ? secrets : [];
  // Hide credential delimiters from the scanner WITHOUT changing source bytes
  // or offsets. Decoding must still see original keys to classify sensitivity:
  // replacing a token-shaped password key first would erase that classification.
  value = String(value ?? "");
  let scanView = "";
  let offset = 0;
  for (const [start, end] of mergeSpans(knownSecretSpans(value, secretList))) {
    scanView += value.slice(offset, start) + "x".repeat(end - start);
    offset = end;
  }
  scanView += value.slice(offset);
  const { spans, incompleteAt } = scanJsonCandidates(scanView);
  // An unfinished JSON-like prefix can own quote state and hide every later
  // record. Fail closed from its opener; only the balanced prefix is shaped.
  // That prefix has no unfinished candidate, so this adds at most one scan.
  if (incompleteAt !== null) {
    return (shapeEmbeddedText(value.slice(0, incompleteAt), secretList, depth) + SECRET_PLACEHOLDER).slice(0, MAX_LOG_MESSAGE_CHARS);
  }
  let out = "";
  let pos = 0;
  let changed = false;
  for (const [start, end] of spans) {
    if (start < pos) continue; // inside an already-replaced outer span
    const original = value.slice(start, end);
    let shaped = SECRET_PLACEHOLDER;
    try {
      const decoded = JSON.parse(original);
      shaped = shapeLogValue(decoded, secretList, depth + 1);
    } catch {
      // Complete but malformed containers may also hide quoted secrets. They
      // redact as a unit, except our own fixed placeholder (idempotent).
      if (original === SECRET_PLACEHOLDER) continue;
    }
    // Always emit the bounded shaped value. Comparing with the decoded input
    // loses duplicate-key evidence (JSON.parse keeps only the last value),
    // and stringifying the unbounded input can overflow the stack before the
    // shaping depth guard protects it. Canonicalization is part of the boundary,
    // not a reason to return the original bytes (TOG-9053).
    const encoded = typeof shaped === "string" ? shaped : JSON.stringify(shaped);
    if (encoded === original) continue;
    out += scrubSecrets(value.slice(pos, start), secretList) + encoded;
    pos = end;
    changed = true;
  }
  if (!changed) return scrubSecrets(value, secretList).slice(0, MAX_LOG_MESSAGE_CHARS);
  out += scrubSecrets(value.slice(pos), secretList);
  return out.slice(0, MAX_LOG_MESSAGE_CHARS);
}

/**
 * PEM context is a batch property: a bounded log tail can start inside a key,
 * and one entry can close and reopen blocks. Inspect all marker transitions
 * before shaping or truncation. END without BEGIN redacts the preceding tail;
 * BEGIN without END redacts the remaining batch (TOG-9053).
 */
export const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;

function pemSpans(text) {
  const spans = [];
  const markers = /-----((?:BEGIN|END)) [A-Z ]*PRIVATE KEY-----/g;
  let start = null;
  let lastEnd = 0;
  for (const marker of text.matchAll(markers)) {
    if (marker[1] === "BEGIN") {
      if (start === null) start = marker.index;
    } else {
      const end = marker.index + marker[0].length;
      spans.push([start ?? lastEnd, end]);
      start = null;
      lastEnd = end;
    }
  }
  if (start !== null) spans.push([start, text.length]);
  return spans;
}

function redactSpans(text, spans) {
  let out = "";
  let pos = 0;
  for (const [start, end] of spans) {
    out += text.slice(pos, start) + SECRET_PLACEHOLDER;
    pos = end;
  }
  return out + text.slice(pos);
}

export function redactPemBlock(text) {
  const s = String(text ?? "");
  return redactSpans(s, pemSpans(s));
}

// Conservatively recognize JSON-escaped marker text, including multiple
// string-encoding layers, without parsing away duplicate-key evidence. These
// escapes are used only in the inspection view, never returned as log text.
function pemTextView(text) {
  let view = text;
  for (let depth = 0; depth <= 10; depth += 1) {
    const decoded = view.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape) => JSON.parse(`"${escape}"`));
    if (decoded === view) return view;
    view = decoded;
  }
  return view;
}

// Iterative inspection avoids JSON.stringify on arbitrary panel objects: even
// a 12,000-level wrapper must reach the shaping depth guard, not HTTP 500.
// Bound nodes and text independently; uncertain/over-budget inspection causes
// the entire batch to redact rather than passing unexamined material through.
function pemItemView(item, budget) {
  const pending = [item];
  const parts = [];
  while (pending.length > 0) {
    if (--budget.nodes < 0) return null;
    const value = pending.pop();
    if (typeof value === "string") {
      budget.chars -= value.length + 1;
      if (budget.chars < 0) return null;
      parts.push(pemTextView(value));
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > budget.nodes) return null;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i];
        pending.push(child, key);
      }
    }
  }
  return parts.join("\n");
}

/** Carry marker context across raw, escaped and structured log entries. */
export function applyPemContext(items) {
  const budget = { nodes: MAX_PANEL_BYTES, chars: MAX_PANEL_BYTES };
  const views = [];
  for (const item of items) {
    const view = pemItemView(item, budget);
    if (view === null) return items.map(() => SECRET_PLACEHOLDER);
    views.push(view);
  }
  const spans = pemSpans(views.join("\n"));
  let offset = 0;
  return items.map((item, i) => {
    const view = views[i];
    const start = offset;
    offset += view.length + 1;
    const local = spans
      .filter(([from, to]) => from <= start + view.length && to > start)
      .map(([from, to]) => [Math.max(0, from - start), Math.min(view.length, to - start)]);
    if (local.length === 0) return item;
    // Changed offsets or object structure cannot be spliced safely: collapse
    // the entry, never reinterpret an inspection view as the original payload.
    if (typeof item !== "string" || view !== item) return SECRET_PLACEHOLDER;
    return redactSpans(item, local);
  });
}

export function shapeLogValue(value, secrets, depth = 0) {
  if (depth > 10) return SECRET_PLACEHOLDER;
  if (typeof value === "string") {
    // PEM redacts FIRST, before any JSON parsing: a block whose END marker
    // is beyond this string (or absent) still dies to end-of-string, so JSON
    // embedded in an incomplete PEM suffix never survives to be shaped and
    // re-emitted (TOG-9053 finding 2). Idempotent on clean text.
    const pemSafe = redactPemBlock(value);
    if (pemSafe !== value) return shapeEmbeddedText(pemSafe, secrets, depth);
    // JSON-in-strings decodes before shaping: a log message carrying the
    // bot's ready-line record as escaped JSON must come out as a redacted
    // OBJECT the caller's single JSON.stringify can encode once — returning
    // a stringified blob here would double-encode when nested inside a
    // {message} wrapper and hide the ready line from the smoke's
    // jsonCandidates parser. Unparseable text falls through to the embedded
    // path below, which shapes EVERY span, not just the first (shaping only
    // the first differing span left sibling records raw, and a
    // whitespace-formatted benign span compared unequal and hid the secrets
    // behind it — TOG-9053 finding 2). Every span now re-encodes from its
    // bounded shaped value, including duplicate-key input; smoke-critical
    // fields survive but original whitespace need not. Over-depth spans
    // cross as the placeholder, never raw: discarding a non-object shaped
    // result fell through to raw text, leaking depth-11 payloads.
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
        // Not JSON — fall through to the embedded-record path.
      }
    }
    return shapeEmbeddedText(value, secrets, depth);
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
 * Shape one raw panel log item. Strings run the single string policy in
 * shapeLogValue (whole-string JSON, then embedded-record shaping, then
 * scrubbed raw text); re-encoded JSON keeps its structure for the smoke's
 * ready-line parser. Non-text items are shaped when they are objects, and
 * message-less scalars return null (dropped, not forwarded). Raw, wrapped
 * and embedded inputs share one boundary policy (TOG-9053 finding 2).
 * Never throws.
 */
export function shapeLogItem(item, secrets) {
  const secretList = Array.isArray(secrets) ? secrets : [];
  if (typeof item === "string") {
    const shaped = shapeLogValue(item, secretList);
    // shapeLogValue on a string always returns a string (objects decode and
    // re-shape; over-depth returns the placeholder) — but a raw panel string
    // is never message-less, so a structured result re-encodes as the message
    // rather than dropping.
    return { message: typeof shaped === "string" ? shaped : JSON.stringify(shaped) };
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
  // PEM context BEFORE per-line shaping: a multiline key block split across
  // lines (or across BEGIN/body/END entries) must die as one block — shaping
  // lines in isolation orphans the body from its marker (TOG-9053 finding 2).
  items = applyPemContext(items);
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
        // IDs are untrusted panel output too: a syntactically valid ID can
        // contain a host credential. Reject it whole before storing, logging
        // (including its prefix), or returning anything to the caller.
        if (!DEPLOYMENT_UUID_RE.test(deploymentUuid) || scrubSecrets(deploymentUuid, hostSecrets()) !== deploymentUuid) {
          throw httpError(502, "bad_gateway");
        }
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
        send(res, 200, shapeStatus(panelJson, hostSecrets()));
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
        send(res, 200, shapeStatus(panelJson, hostSecrets()));
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
