#!/usr/bin/env node

// Staging deploy trigger + settle poll through the staging-only broker
// (ops/staging-deploy-broker/server.mjs) for the TOG-6911 deploy-staging job.
//
// TRANSPORT. Actions holds NO panel bearer. This script speaks only to the
// broker on loopback (default http://127.0.0.1:8091, override
// STAGING_BROKER_URL) with the scoped staging credential STAGING_BROKER_TOKEN
// as an Authorization Bearer header. The panel bearer lives on the host inside
// the broker's systemd unit; the broker's server-side authority admits only
// the pinned two-bot staging app (uy4d9ndeygjcem6lgayhxgub) and rejects
// arbitrary app UUIDs and production (operator hand-back, 2026-09-28).
//
// A 200 from the broker only QUEUED the deploy. This script POSTs
// /v1/staging/deploy {repo, sha} — the broker validates caller/repo/commit —
// then polls the broker's bounded, redacted status endpoints until the
// deployment reports `finished` AND the app reports `running:healthy` (the
// compose healthcheck is /readyz: gateway connected AND Postgres answering).
// A green job means "it is live". There is no URL to curl: the bot publishes
// no ports, so the sslip.io address answers proxy 404 by design.
//
// Never skips: an unanswered broker, a failed deployment, or an app that
// never reports healthy FAILS (TOG-913).
//
// Usage:
//   STAGING_BROKER_TOKEN=... [STAGING_BROKER_URL=http://127.0.0.1:8091] \
//     MERGE_SHA=<40-hex-sha> \
//     node scripts/broker-deploy.mjs --env-name staging \
//       [--poll-seconds 30] [--timeout-seconds 600]
//
// Secret hygiene: only env var NAMES appear in logs. The broker token travels
// in the Authorization header only, never in a URL.
//
// Exit codes: 0 deployed and healthy, 1 deploy failed or never healthy,
// 2 usage error. Stdlib only (global fetch).

import { env, exit } from "node:process";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:8091";
export const DEFAULT_POLL_SECONDS = 30;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const PINNED_REPO = "TogetherWeOwn/two-bot";

export function parseArgs(args, lookup) {
  const values = { envName: null, pollSeconds: DEFAULT_POLL_SECONDS, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
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
    else if (flag === "--poll-seconds") values.pollSeconds = Number(value);
    else if (flag === "--timeout-seconds") values.timeoutSeconds = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
    i += 1;
  }
  if (values.envName === null) throw new Error("Missing required --env-name");
  if (values.envName !== "staging") {
    throw new Error(`Refusing env ${JSON.stringify(values.envName)}: this client deploys staging only, through the staging broker`);
  }
  for (const [label, n] of [["--poll-seconds", values.pollSeconds], ["--timeout-seconds", values.timeoutSeconds]]) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be an integer >= 1`);
  }
  // Empty string falls back to loopback: an unset Actions secret expands to
  // "" and must not override the default with a broken empty origin.
  const rawBrokerUrl = (lookup("STAGING_BROKER_URL") ?? "").trim();
  const brokerUrl = (rawBrokerUrl === "" ? DEFAULT_BROKER_URL : rawBrokerUrl).replace(/\/+$/, "");
  const token = lookup("STAGING_BROKER_TOKEN") ?? "";
  const sha = (lookup("MERGE_SHA") ?? "").trim();
  const missing = [];
  if (typeof token !== "string" || token.trim() === "") missing.push("STAGING_BROKER_TOKEN");
  if (!/^[0-9a-f]{40}$/i.test(sha)) missing.push("MERGE_SHA (40-hex commit SHA)");
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")} — refusing to skip-and-pass (TOG-913; see TOG-6911)`);
  }
  return { ...values, brokerUrl, token, sha: sha.toLowerCase() };
}

function usage() {
  return [
    "Usage: STAGING_BROKER_TOKEN=... MERGE_SHA=<40-hex-sha> \\",
    "    node scripts/broker-deploy.mjs --env-name staging",
    "    [--poll-seconds <n>] [--timeout-seconds <n>]",
    "",
    "Triggers the staging deploy through the staging-only broker, then polls",
    "the deployment to finished and the app to running:healthy. Never skips.",
  ].join("\n");
}

export function deploymentTerminal(status) {
  return status === "finished" || status === "failed" || status === "cancelled";
}

export function appHealthy(status) {
  const s = String(status ?? "");
  return s.startsWith("running") && s.includes("healthy") && !s.includes("unhealthy");
}

export async function brokerJson(brokerUrl, token, path, { method = "GET", body = undefined, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${brokerUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`broker answered ${res.status} for ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), (name) => env[name]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`);
    exit(2);
  }
  const perRequestMs = 60_000;
  const shortSha = options.sha.slice(0, 12);

  // 1. Trigger through the broker (it validates repo + sha server-side).
  let deploymentUuid = "";
  try {
    const queued = await brokerJson(options.brokerUrl, options.token, "/v1/staging/deploy", {
      method: "POST",
      body: { repo: PINNED_REPO, sha: options.sha },
      timeoutMs: perRequestMs,
    });
    deploymentUuid = String(queued?.deployment_uuid ?? "");
    if (deploymentUuid === "") throw new Error("broker returned no deployment_uuid");
  } catch (error) {
    process.stderr.write(
      `FAIL deploy (${options.envName}): broker trigger for ${shortSha} failed (${error instanceof Error ? error.message : String(error)}). ` +
        `Nothing was queued; roll nothing back, fix the broker call. Refusing to skip-and-pass (TOG-913).\n`,
    );
    exit(1);
  }
  process.stdout.write(`DEPLOY: queued for sha ${shortSha} (deployment ${deploymentUuid.slice(0, 12)}).\n`);

  // 2. Poll the deployment to a terminal status, then the app to healthy.
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await sleep(options.pollSeconds * 1000);
    try {
      const dep = await brokerJson(options.brokerUrl, options.token, `/v1/staging/deployments/${deploymentUuid}`, { timeoutMs: perRequestMs });
      lastStatus = String(dep?.status ?? "");
      process.stdout.write(`DEPLOY: deployment status: ${lastStatus || "unknown"}\n`);
      if (lastStatus === "failed" || lastStatus === "cancelled") {
        process.stderr.write(
          `FAIL deploy (${options.envName}): deployment ${lastStatus}. ` +
            `Roll back via git revert on main (docs/DEPLOY.md §7).\n`,
        );
        exit(1);
      }
      if (lastStatus !== "finished") continue;
      const app = await brokerJson(options.brokerUrl, options.token, "/v1/staging/app", { timeoutMs: perRequestMs });
      const appStatus = String(app?.status ?? "");
      process.stdout.write(`DEPLOY: application status: ${appStatus || "unknown"}\n`);
      if (appHealthy(appStatus)) {
        process.stdout.write(
          `DEPLOYED (${options.envName}): sha ${shortSha} is ${appStatus} ` +
            `(/readyz via the compose healthcheck: gateway connected and Postgres answering). ` +
            `Rollback if needed: git revert on main + redeploy (docs/DEPLOY.md §7).\n`,
        );
        return;
      }
      lastStatus = appStatus;
    } catch (error) {
      process.stdout.write(`DEPLOY: poll error, retrying: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.stderr.write(
    `FAIL deploy (${options.envName}): sha ${shortSha} not healthy within ${options.timeoutSeconds}s ` +
      `(last status: ${lastStatus || "unknown"}). The deploy was queued but the release is not serving; ` +
      `roll back via git revert on main (docs/DEPLOY.md §7). Refusing to skip-and-pass (TOG-913).\n`,
  );
  exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) await main();
