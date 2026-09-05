/**
 * The Friday growth gate check: six criteria, all required, five of six is red.
 *
 *   node scripts/gate-check.ts
 *   node scripts/gate-check.ts --json     # same verdict, for a comment or a bot
 *
 * READ-ONLY. It writes nothing, messages nobody, and never prints a token or a
 * member identity. Safe to run on any box, any time, by anyone.
 *
 * WHY THIS EXISTS
 *
 * The founder gated every outward-facing growth channel on the bot AND the
 * website being live (20 Aug 2026, `event-go-no-go` §0). The Chief of Staff
 * checks the six criteria every Friday 21:00 UK, and TOG-92's weekly scoring
 * loop does not start until one comes back green.
 *
 * That check was prose: read the doc, form a view on each of six lines, write a
 * comment. Six judgement calls re-made weekly by whoever is awake. It produced
 * exactly the failure you would expect - a run that said "the gate is red",
 * named no criterion, cited no evidence, and left nothing anyone could re-run.
 * This script gives the same input the same answer every week, and prints the
 * evidence beside each line so the verdict can be argued with.
 *
 * WHAT IT CAN AND CANNOT SEE
 *
 * Two criteria are not observable from a runtime with no live host and no
 * token: the systemd service, and the routed-welcome test. Those report
 * `UNKNOWN`, which counts as red - never as green. `verdict()` in
 * src/growth/gate.ts treats an unknown exactly as hard as a fail, because a
 * gate that goes green on six shrugs is worse than having no gate.
 *
 * Exit: 0 green, 1 red. Red is a normal weekly outcome, not a malfunction.
 */
import { openDb } from '../src/store/db.ts';
import {
  EXIT_CODE,
  WEB_HOMEPAGE_CODE,
  allChecks,
  failing,
  scoringLoopRuns,
  verdict,
  type Criterion,
  type Observations,
} from '../src/growth/gate.ts';

const json = process.argv.slice(2).includes('--json');

/** The apex, not a preview URL. Website criterion 1 turns on that distinction. */
const SITE = 'https://two.gg';

const o: Observations = {};

// --- bot criterion 1: the service ------------------------------------------
//
// systemctl is not reachable from the agent runtime and TOG-13 has not stood a
// live host up, so from here this is structurally unknowable rather than false.
// Left to gate.ts to phrase; we only report what we could and could not reach.
if (process.env.TWO_GATE_SERVICE_ACTIVE === '1') {
  o.serviceActive = true;
  o.serviceDetail = 'reported active by the caller (TWO_GATE_SERVICE_ACTIVE=1).';
} else if (process.env.TWO_GATE_SERVICE_ACTIVE === '0') {
  o.serviceActive = false;
  o.serviceDetail = 'reported inactive by the caller (TWO_GATE_SERVICE_ACTIVE=0).';
}

// --- bot criterion 3: the routed welcome -----------------------------------
//
// Needs a human to run a test account through the rules gate. There is no way
// to observe it from here, and inventing one would be the dry-run trap: a green
// that proves the guards rather than the call.
if (process.env.TWO_GATE_WELCOME_OK === '1') {
  o.welcomeDelivered = true;
  o.welcomeDetail = 'a test account cleared the gate and the routed welcome arrived (reported by the caller).';
} else if (process.env.TWO_GATE_WELCOME_OK === '0') {
  o.welcomeDelivered = false;
}

