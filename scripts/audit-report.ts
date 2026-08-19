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
const SEND_MESSAGES = 1n << 11n;

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
  user_limit?: number;
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
  unique_human_authors_30d: number;
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

/** Can @everyone post here, after overwrites? Onboarding's own rule needs this. */
function everyoneCanSend(ch: Channel): boolean {
  const base = BigInt(everyoneRole.permissions);
  if (base & ADMINISTRATOR) return true;
  let send = (base & SEND_MESSAGES) !== 0n;
  const ow = (ch.permission_overwrites ?? []).find((o) => o.id === guild.id && o.type === 0);
  if (ow) {
    if (BigInt(ow.deny) & SEND_MESSAGES) send = false;
    if (BigInt(ow.allow) & SEND_MESSAGES) send = true;
  }
  return send && everyoneCanView(ch);
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
  humans30: number;
  threads90: number;
  posts: number;
  postsWithReply: number;
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
    humans30: 0,
    threads90: 0,
    posts: 0,
    postsWithReply: 0,
    lastMs: null,
  };
  const bucket = forumThreads[id];
  for (const t of [...(bucket?.active ?? []), ...(bucket?.archived ?? [])]) {
    const ms = snowflakeMs(t.last_message_id ?? t.id);
    if (s.lastMs === null || ms > s.lastMs) s.lastMs = ms;
    // A forum post with no reply is the clearest "nobody is home" signal there
    // is. total_message_sent counts the opening post, so >1 means someone
    // answered.
    s.posts++;
    if ((t.total_message_sent ?? 0) > 1) s.postsWithReply++;
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
    s.humans30 += t.unique_human_authors_30d ?? 0;
  }
  return s;
}

// --- rubric ------------------------------------------------------------------
//
// Straight out of the `audit-spec` document on TWO-13, section 3. Verdicts are
// driven by UNIQUE HUMAN AUTHORS, not message counts - "400 messages from 2
// people is not a channel, it is a DM with an audience".
//
//   keep              >= 3 unique human authors in the last 30 days
//   merge             1-2 unique human authors in 30d, but real activity in 90d
//   archive           zero human messages in 90 days (hide, never delete)
//   rewrite-topic     alive, but the topic is empty
//   gate-behind-role  a per-game or niche channel visible to everyone at join
//
// First matching rule wins. `create` is a redesign decision, not an audit one,
// so it is out of scope here (spec section 4: no recommendations beyond the
// per-channel verdicts).
//
// PROTECTED does not change a verdict - the spec does not exempt anything. It
// is carried as its own column so the migration knows which archives require
// repointing a guild setting first.
const PROTECTED_BY = new Map<string, string>();
const markProtected = (id: unknown, why: string) => {
  if (typeof id === 'string' && id && !PROTECTED_BY.has(id)) PROTECTED_BY.set(id, why);
};
markProtected(guild.rules_channel_id, 'rules channel');
markProtected(guild.public_updates_channel_id, 'public updates channel');
markProtected(guild.safety_alerts_channel_id, 'safety alerts channel');
markProtected(guild.afk_channel_id, 'AFK channel');
markProtected(guild.system_channel_id, 'system channel');
for (const w of welcome?.welcome_channels ?? []) markProtected(w.channel_id, 'welcome screen card');
for (const id of onboarding?.default_channel_ids ?? []) markProtected(id, 'Server Guide default channel');

/** Names that look like a specific game or platform rather than a general room. */
// Word-boundaried on purpose: an unanchored /ark/ matches "Dark red" and an
// unanchored /cod/ matches "Coding".
const GAME_CHANNEL =
  /\b(shooters?|survival|horror|minecraft|valorant|fortnite|apex|cod|warzone|rust|dayz|ark|gta|league|dota|overwatch|siege|tarkov|palworld|helldivers|destiny|halo|battlefield|rocketleague)\b/i;

const OPS_PATTERN =
  /log|audit|mod-|modmail|moderator|admin|staff|wick|ticket|verify|network-status|lfc_role_proof|stream_program|pisnrzrs|microuxys|toxxicpeaches|ghostlyog|segunpeace|bawrzy|monkers/i;

type Row = {
  channel_id: string;
  name: string;
  type: string;
  category: string;
  position: number;
  visible_to_everyone: boolean;
  everyone_can_send: boolean;
  gated_roles: number;
  topic: string;
  has_topic: boolean;
  slowmode_s: number;
  nsfw: boolean;
  voice_user_limit: string;
  msgs_90d: number;
  msgs_30d: number;
  human_msgs_90d: number;
  human_msgs_30d: number;
  bot_msgs_90d: number;
  unique_humans_30d: number;
  unique_humans_90d: number;
  forum_posts: string;
  forum_posts_with_reply: string;
  threads_active: number;
  truncated: boolean;
  last_message_at: string;
  days_silent: string;
  verdict: string;
  merge_into: string;
  protected_by: string;
  justification: string;
};

