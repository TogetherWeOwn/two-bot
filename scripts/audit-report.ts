/**
 * Turn audit/raw/*.json into the tables a human reads.
 *
 *   node scripts/audit-report.ts
 *
 * Writes audit/channels.csv, audit/roles.csv, audit/invites.csv,
 * audit/summary.json, and prints the new-member walkthrough to stdout.
 *
 * Pure function of the raw dump - it never calls Discord. Re-run it after
 * changing the rubric without re-scanning 130 channels.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RAW = 'audit/raw';
const OUT = 'audit';
const read = <T>(n: string): T => JSON.parse(readFileSync(`${RAW}/${n}.json`, 'utf8')) as T;

const DISCORD_EPOCH = 1420070400000;
const snowflakeMs = (id: string) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
const DAY = 86_400_000;

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const BAN_MEMBERS = 1n << 2n;
const KICK_MEMBERS = 1n << 1n;
const MANAGE_ROLES = 1n << 28n;
const MANAGE_CHANNELS = 1n << 4n;
const MENTION_EVERYONE = 1n << 17n;

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
  last_message_id?: string | null;
  permission_overwrites?: Overwrite[];
};
type Role = {
  id: string;
  name: string;
  position: number;
  permissions: string;
  hoist: boolean;
  managed: boolean;
  color: number;
  mentionable: boolean;
  tags?: Record<string, unknown>;
};
type Activity = {
  channel_id: string;
  scanned: boolean;
  skipped_reason: string | null;
  messages_30d: number;
  messages_90d: number;
  human_messages_30d: number;
  human_messages_90d: number;
  bot_messages_90d: number;
  unique_authors_90d: number;
  unique_human_authors_90d: number;
  last_message_at: string | null;
  days_since_last_message: number | null;
  hit_page_cap: boolean;
};
type Thread = {
  id: string;
  parent_id: string;
  message_count?: number;
  total_message_sent?: number;
  last_message_id?: string | null;
};

const guild = read<Record<string, any>>('guild');
const channels = read<Channel[]>('channels');
const roles = read<Role[]>('roles');
const invites = read<any[]>('invites');
const activity = read<Activity[]>('activity');
const forumThreads = read<Record<string, { active: Thread[]; archived: Thread[] }>>('forum_threads');
const threadActivity = read<(Activity & { parent_id: string; name: string })[]>('thread_activity');
const onboarding = read<any>('onboarding');
const members = read<any>('members');
const welcome = read<any>('welcome_screen');
const meta = read<any>('meta');

const now = Date.parse(meta.collected_at);
const cut30 = now - 30 * DAY;
const cut90 = now - 90 * DAY;

const byId = new Map(channels.map((c) => [c.id, c]));
const act = new Map(activity.map((a) => [a.channel_id, a]));
const everyoneRole = roles.find((r) => r.id === guild.id)!;

const TYPE_NAME: Record<number, string> = {
  0: 'text',
  2: 'voice',
  4: 'category',
  5: 'announcement',
  13: 'stage',
  15: 'forum',
  16: 'media',
};

// --- what @everyone can see -------------------------------------------------
// Discord resolves channel permissions from the channel's own overwrites.
// A category only matters because "sync" physically copies its overwrites down,
// so the channel row we already have is authoritative.
function everyoneCanView(ch: Channel): boolean {
  const base = BigInt(everyoneRole.permissions);
  if (base & ADMINISTRATOR) return true;
  let view = (base & VIEW_CHANNEL) !== 0n;
  const ow = (ch.permission_overwrites ?? []).find((o) => o.id === guild.id && o.type === 0);
  if (ow) {
    if (BigInt(ow.deny) & VIEW_CHANNEL) view = false;
    if (BigInt(ow.allow) & VIEW_CHANNEL) view = true;
  }
  return view;
}

/** Roles other than @everyone that are explicitly granted view on this channel. */
function grantedRoles(ch: Channel): string[] {
  return (ch.permission_overwrites ?? [])
    .filter((o) => o.type === 0 && o.id !== guild.id && BigInt(o.allow) & VIEW_CHANNEL)
    .map((o) => roles.find((r) => r.id === o.id)?.name ?? o.id);
}

