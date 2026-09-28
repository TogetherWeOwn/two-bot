/**
 * Shared human-readable CLI formatters (TOG-5723, impl TOG-6157).
 *
 * The funnel / dashboard / roster scripts each built their console text
 * inline next to their DB queries, so the text was untestable without a live
 * database and the three reports drifted apart (different header styles,
 * unaligned columns, missing units, blank empty states). This module holds
 * the pure text renderers: the scripts collect rows, these functions format
 * them. Tests feed fixtures directly, no DB required.
 *
 * House style enforced here:
 *  - top header: `TWO <name> - last <N> days (since <YYYY-MM-DD>)`, no indent.
 *  - section header: two spaces + `Title:` (via `sectionHeader`).
 *  - headline tables: label column 20 wide, count column 6 wide right-aligned,
 *    units on every count (`clicks`, `joins`, `members`, `leaves`, `events`)
 *    and on every rate (`%`, `days`/`day`).
 *  - data tables: fixed minimum widths, capped maximums with ellipsis so one
 *    long slug or display name cannot push the columns off screen.
 *  - empty states print guidance (what to run next), never blank output.
 */
import { formatVoiceDurationSeconds } from '../core/voiceSessions.ts';
import { renderDowntimeReport } from '../core/inviteTracker.ts';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** `  Title:` - the one section-header style all three reports use. */
export function sectionHeader(title: string): string {
  return `  ${title}:`;
}

/** Top header shared by funnel and roster. */
export function topHeader(report: string, days: number, since: string): string {
  return `TWO ${report} - last ${days} days (since ${since.slice(0, 10)})`;
}

/** Rate as `  67%` / ` 100%`, or `   n/a` when there is no denominator. */
export function formatPct(a: number, b: number): string {
  if (b === 0) return '   n/a';
  return `${((a / b) * 100).toFixed(0).padStart(4)}%`;
}

/** Cap a column value so one long string cannot move the table. */
export function fitCell(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 3) return value.slice(0, maxWidth);
  return `${value.slice(0, maxWidth - 3)}...`;
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export interface FunnelTextSource {
  source: string;
  joins: number;
}

export interface FunnelTextCampaign {
  slug: string;
  label: string;
  inviteCode: string;
  clicks: number;
  joins: number;
  retired: boolean;
}

export interface FunnelTextDowntimeWindow {
  start: string;
  end: string;
  gapMs: number;
  downtimeUnknown: number;
}

export interface FunnelTextRetention {
  day: number;
  retained: number;
  cohort: number;
}

export interface FunnelTextInput {
  days: number;
  since: string;
  clicks: number;
  joins: number;
  joinsSetAside: number;
  gateCleared: number;
  joiners: number;
  stuckAtGate: number;
  firstMessage: number;
  firstVoice: number;
  leaves: number;
  leavesSetAside: number;
  trackedLinks: number;
  bySource: FunnelTextSource[];
  ambiguous: number;
  unknown: number;
  downtime: FunnelTextDowntimeWindow[];
  downtimeUnknown: number;
  campaigns: FunnelTextCampaign[];
  avgSessionSeconds: number | null;
  measuredSessions: number;
  excludedUnknownStarts: number;
  retention: FunnelTextRetention[];
  neverPosted: number;
  strandedRaid: number;
  totalEvents: number;
}

