#!/usr/bin/env node

// Post-deploy smoke for the TOG-6911 deploy jobs
// (.github/workflows/deploy.yml: deploy-staging, deploy-production).
//
// The bot publishes no ports (docker-compose.yml), so the staging app's
// sslip.io address answers proxy 404 BY DESIGN (docs/DEPLOY.md §6.1) —
// there is no /up to curl. The smoke therefore goes through the panel,
// which is the documented liveness surface (docs/DEPLOY.md §6.1: "poll the
// logs twice a minute apart and check the newest timestamp actually moved"):
//
//   1. the application reports `running:healthy` — the compose healthcheck
//      hits /readyz in-container, which returns 200 only when the Discord
//      gateway is connected AND Postgres answers (a bare `running` would be
//      a process-exists check; scripts/gate-check.ts requires the same
//      `running:healthy` shape);
//   2. the logs carry a FRESH `{"msg":"ready","guilds":N}` line with N >= 1
//      and ts >= --since (the deploy trigger time) — RUNBOOK: "If you see
//      `ready` you are connected to Discord". Freshness ties the line to
//      THIS deploy, not the previous release's surviving log tail;
//   3. the newest log timestamp ADVANCES between two reads a minute apart —
//      the process is alive now, not a corpse that logged ready once.
//
// Never skips: an unanswered panel, a missing fresh ready line, or frozen
// timestamps FAIL (TOG-913). No skip branch.
//
// Usage:
//   COOLIFY_URL=... COOLIFY_TOKEN=... COOLIFY_APP_UUID=... \
//     node scripts/smoke-staging-deploy.mjs --env-name staging \
//       --since 2026-09-28T09:40:00.000Z \
//       [--lines 200] [--interval-seconds 65] [--timeout-seconds 30]
//
// Secret hygiene: only env var NAMES and the app UUID prefix appear in logs.
// The bearer token travels in the Authorization header only, never in a URL.
//
// Exit codes: 0 smoke passed, 1 smoke failed, 2 usage error. Stdlib only.

import { env, exit } from "node:process";

export const DEFAULT_LINES = 200;
export const DEFAULT_INTERVAL_SECONDS = 65;
export const DEFAULT_TIMEOUT_SECONDS = 30;

const TEXT_KEYS = ["message", "output", "log", "line", "text", "content"];
const TS_KEYS = ["timestamp", "ts", "time", "_ts", "created_at"];
const PAYLOAD_KEYS = ["logs", "data", "output", "lines", "result"];

/** Normalize one raw log item into { text, ts } candidates. Never throws. */
export function normalizeItem(item) {
  if (typeof item === "string") return [{ text: item, ts: null }];
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    let text = null;
    for (const key of TEXT_KEYS) {
      if (typeof item[key] === "string") {
        text = item[key];
        break;
      }
    }
    let ts = null;
    for (const key of TS_KEYS) {
      if (typeof item[key] === "string" || typeof item[key] === "number") {
        ts = String(item[key]);
        break;
      }
    }
    return text === null ? [] : [{ text, ts }];
  }
  return [];
}

/** Normalize a panel logs payload into flat { text, ts } lines. Never throws. */
export function normalizeLogPayload(payload) {
  if (typeof payload === "string") {
    return payload.split("\n").flatMap(normalizeItem);
  }
  if (Array.isArray(payload)) {
    return payload.flatMap(normalizeItem);
  }
  if (payload !== null && typeof payload === "object") {
    for (const key of PAYLOAD_KEYS) {
      if (payload[key] !== undefined) return normalizeLogPayload(payload[key]);
    }
  }
  return [];
}

/** Yield each {...} JSON substring candidate in a line, innermost-first. */
export function jsonCandidates(text) {
  const out = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}" && stack.length > 0) {
      const start = stack.pop();
      out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * Find bot log records in normalized lines. Returns [{ record, tsMs }] where
 * record is the parsed bot JSON ({msg, ts, guilds, ...}) and tsMs the
 * millisecond epoch of its timestamp (bot `ts`, else the line-level ts).
 */
export function findBotRecords(lines) {
  const found = [];
  for (const { text, ts } of lines) {
    for (const candidate of jsonCandidates(text)) {
      let record = null;
      try {
        record = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (record === null || typeof record !== "object" || typeof record.msg !== "string") continue;
      const tsRaw = typeof record.ts === "string" ? record.ts : ts;
      const tsMs = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
      found.push({ record, tsMs: Number.isFinite(tsMs) ? tsMs : NaN });
      break;
    }
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
  if (values.since === null) throw new Error("Missing required --since (ISO timestamp of the deploy trigger)");
  const sinceMs = Date.parse(values.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`Invalid --since ${JSON.stringify(values.since)}: expected an ISO timestamp`);
  for (const [label, n] of [["--lines", values.lines], ["--interval-seconds", values.intervalSeconds], ["--timeout-seconds", values.timeoutSeconds]]) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be an integer >= 1`);
  }
  const panelUrl = (lookup("COOLIFY_URL") ?? "").trim().replace(/\/+$/, "");
  const appUuid = (lookup("COOLIFY_APP_UUID") ?? "").trim();
  const token = lookup("COOLIFY_TOKEN") ?? "";
  const missing = [];
  if (panelUrl === "") missing.push("COOLIFY_URL");
  if (typeof token !== "string" || token.trim() === "") missing.push("COOLIFY_TOKEN");
  if (appUuid === "") missing.push("COOLIFY_APP_UUID");
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")} — refusing to skip-and-pass (TOG-913; see TOG-6911)`);
  }
  return { ...values, sinceMs, panelUrl, appUuid, token };
}

function usage() {
  return [
    "Usage: COOLIFY_URL=... COOLIFY_TOKEN=... COOLIFY_APP_UUID=... \\",
    "    node scripts/smoke-staging-deploy.mjs --env-name staging",
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

export async function apiGetJson(panelUrl, token, path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${panelUrl}/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Coolify API answered ${res.status} for ${path}`);
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
  const shortUuid = options.appUuid.slice(0, 8);

  // 1. The app reports running:healthy (compose healthcheck = /readyz:
  // gateway connected AND Postgres answering).
  let appStatus = "";
  try {
    const app = await apiGetJson(options.panelUrl, options.token, `applications/${options.appUuid}`, perRequestMs);
    appStatus = String(app?.status ?? "");
  } catch (error) {
    fail(
      `FAIL smoke (${options.envName}): could not read app ${shortUuid} ` +
        `(${error instanceof Error ? error.message : String(error)}). Refusing to skip-and-pass (TOG-913).`,
    );
  }
  const healthy =
    appStatus.startsWith("running") && appStatus.includes("healthy") && !appStatus.includes("unhealthy");
  if (!healthy) {
    fail(
      `FAIL smoke (${options.envName}): app ${shortUuid} reports ${JSON.stringify(appStatus || "unknown")} ` +
        `— not running:healthy. The release is not serving; roll back via git revert on main (docs/DEPLOY.md §7).`,
    );
  }
  process.stdout.write(`SMOKE (${options.envName}): app ${shortUuid} is ${appStatus}.\n`);

  // 2 + 3. Fresh ready line, and timestamps advancing between two reads.
  const reads = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(options.intervalSeconds * 1000);
    let payload = null;
    try {
      payload = await apiGetJson(
        options.panelUrl,
        options.token,
        `applications/${options.appUuid}/logs?lines=${options.lines}`,
        perRequestMs,
      );
    } catch (error) {
      fail(
        `FAIL smoke (${options.envName}): could not read logs for app ${shortUuid} ` +
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