// --- forum activity, rolled up from its threads ------------------------------
// Forums keep no messages of their own. Threads that moved in the last 90 days
// were scanned message-by-message, so their human/bot split is real, not a
// guess; older threads only contribute their last-activity date.
type ForumStats = {
  msgs90: number;
  msgs30: number;
  human90: number;
  human30: number;
  bot90: number;
  humans90: number;
  threads90: number;
  lastMs: number | null;
};
function forumStats(id: string): ForumStats {
  const s: ForumStats = {
    msgs90: 0,
    msgs30: 0,
    human90: 0,
    human30: 0,
    bot90: 0,
    humans90: 0,
    threads90: 0,
    lastMs: null,
  };
  const bucket = forumThreads[id];
  for (const t of [...(bucket?.active ?? []), ...(bucket?.archived ?? [])]) {
    const ms = snowflakeMs(t.last_message_id ?? t.id);
    if (s.lastMs === null || ms > s.lastMs) s.lastMs = ms;
  }
  for (const t of threadActivity.filter((x) => x.parent_id === id)) {
    if (t.messages_90d === 0) continue;
    s.threads90++;
    s.msgs90 += t.messages_90d;
    s.msgs30 += t.messages_30d;
    s.human90 += t.human_messages_90d;
    s.human30 += t.human_messages_30d;
    s.bot90 += t.bot_messages_90d;
    // Upper bound: the same person posting in two threads counts twice. Good
    // enough to separate "one person talking" from "a room full of people".
    s.humans90 += t.unique_human_authors_90d;
  }
  return s;
}

// --- rubric ------------------------------------------------------------------
//
// One verdict per channel, first matching rule wins. The justifying number is
// recorded next to it so nobody has to take the verdict on faith.
//
//   gate-behind-role  visible to @everyone, but zero human traffic and it is a
//                     bot log / staff / ops room. It is sidebar noise for a new
//                     member and should sit behind a role.
//   archive           nothing at all in 90 days.
//   merge             1-9 human messages in 90 days. Real but too thin to hold
//                     its own room; fold into a sibling.
//   rewrite-topic     healthy traffic, visible to everyone, but no topic set -
//                     a newcomer cannot tell what it is for.
//   keep              everything else.
//
// PROTECTED never gets archived regardless of traffic: Discord itself points
// new members at these, so deleting them breaks the server's own config.
const PROTECTED = new Set<string>(
  [
    guild.rules_channel_id,
    guild.public_updates_channel_id,
    guild.safety_alerts_channel_id,
    guild.afk_channel_id,
    ...(welcome?.welcome_channels ?? []).map((w: any) => w.channel_id),
    ...(onboarding?.default_channel_ids ?? []),
  ].filter(Boolean) as string[],
);

const OPS_PATTERN =
  /log|audit|mod-|modmail|moderator|admin|staff|wick|ticket|verify|network-status|lfc_role_proof|stream_program|pisnrzrs|microuxys|toxxicpeaches|ghostlyog|segunpeace|bawrzy|monkers/i;

type Row = {
  channel_id: string;
  name: string;
  type: string;
  category: string;
  position: number;
  visible_to_everyone: boolean;
  gated_roles: number;
  has_topic: boolean;
  slowmode_s: number;
  nsfw: boolean;
  msgs_90d: number;
  msgs_30d: number;
  human_msgs_90d: number;
  human_msgs_30d: number;
  bot_msgs_90d: number;
  unique_humans_90d: number;
  last_message_at: string;
  days_silent: string;
  verdict: string;
  justification: string;
};

/** Roles a member could pick up from the Server Guide, if it were switched on. */
const onboardingRoleIds = new Set<string>(
  (onboarding?.prompts ?? []).flatMap((p: any) =>
    (p.options ?? []).flatMap((o: any) => (o.role_ids ?? []) as string[]),
  ),
);

