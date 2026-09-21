import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events, MessageFlags, PermissionsBitField, type ChatInputCommandInteraction, type Client } from 'discord.js';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from '../src/analytics/communityClassifier.ts';
import { OnboardingRota } from '../src/analytics/onboardingRota.ts';
import { DiscordOnboardingRota } from '../src/discord/onboardingRota.ts';
import { acknowledgeRotaInteraction, registerRotaAcknowledgement, ROTA_ACKNOWLEDGEMENT_COMMAND } from '../src/discord/rotaAcknowledgement.ts';
import { BUILTIN_COMMAND_NAMES } from '../src/discord/commandNames.ts';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ACTION = '333333333333333333';
const PRIMARY = '444444444444444444';
const SUBJECT = '555555555555555555';
const KEY = 'test-only-rota-primary-input-key-123456789';
const FIRST = '2026-09-01T12:05:00.000Z';
const LINK = `https://discord.com/channels/${GUILD}/${CHANNEL}/${ACTION}`;
let fixture: TestDb;
let core: OnboardingRota;
let observer: DiscordOnboardingRota;

function build(env: NodeJS.ProcessEnv = {}, enabled = true, primaryActorId: string | undefined = PRIMARY) {
  core = new OnboardingRota(fixture.db, new CommunityClassifier(loadCommunityClassifierConfig(env)), {
    enabled, noticeEnabled: true, primaryActorId, pseudonymKey: KEY,
  });
  return new DiscordOnboardingRota(fixture.db, core, { guildId: GUILD, primaryActorId,
    staffActorIds: new Set(), staffRoleIds: new Set(['staff']), humanChannelIds: new Set([CHANNEL]) });
}

before(async () => { fixture = await openTestDb(import.meta.filename); });
after(async () => fixture?.cleanup());
beforeEach(async () => { await fixture.reset(); observer = build(); });

async function enroll() {
  const subject = { guildId: GUILD, actorId: SUBJECT, pending: false };
  await core.rulesAccepted({ ...subject, occurredAt: '2026-09-01T12:00:00.000Z', sourceCohort: 'invite:campaign' });
  await core.promptShown({ ...subject, occurredAt: '2026-09-01T12:01:00.000Z', promptVariant: 'session', messageId: 'welcome', channelId: CHANNEL });
  await core.message({ ...subject, occurredAt: FIRST, messageId: ACTION, channelId: CHANNEL, eligibleChannel: true });
}

function input() {
  const fetches: unknown[] = [];
  const replies: Record<string, unknown>[] = [];
  const defers: Record<string, unknown>[] = [];
  const member = (id: string) => ({ id, user: { id, bot: false }, pending: false, partial: false,
    guild: { id: GUILD, ownerId: 'owner' }, roles: { cache: new Collection() },
    permissions: new PermissionsBitField(0n), isCommunicationDisabled: () => false });
  const primary = member(PRIMARY);
  const subject = member(SUBJECT);
  const message = { id: ACTION, guildId: GUILD, channelId: CHANNEL, author: subject.user,
    webhookId: null, system: false, partial: false };
  const channel = { id: CHANNEL, guild: { id: GUILD }, type: ChannelType.GuildText,
    permissionsFor: (_m: unknown) => new PermissionsBitField(['ViewChannel', 'SendMessages', 'ReadMessageHistory']),
    messages: { fetch: async (opts: unknown) => { fetches.push(opts); return message; } } };
  const guild = { id: GUILD, members: { fetch: async (opts: { user: string; force: boolean }) => {
    fetches.push(opts); return opts.user === PRIMARY ? primary : subject;
  } }, channels: { fetch: async (id: string, opts: unknown) => { fetches.push([id, opts]); return channel; } } };
  const value = { commandName: String(ROTA_ACKNOWLEDGEMENT_COMMAND.name), isChatInputCommand: () => true,
    inGuild: () => true, guildId: GUILD, guild, user: { id: PRIMARY, bot: false },
    options: { getString: () => LINK },
    deferReply: async (data: Record<string, unknown>) => { defers.push(data); },
    editReply: async (data: Record<string, unknown>) => { replies.push(data); } };
  return { value, interaction: value as unknown as ChatInputCommandInteraction,
    primary, subject, message, channel, guild, fetches, replies, defers };
}
async function acks() {
  return fixture.db.prepare("SELECT actor_id, metadata FROM community_facts WHERE event_type = 'welcome_rota_acknowledged'")
    .all<{ actor_id: string; metadata: string }>();
}