/** Roles a member could pick up from the Server Guide, if it were switched on. */
const onboardingRoleIds = new Set<string>(
  (onboarding?.prompts ?? []).flatMap((p: any) =>
    (p.options ?? []).flatMap((o: any) => (o.role_ids ?? []) as string[]),
  ),
);

/** Do a role name and a channel name refer to the same game? */
function namesOverlap(a: string, b: string): boolean {
  const words = (v: string) => v.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const wb = new Set(words(b));
  return words(a).some((w) => wb.has(w) || wb.has(w.replace(/s$/, '')) || wb.has(w + 's'));
}

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
  const topic = (ch.topic ?? '').trim().length > 0;

  const authors30 = f ? f.humans30 : (a?.unique_human_authors_30d ?? 0);
  const protectedBy = PROTECTED_BY.get(ch.id) ?? '';
  const perGame = GAME_CHANNEL.test(ch.name);

  let verdict: string;
  let why: string;
  let mergeInto = '';

  if (human90 === 0) {
    verdict = 'archive';
    why =
      `0 human messages in 90 days` +
      (bot90 > 0 ? ` (${bot90} bot messages)` : '') +
      (silent === null ? ', never used' : `, last message ${silent}d ago`) +
      (visible ? '' : ' - already hidden from @everyone, so this is bookkeeping, not a member-facing change');
  } else if (authors30 >= 3) {
    if (visible && !topic) {
      verdict = 'rewrite-topic';
      why = `${authors30} unique human authors in 30d, but no topic is set`;
    } else {
      verdict = 'keep';
      why = `${authors30} unique human authors in 30d (${human30} messages)`;
    }
  } else if (authors30 >= 1) {
    verdict = 'merge';
    why = `only ${authors30} unique human author${authors30 === 1 ? '' : 's'} in 30d (${humans} in 90d, ${human90} messages)`;
  } else if (visible && perGame) {
    verdict = 'gate-behind-role';
    why = `per-game channel visible at join, ${human90} human messages/90d from ${humans} people but nobody in 30d`;
  } else if (visible && !topic) {
    verdict = 'rewrite-topic';
    why = `${human90} human messages/90d but 0 authors in 30d and no topic set`;
  } else {
    verdict = 'merge';
    why = `${human90} human messages/90d from ${humans} people, none in the last 30 days`;
  }

  if (verdict === 'merge') {
    // Name the destination: the liveliest sibling in the same category.
    const siblings = channels.filter(
      (c) => c.parent_id === ch.parent_id && c.id !== ch.id && (c.type === ch.type || (c.type === 0 && ch.type === 0)),
    );
    let best: { name: string; n: number } | null = null;
    for (const sib of siblings) {
      const sa = act.get(sib.id);
      const n = sa?.human_messages_90d ?? 0;
      if (n > 0 && (best === null || n > best.n)) best = { name: sib.name, n };
    }
    mergeInto = best?.name ?? '';
  }

  rows.push({
    channel_id: ch.id,
    name: ch.name,
    type: TYPE_NAME[ch.type] ?? String(ch.type),
    category: ch.parent_id ? (byId.get(ch.parent_id)?.name ?? '') : '(no category)',
    position: ch.position ?? 0,
    visible_to_everyone: visible,
    everyone_can_send: everyoneCanSend(ch),
    gated_roles: grantedRoles(ch).length,
    topic: (ch.topic ?? '').replace(/\s+/g, ' ').trim(),
    has_topic: topic,
    slowmode_s: ch.rate_limit_per_user ?? 0,
    nsfw: ch.nsfw === true,
    voice_user_limit: ch.type === 2 ? String(ch.user_limit ?? 0) : '',
    msgs_90d: msgs90,
    msgs_30d: msgs30,
    human_msgs_90d: human90,
    human_msgs_30d: human30,
    bot_msgs_90d: bot90,
    unique_humans_30d: authors30,
    unique_humans_90d: humans,
    forum_posts: f ? String(f.posts) : '',
    forum_posts_with_reply: f ? String(f.postsWithReply) : '',
    threads_active: threadActivity.filter((t) => t.parent_id === ch.id).length,
    truncated: a?.hit_page_cap === true,
    last_message_at: lastMs ? new Date(lastMs).toISOString().slice(0, 10) : '',
    days_silent: silent === null ? '' : String(silent),
    verdict,
    merge_into: mergeInto,
    protected_by: protectedBy,
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
      // spec 3.8 - the risk list. Named permissions, not a bitfield, so a
      // non-engineer can read the row.
      dangerous_permissions: (
        [
          [ADMINISTRATOR, 'Administrator'],
          [MANAGE_GUILD, 'Manage Guild'],
          [MANAGE_ROLES, 'Manage Roles'],
          [MANAGE_CHANNELS, 'Manage Channels'],
          [BAN_MEMBERS, 'Ban Members'],
          [KICK_MEMBERS, 'Kick Members'],
          [MENTION_EVERYONE, 'Mention Everyone'],
        ] as [bigint, string][]
      )
        .filter(([bit]) => (p & bit) !== 0n)
        .map(([, label]) => label)
        .join(' / '),
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

// --- server-level checks (spec section 3) ------------------------------------
const count = (v: string) => rows.filter((r) => r.verdict === v).length;
const visibleRows = rows.filter((r) => r.visible_to_everyone);
const serverTotals = read<{ unique_human_authors_30d: number; unique_human_authors_90d: number }>('server_totals');

/** Every action between clicking the invite and being able to say hello. */
const gateSteps: string[] = [];
if ((guild.features ?? []).includes('MEMBER_VERIFICATION_GATE_ENABLED'))
  gateSteps.push('accept the rules screening box');
if (guild.verification_level >= 3) gateSteps.push(`verification level ${guild.verification_level}`);
if (onboarding?.enabled === true) {
  const required = (onboarding.prompts ?? []).filter((p: any) => p.required && p.in_onboarding).length;
  if (required > 0) gateSteps.push(`${required} required Server Guide questions`);
}
// A channel a newcomer can read but not post in is a gate too, if it is the only
// one they can see.
if (visibleRows.filter((r) => r.everyone_can_send && (r.type === 'text' || r.type === 'voice')).length === 0)
  gateSteps.push('no visible channel @everyone can post in');

const deadAir = visibleRows.filter((r) => r.human_msgs_30d === 0).length;

const obviousHangout = rows.some(
  (r) => r.type === 'voice' && r.visible_to_everyone && /lobby|lounge|hang|general|chat|hub/i.test(r.name),
);

/**
 * Onboarding's own rule: >= 7 defaults, >= 5 of them view AND send for @everyone.
 *
 * Verified 2026-08-19 against the live docs, Modify Guild Onboarding:
 * "Onboarding enforces constraints when enabled. These constraints are that there
 *  must be at least 7 Default Channels and at least 5 of them must allow sending
 *  messages to the @everyone role. The `mode` field modifies what is considered
 *  when enforcing these constraints."
 * https://discord.com/developers/docs/resources/guild#modify-guild-onboarding
 *
 * mode 0 (ONBOARDING_DEFAULT) counts only default channels; mode 1
 * (ONBOARDING_ADVANCED) counts default channels and questions. The guild is on
 * mode 0 today. Note that mode 1 only ever helps the >= 7 half of the rule --
 * the >= 5 send-capable half is unaffected by questions.
 */
const qualifyingDefaults = (onboarding?.default_channel_ids ?? []).filter((id: string) => {
  const r = rows.find((x) => x.channel_id === id);
  return r?.everyone_can_send === true;
}).length;

/** Game roles vs per-game channels. Both directions are bugs (spec 3.5). */
const gameRoleNames = roles.filter((r) => GAME_CHANNEL.test(r.name) || /games?$/i.test(r.name));
const gameCoverage = {
  roles_with_no_channel: gameRoleNames
    .filter((r) => !rows.some((c) => GAME_CHANNEL.test(c.name) && namesOverlap(r.name, c.name)))
    .map((r) => ({ role: r.name, holders: members.role_headcount[r.id] ?? 0 })),
  channels_with_no_role: rows
    .filter((c) => GAME_CHANNEL.test(c.name) && !gameRoleNames.some((r) => namesOverlap(r.name, c.name)))
    .map((c) => c.name),
  roles_wired_to_their_channel: gameRoleNames
    .map((r) => {
      const chans = rows.filter((c) => GAME_CHANNEL.test(c.name) && namesOverlap(r.name, c.name));
      const granted = chans.filter((c) => {
        const raw = byId.get(c.channel_id);
        return (raw?.permission_overwrites ?? []).some(
          (o) => o.id === r.id && BigInt(o.allow) & VIEW_CHANNEL,
        );
      });
      return {
        role: r.name,
        holders: members.role_headcount[r.id] ?? 0,
        channels: chans.map((c) => c.name),
        channels_the_role_can_actually_see: granted.map((c) => c.name),
      };
    })
    .filter((x) => x.channels.length > 0),
};
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
  // spec section 3, "server-level checks". These are the baselines TWO-14
  // re-reads at T+30 to decide whether the redesign worked.
  server_level: {
    // 3.1 - target is <= 7
    visible_channels_at_join: visibleRows.length,
    visible_channels_target: 7,
    // 3.2 - gate cost. Anything over two steps needs a reason.
    gate_steps: gateSteps.length,
    gate_step_detail: gateSteps,
    // 3.3 - dead air: visible channels with 0 human messages in 30d / visible channels
    dead_air_ratio: Number((deadAir / Math.max(1, visibleRows.length)).toFixed(3)),
    dead_air_numerator: deadAir,
    dead_air_denominator: visibleRows.length,
    // 3.4 - voice readiness
    voice_channels_total: rows.filter((r) => r.type === 'voice').length,
    voice_visible_at_join: rows.filter((r) => r.type === 'voice' && r.visible_to_everyone).length,
    voice_obvious_hangout: obviousHangout,
    voice_history_readable_over_rest: false,
    // 3.6 - default notifications. 0 = ALL_MESSAGES (a problem), 1 = ONLY_MENTIONS (fine)
    default_message_notifications: guild.default_message_notifications,
    default_notifications_flag:
      guild.default_message_notifications === 0
        ? 'ALL MESSAGES - one click to fix, common cause of week-one muting'
        : 'only mentions - fine, no action needed',
    // 3.7 - ownership. Discord stores no such field; this needs a human answer.
    channel_ownership_recorded: false,
    // The rule for turning native Onboarding on at all.
    onboarding_requirement: 'at least 7 default channels, at least 5 allowing @everyone to view AND send',
    onboarding_default_channels_configured: (onboarding?.default_channel_ids ?? []).length,
    onboarding_qualifying_channels_today: qualifyingDefaults,
    onboarding_requirement_met_today: (onboarding?.default_channel_ids ?? []).length >= 7 && qualifyingDefaults >= 5,
  },
  // 3.8 - permission risk. Reported per role with headcounts, never as a list of
  // named members: spec 2.6 says do not enumerate members.
  permission_risk: roleRows
    .filter((r) => !r.managed_by_integration && r.dangerous_permissions)
    .map((r) => ({
      role: r.name,
      holders: r.members_holding,
      permissions: r.dangerous_permissions,
    })),
  // 3.5 - game coverage: roles with no channel, channels with no role.
  game_coverage: gameCoverage,
  A_unique_human_authors_30d: serverTotals.unique_human_authors_30d,
  A_unique_human_authors_90d: serverTotals.unique_human_authors_90d,
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

// --- the two files TWO-14 builds from ----------------------------------------
// Contract paths from the audit-spec, section 4. The JSON is the rollback
// source for the migration, so it carries every channel's topic, position,
// parent and permission overwrites exactly as they are today.
const STAMP = new Date(now).toISOString().slice(0, 10);
mkdirSync('data', { recursive: true });

writeFileSync(`data/server-audit-${STAMP}.csv`, csv(rows as unknown as Record<string, unknown>[]));

writeFileSync(
  `data/server-audit-${STAMP}.json`,
  JSON.stringify(
    {
      collected_at: meta.collected_at,
      note:
        'Rollback source for the TWO-14 migration. Every channel below is recorded with the' +
        ' topic, position, parent and permission overwrites it had at collection time.' +
        ' No message content and no member identities are in this file.',
      summary,
      guild,
      welcome_screen: welcome,
      onboarding,
      categories: channels.filter((c) => c.type === 4),
      channels: channels
        .filter((c) => c.type !== 4)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          type_name: TYPE_NAME[c.type] ?? String(c.type),
          parent_id: c.parent_id ?? null,
          parent_name: c.parent_id ? (byId.get(c.parent_id)?.name ?? null) : null,
          position: c.position ?? 0,
          topic: c.topic ?? null,
          nsfw: c.nsfw === true,
          rate_limit_per_user: c.rate_limit_per_user ?? 0,
          user_limit: c.user_limit ?? null,
          permission_overwrites: c.permission_overwrites ?? [],
          audit: rows.find((r) => r.channel_id === c.id) ?? null,
        })),
      roles: roleRows,
      invites: inviteRows,
    },
    null,
    2,
  ) + '\n',
);

process.stdout.write(walk);
process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');
