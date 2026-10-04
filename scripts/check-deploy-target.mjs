#!/usr/bin/env node

// Deploy-target gate for the TOG-6911 deploy jobs
// (.github/workflows/deploy.yml: deploy-staging, deploy-production).
//
// Exits 0 when every named env var is present and non-blank, exits 1
// otherwise. A missing deploy target FAILS the job — this gate must never
// gain a "skip and pass" branch (TOG-913: a control that reports success
// for work it did not do produces false "it shipped" claims; two-web's
// ci/deploy-target.sh is the in-org precedent).
//
// Transport model: there is no token-in-URL hook. The deploy step POSTs the
// Coolify API (`/api/v1/deploy?uuid=<app>&force=true`) with the panel token
// as an `Authorization: Bearer` HEADER from a self-hosted runner — the same
// shape as docs/DEPLOY.md §6.1 and the wayselect TOG-7131 recipe. So the gate
// checks the bearer credential (--credential-env), the panel URL and the
// Coolify app UUID (--require-env, repeatable). A broad bearer is never
// embedded in a URL and never printed.
//
// There is deliberately no --url-env: a bot publishes no ports
// (docker-compose.yml), so the staging app's sslip.io address answers proxy
// 404 by design (docs/DEPLOY.md §6.1). Liveness is proved through the panel
// instead — scripts/wait-for-coolify-deploy.mjs polls the deployment to
// `finished` and the app to `running:healthy`, whose compose healthcheck is
// /readyz (gateway connected AND database answering).
//
// Secret hygiene: only env var NAMES are ever printed, never values. The
// bearer token reaches later steps via the secrets context directly, never
// through this script's output.
//
// Usage:
//   node scripts/check-deploy-target.mjs --env-name staging \
//     --credential-env COOLIFY_TOKEN \
//     --require-env COOLIFY_URL --require-env TWO_BOT_STAGING_APP_UUID
//
// Exit codes: 0 ready, 1 missing target, 2 usage error. Stdlib only.

import { argv, env, exit } from "node:process";

function usage() {
  return [
    "Usage: node scripts/check-deploy-target.mjs --env-name <name>",
    "    --credential-env <VAR> [--require-env <VAR> ...]",
    "",
    "  --env-name        deployment environment label for log lines (e.g. staging)",
    "  --credential-env  env var holding the Coolify bearer credential",
    "                    (a Bearer HEADER, never a token-in-URL hook)",
    "  --require-env     extra env var that must be present (repeatable:",
    "                    panel URL, Coolify app UUID, ...)",
    "",
    "Only variable NAMES are printed, never values.",
  ].join("\n");
}

export function parseArgs(args) {
  const values = { envName: null, credentialEnv: null, requireEnv: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      exit(0);
    }
    const value = args[i + 1];
    if (flag === "--env-name" || flag === "--credential-env" || flag === "--require-env") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--env-name") values.envName = value;
      else if (flag === "--credential-env") values.credentialEnv = value;
      else values.requireEnv.push(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (values.envName === null) throw new Error("Missing required --env-name");
  if (values.credentialEnv === null) throw new Error("Missing required --credential-env");
  return values;
}

export function findMissing(names, lookup) {
  return names.filter((name) => {
    const value = lookup(name);
    return typeof value !== "string" || value.trim() === "";
  });
}

function main() {
  let args;
  try {
    args = parseArgs(argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`);
    exit(2);
  }

  const names = [args.credentialEnv, ...args.requireEnv];
  const missing = findMissing(names, (name) => env[name]);

  if (missing.length > 0) {
    process.stderr.write(
      `FAIL deploy-target (${args.envName}): missing ${missing.join(", ")} — ` +
        `no deploy target is provisioned. Set the Coolify bearer credential + ` +
        `panel URL + app UUID as repository secrets, then re-run. ` +
        `Refusing to skip-and-pass (TOG-913; see TOG-6911).\n`,
    );
    exit(1);
  }

  process.stdout.write(
    `READY deploy-target (${args.envName}): ${names.join(", ")} present; values redacted.\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) main();
