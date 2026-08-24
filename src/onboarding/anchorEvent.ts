/**
 * The Sunday Squad anchor event: when it is on, and what we say about it.
 *
 * Same split as the rest of onboarding - this file decides, the adapter in
 * src/discord/anchorWelcome.ts posts. Nothing here touches Discord, a token or
 * a clock it was not handed, so every string and every date below is tested in
 * test/unit.anchorevent.test.ts without a network.
 *
 * Spec: `anchor-event-and-first-72-hours` on TWO-66, revision 4
 * (dc192d46-22fe-420b-9cc9-8945b722b60e) - §5.3 for the copy, §5.4 for the
 * scheduled event. Revisions 2 and 3 name Fortnite and are dead: the CEO
 * settled on Fall Guys on 2026-08-19. Do not build against them.
 *
 * THE ONE TRAP. The recurrence is 20:00 *America/New_York*, not a fixed number
 * of seconds. Adding 604800 to the previous occurrence is right 51 weeks a year
 * and silently an hour wrong from 1 November 2026, when US DST ends. So every
 * occurrence is computed from its own calendar date as a wall-clock time in the
 * event's own zone, and converted to an instant afterwards.
 */

/** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AnchorEventSpec {
  name: string;
  /** Voice room the event runs in, and the channel its welcome posts into. */
  channelId: string;
  /** IANA zone. The recurrence is local to this, not to UTC. */
  timeZone: string;
  weekday: Weekday;
  /** Local wall-clock start. */
  hour: number;
  minute: number;
  durationMinutes: number;
  /**
   * First run of the series, as epoch seconds. Sunday 23 August 2026, 20:00
   * America/New_York. The old spec said 30 August; that is now run 2, and
   * creating the series from it would put the sidebar card a week behind the
   * actual first run - a failure that looks correct.
   */
  seriesStartEpoch: number;
  /** Sidebar description, TWO-66 §5.4. */
  description: string;
}

export const SUNDAY_SQUAD: AnchorEventSpec = {
  name: 'Sunday Squad',
  channelId: '1175127344072118405', // 🔊🏠〢Lobby (voice)
  timeZone: 'America/New_York',
  weekday: 0,
  hour: 20,
  minute: 0,
  durationMinutes: 60,
  seriesStartEpoch: 1787529600,
  description: [
    'Fall Guys, an hour, every Sunday. It runs whether there\'s two of us or eight — a party of two still drops into a full public show. Free on PC, PlayStation, Xbox, Switch and Android, and nothing to be rusty at.',
    '',
    'Drop in whenever. No sign-up, no need to say you\'re coming, and if you haven\'t got it installed there\'s something we can play in the room itself.',
  ].join('\n'),
};

/**
 * How close a join has to be to an occurrence before we switch to the
 * "happening right now" copy. TWO-66 §5.3: "less than two hours before".
 */
export const NEAR_EVENT_MS = 2 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

// --- zone arithmetic --------------------------------------------------------

interface LocalFields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 rather than hour12:false: the latter can yield hour "24" on some
      // ICU builds, which turns into the wrong day when read back as a number.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** What the wall clock in `timeZone` reads at this instant. */
function localFields(ms: number, timeZone: string): LocalFields {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  };
}

/** Those same fields packed into the UTC line, so date maths has no DST in it. */
function asUtc(f: LocalFields): number {
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
}

function offsetMs(ms: number, timeZone: string): number {
  return asUtc(localFields(ms, timeZone)) - ms;
}

/**
 * The instant at which the clock in `timeZone` reads this wall time.
 *
 * Two passes on purpose. The first guess uses the offset in force at the
 * *naive* instant, which is the wrong side of the boundary on the two DST
 * changeover days a year; re-reading the offset at that guess fixes it. For
 * 20:00 on a Sunday this only ever matters on 1 November 2026 and its
 * successors, which is exactly the case we are here to get right.
 */
export function zonedEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = naive - offsetMs(naive, timeZone);
  ts = naive - offsetMs(ts, timeZone);
  return ts;
}

/** Start of the occurrence on a given local calendar date, in epoch ms. */
function startOnLocalDate(dateMs: number, spec: AnchorEventSpec): number {
  const d = new Date(dateMs);
  return zonedEpochMs(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    spec.hour,
    spec.minute,
    spec.timeZone,
  );
}

