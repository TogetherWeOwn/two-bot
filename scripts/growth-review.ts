/**
 * The Friday growth review: rank the portfolio, apply the kill/scale rules,
 * check where the effort went, and print the ledger entry to paste.
 *
 *   npm run review                     # trailing 4 weeks
 *   npm run review -- --weeks 8        # a longer window
 *   npm run review -- --json           # same verdicts, for a comment or a bot
 *   npm run review -- --force          # run it anyway while the gate is red
 *
 * READ-ONLY. It writes nothing, messages nobody, and never prints a token or a
 * member identity. It cannot kill a channel; it can only say that the
 * pre-registered rules have been met, and a human then does the killing.
 *
 * THIS IS STEPS 2-5 OF TOG-92. Step 1 is `npm run attribution` and this reads
 * the same tables through the same helpers, so the two can be diffed. The rules
 * themselves are in src/growth/portfolio.ts, registered on 2026-09-05 before
 * any channel had run - which is the ledger's whole method: thresholds are set
 * before the data exists, so nobody can pick the flattering one afterwards.
 *
 * IT REFUSES TO RUN WHILE THE GATE IS RED, and that is the point.
 *
 * `scoringLoopRuns()` in src/growth/gate.ts already says so: a portfolio at 0
 * joins and £0 spend scores a table of zeros, and the rules are explicit that
 * nothing is killed on a single week - so a red-gate run cannot produce a valid
 * kill, only a page of zeros that reads like a finding. `--force` prints the
 * scaffolding with every verdict clearly marked NOT A FINDING, for checking the
 * report before the data exists. It exits non-zero so no automation mistakes it
 * for a completed review.
 *
 * AGENT-HOURS COME FROM A FILE, BECAUSE NOTHING RECORDS THEM
 *
 * Every other input here is in the database. Effort is not: no table has ever
 * held an agent-hour, and the effort-allocation check is the half of the card
 * that catches "we spent the month on listings because listings are easy". So
 * it reads data/growth-effort.json, hand-kept, one line per channel per week.
 * An absent file is reported as absent - never silently scored as zero hours,
 * which would make every unworked channel look like a free success and would
 * let neglect issue kills.
 */
import { readFile } from 'node:fs/promises';

import { openDb } from '../src/store/db.ts';
import { excludeClause } from '../src/analytics/anomalies.ts';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';
import { rollUp, type AttributionRow, type JoinRecord } from '../src/analytics/attribution.ts';
import { allChecks, failing, scoringLoopRuns, verdict as gateVerdict } from '../src/growth/gate.ts';
import {
  KILL_WINDOW_WEEKS,
  REGISTERED_CHANNELS,
  assess,
  effortAllocation,
  paidAskStatus,
  rankPortfolio,
  windowOf,
  type Assessment,
  type ChannelWeek,
  type ChannelWindow,
  type RegisteredChannel,
} from '../src/growth/portfolio.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/growth-review.ts [--weeks <count>] [--json] [--force]');
  process.exit(0);
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const force = argv.includes('--force');
const weeksArg = argv.indexOf('--weeks');
const weeks = weeksArg >= 0 ? Number(argv[weeksArg + 1]) : KILL_WINDOW_WEEKS;
if (!Number.isFinite(weeks) || weeks <= 0) {
  console.error(`Bad --weeks "${argv[weeksArg + 1]}". Use a positive number of weeks.`);
  process.exit(2);
}

const EFFORT_FILE = process.env.TWO_EFFORT_FILE ?? './data/growth-effort.json';
const nowMs = Date.now();
const since = new Date(nowMs - weeks * 7 * 86_400_000).toISOString();