test('authenticated primary command fetches fresh evidence and writes one pseudonymous acknowledgement', async () => {
  await enroll();
  const x = input();
  const before = Date.now();
  await acknowledgeRotaInteraction(x.interaction, observer);
  assert.deepEqual(x.defers, [{ flags: MessageFlags.Ephemeral }]);
  assert.equal(x.replies.length, 1);
  assert.match(String(x.replies[0].content), /Primary acknowledgement recorded.*human reply is still required/);
  assert.deepEqual(x.replies[0].allowedMentions, { parse: [] });
  assert.deepEqual(x.fetches, [{ user: PRIMARY, force: true }, [CHANNEL, { force: true }],
    { message: ACTION, force: true }, { user: SUBJECT, force: true }]);
  const rows = await acks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, core.memberId(GUILD, SUBJECT));
  assert.equal(JSON.parse(rows[0].metadata).responderId, core.memberId(GUILD, PRIMARY));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${PRIMARY}|${SUBJECT}`));
  const clock = await fixture.db.prepare("SELECT occurred_at FROM community_facts WHERE event_type = 'welcome_rota_acknowledged'").get<{ occurred_at: string }>();
  assert.ok(Date.parse(clock!.occurred_at) >= before && Date.parse(clock!.occurred_at) <= Date.now());
  assert.deepEqual(await core.dueNotices(GUILD, new Date().toISOString()), []);
  await acknowledgeRotaInteraction(x.interaction, observer);
  assert.match(String(x.replies[1].content), /No new acknowledgement/);
  assert.equal((await acks()).length, 1);
  const replies = await fixture.db.prepare("SELECT count(*)::int AS n FROM community_facts WHERE event_type IN ('onboarding_first_human_reply', 'onboarding_reply_latency')").get<{ n: number }>();
  assert.equal(replies?.n, 0);
});

test('actor authentication and canonical same-guild link checks precede every Discord fetch', async () => {
  await enroll();
  for (const mutate of [
    (x: ReturnType<typeof input>) => { x.value.user.id = SUBJECT; },
    (x: ReturnType<typeof input>) => { x.value.user.bot = true; },
    (x: ReturnType<typeof input>) => { x.value.inGuild = () => false; },
    (x: ReturnType<typeof input>) => { x.value.guildId = 'other'; },
    (x: ReturnType<typeof input>) => { x.guild.id = 'other'; },
  ]) {
    const x = input(); mutate(x);
    assert.equal(await observer.acknowledgePrimary(x.interaction), false);
    assert.deepEqual(x.fetches, []);
  }
  for (const link of [LINK.replace('discord.com', 'evil.example'), LINK.replace('https:', 'http:'),
    LINK.replace(GUILD, PRIMARY), LINK.replace(CHANNEL, PRIMARY), LINK + '?extra=1', LINK + '/extra',
    LINK.replace('/' + ACTION, '/123'), 'not-a-link', `https://discord.com@evil.example/channels/${GUILD}/${CHANNEL}/${ACTION}`]) {
    const x = input(); x.value.options.getString = () => link;
    assert.equal(await observer.acknowledgePrimary(x.interaction), false);
    assert.deepEqual(x.fetches, []);
  }
  assert.deepEqual(await acks(), []);
});

test('fresh member, channel and fetched message exclusions fail closed', async () => {
  await enroll();
  const mutate: Array<(x: ReturnType<typeof input>) => void> = [
    x => { x.primary.pending = true; }, x => { x.primary.partial = true; },
    x => { x.primary.user.bot = true; }, x => { x.primary.id = SUBJECT; },
    x => { x.primary.isCommunicationDisabled = () => true; },
    x => { x.subject.pending = true; }, x => { x.subject.partial = true; },
    x => { x.subject.user.bot = true; }, x => { x.subject.id = PRIMARY; },
    x => { x.subject.permissions = new PermissionsBitField(['ManageGuild']); },
    x => { x.subject.isCommunicationDisabled = () => true; },
    x => { x.subject.guild.id = 'other'; }, x => { x.channel.id = 'other'; },
    x => { x.channel.guild.id = 'other'; },
    x => { x.channel.type = ChannelType.PublicThread as typeof x.channel.type; },
    x => { x.channel.permissionsFor = () => new PermissionsBitField(['ViewChannel']); },
    x => { x.channel.permissionsFor = m => new PermissionsBitField(m === x.subject ? [] : ['ViewChannel', 'SendMessages', 'ReadMessageHistory']); },
    x => { x.message.id = 'other'; }, x => { x.message.guildId = 'other'; },
    x => { x.message.channelId = 'other'; }, x => { x.message.partial = true; },
    x => { x.message.system = true; }, x => { Object.assign(x.message, { webhookId: 'hook' }); },
  ];
  for (const change of mutate) {
    const x = input(); change(x);
    assert.equal(await observer.acknowledgePrimary(x.interaction), false);
  }
  assert.deepEqual(await acks(), []);
});

