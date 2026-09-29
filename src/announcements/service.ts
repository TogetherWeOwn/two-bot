import { createHash, randomUUID } from 'node:crypto';
import type {
  AnnouncementsStore,
  FeedHealthRow,
  FeedKind,
  FeedRelayRow,
  LfgPostRow,
  LfgRoleRow,
  RsvpStatus,
} from './store.ts';

const MAX_TITLE_CHARS = 100;
const MAX_LFG_ROLES = 20;
const MAX_FEED_BODY_CHARS = 2000;
// A worker that crashes between the claim insert and markDelivered/release
// must not wedge the item forever: a later poll reclaims `pending` claims
// older than this lease. Mirrors the automations sticky-post 60s lease.
export const DELIVERY_CLAIM_LEASE_MS = 60_000;

export interface AnnouncementDiscord {
  postMessage(channelId: string, content: string, options?: { nonce?: string; components?: unknown[] }): Promise<string>;
  editMessage(channelId: string, messageId: string, content: string, components?: unknown[]): Promise<void>;
  findMessageByNonce?(channelId: string, nonce: string): Promise<string | null>;
  getScheduledEventStatus(guildId: string, eventId: string): Promise<number | null>;
}

export interface FeedItem {
  key: string;
  title: string;
  url: string;
  publishedAt?: string;
}

export interface FeedReader {
  read(feed: FeedRelayRow, signal?: AbortSignal): Promise<FeedItem[]>;
}

export interface LfgRoleInput {
  key: string;
  label: string;
  slots: number;
}

/**
 * Per-feed read deadline for `pollFeeds`, in milliseconds.
 *
 * Each feed read races the reader against this timeout, so one hung feed
 * records a `failed` feed.poll audit and the loop moves on instead of
 * stalling every feed behind it. Must stay at or below 60_000: the feed
 * poller runs on a fixed interval and a longer per-feed deadline would let
 * a slow feed list overrun the next tick.
 */
export const FEED_READ_TIMEOUT_MS = 15_000;
/** Upper bound for any per-feed read deadline. Polls run on a fixed interval. */
export const MAX_FEED_READ_TIMEOUT_MS = 60_000;

/**
 * Consecutive `failed` polls after which a feed counts as stale (TOG-9128).
 *
 * At the default 5-minute poll cadence this is ~15 minutes of continuous
 * failure: long enough to ride out a transient upstream blip, short enough
 * that a dead feed surfaces the same day. When a feed first reaches this
 * count, the poll writes one `feed.stale` audit row (action `feed.stale`,
 * outcome `stale`, reason naming the count and last error) so the operator
 * sees the crossing even when they were not watching the count climb. The
 * count itself resets on the next successful `read N` poll.
 */
export const FEED_STALE_AFTER_FAILURES = 3;

export interface AnnouncementsServiceOptions {
  /**
   * Override for {@link FEED_READ_TIMEOUT_MS}. Defaults to 15 s.
   * Values are clamped to (0, {@link MAX_FEED_READ_TIMEOUT_MS}].
   */
  feedReadTimeoutMs?: number;
}

export class AnnouncementsService {
  private store: AnnouncementsStore;
  private discord: AnnouncementDiscord;
  private feedReader?: FeedReader;
  private feedReadTimeoutMs: number;

  constructor(
    store: AnnouncementsStore,
    discord: AnnouncementDiscord,
    feedReader?: FeedReader,
    options: AnnouncementsServiceOptions = {},
  ) {
    this.store = store;
    this.discord = discord;
    this.feedReader = feedReader;
    const configured = options.feedReadTimeoutMs ?? FEED_READ_TIMEOUT_MS;
    if (!Number.isFinite(configured) || configured <= 0) {
      throw new Error('feedReadTimeoutMs must be a positive number of milliseconds.');
    }
    this.feedReadTimeoutMs = Math.min(configured, MAX_FEED_READ_TIMEOUT_MS);
  }

  async rsvp(input: {
    guildId: string;
    eventId: string;
    userId: string;
    status: RsvpStatus;
    now?: Date;
  }): Promise<RsvpStatus> {
    assertSnowflake(input.eventId, 'event id');
    const eventStatus = await this.discord.getScheduledEventStatus(input.guildId, input.eventId);
    if (eventStatus === null) throw new Error('No scheduled event with that id exists in this server.');
    if (eventStatus === 4) throw new Error('That scheduled event is cancelled.');
    const now = (input.now ?? new Date()).toISOString();
    await this.store.putRsvp({ ...input, respondedAt: now });
    await this.store.audit({
      guildId: input.guildId,
      actorId: input.userId,
      action: 'event.rsvp',
      targetKey: input.eventId,
      outcome: input.status,
    }, now);
    return input.status;
  }