/** UTC Monday of the week containing this instant. Weeks are the review's unit. */
function weekStartOf(iso: string): string {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// --- the gate, first ---------------------------------------------------------
//
// Read exactly what gate-check.ts reads for the funnel criterion. The two
// unobservable criteria stay unknown here as they do there, so this can never
// be greener than the gate script - it can only agree or be redder.
const gateEnv = { ...process.env };
const databaseUrl = gateEnv.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');

const db = await openDb(databaseUrl);

const attributedJoins = Number(
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE event_type='member_join' AND member_id IS NOT NULL AND source LIKE 'invite:%'`,
      )
      .get<{ n: number }>()
  )?.n ?? 0,
);

const gate = gateVerdict(
  allChecks({
    attributedJoins,
    serviceActive: gateEnv.TWO_GATE_SERVICE_ACTIVE === '1' ? true : undefined,
    welcomeDelivered: gateEnv.TWO_GATE_WELCOME_OK === '1' ? true : undefined,
  }),
);
const gateBlocking = !scoringLoopRuns(gate);

if (gateBlocking && !force && !json) {
  await db.close();
  console.log('\nTWO weekly growth review - NOT RUN\n');
  console.log(`  The growth gate is ${gate.toUpperCase()}, so the scoring loop does not start.`);
  console.log('  Run `npm run gate:check` for which criteria are outstanding.\n');
  console.log('  This is a normal outcome, not a malfunction. Scoring a portfolio at 0 joins');
  console.log('  and £0 spend produces a table of zeros; the rules never kill on one week, so');
  console.log('  a red-gate run cannot produce a valid decision either way.\n');
  console.log('  `npm run review -- --force` prints the scaffolding with every verdict marked');
  console.log('  NOT A FINDING, for checking the report before the data exists.\n');
  process.exit(1);
}

// --- step 1: the funnel, per code, per week ---------------------------------

const joinExcl = excludeClause('member_join');
const joinEvents = await db
  .prepare(
    `SELECT member_id, occurred_at, source, metadata FROM events
      WHERE event_type='member_join' AND member_id IS NOT NULL AND occurred_at >= ?${joinExcl.sql}
      ORDER BY occurred_at`,
  )
  .all<{ member_id: string; occurred_at: string; source: string; metadata: string | null }>(
    since,
    ...joinExcl.params,
  );

/** TWO-73: only an explicit `false` marks a placed rather than observed join. */
const attributionExact = (raw: string | null): boolean | null => {
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { attribution_exact?: unknown }).attribution_exact;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
};

const { kept } = collapseCrossSourceDuplicates(
  joinEvents.map((e) => ({
    eventType: 'member_join',
    memberId: e.member_id,
    occurredAt: e.occurred_at,
    source: e.source,
    attributionExact: attributionExact(e.metadata),
  })),
);

const memberRows = await db
  .prepare(
    `SELECT member_id, first_message_at, third_message_at, first_voice_at, last_active_at,
            left_at, is_bot
       FROM members`,
  )
  .all<{
    member_id: string;
    first_message_at: string | null;
    third_message_at: string | null;
    first_voice_at: string | null;
    last_active_at: string | null;
    left_at: string | null;
    is_bot: number;
  }>();
const byMember = new Map(memberRows.map((m) => [m.member_id, m]));

/** Live code -> registered channel, via the campaign table. */
const campaigns = await db
  .prepare(`SELECT slug, invite_code, label FROM invite_campaigns`)
  .all<{ slug: string; invite_code: string; label: string }>()
  .catch(() => [] as { slug: string; invite_code: string; label: string }[]);

/**
 * Which registered slot a `invite:<code>` source belongs to.
 *
 * Codes live in the registry document and in `invite_campaigns`, never in the
 * portfolio module - a code can be rebound, and a second copy in code would
 * drift silently. Prefix slots (`REF-<memberId>`, `PART-<slug>`) collapse to
 * their family, which is the unit their kill rules are written in.
 */
const PREFIX_SLOTS = ['REF', 'PART'];
const slotOf = (source: string): string | null => {
  if (!source.startsWith('invite:')) return null;
  const code = source.slice('invite:'.length);
  const camp = campaigns.find((c) => c.invite_code === code);
  const name = camp?.slug.toUpperCase().replace(/-/g, '-') ?? code;
  const exact = REGISTERED_CHANNELS.find((c) => c.id === name);
  if (exact) return exact.id;
  const prefix = PREFIX_SLOTS.find((p) => name.startsWith(`${p}-`));
  return prefix ?? null;
};

// One roll-up per week, so the window can drop a week without re-deriving AM7.
const weekKeys = [...new Set(kept.map((e) => weekStartOf(e.occurredAt)))].sort();
const channelWeeks: ChannelWeek[] = [];

for (const wk of weekKeys) {
  const records: JoinRecord[] = [];
  for (const e of kept) {
    if (weekStartOf(e.occurredAt) !== wk) continue;
    const m = byMember.get(e.memberId!);
    if (m && Number(m.is_bot) === 1) continue;
    records.push({
      memberId: e.memberId!,
      joinedAt: e.occurredAt,
      source: e.source,
      firstVoiceAt: m?.first_voice_at ?? null,
      firstMessageAt: m?.first_message_at ?? null,
      thirdMessageAt: m?.third_message_at ?? null,
      lastActiveAt: m?.last_active_at ?? null,
      leftAt: m?.left_at ?? null,
      attributionExact: e.attributionExact,
    });
  }
  const rolled = rollUp(records, { nowMs });
  // Several codes can map to one slot (REF-<memberId>), so sum rather than pick.
  const perSlot = new Map<string, AttributionRow[]>();
  for (const r of rolled.rows) {
    const slot = slotOf(r.source);
    if (!slot) continue;
    perSlot.set(slot, [...(perSlot.get(slot) ?? []), r]);
  }
  for (const [slot, rows] of perSlot) {
    channelWeeks.push({
      channelId: slot,
      weekStart: wk,
      joins: rows.reduce((n, r) => n + r.joins, 0),
      joinsInexact: rows.reduce((n, r) => n + r.joinsInexact, 0),
      am7: rows.reduce((n, r) => n + r.am7, 0),
      am7Eligible: rows.reduce((n, r) => n + r.am7Eligible, 0),
      am30: rows.reduce((n, r) => n + r.am30, 0),
      am30Eligible: rows.reduce((n, r) => n + r.am30Eligible, 0),
      agentHours: null,
      cashPence: null,
    });
  }
}

await db.close();

// --- effort, from the file ---------------------------------------------------

interface EffortEntry {
  channelId: string;
  weekStart: string;
  agentHours?: number;
  cashPence?: number;
  bumpsExpected?: number;
  bumpsDone?: number;
  outputProduced?: boolean;
  referralLinkCreators?: number;
  partnerNights?: number;
  partnersWithZeroAm30?: number;
  weeksLive?: number;
}

let effort: EffortEntry[] = [];
let effortProblem: string | null = null;
try {
  const parsed = JSON.parse(await readFile(EFFORT_FILE, 'utf8')) as { weeks?: EffortEntry[] };
  effort = parsed.weeks ?? [];
  if (effort.length === 0) {
    effortProblem = `${EFFORT_FILE} has no week entries yet - nobody has recorded an agent-hour.`;
  }
} catch (err) {
  const why = err instanceof Error && 'code' in err && err.code === 'ENOENT' ? 'does not exist' : String(err);
  effortProblem = `${EFFORT_FILE} ${why}. Effort is not in any table, so without it "sustained effort" cannot be tested and NO KILL WILL BE ISSUED.`;
}

// An effort row for a channel with no joins that week still has to reach the
// window, or a channel we worked and that delivered nobody would never appear.
const seen = new Set(channelWeeks.map((w) => `${w.channelId}|${w.weekStart}`));
for (const e of effort) {
  if (e.weekStart < since.slice(0, 10)) continue;
  if (!seen.has(`${e.channelId}|${e.weekStart}`)) {
    channelWeeks.push({
      channelId: e.channelId,
      weekStart: e.weekStart,
      joins: 0,
      joinsInexact: 0,
      am7: 0,
      am7Eligible: 0,
      am30: 0,
      am30Eligible: 0,
      agentHours: null,
      cashPence: null,
    });
  }
}
for (const w of channelWeeks) {
  const e = effort.find((x) => x.channelId === w.channelId && x.weekStart === w.weekStart);
  if (!e) continue;
  w.agentHours = e.agentHours ?? null;
  w.cashPence = e.cashPence ?? null;
  w.bumpsExpected = e.bumpsExpected;
  w.bumpsDone = e.bumpsDone;
  w.outputProduced = e.outputProduced;
}

/** The per-experiment facts the funnel cannot carry: latest recorded wins. */
const inputFor = (channelId: string) => {
  const rows = effort.filter((e) => e.channelId === channelId).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const last = <K extends keyof EffortEntry>(k: K): EffortEntry[K] | undefined => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][k] !== undefined) return rows[i][k];
    return undefined;
  };
  return {
    referralLinkCreators: last('referralLinkCreators') as number | undefined,
    partnerNights: last('partnerNights') as number | undefined,
    partnersWithZeroAm30: last('partnersWithZeroAm30') as number | undefined,
    weeksLive: last('weeksLive') as number | undefined,
  };
};

// --- steps 2-5 ---------------------------------------------------------------

const windows: ChannelWindow[] = REGISTERED_CHANNELS.map((c) => windowOf(c.id, channelWeeks));
const assessments: Assessment[] = REGISTERED_CHANNELS.map((c, i) => assess(c, windows[i], inputFor(c.id)));
const ranking = rankPortfolio(assessments);
const allocation = effortAllocation(windows);
const paid = paidAskStatus(assessments);
const byId = new Map<string, RegisteredChannel>(REGISTERED_CHANNELS.map((c) => [c.id, c]));

if (json) {
  console.log(
    JSON.stringify(
      {
        reviewedAt: new Date(nowMs).toISOString(),
        windowWeeks: weeks,
        gate,
        scoringLoopRuns: !gateBlocking,
        findingsAreValid: !gateBlocking,
        effortProblem,
        assessments,
        ranking,
        allocation,
        paid,
      },
      null,
      2,
    ),
  );
  process.exit(gateBlocking ? 1 : 0);
}

// --- report ------------------------------------------------------------------

const BANNER =
  '  ###########################################################################\n' +
  '  #  NOT A FINDING. The gate is red and the portfolio has not run.          #\n' +
  '  ###########################################################################';

console.log(`\nTWO weekly growth review - trailing ${weeks} weeks, since ${since.slice(0, 10)}`);
console.log(`as of ${new Date(nowMs).toISOString().slice(0, 16)}Z\n`);
if (gateBlocking) {
  console.log(BANNER);
  console.log('  Every verdict below is scaffolding shown under --force. The rules were');
  console.log('  registered before the data existed, on purpose - that is the ledger method -');
  console.log('  so they can be read and argued with now. They decide nothing until green.\n');
}
if (effortProblem) {
  console.log(`  EFFORT NOT RECORDED: ${effortProblem}`);
  console.log('  Step 3 needs sustained effort AND 0 AM30. Without hours the conjunction');
  console.log('  cannot be tested, so every channel holds rather than being killed.\n');
}

const w = Math.max(18, ...REGISTERED_CHANNELS.map((c) => c.id.length)) + 2;
console.log(`  ${'channel'.padEnd(w)}${'joins'.padStart(6)}${'AM7'.padStart(5)}${'AM30'.padStart(6)}${'hours'.padStart(7)}${'  h/AM30'}   verdict`);
console.log(`  ${'-'.repeat(w + 24 + 30)}`);
for (let i = 0; i < REGISTERED_CHANNELS.length; i++) {
  const c = REGISTERED_CHANNELS[i];
  const win = windows[i];
  const a = assessments[i];
  const cost = a.cost.hoursPerAm30 === null ? '     -' : a.cost.hoursPerAm30.toFixed(1).padStart(6);
  const name = win.joinsInexact > 0 ? `${c.id} ~` : c.id;
  console.log(
    `  ${name.padEnd(w)}${String(win.joins).padStart(6)}${String(win.am7).padStart(5)}` +
      `${String(win.am30).padStart(6)}${win.agentHours.toFixed(1).padStart(7)}${cost}   ${a.verdict}`,
  );
}
console.log(`  ${'-'.repeat(w + 24 + 30)}\n`);

console.log('  Why each verdict\n');
for (const a of assessments) {
  console.log(`    ${a.channelId} (${a.experiment}) - ${a.verdict}`);
  console.log(`      ${a.reason}`);
  if (!a.costIsHard && a.cost.am30 > 0) {
    console.log('      ~ this row\'s joins were placed, not observed; its rate is not quotable.');
  }
  console.log('');
}

console.log('  Step 2/3: the scale decision\n');
if (ranking.scale) {
  console.log(`    ${ranking.scale.channelId} has the best cost-per-AM30 in the portfolio`);
  console.log(`    (${ranking.scale.cost.hoursPerAm30?.toFixed(1)} agent-hours per AM30, on ${ranking.scale.cost.am30} AM30).`);
  console.log('    The registered rule gives it DOUBLE EFFORT next cycle. Ranking:');
  for (const [i, a] of ranking.ordered.entries()) {
    console.log(`      ${i + 1}. ${a.channelId}  ${a.cost.hoursPerAm30?.toFixed(1)} h/AM30 on ${a.cost.am30} AM30`);
  }
} else {
  console.log('    No scale decision is available.');
}
for (const b of ranking.blockers) console.log(`      [${b.blocker}] ${b.detail}`);
console.log('');

console.log('  Step 5: where the effort actually went\n');
for (const f of allocation.findings) console.log(`    ${f}`);
if (allocation.recorded) {
  const t = allocation.byTier;
  console.log(
    `    highest ${t.highest.toFixed(1)}h  high ${t.high.toFixed(1)}h  medium ${t.medium.toFixed(1)}h  low ${t.low.toFixed(1)}h  (roadmap-30d §5 tiers)`,
  );
}
console.log('');

console.log('  Paid (EXP-008)\n');
console.log(`    ${paid.detail}`);
console.log('');

// --- step 4: the ledger entry -----------------------------------------------
//
// The step everyone skips, and the one the card says makes the pipeline learn
// rather than just run. Printed as a paste-ready block so writing it down is
// less work than not writing it down.
console.log('  Step 4: paste this into the experiment ledger\n');
console.log('  ----------------------------------------------------------------');
console.log(`  ### Review ${new Date(nowMs).toISOString().slice(0, 10)} - trailing ${weeks} weeks`);
console.log(`  Gate: ${gate.toUpperCase()}${gateBlocking ? ' - THESE ARE NOT FINDINGS' : ''}`);
for (const a of assessments) {
  if (a.verdict === 'NOT-A-BET') continue;
  const c = byId.get(a.channelId);
  console.log(`  - **${a.channelId}** (${c?.experiment}) - ${a.verdict}. ${a.reason}`);
}
console.log(`  - **Scale:** ${ranking.scale ? `${ranking.scale.channelId}, double effort next cycle.` : 'none available. ' + ranking.blockers.map((b) => b.detail).join(' ')}`);
console.log(`  - **Effort:** ${allocation.findings.join(' ')}`);
console.log(`  - **Paid:** ${paid.detail}`);
console.log('  ----------------------------------------------------------------\n');

if (gateBlocking) {
  const bad = failing(allChecks({ attributedJoins }));
  console.log(`  ${bad.length} gate criteria outstanding. Run \`npm run gate:check\` for the list.\n`);
}

process.exit(gateBlocking ? 1 : 0);