/** Demo numbers used by `--help` output and, via fixtures, the unit tests. */
export function sampleFunnelInput(): FunnelTextInput {
  return {
    days: 7,
    since: '2026-09-20T00:00:00.000Z',
    clicks: 120,
    joins: 40,
    joinsSetAside: 0,
    gateCleared: 32,
    joiners: 38,
    stuckAtGate: 3,
    firstMessage: 18,
    firstVoice: 9,
    leaves: 6,
    leavesSetAside: 0,
    trackedLinks: 2,
    bySource: [
      { source: 'invite:abc123', joins: 25 },
      { source: 'vanity', joins: 10 },
      { source: 'unknown', joins: 5 },
    ],
    ambiguous: 0,
    unknown: 5,
    downtime: [],
    downtimeUnknown: 0,
    campaigns: [
      { slug: 'test-link', label: 'Test listing', inviteCode: 'abc123', clicks: 90, joins: 25, retired: false },
      { slug: 'old-link', label: 'Old listing', inviteCode: 'old999', clicks: 30, joins: 0, retired: true },
    ],
    avgSessionSeconds: 2820,
    measuredSessions: 9,
    excludedUnknownStarts: 1,
    retention: [
      { day: 1, retained: 20, cohort: 40 },
      { day: 7, retained: 8, cohort: 22 },
      { day: 30, retained: 0, cohort: 0 },
    ],
    neverPosted: 12,
    strandedRaid: 0,
    totalEvents: 1234,
  };
}

/** All-zero funnel: the empty-state fixture. Must print guidance, not blanks. */
export function emptyFunnelInput(days = 7, since = '2026-09-20T00:00:00.000Z'): FunnelTextInput {
  return {
    days,
    since,
    clicks: 0,
    joins: 0,
    joinsSetAside: 0,
    gateCleared: 0,
    joiners: 0,
    stuckAtGate: 0,
    firstMessage: 0,
    firstVoice: 0,
    leaves: 0,
    leavesSetAside: 0,
    trackedLinks: 0,
    bySource: [],
    ambiguous: 0,
    unknown: 0,
    downtime: [],
    downtimeUnknown: 0,
    campaigns: [],
    avgSessionSeconds: null,
    measuredSessions: 0,
    excludedUnknownStarts: 0,
    retention: [
      { day: 1, retained: 0, cohort: 0 },
      { day: 7, retained: 0, cohort: 0 },
      { day: 30, retained: 0, cohort: 0 },
    ],
    neverPosted: 0,
    strandedRaid: 0,
    totalEvents: 0,
  };
}

const HEADLINE_LABEL_WIDTH = 20;
const HEADLINE_COUNT_WIDTH = 6;

function headline(label: string, count: number, unit: string, rate = ''): string {
  const countCell = `${String(count).padStart(HEADLINE_COUNT_WIDTH)} ${unit}`;
  return `  ${label.padEnd(HEADLINE_LABEL_WIDTH)}  ${countCell}${rate ? `  ${rate}` : ''}`;
}

/**
 * The full funnel text report, one string. The script prints it and handles
 * the anomaly-spike section separately (out of TOG-5723 scope).
 */
