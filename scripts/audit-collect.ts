/**
 * Read-only inventory of the live TWO Discord server.
 *
 *   DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/audit-collect.ts
 *
 * Writes audit/raw/*.json. Nothing else. Run it again in a month and diff the
 * files instead of redoing the audit by hand. The dumps stay on the
 * maintainer machine: audit/raw/ is gitignored (TOG-8963) — commit only the
 * tables `node scripts/audit-report.ts` rebuilds from them.
 *
 * TWO RULES THIS FILE ENFORCES, not by convention but by construction:
 *
 * 1. READ-ONLY. `get()` is the only way this file talks to Discord and it
 *    hardcodes GET. There is no post/patch/delete helper to reach for. Keep it
 *    that way - every server change goes through a proposal the CEO approves.
 *
 * 2. NO MESSAGE CONTENT. `scanChannel` reads a message page and immediately
 *    reduces it to (author id, timestamp, is-bot). The `content` field is never
 *    read, never stored, never logged. Author ids stay in memory to count
 *    distinct humans; only the counts are written to disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { stripUsers } from './audit-scrub.ts';

const TOKEN = process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;
if (!TOKEN || !GUILD) {
  console.error('need DISCORD_TOKEN (or DISCORD_BOT_TOKEN) and DISCORD_GUILD_ID');
  process.exit(2);
}

const API = 'https://discord.com/api/v10';
const OUT = 'audit/raw';

/** Discord snowflakes carry their own creation time. Cheap date filter. */
const DISCORD_EPOCH = 1420070400000;
const snowflakeMs = (id: string) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let requests = 0;

/**
 * The single HTTP door. GET only, retries on 429/5xx, returns null on 403/404
 * so one locked channel does not abort a 130-channel run.
 */
async function get<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    requests++;
    const res = await fetch(`${API}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'two-bot-audit/1.0' },
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 403 || res.status === 404) {
      log(`  skip ${path} -> ${res.status}`);
      return null;
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      log(`  429 on ${path}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  throw new Error(`GET ${path} failed after retries`);
}

const log = (m: string) => process.stdout.write(m + '\n');

// PII scrubbing lives in ./audit-scrub.ts (TOG-7216) so the rule is pinned by
// a unit test instead of hiding inside the collector. See that module for why.

const save = (name: string, data: unknown) => {
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(stripUsers(data), null, 2) + '\n');
  log(`wrote ${OUT}/${name}.json`);
};

// --- types we actually touch -------------------------------------------------

type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = {
  id: string;
  type: number;
  name: string;
  position?: number;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  user_limit?: number;
  bitrate?: number;
  last_message_id?: string | null;
  permission_overwrites?: Overwrite[];
  available_tags?: { id: string; name: string }[];
  total_message_sent?: number;
  message_count?: number;
  thread_metadata?: { archived: boolean; archive_timestamp: string };
};
type Message = { id: string; timestamp: string; author: { id: string; bot?: boolean } };

/** Channel types whose message history we can read over REST. */
const HAS_MESSAGES = new Set([0, 2, 5, 10, 11, 12, 13]); // text, voice, news, threads, stage

type Activity = {
  channel_id: string;
  scanned: boolean;
  skipped_reason: string | null;
  messages_30d: number;
  messages_90d: number;
  human_messages_30d: number;
  human_messages_90d: number;
  bot_messages_90d: number;
  unique_authors_30d: number;
  unique_authors_90d: number;
  unique_human_authors_30d: number;
  unique_human_authors_90d: number;
  last_message_at: string | null;
  days_since_last_message: number | null;
  pages_fetched: number;
  hit_page_cap: boolean;
};

const now = Date.now();
const DAY = 86_400_000;
const cut30 = now - 30 * DAY;
const cut90 = now - 90 * DAY;
/**
 * Server-wide de-duplicated human author ids. Held in memory only, for the
 * length of one run, and reduced to two integers before anything is written.
 * This is the "A" number the reconfiguration proposal is sized from: how many
 * distinct people said anything at all, anywhere, in the window.
 */
const SERVER_HUMANS_30 = new Set<string>();
const SERVER_HUMANS_90 = new Set<string>();

const PAGE_CAP = 40; // 4000 messages in 90d is plenty to call a channel "busy"

/**
 * Walk a channel's history backwards until we pass the 90-day line.
 * Only (author id, timestamp, bot flag) survives this function.
 */
