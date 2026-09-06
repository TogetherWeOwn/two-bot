import { LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, checkStagingToken, stagingGuildId } from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';
const APPLY = process.argv.includes('--apply');
const EXPORT = process.argv.includes('--export');
const INVITE = process.argv.includes('--invite');
const token = process.env.DISCORD_STAGING_BOT_TOKEN;

if (!token) {
  console.error('Missing DISCORD_STAGING_BOT_TOKEN.');
  process.exit(2);
}
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) {
  console.error(tokenCheck.message);
  process.exit(2);
}

const guildId = stagingGuildId();
if (guildId === LIVE_GUILD_ID) {
  console.error(`Refusing to touch the live TWO guild (${LIVE_GUILD_ID}).`);
  process.exit(2);
}

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const CONNECT = 1n << 20n;
const SPEAK = 1n << 21n;

const SERVER_DESCRIPTION =
  'An 18+ gaming clan since 1998. No application, no interview, no member number — join the Discord, play a session, and find out what it is like when people notice you came back.';
const WELCOME_DESCRIPTION =
  'The internet has enough crowded rooms. This one is small on purpose: join, play, come back — that is the whole onboarding process.';
const STARTER_MESSAGE =
  "**You're in — that was the whole application.** Tell us what you're playing, on what platform, and when you're usually around. Need a crew tonight? Post the game, platform, and start time in #looking-to-play, then claim a voice room when the party forms.";
const PREVIOUS_STARTER_MESSAGES = new Set([
  '**Welcome to TWO.** What have you been playing lately? Say hello here, or use #looking-to-play when you want a group now.',
  '**Pull up a chair.** Tell us what you are playing, your platform, and when you are usually around. Looking for a game right now? Post in #looking-to-play, then grab a voice room when your crew is ready.',
]);

const TOPICS = {
  'start-here': 'Four rules, then the server is yours. There is no application, no interview, and no quiz — this page is the only gate. Say hello in #general when you are ready.',
  announcements: 'Important TWO news and scheduled events. Low-volume and read-only; if it is posted here, it matters.',
  general: 'The shared table for games, life, questionable strategies, and introductions. New here? Say hello and tell us what you play — this is a place where people notice who comes back.',
  'looking-to-play': 'Finding a group should not require a spreadsheet, three bots, and divine intervention. Post the game, the platform if it matters, and your start time; claim a voice room when the party forms.',
  'discord-updates': 'Discord Community and platform notices. Internal record; no conversation.',
  'moderation-log': 'Screening, anti-raid, report, and moderation actions. Internal evidence; no conversation.',
  'audit-log': 'Channel, role, configuration, and retained-bot events. Internal evidence; no conversation.',
  'voice-log': 'Voice join, leave, and session telemetry used for community-health metrics. Internal evidence; no conversation.',
} as const;

const CATEGORIES = [
  { name: '👋 START HERE', channels: ['start-here', 'announcements'] },
  { name: '💬 COMMUNITY', channels: ['general', 'looking-to-play'] },
  { name: '🔊 VOICE', channels: ['Lobby', 'Squad'] },
  { name: '🔒 OPERATIONS', channels: ['discord-updates', 'moderation-log', 'audit-log', 'voice-log'] },
] as const;

const TEXT = new Set(['start-here', 'announcements', 'general', 'looking-to-play', 'discord-updates', 'moderation-log', 'audit-log', 'voice-log']);
const PUBLIC_READ_ONLY = new Set(['start-here', 'announcements']);
const OPERATIONS = new Set(['discord-updates', 'moderation-log', 'audit-log', 'voice-log']);
const VOICE = new Set(['Lobby', 'Squad']);
const WANTED_NAMES = new Set<string>(CATEGORIES.flatMap((category) => [category.name, ...category.channels]));

const OWNER_ROLE = {
  name: 'Owner',
  color: 0xd4af37,
  hoist: true,
  permissions: '0',
  mentionable: false,
};
const MODERATOR_ROLE = {
  name: 'Moderator',
  color: 0x5865f2,
  hoist: true,
  permissions: String((1n << 1n) | (1n << 2n) | (1n << 13n) | (1n << 16n) | (1n << 28n) | (1n << 40n)),
  mentionable: false,
};

const RULES = [
  'Treat people with respect. Harassment, hate, threats, and targeted abuse are not allowed.',
  'Keep content legal and appropriate for an 18+ gaming community.',
  'No spam, scams, malicious links, raids, or unsolicited promotion.',
  "Follow moderator direction. If something feels unsafe, use Discord's report tools or contact the Owner directly.",
];

