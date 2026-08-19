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

const GUILD_ID = '900000000000000001';
const BOT_ID = '900000000000000002';
const EVERYONE_ROLE = GUILD_ID; // @everyone role id == guild id, as on real Discord
const TEXT_CHANNEL = '900000000000000010';
const VOICE_CHANNEL = '900000000000000011';

export interface MockInvite {
  code: string;
  uses: number;
  inviterId: string;
}

export interface MockDiscord {
  port: number;
  apiBase: string;
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  /** Mutable - bump `uses` before firing a join to test attribution. */
  invites: MockInvite[];
  /** Resolves once a client has completed IDENTIFY and been sent READY. */
  waitForReady(timeoutMs?: number): Promise<void>;
  dispatch(type: string, data: unknown): void;
  memberJoin(memberId: string, username: string): void;
  message(memberId: string, channelId?: string): void;
  voiceJoin(memberId: string, channelId?: string): void;
  close(): Promise<void>;
}

function guildPayload() {
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
    roles: [
      {
        id: EVERYONE_ROLE,
        name: '@everyone',
        color: 0,
        hoist: false,
        position: 0,
        permissions: '104324673',
        managed: false,
        mentionable: false,
        flags: 0,
      },
    ],
    channels: [
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
        id: VOICE_CHANNEL,
        type: 2,
        guild_id: GUILD_ID,
        name: 'Lobby',
        position: 1,
        permission_overwrites: [],
        bitrate: 64000,
        user_limit: 0,
      },
    ],
    threads: [],
    members: [],
    presences: [],
    voice_states: [],
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

export async function startMockDiscord(): Promise<MockDiscord> {
  const invites: MockInvite[] = [{ code: 'twodev01', uses: 5, inviterId: '900000000000000099' }];

  let seq = 0;
  let socket: WebSocket | null = null;
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((res) => {
    readyResolve = res;
  });

  const http: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (body: unknown, status = 200) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };

    if (url.startsWith('/api/v10/gateway/bot')) {
      const port = (http.address() as AddressInfo).port;
      return json({
        url: `ws://127.0.0.1:${port}/gw`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 999, reset_after: 60_000, max_concurrency: 1 },
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

      if (msg.op === 1) {
        send(ws, { op: 11, d: null, s: null, t: null }); // heartbeat ack
        return;
      }

      if (msg.op === 2) {
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
          send(ws, { op: 0, s: ++seq, t: 'GUILD_CREATE', d: guildPayload() });
          readyResolve?.();
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
    waitForReady: (timeoutMs = 15_000) =>
      Promise.race([
        readyPromise,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('mock gateway: client never became ready')), timeoutMs),
        ),
      ]),
    dispatch,
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
    voiceJoin(memberId, channelId = VOICE_CHANNEL) {
      dispatch('VOICE_STATE_UPDATE', {
        guild_id: GUILD_ID,
        channel_id: channelId,
        user_id: memberId,
        member: {
          user: userPayload(memberId, 'member'),
          roles: [],
          joined_at: new Date().toISOString(),
          deaf: false,
          mute: false,
          flags: 0,
        },
        session_id: 'mock-voice',
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        self_video: false,
        suppress: false,
        request_to_speak_timestamp: null,
      });
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      // discord.js's REST client holds keep-alive sockets open. Without this,
      // http.close() waits on them forever and the test suite hangs.
      http.closeAllConnections();
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