const rows: Row[] = [];
for (const ch of channels) {
  if (ch.type === 4) continue; // categories get their own table
  const a = act.get(ch.id);
  const isForum = ch.type === 15 || ch.type === 16;
  const f = isForum ? forumStats(ch.id) : null;

  const msgs90 = f ? f.msgs90 : (a?.messages_90d ?? 0);
  const msgs30 = f ? f.msgs30 : (a?.messages_30d ?? 0);
  const human90 = f ? f.human90 : (a?.human_messages_90d ?? 0);
  const human30 = f ? f.human30 : (a?.human_messages_30d ?? 0);
  const bot90 = f ? f.bot90 : (a?.bot_messages_90d ?? 0);
  const humans = f ? f.humans90 : (a?.unique_human_authors_90d ?? 0);
  const lastMs = f
    ? f.lastMs
    : a?.last_message_at
      ? Date.parse(a.last_message_at)
      : ch.last_message_id
        ? snowflakeMs(ch.last_message_id)
        : null;
  const silent = lastMs === null ? null : Math.floor((now - lastMs) / DAY);

  const visible = everyoneCanView(ch);
  const ops = OPS_PATTERN.test(ch.name);
  const topic = (ch.topic ?? '').trim().length > 0;
  const protectedCh = PROTECTED.has(ch.id);

  let verdict: string;
  let why: string;
  const readable = ch.type === 0 || ch.type === 5 || ch.type === 15 || ch.type === 16;
  if (visible && human90 === 0 && (ops || bot90 > 0) && !protectedCh) {
    verdict = 'gate-behind-role';
    why = `in @everyone's sidebar but 0 human messages/90d (${bot90} bot messages) - noise for a newcomer`;
  } else if (msgs90 === 0 && !protectedCh) {
    verdict = 'archive';
    why = silent === null ? 'never had a message' : `0 messages/90d, silent ${silent}d`;
  } else if (visible && readable && !topic && (protectedCh || human90 >= 10)) {
    verdict = 'rewrite-topic';
    why =
      `kept and in the newcomer's sidebar, but no channel topic is set` +
      ` (${human90} human messages/90d) - nothing tells a newcomer what it is for`;
  } else if (msgs90 === 0 && protectedCh) {
    verdict = 'keep';
    why = `0 messages/90d, but Discord's own config points new members here`;
  } else if (human90 === 0 && bot90 > 0) {
    verdict = 'keep';
    why = `bot-only feed: ${bot90} bot messages/90d, already hidden from @everyone`;
  } else if (human90 >= 1 && human90 <= 9) {
    verdict = 'merge';
    why = `only ${human90} human messages/90d from ${humans} people`;
  } else if (visible && !topic) {
    verdict = 'rewrite-topic';
    why = `${human90} human messages/90d but no channel topic - a newcomer cannot tell what it is for`;
  } else {
    verdict = 'keep';
    why = `${human90} human messages/90d (${human30} in 30d) from ${humans} people`;
  }

  rows.push({
    channel_id: ch.id,
    name: ch.name,
    type: TYPE_NAME[ch.type] ?? String(ch.type),
    category: ch.parent_id ? (byId.get(ch.parent_id)?.name ?? '') : '(no category)',
    position: ch.position ?? 0,
    visible_to_everyone: visible,
    gated_roles: grantedRoles(ch).length,
    has_topic: topic,
    slowmode_s: ch.rate_limit_per_user ?? 0,
    nsfw: ch.nsfw === true,
    msgs_90d: msgs90,
    msgs_30d: msgs30,
    human_msgs_90d: human90,
    human_msgs_30d: human30,
    bot_msgs_90d: bot90,
    unique_humans_90d: humans,
    last_message_at: lastMs ? new Date(lastMs).toISOString().slice(0, 10) : '',
    days_silent: silent === null ? '' : String(silent),
    verdict,
    justification: why,
  });
}

