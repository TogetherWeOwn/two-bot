import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordHarnessTransport, type DiscordTransportIO } from '../src/e2e/discordTransport.ts';
import { TWO_STAGING_GUILD_ID as guildId } from '../src/staging/spec.ts';

/**
 * Record/replay round-trip for the staging e2e transport (TOG-9133).
 *
 * One hermetic run drives connect + message + ticket-button ephemeral reply +
 * voice join/move/leave against a fake fetch/WebSocket boundary while recording
 * every request/response pair, every injected gateway packet and every redacted
 * outbound opcode. A second, fresh transport then replays that recording: fetch
 * responses are served from the log in order, injected packets come from the log
 * with the fresh interaction nonce substituted, and every step result, request
 * shape and outbound opcode must match the recorded run.
 *
 * Hermetic by construction: no token, no guild, no socket leaves this file. The
 * canary token below must not appear anywhere in the serialized recording, and
 * the Identify packet is stored with its credential redacted — the artifact stays
 * publishable without redaction, the same property transport.ts requires of
 * transcripts.
 */

const accountId = '100000000000000001';
const staffRoleId = '100000000000000002';
const textId = '100000000000000003';
const panelId = '100000000000000004';
const botId = '100000000000000005';
const lobbyId = '100000000000000006';
const voiceId = '100000000000000009';
const replyId = '100000000000000010';
const token = 'test-only-replay-canary';
const targets = { guildId, accountId, welcomeChannelId: textId,
  selfRolePanelChannelId: textId, selfRolePanelMessageId: panelId, selfRoleEmoji: '✅',
  ticketPanelChannelId: textId, ticketPanelMessageId: panelId, ticketBotId: botId, voiceLobbyChannelId: lobbyId };
// Far-future heartbeat: the timer must exist (honest Identify) without firing a
// heartbeat opcode mid-run and breaking the outbound comparison.
const HEARTBEAT_INTERVAL = 3_600_000;

interface FetchEntry { method: string; path: string; body: unknown; }
interface Recording {
  fetches: FetchEntry[];
  responses: Array<{ status: number; json: unknown }>;
  injected: Array<{ t: string; d: unknown }>;
  outbound: Array<{ op: number; d: unknown }>;
  steps: Array<{ name: string; result: unknown }>;
}

class Socket extends EventTarget {
  readyState = 1;
  sent: Array<{ op: number; d: Record<string, unknown> }> = [];
  closed = 0;
  send(body: string): void {
    const packet = JSON.parse(body);
    this.sent.push(packet);
    if (packet.op === 2) this.dispatch('READY', { user: { id: accountId }, session_id: 'offline-session' });
  }
  packet(packet: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }
  dispatch(t: string, d: unknown): void { this.packet({ op: 0, t, d, s: this.sent.length + 1 }); }
  close(): void { this.closed++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

const channelsMap = () => new Map<string, Record<string, unknown>>([
  [textId, { id: textId, guild_id: guildId, type: 0 }],
  [lobbyId, { id: lobbyId, guild_id: guildId, type: 2 }],
]);
const panelMessage = () => ({ id: panelId, channel_id: textId, guild_id: guildId,
  author: { id: botId, bot: true }, content: '', flags: 0,
  components: [{ type: 1, components: [{ type: 2, custom_id: 'two:tickets:open' }] }],
});
async function stubResponse(channels: Map<string, Record<string, unknown>>, method: string, path: string): Promise<Response> {
  if (path === '/users/@me') return Response.json({ id: accountId });
  if (path.endsWith('/roles')) return Response.json([{ id: guildId, permissions: '0' }, { id: staffRoleId, permissions: '0' }]);
  if (path.includes('/members/')) return Response.json({ user: { id: accountId }, roles: [] });
  if (path === `/channels/${textId}/messages/${panelId}`) return Response.json(panelMessage());
  if (method === 'GET' && path.startsWith('/channels/')) return Response.json(channels.get(path.split('/')[2]) ?? {});
  if (method === 'POST' && path.endsWith('/messages')) return Response.json({ id: replyId });
  return new Response(null, { status: 204 });
}
const socketIo = (socket: Socket): DiscordTransportIO['socket'] => (url) => {
  assert.equal(url, 'wss://gateway.discord.gg/?v=9&encoding=json');
  queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: HEARTBEAT_INTERVAL } }));
  return socket as unknown as WebSocket;
};
/** The Identify packet carries the credential; the log keeps its shape, not its secret. */
function redact(packet: { op: number; d: unknown }): { op: number; d: unknown } {
  const clone = JSON.parse(JSON.stringify(packet)) as { op: number; d: Record<string, unknown> };
  if (clone.op === 2) clone.d.token = '[redacted]';
  return clone;
}
function remapNonce(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => remapNonce(v, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapNonce(v, from, to)]));
  }
  return value;
}
const interactionsNonce = (fetches: FetchEntry[]): string => {
  const body = fetches.find((f) => f.path === '/interactions')?.body as { nonce?: unknown };
  assert.equal(typeof body?.nonce, 'string');
  return body.nonce as string;
};

