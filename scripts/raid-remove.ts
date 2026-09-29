/**
 * Remove raid accounts. DRY RUN BY DEFAULT — `--execute` is the only way to
 * change anything, and it has to be typed.
 *
 *   node scripts/raid-list.ts --ids > data/targets.txt
 *   node scripts/raid-remove.ts --ids-from data/targets.txt          # dry run
 *   node scripts/raid-remove.ts --ids-from - < data/targets.txt      # same, from a pipe
 *   node scripts/raid-remove.ts --ids-from data/targets.txt --execute --expect 30
 *
 * It kicks. It never bans — a kicked account can come back through the rules
 * gate, a banned one cannot, and unbanning thirty accounts by hand is not a
 * realistic undo. There is no ban code path to enable (src/discord/kick.ts).
 *
 * WHY --expect IS MANDATORY FOR --execute
 *
 * The authorised count is not settled. The authorisation says nineteen in one
 * sentence and implies thirty in another; that is with the Chief of Staff
 * (TOG-411, TOG-451) and this script is not the place it gets decided. So the
 * operator has to state the number they believe they are authorised to remove,
 * and the run refuses if the file in front of them disagrees. A list that
 * silently grew by eleven between being produced and being run is the exact
 * accident this catches.
 *
 * WHAT IT WRITES
 *
 * One JSON line per account — id, action, outcome, HTTP status, timestamp —
 * appended and fsync'd before the next account is touched. Default
 * `data/raid-removal-audit.jsonl`, which .gitignore excludes: that file names
 * individual members and must not reach GitHub (docs/PRIVACY.md).
 *
 * SAFE TO RE-RUN. Anything already kicked or already gone is skipped without a
 * request. Anything that failed is retried. If the process is killed between a
 * successful kick and its audit line, the retry gets a 404 and records
 * `already_gone`. No input to this double-acts.
 *
 * EXIT CODES  0 clean · 1 aborted or some accounts failed · 2 refused to start
 */
import { readFileSync } from 'node:fs';
import { GUILD_ID } from '../src/onboarding/catalog.ts';
import { DiscordKicker } from '../src/discord/kick.ts';
import {
  crossCheck,
  fileAuditSink,
  parseIdList,
  readAuditContext,
  readAuditLog,
  removeAccounts,
  type AuditRecord,
} from '../src/moderation/raidRemoval.ts';

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

if (flag('help') || argv.length === 0) {
  console.log('usage: node scripts/raid-remove.ts --ids-from <file|-> [--execute --expect N]');
  console.log('');
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*| \* ?/gm, ''));
  process.exit(0);
}

const execute = flag('execute');
const idsFrom = value('ids-from') ?? die(2, 'need --ids-from <file>, or --ids-from - to read stdin.');
const auditPath = value('audit') ?? 'data/raid-removal-audit.jsonl';
const guildId = value('guild') ?? process.env.DISCORD_GUILD_ID ?? GUILD_ID;
const contextPath = value('context') ?? 'audit/summary.json';
const reason = value('reason') ?? 'Raid account removal (TOG-411). Never posted, never joined voice.';
const expectRaw = value('expect');

// -- the target list ---------------------------------------------------------

let text: string;
try {
  text = idsFrom === '-' ? readFileSync(0, 'utf8') : readFileSync(idsFrom, 'utf8');
} catch (err) {
  die(2, `could not read ${idsFrom === '-' ? 'stdin' : idsFrom}: ${String(err)}`);
}

let parsed;
try {
  parsed = parseIdList(text, idsFrom === '-' ? 'stdin' : idsFrom);
} catch (err) {
  die(2, String(err instanceof Error ? err.message : err));
}

if (parsed.rejected.length) {
  console.error(`\n  ${parsed.rejected.length} line(s) in ${idsFrom} are not Discord ids:\n`);
  for (const r of parsed.rejected.slice(0, 10)) {
    console.error(`    line ${r.line}: ${JSON.stringify(r.value)}`);
  }
  die(2, 'Refusing to run on a list I did not fully understand. Fix or remove those lines.');
}

// -- the count gate ----------------------------------------------------------

if (execute) {
  if (expectRaw === null) {
    die(
      2,
      `--execute requires --expect <n>: the number of accounts you are authorised to remove.\n` +
        `  This list has ${parsed.ids.length}. State it deliberately — the authorised count is\n` +
        `  still open (19 vs 30, TOG-411) and this script does not get to decide it.`,
    );
  }
  const expect = Number(expectRaw);
  if (!Number.isInteger(expect) || expect < 0) die(2, `--expect must be a whole number, got ${expectRaw}.`);
  if (expect !== parsed.ids.length) {
    die(
      2,
      `--expect ${expect} but ${idsFrom} has ${parsed.ids.length} unique ids. Nothing was done.\n` +
        `  One of the two is wrong and finding out which is the whole point of this check.`,
    );
  }
}