// --- csv ---------------------------------------------------------------------
const csv = (recs: Record<string, unknown>[]) => {
  if (recs.length === 0) return '\n';
  const cols = Object.keys(recs[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...recs.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/channels.csv`, csv(rows as unknown as Record<string, unknown>[]));

const categoryRows = channels
  .filter((c) => c.type === 4)
  .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  .map((cat) => {
    const kids = rows.filter((r) => r.category === cat.name);
    return {
      category_id: cat.id,
      name: cat.name,
      position: cat.position ?? 0,
      channels: kids.length,
      visible_to_everyone: kids.filter((k) => k.visible_to_everyone).length,
      human_msgs_90d: kids.reduce((n, k) => n + k.human_msgs_90d, 0),
      human_msgs_30d: kids.reduce((n, k) => n + k.human_msgs_30d, 0),
      bot_msgs_90d: kids.reduce((n, k) => n + k.bot_msgs_90d, 0),
      channels_to_archive: kids.filter((k) => k.verdict === 'archive').length,
    };
  });
writeFileSync(`${OUT}/categories.csv`, csv(categoryRows));

const roleRows = roles
  .slice()
  .sort((a, b) => b.position - a.position)
  .map((r) => {
    const p = BigInt(r.permissions);
    const priv =
      (p & ADMINISTRATOR) !== 0n
        ? 'administrator'
        : p & (MANAGE_GUILD | MANAGE_ROLES | MANAGE_CHANNELS | BAN_MEMBERS | KICK_MEMBERS)
          ? 'moderation'
          : (p & MENTION_EVERYONE) !== 0n
            ? 'mention-everyone'
            : p === 0n
              ? 'cosmetic (no permissions)'
              : 'basic';
    return {
      role_id: r.id,
      name: r.name,
      position: r.position,
      hoisted: r.hoist,
      mentionable: r.mentionable,
      managed_by_integration: r.managed,
      colored: r.color !== 0,
      permission_class: priv,
      permissions: r.permissions,
      granted_by_onboarding: onboardingRoleIds.has(r.id),
      // Roles padded with invisible characters (braille blank, hangul
      // filler, zero-width space) are decorative headers for the member
      // list. They grant nothing; they exist to draw a line.
      separator_header: /[\u2800\u3164\u200b\u00a0]{3,}/.test(r.name),
      members_holding: members.role_headcount?.[r.id] ?? 0,
    };
  });

writeFileSync(`${OUT}/roles.csv`, csv(roleRows));

const inviteRows = invites
  .slice()
  .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))
  .map((i) => ({
    code: i.code,
    uses: i.uses ?? 0,
    landing_channel: i.channel?.name ?? '',
    landing_channel_id: i.channel?.id ?? '',
    inviter_id: i.inviter?.id ?? '',
    created_at: (i.created_at ?? '').slice(0, 10),
    expires_in_days: i.max_age ? Math.round(i.max_age / 86400) : 'never',
    max_uses: i.max_uses || 'unlimited',
    temporary_membership: i.temporary === true,
  }));
writeFileSync(`${OUT}/invites.csv`, csv(inviteRows));

// --- summary -----------------------------------------------------------------
const count = (v: string) => rows.filter((r) => r.verdict === v).length;
const visibleRows = rows.filter((r) => r.visible_to_everyone);
const summary = {
  collected_at: meta.collected_at,
  guild: {
    id: guild.id,
    name: guild.name,
    members: guild.approximate_member_count,
    online: guild.approximate_presence_count,
    verification_level: guild.verification_level,
    boost_tier: guild.premium_tier,
    boosts: guild.premium_subscription_count,
    vanity_url: read<any>('vanity_url'),
    rules_channel: byId.get(guild.rules_channel_id)?.name ?? null,
    system_channel: guild.system_channel_id ? byId.get(guild.system_channel_id)?.name : null,
    onboarding_enabled: onboarding?.enabled === true,
    onboarding_prompts: (onboarding?.prompts ?? []).length,
    welcome_screen_channels: (welcome?.welcome_channels ?? []).length,
  },
  counts: {
    categories: channels.filter((c) => c.type === 4).length,
    channels_total: rows.length,
    channels_visible_to_everyone: visibleRows.length,
    roles_total: roles.length,
    roles_cosmetic: roleRows.filter((r) => r.permission_class === 'cosmetic (no permissions)').length,
    roles_separator_header: roleRows.filter((r) => r.separator_header).length,
    roles_nobody_holds: roleRows.filter((r) => r.members_holding === 0 && !r.managed_by_integration).length,
    roles_managed_by_bots: roleRows.filter((r) => r.managed_by_integration).length,
    invites_total: invites.length,
    invites_never_used: invites.filter((i) => (i.uses ?? 0) === 0).length,
    bot_integrations: read<any[]>('integrations').length,
  },
  members: {
    human_members: members.human_members,
    bot_members: members.bot_members,
    stuck_at_rules_screening: members.pending_rules_screening,
    joined_last_30d: members.joined_last_30d,
    joined_last_90d: members.joined_last_90d,
    // Dense series - the empty months are the point.
    joins_by_month_last_12: Object.fromEntries(
      Array.from({ length: 12 }, (_, k) => {
        const d = new Date(now);
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - (11 - k));
        const m = d.toISOString().slice(0, 7);
        return [m, members.joins_by_month[m] ?? 0];
      }),
    ),
  },
  activity: {
    channels_with_any_human_message_90d: rows.filter((r) => r.human_msgs_90d > 0).length,
    channels_with_any_human_message_30d: rows.filter((r) => r.human_msgs_30d > 0).length,
    total_human_messages_90d: rows.reduce((n, r) => n + r.human_msgs_90d, 0),
    total_human_messages_30d: rows.reduce((n, r) => n + r.human_msgs_30d, 0),
    total_bot_messages_90d: rows.reduce((n, r) => n + r.bot_msgs_90d, 0),
  },
  verdicts: {
    keep: count('keep'),
    merge: count('merge'),
    archive: count('archive'),
    'rewrite-topic': count('rewrite-topic'),
    'gate-behind-role': count('gate-behind-role'),
  },
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2) + '\n');

// --- new member walkthrough --------------------------------------------------
// Sidebar order: categories by position, channels inside by (text before voice,
// then position). Uncategorised channels sort above every category.
const cats = channels.filter((c) => c.type === 4).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
const sortCh = (a: Channel, b: Channel) => {
  const grp = (c: Channel) => (c.type === 2 || c.type === 13 ? 1 : 0);
  return grp(a) - grp(b) || (a.position ?? 0) - (b.position ?? 0);
};

let walk = '';
const line = (s: string) => (walk += s + '\n');
const visibleIn = (parent: string | null) =>
  channels
    .filter((c) => c.type !== 4 && (c.parent_id ?? null) === parent && everyoneCanView(c))
    .sort(sortCh);

line(`# What a brand-new member sees, in order`);
line('');
line(`1. Invite link -> membership screening (verification level ${guild.verification_level}, ` +
  `${guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED') ? 'rules screening ON' : 'rules screening OFF'}). ` +
  `Until they tick the box they can read but not post. ` +
  `${members.pending_rules_screening} of ${members.human_members} members are still stuck here.`);
line(`2. Server Guide / onboarding: **${onboarding?.enabled ? 'ENABLED' : 'DISABLED'}** ` +
  `(${(onboarding?.prompts ?? []).length} prompts configured, ` +
  `${onboardingRoleIds.size} roles it would hand out).`);
line(`3. Welcome screen lands them in: ` +
  ((welcome?.welcome_channels ?? []).map((w: any) => `#${byId.get(w.channel_id)?.name ?? w.channel_id}`).join(', ') || 'nothing'));
line(`4. Sidebar they can actually read (${visibleRows.length} of ${rows.length} channels):`);
line('');
const orphan = visibleIn(null);
if (orphan.length) {
  line(`(no category)`);
  for (const c of orphan) line(`   ${TYPE_NAME[c.type] === 'voice' ? '🔊' : '#'}${c.name}`);
}
for (const cat of cats) {
  const kids = visibleIn(cat.id);
  if (kids.length === 0) continue;
  line(`${cat.name}`);
  for (const c of kids) {
    const r = rows.find((x) => x.channel_id === c.id)!;
    line(
      `   ${TYPE_NAME[c.type] === 'voice' ? '🔊' : '#'}${c.name}` +
        `  [${r.human_msgs_90d} human msgs/90d${r.has_topic ? '' : ', no topic'}]`,
    );
  }
}
writeFileSync(`${OUT}/new-member-walkthrough.txt`, walk);
process.stdout.write(walk);
process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');
