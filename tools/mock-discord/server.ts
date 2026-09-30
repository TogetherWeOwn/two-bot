/**
 * A minimal local stand-in for Discord: the REST endpoints the bot calls at
 * startup, plus a gateway websocket that speaks enough of the protocol to get
 * a real discord.js client to READY and then push dispatches at it.
 *
 * Why this exists: we do not have the live TWO bot token yet, and we should not
 * be blocked on it. This lets the actual bot process - unmodified, using real
 * discord.js - connect, receive a real GUILD_MEMBER_ADD frame over a socket,
 * and write a row. The only thing it does not exercise is Discord's own
 * servers and TLS.
 *
 * This is a dev/test tool. It is never imported by src/.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { GAME_PICKS, GAME_HUB_CHANNEL_ID, GATED_CATEGORIES, GUILD_ID as TWO_GUILD_ID } from '../../src/onboarding/catalog.ts';
import { LOOKING_TO_PLAY_CHANNEL_ID, LOBBY_VOICE_CHANNEL_ID } from '../../src/onboarding/session.ts';
import {
  STAGING_INVITE_PERMISSIONS,
  STAGING_ROLES,
  STAGING_SERVER_NAME,
  STAGING_TEXT_CHANNELS,
  STAGING_VOICE_CHANNELS,
  TWO_STAGING_GUILD_ID,
} from '../../src/staging/spec.ts';

/**
 * Defaults use TWO's catalog ids so onboarding role/channel routing stays
 * realistic. A fixture may override the guild identity (including @everyone)
 * without changing that catalog. The bot connects via DISCORD_API_BASE;
 * process-level tests must separately contain other outbound transports.
 */
const BOT_ID = '900000000000000002';
const TEXT_CHANNEL = '1045943373007171674'; // 💬〢general - the real landing channel
const VOICE_CHANNEL = '900000000000000011';
const MEMBER_ROLE = '1078755185423286372'; // the real "Member" role
/** Position the bot's role where it really sits: above the game roles. */
const BOT_ROLE = '900000000000000003';

export interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface MockInvite {
  code: string;
  uses: number;
  inviterId: string;
}

export interface MockScheduledEvent {
  id: string;
  name: string;
  scheduled_start_time: string;
  channel_id: string | null;
  description: string | null;
  /** Discord's real shape for an external event; null for a voice event. */
  entity_metadata: { location: string } | null;
  status: number;
}

/**
 * The two capability fields of an Identify frame, and nothing else.
 *
 * A fixture must not become a token sink: `d.token`, `d.properties` and the
 * rest of the frame are read and dropped. Only what the connection *asks
 * Discord for* is retained, because that is the boundary tests assert on.
 */
export interface IdentifyCapability {
  /** Raw `d.intents` bitfield, as sent. */
  intents: number | null;
  /** `d.presence.status`, or null when the frame carried no presence at all. */
  presenceStatus: string | null;
}

export interface MockVoiceState {
  memberId: string;
  channelId: string;
  isBot?: boolean;
}