  async attendance(guildId: string, eventId: string): Promise<Record<RsvpStatus, string[]>> {
    assertSnowflake(eventId, 'event id');
    const rows = await this.store.listRsvps(guildId, eventId);
    return {
      going: rows.filter((row) => row.status === 'going').map((row) => row.userId),
      interested: rows.filter((row) => row.status === 'interested').map((row) => row.userId),
      declined: rows.filter((row) => row.status === 'declined').map((row) => row.userId),
    };
  }

  async createLfg(input: {
    id?: string;
    guildId: string;
    channelId: string;
    title: string;
    startsAt: string;
    roles: LfgRoleInput[];
    actorId: string;
    now?: Date;
  }): Promise<LfgPostRow> {
    const title = input.title.trim();
    if (!title || title.length > MAX_TITLE_CHARS) {
      throw new Error(`LFG title must be 1-${MAX_TITLE_CHARS} characters.`);
    }
    const startsAt = normalizeFutureTimestamp(input.startsAt, input.now);
    const roles = normalizeRoles(input.roles);
    const now = (input.now ?? new Date()).toISOString();
    const id = input.id ?? randomUUID();
    const row: LfgPostRow = {
      id,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: null,
      title,
      startsAt,
      status: 'open',
      createdBy: input.actorId,
      createdAt: now,
      closedAt: null,
    };
    const roleRows = roles.map<LfgRoleRow>((role, position) => ({
      lfgId: id,
      roleKey: role.key,
      label: role.label,
      slots: role.slots,
      position,
    }));
    await this.store.putLfg(row, roleRows);
    const rendered = await this.renderLfg(row);
    const nonce = lfgNonce(id);
    let messageId: string;
    try {
      messageId = await this.discord.postMessage(input.channelId, rendered.content, {
        nonce,
        components: rendered.components,
      });
    } catch (error) {
      const recovered = await this.discord.findMessageByNonce?.(input.channelId, nonce).catch(() => null);
      if (!recovered) {
        await this.store.deleteLfg(input.guildId, id);
        throw error;
      }
      messageId = recovered;
    }
    const posted = { ...row, messageId };
    await this.store.putLfg(posted, roleRows, false);
    await this.store.audit({
      guildId: input.guildId,
      actorId: input.actorId,
      action: 'lfg.create',
      targetKey: id,
      outcome: 'created',
    }, now);
    return posted;
  }

  async signupLfg(input: {
    guildId: string;
    id: string;
    roleKey: string;
    userId: string;
    now?: Date;
  }): Promise<'joined' | 'moved' | 'full' | 'closed' | 'missing'> {
    const now = (input.now ?? new Date()).toISOString();
    const outcome = await this.store.signupLfg(
      input.guildId, input.id, input.roleKey, input.userId, now,
    );
    const post = await this.store.getLfg(input.guildId, input.id);
    if (post?.messageId && (outcome === 'joined' || outcome === 'moved')) await this.refreshLfg(post);
    await this.store.audit({
      guildId: input.guildId,
      actorId: input.userId,
      action: 'lfg.signup',
      targetKey: input.id,
      outcome,
      reason: input.roleKey,
    }, now);
    return outcome;
  }

  async leaveLfg(guildId: string, id: string, userId: string, now = new Date()): Promise<boolean> {
    const removed = await this.store.leaveLfg(id, userId);
    const post = await this.store.getLfg(guildId, id);
    if (removed && post?.messageId) await this.refreshLfg(post);
    await this.store.audit({
      guildId, actorId: userId, action: 'lfg.leave', targetKey: id,
      outcome: removed ? 'left' : 'not_joined',
    }, now.toISOString());
    return removed;
  }

  async closeLfg(guildId: string, id: string, actorId: string, now = new Date()): Promise<boolean> {
    const closed = await this.store.closeLfg(guildId, id, now.toISOString());
    const post = await this.store.getLfg(guildId, id);
    if (closed && post?.messageId) await this.refreshLfg(post);
    await this.store.audit({
      guildId, actorId, action: 'lfg.close', targetKey: id,
      outcome: closed ? 'closed' : 'already_closed_or_missing',
    }, now.toISOString());
    return closed;
  }

