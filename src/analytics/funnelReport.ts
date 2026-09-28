/**
 * The funnel `--json` report builder (TOG-8290).
 *
 * `node scripts/funnel.ts --json` prints one JSON object (schema 1) that the
 * dashboard stopgap quotes: the same numbers a human reproduces from the text
 * report. Anything downstream that parses that output breaks silently when a
 * key is renamed or removed, so the key set, the type of every field, and the
 * units of every measured value are pinned by
 * test/unit.funnel-json.test.ts, which drives `buildFunnelReport` directly
 * with no database.
 *
 * Design rules:
 *  - scripts/funnel.ts only ever collects rows; it never shapes the report.
 *    Every key of the --json output is written exactly once, here, so a
 *    rename fails the pinning test instead of shipping a silent contract
 *    break. Do not build this object inline anywhere else.
 *  - Units live in the field docs, not in key names: `gapMs` is milliseconds,
 *    `avgSessionSeconds` is seconds, `day` is days, `since`/`start`/`end`
 *    are ISO-8601 UTC instants, and every other number is a count of events,
 *    people, or sessions. A seconds-vs-milliseconds mixup is the failure
 *    these docs exist to prevent.
 *  - A number we cannot compute is `null`, never 0: `avgSessionSeconds` is
 *    null when no session was measured, not a zero-second average.
 */
import type { DowntimeWindowCount } from '../core/inviteTracker.ts';
import type { VoiceDurationSummary } from '../core/voiceSessions.ts';

/** The `schema` value in every report. Bump only with a documented change. */
export const FUNNEL_JSON_SCHEMA_VERSION = 1;

/** One row of the per-source join table. `joins` counts join events. */
export interface FunnelReportSource {
  source: string;
  joins: number;
}

/**
 * One tracked invite campaign. `clicks` and `joins` are counts on the same
 * invite code; `retired` marks a disabled campaign row.
 */
export interface FunnelReportCampaign {
  slug: string;
  label: string;
  inviteCode: string;
  clicks: number;
  joins: number;
  retired: boolean;
}

/**
 * One bot-down window. `start`/`end` are ISO-8601 UTC instants bounding the
 * gap in the bot's own write series; `gapMs` is that gap in milliseconds;
 * `downtimeUnknown` counts the `unknown` joins whose Discord timestamp falls
 * inside the window (an upper bound, never a re-attribution).
 */
export interface FunnelReportDowntimeWindow {
  start: string;
  end: string;
  gapMs: number;
  downtimeUnknown: number;
}

/** One per-day click spike flag. `count` is clicks, `factor` is vs normal. */
export interface FunnelReportClickSpikeDay {
  day: string;
  count: number;
  factor: number;
}

/** Per-campaign click-spike flags. Reporting only; rows stay counted above. */
export interface FunnelReportClickSpike {
  slug: string;
  spikes: FunnelReportClickSpikeDay[];
}

/**
 * One retention measurement. `day` is days after joining; `retained` and
 * `cohort` are member counts.
 */
export interface FunnelReportRetention {
  day: number;
  retained: number;
  cohort: number;
}

/** Everything the script collects before shaping the report. All pure data. */
export interface FunnelReportInput {
  /** Window length in days. */
  windowDays: number;
  /** Window start, ISO-8601 UTC instant. */
  since: string;
  /** Invite clicks in the window (events). */
  clicks: number;
  /** Joins in the window (events; a rejoiner counts twice). */
  joins: number;
  /** Join events set aside inside anomaly windows. */
  joinsSetAside: number;
  /** Distinct members who cleared the rules gate in the window. */
  gateCleared: number;
  /** Distinct members who joined in the window (people, not events). */
  joiners: number;
  /** Members in the server right now who never cleared the gate. */
  stuckAtGate: number;
  /** First-message events in the window. */
  firstMessage: number;
  /** First-voice-session events in the window. */
  firstVoice: number;
  /** Leaves in the window (events). */
  leaves: number;
  /** Leave events set aside inside anomaly windows. */
  leavesSetAside: number;
  bySource: FunnelReportSource[];
  /** Joins attributable to several invites at once. */
  ambiguous: number;
  /** Joins attributable to nothing. */
  unknown: number;
  /** Blind windows with their unknown-join counts. */
  downtime: DowntimeWindowCount[];
  /** Unknown joins inside any blind window (upper bound). */
  downtimeUnknown: number;
  campaigns: FunnelReportCampaign[];
  clickSpikes: FunnelReportClickSpike[];
  /** First-voice count also rides here so voice stats share one query. */
  firstVoiceSessions: number;
  voice: VoiceDurationSummary;
  retention: FunnelReportRetention[];
  /** Members still here who never posted or spoke. */
  neverPosted: number;
  /** Never-cleaned-up raid accounts still in the member count. */
  strandedRaid: number;
  totalEvents: number;
}

/** The exact `--json` object on stdout. Key renames break the contract. */
export interface FunnelReport {
  schema: number;
  windowDays: number;
  since: string;
  funnel: {
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
  };
  attribution: {
    bySource: FunnelReportSource[];
    ambiguous: number;
    unknown: number;
  };
  downtime: {
    windows: FunnelReportDowntimeWindow[];
    unknownInWindow: number;
  };
  campaigns: FunnelReportCampaign[];
  clickSpikes: FunnelReportClickSpike[];
  voice: {
    firstVoiceSessions: number;
    /** Mean over known-start sessions, seconds; null when none measured. */
    avgSessionSeconds: number | null;
    measuredSessions: number;
    excludedUnknownStarts: number;
  };
  retention: FunnelReportRetention[];
  neverPosted: number;
  strandedRaid: number;
  totalEvents: number;
}

/** Shape the collected numbers into the `--json` report. No I/O. */
export function buildFunnelReport(input: FunnelReportInput): FunnelReport {
  return {
    schema: FUNNEL_JSON_SCHEMA_VERSION,
    windowDays: input.windowDays,
    since: input.since,
    funnel: {
      clicks: input.clicks,
      joins: input.joins,
      joinsSetAside: input.joinsSetAside,
      gateCleared: input.gateCleared,
      joiners: input.joiners,
      stuckAtGate: input.stuckAtGate,
      firstMessage: input.firstMessage,
      firstVoice: input.firstVoice,
      leaves: input.leaves,
      leavesSetAside: input.leavesSetAside,
    },
    attribution: {
      bySource: input.bySource,
      ambiguous: input.ambiguous,
      unknown: input.unknown,
    },
    downtime: {
      windows: input.downtime.map((w) => ({
        start: w.start,
        end: w.end,
        gapMs: w.gapMs,
        downtimeUnknown: w.downtimeUnknown,
      })),
      unknownInWindow: input.downtimeUnknown,
    },
    campaigns: input.campaigns,
    clickSpikes: input.clickSpikes,
    voice: {
      firstVoiceSessions: input.firstVoiceSessions,
      avgSessionSeconds: input.voice.averageSeconds,
      measuredSessions: input.voice.measured,
      excludedUnknownStarts: input.voice.excludedUnknownStarts,
    },
    retention: input.retention,
    neverPosted: input.neverPosted,
    strandedRaid: input.strandedRaid,
    totalEvents: input.totalEvents,
  };
}
