#!/usr/bin/env node

// Post-deploy smoke through the staging-only broker
// (ops/staging-deploy-broker/server.mjs) for the TOG-6911 deploy-staging job.
//
// The bot publishes no ports (docker-compose.yml), so the staging app's
// sslip.io address answers proxy 404 BY DESIGN (docs/DEPLOY.md §6.1) —
// there is no /up to curl. The smoke therefore goes through the broker,
// which proxies the panel's bounded, redacted reads for the pinned staging
// app only:
//
//   1. the application reports `running:healthy` — the compose healthcheck
//      hits /readyz in-container, which returns 200 only when the Discord
//      gateway is connected AND Postgres answers;
//   2. the logs carry a FRESH `{"msg":"ready","guilds":N}` line with N >= 1
//      and ts >= --since (the deploy trigger time);
//   3. the newest log timestamp ADVANCES between two reads a minute apart.
//
// Actions holds NO panel bearer: STAGING_BROKER_TOKEN only. The broker is
// reached over public HTTPS through the host's TLS-terminating reverse proxy
// (STAGING_BROKER_URL carries the public https:// origin in CI; the
// bare-loopback default below is local-smoke only). Non-loopback http:// and
// any credential-in-URL shape are refused before any request is sent
// (resolveBrokerUrl, same policy as scripts/broker-deploy.mjs). Never skips:
// an unanswered broker, a missing fresh ready line, or frozen timestamps FAIL
// (TOG-913).
//
// Usage:
//   STAGING_BROKER_TOKEN=... \
//     node scripts/broker-smoke.mjs --env-name staging \
//       --since 2026-09-28T09:40:00.000Z \
//       [--lines 200] [--interval-seconds 65] [--timeout-seconds 30]
//
// Exit codes: 0 smoke passed, 1 smoke failed, 2 usage error. Stdlib only.

import { env, exit } from "node:process";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:8091";
export const DEFAULT_LINES = 200;
export const DEFAULT_INTERVAL_SECONDS = 65;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Resolve the broker origin from STAGING_BROKER_URL, fail-closed.
 *
 * Same policy as scripts/broker-deploy.mjs (deliberately duplicated: these
 * deploy scripts are stdlib-only with no shared module). Empty/unset means
 * local smoke against the loopback default. Anything else must be a bare
 * http(s):// origin: plaintext http:// is allowed ONLY for loopback,
 * non-loopback origins must be https://, credentials in the URL are refused,
 * and path/query/fragment are refused (the proxy must forward at root).
 * Throws with the reason; never returns a broken origin.
 */
export function resolveBrokerUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return DEFAULT_BROKER_URL;
  let url = null;
  try {
    url = new URL(trimmed);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`Invalid STAGING_BROKER_URL ${JSON.stringify(trimmed)}: expected an http(s):// origin`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Invalid STAGING_BROKER_URL: credential-in-URL is refused — the broker token travels in the Authorization header only");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Invalid STAGING_BROKER_URL ${JSON.stringify(trimmed)}: non-loopback origins must be https:// (the broker token never travels over plaintext)`,
    );
  }
  if (!/^\/+$/.test(url.pathname) || url.search !== "" || url.hash !== "") {
    throw new Error(
      `Invalid STAGING_BROKER_URL ${JSON.stringify(trimmed)}: expected a bare origin — the proxy must forward at root, no path prefix`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

const TEXT_KEYS = ["message", "output", "log", "line", "text", "content"];
const TS_KEYS = ["timestamp", "ts", "time", "_ts", "created_at"];
const PAYLOAD_KEYS = ["logs", "data", "output", "lines", "result"];
const RECORD_PAYLOAD_KEYS = [...new Set([...TEXT_KEYS, ...PAYLOAD_KEYS])];

// Match the broker's numeric epoch-millisecond contract without converting
// numbers to strings for Date.parse. Out-of-range epochs cannot prove freshness.
function timestampMs(value) {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
}

function usableTimestamp(item) {
  for (const key of TS_KEYS) {
    if (Number.isFinite(timestampMs(item[key]))) return item[key];
  }
  return null;
}

/** Normalize one raw log item into { text, ts } candidates. Never throws. */
export function normalizeItem(item) {
  if (typeof item === "string") return [{ text: item, ts: null }];
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const key = TEXT_KEYS.find((key) => Object.hasOwn(item, key));
    return key === undefined || typeof item[key] !== "string"
      ? [] : [{ text: item[key], ts: usableTimestamp(item) }];
  }
  return [];
}

/** Normalize a broker logs payload into flat { text, ts } lines. Never throws. */
export function normalizeLogPayload(payload) {
  if (typeof payload === "string") {
    return payload.split("\n").flatMap(normalizeItem);
  }
  if (Array.isArray(payload)) {
    return payload.flatMap(normalizeItem);
  }
  if (payload !== null && typeof payload === "object") {
    for (const key of PAYLOAD_KEYS) {
      if (Object.hasOwn(payload, key)) return normalizeLogPayload(payload[key]);
    }
  }
  return [];
}

// Only these msg labels denote transport rather than a terminal bot event.
// A terminal event's metadata must neither hide it nor become readiness proof.
const TRANSPORT_MESSAGES = new Set(["container_output", "stdout", "stderr"]);

function scanCandidates(text) {
  const spans = [];
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"' && stack.length > 0) quoted = true;
    else if (char === "{" || char === "[") stack.push({ start: i, closer: char === "{" ? "}" : "]" });
    else if (stack.length > 0 && char === stack[stack.length - 1].closer) spans.push([stack.pop().start, i + 1]);
  }
  // Prefer complete parents so traversal retains their timestamp/record type.
  // A recovered child has LOST enclosing record provenance, not just its
  // timestamp. Even a fresh local ts cannot prove it was a terminal event
  // rather than diagnostic metadata; release evidence must reject it.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  let end = 0;
  const incompleteAt = stack[0]?.start ?? Infinity;
  for (const [start, stop] of spans) {
    if (start < end) continue;
    out.push({ text: text.slice(start, stop), recovered: incompleteAt < start });
    end = stop;
  }
  return out;
}

