/**
 * TOG-3052 staging evidence: drive the temp-voice runtime against TWO Staging
 * and assert the result by re-reading Discord, not by trusting our own logs.
 *
 *   node scripts/staging-temp-voice-demo.ts create   # generator -> channel, controls
 *   node scripts/staging-temp-voice-demo.ts restart  # boot reconcile, occupied channel
 *   node scripts/staging-temp-voice-demo.ts cleanup  # empty -> grace -> deleted
 *
 * The three phases are separate PROCESSES on purpose. "Survives a restart" is
 * not a claim a single process can make about itself, and the occupied-channel
 * case is the one that matters: a restart that strands or ghosts somebody who is
 * still sitting in a generated channel is the failure this feature can most
 * easily have. The occupant is a fourth process (staging-voice-occupant.ts) so
 * that it outlives the restart.
 *
 * Every assertion re-reads the channel over REST with a separate token-bearing
 * fetch, so a bug in our own gateway wrapper cannot make the evidence agree with
 * itself. State between phases lives in Postgres, which is the point.
 *
 * Staging only. The guild is the pinned constant, never DISCORD_GUILD_ID - in
 * this environment that variable holds the LIVE guild, and the config loader
 * refuses to start against it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { openDb } from '../src/store/db.ts';
import { migrate } from '../src/store/migrate.ts';
import { TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import { loadTempVoiceConfig } from '../src/tempVoice/config.ts';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
import { TempVoiceService, type ControlContext } from '../src/tempVoice/service.ts';
import { DiscordTempVoiceGateway, registerTempVoice } from '../src/tempVoice/discord.ts';
import { loadAutomodConfig } from '../src/automod/config.ts';

const phase = process.argv[2];
if (!['create', 'restart', 'cleanup'].includes(phase ?? '')) {
  throw new Error('usage: staging-temp-voice-demo.ts <create|restart|cleanup>');
}

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) throw new Error('DISCORD_STAGING_BOT_TOKEN is required; this script is staging-only.');
const databaseUrl = process.env.TWO_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TWO_TEST_DATABASE_URL is required.');

const ARTIFACT = process.env.TEMP_VOICE_EVIDENCE ?? 'temp-voice-evidence.ndjson';
mkdirSync(dirname(join(process.cwd(), ARTIFACT)), { recursive: true });

let failures = 0;
function record(entry: Record<string, unknown>): void {
  appendFileSync(ARTIFACT, `${JSON.stringify({ phase, ...entry })}\n`);
}
function check(name: string, pass: boolean, detail: unknown): void {
  if (!pass) failures++;
  record({ check: name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
}

/** An independent read of Discord, deliberately not going through our gateway wrapper. */
async function rest(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

const PERM = { ViewChannel: 1n << 10n, Connect: 1n << 20n, Speak: 1n << 21n, ManageChannels: 1n << 4n, MoveMembers: 1n << 24n, Administrator: 1n << 3n };
const has = (bits: string, flag: bigint) => (BigInt(bits) & flag) === flag;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = await openDb(databaseUrl, { poolMax: 4 });
await migrate(db);

const config = loadTempVoiceConfig();
if (!config.enabled) throw new Error('TWO_TEMP_VOICE=1 is required for this demo.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});
const store = new TempVoiceStore(db);
const service = new TempVoiceService({
  store,
  gateway: new DiscordTempVoiceGateway(client),
  config,
  // The same policy object index.ts hands the service, so the name filter under
  // test is the deployed word list rather than a demo-shaped stand-in.
  policy: loadAutomodConfig().policy,
});
// The same registration index.ts performs, so the voiceStateUpdate path under
// test is the shipped one rather than a rehearsal of it.
registerTempVoice(client, { guildId: TWO_STAGING_GUILD_ID, service, config });

await new Promise<void>((resolve) => {
  client.once('ready', () => resolve());
  void client.login(token);
});
const botId = client.user!.id;
record({ event: 'connected', botId, generator: config.generatorChannelId, category: config.categoryId });

const ctx = (channelId: string | null): ControlContext => ({
  guildId: TWO_STAGING_GUILD_ID,
  actorId: botId,
  actorChannelId: channelId,
});

/** Channels that exist in staging and are nobody's to delete. */
const PROTECTED = {
  lobby: '1546211378430345286',
  squad: config.generatorChannelId,
  strayVoice1: '1546451671146565732',
};

async function assertBystandersSurvive(label: string): Promise<void> {
  for (const [name, id] of Object.entries(PROTECTED)) {
    const { status } = await rest(`/channels/${id}`);
    check(`${label}: ${name} still exists`, status === 200, { id, status });
  }
}

if (phase === 'create') {
  writeFileSync(ARTIFACT, '');
  record({ event: 'phase_start', note: 'occupant is expected to already be sitting in the generator' });

  // The occupant process joined the generator; the handler fires on its own.
  // Poll for the row rather than racing a fixed sleep.
  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    await sleep(500);
    const live = await store.listLive(TWO_STAGING_GUILD_ID);
    row = live.find((r) => r.ownerId === botId) ?? null;
  }
  check('a join on the generator created a channel', row !== null, { rowId: row?.id, channelId: row?.channelId });
  if (!row?.channelId) {
    console.error('no channel was created; aborting so later checks cannot pass vacuously');
    process.exit(1);
  }
  const channelId = row.channelId;

  const created = await rest(`/channels/${channelId}`);
  check('the channel exists in Discord', created.status === 200, { channelId, status: created.status });
  check('it is in the configured category', created.body.parent_id === config.categoryId, {
    parent: created.body.parent_id, expected: config.categoryId,
  });
  const lobby = await rest(`/channels/${PROTECTED.lobby}`);
  check('it is positioned below Lobby', created.body.position > lobby.body.position, {
    channel: created.body.position, lobby: lobby.body.position,
  });

  const occupants = await rest(`/guilds/${TWO_STAGING_GUILD_ID}/voice-states/${botId}`).catch(() => null);
  check('the member was moved into it', occupants?.body?.channel_id === channelId, {
    votes: occupants?.body?.channel_id, expected: channelId,
  });

  const ow = (created.body.permission_overwrites ?? []) as Array<{ id: string; type: number; allow: string; deny: string }>;
  const owner = ow.find((o) => o.id === botId && o.type === 1);
  check('the owner holds ManageChannels on this channel', !!owner && has(owner.allow, PERM.ManageChannels), { allow: owner?.allow });
  check('the owner holds MoveMembers on this channel', !!owner && has(owner.allow, PERM.MoveMembers), { allow: owner?.allow });
  check('no overwrite grants Administrator', ow.every((o) => !has(o.allow, PERM.Administrator)), {
    overwrites: ow.map((o) => ({ id: o.id, allow: o.allow })),
  });
  const guildMember = await rest(`/guilds/${TWO_STAGING_GUILD_ID}/members/${botId}`);
  const roles = await rest(`/guilds/${TWO_STAGING_GUILD_ID}/roles`);
  const ownerGuildPerms = (roles.body as Array<{ id: string; permissions: string }>)
    .filter((r) => guildMember.body.roles.includes(r.id) || r.id === TWO_STAGING_GUILD_ID)
    .reduce((acc, r) => acc | BigInt(r.permissions), 0n);
  check('the owner does NOT hold guild-wide Administrator', (ownerGuildPerms & PERM.Administrator) === 0n, {
    note: 'this is the thing TempVoice does that we refuse',
  });

  // ---- controls, through the same service methods the panel and /voice call ----
  const renamed = await service.rename(ctx(channelId), 'tog-3052 demo room');
  const afterRename = await rest(`/channels/${channelId}`);
  check('rename applies', renamed.status === 'ok' && afterRename.body.name === 'tog-3052 demo room', {
    outcome: renamed, name: afterRename.body.name,
  });
  const second = await service.rename(ctx(channelId), 'second rename inside the window');
  const afterSecond = await rest(`/channels/${channelId}`);
  check('a second rename inside 5 minutes is throttled, not sent to Discord',
    second.status === 'ok' && afterSecond.body.name === 'tog-3052 demo room',
    { outcome: second, nameStillIs: afterSecond.body.name });

  const filtered = await service.rename(ctx(channelId), 'join discord.gg/abcdef now');
  const afterFiltered = await rest(`/channels/${channelId}`);
  check('a filtered name is refused and never reaches Discord',
    filtered.status === 'refused' && afterFiltered.body.name === 'tog-3052 demo room',
    { outcome: filtered, nameStillIs: afterFiltered.body.name });

  const limit = await service.setLimit(ctx(channelId), 4);
  check('limit applies', limit.status === 'ok' && (await rest(`/channels/${channelId}`)).body.user_limit === 4, { outcome: limit });

  const bitrate = await service.setBitrate(ctx(channelId), 32000);
  check('bitrate applies', bitrate.status === 'ok' && (await rest(`/channels/${channelId}`)).body.bitrate === 32000, { outcome: bitrate });

  const locked = await service.lock(ctx(channelId), true);
  let ev = (await rest(`/channels/${channelId}`)).body.permission_overwrites.find((o: any) => o.id === TWO_STAGING_GUILD_ID);
  check('lock denies Connect to @everyone', locked.status === 'ok' && has(ev.deny, PERM.Connect), { deny: ev?.deny });

  const hidden = await service.hide(ctx(channelId), true);
  ev = (await rest(`/channels/${channelId}`)).body.permission_overwrites.find((o: any) => o.id === TWO_STAGING_GUILD_ID);
  check('hide denies ViewChannel while lock stays on',
    hidden.status === 'ok' && has(ev.deny, PERM.ViewChannel) && has(ev.deny, PERM.Connect),
    { deny: ev?.deny });

  const revealed = await service.hide(ctx(channelId), false);
  ev = (await rest(`/channels/${channelId}`)).body.permission_overwrites.find((o: any) => o.id === TWO_STAGING_GUILD_ID);
  check('reveal does not silently unlock', revealed.status === 'ok' && has(ev.deny, PERM.Connect) && !has(ev.deny, PERM.ViewChannel), { deny: ev?.deny });
  await service.lock(ctx(channelId), false);

  const HUMAN = '1258110103387635734';
  const permitted = await service.permit(ctx(channelId), { id: HUMAN, type: 'member' });
  const permitOw = (await rest(`/channels/${channelId}`)).body.permission_overwrites.find((o: any) => o.id === HUMAN);
  check('permit grants a member ViewChannel and Connect',
    permitted.status === 'ok' && has(permitOw.allow, PERM.Connect) && has(permitOw.allow, PERM.ViewChannel), { allow: permitOw?.allow });
  const rejected = await service.reject(ctx(channelId), { id: HUMAN, type: 'member' });
  const rejectOw = (await rest(`/channels/${channelId}`)).body.permission_overwrites.find((o: any) => o.id === HUMAN);
  check('reject flips it to a deny', rejected.status === 'ok' && has(rejectOw.deny, PERM.Connect), { deny: rejectOw?.deny });

  // Scoped to users currently connected: the target is a real person who is not
  // in the channel, so these must refuse rather than reach for them.
  const kicked = await service.kick(ctx(channelId), HUMAN);
  check('kick refuses a target who is not connected', kicked.status === 'refused', { outcome: kicked });
  const transferred = await service.transfer(ctx(channelId), HUMAN);
  check('transfer refuses a target who is not connected', transferred.status === 'refused', { outcome: transferred });
  const claimed = await service.claim(ctx(channelId));
  check('claim refuses while the recorded owner is still present', claimed.status === 'refused', { outcome: claimed });

  // Controls outside a generated channel, and by a non-owner.
  const outside = await service.lock(ctx(PROTECTED.lobby), true);
  const lobbyAfter = await rest(`/channels/${PROTECTED.lobby}`);
  check('a control aimed at Lobby is a no-op that changes nothing',
    outside.status === 'noop' && !(lobbyAfter.body.permission_overwrites ?? []).some((o: any) => has(o.deny, PERM.Connect)),
    { outcome: outside });
  const stranger = await service.lock({ guildId: TWO_STAGING_GUILD_ID, actorId: HUMAN, actorChannelId: channelId }, true);
  check('a non-owner is refused', stranger.status === 'refused', { outcome: stranger });

  // The hard invariant, against live Discord: a full sweep must not touch
  // anything it has no row for.
  const swept = await service.sweep(TWO_STAGING_GUILD_ID);
  check('a sweep with the channel occupied deletes nothing', swept.deleted === 0, { report: swept });
  await assertBystandersSurvive('after sweep');

  const forged = await service.deleteGeneratedChannel(TWO_STAGING_GUILD_ID, PROTECTED.lobby, 'demo: attempt to delete Lobby');
  check('deleting Lobby is refused', forged === 'refused', { outcome: forged });
  const stray = await service.deleteGeneratedChannel(TWO_STAGING_GUILD_ID, PROTECTED.strayVoice1, 'demo: attempt to delete an unowned channel');
  check('deleting an unowned channel with no row is refused', stray === 'refused', { outcome: stray });
  await assertBystandersSurvive('after forged deletes');

  record({ event: 'phase_end', channelId, note: 'leaving the channel occupied for the restart phase' });
  console.log(`\nchannel left occupied for the restart phase: ${channelId}`);
}

if (phase === 'restart') {
  // A brand-new process against the same database: this is the restart.
  const before = await store.listLive(TWO_STAGING_GUILD_ID);
  const row = before.find((r) => r.ownerId === botId);
  check('the row survived the restart', !!row?.channelId, { rowId: row?.id, channelId: row?.channelId });
  if (!row?.channelId) process.exit(1);

  const report = await service.reconcile(TWO_STAGING_GUILD_ID);
  check('boot reconcile re-adopted the occupied channel', report.adopted === 1 && report.deleted === 0, { report });

  const after = await rest(`/channels/${row.channelId}`);
  check('the occupied channel was not deleted out from under its occupant', after.status === 200, {
    channelId: row.channelId, status: after.status,
  });
  const stillThere = await store.getByChannel(TWO_STAGING_GUILD_ID, row.channelId);
  check('no ghost row: the channel and the row still agree', !!stillThere, { rowId: stillThere?.id });

  // Re-adopted means re-adopted: the controls still work after the restart.
  const renamed = await service.rename(ctx(row.channelId), 'adopted after restart');
  const named = await rest(`/channels/${row.channelId}`);
  check('the re-adopted channel is still controllable',
    renamed.status === 'ok' && named.body.name === 'adopted after restart', { outcome: renamed, name: named.body.name });

  await assertBystandersSurvive('after reconcile');
  record({ event: 'phase_end', channelId: row.channelId });
}

if (phase === 'cleanup') {
  const row = (await store.listLive(TWO_STAGING_GUILD_ID)).find((r) => r.ownerId === botId);
  check('the channel is still tracked at the start of cleanup', !!row?.channelId, { channelId: row?.channelId });
  if (!row?.channelId) process.exit(1);
  const channelId = row.channelId;

  // The occupant has been killed by now, so the channel is empty.
  const first = await service.sweep(TWO_STAGING_GUILD_ID);
  check('the first empty sweep starts the grace window rather than deleting', first.deleted === 0, { report: first });
  check('the channel is still alive during grace', (await rest(`/channels/${channelId}`)).status === 200, { channelId });

  const waitMs = (config.emptyGraceSeconds + 5) * 1000;
  console.log(`waiting out the ${config.emptyGraceSeconds}s grace window...`);
  await sleep(waitMs);

  const second = await service.sweep(TWO_STAGING_GUILD_ID);
  check('the sweep deletes once the grace window has expired', second.deleted === 1, { report: second });
  const gone = await rest(`/channels/${channelId}`);
  check('the channel is gone from Discord', gone.status === 404, { channelId, status: gone.status });
  check('the row is gone too', !(await store.getByChannel(TWO_STAGING_GUILD_ID, channelId)), { channelId });

  const again = await service.deleteGeneratedChannel(TWO_STAGING_GUILD_ID, channelId, 'demo: idempotent re-delete');
  check('deleting it again is refused rather than crashing', again === 'refused', { outcome: again });

  await assertBystandersSurvive('after cleanup');
  record({ event: 'phase_end', channelId });
}

console.log(`\n${phase}: ${failures === 0 ? 'all checks passed' : `${failures} CHECK(S) FAILED`}`);
client.destroy();
await db.close?.();
process.exit(failures === 0 ? 0 : 1);
