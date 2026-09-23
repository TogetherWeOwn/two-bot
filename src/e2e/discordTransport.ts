/** Staging-only, on-demand user transport. Protocol sources: docs/E2E-TRANSPORT.md.
 * No client impersonation, retry, reconnect, token logging, or administrative verbs.
 * Node 24's native fetch/WebSocket keep the reviewed boundary dependency-free.
 */
import { HarnessGuard, HarnessHalt, type Acted, type GuardOptions } from './guard.ts';
import { GatewayInbox, type GatewayEvent, type HarnessTransport } from './transport.ts';
import { assertStagingGuild } from './session.ts';
import type { FlowTargets } from './flows.ts';

const API = 'https://discord.com/api/v9';
const GATEWAY = 'wss://gateway.discord.gg/?v=9&encoding=json';
const idPattern = /^\d{17,20}$/;
const privileged = 2n | 4n | 8n | 16n | 32n | 8192n | 268435456n | 536870912n | 1099511627776n;
type ObjectData = Record<string, unknown>;
function object(value: unknown): ObjectData {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : [];
}
function isId(value: unknown): value is string { return typeof value === 'string' && idPattern.test(value); }
function bits(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TransportFailure(403);
  return BigInt(value);
}
class TransportFailure extends Error {
  readonly status: number;
  constructor(status: number) { super(`e2e transport stopped (status ${status})`); this.status = status; }
}

export interface DiscordTransportOptions {
  /** Must name the configured ticket STAFF role, even for non-ticket flows. */
  staffRoleId: string;
}
/** Test boundary only: the CLI never accepts URLs, clocks, or network overrides. */
export interface DiscordTransportIO {
  fetch: typeof globalThis.fetch;
  socket: (url: string) => WebSocket;
  guard?: GuardOptions;
  connectTimeoutMs?: number;
}
const network: DiscordTransportIO = { fetch: globalThis.fetch, socket: (url) => new WebSocket(url) };

export class DiscordHarnessTransport implements HarnessTransport {
  #token: string;
  #targets: Partial<FlowTargets>;
  #options: DiscordTransportOptions;
  #io: DiscordTransportIO;
  #guard: HarnessGuard;
  #inbox = new GatewayInbox(() => this.#stop(507));
  #socket?: WebSocket;
  #abort = new AbortController();
  #status: number | null = null;
  #ready = false;
  #busy = false;
  #sessionId = '';
  #sequence: number | null = null;
  #heartbeat?: ReturnType<typeof setInterval>;
  #firstHeartbeat?: ReturnType<typeof setTimeout>;
  #nonces = new Set<string>();
  #nonceCounter = 0n;
  #awaitingAck = false;
  #hello = false;
  #finishConnect?: (status: number) => void;
  #roles = new Map<string, bigint>();
  #memberRoles: string[] = [];
  #channels = new Map<string, number>();
  #messages = new Map<string, ObjectData>();
  #seenMessages = new Set<string>();
  #openingTicket = false;
  #ticketChannel?: string;
  #joiningVoice = false;
  #voiceChannel?: string;

  private constructor(token: string, targets: Partial<FlowTargets>, options: DiscordTransportOptions,
    io: DiscordTransportIO) {
    this.#token = token;
    this.#targets = { ...targets };
    this.#options = { ...options };
    this.#io = io;
    this.#guard = new HarnessGuard(io.guard);
  }

