/**
 * Early-message backfill.
 *
 * scripts/backfill.ts recovers joins, leaves and voice from Discord's member
 * list and the server's own log channels (TWO-16). It deliberately does not
 * touch the message milestones, because they are not in any log - the only
 * record of a member's posts is the posts themselves, sitting in whichever
 * channels they put them in.
 *
 * So we read the channels. For every readable channel that holds member
 * conversation, walk the history and keep the earliest THREE messages per
 * author. The first is the difference between "joined, status unknown" and
 * "joined and never said a word". The third is AM7's text bar - "3 or more
 * messages within 7 days" - and until TWO-95 we had no way to answer it, so
 * AM7 admitted anyone who had posted at all and was an upper bound.
 *
 * Three, not all of them, because three is the bar. Counting past it would cost
 * memory per author and buy nothing any report asks for.
 *
 * TRUNCATION IS SAFE IN ONE DIRECTION, WHICH IS WHY THIS CAN BE RE-RUN.
 * A capped scan sees a subset of a member's messages, so the third-earliest we
 * find is at or LATER than their true third - never earlier. A member can
 * therefore be missed by AM7 but never wrongly admitted, and because the writer
 * uses recordEarliest a deeper re-run only ever moves the milestones earlier,
 * towards the truth. The report prints the residual either way.
 *
 * Costs one request per 100 messages and is safe to repeat.
 */
import type { EventStore } from '../store/eventStore.ts';
import { MESSAGE_RUNGS } from '../core/events.ts';
import { scanChannel, type DiscordRest, type RawChannel } from '../discord/rest.ts';

/** Channel types that can hold member messages. */
const TEXT_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const FORUM_TYPES = new Set([15]); // GUILD_FORUM - posts are threads
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * Channels that are bot output rather than conversation.
 *
 * Skipping them is a cost decision, not a correctness one: every message in
 * them is authored by a bot and would be discarded anyway. But they are also
 * the highest-volume channels in the server, so scanning them would roughly
 * triple the run for nothing.
 */
const LOGGY = /log|wick|audit|modmail|network-status|^\d+-[a-z]/i;

export function isLogChannel(name: string, categoryName: string): boolean {
  return LOGGY.test(name) || LOGGY.test(categoryName);
}

export interface MessageScanOptions {
  guildId: string;
  maxPagesPerChannel: number;
  /** Stop paging back past this ISO timestamp. null = all history. */
  since?: string | null;
  dryRun?: boolean;
}

export interface MessageScanSummary {
  channelsConsidered: number;
  channelsScanned: number;
  threadsScanned: number;
  messagesRead: number;
  authorsSeen: number;
  /** Authors we found a full ladder for - the ones AM7 can now judge exactly. */
  authorsWithFullLadder: number;
  firstMessagesWritten: number;
  /**
   * Messages read but refused a ladder slot: missing id, missing or
   * unparseable timestamp, or no author id. Counted here so a corrupt page
   * shows up as a number rather than vanishing into the totals. Bots are
   * skipped, not malformed, and are not counted.
   */
  malformed: number;
  /** Channels that hit the page cap - their history is only partly read. */
  truncated: string[];
  /** Oldest message timestamp we actually reached. */
  scannedBackTo: string | null;
}

/** One of a member's earliest messages. */
export interface EarlyMessage {
  /** Discord message snowflake. Only used to not count one message twice. */
  id: string;
  at: string;
  channelId: string;
}

/** A member's earliest messages, ascending, at most MESSAGE_RUNGS.length of them. */
export interface MemberMessages {
  memberId: string;
  rungs: EarlyMessage[];
}

/** Three. The ladder and the AM7 bar are the same number by construction. */
const LADDER = MESSAGE_RUNGS.length;

/**
 * Keep `m` holding the earliest LADDER messages we have been shown.
 *
 * Ordering is by timestamp, with the snowflake as tiebreak so two messages in
 * the same millisecond still get a stable order rather than depending on which
 * channel we happened to scan first.
 */
function offer(m: MemberMessages, msg: EarlyMessage): void {
  // A message already on the ladder is the same message reaching us twice, not
  // a second one. Anything below the ladder is discarded anyway, so this is the
  // only place a duplicate could do damage.
  if (m.rungs.some((r) => r.id === msg.id)) return;
  const after = (a: EarlyMessage, b: EarlyMessage) => a.at > b.at || (a.at === b.at && a.id > b.id);
  let i = m.rungs.length;
  while (i > 0 && after(m.rungs[i - 1], msg)) i--;
  if (i >= LADDER) return;
  m.rungs.splice(i, 0, msg);
  if (m.rungs.length > LADDER) m.rungs.length = LADDER;
}

/**
 * Walk the guild's conversation channels and return the earliest messages per
 * author. Pure with respect to the database - the caller decides what to write.
 */
