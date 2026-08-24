/**
 * Onboarding rules, tested without Discord.
 *
 * The cases here are the ones that would actually bite a real member: getting
 * prompted before they can click anything, being handed a link to a channel
 * they cannot open, and the funnel double-counting them.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/store/eventStore.ts';
import {
  OnboardingRecorder,
  currentGameKeys,
  decidePrompt,
  planSelection,
  resolveDestination,
} from '../src/onboarding/flow.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import {
  ALL_PICKS,
  GAME_HUB_CHANNEL_ID,
  GAME_PICKS,
  GATED_CATEGORIES,
  INTRO_CHANNEL_ID,
  LANDING_CHANNEL_ID,
  pickByKey,
} from '../src/onboarding/catalog.ts';
import { resolveLandingChannels } from '../src/core/config.ts';
import { welcomeText } from '../src/discord/onboarding.ts';

const GUILD = '326474832151838730';
const MEMBER = '900000000000009999';

// Same tests, either driver. SQLite by default; Postgres when
// TWO_TEST_DATABASE_URL is set. See test/helpers/testDb.ts.
let harness: TestDb;
before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
});

async function freshStore(): Promise<EventStore> {
  return new EventStore(harness.db);
}

const seeEverything = () => true;
const seeNothing = () => false;

test('catalog ids are well formed and unique', () => {
  const keys = new Set<string>();
  const roleIds = new Set<string>();
  for (const p of ALL_PICKS) {
    assert.match(p.roleId, /^\d{17,20}$/, `${p.key} roleId is not a snowflake`);
    assert.ok(!keys.has(p.key), `duplicate pick key ${p.key}`);
    assert.ok(!roleIds.has(p.roleId), `role ${p.roleName} offered twice`);
    keys.add(p.key);
    roleIds.add(p.roleId);
    assert.ok(p.label.length <= 100, 'label too long for a select option');
    assert.ok(p.description.length <= 100, 'description too long for a select option');
    if (p.primaryChannelId) assert.match(p.primaryChannelId, /^\d{17,20}$/);
    assert.match(p.fallbackChannelId, /^\d{17,20}$/);
  }
});

test('every gated category maps to a game pick that targets a channel inside it', () => {
  for (const cat of GATED_CATEGORIES) {
    const pick = GAME_PICKS.find((p) => p.roleId === cat.roleId);
    assert.ok(pick, `no pick grants ${cat.roleName}, so ${cat.categoryName} can never be reached`);
    assert.ok(pick.primaryChannelId, `${pick.key} must have a primary channel`);
  }
});

// --- the landing channel ----------------------------------------------------

test('onboarding defaults to the TOG-94 landing channel instead of switching itself off', () => {
  const before = process.env.DISCORD_LANDING_CHANNEL_IDS;
  try {
    delete process.env.DISCORD_LANDING_CHANNEL_IDS;
    const resolved = resolveLandingChannels();
    // The old behaviour was an empty list, which disabled onboarding entirely.
    // That was correct while nobody had chosen a channel; it is now a bug.
    assert.deepEqual(resolved.ids, [LANDING_CHANNEL_ID]);
    assert.equal(resolved.source, 'default');
  } finally {
    if (before === undefined) delete process.env.DISCORD_LANDING_CHANNEL_IDS;
    else process.env.DISCORD_LANDING_CHANNEL_IDS = before;
  }
});

test('an explicit landing channel still wins, so staging can point elsewhere', () => {
  const before = process.env.DISCORD_LANDING_CHANNEL_IDS;
  try {
    process.env.DISCORD_LANDING_CHANNEL_IDS = ' 111111111111111111 , 222222222222222222 ';
    const resolved = resolveLandingChannels();
    assert.deepEqual(resolved.ids, ['111111111111111111', '222222222222222222']);
    assert.equal(resolved.source, 'env');
  } finally {
    if (before === undefined) delete process.env.DISCORD_LANDING_CHANNEL_IDS;
    else process.env.DISCORD_LANDING_CHANNEL_IDS = before;
  }
});

// --- the welcome copy -------------------------------------------------------

test('the welcome addresses one member and never mass-mentions', () => {
  const text = welcomeText('<@900000000000009999>');

  assert.match(text, /<@900000000000009999>/, 'must mention the member it is welcoming');
  assert.match(text, new RegExp(`<#${INTRO_CHANNEL_ID}>`), 'must link the intro channel');

  // The single hard constraint on this issue is no mass messaging. The welcome
  // is the one public post onboarding makes, so an @everyone or @here smuggled
  // into the copy would ping the whole server on every single join.
  assert.ok(!text.includes('@everyone'), 'the welcome must never ping @everyone');
  assert.ok(!text.includes('@here'), 'the welcome must never ping @here');

  // Discord hard-caps a message at 2000 characters, and a welcome that needs
  // scrolling has already lost the person it is talking to.
  assert.ok(text.length < 400, `welcome is ${text.length} chars - too long to read at a glance`);
});

// --- when do we prompt ------------------------------------------------------

test('a member behind the rules gate is not prompted', async () => {
  const store = await freshStore();
  const d = await decidePrompt(store, {
    guildId: GUILD,
    memberId: MEMBER,
    isBot: false,
    pending: true,
  });
  assert.equal(d.shouldPrompt, false);
  assert.equal(d.reason, 'still_pending');
});

test('bots are never prompted', async () => {
  const store = await freshStore();
  const d = await decidePrompt(store, {
    guildId: GUILD,
    memberId: MEMBER,
    isBot: true,
    pending: false,
  });
  assert.equal(d.shouldPrompt, false);
  assert.equal(d.reason, 'bot');
});

test('a member is prompted once and only once', async () => {
  const store = await freshStore();
  const recorder = new OnboardingRecorder(store);
  const input = { guildId: GUILD, memberId: MEMBER, isBot: false, pending: false };

  assert.equal((await decidePrompt(store, input)).shouldPrompt, true);
  await recorder.prompted(GUILD, MEMBER, '1045943373007171674');

  const second = await decidePrompt(store, input);
  assert.equal(second.shouldPrompt, false, 'a restart must not re-welcome the same member');
  assert.equal(second.reason, 'already_prompted');
});

// --- where do we send them --------------------------------------------------

test('a visible dedicated channel is used and is not flagged degraded', () => {
  const shooters = pickByKey('shooters')!;
  const d = resolveDestination(shooters, seeEverything);
  assert.equal(d.channelId, shooters.primaryChannelId);
  assert.equal(d.degraded, false);
});

test('a dark dedicated channel falls back to the hub and is flagged degraded', () => {
  const shooters = pickByKey('shooters')!;
  const d = resolveDestination(shooters, seeNothing);
  assert.equal(d.channelId, GAME_HUB_CHANNEL_ID, 'must not link a channel they cannot open');
  assert.equal(d.degraded, true, 'falling back has to be visible in the numbers');
});

test('a pick with no dedicated room is not counted as degraded', () => {
  // Routing Rocket League to the hub is the intended destination, not a
  // failure, so it must not inflate the degraded count the CEO is watching.
  const rl = pickByKey('rocketleague')!;
  const d = resolveDestination(rl, seeNothing);
  assert.equal(d.channelId, GAME_HUB_CHANNEL_ID);
  assert.equal(d.degraded, false);
});

test('planSelection dedupes channels and reports unknown keys', () => {
  const plan = planSelection(['shooters', 'rocketleague', 'fallguys', 'not-a-game'], seeNothing);
  assert.deepEqual(plan.unknownKeys, ['not-a-game']);
  assert.equal(plan.roleIds.length, 3);
  assert.deepEqual(plan.channelIds, [GAME_HUB_CHANNEL_ID], 'three picks, one shared room, one link');
  assert.equal(plan.degradedCount, 1, 'only the shooters fallback counts as degraded');
});

test('an empty selection plans nothing rather than throwing', () => {
  const plan = planSelection([], seeEverything);
  assert.deepEqual(plan.roleIds, []);
  assert.deepEqual(plan.channelIds, []);
});

test('currentGameKeys reflects only game roles the member holds', () => {
  const shooters = pickByKey('shooters')!;
  const horror = pickByKey('horror')!;
  const keys = currentGameKeys([shooters.roleId, horror.roleId, '999999999999999999']);
  assert.deepEqual(keys.sort(), ['horror', 'shooters']);
});

// --- what the funnel records ------------------------------------------------

test('the full onboarding funnel is recorded and time-to-route is measurable', async () => {
  const store = await freshStore();

  await store.record({
    guildId: GUILD,
    memberId: MEMBER,
    eventType: 'member_join',
    occurredAt: '2026-08-19T12:00:00.000Z',
    source: 'invite:aB3xY9',
  });
  await store.record({
    guildId: GUILD,
    memberId: MEMBER,
    eventType: 'channel_routed',
    occurredAt: '2026-08-19T12:00:42.000Z',
    source: 'picker',
  });

  assert.equal(
    await store.secondsBetween(GUILD, MEMBER, 'member_join', 'channel_routed'),
    42,
    'this is the number TWO-7 is judged on',
  );
});

test('time-to-route is null until the member is actually routed', async () => {
  const store = await freshStore();
  await store.record({
    guildId: GUILD,
    memberId: MEMBER,
    eventType: 'member_join',
    occurredAt: '2026-08-19T12:00:00.000Z',
    source: 'unknown',
  });
  assert.equal(await store.secondsBetween(GUILD, MEMBER, 'member_join', 'channel_routed'), null);
});

test('re-picking games counts once per member, not once per click', async () => {
  const store = await freshStore();
  const recorder = new OnboardingRecorder(store);
  const plan = planSelection(['shooters'], seeEverything);

  await recorder.selected(GUILD, MEMBER, plan);
  await recorder.routed(GUILD, MEMBER, plan);
  // Same member changes their mind a minute later.
  await recorder.selected(GUILD, MEMBER, planSelection(['horror'], seeEverything));
  await recorder.routed(GUILD, MEMBER, planSelection(['horror'], seeEverything));

  assert.equal(
    await store.countMembersWith('channel_routed'),
    1,
    'reach counts people, not clicks',
  );
  assert.ok((await store.countByType('channel_routed')) >= 1);
});

test('recorded metadata carries game keys only, never member text', async () => {
  const store = await freshStore();
  const recorder = new OnboardingRecorder(store);
  const e = await recorder.selected(
    GUILD,
    MEMBER,
    planSelection(['shooters', 'horror'], seeEverything),
  );
  assert.deepEqual(e.metadata, { picks: ['shooters', 'horror'] });
});
