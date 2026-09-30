/**
 * Report or remove members who have stayed behind Discord's rules gate for 14
 * days. REPORT-ONLY BY DEFAULT.
 *
 *   node scripts/rules-gate-timeout.ts
 *   node scripts/rules-gate-timeout.ts --execute --expect 3
 *
 * The target rule is deterministic: `pending === true` and Discord's own
 * `joined_at` is at least RULES_GATE_TIMEOUT_DAYS old. Report mode lists the
 * exact accounts and writes one audit line per target, but constructs no
 * removal client and sends no DELETE requests. Execution requires both an
 * explicit `--execute` and a matching `--expect <n>` circuit breaker.
 *
 * It kicks, never bans. The only destructive dependency is DiscordKicker,
 * whose single public action is guarded structurally by its tests.
 *
 * Audit: `data/rules-gate-timeout-audit.jsonl` by default, gitignored because it
 * names individual members. See docs/PRIVACY.md.
 *
 * EXIT CODES  0 clean · 1 aborted or some accounts failed · 2 refused to start
 */
import { readFileSync } from 'node:fs';
import { readSecret } from '../src/core/credentials.ts';
import { DiscordRest, fetchAllMembersStrict } from '../src/discord/rest.ts';
import { DiscordKicker } from '../src/discord/kick.ts';
import { GUILD_ID } from '../src/onboarding/catalog.ts';
import {
  fileAuditSink,
  readAuditLog,
  removeAccounts,
  type AuditRecord,
} from '../src/moderation/raidRemoval.ts';
import {
  RULES_GATE_TIMEOUT_DAYS,
  scanRulesGateTimeouts,
} from '../src/moderation/rulesGateTimeout.ts';

const DAY_MS = 86_400_000;
const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(2, `--${name} needs a value.`);
  return v!;
}
function die(code: number, msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(code);
}

if (flag('help')) {
  console.log('Usage: node scripts/rules-gate-timeout.ts [--guild <id>] [--audit <file>] [--now <ISO>] [--execute --expect <count>]');
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*| \* ?/gm, ''));
  process.exit(0);
}

const execute = flag('execute');
const expectRaw = value('expect');
const token = readSecret('discord_token', ['DISCORD_TOKEN', 'DISCORD_BOT_TOKEN']);
const guildId = value('guild') ?? process.env.DISCORD_GUILD_ID ?? GUILD_ID;
const auditPath = value('audit') ?? 'data/rules-gate-timeout-audit.jsonl';
const nowRaw = value('now');
const nowMs = nowRaw === null ? Date.now() : Date.parse(nowRaw);

if (!token) {
  die(
    2,
    `This report needs DISCORD_TOKEN (or DISCORD_BOT_TOKEN) to read the live roster.\n` +
      `  This company does not currently hold that credential, so build and tests can run here\n` +
      `  but the live report must wait for the separate Discord credential decision (TOG-13).`,
  );
}
if (!Number.isFinite(nowMs)) die(2, `--now must be an ISO-8601 timestamp, got ${nowRaw}.`);

/** Loopback-only test seam: never send a live bot token to an arbitrary host. */
function apiBase(): string | undefined {
  const raw = process.env.RULES_GATE_TIMEOUT_API_BASE;
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    die(2, `RULES_GATE_TIMEOUT_API_BASE is not a URL: ${raw}`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    die(2, `RULES_GATE_TIMEOUT_API_BASE is a test seam and only accepts loopback. Got host ${host}.`);
  }
  return raw;
}

const base = apiBase();
const rest = new DiscordRest(base ? { token, base, minIntervalMs: 0 } : { token });
const members = await fetchAllMembersStrict(rest, guildId);
if (!members) die(1, 'Could not read the complete member roster. Nothing was done.');

const scan = scanRulesGateTimeouts(members, nowMs);
if (scan.invalidJoinedAt.length) {
  die(
    1,
    `${scan.invalidJoinedAt.length} pending member(s) had no usable joined_at timestamp. ` +
      `Refusing a partial report: ${scan.invalidJoinedAt.join(', ')}`,
  );
}

if (execute) {
  if (expectRaw === null) {
    die(2, `--execute requires --expect <n>. This report has ${scan.targets.length} target(s).`);
  }
  const expect = Number(expectRaw);
  if (!Number.isInteger(expect) || expect < 0) die(2, `--expect must be a whole number, got ${expectRaw}.`);
  if (expect !== scan.targets.length) {
    die(
      2,
      `--expect ${expect} but the live report has ${scan.targets.length} target(s). Nothing was done.\n` +
        `  Review the named accounts before deciding whether the report or expectation changed.`,
    );
  }
}

console.log(`\n  Rules-gate timeout — ${execute ? 'EXECUTE' : 'REPORT ONLY'}\n`);
console.log(`    rule           pending for at least ${RULES_GATE_TIMEOUT_DAYS} days`);
console.log(`    roster         ${members.length} (${scan.humans} human, ${scan.bots} bots)`);
console.log(`    pending        ${scan.pending} human member(s)`);
console.log(`    targets        ${scan.targets.length}`);
console.log(`    action         kick  (never ban)`);
console.log(`    guild          ${guildId}`);
console.log(`    audit log      ${auditPath}\n`);
for (const target of scan.targets) {
  const ageDays = Math.floor((nowMs - Date.parse(target.joinedAt)) / DAY_MS);
  console.log(`    ${target.memberId}  joined ${target.joinedAt}  ${ageDays} days pending`);
}
console.log('');

const prior = readAuditLog(auditPath);
const runId = `${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const kicker = execute
  ? new DiscordKicker(base ? { token, guildId, base, minIntervalMs: 0 } : { token, guildId })
  : null;
const summary = await removeAccounts({
  ids: scan.targets.map((target) => target.memberId),
  execute,
  remover: kicker,
  sink: fileAuditSink(auditPath),
  prior,
  reason: `Rules-gate timeout: pending at least ${RULES_GATE_TIMEOUT_DAYS} days (TOG-479).`,
  runId,
  now: () => new Date(nowMs).toISOString(),
  onRecord: (record: AuditRecord) => {
    console.log(`    ${record.outcome.padEnd(13)} ${record.memberId}  ${record.detail}`);
  },
});

console.log('');
if (summary.aborted) {
  console.error(`  ABORTED: ${summary.abortReason}`);
  console.error(`  ${summary.notAttempted.length} account(s) were never attempted.\n`);
  process.exit(1);
}

if (!execute) {
  console.log(
    `  Report only: Discord was read, nobody was removed. ` +
      `Add --execute --expect ${scan.targets.length} only after the 30-day report-only period.\n`,
  );
  process.exit(0);
}

const failures = (summary.counts.forbidden ?? 0) + (summary.counts.rate_limited ?? 0) + (summary.counts.failed ?? 0);
if (failures) {
  console.error(`  ${failures} account(s) did not complete. Re-run the same command; finished ones are skipped.\n`);
  process.exit(1);
}
console.log(`  Done. Every action is in ${auditPath}.\n`);
