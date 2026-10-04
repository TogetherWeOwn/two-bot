/**
 * Drive the end-to-end member flows against TWO Staging (TOG-3978).
 *
 *   node scripts/e2e-harness.ts --dry-run                  # no credential, no network
 *   node scripts/e2e-harness.ts --flow reaction --out t.json
 *   node scripts/e2e-harness.ts --kill-switch --reason "Discord flagged the account"
 *
 * WHAT THIS IS FOR. Four cards - TOG-3085, TOG-2796, TOG-3690, TOG-3122 - are
 * blocked on a human joining a Discord server and pressing things, because a
 * bot token cannot accept a rules gate or press its own buttons. The owner
 * approved a throwaway account for that on 2026-09-22 under five conditions;
 * `src/e2e/guard.ts` and `src/e2e/session.ts` are those conditions in code and
 * this script is the way to invoke them.
 *
 * ON-DEMAND ONLY. There is deliberately no workflow, no cron and no npm
 * `pretest` hook that calls this. "Low, human-ish volume" and "runs whenever CI
 * runs" are incompatible, and a scheduler is the easiest way to lose that
 * argument by accident.
 *
 * `--dry-run` HAS NO SESSION AND NO CREDENTIAL. It builds the guard and a
 * transport that reaches nothing, so it proves the step sequence, the pacing
 * and the transcript shape and nothing else. The transcript it writes says
 * `"dryRun": true` at the top level; anything attached as evidence for one of
 * those four cards must say false.
 */