async function scanChannel(ch: Channel): Promise<Activity> {
  const base: Activity = {
    channel_id: ch.id,
    scanned: false,
    skipped_reason: null,
    messages_30d: 0,
    messages_90d: 0,
    human_messages_30d: 0,
    human_messages_90d: 0,
    bot_messages_90d: 0,
    unique_authors_30d: 0,
    unique_authors_90d: 0,
    unique_human_authors_30d: 0,
    unique_human_authors_90d: 0,
    last_message_at: null,
    days_since_last_message: null,
    pages_fetched: 0,
    hit_page_cap: false,
  };

  if (!HAS_MESSAGES.has(ch.type)) {
    return { ...base, skipped_reason: `channel type ${ch.type} has no direct message history` };
  }

  // Fast path: the last_message_id snowflake already tells us the channel has
  // been silent for 90+ days. No need to spend a request on it.
  if (ch.last_message_id) {
    const lastMs = snowflakeMs(ch.last_message_id);
    base.last_message_at = new Date(lastMs).toISOString();
    base.days_since_last_message = Math.floor((now - lastMs) / DAY);
    if (lastMs < cut90) return { ...base, scanned: true };
  } else {
    return { ...base, scanned: true, days_since_last_message: null };
  }

  const authors30 = new Set<string>();
  const authors90 = new Set<string>();
  const humans30 = new Set<string>();
  const humans90 = new Set<string>();
  let before: string | null = null;
  let done = false;

  while (!done && base.pages_fetched < PAGE_CAP) {
    const url: string = `/channels/${ch.id}/messages?limit=100${before ? `&before=${before}` : ''}`;
    const page: Message[] | null = await get<Message[]>(url);
    if (page === null) {
      return { ...base, skipped_reason: 'no read permission for this channel' };
    }
    base.pages_fetched++;
    if (page.length === 0) break;

    for (const m of page) {
      const ts = Date.parse(m.timestamp);
      if (ts < cut90) {
        done = true;
        continue;
      }
      const bot = m.author?.bot === true;
      base.messages_90d++;
      if (bot) base.bot_messages_90d++;
      else base.human_messages_90d++;
      authors90.add(m.author.id);
      if (!bot) {
        humans90.add(m.author.id);
        SERVER_HUMANS_90.add(m.author.id);
      }
      if (ts >= cut30) {
        base.messages_30d++;
        if (!bot) base.human_messages_30d++;
        authors30.add(m.author.id);
        if (!bot) {
          humans30.add(m.author.id);
          SERVER_HUMANS_30.add(m.author.id);
        }
      }
    }
    if (page.length < 100) break;
    const oldest: string = page[page.length - 1].id;
    before = oldest;
    if (snowflakeMs(oldest) < cut90) done = true;
    await sleep(120); // stay well under the per-route limit
  }

  base.hit_page_cap = base.pages_fetched >= PAGE_CAP && !done;
  base.unique_authors_30d = authors30.size;
  base.unique_authors_90d = authors90.size;
  base.unique_human_authors_30d = humans30.size;
  base.unique_human_authors_90d = humans90.size;
  base.scanned = true;
  return base;
}

// --- run ---------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const startedAt = new Date().toISOString();
log(`audit start ${startedAt} guild=${GUILD}`);

const guild = await get<Record<string, unknown>>(`/guilds/${GUILD}?with_counts=true`);
if (!guild) throw new Error('cannot read the guild - is the bot still in the server?');
save('guild', guild);

const channels = (await get<Channel[]>(`/guilds/${GUILD}/channels`)) ?? [];
save('channels', channels);

save('roles', (await get<unknown[]>(`/guilds/${GUILD}/roles`)) ?? []);

// Invites are the top of the funnel: code, uses, inviter, expiry.
save('invites', (await get<unknown[]>(`/guilds/${GUILD}/invites`)) ?? []);
save('vanity_url', (await get<unknown>(`/guilds/${GUILD}/vanity-url`)) ?? null);

// What a brand-new member is actually shown, per Discord's own config.
save('welcome_screen', (await get<unknown>(`/guilds/${GUILD}/welcome-screen`)) ?? null);
save('onboarding', (await get<unknown>(`/guilds/${GUILD}/onboarding`)) ?? null);
save('preview', (await get<unknown>(`/guilds/${GUILD}/preview`)) ?? null);
save('scheduled_events', (await get<unknown[]>(`/guilds/${GUILD}/scheduled-events`)) ?? []);
save('integrations', (await get<unknown[]>(`/guilds/${GUILD}/integrations`)) ?? []);
save('automod_rules', (await get<unknown[]>(`/guilds/${GUILD}/auto-moderation/rules`)) ?? []);

const activeThreads = await get<{ threads: Channel[] }>(`/guilds/${GUILD}/threads/active`);
save('active_threads', activeThreads?.threads ?? []);

// Forum channels hold their traffic in threads, not in the channel itself.
const forums = channels.filter((c) => c.type === 15 || c.type === 16);
const forumThreads: Record<string, unknown> = {};
for (const f of forums) {
  const archived = await get<{ threads: Channel[] }>(
    `/channels/${f.id}/threads/archived/public?limit=100`,
  );
  forumThreads[f.id] = {
    active: (activeThreads?.threads ?? []).filter((t) => t.parent_id === f.id),
    archived: archived?.threads ?? [],
  };
  await sleep(120);
}
save('forum_threads', forumThreads);