// -- what a previous run already settled -------------------------------------

const prior = readAuditLog(auditPath);
const remaining = parsed.ids.filter((id) => !prior.done.has(id));

// -- report ------------------------------------------------------------------

console.log(`\n  Raid account removal — ${execute ? 'EXECUTE' : 'DRY RUN'}\n`);
console.log(`    target list   ${idsFrom}  (${parsed.ids.length} unique ids)`);
console.log(`    action        kick  (never ban)`);
console.log(`    guild         ${guildId}`);
console.log(`    audit log     ${auditPath}`);
if (parsed.duplicates.length) {
  console.log(`    duplicates    ${parsed.duplicates.length} repeated id(s) in the input, counted once`);
}
if (prior.lines) {
  console.log(
    `    already done  ${prior.done.size} of these have a terminal outcome recorded` +
      (prior.unparseable ? `  (${prior.unparseable} unreadable line(s) in the log)` : ''),
  );
}
console.log(`    to attempt    ${remaining.length}\n`);

const ctx = readAuditContext(contextPath);
if (ctx) {
  console.log(`    Cross-check against ${contextPath} (collected ${ctx.collectedAt.slice(0, 10)}):`);
  console.log(
    `      ${ctx.humanMembers} human members recorded, ${ctx.stuckAtRulesScreening} of them stuck at the rules gate.`,
  );
  console.log(
    `      Removing ${parsed.ids.length} leaves ${ctx.humanMembers - parsed.ids.length} of the counted humans.\n`,
  );
  const warnings = crossCheck(ctx, parsed.ids.length, guildId);
  for (const w of warnings) console.log(`      WARNING: ${w}\n`);
} else {
  console.log(`    No cross-check: ${contextPath} is absent or unreadable.\n`);
}

// -- go ----------------------------------------------------------------------

const token = execute ? (process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN) : null;
if (execute && !token) {
  die(
    2,
    `--execute needs DISCORD_TOKEN (or DISCORD_BOT_TOKEN) and there is none set.\n` +
      `  Do not go looking for one: the Discord credentials for this server are not held by\n` +
      `  this company (TOG-432). Execution is tracked on TOG-411, blocked on that decision.\n` +
      `  The dry run above is the part that works today.`,
  );
}

/**
 * Test seam, loopback only.
 *
 * scripts/wave0-export.ts takes any host in `WAVE0_API_BASE`, which is fine for
 * a read-only script. This one sends a bot token with every request, so an
 * unrestricted override would be a one-environment-variable way to post that
 * token to somebody else's server. Loopback is enough for a stub and cannot
 * reach anything.
 */
function apiBase(): string | undefined {
  const raw = process.env.RAID_REMOVE_API_BASE;
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    die(2, `RAID_REMOVE_API_BASE is not a URL: ${raw}`);
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    die(2, `RAID_REMOVE_API_BASE is a test seam and only accepts loopback. Got host ${host}.`);
  }
  return raw;
}

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const base = apiBase();
const kicker = token
  ? new DiscordKicker(base ? { token, guildId, base, minIntervalMs: 0 } : { token, guildId })
  : null;

const summary = await removeAccounts({
  ids: parsed.ids,
  execute,
  remover: kicker,
  sink: fileAuditSink(auditPath),
  prior,
  reason,
  runId,
  onRecord: (r: AuditRecord) => {
    const label = r.outcome.padEnd(13);
    console.log(`    ${label} ${r.memberId}${r.status ? `  ${r.status}` : ''}  ${r.detail}`);
  },
});

console.log('');
for (const [outcome, n] of Object.entries(summary.counts).sort()) {
  console.log(`    ${String(n).padStart(5)}  ${outcome}`);
}
console.log('');

if (summary.aborted) {
  console.error(`  ABORTED: ${summary.abortReason}`);
  console.error(`  ${summary.notAttempted.length} account(s) were never attempted.\n`);
  process.exit(1);
}

if (!execute) {
  console.log(`  Nothing was contacted and nothing was changed. Add --execute --expect ${parsed.ids.length} to act.\n`);
  process.exit(0);
}

const failures = (summary.counts.forbidden ?? 0) + (summary.counts.rate_limited ?? 0) + (summary.counts.failed ?? 0);
if (failures) {
  console.error(`  ${failures} account(s) did not complete. Re-run the same command; finished ones are skipped.\n`);
  process.exit(1);
}
console.log(`  Done. Every line is in ${auditPath}.\n`);
