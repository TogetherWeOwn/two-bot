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
 * Two criteria are not observable from a bare agent runtime: the bot process
 * (needs COOLIFY_URL + COOLIFY_TOKEN to poll the container) and the
 * routed-welcome test (needs a human to walk an account through the rules gate
 * in Discord). Those report `UNKNOWN`, which counts as red - never as green.
 *
 * NOTE the bot is LIVE as of 2026-09-06 (`two-bot-dk`, `Owen#2309`). An unknown
 * on the bot side now means "we could not look from here", NOT "it was never
 * deployed" - do not read it as the latter. `verdict()` in
 * src/growth/gate.ts treats an unknown exactly as hard as a fail, because a
 * gate that goes green on six shrugs is worse than having no gate.
 *
 * Exit: 0 green, 1 red. Red is a normal weekly outcome, not a malfunction.
 */
import { openDb } from '../src/store/db.ts';
import { paint } from '../src/analytics/cliColor.ts';
import {
  observeApprovedPublicSite,
  observeTrackedJoinPath,
  webCodeRowSource,
} from '../src/growth/joinPath.ts';
import {
  EXIT_CODE,
  allChecks,
  failing,
  scoringLoopRuns,
  verdict,
  type Criterion,
  type Observations,
} from '../src/growth/gate.ts';

const json = process.argv.slice(2).includes('--json');

/** The approved vanity entry point, not a preview URL. */
const SITE = process.env.TWO_GATE_SITE || 'https://two.gg';
/** The public WEB-HOMEPAGE invite. The observation stops at this redirect and never opens Discord. */
const EXPECTED_JOIN_DESTINATION = process.env.TWO_GATE_JOIN_DESTINATION || 'https://discord.gg/4GwEDNRTtx';

const o: Observations = {};

// --- bot criterion 1: the bot process --------------------------------------
//
// TOG-13 deployed the bot as a Coolify container (`two-bot-dk`), NOT as a
// systemd unit, so `systemctl` was never going to answer this and the old
// "TOG-13 has not deployed one" text outlived the card by a day. When the panel
// credentials are bound we ask Coolify directly; otherwise this stays unknown,
// which is honest, rather than false-and-blaming-a-closed-card.
//
// `running:healthy` is load-bearing here and only because of what compose's
// healthcheck is: it hits /readyz in-container, which returns 200 only when the
// Discord gateway is connected AND Postgres answers. A bare `running` would be
// a process-exists check and would not satisfy this criterion.
const COOLIFY_APP = process.env.COOLIFY_APP_UUID || 'cangagerae31txrk2vfvzzyq';

if (process.env.TWO_GATE_SERVICE_ACTIVE === '1') {
  o.serviceActive = true;
  o.serviceDetail = 'reported active by the caller (TWO_GATE_SERVICE_ACTIVE=1).';
} else if (process.env.TWO_GATE_SERVICE_ACTIVE === '0') {
  o.serviceActive = false;
  o.serviceDetail = 'reported inactive by the caller (TWO_GATE_SERVICE_ACTIVE=0).';
} else if (process.env.COOLIFY_URL && process.env.COOLIFY_TOKEN) {
  try {
    const res = await fetch(`${process.env.COOLIFY_URL.replace(/\/$/, '')}/api/v1/applications/${COOLIFY_APP}`, {
      headers: { Authorization: `Bearer ${process.env.COOLIFY_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      o.serviceDetail = `the Coolify API answered ${res.status} for ${COOLIFY_APP} - could not read the container state.`;
    } else {
      const app = (await res.json()) as { status?: string };
      const status = String(app.status ?? '');
      // Coolify reports e.g. `running:healthy`, `running:unhealthy`, `exited`.
      o.serviceActive = status.startsWith('running') && status.includes('healthy') && !status.includes('unhealthy');
      o.serviceDetail = o.serviceActive
        ? `two-bot-dk reports ${status} (healthcheck is /readyz: gateway connected and Postgres answering).`
        : `two-bot-dk reports ${status}.`;
    }
  } catch (err) {
    o.serviceDetail = `the Coolify API could not be reached: ${err instanceof Error ? err.message : String(err)}`;
  }
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

// --- website criterion 1: the approved public route -------------------------
const publicSite = await observeApprovedPublicSite(SITE);
o.domainLive = publicSite.live;
o.domainDetail = publicSite.detail;
const homepageHtml = publicSite.homepageHtml;

// --- the funnel: bot criterion 2 and website criterion 3 -------------------
//
// Both read the same table, so they share one connection. attribution.ts is
// explicit that this works without a deployed bot - it reads whatever
// `npm run capture` has written - so an unbound URL here means "nobody gave us
// the database", not "the bot is down".
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) {
  const why = 'TWO_DATABASE_URL is not bound in this environment.';
  o.funnelDetail = why;
  o.webCodeRowDetail = why;
} else {
  let db;
  try {
    db = await openDb(databaseUrl, { skipMigrations: true, poolMax: 2, applicationName: 'two-bot-gate-check' });
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
      //
      // The funnel stores raw Discord codes (`invite:<code>`), not the registry
      // slot label - so the slot is resolved through the same join destination
      // the website criterion checks (TOG-5037). No second copy of the code.
      o.webCodeRowSource = webCodeRowSource(EXPECTED_JOIN_DESTINATION);
      const webSource = o.webCodeRowSource;
      if (webSource === undefined) {
        o.webCodeRowPresent = undefined;
        o.webCodeRowDetail =
          `the WEB-HOMEPAGE slot could not be resolved to a Discord code from ${EXPECTED_JOIN_DESTINATION} - no funnel row can be matched.`;
      } else {
        const web = rows.find((r) => r.source === webSource);
        o.webCodeRowPresent = web !== undefined;
        o.webCodeRowDetail = web
          ? `${webSource} has ${Number(web.n)} attributed join(s).`
          : `${webSource} has no row in the funnel - no join has ever arrived on it.`;
      }
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
// Only meaningful once the approved public host serves Phase 1. Asking any
// other page for a join route would be a fail we invented rather than one we
// observed, so this stays unknown unless criterion 1 is positively ok.
if (o.domainLive === true && publicSite.site) {
  const join = await observeTrackedJoinPath(publicSite.site, EXPECTED_JOIN_DESTINATION, { homepageHtml });
  o.joinButtonWorks = join.works;
  o.joinButtonDetail = join.detail;
} else {
  o.joinButtonDetail = 'not exercised - the approved public route does not observably serve Phase 1 yet.';
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

// Status tokens go through the NO_COLOR gate (TOG-8698): styled on a color
// TTY, plain under NO_COLOR or a pipe. Padding sits outside the paint call,
// so stripped output is byte-identical to plain text.
const LABEL: Record<Criterion['status'], string> = {
  ok: `${paint('ok', 'green')}     `,
  fail: `${paint('FAIL', 'red')}   `,
  unknown: paint('UNKNOWN', 'yellow'),
};

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