// A forum channel holds no messages of its own - its traffic lives in threads.
// Scan the threads that moved in the last 90 days so forum numbers separate
// humans from bots the same way text channels do. Everything older is dead by
// definition and not worth a request.
const liveThreads: Channel[] = [];
for (const bucket of Object.values(forumThreads) as { active: Channel[]; archived: Channel[] }[]) {
  for (const t of [...bucket.active, ...bucket.archived]) {
    const lastMs = snowflakeMs(t.last_message_id ?? t.id);
    if (lastMs >= cut90) liveThreads.push(t);
  }
}
for (const t of activeThreads?.threads ?? []) {
  if (!liveThreads.some((x) => x.id === t.id)) liveThreads.push(t);
}
log(`scanning ${liveThreads.length} threads active in the last 90 days...`);
const threadActivity: (Activity & { parent_id: string; name: string })[] = [];
for (const t of liveThreads) {
  const a = await scanChannel({ ...t, type: 11 });
  threadActivity.push({ ...a, parent_id: t.parent_id ?? '', name: t.name });
  log(`  thread "${t.name}" 90d=${a.messages_90d} human=${a.human_messages_90d}`);
}
save('thread_activity', threadActivity);

// --- member census -----------------------------------------------------------
// The one place this script touches per-member data. It is reduced to counts
// before anything is written: joined-month histogram, role headcounts, and how
// many members are stuck at each gate. No user ids, no names, nothing that
// identifies a person leaves this block.
type Member = { user: { id: string; bot?: boolean }; joined_at: string; roles: string[]; pending?: boolean };
const joinsByMonth: Record<string, number> = {};
const roleHeadcount: Record<string, number> = {};
const pendingRoleHeadcount: Record<string, number> = {};
let humans = 0;
let bots = 0;
let pending = 0;
let noRoles = 0;
let joined30 = 0;
let joined90 = 0;
let after: string = '0';
for (;;) {
  const page = await get<Member[]>(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
  if (!page || page.length === 0) break;
  for (const m of page) {
    if (m.user.bot) {
      bots++;
      continue;
    }
    humans++;
    if (m.pending) pending++;
    if (m.roles.length === 0) noRoles++;
    const t = Date.parse(m.joined_at);
    if (t >= cut30) joined30++;
    if (t >= cut90) joined90++;
    const month = m.joined_at.slice(0, 7);
    joinsByMonth[month] = (joinsByMonth[month] ?? 0) + 1;
    for (const r of m.roles) {
      roleHeadcount[r] = (roleHeadcount[r] ?? 0) + 1;
      if (m.pending) pendingRoleHeadcount[r] = (pendingRoleHeadcount[r] ?? 0) + 1;
    }
  }
  after = page[page.length - 1].user.id;
  if (page.length < 1000) break;
  await sleep(200);
}
save('members', {
  human_members: humans,
  bot_members: bots,
  pending_rules_screening: pending,
  members_with_no_roles: noRoles,
  joined_last_30d: joined30,
  joined_last_90d: joined90,
  joins_by_month: Object.fromEntries(Object.entries(joinsByMonth).sort()),
  role_headcount: roleHeadcount,
  pending_role_headcount: pendingRoleHeadcount,
  note: 'aggregate counts only - no user ids, names, or avatars are written to disk',
});

log(`scanning message history for ${channels.length} channels...`);
const activity: Activity[] = [];
let i = 0;
for (const ch of channels) {
  i++;
  const a = await scanChannel(ch);
  activity.push(a);
  log(
    `  [${i}/${channels.length}] #${ch.name} type=${ch.type} 90d=${a.messages_90d} 30d=${a.messages_30d}` +
      (a.skipped_reason ? ` (${a.skipped_reason})` : ''),
  );
}
save('activity', activity);

// The de-duplicated headline: how many distinct humans said anything at all,
// anywhere in the guild, in each window. Counts only - the id sets never leave
// memory. Threads are scanned separately above and feed the same sets.
save('server_totals', {
  unique_human_authors_30d: SERVER_HUMANS_30.size,
  unique_human_authors_90d: SERVER_HUMANS_90.size,
  note: 'de-duplicated across every channel and thread scanned in this run',
});

save('meta', {
  collected_at: startedAt,
  finished_at: new Date().toISOString(),
  guild_id: GUILD,
  window_30d_start: new Date(cut30).toISOString(),
  window_90d_start: new Date(cut90).toISOString(),
  discord_requests: requests,
  channels_seen: channels.length,
  collector: 'scripts/audit-collect.ts',
  read_only: true,
  message_content_collected: false,
});

log(`done. ${requests} requests.`);