// --- occurrences ------------------------------------------------------------

/**
 * The next start strictly after `nowMs`, as epoch ms.
 *
 * Walks forward over local calendar dates rather than adding a week to a
 * timestamp. Each candidate date is converted independently, so the series
 * never drifts across a DST boundary.
 */
export function nextOccurrenceMs(nowMs: number, spec: AnchorEventSpec = SUNDAY_SQUAD): number {
  const today = asUtc(localFields(nowMs, spec.timeZone));
  for (let add = 0; add <= 8; add++) {
    const dateMs = today + add * DAY_MS;
    if (new Date(dateMs).getUTCDay() !== spec.weekday) continue;
    const start = startOnLocalDate(dateMs, spec);
    if (start > nowMs) return start;
  }
  // Unreachable: any 9-day window contains at least one of every weekday.
  throw new Error(`no occurrence of ${spec.name} found after ${new Date(nowMs).toISOString()}`);
}

/** The most recent start at or before `nowMs`, as epoch ms. */
function previousOccurrenceMs(nowMs: number, spec: AnchorEventSpec): number | null {
  const today = asUtc(localFields(nowMs, spec.timeZone));
  for (let back = 0; back <= 8; back++) {
    const dateMs = today - back * DAY_MS;
    if (new Date(dateMs).getUTCDay() !== spec.weekday) continue;
    const start = startOnLocalDate(dateMs, spec);
    if (start <= nowMs) return start;
  }
  return null;
}

/**
 * The start to use when creating or repairing the live recurring series.
 *
 * The original anchor remains part of the spec, but Discord cannot create a
 * scheduled event in the past. Before run 1 this returns run 1; afterwards it
 * advances to the next independently-computed local Sunday, preserving the
 * 20:00 America/New_York contract without trying to recreate missed cards.
 */
export function liveSeriesStartEpoch(
  nowMs: number,
  spec: AnchorEventSpec = SUNDAY_SQUAD,
): number {
  if (nowMs < spec.seriesStartEpoch * 1000) return spec.seriesStartEpoch;
  return Math.floor(nextOccurrenceMs(nowMs, spec) / 1000);
}

/** The next `count` starts, as epoch *seconds* - the unit Discord takes. */
export function occurrencesFrom(
  nowMs: number,
  count: number,
  spec: AnchorEventSpec = SUNDAY_SQUAD,
): number[] {
  const out: number[] = [];
  let cursor = nowMs;
  for (let i = 0; i < count; i++) {
    const next = nextOccurrenceMs(cursor, spec);
    out.push(Math.floor(next / 1000));
    cursor = next;
  }
  return out;
}

export interface OccurrenceContext {
  /** Epoch *seconds* of the occurrence this member should be told about. */
  startEpoch: number;
  /**
   * True when the near-event copy applies: inside the two hours before the
   * start, or while it is still running.
   */
  near: boolean;
  /** True when the occurrence is actually under way right now. */
  live: boolean;
}

/**
 * Which occurrence to name, and in which of the two voices.
 *
 * The spec states one rule - "less than two hours before an occurrence" - and
 * writes the near-event copy in the present tense ("happening right now ... for
 * about another hour"). Taken literally the rule alone leaves a member who
 * joins at 20:30 being told about *next* Sunday while the event is running in
 * the very room they are reading, so an occurrence still in progress counts as
 * near too and is the one we name. That is the only judgement call in this
 * file; everything else is transcription.
 */
export function occurrenceContext(
  nowMs: number,
  spec: AnchorEventSpec = SUNDAY_SQUAD,
): OccurrenceContext {
  const prev = previousOccurrenceMs(nowMs, spec);
  if (prev !== null && nowMs < prev + spec.durationMinutes * 60_000) {
    return { startEpoch: Math.floor(prev / 1000), near: true, live: true };
  }
  const next = nextOccurrenceMs(nowMs, spec);
  return {
    startEpoch: Math.floor(next / 1000),
    near: next - nowMs < NEAR_EVENT_MS,
    live: false,
  };
}