function voicePayload(guildId: string, memberId: string, channelId: string | null, isBot = false) {
  return {
    guild_id: guildId,
    channel_id: channelId,
    user_id: memberId,
    member: {
      user: userPayload(memberId, 'member', isBot),
      roles: [],
      joined_at: new Date(0).toISOString(),
      deaf: false,
      mute: false,
      flags: 0,
    },
    session_id: `mock-voice-${memberId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    suppress: false,
    request_to_speak_timestamp: null,
  };
}

export interface MockDiscord {
  port: number;
  apiBase: string;
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  /** Mutable - bump `uses` before firing a join to test attribution. */
  invites: MockInvite[];
  /** Mutable Discord REST snapshot returned by the scheduled-events GET. */
  scheduledEvents: MockScheduledEvent[];
  /** Resolves once a client has completed IDENTIFY and been sent READY. */
  waitForReady(timeoutMs?: number): Promise<void>;
  dispatch(type: string, data: unknown): void;
  memberJoin(memberId: string, username: string): void;
  message(memberId: string, channelId?: string): void;
  voiceJoin(memberId: string, channelId?: string, isBot?: boolean): void;
  voiceLeave(memberId: string, isBot?: boolean): void;
  /** Replace the next GUILD_CREATE snapshot without emitting live voice frames. */
  setVoiceStates(states: MockVoiceState[]): void;
  /** Real recovery handshake: opcode 7 -> Resume, or opcode 9 false -> Identify. */
  reconnect(mode: 'resume' | 'fresh', timeoutMs?: number): Promise<void>;
  close(): Promise<void>;

  // --- onboarding (TWO-7) ---------------------------------------------------
  /** Every non-GET the bot made. Assert on what it actually sent. */
  captured: CapturedRequest[];
  /** Gateway opcode census only; never retain identify tokens or frame bodies. */
  gatewayOpcodes: number[];
  /** Capability of every IDENTIFY seen on the socket, in order. Never tokens. */
  identifies: IdentifyCapability[];
  /** Join behind the rules gate: present in the guild, unable to interact. */
  memberJoinPending(memberId: string, username: string, guildId?: string): void;
  /** Rules accepted - pending flips false. This is the real onboarding trigger. */
  memberAcceptRules(memberId: string, username: string, guildId?: string): void;
  /** Simulate a game selection; return its unique token to correlate the reply. */
  selectGames(memberId: string, username: string, keys: string[], heldRoleIds?: string[]): string;
  /** Simulate the member using the session picker (TOG-1644). */
  selectSession(memberId: string, username: string, keys: string[], guildId?: string): void;
  /** Simulate the member leaving the guild (triggers goodbye, TOG-1644). */
  memberRemove(memberId: string, username: string, guildId?: string): void;

  // --- staging-verify surface (TOG-8295) ------------------------------------
  /**
   * Channel history the audit-marker reconciliation reads, keyed by channel
   * id. Only consulted when this mock was started with `stagingVerify: true`;
   * anything unseeded reads back empty, so a missing marker is a FAIL in the
   * script rather than a 500 here.
   */
  seedChannelHistory(channelId: string, messages: StagingVerifySeedMessage[]): void;

  // --- internal actions endpoint (TWO-59) -----------------------------------
  /** Seed the roles GET /guilds/x/members/y reports, so already_held is reachable. */
  setMemberRoles(memberId: string, roleIds: string[]): void;
  /** Seed an existing member, so PUT /guilds/x/members/y answers 204 not 201. */
  addExistingMember(memberId: string): void;
  /** True once the bot has added this member through the one-click join path. */
  hasMember(memberId: string): boolean;
}

const VIEW_CHANNEL = 1n << 10n;

function rolePayload(id: string, name: string, position: number, permissions = '0', tags?: { bot_id: string }) {
  return {
    id,
    name,
    color: 0,
    hoist: false,
    position,
    permissions,
    managed: false,
    mentionable: false,
    flags: 0,
    ...(tags ? { tags } : {}),
  };
}

/**
 * Fixture-block ids for the staging-verify surface (TOG-8295). The guild id
 * itself must be the real TWO Staging guild - `stagingGuildId()` refuses
 * anything else - but every channel and role id inside it is mock-local, so
 * they come from the reserved fixture block and can never name a live object.
 */
export const STAGING_VERIFY_BOT_ROLE_ID = '900000000000000041';
export const STAGING_VERIFY_CHANNELS = {
  welcome: '900000000000000031',
  /** Doubles as the goodbye channel: DISCORD_GOODBYE_CHANNEL_IDS points here. */
  general: '900000000000000032',
  events: '900000000000000033',
  botLog: '900000000000000034',
  auditLog: '900000000000000035',
  voiceLog: '900000000000000036',
  moderationLog: '900000000000000037',
  voice1: '900000000000000038',
  tempVoiceCategory: '900000000000000039',
  tempVoiceGenerator: '900000000000000040',
} as const;
/** Not the bot: the verifier exercises the non-owner permission path. */
const STAGING_VERIFY_OWNER_ID = '900000000000000099';

/**
 * Panel messages the full-sweep self-role slice reads (TOG-8295). The test
 * owns the panel JSON and imports these ids so the catalogue and the mock
 * cannot drift; any other single-message fetch 404s, keeping the slice
 * falsifiable.
 */
export const STAGING_VERIFY_PANEL_MESSAGES = {
  buttons: '900000000000000061',
  select: '900000000000000062',
  reactions: '900000000000000063',
} as const;

/** One seeded channel-history row the audit-marker reconciliation reads. */
export interface StagingVerifySeedMessage {
  id: string;
  content: string;
  timestamp: string;
}

/**
 * Mock-local ids for the STAGING_ROLES entries, in spec order. Exported so
 * the staging-verify test builds its panel catalogue from the same ids the
 * mock serves, instead of repeating the template.
 */
export const STAGING_VERIFY_ROLE_IDS: Record<(typeof STAGING_ROLES)[number], string> = {
  Moderator: '900000000000000050',
  Member: '900000000000000051',
  'Game: Test': '900000000000000052',
  'Game: Test 2': '900000000000000053',
  'Color: Red': '900000000000000054',
  'Color: Blue': '900000000000000055',
};

/** The mock bot's own user id, served by GET /users/@me when stagingVerify is on. */
export const MOCK_BOT_USER_ID = BOT_ID;

/** Every STAGING_ROLES entry below the bot's managed role, so none is blocked. */
function stagingVerifyRolesPayload(guildId: string) {
  return [
    rolePayload(guildId, '@everyone', 0, '0'),
    ...STAGING_ROLES.map((name, i) => rolePayload(STAGING_VERIFY_ROLE_IDS[name], name, 10 + i, '0')),
    {
      ...rolePayload(
        STAGING_VERIFY_BOT_ROLE_ID,
        'Owen Staging',
        100,
        String(STAGING_INVITE_PERMISSIONS),
        { bot_id: BOT_ID },
      ),
      managed: true,
    },
  ];
}

/**
 * The spec channel set: every STAGING_TEXT_CHANNELS entry (the three staff
 * logs private to @everyone), the STAGING_VOICE_CHANNELS entry, plus the
 * temp-voice category and generator the --case=temp-voice slice resolves.
 * Names come from the spec; only the ids are fixture-local.
 */
function stagingVerifyChannelsPayload(guildId: string) {
  const text = (id: string, name: string) => ({
    id, type: 0, guild_id: guildId, name, position: 0,
    permission_overwrites: [], nsfw: false,
  });
  const staffLog = (id: string, name: string) => ({
    id, type: 0, guild_id: guildId, name, position: 0,
    permission_overwrites: [{ id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }],
    nsfw: false,
  });
  const textId: Record<string, string> = {
    welcome: STAGING_VERIFY_CHANNELS.welcome,
    general: STAGING_VERIFY_CHANNELS.general,
    events: STAGING_VERIFY_CHANNELS.events,
    'bot-log': STAGING_VERIFY_CHANNELS.botLog,
    'audit-log': STAGING_VERIFY_CHANNELS.auditLog,
    'voice-log': STAGING_VERIFY_CHANNELS.voiceLog,
    'moderation-log': STAGING_VERIFY_CHANNELS.moderationLog,
  };
  const staffLogs = new Set(['audit-log', 'voice-log', 'moderation-log']);
  const channels = STAGING_TEXT_CHANNELS.map((name) => {
    const id = textId[name] ?? `90000000000000007${STAGING_TEXT_CHANNELS.indexOf(name)}`;
    return staffLogs.has(name) ? staffLog(id, name) : text(id, name);
  });
  return [
    ...channels,
    {
      id: STAGING_VERIFY_CHANNELS.voice1, type: 2, guild_id: guildId,
      name: STAGING_VOICE_CHANNELS[0] ?? 'Voice 1', position: 1, permission_overwrites: [],
      bitrate: 64000, user_limit: 0,
    },
    {
      id: STAGING_VERIFY_CHANNELS.tempVoiceCategory, type: 4, guild_id: guildId,
      name: 'Voice Rooms', position: 5, permission_overwrites: [],
    },
    {
      id: STAGING_VERIFY_CHANNELS.tempVoiceGenerator, type: 2, guild_id: guildId,
      name: 'Join to Create', position: 6, parent_id: STAGING_VERIFY_CHANNELS.tempVoiceCategory,
      permission_overwrites: [], bitrate: 64000, user_limit: 0,
    },
  ];
}

/**
 * The roles onboarding touches, at their real relative positions: every game
 * role below the bot's role, so role-hierarchy failures show up here rather
 * than in production.
 */
function rolesPayload(guildId: string) {
  return [
    // @everyone with VIEW_CHANNEL and SEND_MESSAGES, as on the real server.
    rolePayload(guildId, '@everyone', 0, String(VIEW_CHANNEL | (1n << 11n))),
    rolePayload(BOT_ROLE, 'Owen', 105, String(1n << 28n)), // MANAGE_ROLES
    rolePayload(MEMBER_ROLE, 'Member', 106),
    ...GAME_PICKS.map((p, i) => rolePayload(p.roleId, p.roleName, 10 + i)),
  ];
}

/**
 * Channels, reproducing production's defect on purpose: the three game
 * categories deny view to @everyone and grant it back to nobody, so a member
 * holding "Shooter Games" still cannot see #shooters-general.
 *
 * Three configurations, because the difference between the last two is a bug
 * that nearly shipped:
 *
 *   'dark'            - production today. Nobody can see the game rooms.
 *   'categories-only' - the grant added to the categories and nothing else.
 *                       Looks correct in the Discord UI. Changes nothing for
 *                       members, because Discord resolves permissions from a
 *                       channel's OWN overwrites - a category is a template you
 *                       sync down, it grants nothing at runtime.
 *   'lit'             - the grant on the categories AND the channels inside
 *                       them. This is what apply-game-channel-access.ts does.
 */
export type Lighting = 'dark' | 'categories-only' | 'lit';

function channelsPayload(lighting: Lighting, GUILD_ID: string) {
  const deny = [{ id: GUILD_ID, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }];
  const granted = (roleId: string) => [
    ...deny,
    { id: roleId, type: 0, allow: String(VIEW_CHANNEL), deny: '0' },
  ];

  const categories = GATED_CATEGORIES.map((cat) => ({
    id: cat.categoryId,
    type: 4,
    guild_id: GUILD_ID,
    name: cat.categoryName,
    position: 5,
    permission_overwrites: lighting === 'dark' ? deny : granted(cat.roleId),
  }));

  const gameChannels = GAME_PICKS.filter((p) => p.primaryChannelId).map((p) => {
    const cat = GATED_CATEGORIES.find((c) => c.roleId === p.roleId)!;
    return {
      id: p.primaryChannelId!,
      type: 0,
      guild_id: GUILD_ID,
      name: p.label.toLowerCase() + '-general',
      position: 0,
      parent_id: cat.categoryId,
      permission_overwrites: lighting === 'lit' ? granted(cat.roleId) : deny,
      nsfw: false,
    };
  });

  return [
    {
      id: TEXT_CHANNEL,
      type: 0,
      guild_id: GUILD_ID,
      name: 'general',
      position: 0,
      permission_overwrites: [],
      nsfw: false,
    },
    {
      id: GAME_HUB_CHANNEL_ID,
      type: 0, // a text channel here; the real one is a forum, but routing only links it
      guild_id: GUILD_ID,
      name: 'game-hub',
      position: 2,
      permission_overwrites: [],
      nsfw: false,
    },
    {
      id: VOICE_CHANNEL,
      type: 2,
      guild_id: GUILD_ID,
      name: 'Lobby',
      position: 1,
      permission_overwrites: [],
      bitrate: 64000,
      user_limit: 0,
    },
    // The session-routing destinations (TOG-1644): open to @everyone, exactly
    // as the clean-slate staging structure has them.
    {
      id: LOOKING_TO_PLAY_CHANNEL_ID,
      type: 0,
      guild_id: GUILD_ID,
      name: 'looking-to-play',
      position: 3,
      permission_overwrites: [],
      nsfw: false,
    },
    {
      id: LOBBY_VOICE_CHANNEL_ID,
      type: 2,
      guild_id: GUILD_ID,
      name: 'Lobby (session)',
      position: 2,
      permission_overwrites: [],
      bitrate: 64000,
      user_limit: 0,
    },
    ...categories,
    ...gameChannels,
  ];
}

function guildPayload(lighting: Lighting, GUILD_ID: string, voiceStates: MockVoiceState[] = []) {
  return {
    id: GUILD_ID,
    name: 'TWO Dev',
    icon: null,
    splash: null,
    discovery_splash: null,
    owner_id: '900000000000000099',
    region: 'deprecated',
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 1,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0,
    application_id: null,
    system_channel_id: TEXT_CHANNEL,
    system_channel_flags: 0,
    rules_channel_id: null,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: 0,
    preferred_locale: 'en-US',
    public_updates_channel_id: null,
    nsfw_level: 0,
    premium_progress_bar_enabled: false,
    unavailable: false,
    member_count: 3,
    large: false,
    joined_at: new Date(0).toISOString(),
    features: [],
    emojis: [],
    stickers: [],
    roles: rolesPayload(GUILD_ID),
    channels: channelsPayload(lighting, GUILD_ID),
    threads: [],
    // The bot itself has to be in the member list, otherwise guild.members.me
    // is null and every permission check the bot makes returns nothing.
    members: [
      {
        user: userPayload(BOT_ID, 'two-dev-bot', true),
        roles: [BOT_ROLE],
        joined_at: new Date(0).toISOString(),
        deaf: false,
        mute: false,
        flags: 0,
        pending: false,
      },
      ...voiceStates.filter((state) => state.memberId !== BOT_ID).map((state) =>
        voicePayload(GUILD_ID, state.memberId, state.channelId, state.isBot).member),
    ],
    presences: [],
    voice_states: voiceStates.map((state) =>
      voicePayload(GUILD_ID, state.memberId, state.channelId, state.isBot)),
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
  };
}

const DISCORD_EPOCH = 1_420_070_400_000n;

/**
 * A real Discord snowflake for "now". This matters: discord.js derives
 * Message#createdTimestamp from the id, not from the `timestamp` field, so a
 * made-up id makes every message look like it was sent in 1970.
 */
function snowflake(): string {
  return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | 1n);
}

function userPayload(id: string, username: string, bot = false) {
  return {
    id,
    username,
    discriminator: '0',
    global_name: username,
    avatar: null,
    bot,
    system: false,
    flags: 0,
  };
}

export async function startMockDiscord(
  opts: { lighting?: Lighting; guildId?: string; stagingVerify?: boolean; voiceStates?: MockVoiceState[] } = {},
): Promise<MockDiscord> {
  // Instance-local: fixtures can exercise staging exclusions without changing
  // the production catalog, or another concurrently running mock's identity.
  const GUILD_ID = opts.guildId ?? TWO_GUILD_ID;
  /**
   * The staging-verify REST surface (TOG-8295). Opt-in so the onboarding
   * fixtures keep their exact current answers: every route below is keyed to
   * this mock's own guild id and only fires when the flag is on.
   */
  const stagingVerify = opts.stagingVerify === true && GUILD_ID === TWO_STAGING_GUILD_ID;
  /** Seeded channel history for the audit-marker reconciliation. */
  const channelHistory = new Map<string, StagingVerifySeedMessage[]>();
  const invites: MockInvite[] = [{ code: 'twodev01', uses: 5, inviterId: '900000000000000099' }];
  const scheduledEvents: MockScheduledEvent[] = [];
  const captured: CapturedRequest[] = [];
  const gatewayOpcodes: number[] = [];
  const identifies: IdentifyCapability[] = [];
  const lighting: Lighting = opts.lighting ?? 'dark';
  /** Roles the bot has granted per member, so PATCH member can echo them back. */
  const memberRoles = new Map<string, string[]>();
  /** Who is in the guild, for the one-click join path (TWO-59). */
  const existingMembers = new Set<string>();

  /**
   * Non-GET routes the onboarding flow touches. Everything returns a
   * plausible payload, because discord.js parses these responses.
   */
  function handleWrite(
    method: string,
    url: string,
    body: unknown,
    json: (b: unknown, status?: number) => void,
    noContent: () => void,
  ) {
    // Posting the welcome message.
    let m = /\/api\/v10\/channels\/(\d+)\/messages$/.exec(url);
    if (m && method === 'POST') {
      const b = body as { content?: string };
      return json({
        id: snowflake(),
        type: 0,
        channel_id: m[1],
        guild_id: GUILD_ID,
        author: userPayload(BOT_ID, 'two-dev-bot', true),
        content: b?.content ?? '',
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        components: [],
      });
    }

    // Scheduled events, for event.upsert (TOG-44). Create answers with a new
    // id; modify echoes the one in the path. The bot stores that id against
    // the website's event_key, so a test can assert the second call was a
    // PATCH of the first event rather than a second POST.
    m = /\/api\/v10\/guilds\/\d+\/scheduled-events$/.exec(url);
    if (m && method === 'POST') {
      const b = (body ?? {}) as Record<string, unknown>;
      const metadata = b.entity_metadata as { location?: unknown } | undefined;
      const event: MockScheduledEvent = {
        id: snowflake(),
        name: typeof b.name === 'string' ? b.name : '',
        scheduled_start_time:
          typeof b.scheduled_start_time === 'string' ? b.scheduled_start_time : new Date().toISOString(),
        channel_id: typeof b.channel_id === 'string' ? b.channel_id : null,
        description: typeof b.description === 'string' ? b.description : null,
        entity_metadata:
          typeof metadata?.location === 'string' ? { location: metadata.location } : null,
        status: 1,
      };
      scheduledEvents.push(event);
      return json({ ...b, ...event, guild_id: GUILD_ID });
    }
    m = /\/api\/v10\/guilds\/\d+\/scheduled-events\/(\d+)$/.exec(url);
    if (m && method === 'PATCH') {
      const b = (body ?? {}) as Record<string, unknown>;
      const existing = scheduledEvents.find((event) => event.id === m?.[1]);
      if (existing) {
        if (typeof b.name === 'string') existing.name = b.name;
        if (typeof b.scheduled_start_time === 'string') existing.scheduled_start_time = b.scheduled_start_time;
        if (typeof b.channel_id === 'string' || b.channel_id === null) existing.channel_id = b.channel_id;
        if (typeof b.description === 'string' || b.description === null) existing.description = b.description;
        if (typeof b.status === 'number') existing.status = b.status;
      }
      return json({ ...b, ...(existing ?? {}), id: m[1], guild_id: GUILD_ID, status: existing?.status ?? 1 });
    }

    // Interaction ack (deferReply) and the follow-up edit.
    if (/\/api\/v10\/interactions\/\d+\/[^/]+\/callback/.test(url) && method === 'POST') {
      return noContent();
    }
    if (/\/api\/v10\/webhooks\/\d+\/[^/]+\/messages\/@original/.test(url)) {
      const b = body as { content?: string };
      return json({
        id: snowflake(),
        type: 0,
        channel_id: TEXT_CHANNEL,
        guild_id: GUILD_ID,
        author: userPayload(BOT_ID, 'two-dev-bot', true),
        content: b?.content ?? '',
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        components: [],
        flags: 64,
      });
    }

    // Bulk role change - what discord.js uses for roles.add(array).
    m = /\/api\/v10\/guilds\/\d+\/members\/(\d+)$/.exec(url);
    if (m && method === 'PATCH') {
      const b = body as { roles?: string[] };
      if (b?.roles) memberRoles.set(m[1], b.roles);
      return json({
        user: userPayload(m[1], 'newbie'),
        roles: b?.roles ?? [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
        flags: 0,
        pending: false,
      });
    }

    // One-click join, PUT /guilds/{guild}/members/{user} (TWO-59). Discord
    // answers 201 when it added them and 204 when they were already in, and
    // the endpoint reports those as two different outcomes.
    if (m && method === 'PUT') {
      const id = m[1];
      if (existingMembers.has(id)) return noContent();
      existingMembers.add(id);
      return json(
        {
          user: userPayload(id, 'oneclick'),
          roles: memberRoles.get(id) ?? [],
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
          flags: 0,
          pending: false,
        },
        201,
      );
    }

    // Single role add/remove.
    m = /\/api\/v10\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/.exec(url);
    if (m) {
      const cur = new Set(memberRoles.get(m[1]) ?? [MEMBER_ROLE]);
      if (method === 'PUT') cur.add(m[2]);
      if (method === 'DELETE') cur.delete(m[2]);
      memberRoles.set(m[1], [...cur]);
      return noContent();
    }

    return json({});
  }

  let seq = 0;
  let socket: WebSocket | null = null;
  let voiceStates = (opts.voiceStates ?? []).map((state) => ({ ...state }));
  let recovery: { mode: 'resume' | 'fresh'; finish: (err?: Error) => void } | null = null;
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((res) => {
    readyResolve = res;
  });

  const http: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    const json = (body: unknown, status = 200) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    const noContent = () => {
      res.writeHead(204);
      res.end();
    };

    // Record every write so tests can assert on what the bot actually sent -
    // including asserting that it never sent a DM.
    if (method !== 'GET') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString() || 'null';
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        captured.push({ method, url, body });
        handleWrite(method, url, body, json, noContent);
      });
      return;
    }

    if (url.startsWith('/api/v10/gateway/bot')) {
      const port = (http.address() as AddressInfo).port;
      return json({
        url: `ws://127.0.0.1:${port}/gw`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 999, reset_after: 60_000, max_concurrency: 1 },
      });
    }

    // Read one member. role.assign uses this to tell "role added" from "you
    // already had it", so the roles it reports have to be the seeded ones.
    const member = /\/api\/v10\/guilds\/\d+\/members\/(\d+)$/.exec(url);
    if (member) {
      return json({
        user: userPayload(member[1], 'member'),
        roles: memberRoles.get(member[1]) ?? [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
        flags: 0,
        pending: false,
      });
    }

    if (/\/api\/v10\/guilds\/\d+\/invites/.test(url)) {
      return json(
        invites.map((i) => ({
          code: i.code,
          type: 0,
          channel: { id: TEXT_CHANNEL, type: 0, name: 'general' },
          guild: { id: GUILD_ID, name: 'TWO Dev', features: [] },
          inviter: userPayload(i.inviterId, 'twoadmin'),
          uses: i.uses,
          max_uses: 0,
          max_age: 0,
          temporary: false,
          created_at: new Date(0).toISOString(),
        })),
      );
    }

    if (/\/api\/v10\/guilds\/\d+\/scheduled-events$/.test(url)) {
      return json(scheduledEvents);
    }

    // Read one scheduled event, for event.read (TOG-5510). A deleted mirror
    // answers 404, which the bot surfaces as discord_rejected without
    // dropping the key mapping - terminal state belongs to event.cancel.
    const scheduledEvent = /\/api\/v10\/guilds\/\d+\/scheduled-events\/(\d+)$/.exec(url);
    if (scheduledEvent) {
      const existing = scheduledEvents.find((event) => event.id === scheduledEvent[1]);
      if (!existing) return json({ message: 'Unknown Scheduled Event', code: 10070 }, 404);
      return json({ ...existing, guild_id: GUILD_ID });
    }

    // --- staging-verify surface (TOG-8295) ---------------------------------
    // Flag-gated: with the flag off every one of these falls through to the
    // empty answer below, exactly as before. The verifier is pure REST, so
    // the gateway side of this mock is untouched.
    if (stagingVerify) {
      const path = url.split('?')[0] ?? url;

      if (path === '/api/v10/users/@me') {
        return json({ id: BOT_ID, username: 'two-dev-bot' });
      }

      if (path === '/api/v10/applications/@me') {
        // Both privileged intents the verifier checks: Server Members and
        // Message Content, limited and full bits.
        return json({ id: BOT_ID, flags: (1 << 14) | (1 << 15) | (1 << 18) | (1 << 19) });
      }

      let g = /\/api\/v10\/guilds\/(\d+)$/.exec(path);
      if (g && g[1] === GUILD_ID) {
        return json({ id: GUILD_ID, name: STAGING_SERVER_NAME, owner_id: STAGING_VERIFY_OWNER_ID });
      }

      g = /\/api\/v10\/guilds\/(\d+)\/roles$/.exec(path);
      if (g && g[1] === GUILD_ID) {
        return json(stagingVerifyRolesPayload(GUILD_ID));
      }

      g = /\/api\/v10\/guilds\/(\d+)\/channels$/.exec(path);
      if (g && g[1] === GUILD_ID) {
        return json(stagingVerifyChannelsPayload(GUILD_ID));
      }

      g = /\/api\/v10\/guilds\/(\d+)\/audit-logs$/.exec(path);
      if (g && g[1] === GUILD_ID) {
        return json({ audit_log_entries: [] });
      }

      const single = /\/api\/v10\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
      if (single) {
        const [, channelId, messageId] = single;
        const knownPanel = (Object.values(STAGING_VERIFY_PANEL_MESSAGES) as string[]).includes(messageId ?? '');
        if (knownPanel) return json({ id: messageId, channel_id: channelId });
        const seeded = (channelHistory.get(channelId ?? '') ?? []).some((m) => m.id === messageId);
        if (seeded) return json({ id: messageId, channel_id: channelId });
        return json({ message: 'Unknown Message', code: 50035 }, 404);
      }

      const history = /\/api\/v10\/channels\/(\d+)\/messages$/.exec(path);
      if (history) {
        const rows = channelHistory.get(history[1] ?? '') ?? [];
        return json(
          rows.map((m) => ({
            id: m.id,
            content: m.content,
            timestamp: m.timestamp,
            author: userPayload(BOT_ID, 'two-dev-bot', true),
          })),
        );
      }
    }

    // Anything else the client happens to ask for: an empty, valid-looking answer.
    return json({});
  });

  await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
  const port = (http.address() as AddressInfo).port;

  const wss = new WebSocketServer({ server: http, path: '/gw' });

  const send = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  wss.on('connection', (ws) => {
    socket = ws;
    // HELLO
    send(ws, { op: 10, d: { heartbeat_interval: 45_000 }, s: null, t: null });

    ws.on('message', (raw) => {
      let msg: { op: number; d?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      gatewayOpcodes.push(msg.op);
      if (msg.op === 1) {
        send(ws, { op: 11, d: null, s: null, t: null }); // heartbeat ack
        return;
      }

      if (msg.op === 6) {
        // RESUME -> RESUMED. Keep only the opcode census, never its token.
        send(ws, { op: 0, s: ++seq, t: 'RESUMED', d: {} });
        if (recovery?.mode === 'resume') recovery.finish();
        else recovery?.finish(new Error('mock gateway: expected Identify, received Resume'));
        return;
      }

      if (msg.op === 2) {
        // Record the capability this connection asked for, and only that. The
        // token and the rest of the frame are never read into the fixture.
        const identify = msg.d as { intents?: unknown; presence?: { status?: unknown } } | undefined;
        identifies.push({
          intents: typeof identify?.intents === 'number' ? identify.intents : null,
          presenceStatus: typeof identify?.presence?.status === 'string' ? identify.presence.status : null,
        });

        // IDENTIFY -> READY, then GUILD_CREATE so the guild stops being unavailable.
        send(ws, {
          op: 0,
          s: ++seq,
          t: 'READY',
          d: {
            v: 10,
            user: userPayload(BOT_ID, 'two-dev-bot', true),
            guilds: [{ id: GUILD_ID, unavailable: true }],
            session_id: 'mock-session',
            resume_gateway_url: `ws://127.0.0.1:${port}/gw`,
            shard: [0, 1],
            application: { id: BOT_ID, flags: 0 },
          },
        });
        setTimeout(() => {
          send(ws, { op: 0, s: ++seq, t: 'GUILD_CREATE', d: guildPayload(lighting, GUILD_ID, voiceStates) });
          readyResolve?.();
          if (recovery?.mode === 'fresh') recovery.finish();
          else recovery?.finish(new Error('mock gateway: expected Resume, received Identify'));
        }, 30);
      }
    });
  });

  const dispatch = (type: string, data: unknown) => {
    if (!socket) throw new Error('mock gateway: no client connected');
    send(socket, { op: 0, s: ++seq, t: type, d: data });
  };

  return {
    port,
    apiBase: `http://127.0.0.1:${port}/api`,
    guildId: GUILD_ID,
    textChannelId: TEXT_CHANNEL,
    voiceChannelId: VOICE_CHANNEL,
    invites,
    scheduledEvents,
    waitForReady: (timeoutMs = 15_000) =>
      Promise.race([
        readyPromise,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('mock gateway: client never became ready')), timeoutMs),
        ),
      ]),
    dispatch,
    setVoiceStates(states) {
      voiceStates = states.map((state) => ({ ...state }));
    },
    reconnect(mode, timeoutMs = 15_000) {
      if (!socket || socket.readyState !== socket.OPEN) {
        return Promise.reject(new Error('mock gateway: no open client connection'));
      }
      if (recovery) return Promise.reject(new Error('mock gateway: recovery already pending'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => recovery?.finish(new Error('mock gateway: recovery timed out')), timeoutMs);
        recovery = {
          mode,
          finish(err) {
            clearTimeout(timer);
            recovery = null;
            if (err) reject(err);
            else resolve();
          },
        };
        send(socket!, { op: mode === 'resume' ? 7 : 9, d: mode === 'resume' ? null : false, s: null, t: null });
      });
    },
    memberJoin(memberId, username) {
      dispatch('GUILD_MEMBER_ADD', {
        guild_id: GUILD_ID,
        user: userPayload(memberId, username),
        nick: null,
        avatar: null,
        roles: [],
        joined_at: new Date().toISOString(),
        premium_since: null,
        deaf: false,
        mute: false,
        pending: false,
        flags: 0,
      });
    },
    message(memberId, channelId = TEXT_CHANNEL) {
      dispatch('MESSAGE_CREATE', {
        id: snowflake(),
        channel_id: channelId,
        guild_id: GUILD_ID,
        author: userPayload(memberId, 'member'),
        member: { roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 },
        content: '',
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        type: 0,
      });
    },
    voiceJoin(memberId, channelId = VOICE_CHANNEL, isBot = false) {
      dispatch('VOICE_STATE_UPDATE', voicePayload(GUILD_ID, memberId, channelId, isBot));
    },
    voiceLeave(memberId, isBot = false) {
      dispatch('VOICE_STATE_UPDATE', voicePayload(GUILD_ID, memberId, null, isBot));
    },
    captured,
    gatewayOpcodes,
    identifies,

    memberJoinPending(memberId, username, guildId = GUILD_ID) {
      dispatch('GUILD_MEMBER_ADD', {
        guild_id: guildId,
        user: userPayload(memberId, username),
        roles: [],
        joined_at: new Date().toISOString(),
        premium_since: null,
        deaf: false,
        mute: false,
        pending: true, // behind the rules gate
        flags: 0,
      });
    },

    memberAcceptRules(memberId, username, guildId = GUILD_ID) {
      // discord.js compares against its cached copy, so the "before" state has
      // to have been dispatched first via memberJoinPending.
      dispatch('GUILD_MEMBER_UPDATE', {
        guild_id: guildId,
        user: userPayload(memberId, username),
        roles: [MEMBER_ROLE],
        joined_at: new Date().toISOString(),
        premium_since: null,
        deaf: false,
        mute: false,
        pending: false,
        flags: 0,
      });
    },

    selectGames(memberId, username, keys, heldRoleIds = [MEMBER_ROLE]) {
      const token = `mock-game-${randomUUID()}`;
      dispatch('INTERACTION_CREATE', {
        id: snowflake(),
        application_id: BOT_ID,
        type: 3, // MESSAGE_COMPONENT
        token,
        version: 1,
        guild_id: GUILD_ID,
        channel_id: TEXT_CHANNEL,
        channel: { id: TEXT_CHANNEL, type: 0 },
        data: {
          custom_id: 'two:onboarding:games',
          component_type: 3, // string select
          values: keys,
        },
        member: {
          user: userPayload(memberId, username),
          roles: heldRoleIds,
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
          pending: false,
          flags: 0,
          permissions: '0',
        },
        message: {
          id: snowflake(),
          type: 0,
          channel_id: TEXT_CHANNEL,
          author: userPayload(BOT_ID, 'two-dev-bot', true),
          content: 'welcome',
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          components: [],
        },
        app_permissions: '0',
        locale: 'en-US',
        // discord.js reads these unconditionally - a real INTERACTION_CREATE
        // always carries them, and BaseInteraction throws without them.
        entitlements: [],
        authorizing_integration_owners: {},
      });
      return token;
    },

    setMemberRoles(memberId: string, roleIds: string[]) {
      memberRoles.set(memberId, roleIds);
    },

    seedChannelHistory(channelId: string, messages: StagingVerifySeedMessage[]) {
      channelHistory.set(channelId, messages);
    },

    selectSession(memberId, username, keys, guildId = GUILD_ID) {
      dispatch('INTERACTION_CREATE', {
        id: snowflake(),
        application_id: BOT_ID,
        type: 3, // MESSAGE_COMPONENT
        token: 'mock-interaction-token',
        version: 1,
        guild_id: guildId,
        channel_id: TEXT_CHANNEL,
        channel: { id: TEXT_CHANNEL, type: 0 },
        data: {
          custom_id: 'two:onboarding:session',
          component_type: 3, // string select
          values: keys,
        },
        member: {
          user: userPayload(memberId, username),
          roles: [MEMBER_ROLE],
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
          pending: false,
          flags: 0,
          permissions: '0',
        },
        message: {
          id: snowflake(),
          type: 0,
          channel_id: TEXT_CHANNEL,
          author: userPayload(BOT_ID, 'two-dev-bot', true),
          content: 'welcome',
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          components: [],
        },
        app_permissions: '0',
        locale: 'en-US',
        entitlements: [],
        authorizing_integration_owners: {},
      });
    },

    memberRemove(memberId, username, guildId = GUILD_ID) {
      dispatch('GUILD_MEMBER_REMOVE', {
        guild_id: guildId,
        user: userPayload(memberId, username),
      });
    },

    addExistingMember(memberId: string) {
      existingMembers.add(memberId);
    },

    hasMember(memberId: string) {
      return existingMembers.has(memberId);
    },

    async close() {
      recovery?.finish(new Error('mock gateway: closed during recovery'));
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      // discord.js's REST client holds keep-alive sockets open. Without this,
      // http.close() waits on them forever and the test suite hangs.
      http.closeAllConnections();
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