const SCREENING_DESCRIPTION =
  'Accept the four community rules to enter TWO. This is the only membership gate — there is no application and nothing else to pass.';

let failures = 0;
type DiscordObject = Record<string, unknown>;

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = (await response.json().catch(() => null)) as T | null;
    if (response.status !== 429) return { status: response.status, body: responseBody };
    const retryAfter = Number((responseBody as { retry_after?: number } | null)?.retry_after ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 30) * 1000));
  }
  return { status: 429, body: null };
}

async function write<T>(label: string, method: string, path: string, body?: unknown): Promise<T | null> {
  if (!APPLY) {
    console.log(`WOULD ${label}`);
    return null;
  }
  const result = await api<T>(method, path, body);
  if (result.status >= 300) {
    console.error(`ERROR ${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    failures++;
    return null;
  }
  console.log(`DID   ${label}`);
  return result.body;
}

function equalOverwrites(a: Array<{ id: string; type: number; allow: string; deny: string }>, b: Array<{ id: string; type: number; allow: string; deny: string }>): boolean {
  const normalize = (items: typeof a) => items.map((item) => `${item.id}:${item.type}:${item.allow}:${item.deny}`).sort();
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

const me = await api<{ id: string; username: string }>('GET', '/users/@me');
if (me.status !== 200 || !me.body || me.body.id !== STAGING_BOT_APPLICATION_ID) {
  console.error(`Expected staging bot ${STAGING_BOT_APPLICATION_ID}; Discord returned HTTP ${me.status}.`);
  process.exit(1);
}
const guilds = await api<Array<{ id: string; name: string }>>('GET', '/users/@me/guilds');
if (guilds.status !== 200 || !guilds.body?.some((guild) => guild.id === guildId)) {
  console.error(`The staging bot is not in guild ${guildId}.`);
  process.exit(1);
}
if (guilds.body.some((guild) => guild.id === LIVE_GUILD_ID)) {
  console.error(`The staging bot is also in the live guild ${LIVE_GUILD_ID}; refusing all writes.`);
  process.exit(1);
}

const guild = await api<{ id: string; name: string; owner_id: string; features: string[] }>('GET', `/guilds/${guildId}`);
if (guild.status !== 200 || !guild.body || guild.body.name !== 'TWO Staging') {
  console.error(`Expected TWO Staging (${guildId}); received HTTP ${guild.status} ${JSON.stringify(guild.body)}.`);
  process.exit(1);
}

console.log(`\n${APPLY ? 'Applying' : 'Planning'} clean-slate structure in ${guild.body.name} (${guildId})\n`);

let roles = (await api<Array<{ id: string; name: string; managed: boolean; position: number; color: number; hoist: boolean; permissions: string }>>('GET', `/guilds/${guildId}/roles`)).body ?? [];
const botRole = roles.find((role) => role.managed && role.name === 'Owen QA Test');
if (!botRole) {
  console.error('Owen QA Test managed role is missing.');
  process.exit(1);
}

for (const wanted of [OWNER_ROLE, MODERATOR_ROLE]) {
  const existing = roles.find((role) => !role.managed && role.name === wanted.name);
  if (!existing) {
    await write(`create ${wanted.name} role`, 'POST', `/guilds/${guildId}/roles`, wanted);
  } else if (existing.color !== wanted.color || existing.hoist !== wanted.hoist || existing.permissions !== wanted.permissions) {
    await write(`reconcile ${wanted.name} role`, 'PATCH', `/guilds/${guildId}/roles/${existing.id}`, wanted);
  }
}

roles = APPLY ? ((await api<typeof roles>('GET', `/guilds/${guildId}/roles`)).body ?? roles) : roles;
const ownerRole = roles.find((role) => role.name === 'Owner' && !role.managed);
const moderatorRole = roles.find((role) => role.name === 'Moderator' && !role.managed);
if (APPLY && ownerRole && moderatorRole) {
  await write('order Owner and Moderator below Owen', 'PATCH', `/guilds/${guildId}/roles`, [
    { id: ownerRole.id, position: Math.max(2, botRole.position - 1) },
    { id: moderatorRole.id, position: Math.max(1, botRole.position - 2) },
  ]);
}

const obsoleteRoleNames = new Set(['Member', 'Game: Test', 'tog463-qa-throwaway', 'Verified', 'Survival Games', 'Shooter Games', 'Horror Games']);
for (const role of roles) {
  if (!role.managed && role.id !== guildId && obsoleteRoleNames.has(role.name)) {
    await write(`delete obsolete role ${role.name}`, 'DELETE', `/guilds/${guildId}/roles/${role.id}`);
  }
}

let channels = (await api<Array<{ id: string; name: string; type: number; parent_id: string | null; position: number; topic?: string | null; permission_overwrites: Array<{ id: string; type: number; allow: string; deny: string }> }>>('GET', `/guilds/${guildId}/channels`)).body ?? [];
const categories = new Map<string, string>();
for (const wanted of CATEGORIES) {
  const existing = channels.find((channel) => channel.type === 4 && channel.name === wanted.name);
  if (existing) categories.set(wanted.name, existing.id);
  else {
    const created = await write<{ id: string }>(`create category ${wanted.name}`, 'POST', `/guilds/${guildId}/channels`, { name: wanted.name, type: 4 });
    if (created) categories.set(wanted.name, created.id);
  }
}

channels = APPLY ? ((await api<typeof channels>('GET', `/guilds/${guildId}/channels`)).body ?? channels) : channels;
for (const category of CATEGORIES) {
  const parentId = categories.get(category.name) ?? channels.find((channel) => channel.type === 4 && channel.name === category.name)?.id;
  for (const name of category.channels) {
    const type = VOICE.has(name) ? 2 : 0;
    const existing = channels.find((channel) => channel.type === type && channel.name === name);
    const overwrites = OPERATIONS.has(name)
      ? [{ id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }]
      : PUBLIC_READ_ONLY.has(name)
        ? [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL), deny: String(SEND_MESSAGES) }]
        : VOICE.has(name)
          ? [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL | CONNECT | SPEAK), deny: '0' }]
          : [{ id: guildId, type: 0, allow: String(VIEW_CHANNEL | SEND_MESSAGES), deny: '0' }];
    const body = {
      name,
      type,
      parent_id: parentId,
      ...(TEXT.has(name) ? { topic: TOPICS[name as keyof typeof TOPICS] } : {}),
      permission_overwrites: overwrites,
    };
    if (!existing) await write(`create ${type === 2 ? 'voice' : 'text'} channel ${name}`, 'POST', `/guilds/${guildId}/channels`, body);
    else if (existing.parent_id !== parentId || (TEXT.has(name) && existing.topic !== TOPICS[name as keyof typeof TOPICS]) || !equalOverwrites(existing.permission_overwrites, overwrites)) {
      await write(`reconcile channel ${name}`, 'PATCH', `/channels/${existing.id}`, body);
    }
  }
}

channels = APPLY ? ((await api<typeof channels>('GET', `/guilds/${guildId}/channels`)).body ?? channels) : channels;
const positions: Array<{ id: string; position: number; parent_id?: string }> = [];
for (let categoryIndex = 0; categoryIndex < CATEGORIES.length; categoryIndex++) {
  const category = CATEGORIES[categoryIndex];
  const categoryObject = channels.find((channel) => channel.type === 4 && channel.name === category.name);
  if (!categoryObject) continue;
  positions.push({ id: categoryObject.id, position: categoryIndex });
  category.channels.forEach((name, position) => {
    const channel = channels.find((candidate) => candidate.name === name && candidate.type === (VOICE.has(name) ? 2 : 0));
    if (channel) positions.push({ id: channel.id, position, parent_id: categoryObject.id });
  });
}
if (positions.length) {
  await write(
    'set category order',
    'PATCH',
    `/guilds/${guildId}/channels`,
    positions.filter((position) => position.parent_id === undefined),
  );
  for (const position of positions.filter((item) => item.parent_id !== undefined)) {
    await write(`set channel order for ${position.id}`, 'PATCH', `/guilds/${guildId}/channels`, [position]);
  }
}

for (const channel of channels) {
  if ((channel.type === 0 || channel.type === 2 || channel.type === 4) && !WANTED_NAMES.has(channel.name)) {
    await write(`delete obsolete channel ${channel.name}`, 'DELETE', `/channels/${channel.id}`);
  }
}

const freshChannels = APPLY ? ((await api<typeof channels>('GET', `/guilds/${guildId}/channels`)).body ?? []) : channels;
const startHere = freshChannels.find((channel) => channel.name === 'start-here' && channel.type === 0);
const announcements = freshChannels.find((channel) => channel.name === 'announcements' && channel.type === 0);
const general = freshChannels.find((channel) => channel.name === 'general' && channel.type === 0);
const looking = freshChannels.find((channel) => channel.name === 'looking-to-play' && channel.type === 0);

if (APPLY && startHere && announcements) {
  await write('configure guild description and system channels', 'PATCH', `/guilds/${guildId}`, {
    description: SERVER_DESCRIPTION,
    system_channel_id: startHere.id,
    rules_channel_id: startHere.id,
    public_updates_channel_id: announcements.id,
  });
}

let communityEnabled = guild.body.features.includes('COMMUNITY');
if (APPLY && !communityEnabled && startHere && announcements) {
  const verification = await write<{ features?: string[] }>('raise verification level for Community', 'PATCH', `/guilds/${guildId}`, {
    verification_level: 1,
    explicit_content_filter: 2,
  });
  if (verification) {
    const community = await write<{ features?: string[] }>('enable Community for welcome and screening placeholders', 'PATCH', `/guilds/${guildId}`, {
      features: [...guild.body.features, 'COMMUNITY'],
      rules_channel_id: startHere.id,
      public_updates_channel_id: announcements.id,
    });
    communityEnabled = Boolean(community?.features?.includes('COMMUNITY'));
  }
}

if (APPLY && communityEnabled && startHere && general && looking) {
  await write('configure three-card Welcome Screen', 'PATCH', `/guilds/${guildId}/welcome-screen`, {
    enabled: true,
    description: WELCOME_DESCRIPTION,
    welcome_channels: [
      { channel_id: startHere.id, description: 'Four rules, then the server is yours.', emoji_name: '👋' },
      { channel_id: general.id, description: 'Say hello. People notice who comes back.', emoji_name: '💬' },
      { channel_id: looking.id, description: 'Game, platform, start time — find your crew.', emoji_name: '🎮' },
    ],
  });
  await write('keep native Onboarding off', 'PUT', `/guilds/${guildId}/onboarding`, {
    prompts: [],
    default_channel_ids: [startHere.id, announcements?.id, general.id, looking.id].filter(Boolean),
    enabled: false,
    mode: 0,
  });
  await write('configure Membership Screening placeholder', 'PATCH', `/guilds/${guildId}/member-verification`, {
    enabled: true,
    form_fields: [{ field_type: 'TERMS', label: 'TWO community rules', required: true, values: RULES }],
    description: SCREENING_DESCRIPTION,
  });
}

if (APPLY && general) {
  const recentMessages = await api<Array<{ id: string; author: { id: string }; content: string }>>(
    'GET',
    `/channels/${general.id}/messages?limit=50`,
  );
  const currentStarter = recentMessages.body?.find(
    (message) => message.author.id === me.body.id && message.content === STARTER_MESSAGE,
  );
  if (!currentStarter) {
    const previousStarter = recentMessages.body?.find(
      (message) => message.author.id === me.body.id && PREVIOUS_STARTER_MESSAGES.has(message.content),
    );
    if (previousStarter) {
      await write('update first-message starter placeholder', 'PATCH', `/channels/${general.id}/messages/${previousStarter.id}`, {
        content: STARTER_MESSAGE,
        allowed_mentions: { parse: [] },
      });
    } else {
      await write('post first-message starter placeholder', 'POST', `/channels/${general.id}/messages`, {
        content: STARTER_MESSAGE,
        allowed_mentions: { parse: [] },
      });
    }
  }
}

let inviteUrl: string | null = null;
if (APPLY && INVITE && startHere) {
  const invite = await write<{ code: string }>('create owner review invite', 'POST', `/channels/${startHere.id}/invites`, {
    max_age: 604800,
    max_uses: 10,
    unique: true,
  });
  if (invite) inviteUrl = `https://discord.gg/${invite.code}`;
}

if (APPLY || EXPORT) {
  const finalGuild = await api<DiscordObject>('GET', `/guilds/${guildId}`);
  const finalRoles = await api<DiscordObject[]>('GET', `/guilds/${guildId}/roles`);
  const finalChannels = await api<DiscordObject[]>('GET', `/guilds/${guildId}/channels`);
  const welcome = await api<DiscordObject>('GET', `/guilds/${guildId}/welcome-screen`);
  const onboarding = await api<DiscordObject>('GET', `/guilds/${guildId}/onboarding`);
  const screening = await api<DiscordObject>('GET', `/guilds/${guildId}/member-verification`);
  console.log('\n---BEGIN CLEAN SLATE EXPORT---');
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), guild: finalGuild.body, roles: finalRoles.body, channels: finalChannels.body, welcomeScreen: { status: welcome.status, body: welcome.body }, onboarding: { status: onboarding.status, body: onboarding.body }, membershipScreening: { status: screening.status, body: screening.body }, inviteUrl }, null, 2));
  console.log('---END CLEAN SLATE EXPORT---');
}

console.log(`\nDone with ${failures} error(s).${inviteUrl ? `\nOwner invite: ${inviteUrl}` : ''}`);
process.exit(failures ? 1 : 0);
