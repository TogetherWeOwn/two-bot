/**
 * TOG-3845: real REST + isolated staging Postgres, never the deployed bot's DB schema.
 * node scripts/staging-announcements-proof.ts --output=<new-report.json>
 * Requires DISCORD_STAGING_BOT_TOKEN and TWO_STAGING_DATABASE_URL.
 * Removes owned messages/channel/active rows; retains the cancelled event, its
 * mapping, idempotency results and audit rows for independent readback.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PermissionFlagsBits, type Client } from 'discord.js';
import pg from 'pg';
import { openDb } from '../src/store/db.ts';
import { AnnouncementsStore, type FeedRelayRow } from '../src/announcements/store.ts';
import { AnnouncementsService } from '../src/announcements/service.ts';
import { DiscordAnnouncements, XmlFeedReader, registerAnnouncementCommands } from '../src/announcements/discord.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { startInternalActions, type InternalServer } from '../src/internal/server.ts';
import { KeyRing, sign } from '../src/internal/signing.ts';
import { STAGING_BOT_APPLICATION_ID as APP, TWO_STAGING_GUILD_ID as GUILD } from '../src/staging/spec.ts';
import { announcementsProofConfig, assertProofIdentity, ownsProofMessage, proofSchema, type AnnouncementsProof } from './staging-announcements-state.ts';

const { token, dbUrl } = announcementsProofConfig(process.env);
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
if (!output) throw new Error('A new --output=<report.json> file is required.');
// Exclusive creation: never overwrite a prior proof. Open before any mutation.
const reportFile = await open(output, 'wx', 0o600);
const runId = randomBytes(12).toString('hex');
const marker = `TOG-3845:${runId}`;
const schema = proofSchema(runId);
const report: AnnouncementsProof = {
  version: 1, runId, schema, guildId: GUILD, applicationId: APP,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url) }).toString().trim(),
  startedAt: new Date().toISOString(), finishedAt: '', channelId: '', deniedChannelId: null,
  eventId: null, messageIds: [], checks: [],
};
const check = (name: string, pass: boolean, detail: string) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};
const requireCheck = (name: string, pass: boolean, detail: string) => {
  check(name, pass, detail);
  assert.ok(pass, name);
};
// Do not serialize upstream response bodies/errors, which may include credentials.
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  return { status: res.status, body: res.status === 204 ? null as T : await res.json() as T };
}
async function get<T>(path: string): Promise<T> {
  const res = await api<T>(path);
  assert.equal(res.status, 200, `Discord GET ${path}`);
  return res.body;
}
type Message = { id: string; author: { id: string }; content: string; components: unknown[]; timestamp: string };
type Event = { id: string; guild_id: string; name: string; status: number; creator_id: string };
type Channel = { id: string; guild_id: string; name: string; type: number; topic: string | null };
let db: Awaited<ReturnType<typeof openDb>> | undefined;
let server: InternalServer | undefined;
let store: AnnouncementsStore | undefined;
let lfgId: string | undefined;
let feedId: string | undefined;
const remember = (id: string) => { if (!report.messageIds.includes(id)) report.messageIds.push(id); return id; };
const secret = randomBytes(48).toString('hex'); // local ephemeral signing key, never published
const keyId = `proof-${runId}`;
const eventKey = `${marker}:event`;
try {
  requireCheck('source.clean', execFileSync('git', ['status', '--porcelain'], { cwd: new URL('..', import.meta.url) }).toString().trim() === '',
    'proof must execute committed source at the reported SHA');
  const application = await get<{ id: string }>('/oauth2/applications/@me');
  const guild = await get<{ id: string; name: string; owner_id: string }>(`/guilds/${GUILD}`);
  assertProofIdentity(application.id, guild);
  check('identity.remote', true, `${application.id} / ${guild.id} / ${guild.name}`);
  const member = await get<{ roles: string[] }>(`/guilds/${GUILD}/members/${APP}`);
  const roles = await get<Array<{ id: string; permissions: string }>>(`/guilds/${GUILD}/roles`);
  const permissions = roles.filter(r => r.id === GUILD || member.roles.includes(r.id))
    .reduce((bits, r) => bits | BigInt(r.permissions), 0n);
  requireCheck('permission.no-bypass', guild.owner_id !== APP && (permissions & PermissionFlagsBits.Administrator) === 0n,
    'bot is neither owner nor Administrator; channel denial can be meaningful');
  requireCheck('permission.manage-channels', (permissions & PermissionFlagsBits.ManageChannels) !== 0n,
    'temporary denied channel can be created and removed without changing shared permissions');
  const channels = await get<Channel[]>(`/guilds/${GUILD}/channels`);
  const candidates = channels.filter(c => c.name === 'bot-log' && c.type === 0);
  requireCheck('channel.unique', candidates.length === 1, 'exactly one staging #bot-log text channel');
  report.channelId = candidates[0]!.id;
  const channel = await get<Channel>(`/channels/${report.channelId}`);
  assert.equal(channel.guild_id, GUILD);

  // Fetch/parse one real public-feed snapshot before writes. Reuse that snapshot
  // for both polls so a newly published item cannot invalidate the replay check.
  const sampleFeed = { source: 'https://www.nasa.gov/feed/' } as FeedRelayRow;
  const items = (await new XmlFeedReader().read(sampleFeed)).slice(0, 1);
  requireCheck('feed.public-fetch', items.length === 1, 'production public fetcher and XML parser read NASA RSS; bounded to one item');
  const snapshot = items.map(i => ({ ...i, title: `${marker} ${i.title}` }));

  const preflight = new pg.Pool({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  try {
    const identity = (await preflight.query('SELECT current_database() AS name')).rows[0];
    assert.equal(identity.name, 'two_bot_staging');
    const exists = await preflight.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    assert.equal(exists.rowCount, 0, 'proof schema must be new');
  } finally { await preflight.end(); }
  db = await openDb(dbUrl, { schema, poolMax: 2, applicationName: 'tog3845-announcements-proof' });
  const internal = new InternalActionStore(db);
  store = new AnnouncementsStore(db);
  const discord = new DiscordAnnouncements({ token });
  const service = new AnnouncementsService(store, {
    postMessage: async (c, text, options) => remember(await discord.postMessage(c, text, options)),
    editMessage: (...args) => discord.editMessage(...args),
    findMessageByNonce: (...args) => discord.findMessageByNonce(...args),
  }, { read: async () => snapshot });

  const denied = await api<Channel>(`/guilds/${GUILD}/channels`, 'POST', {
    name: `tog3845-denied-${runId.slice(0, 8)}`, type: 0, topic: marker,
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: String(PermissionFlagsBits.ViewChannel) },
      { id: APP, type: 1, allow: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory), deny: String(PermissionFlagsBits.SendMessages) },
    ],
  });
  assert.equal(denied.status, 201);
  report.deniedChannelId = denied.body.id;
  const rest = new DiscordActions({ token });
  const start = () => startInternalActions({
    host: '127.0.0.1', port: 0, keys: new KeyRing([{ id: keyId, secret }]), guildId: GUILD,
    discord: rest, roleKeys: new Map(), channelKeys: new Map([['proof', report.channelId], ['denied', report.deniedChannelId!]]),
    enabled: new Set(['announcement.post', 'event.upsert', 'event.cancel']), store: internal,
  });
  server = await start();
  async function signed(body: Record<string, unknown>, suffix: string) {
    const raw = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const res = await fetch(server!.url, {
      method: 'POST', body: raw, signal: AbortSignal.timeout(30_000), headers: {
        'content-type': 'application/json', 'x-two-key-id': keyId, 'x-two-timestamp': timestamp,
        'x-two-nonce': nonce, 'x-two-signature': sign(secret, timestamp, nonce, raw),
        'idempotency-key': `${marker}:${suffix}`,
      },
    });
    const result = await res.json() as { ok: boolean; result?: { event_id?: string; message_id?: string; outcome?: string }; error?: { code: string } };
    return { status: res.status, replay: res.headers.get('idempotent-replay') === 'true', ...result };
  }
  const announce = { action: 'announcement.post', channel_key: 'proof', content: `${marker} event-announcement proof` };
  const posted = await signed(announce, 'post');
  if (posted.result?.message_id) remember(posted.result.message_id);
  requireCheck('announcement.post', posted.ok && !!posted.result?.message_id, `HTTP ${posted.status}`);
  const postedMessage = await get<Message>(`/channels/${report.channelId}/messages/${posted.result!.message_id}`);
  requireCheck('announcement.readback', postedMessage.content === announce.content && ownsProofMessage(postedMessage, marker), 'same content and QA bot author');
  const postReplay = await signed(announce, 'post');
  requireCheck('announcement.replay', postReplay.replay && postReplay.result?.message_id === posted.result?.message_id, 'same idempotency key returns same message');
  const forbidden = await signed({ ...announce, channel_key: 'denied' }, 'denied');
  requireCheck('permission.discord-denial', forbidden.error?.code === 'discord_rejected', `real Discord denies SendMessages; endpoint HTTP ${forbidden.status}`);
  const deniedHistory = await get<Message[]>(`/channels/${report.deniedChannelId}/messages?limit=10`);
  requireCheck('permission.no-message', deniedHistory.length === 0, 'denied channel remains empty');
  const unknownChannel = await signed({ ...announce, channel_key: 'not-allowed' }, 'unknown-channel');
  requireCheck('announcement.allowlist', unknownChannel.error?.code === 'action_not_allowed', 'unknown channel key refused');

  const eventBody = {
    action: 'event.upsert', event_key: eventKey, name: `${marker} event`, location: 'TWO Staging QA only',
    starts_at: new Date(Date.now() + 3_600_000).toISOString(), ends_at: new Date(Date.now() + 7_200_000).toISOString(),
  };
  const created = await signed(eventBody, 'create');
  report.eventId = created.result?.event_id ?? null;
  requireCheck('event.create', created.ok && !!report.eventId, `HTTP ${created.status}`);
  const createdReadback = await get<Event>(`/guilds/${GUILD}/scheduled-events/${report.eventId}`);
  requireCheck('event.create-readback', createdReadback.name === eventBody.name && createdReadback.status === 1 && createdReadback.creator_id === APP, 'created scheduled event belongs to QA bot');
  const updatedBody = { ...eventBody, name: `${marker} updated` };
  const updated = await signed(updatedBody, 'update');
  const updatedReadback = await get<Event>(`/guilds/${GUILD}/scheduled-events/${report.eventId}`);
  requireCheck('event.update', updated.ok && updated.result?.event_id === report.eventId && updatedReadback.name === updatedBody.name, 'same Discord event id, changed name read back');

  // These are synthetic interaction objects through the production listener,
  // not a claim that a human used the deployed gateway/slash registration.
  const bus = new EventEmitter();
  registerAnnouncementCommands(bus as unknown as Client, { guildId: GUILD, service, store });
  const replies: unknown[] = [];
  const interaction = (name: string, values: Record<string, string>, permitted = true) => ({
    inGuild: () => true, guildId: GUILD, channelId: report.channelId, user: { id: APP },
    isStringSelectMenu: () => false, isChatInputCommand: () => true, commandName: name,
    memberPermissions: { has: () => permitted }, options: { getString: (key: string) => values[key] },
    reply: async (body: unknown) => { replies.push(body); }, replied: false, deferred: false,
  });
  async function dispatch(value: unknown) {
    for (const listener of bus.listeners('interactionCreate')) await listener(value);
  }
  for (const status of ['going', 'going', 'interested']) {
    await dispatch(interaction('rsvp', { 'event-id': report.eventId!, status }));
  }
  const attendance = await service.attendance(GUILD, report.eventId!);
  requireCheck('rsvp.converges', attendance.going.length === 0 && attendance.interested.length === 1 && attendance.interested[0] === APP,
    'synthetic listener actor: repeat/update leaves one RSVP; each call remains audited');
  for (const [command, message] of [['feed-add', 'Manage Server'], ['lfg', 'Manage Events']]) {
    replies.length = 0;
    await dispatch(interaction(command!, {}, false));
    requireCheck(`permission.listener-${command}`, JSON.stringify(replies).includes(message!), 'synthetic no-permission member rejected by production listener');
  }
  lfgId = `${marker}:lfg`;
  const lfg = await service.createLfg({ id: lfgId, guildId: GUILD, channelId: report.channelId,
    title: `${marker} signup`, startsAt: eventBody.starts_at, roles: [{ key: 'player', label: 'Player', slots: 1 }, { key: 'reserve', label: 'Reserve', slots: 1 }], actorId: APP });
  lfgId = lfg.id;
  if (lfg.messageId) remember(lfg.messageId);
  for (let i = 0; i < 2; i++) {
    await dispatch({ ...interaction('', {}), isStringSelectMenu: () => true, customId: `two:lfg:${lfg.id}`, values: ['player'] });
  }
  const signups = await store.listLfgSignups(lfg.id);
  requireCheck('lfg.signup-replay', signups.length === 1 && signups[0]?.userId === APP, 'synthetic select listener repeat leaves one signup; edits/audits are not claimed to be zero');
  const full = await service.signupLfg({ guildId: GUILD, id: lfg.id, userId: `${marker}:other`, roleKey: 'player' });
  requireCheck('lfg.full', full === 'full', 'second synthetic actor cannot overfill the slot');
  const moved = await service.signupLfg({ guildId: GUILD, id: lfg.id, userId: APP, roleKey: 'reserve' });
  const lfgMessage = await get<Message>(`/channels/${report.channelId}/messages/${lfg.messageId}`);
  requireCheck('lfg.update-readback', moved === 'moved' && lfgMessage.content.includes('Reserve') && lfgMessage.content.includes(`<@${APP}>`) && lfgMessage.components.length > 0, 'signup move propagated to same real message');
  assert.equal(await service.closeLfg(GUILD, lfg.id, APP), true);
  assert.equal(await service.closeLfg(GUILD, lfg.id, APP), false);
  const closed = await get<Message>(`/channels/${report.channelId}/messages/${lfg.messageId}`);
  requireCheck('lfg.close-readback', closed.content.includes('Closed') && closed.components.length === 0, 'closed message has no signup controls; repeated close is harmless');
  requireCheck('lfg.closed', await service.signupLfg({ guildId: GUILD, id: lfg.id, userId: APP, roleKey: 'player' }) === 'closed', 'closed signup rejected');

  feedId = `${marker}:feed`;
  const feed = await service.addFeed({ id: feedId, guildId: GUILD, channelId: report.channelId, kind: 'rss', source: sampleFeed.source, actorId: APP });
  feedId = feed.id;
  const firstPoll = await service.pollFeeds(GUILD);
  const secondPoll = await service.pollFeeds(GUILD);
  const deliveries = await db.prepare('SELECT message_id FROM feed_deliveries WHERE feed_id = ? AND state = ?').all<{ message_id: string }>(feed.id, 'delivered');
  requireCheck('feed.deduplicated', firstPoll === 1 && secondPoll === 0 && deliveries.length === 1, 'same fetched item polled twice, one durable delivered row');
  const feedMessage = await get<Message>(`/channels/${report.channelId}/messages/${deliveries[0]!.message_id}`);
  requireCheck('feed.readback', ownsProofMessage(feedMessage, marker) && feedMessage.content.includes(items[0]!.url), 'real RSS item relayed into staging channel');
  requireCheck('feed.unknown', await service.removeFeed(GUILD, `${marker}:unknown`, APP) === false, 'unknown feed returns missing');
  requireCheck('feed.remove', await service.removeFeed(GUILD, feed.id, APP) && await service.pollFeeds(GUILD) === 0, 'removed feed no longer follows/polls');

  const cancellation = { action: 'event.cancel', event_key: eventKey };
  const cancelled = await signed(cancellation, 'cancel');
  requireCheck('event.cancel', cancelled.ok && cancelled.result?.event_id === report.eventId, `HTTP ${cancelled.status}`);
  const cancelledReadback = await get<Event>(`/guilds/${GUILD}/scheduled-events/${report.eventId}`);
  requireCheck('event.cancel-readback', cancelledReadback.status === 4, 'Discord reports CANCELED; mapping retained');
  await server.close();
  server = await start();
  const replayed = await signed(cancellation, 'cancel');
  requireCheck('event.cancel-restart-replay', replayed.replay && replayed.result?.event_id === report.eventId, 'new endpoint instance replays durable cancellation');
  const unknown = await signed({ action: 'event.cancel', event_key: `${marker}:unknown` }, 'unknown-event');
  requireCheck('event.unknown', unknown.error?.code === 'action_not_allowed', 'unknown event key refused');
  requireCheck('event.mapping', await internal.discordEventId(GUILD, eventKey) === report.eventId, 'cancelled identity remains mapped');
  const matchingEvents = (await get<Event[]>(`/guilds/${GUILD}/scheduled-events`)).filter(e => e.name.includes(marker));
  requireCheck('event.no-active-copy', matchingEvents.every(e => e.id === report.eventId && e.status === 4), 'no active replacement event for the proof marker');
  const audit = await db.prepare('SELECT action, outcome, code, status FROM internal_action_log WHERE key_id = ? ORDER BY created_at').all<{ action: string; outcome: string; code: string | null; status: number }>(keyId);
  const required = [['event.upsert', 'created'], ['event.upsert', 'updated'], ['event.cancel', 'cancelled'], ['event.cancel', 'replayed:cancelled']];
  requireCheck('audit.internal', required.every(([action, outcome]) => audit.some(r => r.action === action && r.outcome === outcome && r.status === 200)) && audit.some(r => r.code === 'discord_rejected'), JSON.stringify(audit));
  const announcementAudit = await db.prepare('SELECT action, outcome FROM announcements_audit_log WHERE guild_id = ? ORDER BY created_at').all<{ action: string; outcome: string }>(GUILD);
  requireCheck('audit.announcements', ['event.rsvp', 'lfg.create', 'lfg.signup', 'lfg.close', 'feed.create', 'feed.poll', 'feed.remove'].every(action => announcementAudit.some(r => r.action === action)), JSON.stringify(announcementAudit));
  check('hierarchy.not-applicable', true, 'no member role assignment: LFG role labels are slots, not Discord roles; real channel permission denial covered separately');
} catch (error) {
  check('execution', false, error instanceof assert.AssertionError ? error.message :
    `proof aborted (${error instanceof Error ? error.name : 'unknown error'}); upstream details intentionally redacted`);
} finally {
  if (server) await server.close();
  async function cleanup(name: string, fn: () => Promise<void>) {
    try { await fn(); check(`cleanup.${name}`, true, 'owned artifact removed and read back'); }
    catch { check(`cleanup.${name}`, false, 'cleanup refused or failed; inspect retained report IDs before retrying'); }
  }
  // Recover identifiable artifacts if Discord accepted a write but its response
  // or the subsequent durable write failed. Never infer cleanup from a null ID.
  if (db) await cleanup('inventory', async () => {
    let before = '';
    for (let page = 0; ; page++) {
      assert.ok(page < 20, 'history truncated; complete cleanup cannot be claimed');
      const history = await get<Message[]>(`/channels/${report.channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
      for (const message of history) if (ownsProofMessage(message, marker)) remember(message.id);
      if (history.length < 100 || history.some(m => Date.parse(m.timestamp) < Date.parse(report.startedAt) - 60_000)) break;
      before = history.at(-1)!.id;
    }
    const channels = (await get<Channel[]>(`/guilds/${GUILD}/channels`)).filter(c => c.topic === marker && c.name === `tog3845-denied-${runId.slice(0, 8)}`);
    assert.ok(channels.length <= 1, 'ambiguous proof channel inventory');
    if (!report.deniedChannelId && channels[0]) report.deniedChannelId = channels[0].id;
    const events = (await get<Event[]>(`/guilds/${GUILD}/scheduled-events`)).filter(e => e.creator_id === APP && e.name.includes(marker));
    assert.ok(events.length <= 1 && (!report.eventId || events.every(e => e.id === report.eventId)), 'ambiguous proof event inventory');
    if (!report.eventId && events[0]) report.eventId = events[0].id;
  });
  // Never delete an event mapping. If a later check failed, still cancel our
  // scheduled event, but do not turn cleanup cancellation into a proof PASS.
  if (report.eventId) await cleanup('event-terminal', async () => {
    const event = await get<Event>(`/guilds/${GUILD}/scheduled-events/${report.eventId}`);
    assert.ok(event.name.includes(marker) && event.creator_id === APP && event.guild_id === GUILD);
    if (event.status === 1) assert.equal((await api(`/guilds/${GUILD}/scheduled-events/${report.eventId}`, 'PATCH', { status: 4 })).status, 200);
    assert.equal((await get<Event>(`/guilds/${GUILD}/scheduled-events/${report.eventId}`)).status, 4);
  });
  if (db && store) await cleanup('rows', async () => {
    if (feedId) await store!.deleteFeed(GUILD, feedId);
    if (lfgId) await store!.deleteLfg(GUILD, lfgId);
    if (report.eventId) await db!.prepare('DELETE FROM event_rsvps WHERE guild_id = ? AND event_id = ? AND user_id = ?').run(GUILD, report.eventId, APP);
    for (const table of ['feed_relays', 'feed_deliveries', 'lfg_posts', 'lfg_signups', 'event_rsvps']) {
      const count = await db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>();
      assert.equal(Number(count?.n), 0, table);
    }
  });
  for (const id of report.messageIds) await cleanup(`message.${id}`, async () => {
    const message = await get<Message>(`/channels/${report.channelId}/messages/${id}`);
    assert.ok(ownsProofMessage(message, marker));
    assert.equal((await api(`/channels/${report.channelId}/messages/${id}`, 'DELETE')).status, 204);
    assert.equal((await api(`/channels/${report.channelId}/messages/${id}`)).status, 404);
  });
  if (report.deniedChannelId) await cleanup('denied-channel', async () => {
    const channel = await get<Channel>(`/channels/${report.deniedChannelId}`);
    assert.ok(channel.guild_id === GUILD && channel.topic === marker && channel.name === `tog3845-denied-${runId.slice(0, 8)}`);
    assert.equal((await api(`/channels/${report.deniedChannelId}`, 'DELETE')).status, 200);
    assert.equal((await api(`/channels/${report.deniedChannelId}`)).status, 404);
  });
  if (db) await db.close();
  report.finishedAt = new Date().toISOString();
  await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  await reportFile.close();
}
console.log(`Report: ${output}; retained audit schema: ${schema}; cancelled event: ${report.eventId ?? 'none'}`);
process.exitCode = report.checks.some(c => !c.pass) ? 1 : 0;
