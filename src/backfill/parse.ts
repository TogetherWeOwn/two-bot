/**
 * Parsers for the log channels the TWO server already keeps.
 *
 * Discord's API exposes no voice history and no per-member invite record. But
 * TWO has been running logging bots for years, and those bots wrote the history
 * down in ordinary channels. Reading those channels back is how we get a
 * baseline instead of a zero.
 *
 * These are pure string functions on purpose: log formats are exactly the kind
 * of thing that changes silently, so they are unit tested against real captured
 * samples in test/unit.backfill.test.ts.
 *
 * Every export is TOTAL over untrusted input (TOG-8670): truncated JSON,
 * logger format drift and hand-edited fixtures must parse as null - never
 * throw, never return a half-record. In particular a returned record always
 * carries a parseable `occurredAt`, so the backfill script's
 * `new Date(occurredAt).toISOString()` cannot throw mid-scan and abort the
 * run (or leave a partial write behind it).
 */

/** Narrow an untrusted value to a plain object. Arrays count - callers index them. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Coerce an untrusted embed/message field to text; non-strings are malformed. */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Discord stamps ISO strings; anything else is a truncated or corrupt row. */
function validTimestamp(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

const SNOWFLAKE = /(\d{15,25})/;

/** Every logger we found stamps `ID: <snowflake>` in the embed footer. */
export function memberIdFromEmbed(e: unknown): string | null {
  if (!isRecord(e)) return null;
  const footer = isRecord(e.footer) ? asText(e.footer.text) : '';
  // The trailing lookahead refuses a 26+-digit run instead of silently
  // keying the member on its first 25 digits, which is not a snowflake.
  const fromFooter = footer.match(/ID:\s*(\d{15,25})(?!\d)/);
  if (fromFooter) return fromFooter[1] ?? null;
  // Fall back to the first mention in the description.
  const mention = asText(e.description).match(/<@!?(\d{15,25})>/);
  return mention ? (mention[1] ?? null) : null;
}

export function channelIdFromEmbed(e: unknown): string | null {
  if (!isRecord(e)) return null;
  const m = asText(e.description).match(/<#(\d{15,25})>/);
  return m ? (m[1] ?? null) : null;
}

export type VoiceKind = 'join' | 'change' | 'leave';

export interface VoiceRecord {
  memberId: string;
  channelId: string | null;
  kind: VoiceKind;
  occurredAt: string;
}

/**
 * Two different bots logged voice over the years, in two formats:
 *
 *   Logger (current):  title "Member joined voice channel"
 *                      description "**name** joined #channel-name"
 *   Wick   (historic): no title
 *                      description "**<@id> joined voice channel <#id>**"
 *
 * Both put the member snowflake in the footer, which is what we key on.
 */
export function parseVoiceMessage(msg: unknown): VoiceRecord | null {
  if (!isRecord(msg) || !validTimestamp(msg.timestamp)) return null;
  const embeds = msg.embeds;
  const e = Array.isArray(embeds) ? embeds[0] : undefined;
  if (!isRecord(e)) return null;

  // A present-but-non-string title is a drifted logger, not a titleless Wick
  // embed. Refusing beats guessing a kind from the description.
  if (e.title !== undefined && typeof e.title !== 'string') return null;
  const title = asText(e.title).toLowerCase();
  const desc = asText(e.description).toLowerCase();

  let kind: VoiceKind | null = null;
  if (title.includes('joined voice') || (!title && desc.includes('joined voice channel'))) {
    kind = 'join';
  } else if (title.includes('changed voice') || (!title && desc.includes('moved voice channel'))) {
    kind = 'change';
  } else if (title.includes('left voice') || (!title && desc.includes('left voice channel'))) {
    kind = 'leave';
  }
  if (!kind) return null;

  const memberId = memberIdFromEmbed(e);
  if (!memberId) return null;

  return { memberId, channelId: channelIdFromEmbed(e), kind, occurredAt: msg.timestamp };
}

export type MemberLogKind = 'join' | 'leave';

export interface MemberLogRecord {
  memberId: string;
  kind: MemberLogKind;
  occurredAt: string;
}

/**
 * The join/leave log: title "Member joined" / "Member left", with the member
 * mentioned in the description. This is the only record we have of members who
 * joined and then left - they are gone from the member list, but they still
 * happened, and leaving them out would flatter every retention number we print.
 *
 * `channelKind` handles the OTHER convention TWO's loggers use. The older
 * setup gave each event type its own channel (#member-join, #member-leave) and
 * then wrote a titleless embed - just the mention, the username, and the
 * footer ID - because the channel name already said what happened. Those
 * embeds are indistinguishable from each other in isolation, so the caller
 * passes down what the channel means. Without this the entire pre-2025 join
 * history parses as nothing.
 */
export function parseMemberLogMessage(
  msg: unknown,
  channelKind: MemberLogKind | null = null,
): MemberLogRecord | null {
  if (!isRecord(msg) || !validTimestamp(msg.timestamp)) return null;
  const embeds = msg.embeds;
  const e = Array.isArray(embeds) ? embeds[0] : undefined;
  if (!isRecord(e)) return null;
  // Same rule as the documented titled-embed guard below: a non-string title
  // is an unrecognised titled embed, so the channel hint must not apply.
  if (e.title !== undefined && typeof e.title !== 'string') return null;
  const title = asText(e.title).toLowerCase();
  let kind: MemberLogKind | null = null;
  if (title === 'member joined') kind = 'join';
  else if (title === 'member left' || title === 'member banned') kind = 'leave';
  // Only fall back to the channel's meaning when the embed carries no title of
  // its own. A titled embed we do not recognise is a different event type
  // (role changes, nickname edits) and must not be counted as a join.
  // The channel hint is trusted only when it is exactly 'join' or 'leave' -
  // a drifted caller passing anything else must not mint a kind from it.
  else if (!title && (channelKind === 'join' || channelKind === 'leave')) kind = channelKind;
  if (!kind) return null;

  const memberId = memberIdFromEmbed(e);
  if (!memberId) return null;
  return { memberId, kind, occurredAt: msg.timestamp };
}

/**
 * Map a channel name to the event type it is dedicated to, for the titleless
 * logs above. Returns null for channels whose contents must speak for
 * themselves.
 */
export function memberLogKindForChannel(name: unknown): MemberLogKind | null {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase();
  if (/(^|[^a-z])member-join([^a-z]|$)/.test(n)) return 'join';
  if (/(^|[^a-z])member-(leave|ban)([^a-z]|$)/.test(n)) return 'leave';
  return null;
}

export interface LeaveAttributionRecord {
  /** This logger only ever wrote a username, never a snowflake. */
  username: string;
  /** 'vanity' | 'oauth' | 'unknown' - the bot's own words, normalised. */
  joinedVia: string;
  occurredAt: string;
}

/**
 * The #invites channel. An invite-tracker bot posts one line per departure,
 * retroactively saying how that member had joined.
 *
 * Note what this is NOT: it never logs joins, and it never records a snowflake,
 * so it cannot attribute a *current* member to an invite. It is only good for
 * counting churn and for showing how coarse the historic attribution was.
 */
export function parseLeaveAttribution(msg: unknown): LeaveAttributionRecord | null {
  if (!isRecord(msg) || !validTimestamp(msg.timestamp)) return null;
  const m = asText(msg.content).match(/^(.*?)\s+left the server\.\s*(.*)$/i);
  if (!m) return null;
  const username = (m[1] ?? '').trim();
  // An empty username is a truncated line, not a departure - admitting it
  // would write an unattributable churn row the funnel cannot join to anyone.
  if (!username) return null;
  const tail = (m[2] ?? '').toLowerCase();
  let joinedVia = 'unknown';
  if (tail.includes('vanity')) joinedVia = 'vanity';
  else if (tail.includes('oauth')) joinedVia = 'oauth';
  else if (tail.includes('can not figure out') || tail.includes("can't figure out")) joinedVia = 'unknown';
  return { username, joinedVia, occurredAt: msg.timestamp };
}

/** Discord snowflake -> creation time. Lets us bound a scan without an API call. */
const DISCORD_EPOCH = 1_420_070_400_000n;
const SNOWFLAKE_ID = /^\d+$/;
/**
 * Total over untrusted ids: a non-numeric or out-of-range id is a corrupt
 * export row, not a crash. Returns the epoch for those, so a bad bound still
 * scans from the start instead of aborting the run.
 */
export function snowflakeToDate(id: unknown): Date {
  if (typeof id !== 'string' || !SNOWFLAKE_ID.test(id)) return new Date(Number(DISCORD_EPOCH));
  try {
    const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    if (ms > BigInt(Number.MAX_SAFE_INTEGER)) return new Date(Number(DISCORD_EPOCH));
    return new Date(Number(ms));
  } catch {
    return new Date(Number(DISCORD_EPOCH));
  }
}

/** The inverse: the smallest snowflake at or after a given time. */
export function dateToSnowflake(d: unknown): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '0';
  const ms = BigInt(d.getTime()) - DISCORD_EPOCH;
  return String((ms > 0n ? ms : 0n) << 22n);
}

export { SNOWFLAKE };