function makeRecordWorld(rec: Recording) {
  const socket = new Socket();
  const channels = channelsMap();
  const origSend = socket.send.bind(socket);
  socket.send = (body: string) => { rec.outbound.push(redact(JSON.parse(body))); origSend(body); };
  const io: DiscordTransportIO = {
    guard: { minGapMs: 0, jitterMs: 0 },
    socket: socketIo(socket),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace('/api/v9', '');
      const method = init?.method ?? 'GET';
      assert.equal(new Headers(init?.headers).get('Authorization'), token);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const res = await stubResponse(channels, method, path);
      let json: unknown = null;
      try { json = await res.clone().json(); } catch { json = null; }
      rec.fetches.push({ method, path, body });
      rec.responses.push({ status: res.status, json });
      return res;
    },
  };
  return { socket, io, connect: () => DiscordHarnessTransport.connect(token, { ...targets }, { staffRoleId }, io) };
}

function makeReplayWorld(rec: Recording) {
  const socket = new Socket();
  const seen: FetchEntry[] = [];
  const outbound: Array<{ op: number; d: unknown }> = [];
  let fetchIndex = 0;
  const origSend = socket.send.bind(socket);
  socket.send = (body: string) => { outbound.push(redact(JSON.parse(body))); origSend(body); };
  const io: DiscordTransportIO = {
    guard: { minGapMs: 0, jitterMs: 0 },
    socket: socketIo(socket),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace('/api/v9', '');
      const method = init?.method ?? 'GET';
      assert.equal(new Headers(init?.headers).get('Authorization'), token);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const i = fetchIndex++;
      assert.ok(i < rec.fetches.length, `unexpected fetch ${method} ${path}`);
      assert.equal(method, rec.fetches[i].method);
      assert.equal(path, rec.fetches[i].path);
      seen.push({ method, path, body });
      const r = rec.responses[i];
      return r.status === 204 ? new Response(null, { status: 204 }) : Response.json(r.json);
    },
  };
  return { socket, io, seen, outbound,
    connect: () => DiscordHarnessTransport.connect(token, { ...targets }, { staffRoleId }, io) };
}

const ephemeralCreate = (nonce: string) => ({ id: replyId, channel_id: textId, guild_id: guildId,
  author: { id: botId, bot: true }, content: '', flags: 64 | 128, nonce,
  components: [{ type: 1, components: [{ type: 2, custom_id: 'two:tickets:open' }] }],
});
const ephemeralUpdate = () => ({ id: replyId, channel_id: textId, flags: 64, content: 'actual reply' });
const voiceSpawn = () => ({ id: voiceId, guild_id: guildId, type: 2,
  permission_overwrites: [{ id: accountId, type: 1, allow: '1024' }] });
const voiceMove = () => ({ guild_id: guildId, user_id: accountId, channel_id: voiceId });

