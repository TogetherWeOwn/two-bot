import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GatewayInbox } from '../src/e2e/transport.ts';
import { DiscordHarnessTransport, type DiscordTransportIO } from '../src/e2e/discordTransport.ts';
import { HarnessGuard } from '../src/e2e/guard.ts';
import { TWO_STAGING_GUILD_ID as guildId, LIVE_GUILD_ID } from '../src/staging/spec.ts';

const accountId = '100000000000000001';
const staffRoleId = '100000000000000002';
const textId = '100000000000000003';
const panelId = '100000000000000004';
const botId = '100000000000000005';
const lobbyId = '100000000000000006';
const ticketId = '100000000000000007';
const controlsId = '100000000000000008';
const voiceId = '100000000000000009';
const replyId = '100000000000000010';
const token = 'test-only-secret-canary';
const targets = { guildId, accountId, welcomeChannelId: textId,
  selfRolePanelChannelId: textId, selfRolePanelMessageId: panelId, selfRoleEmoji: '✅',
  ticketPanelChannelId: textId, ticketPanelMessageId: panelId, ticketBotId: botId, voiceLobbyChannelId: lobbyId };
const button = (custom_id: string) => ({ type: 2, custom_id });
const message = (id = panelId, channel_id = textId, ids = ['two:tickets:open']) => ({
  id, channel_id, guild_id: guildId, author: { id: botId, bot: true }, content: '', flags: 0,
  components: [{ type: 1, components: ids.map(button) }],
});

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
function fixture() {
  const socket = new Socket();
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const channels = new Map<string, Record<string, unknown>>([
    [textId, { id: textId, guild_id: guildId, type: 0 }],
    [lobbyId, { id: lobbyId, guild_id: guildId, type: 2 }],
  ]);
  let hook: ((method: string, path: string, body: Record<string, unknown>) => Response | undefined) | undefined;
  const io: DiscordTransportIO = {
    guard: { minGapMs: 0, jitterMs: 0 },
    socket: (url) => {
      assert.equal(url, 'wss://gateway.discord.gg/?v=9&encoding=json');
      queueMicrotask(() => socket.packet({ op: 10, d: { heartbeat_interval: 45_000 } }));
      return socket as unknown as WebSocket;
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace('/api/v9', '');
      const method = init?.method ?? 'GET';
      assert.equal(new Headers(init?.headers).get('Authorization'), token);
      assert.equal(init?.redirect, 'error');
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ method, path, body });
      const overridden = hook?.(method, path, body);
      if (overridden) return overridden;
      if (path === '/users/@me') return Response.json({ id: accountId });
      if (path.endsWith('/roles')) return Response.json([{ id: guildId, permissions: '0' }, { id: staffRoleId, permissions: '0' }]);
      if (path.includes('/members/')) return Response.json({ user: { id: accountId }, roles: [] });
      if (path.endsWith('/member-verification')) return Response.json({ version: 'v1', form_fields: [{ field_type: 'TERMS', values: ['Staging rules'] }] });
      if (path === `/channels/${textId}/messages/${panelId}`) return Response.json(message());
      if (method === 'GET' && path.startsWith('/channels/')) return Response.json(channels.get(path.split('/')[2]) ?? {});
      if (method === 'POST' && path.endsWith('/messages')) return Response.json({ id: replyId });
      return new Response(null, { status: 204 });
    },
  };
  return { socket, requests, channels, io, setHook: (fn: typeof hook) => { hook = fn; },
    connect: (extra = {}) => DiscordHarnessTransport.connect(token, { ...targets, ...extra }, { staffRoleId }, io) };
}
const event = (id: string) => ({ name: 'channelCreate', data: { id } });