export function formatFunnelText(r: FunnelTextInput): string {
  const out: string[] = [];
  out.push(`\n${topHeader('funnel', r.days, r.since)}\n`);

  out.push(
    headline('invite clicks', r.clicks, 'clicks') +
      (r.trackedLinks === 0 ? '   (no tracked links yet - see npm run campaigns)' : ''),
  );
  out.push(
    headline('joins', r.joins, 'joins', `${formatPct(r.joins, r.clicks)} of clicks`),
  );
  if (r.clicks === 0 && r.joins === 0) {
    out.push('    (no clicks or joins in window - share a tracked link, then see npm run campaigns)');
  }
  if (r.clicks > 0 && r.joins > r.clicks) {
    // Over 100% is expected while some invites are tracked and some are raw.
    out.push('    (>100%: some invites are posted as raw discord.gg links)');
  }
  if (r.joinsSetAside > 0) {
    out.push(`   +${String(r.joinsSetAside).padStart(5)} joins set aside as a one-off event, see below`);
  }
  // The rules gate sits between joining and doing anything at all (TOG-76).
  out.push(
    headline('cleared rules gate', r.gateCleared, 'members', `${formatPct(r.gateCleared, r.joiners)} of joiners`) +
      (r.gateCleared === 0 && r.joiners > 0 ? '   (no clearing recorded - run npm run backfill)' : ''),
  );
  if (r.joins === 0 && r.joiners === 0) {
    out.push('    (no joiners in window - gate conversion needs a join first)');
  }
  if (r.stuckAtGate > 0) {
    out.push(`   ${String(r.stuckAtGate).padStart(5)} members in the server right now, never accepted the rules`);
  }
  out.push(
    headline('posted first message', r.firstMessage, 'members', `${formatPct(r.firstMessage, r.joins)} of joins`),
  );
  out.push(
    headline('first voice session', r.firstVoice, 'members', `${formatPct(r.firstVoice, r.joins)} of joins`),
  );
  const avgCell =
    r.avgSessionSeconds === null
      ? `${'—'.padStart(HEADLINE_COUNT_WIDTH)} avg`
      : `${fitCell(formatVoiceDurationSeconds(r.avgSessionSeconds), HEADLINE_COUNT_WIDTH).padStart(HEADLINE_COUNT_WIDTH)} avg`;
  out.push(
    `  ${'avg voice session'.padEnd(HEADLINE_LABEL_WIDTH)}  ${avgCell}` +
      (r.avgSessionSeconds === null
        ? '   (no measured session in window)'
        : `   over ${r.measuredSessions} measured, ${r.excludedUnknownStarts} unknown-start excluded`),
  );
  out.push(headline('left', r.leaves, 'leaves'));
  if (r.leavesSetAside > 0) {
    out.push(`   +${String(r.leavesSetAside).padStart(5)} leaves set aside as a one-off event, see below`);
  }

  out.push(`\n${sectionHeader('Where joins came from')}`);
  if (r.bySource.length === 0) {
    out.push('    (no joins yet - share an invite, then see npm run campaigns)');
  }
  for (const row of r.bySource) {
    out.push(`    ${String(row.joins).padStart(5)} joins  ${row.source}`);
  }
  out.push(`    ${String(r.ambiguous).padStart(5)} joins  ambiguous (several invites grew at once)`);
  out.push(`    ${String(r.unknown).padStart(5)} joins  unknown (no invite grew, no vanity URL)`);

  out.push(`\n${sectionHeader('Join downtime (EVENTS.md limit 3 - unknown joins the outage explains)')}`);
  for (const line of renderDowntimeReport(r.downtime)) out.push(line.startsWith(' ') ? line : `  ${line}`);
  if (r.downtime.length > 0) {
    out.push(
      `    ${String(r.downtimeUnknown).padStart(5)} of ${r.unknown} unknown in-window ` +
        `(upper bound - a quiet stretch with no writes reads as a gap)`,
    );
  }

  if (r.trackedLinks > 0) {
    out.push(`\n${sectionHeader('Tracked links (clicks -> joins on the same invite code)')}`);
    if (r.campaigns.length === 0) {
      out.push('    (tracked links exist but none saw clicks in window)');
    }
    const slugWidth = Math.min(
      24,
      Math.max(8, ...r.campaigns.map((c) => c.slug.length)),
    );
    for (const c of r.campaigns) {
      out.push(
        `    ${fitCell(c.slug, 24).padEnd(slugWidth)}  ${String(c.clicks).padStart(5)} clicks  ` +
          `${String(c.joins).padStart(4)} joins  ${formatPct(c.joins, c.clicks)}  ${c.label}${c.retired ? '  (retired)' : ''}`,
      );
    }
    // Two campaigns on one invite code cannot be told apart by joins.
    const shared = new Map<string, string[]>();
    for (const c of r.campaigns) {
      const arr = shared.get(c.inviteCode);
      if (arr) arr.push(c.slug);
      else shared.set(c.inviteCode, [c.slug]);
    }
    for (const [code, slugs] of shared) {
      if (slugs.length > 1) {
        out.push(
          `    note: ${slugs.join(', ')} share invite code ${code}, so the join counts above ` +
            `repeat one number. Give each its own code to split them.`,
        );
      }
    }
  }

  out.push(`\n${sectionHeader('Retention (of members who joined in the window)')}`);
  for (const { day: d, retained, cohort } of r.retention) {
    const dayUnit = d === 1 ? '1 day' : `${d} days`;
    if (cohort === 0) {
      out.push(`    D${String(d).padEnd(2)} (${dayUnit})   no members aged ${dayUnit} yet`);
    } else {
      out.push(
        `    D${String(d).padEnd(2)} (${dayUnit})  ${String(retained).padStart(4)} / ${String(cohort).padEnd(4)} retained  ${formatPct(retained, cohort)}`,
      );
    }
  }

  out.push(`\n  Joined but never posted (all time, still in server): ${r.neverPosted} members`);
  if (r.neverPosted === 0) {
    out.push('    (everyone on record has posted or spoken - see npm run reengage when this grows)');
  }
  if (r.strandedRaid > 0) {
    out.push(`  Raid accounts never cleaned up, still in the member count: ${r.strandedRaid} members`);
  }
  out.push(`  Total events on file: ${r.totalEvents} events\n`);

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Dashboard console summary
// ---------------------------------------------------------------------------

export interface DashboardSummaryInput {
  joinsThisWeek: number;
  active7d: number;
  realHumans: number;
}

export function sampleDashboardSummary(): DashboardSummaryInput {
  return { joinsThisWeek: 3, active7d: 5, realHumans: 53 };
}

export function emptyDashboardSummary(): DashboardSummaryInput {
  return { joinsThisWeek: 0, active7d: 0, realHumans: 0 };
}

/**
 * The two console lines `scripts/dashboard.ts` prints after writing the HTML.
 * Units on every count; when everything is zero the line names the next
 * command instead of printing a bare `0 · 0 · 0`.
 */
export function formatDashboardSummary(s: DashboardSummaryInput): string {
  const line =
    `  joined this week ${s.joinsThisWeek} joins · ` +
    `active last 7 days ${s.active7d} members · ` +
    `real members ${s.realHumans} members`;
  const hints: string[] = [];
  if (s.joinsThisWeek === 0) hints.push('no joins this week - see npm run funnel');
  if (s.active7d === 0) hints.push('nobody active in 7 days - see npm run reengage');
  if (s.realHumans === 0) hints.push('no members on record - run npm run backfill');
  if (hints.length === 0) return line;
  return `${line}\n  (${hints.join('; ')})`;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface RosterTextRow {
  memberId: string;
  displayName?: string | null;
  joinedAt: string;
  joinSource: string | null;
  firstMessageAt: string | null;
  firstVoiceAt: string | null;
  leftAt: string | null;
}

export function sampleRosterRows(): RosterTextRow[] {
  return [
    {
      memberId: '1001',
      displayName: 'Ava',
      joinedAt: '2026-09-24T10:00:00.000Z',
      joinSource: 'invite:abc123',
      firstMessageAt: '2026-09-24T11:00:00.000Z',
      firstVoiceAt: null,
      leftAt: null,
    },
    {
      memberId: '1002',
      displayName: null,
      joinedAt: '2026-09-25T12:30:00.000Z',
      joinSource: 'unknown',
      firstMessageAt: null,
      firstVoiceAt: null,
      leftAt: null,
    },
    {
      memberId: '1003',
      displayName: 'Bo',
      joinedAt: '2026-09-26T09:15:00.000Z',
      joinSource: 'backfill:log:member-join',
      firstMessageAt: null,
      firstVoiceAt: null,
      leftAt: '2026-09-27T00:00:00.000Z',
    },
  ];
}

/**
 * Turn a stored source into something a community operator can act on.
 * `backfill:*` means the member predates the instrumentation, and saying
 * "unknown (pre-tracking)" is honest where "unknown" alone would look like a
 * bug in the tracker.
 */
export function describeRosterSource(s: string | null): string {
  if (!s) return 'unknown';
  if (s.startsWith('invite:')) return s.slice('invite:'.length);
  if (s.startsWith('ambiguous:')) return `ambiguous (${s.slice('ambiguous:'.length)})`;
  if (s.startsWith('backfill:')) return 'unknown (pre-tracking)';
  if (s === 'vanity') return 'vanity URL';
  return s;
}

const ROSTER_MEMBER_MIN = 20;
const ROSTER_MEMBER_MAX = 32;
const ROSTER_SOURCE_WIDTH = 22;
const ROSTER_JOINED_WIDTH = 16;
const ROSTER_POSTED_WIDTH = 7;
const ROSTER_VOICE_WIDTH = 6;
const ROSTER_HERE_WIDTH = 'still here?'.length;

function rosterLabel(r: RosterTextRow): string {
  const n = (r.displayName ?? '').trim();
  return n ? `${n} (${r.memberId})` : r.memberId;
}

function rosterJoined(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * The roster table plus summary, one string. Zero rows print the next step
 * (wider window / backfill check) instead of an empty table.
 */
export function formatRosterText(rows: RosterTextRow[], days: number, since: string): string {
  const out: string[] = [];
  out.push(`\n${topHeader('new members', days, since)}\n`);

  if (rows.length === 0) {
    out.push('  No joins recorded in this window.');
    out.push('  Try a wider window (e.g. node scripts/roster.ts 30) or run npm run backfill if joins should exist.\n');
    return out.join('\n');
  }

  const memberWidth = Math.min(
    ROSTER_MEMBER_MAX,
    Math.max(ROSTER_MEMBER_MIN, ...rows.map((r) => fitCell(rosterLabel(r), ROSTER_MEMBER_MAX).length)),
  );
  // Fixed column widths: the dash rule and every body row share them, so one
  // long name or source cannot move the columns. The last column is padded to
  // its header width so trailing alignment holds too.
  out.push(
    `  ${'member'.padEnd(memberWidth)}  ${'joined'.padEnd(ROSTER_JOINED_WIDTH)}  ` +
      `${'came from'.padEnd(ROSTER_SOURCE_WIDTH)}  ${'posted?'.padEnd(ROSTER_POSTED_WIDTH)}  ` +
      `${'voice?'.padEnd(ROSTER_VOICE_WIDTH)}  ${'still here?'}`,
  );
  out.push(
    `  ${'-'.repeat(memberWidth)}  ${'-'.repeat(ROSTER_JOINED_WIDTH)}  ` +
      `${'-'.repeat(ROSTER_SOURCE_WIDTH)}  ${'-'.repeat(ROSTER_POSTED_WIDTH)}  ` +
      `${'-'.repeat(ROSTER_VOICE_WIDTH)}  ${'-'.repeat(ROSTER_HERE_WIDTH)}`,
  );
  for (const r of rows) {
    out.push(
      `  ${fitCell(rosterLabel(r), ROSTER_MEMBER_MAX).padEnd(memberWidth)}  ` +
        `${rosterJoined(r.joinedAt).padEnd(ROSTER_JOINED_WIDTH)}  ` +
        `${fitCell(describeRosterSource(r.joinSource), ROSTER_SOURCE_WIDTH).padEnd(ROSTER_SOURCE_WIDTH)}  ` +
        `${(r.firstMessageAt ? 'yes' : 'NO').padEnd(ROSTER_POSTED_WIDTH)}  ` +
        `${(r.firstVoiceAt ? 'yes' : 'no').padEnd(ROSTER_VOICE_WIDTH)}  ` +
        `${(r.leftAt ? 'left' : 'yes').padEnd(ROSTER_HERE_WIDTH)}`,
    );
  }

  const posted = rows.filter((r) => r.firstMessageAt).length;
  const silent = rows.filter((r) => !r.firstMessageAt && !r.leftAt).length;
  const attributed = rows.filter((r) => (r.joinSource ?? '').startsWith('invite:')).length;
  out.push(`\n  ${rows.length} members joined, ${posted} posted, ${rows.length - posted} never posted`);
  out.push(`  ${attributed} of ${rows.length} members attributed to a specific invite code`);
  if (attributed < rows.length) {
    out.push(
      `  The rest joined before per-invite tracking was live. Every join from` +
        `\n  deploy onward is attributed to a code.`,
    );
  }
  if (silent > 0) {
    out.push(`\n  ${silent} members still in the server and have never posted - the re-engagement list.`);
  }
  out.push('');
  return out.join('\n');
}