import { writeFileSync } from 'node:fs';
import { FLOWS, flowByKey, missingTargets, type Flow, type FlowTargets } from '../src/e2e/flows.ts';
import { DiscordHarnessTransport } from '../src/e2e/discordTransport.ts';
import { HarnessGuard } from '../src/e2e/guard.ts';
import { tripKillSwitch } from '../src/e2e/killSwitch.ts';
import { exitCodeFor, runFlows } from '../src/e2e/runner.ts';
import { assertStagingGuild, openSession } from '../src/e2e/session.ts';
import { DryRunTransport, type HarnessTransport } from '../src/e2e/transport.ts';
import { DiscordKicker } from '../src/discord/kick.ts';
import { readSecret } from '../src/core/credentials.ts';
import { TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import { E2eSelftestError, runSelftestProbe } from '../src/e2e/selftest.ts';
import { startMockDiscord } from '../tools/mock-discord/server.ts';

const DEFAULT_ASSERTION_TIMEOUT_MS = 15_000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Ids come from the environment, never from source. `src/` carries a snowflake
 * budget that only goes down (scripts/ci/check-src-snowflakes.sh), and beyond
 * the ratchet it means re-pointing the harness at a rebuilt staging guild is a
 * config change rather than a pull request.
 */
function targetsFromEnv(env: NodeJS.ProcessEnv): Partial<FlowTargets> {
  return {
    guildId: env.TWO_E2E_GUILD_ID || TWO_STAGING_GUILD_ID,
    accountId: env.TWO_E2E_ACCOUNT_ID,
    welcomeChannelId: env.TWO_E2E_WELCOME_CHANNEL_ID,
    selfRolePanelChannelId: env.TWO_E2E_SELF_ROLE_CHANNEL_ID,
    selfRolePanelMessageId: env.TWO_E2E_SELF_ROLE_MESSAGE_ID,
    selfRoleEmoji: env.TWO_E2E_SELF_ROLE_EMOJI,
    selfRoleId: env.TWO_E2E_SELF_ROLE_ID,
    ticketPanelChannelId: env.TWO_E2E_TICKET_CHANNEL_ID,
    ticketPanelMessageId: env.TWO_E2E_TICKET_MESSAGE_ID,
    ticketBotId: env.TWO_E2E_TICKET_BOT_ID,
    voiceLobbyChannelId: env.TWO_E2E_VOICE_LOBBY_ID,
  };
}

/**
 * Obviously-fake ids for `--dry-run`, so every flow's step sequence is
 * exercised without a configured guild. They are not snowflake-shaped on
 * purpose: a dry-run transcript that got mislabelled is still recognisable as
 * one from a single line of its output.
 */
function dryRunTargets(): FlowTargets {
  return {
    guildId: TWO_STAGING_GUILD_ID,
    accountId: 'dry-run-account',
    welcomeChannelId: 'dry-run-welcome',
    selfRolePanelChannelId: 'dry-run-self-role-channel',
    selfRolePanelMessageId: 'dry-run-self-role-message',
    selfRoleEmoji: 'dry-run-emoji',
    selfRoleId: 'dry-run-role',
    ticketPanelChannelId: 'dry-run-ticket-channel',
    ticketPanelMessageId: 'dry-run-ticket-message',
    ticketBotId: 'dry-run-ticket-bot',
    voiceLobbyChannelId: 'dry-run-voice-lobby',
  };
}

async function killSwitch(): Promise<number> {
  const guildId = process.env.TWO_E2E_GUILD_ID || TWO_STAGING_GUILD_ID;
  const accountId = process.env.TWO_E2E_ACCOUNT_ID;
  const reason = arg('reason') ?? 'tripped by an operator';
  if (!accountId) {
    console.error('--kill-switch needs TWO_E2E_ACCOUNT_ID so it knows who to remove.');
    return 1;
  }
  // The BOT token does the removal, not the test account's: an account cannot
  // reliably kick itself, and this half must keep working after the user
  // credential has been revoked.
  // Same env order as src/core/config.ts:112 and scripts/verify-grant.ts. The
  // deployed host provisions DISCORD_BOT_TOKEN, so omitting it here would fail
  // the kill switch on the one box where it is most likely to be needed.
  const botToken = readSecret('discord_token', [
    'DISCORD_BOT_TOKEN',
    'DISCORD_TOKEN',
    'TWO_STAGING_BOT_TOKEN',
  ]);
  if (!botToken) {
    console.error(
      '--kill-switch needs the staging bot token (DISCORD_BOT_TOKEN, or DISCORD_TOKEN) ' +
        'to remove the member. See docs/SECRETS.md.',
    );
    return 1;
  }
  const result = await tripKillSwitch({
    guildId,
    accountId,
    reason,
    remover: new DiscordKicker({ token: botToken, guildId }),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}

/**
 * Self-test: boot tools/mock-discord, run one canned probe, report pass.
 * No credential, no live Discord, no writes - the probe is a single GET.
 * `--selftest-base <url>` skips the boot and probes that base instead, so a
 * broken mock URL fails with the same named error the boot path reports.
 */
async function selftest(): Promise<number> {
  const override = arg('selftest-base');
  const mock = override ? null : await startMockDiscord();
  try {
    const apiBase = override ?? mock!.apiBase;
    const result = await runSelftestProbe({ apiBase });
    console.log(`  ok   ${result.probe} -> ${result.gatewayUrl}`);
    console.log('\nself-test passed\n');
    return 0;
  } catch (err) {
    const code = err instanceof E2eSelftestError ? err.code : 'mock_probe_failed';
    console.error(`  FAIL  gateway-bot -> ${code}`);
    console.error(`\nself-test FAILED (${code})\n`);
    return 1;
  } finally {
    await mock?.close();
  }
}

async function main(): Promise<number> {
  if (flag('help')) {
    console.log('usage: node scripts/e2e-harness.ts [--dry-run] [--flow <key>] [--out <file>] [--timeout-ms <n>] [--no-pace] [--kill-switch --reason "<why>"] [--selftest]');
    console.log('');
    console.log('Drive the end-to-end member flows against TWO Staging (TOG-3978).');
    console.log('  --dry-run   no credential, no session, no network; proves step sequence and pacing only');
    console.log('  --selftest  boot tools/mock-discord, run one canned probe, report pass; no credential, no live Discord');
    console.log('Live flows need TWO_E2E_ACCOUNT_ID, TWO_E2E_STAFF_ROLE_ID and a user credential; --help needs none.');
    return 0;
  }
  if (flag('kill-switch')) return killSwitch();
  if (flag('selftest')) return selftest();

  const dryRun = flag('dry-run');
  const only = arg('flow');
  const flows: ReadonlyArray<Flow> = only ? [flowByKey(only)].filter((f): f is Flow => !!f) : FLOWS;
  if (only && flows.length === 0) {
    console.error(`unknown flow "${only}". Known: ${FLOWS.map((f) => f.key).join(', ')}`);
    return 1;
  }

  const targets = dryRun ? dryRunTargets() : targetsFromEnv(process.env);
  const guildId = targets.guildId ?? TWO_STAGING_GUILD_ID;
  assertStagingGuild(guildId);
  const timeoutMs = Number(arg('timeout-ms') ?? DEFAULT_ASSERTION_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be between 1 and 60000.');
  }
  if (!dryRun) {
    if (flag('no-pace')) throw new Error('--no-pace is available only with --dry-run.');
    if (!targets.accountId || !process.env.TWO_E2E_STAFF_ROLE_ID) {
      throw new Error('Live transport needs TWO_E2E_ACCOUNT_ID and TWO_E2E_STAFF_ROLE_ID.');
    }
    const missing = [...new Set(flows.flatMap((flow) => missingTargets(flow, targets)))];
    if (missing.length) throw new Error(`Live flow configuration missing: ${missing.join(', ')}`);
  }

  let guard: HarnessGuard;
  let transport: HarnessTransport;
  let close = (): void => {};

  if (dryRun) {
    // No session, because there is no credential and nothing to keep alive.
    // The pacing is NOT switched off: a dry run that finishes instantly proves
    // the step sequence and nothing about the fence that matters most, and the
    // whole four-flow walk still costs well under a minute. `--no-pace` exists
    // for editing the flows, and stamps itself on the transcript.
    guard = new HarnessGuard(flag('no-pace') ? { minGapMs: 0, jitterMs: 0 } : {});
    transport = new DryRunTransport();
  } else {
    const session = await openSession({
      guildId,
      connect: (token) => DiscordHarnessTransport.connect(token, targets, {
        staffRoleId: process.env.TWO_E2E_STAFF_ROLE_ID!,
      }),
    });
    guard = session.guard;
    transport = session.transport;
    close = session.close;
  }

  try {
    const transcript = await runFlows(
      flows,
      {
        guard,
        transport,
        targets: targets as FlowTargets,
        timeoutMs,
      },
      { dryRun },
    );

    const json = JSON.stringify(transcript, null, 2);
    const out = arg('out');
    if (out) writeFileSync(out, json + '\n');
    else console.log(json);

    for (const f of transcript.flows) {
      console.error(`  ${f.outcome.padEnd(7)} ${f.key.padEnd(15)} ${f.unblocks}  ${f.detail ?? ''}`);
    }
    if (dryRun) console.error('\nDRY RUN - nothing reached Discord. This is not evidence.\n');

    return exitCodeFor(transcript);
  } finally {
    close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  },
);