test('inbox preserves unmatched events, consumes each match once, FIFO including active waits', async () => {
  const inbox = new GatewayInbox();
  inbox.push(event('other')); inbox.push(event('match'));
  assert.equal((await inbox.wait('channelCreate', (e) => e.data.id === 'match', 0)).value?.data.id, 'match');
  assert.equal((await inbox.wait('channelCreate', (e) => e.data.id === 'match', 0)).status, 504);
  assert.equal((await inbox.wait('channelCreate', () => true, 0)).value?.data.id, 'other');
  const first = inbox.wait('channelCreate', () => true, 100);
  const second = inbox.wait('channelCreate', () => true, 10);
  inbox.push(event('after-wait'));
  assert.equal((await first).value?.data.id, 'after-wait');
  assert.equal((await second).status, 504);
  inbox.close();
});
test('inbox cancellation, timeout, invalid timeouts, predicate error, overflow and close settle waits', async () => {
  const inbox = new GatewayInbox();
  const abort = new AbortController();
  const pending = inbox.wait('channelCreate', () => true, 1000, abort.signal);
  abort.abort(new Error(token));
  assert.deepEqual(await pending, { status: 499, value: null });
  assert.equal((await inbox.wait('channelCreate', () => true, 1000, abort.signal)).status, 499);
  assert.equal((await inbox.wait('channelCreate', () => true, NaN)).status, 400);
  inbox.push(event('retained'));
  assert.equal((await inbox.wait('channelCreate', () => { throw new Error(token); }, 1)).status, 500);
  assert.equal((await inbox.wait('channelCreate', () => true, 1)).status, 200);
  const waiting = inbox.wait('never', () => true, 1000);
  inbox.close(); inbox.close();
  assert.equal((await waiting).status, 503);
  assert.equal((await inbox.wait('never', () => true, 1)).status, 503);
  const bounded = new GatewayInbox();
  for (let i = 0; i <= 256; i++) bounded.push(event(String(i)));
  assert.equal((await bounded.wait('channelCreate', () => true, 0)).status, 507);
});
test('real adapter normalizes events received during guard pacing, not just scripted flow events', async (t) => {
  const f = fixture(); const transport = await f.connect(); t.after(() => transport.close());
  let now = 0;
  const guard = new HarnessGuard({ random: () => 0, clock: { now: () => now,
    sleep: async (ms) => { now += ms; f.socket.dispatch('GUILD_MEMBER_UPDATE', { guild_id: guildId, user: { id: accountId }, roles: [], pending: false }); },
  } });
  await guard.act('message', 'rules', () => transport.acceptRules());
  const e = await guard.act('observe', 'pending', () => transport.awaitEvent('guildMemberUpdate', (e) => e.data.pending === false, 10));
  assert.equal(e?.data.userId, accountId);
  assert.ok(now >= 2000);
  assert.equal((await transport.awaitEvent('guildMemberUpdate', () => true, 0)).status, 504);
});
test('adapter has one honest Identify, no reconnect, and closes all active observations', async () => {
  const f = fixture(); const transport = await f.connect();
  const identify = f.socket.sent.find((p) => p.op === 2)!;
  assert.deepEqual(identify.d.properties, { os: process.platform, browser: 'two-staging-e2e', device: 'two-staging-e2e' });
  const waiting = transport.awaitEvent('messageCreate', () => true, 1000);
  f.socket.packet({ op: 7, d: null });
  assert.equal((await waiting).status, 503);
  assert.equal((await transport.sendMessage(textId, 'never')).status, 503);
  assert.equal(f.socket.sent.filter((p) => p.op === 2).length, 1);
  transport.close(); assert.equal(f.socket.closed, 1);
  assert.ok(!JSON.stringify(transport).includes(token));
});
for (const code of [401, 403, 429]) test(`HTTP ${code} stops with no body read, retry, or subsequent request`, async () => {
  const f = fixture(); const transport = await f.connect();
  f.setHook((method) => method === 'POST' ? new Response(token, { status: code }) : undefined);
  assert.equal((await transport.sendMessage(textId, 'one')).status, code);
  const count = f.requests.length;
  assert.equal((await transport.sendMessage(textId, 'two')).status, code);
  assert.equal(f.requests.length, count);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
  transport.close();
});
test('raw network errors, disconnect reasons and errors during connect never escape', async () => {
  const f = fixture(); const transport = await f.connect();
  f.setHook(() => { throw new Error(token); });
  assert.deepEqual(await transport.sendMessage(textId, 'one'), { status: 503, value: { id: '' } });
  f.socket.dispatchEvent(Object.assign(new Event('error'), { message: token }));
  transport.close();
  const broken = fixture(); broken.io.socket = () => { throw new Error(token); };
  await assert.rejects(broken.connect(), (e: Error) => !String(e).includes(token) && /status 503/.test(String(e)));
});
test('connect rejects wrong guild/account, bot account, staff and privileged roles before socket creation', async () => {
  const f = fixture();
  await assert.rejects(f.connect({ guildId: LIVE_GUILD_ID })); assert.equal(f.requests.length, 0);
  await assert.rejects(f.connect({ accountId: 'path/injection' })); assert.equal(f.requests.length, 0);
  for (const user of [{ id: botId }, { id: accountId, bot: true }]) {
    const f = fixture(); f.setHook((_m, p) => p === '/users/@me' ? Response.json(user) : undefined);
    await assert.rejects(f.connect()); assert.equal(f.socket.sent.length, 0);
  }
  const staff = fixture(); staff.setHook((_m, p) => p.includes('/members/') ? Response.json({ user: { id: accountId }, roles: [staffRoleId] }) : undefined);
  await assert.rejects(staff.connect()); assert.equal(staff.socket.sent.length, 0);
  const admin = fixture(); admin.setHook((_m, p) => p.endsWith('/roles') ? Response.json([{ id: guildId, permissions: '8' }, { id: staffRoleId, permissions: '0' }]) : undefined);
  await assert.rejects(admin.connect());
});
test('configured and discovered channels are revalidated before every action', async () => {
  const f = fixture(); const transport = await f.connect();
  f.channels.set(textId, { id: textId, guild_id: LIVE_GUILD_ID, type: 0 });
  assert.equal((await transport.sendMessage(textId, 'no')).status, 403);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 0);
  transport.close();
  const other = fixture(); const t = await other.connect();
  assert.equal((await t.sendMessage(ticketId, 'not observed')).status, 403); t.close();
});
test('discovery excludes unrelated guild, account, type and pre-action channel events', async (t) => {
  const f = fixture(); const transport = await f.connect(); t.after(() => transport.close());
  const channel = { id: ticketId, guild_id: guildId, type: 0, topic: 'two-ticket:offline',
    permission_overwrites: [{ id: accountId, type: 1, allow: '1024' }] };
  f.socket.dispatch('CHANNEL_CREATE', channel);
  assert.equal((await transport.awaitEvent('channelCreate', () => true, 0)).status, 504);
  await transport.clickButton(textId, panelId, 'two:tickets:open');
  for (const wrong of [{ guild_id: LIVE_GUILD_ID }, { permission_overwrites: [] }, { type: 2 }, { topic: 'unrelated' }]) f.socket.dispatch('CHANNEL_CREATE', { ...channel, ...wrong });
  assert.equal((await transport.awaitEvent('channelCreate', () => true, 0)).status, 504);
  f.socket.dispatch('CHANNEL_CREATE', channel); f.channels.set(ticketId, channel);
  assert.equal((await transport.awaitEvent('channelCreate', () => true, 0)).value?.data.id, ticketId);
  f.socket.dispatch('MESSAGE_CREATE', message(controlsId, ticketId, ['two:tickets:claim', 'two:tickets:close']));
  f.channels.set(ticketId, { ...channel, guild_id: LIVE_GUILD_ID });
  assert.equal((await transport.clickButton(ticketId, controlsId, 'two:tickets:claim')).status, 403);
  assert.equal(f.requests.filter((r) => r.path === '/interactions').length, 1);
});
test('button POST envelope and correlated gateway ephemeral update; HTTP 204/INTERACTION_SUCCESS are not proof', async (t) => {
  const f = fixture(); const transport = await f.connect(); t.after(() => transport.close());
  assert.equal((await transport.clickButton(textId, panelId, 'two:tickets:open')).status, 200);
  const invoke = f.requests.find((r) => r.path === '/interactions')!.body;
  assert.equal(invoke.session_id, 'offline-session'); assert.equal(invoke.message_flags, 0);
  assert.match(String(invoke.nonce), /^\d+$/);
  assert.deepEqual(invoke.data, { component_type: 2, custom_id: 'two:tickets:open' });
  f.socket.dispatch('INTERACTION_SUCCESS', { nonce: invoke.nonce });
  assert.equal((await transport.awaitEvent('messageCreate', () => true, 0)).status, 504);
  f.socket.dispatch('MESSAGE_CREATE', { ...message(replyId), nonce: 'unrelated', flags: 64, content: 'wrong' });
  assert.equal((await transport.awaitEvent('messageCreate', () => true, 0)).status, 504);
  const initial = { ...message(replyId), nonce: invoke.nonce, flags: 64 | 128 };
  f.socket.dispatch('MESSAGE_CREATE', initial);
  f.socket.dispatch('MESSAGE_UPDATE', { id: replyId, channel_id: textId, flags: 64, content: 'actual reply' });
  const e = await transport.awaitEvent('messageCreate', (e) => e.data.content === 'actual reply', 10);
  assert.equal(e.value?.data.authorId, botId); assert.equal(e.value?.data.flags, 64);
  f.socket.dispatch('MESSAGE_UPDATE', { id: replyId, channel_id: textId, flags: 64, content: 'actual reply' });
  assert.equal((await transport.awaitEvent('messageCreate', (e) => e.data.content === 'actual reply', 0)).status, 504);
  assert.equal((await transport.awaitEvent('messageCreate', (e) => e.data.flags === 192, 0)).status, 200);
});
test('voice sends scoped opcode 4, observes owned spawn/move/delete; leave needs prior join', async (t) => {
  const f = fixture(); const transport = await f.connect(); t.after(() => transport.close());
  await transport.joinVoice(lobbyId);
  f.socket.dispatch('CHANNEL_CREATE', { id: voiceId, guild_id: guildId, type: 2, permission_overwrites: [{ id: accountId, type: 1, allow: '1024' }] });
  f.socket.dispatch('VOICE_STATE_UPDATE', { guild_id: guildId, user_id: accountId, channel_id: voiceId });
  assert.equal((await transport.awaitEvent('channelCreate', () => true, 0)).value?.data.id, voiceId);
  assert.equal((await transport.awaitEvent('voiceStateUpdate', () => true, 0)).value?.data.channelId, voiceId);
  await transport.leaveVoice();
  f.socket.dispatch('CHANNEL_DELETE', { id: voiceId, guild_id: guildId });
  assert.equal((await transport.awaitEvent('channelDelete', () => true, 0)).value?.data.id, voiceId);
  assert.deepEqual(f.socket.sent.filter((p) => p.op === 4).map((p) => p.d), [
    { guild_id: guildId, channel_id: lobbyId, self_mute: true, self_deaf: true },
    { guild_id: guildId, channel_id: null, self_mute: true, self_deaf: true },
  ]);
});
test('direct transport writes retain spacing, jitter and single-digit message budget', async () => {
  const f = fixture(); let now = 0; const sleeps: number[] = [];
  f.io.guard = { random: () => 0.5, clock: { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } } };
  const transport = await f.connect();
  for (let i = 0; i < 9; i++) assert.equal((await transport.sendMessage(textId, 'bounded')).status, 200);
  assert.equal((await transport.sendMessage(textId, 'tenth')).status, 429);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 9);
  assert.ok(sleeps.every((ms) => ms === 2750)); assert.equal(sleeps.length, 8);
  transport.close();
});
test('unknown buttons, wrong reaction targets, unsupported screening and permission changes fail closed', async () => {
  for (const action of [
    (t: DiscordHarnessTransport) => t.clickButton(textId, panelId, 'unreviewed'),
    (t: DiscordHarnessTransport) => t.addReaction(textId, replyId, '✅'),
    (t: DiscordHarnessTransport) => t.joinVoice(textId),
    (t: DiscordHarnessTransport) => t.leaveVoice(),
  ]) {
    const f = fixture(); const t = await f.connect(); assert.equal((await action(t)).status, 403); t.close();
  }
  const f = fixture(); const t = await f.connect();
  f.setHook((_m, p) => p.endsWith('/member-verification') ? Response.json({ version: 'v', form_fields: [{ field_type: 'TEXT_INPUT' }] }) : undefined);
  assert.equal((await t.acceptRules()).status, 501); t.close();
  const change = fixture(); const client = await change.connect();
  change.socket.dispatch('GUILD_MEMBER_UPDATE', { guild_id: guildId, user: { id: accountId }, roles: [staffRoleId] });
  assert.equal((await client.sendMessage(textId, 'never')).status, 403); client.close();
});
test('CLI dry-run works without credential and incomplete live configuration refuses before network', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const dry = spawnSync(process.execPath, ['scripts/e2e-harness.ts', '--dry-run', '--no-pace', '--flow', 'reaction'], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).dryRun, true);
  const live = spawnSync(process.execPath, ['scripts/e2e-harness.ts', '--flow', 'reaction'], { encoding: 'utf8', env });
  assert.equal(live.status, 1); assert.match(live.stderr, /TWO_E2E_ACCOUNT_ID/);
  const unpaced = spawnSync(process.execPath, ['scripts/e2e-harness.ts', '--no-pace'], { encoding: 'utf8', env });
  assert.equal(unpaced.status, 1); assert.match(unpaced.stderr, /only with --dry-run/);
});
