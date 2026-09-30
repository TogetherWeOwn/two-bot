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
// Transport model: Actions holds NO panel bearer. Staging deploys through the
// staging-only broker (ops/staging-deploy-broker/server.mjs), reached over
// public HTTPS through the host's TLS-terminating reverse proxy — deploy jobs
// run on ubuntu-latest (public repo, #304), so host loopback is unreachable
// from the runner. The panel bearer lives on the host inside the broker's
// systemd unit; the broker admits only the pinned staging app. So the gate
// checks the scoped broker credential (--credential-env), the public broker
// origin STAGING_BROKER_URL and the merge SHA (--require-env, repeatable).
// The broker token travels in an Authorization header only and is never
// printed; credential-in-URL and plaintext non-loopback origins are refused
// by the clients (resolveBrokerUrl) before any request is sent.
//
// There is deliberately no app-URL check: a bot publishes no ports
// (docker-compose.yml), so the staging app's sslip.io address answers proxy
// 404 by design (docs/DEPLOY.md §6.1). Liveness is proved through the broker
// instead — scripts/broker-deploy.mjs polls the deployment to `finished` and
// the app to `running:healthy`, whose compose healthcheck is /readyz
// (gateway connected AND database answering).
//
// Secret hygiene: only env var NAMES are ever printed, never values. The
// broker token reaches later steps via the secrets context directly, never
// through this script's output.
//
// Usage:
//   node scripts/check-deploy-target.mjs --env-name staging \
//     --credential-env STAGING_BROKER_TOKEN \
//     --require-env STAGING_BROKER_URL --require-env MERGE_SHA
//
// Exit codes: 0 ready, 1 missing target, 2 usage error. Stdlib only.

import { argv, env, exit } from "node:process";

function usage() {
  return [
    "Usage: node scripts/check-deploy-target.mjs --env-name <name>",
    "    --credential-env <VAR> [--require-env <VAR> ...]",
    "",
    "  --env-name        deployment environment label for log lines (e.g. staging)",
    "  --credential-env  env var holding the scoped staging broker credential",
    "                    (a Bearer HEADER, never a token-in-URL hook)",
    "  --require-env     extra env var that must be present (repeatable:",
    "                    broker origin, merge SHA, ...)",
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
        `no deploy target is provisioned. Set the scoped staging broker credential + ` +
        `broker origin + merge SHA as repository secrets, then re-run. ` +
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