/** Yield outermost COMPLETE containers; a capped wrapper may still contain one. */
export function jsonCandidates(text) {
  return scanCandidates(text).map((candidate) => candidate.text);
}

// Every complete sibling shares a depth/node budget. A batch is not just its
// first record, and a terminal msg is not an envelope around arbitrary metadata.
function findRecordsInText(text, fallbackMs = NaN, depth = 0, budget = { nodes: 10000 }) {
  const found = [];
  if (depth > 10 || budget.nodes <= 0) return found;
  for (const candidate of scanCandidates(text)) {
    if (candidate.recovered) continue;
    let record = null;
    try {
      record = JSON.parse(candidate.text);
    } catch {
      continue;
    }
    found.push(...visitBotRecords(record, fallbackMs, depth, budget));
    if (budget.nodes <= 0) break;
  }
  return found;
}

function visitBotRecords(record, fallbackMs, depth, budget) {
  if (depth > 10 || --budget.nodes < 0 || record === null || typeof record !== "object") return [];
  const ownMs = timestampMs(usableTimestamp(record));
  const wrapperMs = Number.isFinite(ownMs) ? ownMs : fallbackMs;
  if (typeof record.msg === "string" && !TRANSPORT_MESSAGES.has(record.msg)) {
    // Terminal bot ts outranks transport-style fields on the same event.
    const botMs = timestampMs(record.ts);
    return [{ record, tsMs: Number.isFinite(botMs) ? botMs : wrapperMs }];
  }
  if (depth >= 10) return [];
  // A batch is valid only at the log root or through a selected transport
  // payload. Never discover events by walking arbitrary metadata trees. Like
  // normalization, a wrapper has one primary payload: a terminal message must
  // not acquire independent siblings from another field on the same wrapper.
  // Presence fixes authority before type validation: a malformed primary must
  // fail closed, not promote a competing sibling to replace it.
  const key = RECORD_PAYLOAD_KEYS.find((key) => Object.hasOwn(record, key));
  const values = Array.isArray(record) ? record : key === undefined ? [] : [record[key]];
  const found = [];
  for (const value of values) {
    if (typeof value === "string") {
      found.push(...findRecordsInText(value, wrapperMs, depth + 1, budget));
    } else if (value !== null && typeof value === "object") {
      found.push(...visitBotRecords(value, wrapperMs, depth + 1, budget));
    }
    if (budget.nodes <= 0) break;
  }
  return found;
}

/** Find all terminal bot records in normalized lines. Returns [{ record, tsMs }]. */
export function findBotRecords(lines) {
  const found = [];
  for (const { text, ts } of lines) {
    found.push(...findRecordsInText(text, timestampMs(ts)));
  }
  return found;
}

/** Ready lines proving a gateway session: msg ready with guilds >= 1. */
export function findReadyLines(records) {
  return records.filter(
    ({ record }) => record.msg === "ready" && typeof record.guilds === "number" && record.guilds >= 1,
  );
}

/** Newest parseable timestamp across records, or NaN when there is none. */
export function maxTimestampMs(records) {
  let max = NaN;
  for (const { tsMs } of records) {
    if (Number.isFinite(tsMs) && (!Number.isFinite(max) || tsMs > max)) max = tsMs;
  }
  return max;
}

