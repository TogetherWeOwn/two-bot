/**
 * First-message backfill.
 *
 * scripts/backfill.ts recovers joins, leaves and voice from Discord's member
 * list and the server's own log channels (TWO-16). It deliberately does not
 * touch first_message, because that one is not in any log - the only record of
 * a member's first post is the post itself, sitting in whichever channel they
 * put it in.
 *
 * So we read the channels. For every readable channel that holds member
 * conversation, walk the history and keep the earliest message per author.
 * That is the member's first message, and it is the difference between
 * "joined, status unknown" and "joined and never said a word" - which is the
 * number the community team can actually act on.
 *
 * Costs one request per 100 messages, runs once, and is safe to repeat.
 */
import type { EventStore } from '../store/eventStore.ts';
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
  firstMessagesWritten: number;
  /** Channels that hit the page cap - their history is only partly read. */
  truncated: string[];
  /** Oldest message timestamp we actually reached. */
  scannedBackTo: string | null;
}

export interface FirstMessage {
  memberId: string;
  at: string;
  channelId: string;
}

/**
 * Walk the guild's conversation channels and return the earliest message per
 * author. Pure with respect to the database - the caller decides what to write.
 */
export async function findFirstMessages(
  rest: DiscordRest,
  opts: MessageScanOptions,
): Promise<{ first: Map<string, FirstMessage>; lastActive: Map<string, string>; summary: MessageScanSummary }> {
  const g = opts.guildId;
  const s: MessageScanSummary = {
    channelsConsidered: 0,
    channelsScanned: 0,
    threadsScanned: 0,
    messagesRead: 0,
    authorsSeen: 0,
    firstMessagesWritten: 0,
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

  const first = new Map<string, FirstMessage>();
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
      // Bots are not members of the funnel. Webhooks have no author.bot flag we
      // can trust, but they also never carry a real member snowflake.
      if (!a?.id || a.bot) continue;
      const at = new Date(msg.timestamp).toISOString();
      const prevActive = lastActive.get(a.id);
      if (!prevActive || at > prevActive) lastActive.set(a.id, at);
      const prev = first.get(a.id);
      if (!prev || at < prev.at) first.set(a.id, { memberId: a.id, at, channelId: t.id });
    }
  }

  s.authorsSeen = first.size;
  return { first, lastActive, summary: s };
}

/**
 * Write the scan results into the funnel log.
 *
 * `recordEarliest`, not `record`: the live bot may already have logged a
 * first_message for someone who posted after deploy, and if the scan finds an
 * older post then the older one is the truth. Going the other way is never
 * allowed, so a re-run can only ever improve the data.
 */
export async function writeFirstMessages(
  store: EventStore,
  guildId: string,
  first: Map<string, FirstMessage>,
  lastActive: Map<string, string>,
): Promise<number> {
  let written = 0;
  for (const v of first.values()) {
    const r = await store.recordEarliest({
      guildId,
      memberId: v.memberId,
      eventType: 'first_message',
      occurredAt: v.at,
      source: `channel:${v.channelId}`,
      metadata: { backfill: 'message_scan' },
    });
    if (r.inserted) written++;
  }
  for (const [memberId, at] of lastActive) await store.touchActivity(guildId, memberId, at);
  return written;
}