export async function findEarlyMessages(
  rest: DiscordRest,
  opts: MessageScanOptions,
): Promise<{
  early: Map<string, MemberMessages>;
  lastActive: Map<string, string>;
  summary: MessageScanSummary;
}> {
  const g = opts.guildId;
  const s: MessageScanSummary = {
    channelsConsidered: 0,
    channelsScanned: 0,
    threadsScanned: 0,
    messagesRead: 0,
    authorsSeen: 0,
    authorsWithFullLadder: 0,
    firstMessagesWritten: 0,
    malformed: 0,
    truncated: [],
    scannedBackTo: null,
  };

  const channels = (await rest.get<RawChannel[]>(`/guilds/${g}/channels`)) ?? [];
  const catName = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name ?? '']));
  const nameOf = (c: RawChannel) => c.name ?? '';
  const catOf = (c: RawChannel) => (c.parent_id ? (catName.get(c.parent_id) ?? '') : '');

  const conversation = channels.filter(
    (c) =>
      (TEXT_TYPES.has(c.type) || FORUM_TYPES.has(c.type)) && !isLogChannel(nameOf(c), catOf(c)),
  );
  s.channelsConsidered = conversation.length;

  // Forum posts live in threads, and threads are separate channels to the API.
  const threadIds = new Set<string>();
  const active = await rest.get<{ threads?: RawChannel[] }>(`/guilds/${g}/threads/active`);
  for (const t of active?.threads ?? []) {
    if (THREAD_TYPES.has(t.type)) threadIds.add(t.id);
  }
  for (const f of conversation.filter((c) => FORUM_TYPES.has(c.type))) {
    const arch = await rest.get<{ threads?: RawChannel[] }>(
      `/channels/${f.id}/threads/archived/public?limit=100`,
    );
    for (const t of arch?.threads ?? []) threadIds.add(t.id);
  }

  const early = new Map<string, MemberMessages>();
  const lastActive = new Map<string, string>();

  const targets: { id: string; isThread: boolean }[] = [
    ...conversation.filter((c) => !FORUM_TYPES.has(c.type)).map((c) => ({ id: c.id, isThread: false })),
    ...[...threadIds].map((id) => ({ id, isThread: true })),
  ];

  for (const t of targets) {
    const r = await scanChannel(rest, t.id, {
      maxPages: opts.maxPagesPerChannel,
      stopBefore: opts.since ?? null,
    });
    if (t.isThread) s.threadsScanned++;
    else s.channelsScanned++;
    if (r.truncated) s.truncated.push(t.id);
    s.messagesRead += r.messages.length;
    if (r.scannedBackTo && (!s.scannedBackTo || r.scannedBackTo < s.scannedBackTo)) {
      s.scannedBackTo = r.scannedBackTo;
    }

    for (const msg of r.messages) {
      const a = msg.author;
      // Bots are not members of the funnel. Skipped, not malformed: every
      // message in a log channel is authored by a bot and discarded on purpose.
      if (a?.bot) continue;
      // TOG-5700: a row without an author id, without a message id, or with
      // an unparseable timestamp is refused a ladder slot and counted, not
      // silently skipped. Before this, a bad timestamp threw RangeError and
      // aborted the whole scan, and a missing id was admitted with `undefined`
      // as its dedupe key.
      if (!a?.id || typeof msg.id !== 'string' || !msg.id) {
        s.malformed++;
        continue;
      }
      const parsed = new Date(msg.timestamp);
      if (Number.isNaN(parsed.getTime())) {
        s.malformed++;
        continue;
      }
      const at = parsed.toISOString();
      const prevActive = lastActive.get(a.id);
      if (!prevActive || at > prevActive) lastActive.set(a.id, at);
      let m = early.get(a.id);
      if (!m) early.set(a.id, (m = { memberId: a.id, rungs: [] }));
      offer(m, { id: msg.id, at, channelId: t.id });
    }
  }

  s.authorsSeen = early.size;
  s.authorsWithFullLadder = [...early.values()].filter((m) => m.rungs.length === LADDER).length;
  return { early, lastActive, summary: s };
}

export interface MessageWriteResult {
  /** New milestone events written, across all three rungs. */
  written: number;
  /** Members who now have a third_message on file - the exact half of AM7. */
  laddersCompleted: number;
}

/**
 * Write the scan results into the funnel log.
 *
 * `recordEarliest`, not `record`: the live bot may already have logged a rung
 * for someone who posted after deploy, and if the scan finds an older post then
 * the older one is the truth. Going the other way is never allowed, so a re-run
 * can only ever improve the data.
 *
 * Rungs are written in ladder order and a member's Nth-earliest message becomes
 * their Nth rung, so `third_message` lands on the third message and not merely
 * on a third message. A member with one or two messages on file gets one or two
 * rungs and no third_message - which is the correct answer, not a gap: they
 * have not cleared the AM7 text bar.
 */
export async function writeEarlyMessages(
  store: EventStore,
  guildId: string,
  early: Map<string, MemberMessages>,
  lastActive: Map<string, string>,
): Promise<MessageWriteResult> {
  let written = 0;
  let laddersCompleted = 0;
  for (const m of early.values()) {
    for (const [i, msg] of m.rungs.entries()) {
      const r = await store.recordEarliest({
        guildId,
        memberId: m.memberId,
        eventType: MESSAGE_RUNGS[i],
        occurredAt: msg.at,
        source: `channel:${msg.channelId}`,
        metadata: { backfill: 'message_scan' },
      });
      if (r.inserted) written++;
    }
    if (m.rungs.length === LADDER) laddersCompleted++;
  }
  for (const [memberId, at] of lastActive) await store.touchActivity(guildId, memberId, at);
  return { written, laddersCompleted };
}