async function runScenario(transport: DiscordHarnessTransport,
  io: { nonce(): string; inject(t: string, d: unknown): void },
  steps: Array<{ name: string; result: unknown }>): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    steps.push({ name, result: await fn() });
  };
  await step('sendMessage', () => transport.sendMessage(textId, 'hello replay'));
  await step('clickButton', () => transport.clickButton(textId, panelId, 'two:tickets:open'));
  io.inject('MESSAGE_CREATE', ephemeralCreate(io.nonce()));
  io.inject('MESSAGE_UPDATE', ephemeralUpdate());
  await step('awaitReply', () => transport.awaitEvent('messageCreate', (e) => e.data.content === 'actual reply', 1000));
  await step('joinVoice', () => transport.joinVoice(lobbyId));
  io.inject('CHANNEL_CREATE', voiceSpawn());
  io.inject('VOICE_STATE_UPDATE', voiceMove());
  await step('awaitVoiceChannel', () => transport.awaitEvent('channelCreate', (e) => e.data.id === voiceId, 1000));
  await step('awaitVoiceState', () => transport.awaitEvent('voiceStateUpdate', () => true, 1000));
  await step('leaveVoice', () => transport.leaveVoice());
}

test('record/replay round-trip: identical steps, requests and outbound on a token-free recording', async () => {
  const rec: Recording = { fetches: [], responses: [], injected: [], outbound: [], steps: [] };
  const record = makeRecordWorld(rec);
  const recorded = await record.connect();
  try {
    await runScenario(recorded, {
      nonce: () => interactionsNonce(rec.fetches),
      inject: (t, d) => { rec.injected.push({ t, d: JSON.parse(JSON.stringify(d)) }); record.socket.dispatch(t, d); },
    }, rec.steps);
  } finally { recorded.close(); }
  assert.equal(record.socket.closed, 1);
  assert.ok(rec.steps.every((s) => (s.result as { status: number }).status === 200));

  // The recording is the artifact: it must serialize and carry no credential.
  const artifact = JSON.parse(JSON.stringify(rec)) as Recording;
  assert.ok(!JSON.stringify(artifact).includes(token), 'recording must not contain the token');
  assert.ok(artifact.outbound.some((p) => p.op === 2), 'identify must be recorded (redacted)');
  assert.ok(artifact.outbound.every((p) => !JSON.stringify(p).includes(token)));
  const recordedNonce = interactionsNonce(artifact.fetches);
  assert.match(recordedNonce, /^\d+$/);

  const replay = makeReplayWorld(artifact);
  const replaySteps: Array<{ name: string; result: unknown }> = [];
  let injectIndex = 0;
  const fresh = await replay.connect();
  try {
    await runScenario(fresh, {
      nonce: () => interactionsNonce(replay.seen),
      inject: (t, d) => {
        const next = artifact.injected[injectIndex++];
        assert.equal(next.t, t);
        // The recording must reproduce exactly the packet the scenario needs,
        // up to the fresh run's interaction nonce.
        const packet = remapNonce(next.d, recordedNonce, interactionsNonce(replay.seen));
        assert.deepEqual(packet, d);
        replay.socket.dispatch(t, packet);
      },
    }, replaySteps);
  } finally { fresh.close(); }

  // `value: undefined` does not survive the JSON artifact round-trip, so compare
  // the replay steps in their serialized form — the artifact is the contract.
  assert.deepEqual(JSON.parse(JSON.stringify(replaySteps)), artifact.steps);
  assert.deepEqual(
    replay.seen.map(({ method, path }) => ({ method, path })),
    artifact.fetches.map(({ method, path }) => ({ method, path })));
  const replayNonce = interactionsNonce(replay.seen);
  assert.match(replayNonce, /^\d+$/);
  assert.deepEqual(
    replay.seen.map((s) => remapNonce(s.body, replayNonce, 'NONCE')),
    artifact.fetches.map((f) => remapNonce(f.body, recordedNonce, 'NONCE')));
  assert.deepEqual(replay.outbound, artifact.outbound);
  assert.ok(!JSON.stringify(fresh).includes(token), 'transport must not leak the token');
});
