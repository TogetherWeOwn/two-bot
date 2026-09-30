/**
 * Verifies the bot's LIVE permission grant equals the exact intended bit set,
 * and nothing more. Run it right after a human edits the grant in the Discord
 * UI, which is the only way that grant ever changes:
 *
 *   DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/verify-grant.ts
 *
 * Why this exists separately from preflight.ts: preflight answers "will the
 * funnel collect data?", not "is the grant exactly what we authorised". Since
 * PR #34 it does hard-fail on a dropped Manage Events or Create Instant Invite,
 * so it now catches an under-applied grant. What it structurally cannot catch
 * is an OVER-applied one: it only ever asks "is this bit present?", and
 * Administrator makes every such question answer yes.
 *
 * Measured on this repo (each grant fed to both scripts, exit codes compared):
 *
 *   grant                     preflight   verify-grant
 *   exact six-bit set             0            0
 *   exact + Administrator         0            1   <- the TOG-64 failure
 *   Administrator alone           1            1
 *   dropped Manage Events         1            1
 *   dropped Create Inst. Invite   1            1
 *   exact + Ban Members           0            1
 *
 * Rows 2 and 6 are the whole point. If the human re-invites the bot but leaves
 * the old Administrator role attached - the single most likely way this change
 * gets half-done - preflight prints a WARN and exits 0, and the de-escalation
 * looks applied when nothing was taken away. That is why preflight must not be
 * the acceptance test for this issue, and why this script exists.
 *
 * Exit 0 only when the live grant is bit-for-bit EXPECTED. Any missing bit,
 * any extra bit, and Administrator in particular, is a non-zero exit.
 *
 * The token is never printed. See docs/SECRETS.md.
 */
import { readSecret } from '../src/core/credentials.ts';

const API = 'https://discord.com/api/v10';

/** The intended least-privilege grant for TOG-64. Keep this and the invite
 *  URL in docs/SECRETS.md in lockstep - if you change one, change both. */
export const EXPECTED = 8858373153n;

/** Only the bits this bot has any business holding, by Discord bit position. */
export const NAMES: Record<number, string> = {
  0: 'Create Instant Invite',
  1: 'Kick Members',
  2: 'Ban Members',
  3: 'ADMINISTRATOR',
  4: 'Manage Channels',
  5: 'Manage Server',
  10: 'View Channel',
  11: 'Send Messages',
  16: 'Read Message History',
  28: 'Manage Roles',
  33: 'Manage Events',
  40: 'Moderate Members',
  44: 'Create Events',
};

/** Why each expected bit is held, so a reviewer can challenge it by name
 *  rather than decoding an integer. */
export const RATIONALE: Record<number, string> = {
  0: 'guild.add_member (TOG-57) - Manage Server does NOT imply it',
  5: 'read the invite list for join attribution',
  10: 'see the channels it posts in',
  11: 'announcement.post - narrow to one channel via a channel overwrite',
  28: 'role.assign - needs the bot role ABOVE every role it assigns',
  33: 'event.upsert - a separate bit, not implied by Manage Server',
};

export type Diff = { missing: number[]; extra: number[]; ok: boolean };

/** Pure, so it is testable without a token or a network. */
export function diffGrant(actual: bigint, expected: bigint = EXPECTED): Diff {
  const missing: number[] = [];
  const extra: number[] = [];
  for (let b = 0; b < 64; b++) {
    const inActual = (actual >> BigInt(b)) & 1n;
    const inExpected = (expected >> BigInt(b)) & 1n;
    if (inExpected && !inActual) missing.push(b);
    if (inActual && !inExpected) extra.push(b);
  }
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 };
}

const label = (b: number) => `bit ${b} ${NAMES[b] ?? '(unknown)'}`;

export function report(actual: bigint, log = console.log): boolean {
  const d = diffGrant(actual);
  log(`\n  expected  ${EXPECTED}`);
  log(`  actual    ${actual}\n`);

  if ((actual >> 3n) & 1n) {
    log('  FAIL  bot still has ADMINISTRATOR');
    log('        the de-escalation has NOT been applied - this is the whole point of TOG-64');
  }
  for (const b of d.missing) {
    log(`  FAIL  missing ${label(b)}`);
    if (RATIONALE[b]) log(`        needed for: ${RATIONALE[b]}`);
    log('        this fails SILENTLY at runtime - the action just stops working');
  }
  for (const b of d.extra.filter((x) => x !== 3)) {
    log(`  FAIL  unexpected ${label(b)}  - more access than TOG-64 authorised`);
  }
  if (d.ok) {
    log('  PASS  live grant is exactly the intended least-privilege set');
    for (const b of Object.keys(RATIONALE).map(Number)) log(`        ${label(b)}  ${RATIONALE[b]}`);
  }
  log(d.ok ? '\nGrant verified.\n' : '\nGrant does NOT match. Re-apply the invite URL in docs/SECRETS.md.\n');
  return d.ok;
}

// Everything below is the CLI. It is guarded so that importing this file - from
// a test, or from another script that wants diffGrant() - never demands a token
// and never touches the network.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain && process.argv.includes('--help')) {
  console.log('Usage: node scripts/verify-grant.ts [--selftest]');
  process.exit(0);
}

// --- self-test: `node scripts/verify-grant.ts --selftest`, no token needed ---
if (isMain && process.argv.includes('--selftest')) {
  const cases: [string, bigint, boolean][] = [
    ['exact expected grant', EXPECTED, true],
    ['Administrator only', 8n, false],
    ['expected + Administrator', EXPECTED | 8n, false],
    ['dropped Manage Events (bit 33)', EXPECTED & ~(1n << 33n), false],
    ['dropped Create Instant Invite', EXPECTED & ~1n, false],
    ['extra Ban Members', EXPECTED | (1n << 2n), false],
  ];
  let bad = 0;
  for (const [name, grant, want] of cases) {
    const got = diffGrant(grant).ok;
    const okd = got === want;
    if (!okd) bad++;
    console.log(`  ${okd ? 'ok  ' : 'FAIL'}  ${name} -> ${got ? 'match' : 'mismatch'} (want ${want ? 'match' : 'mismatch'})`);
  }
  console.log(bad === 0 ? '\nself-test passed\n' : `\nself-test FAILED (${bad})\n`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!isMain) {
  // imported as a library - stop here, the pure helpers above are the API
} else {
const token = readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN']);
if (!token) {
  console.error('Missing bot token. Set DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) {
  console.error('Set DISCORD_GUILD_ID - this check is meaningless against the wrong server.');
  process.exit(2);
}

const res = await fetch(`${API}/users/@me/guilds`, { headers: { Authorization: `Bot ${token}` } });
if (res.status !== 200) {
  console.error(`Discord rejected the token (HTTP ${res.status}). See docs/SECRETS.md.`);
  process.exit(2);
}
const guilds = (await res.json()) as { id: string; name: string; permissions: string }[];
const guild = guilds.find((g) => g.id === guildId);
if (!guild) {
  console.error(`Bot is not in guild ${guildId}. Authorise the invite URL in docs/SECRETS.md first.`);
  process.exit(2);
}

console.log(`\nTWO bot grant check\n\n  ${guild.name} (${guild.id})`);
process.exit(report(BigInt(guild.permissions)) ? 0 : 1);
}