// --- copy -------------------------------------------------------------------
//
// TWO-66 §5.3, verbatim. Paragraph breaks are the spec's; the line wrapping in
// the source document is not reproduced, because Discord soft-wraps to the
// reader's window and hard breaks mid-sentence only look broken on a phone.
//
// Nothing may be appended to this message - no picker, no buttons, no footer.
// That is an instruction in TOG-93, not a preference.

const FIRST_PARAGRAPH = (memberMention: string) => `Hey ${memberMention} — glad you're here.`;

const LAST_PARAGRAPH =
  "You don't need to sign up or say anything first — just join the voice room and I'll get you into the party. Haven't got Fall Guys? Come anyway, there's something we can play right there in the room. If you can't make Sunday, hop in whenever and see who's about.";

export function anchorWelcomeText(
  memberMention: string,
  nowMs: number,
  spec: AnchorEventSpec = SUNDAY_SQUAD,
): string {
  const ctx = occurrenceContext(nowMs, spec);

  const middle = ctx.near
    ? `The thing to know: **${spec.name}** is happening right now in <#${spec.channelId}> — Fall Guys, for about another hour. Come say hi. You don't need it installed to join in.`
    : `The thing to know: **${spec.name}**, every Sunday at 8pm Eastern in <#${spec.channelId}>. We play Fall Guys for about an hour. Next one is <t:${ctx.startEpoch}:R>.`;

  // "Replace the second paragraph with" - so the first and third stand in both
  // voices, and only the middle changes.
  return [FIRST_PARAGRAPH(memberMention), '', middle, '', LAST_PARAGRAPH].join('\n');
}

// --- the scheduled event ----------------------------------------------------

/** Discord's `recurrence_rule.frequency`. Only the one we use is named. */
const FREQUENCY_WEEKLY = 2;
/** Discord's `by_weekday` is Monday-based, unlike everything else here. */
const DISCORD_WEEKDAY_SUNDAY = 6;
/** `entity_type`: 2 = VOICE. `privacy_level`: 2 = GUILD_ONLY. */
const ENTITY_TYPE_VOICE = 2;
const PRIVACY_LEVEL_GUILD_ONLY = 2;

export interface ScheduledEventPayload {
  name: string;
  description: string;
  channel_id: string;
  entity_type: number;
  privacy_level: number;
  scheduled_start_time: string;
  scheduled_end_time: string;
  recurrence_rule: {
    start: string;
    frequency: number;
    interval: number;
    by_weekday: number[];
  };
}

/**
 * The body for POST /guilds/{guild}/scheduled-events.
 *
 * `startEpoch` defaults to the series start rather than to "next Sunday" on
 * purpose: the card is a series, and anchoring it anywhere but run 1 shifts
 * every later occurrence. Pass an explicit start only when re-creating a
 * series that has already begun.
 */
export function scheduledEventPayload(
  spec: AnchorEventSpec = SUNDAY_SQUAD,
  startEpoch: number = spec.seriesStartEpoch,
): ScheduledEventPayload {
  const startMs = startEpoch * 1000;
  const endMs = startMs + spec.durationMinutes * 60_000;
  const start = new Date(startMs).toISOString();
  return {
    name: spec.name,
    description: spec.description,
    channel_id: spec.channelId,
    entity_type: ENTITY_TYPE_VOICE,
    privacy_level: PRIVACY_LEVEL_GUILD_ONLY,
    scheduled_start_time: start,
    scheduled_end_time: new Date(endMs).toISOString(),
    recurrence_rule: {
      start,
      frequency: FREQUENCY_WEEKLY,
      interval: 1,
      by_weekday: [DISCORD_WEEKDAY_SUNDAY],
    },
  };
}

/**
 * Individual events for the six weeks ahead, for the case where recurrence is
 * refused - Discord rejects `recurrence_rule` on some guilds, and six cards
 * topped up by hand beat one card that is a week wrong.
 */
export function individualEventPayloads(
  nowMs: number,
  count = 6,
  spec: AnchorEventSpec = SUNDAY_SQUAD,
): Omit<ScheduledEventPayload, 'recurrence_rule'>[] {
  return occurrencesFrom(nowMs, count, spec).map((epoch) => {
    const { recurrence_rule: _drop, ...rest } = scheduledEventPayload(spec, epoch);
    return rest;
  });
}
