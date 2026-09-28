#!/usr/bin/env node

// Coolify deploy trigger + settle poll for the TOG-6911 deploy jobs
// (.github/workflows/deploy.yml: deploy-staging, deploy-production).
//
// A 200 from the deploy call only QUEUED the deploy. This step POSTs the
// bearer-header trigger (docs/DEPLOY.md §6.1; the wayselect TOG-7131 recipe),
// then polls the panel until the new deployment reports `finished` AND the
// application reports `running:healthy`. A green job means "it is live".
//
// There is no URL to curl: the bot publishes no ports (docker-compose.yml),
// so the staging app's sslip.io address answers proxy 404 by design
// (docs/DEPLOY.md §6.1). `running:healthy` IS the liveness proof — the
// compose healthcheck hits /readyz in-container, which returns 200 only when
// the Discord gateway is connected AND Postgres answers. A bare `running`
// would be a process-exists check and would not satisfy this step, mirroring
// the `running:healthy` requirement in scripts/gate-check.ts.
//
// Never skips: an unanswered panel, a failed deployment, or an app that
// never reports healthy FAILS (TOG-913). No skip branch: the history here
// reads one record, not a health endpoint.
//
// Usage:
//   COOLIFY_URL=... COOLIFY_TOKEN=... COOLIFY_APP_UUID=... \
//     node scripts/wait-for-coolify-deploy.mjs --env-name staging \
//       [--poll-seconds 30] [--timeout-seconds 600]
//
// Secret hygiene: only env var NAMES and the app UUID prefix appear in logs.
// The bearer token travels in the Authorization header only, never in a URL.
//
// Exit codes: 0 deployed and healthy, 1 deploy failed or never healthy,
// 2 usage error. Stdlib only (global fetch).

import { env, exit } from "node:process";

export const DEFAULT_POLL_SECONDS = 30;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEPLOY_PATH = "/api/v1/deploy";

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
  for (const [label, n] of [["--poll-seconds", values.pollSeconds], ["--timeout-seconds", values.timeoutSeconds]]) {
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
  return { ...values, panelUrl, appUuid, token };
}

function usage() {
  return [
    "Usage: COOLIFY_URL=... COOLIFY_TOKEN=... COOLIFY_APP_UUID=... \\",
    "    node scripts/wait-for-coolify-deploy.mjs --env-name staging",
    "    [--poll-seconds <n>] [--timeout-seconds <n>]",
    "",
    "Triggers the deploy via the bearer-header Coolify API, then polls the",
    "deployment to finished and the app to running:healthy. Never skips.",
  ].join("\n");
}

export function deployUrl(panelUrl, appUuid) {
  return `${panelUrl}${DEPLOY_PATH}?uuid=${encodeURIComponent(appUuid)}&force=true`;
}

export function summarizeDeployResponse(body) {
  const list = Array.isArray(body?.deployments) ? body.deployments : [];
  return list[0]?.deployment_uuid ?? "";
}

export function deploymentTerminal(status) {
  return status === "finished" || status === "failed" || status === "cancelled";
}

export function appHealthy(status) {
  const s = String(status ?? "");
  return s.startsWith("running") && s.includes("healthy") && !s.includes("unhealthy");
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
  const shortUuid = options.appUuid.slice(0, 8);

  // 1. Trigger.
  const triggerController = new AbortController();
  const triggerTimer = setTimeout(() => triggerController.abort(), perRequestMs);
  let deploymentUuid = "";
  try {
    const res = await fetch(deployUrl(options.panelUrl, options.appUuid), {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
      signal: triggerController.signal,
    });
    if (!res.ok) {
      process.stderr.write(
        `FAIL deploy (${options.envName}): trigger for app ${shortUuid} answered HTTP ${res.status}. ` +
          `Nothing was queued; roll nothing back, fix the panel call. Refusing to skip-and-pass (TOG-913).\n`,
      );
      exit(1);
    }
    deploymentUuid = summarizeDeployResponse(await res.json().catch(() => null));
  } catch (error) {
    process.stderr.write(
      `FAIL deploy (${options.envName}): trigger for app ${shortUuid} failed (${error instanceof Error ? error.message : String(error)}). ` +
        `Refusing to skip-and-pass (TOG-913).\n`,
    );
    exit(1);
  } finally {
    clearTimeout(triggerTimer);
  }
  process.stdout.write(`DEPLOY: queued for app ${shortUuid} (deployment ${deploymentUuid || "unknown"}).\n`);

  // 2. Poll the deployment to a terminal status, then the app to healthy.
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await sleep(options.pollSeconds * 1000);
    try {
      if (deploymentUuid !== "") {
        const dep = await apiGetJson(options.panelUrl, options.token, `deployments/${deploymentUuid}`, perRequestMs);
        lastStatus = String(dep?.status ?? "");
        process.stdout.write(`DEPLOY: deployment status: ${lastStatus || "unknown"}\n`);
        if (lastStatus === "failed" || lastStatus === "cancelled") {
          process.stderr.write(
            `FAIL deploy (${options.envName}): deployment ${lastStatus}. ` +
              `Logs: ${options.panelUrl}/project — roll back via git revert on main (docs/DEPLOY.md §7).\n`,
          );
          exit(1);
        }
        if (lastStatus !== "finished") continue;
      }
      const app = await apiGetJson(options.panelUrl, options.token, `applications/${options.appUuid}`, perRequestMs);
      const appStatus = String(app?.status ?? "");
      process.stdout.write(`DEPLOY: application status: ${appStatus || "unknown"}\n`);
      if (appHealthy(appStatus)) {
        process.stdout.write(
          `DEPLOYED (${options.envName}): app ${shortUuid} is ${appStatus} ` +
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
    `FAIL deploy (${options.envName}): app ${shortUuid} not healthy within ${options.timeoutSeconds}s ` +
      `(last status: ${lastStatus || "unknown"}). The deploy was queued but the release is not serving; ` +
      `roll back via git revert on main (docs/DEPLOY.md §7). Refusing to skip-and-pass (TOG-913).\n`,
  );
  exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) await main();
