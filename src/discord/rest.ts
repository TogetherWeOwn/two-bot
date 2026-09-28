/**
 * A small REST client for the backfill.
 *
 * The live bot uses discord.js and the gateway. Backfill is a different job:
 * it walks a lot of history, once, and then exits. discord.js is built for a
 * long-lived connection and hides pagination, so for this we talk to the API
 * directly - it is easier to make polite about rate limits and easier to test.
 */
import { log } from '../core/log.ts';

const API = 'https://discord.com/api/v10';

export interface RestOptions {
  token: string;
  /** Override the API host. Used by tests. */
  base?: string;
  /** Minimum gap between requests, ms. Discord allows 50/s globally; we use far less. */
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class DiscordRest {
  private token: string;
  private base: string;
  private minInterval: number;
  private fetchImpl: typeof fetch;
  private lastAt = 0;
  /** Requests made, so the backfill can report its own cost. */
  requests = 0;

  constructor(o: RestOptions) {
    this.token = o.token;
    this.base = o.base ?? API;
    this.minInterval = o.minIntervalMs ?? 110;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async pace(): Promise<void> {
    const wait = this.lastAt + this.minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
  }

  /**
   * GET a path. Returns null for 403/404 - a channel we cannot read is a
   * normal condition in a server this size, not an error worth aborting for.
   * Retries 429 and 5xx.
   */
  async get<T>(path: string, attempt = 0): Promise<T | null> {
    await this.pace();
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { Authorization: `Bot ${this.token}` },
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.get<T>(path, attempt + 1);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1');
      log.debug('rate_limited', { path, retryAfter });
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250));
      return this.get<T>(path, attempt);
    }
    if (res.status === 403 || res.status === 404) {
      log.debug('rest_inaccessible', { path, status: res.status });
      return null;
    }
    if (res.status >= 500) {
      if (attempt >= 4) return null;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.get<T>(path, attempt + 1);
    }
    if (!res.ok) {
      log.error('rest_failed', { path, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  }
}

/** Minimal shapes. We only declare the fields the backfill actually reads. */
export interface RawMember {
  user?: { id: string; bot?: boolean };
  joined_at?: string | null;
  /**
   * Discord's membership-screening flag. true = still behind the rules gate and
   * unable to interact with anything (TOG-76).
   *
   * Present-tense only. Discord reports the CURRENT state and keeps no record
   * of when it changed, so a backfill can learn that somebody got in and never
   * when. Absent on a member object from a guild with screening off.
   */
  pending?: boolean;
  /** Discord role snowflakes. Callers keep only the aggregate or highest rank. */
  roles?: string[];
}
export interface RawInvite {
  code: string;
  uses?: number;
  inviter?: { id: string } | null;
  channel?: { id: string } | null;
}
export interface RawChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
}
export interface RawEmbed {
  title?: string;
  description?: string;
  author?: { name?: string };
  footer?: { text?: string };
  fields?: { name: string; value: string }[];
}
export interface RawMessage {
  id: string;
  timestamp: string;
  content?: string;
  author?: { id: string; bot?: boolean };
  embeds?: RawEmbed[];
}

/** Page a guild's full member list. `joined_at` here is Discord's own record. */
export async function fetchAllMembers(rest: DiscordRest, guildId: string): Promise<RawMember[]> {
  return (await fetchAllMembersStrict(rest, guildId)) ?? [];
}

/**
 * The result of a page-capped member scan.
 *
 * `truncated` is true when the scan stopped at `maxPages` with more roster
 * unread. A truncated scan is NOT a roster: callers must never reduce it to a
 * count, or a large guild silently reports a small number.
 */
export interface MemberScan {
  members: RawMember[];
  truncated: boolean;
}

function validMaxPages(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Shared pagination core. `limit` is a page count; Infinity means no ceiling. */
async function pageMembers(
  rest: DiscordRest,
  guildId: string,
  limit: number,
): Promise<MemberScan | null> {
  const out: RawMember[] = [];
  let after = '0';
  for (let pages = 0; ; pages++) {
    // The ceiling is checked BEFORE the next request, so a capped scan makes
    // at most `limit` member-list requests no matter how large the guild is.
    if (pages >= limit) return { members: out, truncated: true };
    const batch = await rest.get<RawMember[]>(
      `/guilds/${guildId}/members?limit=1000&after=${after}`,
    );
    if (!batch) return null;
    if (batch.length === 0) return { members: out, truncated: false };
    out.push(...batch);
    const last = batch[batch.length - 1]?.user?.id;
    if (!last) return null;
    if (batch.length < 1000) return { members: out, truncated: false };
    after = last;
  }
}

/**
 * Page a guild's full member list with a hard page ceiling (TOG-7206).
 *
 * New callers that page members must use this, not the unbounded
 * `fetchAllMembersStrict` default: an uncapped scan fetches the whole roster
 * as full member JSON once per call, with no upper bound on requests or on
 * per-member objects touched. Returns null on a failed page (strict: a partial
 * roster is never presented as complete); `truncated: true` when the ceiling
 * stopped the scan early, so the caller can refuse the partial result loudly
 * instead of counting it.
 */
export async function fetchAllMembersCapped(
  rest: DiscordRest,
  guildId: string,
  opts: { maxPages: number },
): Promise<MemberScan | null> {
  if (!validMaxPages(opts.maxPages)) {
    throw new Error(
      `fetchAllMembersCapped refuses an unbounded scan: maxPages must be a positive integer, got ${String(opts.maxPages)}.`,
    );
  }
  return pageMembers(rest, guildId, opts.maxPages);
}

/**
 * Page a guild's full member list, preserving a failed page as `null`.
 *
 * Backfill historically treated an inaccessible page as the end of the list.
 * A live count cannot: publishing a partial roster as a real count is the same
 * category of error as publishing 0 on failure. Collectors use this strict path.
 */
export async function fetchAllMembersStrict(
  rest: DiscordRest,
  guildId: string,
): Promise<RawMember[] | null> {
  const scan = await pageMembers(rest, guildId, Number.POSITIVE_INFINITY);
  // `pageMembers` never truncates with an infinite limit, so this is null on
  // failure and the full roster otherwise - exactly the old contract.
  return scan?.members ?? null;
}

export interface ScanResult {
  messages: RawMessage[];
  /** Oldest message timestamp we actually reached, or null if the channel was empty. */
  scannedBackTo: string | null;
  /** True if we stopped because of the page cap rather than running out of history. */
  truncated: boolean;
}

/**
 * Walk a channel's history newest-first.
 *
 * `stopBefore` lets us stop early once we are older than anything we care
 * about. `maxPages` is a hard cost ceiling - when we hit it we say so, because
 * a truncated scan and an exhaustive one mean different things for the numbers.
 */
export async function scanChannel(
  rest: DiscordRest,
  channelId: string,
  opts: { maxPages: number; stopBefore?: string | null },
): Promise<ScanResult> {
  const messages: RawMessage[] = [];
  let before: string | null = null;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= opts.maxPages) {
      truncated = true;
      break;
    }
    const q: string = `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`;
    const batch: RawMessage[] | null = await rest.get<RawMessage[]>(q);
    if (!batch || batch.length === 0) break;
    pages++;
    messages.push(...batch);
    const oldest = batch[batch.length - 1];
    before = oldest.id;
    if (batch.length < 100) break;
    if (opts.stopBefore && oldest.timestamp < opts.stopBefore) break;
  }

  const scannedBackTo = messages.length
    ? messages[messages.length - 1].timestamp
    : null;
  return { messages, scannedBackTo, truncated };
}
