#!/usr/bin/env node

// Mirror-settle wait for the TOG-6911 deploy jobs
// (.github/workflows/deploy.yml: deploy-staging, deploy-production).
//
// Coolify clones the HOST mirror (git@135.148.42.223:/srv/git/two-bot.git),
// never github.com — the box cannot clone from GitHub (docs/DEPLOY.md §2,
// TOG-1175). The box re-mirrors GitHub roughly every 2 minutes, so triggering
// a deploy the instant main moves rebuilds the PREVIOUS commit and looks like
// the merge did nothing (docs/DEPLOY.md §6.1).
//
// Runners have no SSH to the box, so there is nothing to poll: this step is a
// bounded delay equal to the mirror interval, then exit 0. MERGE_SHA is
// required so the deploy log records exactly which commit the mirror was
// given time to absorb — when a deploy serves stale code, that line tells
// the operator whether the mirror lagged or the trigger did.
//
// Env:
//   MERGE_SHA            merged commit the deploy must contain (40-hex SHA)
//   MIRROR_POLL_SECONDS  settle delay; default 150 (just over one interval)
//
// Exit codes: 0 after the delay elapses, 2 usage error. Stdlib only, and no
// network: nothing here touches the panel or the mirror.

import { env, exit } from "node:process";

export const DEFAULT_POLL_SECONDS = 150;

export function parseOptions(mergeSha, rawPollSeconds) {
  if (!/^[0-9a-f]{40}$/i.test((mergeSha ?? "").trim())) {
    throw new Error(
      `Invalid MERGE_SHA ${JSON.stringify(mergeSha ?? "")}: expected a 40-hex commit SHA`,
    );
  }
  const raw = ((rawPollSeconds ?? String(DEFAULT_POLL_SECONDS))).trim();
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(
      `Invalid MIRROR_POLL_SECONDS ${JSON.stringify(rawPollSeconds ?? "")}: expected an integer >= 0`,
    );
  }
  return { sha: mergeSha.trim(), seconds };
}

export function settleMessage(sha, seconds) {
  return (
    `MIRROR-SETTLE: waiting ${seconds}s for the host mirror to absorb ${sha.slice(0, 12)} ` +
    `(Coolify clones the mirror, not github.com; runners cannot poll it, so this is a bounded delay).\n`
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: MERGE_SHA=<40-hex-sha> [MIRROR_POLL_SECONDS=<n>] node scripts/wait-for-host-mirror.mjs\n",
  );
  exit(2);
}

async function main() {
  let options;
  try {
    options = parseOptions(env.MERGE_SHA, env.MIRROR_POLL_SECONDS);
  } catch (error) {
    failUsage(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(settleMessage(options.sha, options.seconds));
  await sleep(options.seconds * 1000);
  process.stdout.write(`MIRROR-SETTLE: elapsed; mirror interval covered for ${options.sha.slice(0, 12)}.\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];

if (invokedDirectly) await main();