  async addFeed(input: {
    id?: string;
    guildId: string;
    channelId: string;
    kind: FeedKind;
    source: string;
    actorId: string;
    now?: Date;
  }): Promise<FeedRelayRow> {
    const source = normalizeFeedSource(input.kind, input.source);
    const now = (input.now ?? new Date()).toISOString();
    const row: FeedRelayRow = {
      id: input.id ?? randomUUID(),
      guildId: input.guildId,
      channelId: input.channelId,
      kind: input.kind,
      source,
      enabled: true,
      lastCheckedAt: null,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putFeed(row);
    await this.store.audit({
      guildId: input.guildId, actorId: input.actorId, action: 'feed.create',
      targetKey: row.id, outcome: input.kind,
    }, now);
    return row;
  }

  async removeFeed(guildId: string, id: string, actorId: string, now = new Date()): Promise<boolean> {
    const removed = await this.store.deleteFeed(guildId, id);
    await this.store.audit({
      guildId, actorId, action: 'feed.remove', targetKey: id,
      outcome: removed ? 'removed' : 'missing',
    }, now.toISOString());
    return removed;
  }

  async pollFeeds(guildId: string, now = new Date()): Promise<number> {
    if (!this.feedReader) throw new Error('Feed reader is not configured.');
    let delivered = 0;
    for (const feed of await this.store.listEnabledFeeds(guildId)) {
      try {
        const items = await this.readFeedWithTimeout(feed);
        // Per-item isolation (TOG-9346): one bad item must not abort the
        // batch. Each item is attempted inside its own try/catch — a keyless
        // item audits `feed.item/skipped`, a post failure releases the claim
        // and audits `feed.item/failed` — and the loop continues with the
        // rest, so `markFeedChecked` below still runs.
        for (const item of items.slice(0, 20).reverse()) {
          let itemKey: string;
          try {
            itemKey = normalizeItemKey(item);
          } catch (error) {
            await this.store.audit({
              guildId, actorId: null, action: 'feed.item', targetKey: feed.id,
              outcome: 'skipped',
              reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            }, now.toISOString());
            continue;
          }
          try {
            const nonce = deliveryNonce(feed.id, itemKey);
            const claimToken = randomUUID();
            const expiredClaimCutoff = new Date(now.getTime() - DELIVERY_CLAIM_LEASE_MS).toISOString();
            const claim = await this.store.claimDelivery({
              feedId: feed.id,
              itemKey,
              nonce,
              state: 'pending',
              messageId: null,
              firstSeenAt: now.toISOString(),
              deliveredAt: null,
              claimToken,
              claimedAt: now.toISOString(),
            }, expiredClaimCutoff);
            if (!claim) continue;
            const content = formatFeedMessage(feed.kind, item);
            try {
              const messageId = await this.discord.postMessage(feed.channelId, content, { nonce });
              if (await this.store.markDelivered(feed.id, itemKey, claimToken, messageId, now.toISOString())) delivered++;
            } catch (error) {
              await this.store.releaseDelivery(feed.id, itemKey, claimToken);
              throw error;
            }
          } catch (error) {
            await this.store.audit({
              guildId, actorId: null, action: 'feed.item', targetKey: feed.id,
              outcome: 'failed',
              reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            }, now.toISOString());
          }
        }
        await this.store.markFeedChecked(feed.id, now.toISOString());
        await this.store.audit({
          guildId, actorId: null, action: 'feed.poll', targetKey: feed.id,
          outcome: `read ${items.length}`,
        }, now.toISOString());
      } catch (error) {
        const atIso = now.toISOString();
        const reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        await this.store.audit({
          guildId, actorId: null, action: 'feed.poll', targetKey: feed.id,
          outcome: 'failed', reason,
        }, atIso);
        await this.maybeMarkFeedStale(guildId, feed, reason, atIso);
      }
    }
    return delivered;
  }

  /**
   * Per-feed consecutive-failure counts with last-poll detail (TOG-9128).
   * Derived from `feed.poll` audit rows — no schema change. Rows whose
   * `consecutiveFailures` reached {@link FEED_STALE_AFTER_FAILURES} are the
   * feeds the operator should check first.
   */
  feedHealth(guildId: string): Promise<FeedHealthRow[]> {
    return this.store.feedHealth(guildId);
  }

  /**
   * Emit one `feed.stale` audit row when a feed first reaches the staleness
   * threshold (TOG-9128). The just-written `failed` poll is the newest row,
   * so a trailing run of exactly the threshold means this failure is the
   * crossing. Longer runs (a later poll in the same streak) and shorter runs
   * write nothing — the single crossing row per streak stays greppable, and
   * a success between streaks lets the next streak emit again.
   */
  private async maybeMarkFeedStale(
    guildId: string, feed: FeedRelayRow, reason: string, atIso: string,
  ): Promise<void> {
    const history = await this.store.listFeedPollHistory(feed.id, FEED_STALE_AFTER_FAILURES + 1);
    let run = 0;
    for (const sample of history) {
      if (sample.outcome !== 'failed') break;
      run++;
    }
    if (run !== FEED_STALE_AFTER_FAILURES) return;
    await this.store.audit({
      guildId, actorId: null, action: 'feed.stale', targetKey: feed.id,
      outcome: 'stale',
      reason: `failed ${FEED_STALE_AFTER_FAILURES} consecutive polls (source ${feed.source}): ${reason}`.slice(0, 500),
    }, atIso);
  }

  private async readFeedWithTimeout(feed: FeedRelayRow): Promise<FeedItem[]> {
    const reader = this.feedReader;
    if (!reader) throw new Error('Feed reader is not configured.');
    const timeoutMs = this.feedReadTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const pending = reader.read(feed, signal);
    // Suppress a late rejection after the timeout wins the race below.
    pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Feed read timed out after ${timeoutMs}ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async refreshLfg(post: LfgPostRow): Promise<void> {
    if (!post.messageId) return;
    const rendered = await this.renderLfg(post);
    await this.discord.editMessage(post.channelId, post.messageId, rendered.content, rendered.components);
  }

  private async renderLfg(post: LfgPostRow): Promise<{ content: string; components: unknown[] }> {
    const roles = await this.store.listLfgRoles(post.id);
    const signups = await this.store.listLfgSignups(post.id);
    const lines = roles.map((role) => {
      const members = signups.filter((signup) => signup.roleKey === role.roleKey).map((signup) => `<@${signup.userId}>`);
      return `**${role.label}** ${members.length}/${role.slots}${members.length ? ` — ${members.join(', ')}` : ''}`;
    });
    const state = post.status === 'open' ? 'Open' : 'Closed';
    const content = `**${post.title}** — ${state}\nStarts <t:${Math.floor(Date.parse(post.startsAt) / 1000)}:F>\n${lines.join('\n')}`;
    const components = post.status === 'open'
      ? [{
          type: 1,
          components: [{
            type: 3,
            custom_id: `two:lfg:${post.id}`,
            placeholder: 'Choose a role or leave',
            min_values: 1,
            max_values: 1,
            options: [
              ...roles.map((role) => ({
                label: `${role.label} (${signups.filter((s) => s.roleKey === role.roleKey).length}/${role.slots})`.slice(0, 100),
                value: role.roleKey,
              })),
              { label: 'Leave this group', value: '__leave__' },
            ],
          }],
        }]
      : [];
    return { content: content.slice(0, 2000), components };
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${label} must be a Discord id.`);
}

function normalizeFutureTimestamp(value: string, now = new Date()): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('starts-at must be an ISO-8601 timestamp.');
  if (ms <= now.getTime()) throw new Error('starts-at must be in the future.');
  return new Date(ms).toISOString();
}

function normalizeRoles(roles: LfgRoleInput[]): LfgRoleInput[] {
  if (roles.length < 1 || roles.length > MAX_LFG_ROLES) {
    throw new Error(`LFG needs 1-${MAX_LFG_ROLES} roles.`);
  }
  const seen = new Set<string>();
  return roles.map((role) => {
    const key = role.key.trim().toLowerCase();
    const label = role.label.trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) throw new Error(`Invalid LFG role key "${role.key}".`);
    if (!label || label.length > 80) throw new Error('LFG role labels must be 1-80 characters.');
    if (!Number.isInteger(role.slots) || role.slots < 1 || role.slots > 99) {
      throw new Error('LFG role slots must be integers from 1-99.');
    }
    if (seen.has(key)) throw new Error(`Duplicate LFG role key "${key}".`);
    seen.add(key);
    return { key, label, slots: role.slots };
  });
}

export function parseRoleSpec(spec: string): LfgRoleInput[] {
  return normalizeRoles(spec.split(',').map((part) => {
    const fields = part.trim().split(':');
    if (fields.length !== 3) throw new Error('roles must be key:label:slots entries separated by commas.');
    return { key: fields[0] ?? '', label: fields[1] ?? '', slots: Number(fields[2]) };
  }));
}

export function normalizeFeedSource(kind: FeedKind, source: string): string {
  const trimmed = source.trim();
  if (kind === 'youtube' && /^[A-Za-z0-9_-]{20,32}$/.test(trimmed)) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${trimmed}`;
  }
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Feed source must be an HTTPS URL without embedded credentials.');
  }
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname)) {
    throw new Error('Feed source cannot target a loopback host.');
  }
  return url.toString();
}

function normalizeItemKey(item: FeedItem): string {
  const key = item.key.trim() || item.url.trim();
  if (!key) throw new Error('Feed item has no stable key.');
  return createHash('sha256').update(key).digest('hex');
}

function deliveryNonce(feedId: string, itemKey: string): string {
  return createHash('sha256').update(`${feedId}\0${itemKey}`).digest('hex').slice(0, 24);
}

function lfgNonce(id: string): string {
  return createHash('sha256').update(`lfg\0${id}`).digest('hex').slice(0, 24);
}

function formatFeedMessage(kind: FeedKind, item: FeedItem): string {
  const prefix = kind === 'youtube' ? 'New YouTube upload' : kind === 'twitch' ? 'Twitch update' : 'New feed item';
  const title = item.title.trim() || 'Untitled';
  return `${prefix}: **${title}**\n${item.url}`.slice(0, MAX_FEED_BODY_CHARS);
}