export function parseArgs(args, lookup) {
  const values = {
    envName: null,
    since: null,
    lines: DEFAULT_LINES,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      exit(0);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--env-name") values.envName = value;
    else if (flag === "--since") values.since = value;
    else if (flag === "--lines") values.lines = Number(value);
    else if (flag === "--interval-seconds") values.intervalSeconds = Number(value);
    else if (flag === "--timeout-seconds") values.timeoutSeconds = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
    i += 1;
  }
  if (values.envName === null) throw new Error("Missing required --env-name");
  if (values.envName !== "staging") {
    throw new Error(`Refusing env ${JSON.stringify(values.envName)}: this client smokes staging only, through the staging broker`);
  }
  if (values.since === null) throw new Error("Missing required --since (ISO timestamp of the deploy trigger)");
  const sinceMs = Date.parse(values.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`Invalid --since ${JSON.stringify(values.since)}: expected an ISO timestamp`);
  for (const [label, n] of [["--lines", values.lines], ["--interval-seconds", values.intervalSeconds], ["--timeout-seconds", values.timeoutSeconds]]) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be an integer >= 1`);
  }
  // Empty string falls back to loopback: an unset Actions secret expands to
  // "" and must not override the default with a broken empty origin. Every
  // non-empty value goes through the fail-closed URL policy (resolveBrokerUrl):
  // https:// for non-loopback, no credentials, no path prefix.
  const brokerUrl = resolveBrokerUrl(lookup("STAGING_BROKER_URL"));
  const token = lookup("STAGING_BROKER_TOKEN") ?? "";
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("Missing STAGING_BROKER_TOKEN — refusing to skip-and-pass (TOG-913; see TOG-6911)");
  }
  return { ...values, sinceMs, brokerUrl, token };
}

function usage() {
  return [
    "Usage: STAGING_BROKER_TOKEN=... \\",
    "    node scripts/broker-smoke.mjs --env-name staging",
    "    --since <ISO-timestamp-of-deploy-trigger>",
    "    [--lines <n>] [--interval-seconds <n>] [--timeout-seconds <n>]",
    "",
    "Proves the new release is live: app running:healthy, a fresh ready line",
    "with guilds >= 1, and advancing log timestamps. Never skips.",
  ].join("\n");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function brokerGetJson(brokerUrl, token, path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${brokerUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`broker answered ${res.status} for ${path}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  exit(1);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), (name) => env[name]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`);
    exit(2);
  }
  const perRequestMs = options.timeoutSeconds * 1000;

  // 1. The app reports running:healthy.
  let appStatus = "";
  try {
    const app = await brokerGetJson(options.brokerUrl, options.token, "/v1/staging/app", perRequestMs);
    appStatus = String(app?.status ?? "");
  } catch (error) {
    fail(
      `FAIL smoke (${options.envName}): could not read staging app ` +
        `(${error instanceof Error ? error.message : String(error)}). Refusing to skip-and-pass (TOG-913).`,
    );
  }
  const healthy =
    appStatus.startsWith("running") && appStatus.includes("healthy") && !appStatus.includes("unhealthy");
  if (!healthy) {
    fail(
      `FAIL smoke (${options.envName}): staging app reports ${JSON.stringify(appStatus || "unknown")} ` +
        `— not running:healthy. The release is not serving; roll back via git revert on main (docs/DEPLOY.md §7).`,
    );
  }
  process.stdout.write(`SMOKE (${options.envName}): staging app is ${appStatus}.\n`);

  // 2 + 3. Fresh ready line, and timestamps advancing between two reads.
  const reads = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(options.intervalSeconds * 1000);
    let payload = null;
    try {
      payload = await brokerGetJson(
        options.brokerUrl,
        options.token,
        `/v1/staging/logs?lines=${options.lines}`,
        perRequestMs,
      );
    } catch (error) {
      fail(
        `FAIL smoke (${options.envName}): could not read staging logs ` +
          `(${error instanceof Error ? error.message : String(error)}). Refusing to skip-and-pass (TOG-913).`,
      );
    }
    reads.push(findBotRecords(normalizeLogPayload(payload)));
  }

  const combined = [...reads[0], ...reads[1]];
  const freshReady = findReadyLines(combined).filter(({ tsMs }) => Number.isFinite(tsMs) && tsMs >= options.sinceMs);
  if (freshReady.length === 0) {
    const newest = maxTimestampMs(combined);
    fail(
      `FAIL smoke (${options.envName}): no fresh {"msg":"ready","guilds":N>=1} line at or after ${options.since} ` +
        `(newest parseable log timestamp: ${Number.isFinite(newest) ? new Date(newest).toISOString() : "none"}). ` +
        `The release never proved a gateway session; roll back via git revert on main (docs/DEPLOY.md §7).`,
    );
  }
  const { record } = freshReady[freshReady.length - 1];
  process.stdout.write(
    `SMOKE (${options.envName}): fresh ready line (user ${JSON.stringify(record.user ?? "unknown")}, ` +
      `guilds ${record.guilds}) — gateway session proved for this deploy.\n`,
  );

  const firstMax = maxTimestampMs(reads[0]);
  const secondMax = maxTimestampMs(reads[1]);
  if (!Number.isFinite(secondMax) || !Number.isFinite(firstMax) || !(secondMax > firstMax)) {
    fail(
      `FAIL smoke (${options.envName}): log timestamps did not advance between the two reads ` +
        `(${Number.isFinite(firstMax) ? new Date(firstMax).toISOString() : "none"} vs ` +
        `${Number.isFinite(secondMax) ? new Date(secondMax).toISOString() : "none"}). ` +
        `The process may have died after logging ready (docs/DEPLOY.md §6.1).`,
    );
  }
  process.stdout.write(
    `SMOKE (${options.envName}): timestamps advancing ` +
      `(${new Date(firstMax).toISOString()} -> ${new Date(secondMax).toISOString()}) — process alive.\n`,
  );
  process.stdout.write(`SMOKE (${options.envName}): PASS — staging release is live.\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) await main();