  static async connect(token: string, targets: Partial<FlowTargets>, options: DiscordTransportOptions,
    io: DiscordTransportIO = network): Promise<DiscordHarnessTransport> {
    assertStagingGuild(targets.guildId ?? '');
    if (!isId(targets.accountId) || !isId(options.staffRoleId)) throw new TransportFailure(400);
    for (const [key, value] of Object.entries(targets)) {
      if (key.endsWith('Id') && value !== undefined && !isId(value)) throw new TransportFailure(400);
    }
    if (!token.trim()) throw new TransportFailure(401);
    const client = new DiscordHarnessTransport(token, targets, options, io);
    try {
      const user = object(await client.#request('GET', '/users/@me'));
      if (user.id !== targets.accountId || user.bot === true) throw new TransportFailure(403);
      await client.#member();
      for (const id of [targets.welcomeChannelId, targets.selfRolePanelChannelId,
        targets.ticketPanelChannelId, targets.voiceLobbyChannelId]) {
        if (id) await client.#channel(id, id === targets.voiceLobbyChannelId ? 2 : 0, true);
      }
      await client.#connect();
      return client;
    } catch (error) {
      const status = error instanceof TransportFailure ? error.status : 503;
      client.#stop(status);
      throw new TransportFailure(status);
    }
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.#status !== null) throw new TransportFailure(this.#status);
    try {
      const response = await this.#io.fetch(`${API}${path}`, {
        method, redirect: 'error',
        headers: { Authorization: this.#token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) {
        // Never read error bodies: they may echo headers, content or a challenge.
        this.#stop(response.status);
        throw new TransportFailure(response.status);
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      const status = error instanceof TransportFailure ? error.status : this.#status ?? 503;
      this.#stop(status);
      throw new TransportFailure(status);
    }
  }

  #ordinary(roles: unknown): void {
    if (!Array.isArray(roles) || roles.some((r) => !isId(r))) throw new TransportFailure(403);
    const assigned = [this.#targets.guildId!, ...roles as string[]];
    if (assigned.includes(this.#options.staffRoleId) || assigned.some((id) =>
      !this.#roles.has(id) || (this.#roles.get(id)! & privileged) !== 0n)) throw new TransportFailure(403);
    this.#memberRoles = assigned;
  }
  async #member(): Promise<void> {
    // Do not rely on role-change gateway delivery to detect permission drift.
    const roles = await this.#request('GET', `/guilds/${this.#targets.guildId}/roles`);
    if (!Array.isArray(roles)) throw new TransportFailure(403);
    this.#roles.clear();
    for (const role of roles.map(object)) {
      if (!isId(role.id)) throw new TransportFailure(403);
      this.#roles.set(role.id, bits(role.permissions));
    }
    if (!this.#roles.has(this.#options.staffRoleId)) throw new TransportFailure(403);
    const member = object(await this.#request('GET', `/guilds/${this.#targets.guildId}/members/${this.#targets.accountId}`));
    if (object(member.user).id !== this.#targets.accountId) throw new TransportFailure(403);
    this.#ordinary(member.roles);
  }
  async #channel(id: string, type: number, initial = false): Promise<void> {
    if (!isId(id) || (!initial && this.#channels.get(id) !== type)) throw new TransportFailure(403);
    const channel = object(await this.#request('GET', `/channels/${id}`));
    if (channel.id !== id || channel.guild_id !== this.#targets.guildId || channel.type !== type) {
      throw new TransportFailure(403);
    }
    this.#ordinaryOverwrites(channel);
    this.#channels.set(id, type);
  }
  #ordinaryOverwrites(channel: ObjectData): void {
    // Channel-level overrides must not quietly turn an ordinary account into a moderator.
    for (const entry of Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : []) {
      const overwrite = object(entry);
      const applies = overwrite.id === this.#targets.accountId || this.#memberRoles.includes(String(overwrite.id));
      if (applies && (bits(overwrite.allow) & privileged) !== 0n) {
        throw new TransportFailure(403);
      }
    }
  }

  async #connect(): Promise<void> {
    const result = new Promise<number>((resolve) => { this.#finishConnect = resolve; });
    const timer = setTimeout(() => this.#stop(504), this.#io.connectTimeoutMs ?? 15_000);
    try {
      this.#socket = this.#io.socket(GATEWAY);
      // Subscribed before Identify, READY, pacing, or any flow side effect.
      this.#socket.addEventListener('message', this.#onMessage);
      this.#socket.addEventListener('close', this.#onDisconnect);
      this.#socket.addEventListener('error', this.#onDisconnect);
      const status = await result;
      if (status !== 200) throw new TransportFailure(status);
    } finally { clearTimeout(timer); this.#finishConnect = undefined; }
  }
  #send(op: number, d: unknown): void {
    if (this.#status !== null || this.#socket?.readyState !== 1) throw new TransportFailure(this.#status ?? 503);
    this.#socket.send(JSON.stringify({ op, d }));
  }
  #beat(requested = false): void {
    try {
      if (this.#awaitingAck && !requested) { this.#stop(504); return; }
      this.#awaitingAck = true;
      this.#send(1, this.#sequence);
    } catch { this.#stop(503); }
  }
  #onDisconnect = (): void => { this.#stop(503); };
  #onMessage = (event: MessageEvent): void => {
    if (this.#status !== null) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw new TransportFailure(400);
      const packet = object(JSON.parse(event.data));
      if (typeof packet.s === 'number') this.#sequence = packet.s;
      const d = object(packet.d);
      if (packet.op === 10) {
        if (this.#hello || typeof d.heartbeat_interval !== 'number' || d.heartbeat_interval < 1000) {
          throw new TransportFailure(400);
        }
        this.#hello = true;
        const interval = d.heartbeat_interval;
        this.#firstHeartbeat = setTimeout(() => {
          this.#beat();
          if (this.#status === null) this.#heartbeat = setInterval(() => this.#beat(), interval);
        }, Math.floor(Math.random() * interval));
        this.#send(2, { token: this.#token, properties: {
          os: process.platform, browser: 'two-staging-e2e', device: 'two-staging-e2e',
        }, compress: false });
      } else if (packet.op === 11) this.#awaitingAck = false;
      else if (packet.op === 1) this.#beat(true);
      else if (packet.op === 7 || packet.op === 9) this.#stop(503); // No resume or reconnect.
      else if (packet.op === 0 && packet.t === 'READY') {
        if (this.#ready || object(d.user).id !== this.#targets.accountId || typeof d.session_id !== 'string' || !d.session_id) {
          throw new TransportFailure(403);
        }
        this.#sessionId = d.session_id;
        this.#ready = true;
        this.#finishConnect?.(200);
      } else if (packet.op === 0 && this.#ready && typeof packet.t === 'string') this.#dispatch(packet.t, d);
    } catch (error) { this.#stop(error instanceof TransportFailure ? error.status : 503); }
  };

  #dispatch(name: string, d: ObjectData): void {
    const guild = d.guild_id;
    if (guild !== undefined && guild !== this.#targets.guildId) return;
    if (name.startsWith('GUILD_ROLE_') && guild === this.#targets.guildId) { this.#stop(403); return; }
    if (name === 'GUILD_MEMBER_UPDATE' && guild === this.#targets.guildId && object(d.user).id === this.#targets.accountId) {
      this.#ordinary(d.roles);
      this.#inbox.push({ name: 'guildMemberUpdate', data: {
        userId: object(d.user).id, pending: d.pending, roles: strings(d.roles),
      } });
    } else if (name === 'GUILD_MEMBER_REMOVE' && guild === this.#targets.guildId && object(d.user).id === this.#targets.accountId) {
      this.#stop(403);
    } else if (name === 'CHANNEL_CREATE' && guild === this.#targets.guildId && isId(d.id)) {
      const owns = Array.isArray(d.permission_overwrites) && d.permission_overwrites.some((entry) => {
        const o = object(entry);
        return o.id === this.#targets.accountId && o.type === 1 && (bits(o.allow) & 1024n) !== 0n;
      });
      const ticket = this.#openingTicket && !this.#ticketChannel && d.type === 0 &&
        typeof d.topic === 'string' && d.topic.startsWith('two-ticket:') && owns;
      const voice = this.#joiningVoice && !this.#voiceChannel && d.type === 2 && owns;
      if (!ticket && !voice) return;
      this.#ordinaryOverwrites(d);
      if (ticket) this.#ticketChannel = d.id;
      else this.#voiceChannel = d.id;
      this.#channels.set(d.id, d.type as number);
      this.#inbox.push({ name: 'channelCreate', data: { id: d.id, guildId: guild } });
    } else if (name === 'CHANNEL_DELETE' && guild === this.#targets.guildId && typeof d.id === 'string' && this.#channels.has(d.id)) {
      this.#channels.delete(d.id);
      this.#inbox.push({ name: 'channelDelete', data: { id: d.id } });
    } else if (name === 'VOICE_STATE_UPDATE' && guild === this.#targets.guildId && d.user_id === this.#targets.accountId &&
      (d.channel_id === null || typeof d.channel_id === 'string' && this.#channels.get(d.channel_id) === 2)) {
      this.#inbox.push({ name: 'voiceStateUpdate', data: { userId: d.user_id, channelId: d.channel_id } });
    } else if (name === 'MESSAGE_CREATE' || name === 'MESSAGE_UPDATE') {
      if (!isId(d.id) || typeof d.channel_id !== 'string' || this.#channels.get(d.channel_id) !== 0) return;
      const old = this.#messages.get(d.id);
      if (name === 'MESSAGE_UPDATE' && !old) return;
      const message = { ...old, ...d };
      const authorId = object(message.author).id;
      if (!isId(authorId)) return;
      if (typeof message.flags === 'number' && (message.flags & 64) !== 0 &&
        (typeof message.nonce !== 'string' || !this.#nonces.has(message.nonce))) return;
      const components = Array.isArray(message.components) ? message.components : [];
      const componentCustomIds = components.flatMap((row) => {
        const children = object(row).components;
        return Array.isArray(children) ? children.map((c) => object(c).custom_id).filter((c): c is string => typeof c === 'string') : [];
      });
      const normalized = { id: message.id, channelId: message.channel_id, authorId,
        content: typeof message.content === 'string' ? message.content : '',
        flags: typeof message.flags === 'number' ? message.flags : 0, componentCustomIds };
      const key = JSON.stringify(normalized);
      if (this.#seenMessages.has(key)) return;
      if (this.#seenMessages.size >= 256) { this.#stop(507); return; }
      this.#seenMessages.add(key);
      this.#messages.set(d.id, message);
      // Only actual gateway message packets, including updates to deferred replies.
      // INTERACTION_SUCCESS and REST 204 are not replies and never enter this inbox.
      this.#inbox.push({ name: 'messageCreate', data: normalized });
    }
  }

  async #act<T>(kind: 'message' | 'reaction' | 'button' | 'voice', value: T,
    action: () => Promise<T>): Promise<Acted<T>> {
    if (this.#status !== null || !this.#ready) return { status: this.#status ?? 503, value };
    if (this.#busy) { this.#stop(409); return { status: 409, value }; }
    this.#busy = true;
    try {
      const result = await this.#guard.act(kind, 'transport', async () => {
        // Recheck after pacing: disconnect/cancellation may have happened during sleep.
        if (this.#status !== null) throw new TransportFailure(this.#status);
        await this.#member();
        return { status: 200, value: await action() };
      });
      return { status: 200, value: result };
    } catch (error) {
      const status = error instanceof TransportFailure ? error.status : error instanceof HarnessHalt ? 429 : 503;
      this.#stop(status);
      return { status, value };
    } finally { this.#busy = false; }
  }

  acceptRules(): Promise<Acted<void>> {
    return this.#act('message', undefined, async () => {
      const form = object(await this.#request('GET', `/guilds/${this.#targets.guildId}/member-verification`));
      if (typeof form.version !== 'string' || !Array.isArray(form.form_fields) || !form.form_fields.length) throw new TransportFailure(501);
      const fields = form.form_fields.map((field) => {
        const f = object(field);
        if (f.field_type !== 'TERMS') throw new TransportFailure(501);
        return { ...f, response: true };
      });
      await this.#request('PUT', `/guilds/${this.#targets.guildId}/requests/@me`, { version: form.version, form_fields: fields });
    });
  }
  sendMessage(channelId: string, content: string): Promise<Acted<{ id: string }>> {
    return this.#act('message', { id: '' }, async () => {
      await this.#channel(channelId, 0);
      if (content.length > 2000 || !content) throw new TransportFailure(400);
      const message = object(await this.#request('POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } }));
      if (!isId(message.id)) throw new TransportFailure(502);
      return { id: message.id };
    });
  }
  addReaction(channelId: string, messageId: string, emoji: string): Promise<Acted<void>> {
    return this.#act('reaction', undefined, async () => {
      if (channelId !== this.#targets.selfRolePanelChannelId || messageId !== this.#targets.selfRolePanelMessageId ||
        emoji !== this.#targets.selfRoleEmoji || !isId(messageId)) throw new TransportFailure(403);
      await this.#channel(channelId, 0);
      await this.#request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    });
  }
  clickButton(channelId: string, messageId: string, customId: string): Promise<Acted<void>> {
    return this.#act('button', undefined, async () => {
      const open = customId === 'two:tickets:open' && channelId === this.#targets.ticketPanelChannelId && messageId === this.#targets.ticketPanelMessageId;
      const control = channelId === this.#ticketChannel && ['two:tickets:claim', 'two:tickets:close'].includes(customId);
      if ((!open && !control) || !isId(messageId)) throw new TransportFailure(403);
      await this.#channel(channelId, 0);
      const message = open ? object(await this.#request('GET', `/channels/${channelId}/messages/${messageId}`)) : this.#messages.get(messageId);
      if (!message || message.id !== messageId || message.channel_id !== channelId ||
        object(message.author).id !== this.#targets.ticketBotId || object(message.author).bot !== true) throw new TransportFailure(403);
      const rows = Array.isArray(message.components) ? message.components : [];
      const button = rows.flatMap((r) => Array.isArray(object(r).components) ? object(r).components as unknown[] : [])
        .map(object).find((c) => c.type === 2 && c.custom_id === customId && c.disabled !== true);
      if (!button) throw new TransportFailure(403);
      if (open) this.#openingTicket = true;
      const nonce = (((BigInt(Date.now()) - 1420070400000n) << 22n) + this.#nonceCounter++).toString();
      this.#nonces.add(nonce);
      await this.#request('POST', '/interactions', { type: 3, application_id: this.#targets.ticketBotId,
        guild_id: this.#targets.guildId, channel_id: channelId, message_id: messageId,
        nonce, message_flags: typeof message.flags === 'number' ? message.flags : 0,
        session_id: this.#sessionId, data: { component_type: 2, custom_id: customId },
      });
    });
  }
  joinVoice(channelId: string): Promise<Acted<void>> {
    return this.#act('voice', undefined, async () => {
      if (channelId !== this.#targets.voiceLobbyChannelId) throw new TransportFailure(403);
      await this.#channel(channelId, 2);
      this.#joiningVoice = true;
      this.#send(4, { guild_id: this.#targets.guildId, channel_id: channelId, self_mute: true, self_deaf: true });
    });
  }
  leaveVoice(): Promise<Acted<void>> {
    return this.#act('voice', undefined, async () => {
      if (!this.#joiningVoice) throw new TransportFailure(403);
      this.#send(4, { guild_id: this.#targets.guildId, channel_id: null, self_mute: true, self_deaf: true });
    });
  }
  awaitEvent(name: string, pred: (e: GatewayEvent) => boolean, timeoutMs: number,
    signal?: AbortSignal): Promise<Acted<GatewayEvent | null>> {
    return this.#inbox.wait(name, pred, timeoutMs, signal);
  }
  #stop(status: number): void {
    if (this.#status !== null) return;
    this.#status = status;
    this.#token = '';
    this.#sessionId = '';
    this.#abort.abort();
    clearInterval(this.#heartbeat);
    clearTimeout(this.#firstHeartbeat);
    this.#nonces.clear();
    this.#inbox.close(status);
    this.#finishConnect?.(status);
    this.#messages.clear();
    this.#seenMessages.clear();
    if (this.#socket) {
      this.#socket.removeEventListener('message', this.#onMessage);
      this.#socket.removeEventListener('close', this.#onDisconnect);
      this.#socket.removeEventListener('error', this.#onDisconnect);
      // The browser-compatible socket may still emit a late error while closing.
      this.#socket.addEventListener('error', () => {});
      try { this.#socket.close(); } catch { /* Already closed: never log library errors. */ }
    }
  }
  close(): void { this.#stop(503); }
}