test('fresh fetch and permission failures are contained, do not persist or poison later observations', async () => {
  await enroll();
  const x = input();
  x.guild.members.fetch = async () => { throw new Error('fixture-sensitive-value'); };
  assert.equal(await observer.acknowledgePrimary(x.interaction), false);
  assert.deepEqual(await acks(), []);
  assert.equal(await observer.acknowledgePrimary(input().interaction), true);
});

test('unobserved and non-first messages cannot create an acknowledgement from fetched history', async () => {
  assert.equal(await observer.acknowledgePrimary(input().interaction), false);
  await enroll();
  const x = input(); x.value.options.getString = () => LINK.replace(ACTION, '666666666666666666');
  x.message.id = '666666666666666666';
  assert.equal(await observer.acknowledgePrimary(x.interaction), false);
  assert.deepEqual(await acks(), []);
});

test('classifier, disabled core and unbound adapter still refuse an authenticated command', async () => {
  await enroll();
  for (const env of [{ TWO_COMMUNITY_RAID_ACTOR_IDS: PRIMARY }, { TWO_COMMUNITY_TEST_ACTOR_IDS: SUBJECT },
    { TWO_COMMUNITY_STAGING_GUILD_IDS: GUILD }, { TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: PRIMARY }]) {
    observer = build(env);
    assert.equal(await observer.acknowledgePrimary(input().interaction), false);
  }
  observer = build({}, false);
  assert.equal(await observer.acknowledgePrimary(input().interaction), false);
  observer = new DiscordOnboardingRota(fixture.db, core, { guildId: GUILD, staffActorIds: new Set(),
    staffRoleIds: new Set(), humanChannelIds: new Set([CHANNEL]) });
  const x = input();
  assert.equal(await observer.acknowledgePrimary(x.interaction), false);
  assert.deepEqual(x.fetches, []);
  assert.deepEqual(await acks(), []);
});

test('ordered pending action is committed before command acknowledgement checks persisted evidence', async () => {
  let resolve!: (source: string) => void;
  const source = new Promise<string>(r => { resolve = r; });
  const x = input();
  Object.assign(x.subject.guild, { features: ['MEMBER_VERIFICATION_GATE_ENABLED'] });
  const joined = observer.join(x.subject as never, source, '2026-09-01T12:00:00.000Z');
  const action = observer.message({ ...x.message, member: x.subject, createdTimestamp: Date.parse(FIRST),
    channel: { ...x.channel, isDMBased: () => false, isThread: () => false } } as never);
  const acknowledged = observer.acknowledgePrimary(x.interaction);
  assert.deepEqual(x.fetches, []);
  resolve('invite:campaign');
  await Promise.all([joined, action]);
  assert.equal(await acknowledged, true);
  assert.equal((await acks()).length, 1);
});

test('gateway routing ignores other commands/guilds; command is reserved and all feedback is ephemeral', async () => {
  const bus = new EventEmitter();
  let calls = 0;
  registerRotaAcknowledgement(bus as unknown as Client, GUILD, { acknowledgePrimary: async () => { calls++; return false; } });
  const wrong = input(); wrong.value.commandName = 'attendance';
  bus.emit(Events.InteractionCreate, wrong.interaction);
  wrong.value.commandName = ROTA_ACKNOWLEDGEMENT_COMMAND.name; wrong.value.guildId = 'other';
  bus.emit(Events.InteractionCreate, wrong.interaction);
  assert.equal(calls, 0);
  const x = input(); bus.emit(Events.InteractionCreate, x.interaction);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(x.defers, [{ flags: MessageFlags.Ephemeral }]);
  assert.match(String(x.replies[0].content), /No new acknowledgement/);
  assert.ok(BUILTIN_COMMAND_NAMES.has(ROTA_ACKNOWLEDGEMENT_COMMAND.name));
  assert.equal(ROTA_ACKNOWLEDGEMENT_COMMAND.dmPermission, false);
  assert.equal(ROTA_ACKNOWLEDGEMENT_COMMAND.defaultMemberPermissions, PermissionsBitField.Flags.ManageGuild);
});

test('interaction response failure is contained without a public or DM fallback', async () => {
  const x = input();
  x.value.deferReply = async () => { throw new Error('fixture-sensitive-token'); };
  await acknowledgeRotaInteraction(x.interaction, { acknowledgePrimary: async () => false });
  assert.deepEqual(x.replies, []);
});