// --- website criterion 1: the real domain ----------------------------------
try {
  const res = await fetch(SITE, { redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  const landed = new URL(res.url).hostname.replace(/^www\./, '');
  const apex = new URL(SITE).hostname.replace(/^www\./, '');
  if (res.ok && landed === apex) {
    o.domainLive = true;
    o.domainDetail = `${apex} answers ${res.status} and serves its own content.`;
  } else if (landed !== apex) {
    // The failure we actually have today: two.gg resolves to the old WordPress
    // site. That is not Phase 1 on the real domain, however alive it looks.
    o.domainLive = false;
    o.domainDetail = `${apex} returned ${res.status} and redirected to ${landed} - the old site, not Phase 1.`;
  } else {
    o.domainLive = false;
    o.domainDetail = `${apex} returned ${res.status}.`;
  }
} catch (err) {
  o.domainDetail = `${SITE} could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}

// --- the funnel: bot criterion 2 and website criterion 3 -------------------
//
// Both read the same table, so they share one connection. attribution.ts is
// explicit that this works without a deployed bot - it reads whatever
// `npm run capture` has written - so an unbound URL here means "nobody gave us
// the database", not "the bot is down".
const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH;
if (!dbSpec) {
  const why = 'neither TWO_DATABASE_URL nor TWO_DB_PATH is bound in this environment.';
  o.funnelDetail = why;
  o.webCodeRowDetail = why;
} else {
  let db;
  try {
    db = await openDb(dbSpec, { skipMigrations: true, poolMax: 2, applicationName: 'two-bot-gate-check' });
  } catch (err) {
    const why = `the funnel database could not be opened: ${err instanceof Error ? err.message : String(err)}`;
    o.funnelDetail = why;
    o.webCodeRowDetail = why;
  }

  if (db) {
    try {
      // A join counts for criterion 2 only if it carries a real invite code.
      // `backfill:*` rows are reconstructed from the server's own log and are
      // attributed to nothing; ledger §0 is explicit that all 3 joins in the
      // 90-day baseline are backfill. Excluding the prefix is the whole check.
      const rows = await db
        .prepare(
          `SELECT source, COUNT(*) AS n FROM events
            WHERE event_type='member_join' AND member_id IS NOT NULL AND source LIKE 'invite:%'
            GROUP BY source`,
        )
        .all<{ source: string; n: number }>();

      o.attributedJoins = rows.reduce((sum, r) => sum + Number(r.n), 0);

      // Say what the joins on file ARE, not just that none are attributed.
      // "0 attributed" over an empty table and "0 attributed out of 3 backfill
      // rows" are different findings, and only the second one is the baseline.
      const others = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM events
            WHERE event_type='member_join' AND member_id IS NOT NULL AND source NOT LIKE 'invite:%'`,
        )
        .all<{ n: number }>();
      const unattributed = Number(others[0]?.n ?? 0);
      o.funnelDetail = o.attributedJoins
        ? `${rows.length} code(s) with attributed joins on file.`
        : unattributed
          ? `${unattributed} join(s) on file, none carrying an invite code (backfill and vanity rows are attributed to nothing).`
          : 'the events table holds no member_join rows at all.';

      // Criterion 3 asks for the code to appear as its own ROW, which is a
      // stronger claim than "the code exists": a bound invite with no joins
      // produces a registry entry and no funnel row.
      const web = rows.find((r) => r.source === `invite:${WEB_HOMEPAGE_CODE}`);
      o.webCodeRowPresent = web !== undefined;
      o.webCodeRowDetail = web
        ? `${WEB_HOMEPAGE_CODE} has ${Number(web.n)} attributed join(s).`
        : `${WEB_HOMEPAGE_CODE} has no row in the funnel - no join has ever arrived on it.`;
    } catch (err) {
      const why = `the funnel could not be read: ${err instanceof Error ? err.message : String(err)}`;
      o.funnelDetail = why;
      o.webCodeRowDetail = why;
    } finally {
      await db.close();
    }
  }
}

// --- website criterion 2: the tracked join button --------------------------
//
// Only meaningful once the domain serves Phase 1. Asking a WordPress page for a
// join button and recording "absent" would be a fail we invented rather than
// one we observed, so this stays unknown while criterion 1 is not ok.
if (o.domainLive === false) {
  o.joinButtonDetail = 'not exercised - the real domain does not serve Phase 1 yet, so there is no button to click.';
}

// --- report -----------------------------------------------------------------

const checks = allChecks(o);
const v = verdict(checks);

if (json) {
  console.log(
    JSON.stringify(
      { verdict: v, scoringLoopRuns: scoringLoopRuns(v), checkedAt: new Date().toISOString(), checks },
      null,
      2,
    ),
  );
  process.exit(EXIT_CODE[v]);
}

const LABEL: Record<Criterion['status'], string> = { ok: 'ok     ', fail: 'FAIL   ', unknown: 'UNKNOWN' };

function print(c: Criterion): void {
  console.log(`  ${LABEL[c.status]}  ${c.title}`);
  console.log(`           ${c.detail}`);
  if (c.owner) console.log(`           owner: ${c.owner}`);
  if (c.action) console.log(`           -> ${c.action}`);
  console.log('');
}

console.log('\nTWO growth gate - six criteria, all required (event-go-no-go §1)\n');
console.log('BOT\n');
for (const c of checks.filter((x) => x.side === 'bot')) print(c);
console.log('WEBSITE\n');
for (const c of checks.filter((x) => x.side === 'website')) print(c);

const bad = failing(checks);
const okCount = checks.length - bad.length;

console.log(`VERDICT: ${v.toUpperCase()}  (${okCount} of ${checks.length} criteria ok)\n`);
if (v === 'green') {
  console.log('  All six hold. The Chief of Staff names the coming Sunday as the first run,');
  console.log('  the launch pack publishes within 24 hours, and TOG-92 scoring starts week 1.');
  console.log('  Before scoring: re-run `npm run funnel` at 30/90/180 and record Baseline B');
  console.log('  (ledger §1a consequence 4 - thresholds read against B, not the 19 Aug baseline).\n');
} else {
  console.log(`  ${bad.length} criteri${bad.length === 1 ? 'on' : 'a'} standing between here and green:\n`);
  for (const c of bad) console.log(`    - [${c.status}] ${c.title}\n      owner: ${c.owner ?? 'unassigned'}`);
  console.log('\n  TOG-92 weekly scoring does NOT run this week. Scoring a portfolio at 0 joins');
  console.log('  and £0 spend produces a table of zeros and feeds the kill/scale rules noise.\n');
}

process.exit(EXIT_CODE[v]);
