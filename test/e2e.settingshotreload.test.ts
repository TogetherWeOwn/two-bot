/**
 * The hot path, end to end: a row in `guild_settings` changes what a running
 * consumer does, with nothing reconstructed in between.
 *
 * TOG-3100 asks for a staging proof - one HOT key taking effect without a
 * restart, shown by a log line before and after. That proof runs against the
 * deployed bot and is recorded on the card. This is the same claim made
 * repeatable: the composition here is exactly the one in `src/index.ts`
 * (SettingsStore -> envSnapshot -> storeFirst -> loadConfig -> thunks into
 * RaidWatch), against real Postgres and the shipping migrations, so the
 * mechanism cannot rot between staging runs without a red suite.
 *
 * Every assertion is against a `RaidWatch` built once, before the write. If any
 * of these passed because something was rebuilt, it would be proving that a
 * restart works, which nobody doubted.
 *
 * The control is the point. `fixed` is an identical watch constructed with the
 * same number rather than a thunk, and is fed the identical joins. Without it,
 * "the fourth join alerted" would be consistent with the threshold never having
 * moved at all.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { SettingsStore } from '../src/core/settings.ts';
import { loadConfig, storeFirst, HOT_WIRED_FIELDS } from '../src/core/config.ts';
import { RaidWatch } from '../src/analytics/raidWatch.ts';
import { AutomodService, type AutomodTargetResolver } from '../src/automod/service.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import type { ModerationService } from '../src/moderation/service.ts';
import type { ModerationStore } from '../src/moderation/store.ts';
import type { AutomodStore } from '../src/automod/store.ts';

const GUILD = '326474832151838730';
const ADMIN = '111111111111111111';
/** Fixed, because a raid is judged against join timestamps, never the clock. */
const T0 = Date.parse('2026-09-17T09:00:00.000Z');

let testDb: TestDb;

before(async () => {
  testDb = await openTestDb(import.meta.filename);
  // loadConfig() reads these from the environment and always will - they are
  // the bootstrap, and env_only in src/core/settingsCatalog.ts for that reason.
  process.env.DISCORD_TOKEN ??= 'test-token-not-a-real-one';
  process.env.TWO_DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';
  // Set explicitly rather than left unset, so what follows is store-beats-env
  // and not store-beats-the-`?? 5`-default in loadConfig().
  process.env.TWO_RAID_JOIN_THRESHOLD = '5';
  // TOG-3536: same reasoning - explicit so what follows is store-beats-env,
  // not store-beats-the-`?? ...`-default in loadConfig().
  process.env.DISCORD_LANDING_CHANNEL_IDS = '100000000000000001,100000000000000002';
  process.env.TWO_AUTOMOD_REPEAT_COUNT = '4';
});
after(async () => {
  await testDb.cleanup();
});
beforeEach(async () => {
  await testDb.reset();
});

/** The four lines of `src/index.ts` this file exists to exercise. */
function bootLikeIndex(store: SettingsStore) {
  let liveCfg = loadConfig(storeFirst(store.envSnapshot(GUILD)));
  const changes: { key: string; from: unknown; to: unknown }[] = [];
  store.onChange(() => {
    const previous = liveCfg;
    liveCfg = loadConfig(storeFirst(store.envSnapshot(GUILD)));
    for (const [key, read] of Object.entries(HOT_WIRED_FIELDS)) {
      const from = read(previous);
      const to = read(liveCfg);
      if (from !== to) changes.push({ key, from, to });
    }
  });
  const live = new RaidWatch({
    threshold: () => liveCfg.raidJoinThreshold,
    windowSeconds: () => liveCfg.raidWindowSeconds,
  });
  return { live, changes, cfg: () => liveCfg };
}

test('a stored threshold reaches a RaidWatch that was built before the write', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const { live, cfg } = bootLikeIndex(store);
  // The control: same options, but a number, which is what shipped before this
  // card. Fed the identical joins throughout.
  const fixed = new RaidWatch({ threshold: 5, windowSeconds: 60 });

  assert.equal(cfg().raidJoinThreshold, 5, 'the environment value is the starting point');

  // Three joins: under 5, so neither watch says anything.
  for (let i = 0; i < 3; i++) {
    const at = T0 + i * 1000;
    assert.equal(live.observe(GUILD, `member-${i}`, at), null);
    assert.equal(fixed.observe(GUILD, `member-${i}`, at), null);
  }

  await store.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 3, ADMIN);
  assert.equal(await store.refreshIfChanged(), true, 'the version poll saw the write');
  assert.equal(cfg().raidJoinThreshold, 3, 'the store beat the environment');

  // The fourth join. Same guild, same timestamp, same watch object that was
  // constructed before the row existed: 4 >= 3 now, and 4 < 5 still for the
  // control.
  const at = T0 + 3000;
  const alert = live.observe(GUILD, 'member-3', at);
  assert.equal(fixed.observe(GUILD, 'member-3', at), null, 'the control must not alert');
  assert.ok(alert, 'the live watch alerts on a threshold it was never constructed with');
  assert.equal(alert.count, 4);
});

test('the window is hot too, and the alert reports the window it actually applied', () => {
  // Both raid keys are HOT_WIRED, and the window is the one that decides which
  // joins are even in the count - a stale window would silently change the
  // answer rather than fail.
  let windowSeconds = 60;
  const watch = new RaidWatch({ threshold: 3, windowSeconds: () => windowSeconds });

  assert.equal(watch.observe(GUILD, 'a', T0), null);
  assert.equal(watch.observe(GUILD, 'b', T0 + 50_000), null);

  // Narrow the window under it. `a` is now 50s outside a 10s window, so the
  // third join sees 2 in the window, not 3.
  windowSeconds = 10;
  assert.equal(watch.observe(GUILD, 'c', T0 + 55_000), null, 'the narrowed window pruned `a`');
  assert.equal(watch.windowSize(GUILD), 2);

  // Widen it again and the same third member cannot re-trip it (already
  // counted), but a fourth join now sees all of them.
  windowSeconds = 600;
  const alert = watch.observe(GUILD, 'd', T0 + 56_000);
  assert.ok(alert);
  assert.equal(
    alert.windowSeconds,
    600,
    'the alert reports the window it pruned against, not the boot value',
  );
});

test('deleting the row hands the key back to the environment, live', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const { cfg, changes } = bootLikeIndex(store);

  await store.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 3, ADMIN);
  // A second, newer row, so the one about to be deleted is not the one holding
  // max(version). Written second on purpose: with the threshold alone in the
  // table, deleting it moves the maximum and the delete would be noticed for a
  // reason that does not generalise. This is the shape that failed on staging.
  // `TWO_ONBOARDING_DRY_RUN` is storable but not HOT_WIRED, so it adds a row
  // without adding a line to `changes`.
  await store.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ADMIN);
  await store.refreshIfChanged();
  assert.equal(cfg().raidJoinThreshold, 3);
  const versionBefore = store.currentVersion();

  // This is the documented undo path for the whole programme: stop writing
  // rows. It has to work without a restart for the same reason the write does.
  await store.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', null, ADMIN);
  assert.equal(await store.refreshIfChanged(), true, 'the delete reached the poll');
  assert.equal(
    store.currentVersion(),
    versionBefore,
    'and did so on the row count, because max(version) never moved',
  );
  assert.equal(cfg().raidJoinThreshold, 5, 'back to the environment value');

  // And both moves are named, which is what makes the staging proof readable:
  // "settings reloaded" would not have told anyone which number they now have.
  assert.deepEqual(changes, [
    { key: 'TWO_RAID_JOIN_THRESHOLD', from: 5, to: 3 },
    { key: 'TWO_RAID_JOIN_THRESHOLD', from: 3, to: 5 },
  ]);
});

/**
 * TOG-3536: the onboarding landing channels and the automod repeat-count are
 * the two settings this card wires. Same discipline as the raid pair above -
 * built once, before the write, with a control that shows what the old,
 * captured-once behaviour would have done with the identical events.
 */
test('a stored landing channel list reaches a thunk built before the write', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const { cfg } = bootLikeIndex(store);
  // The exact shape src/index.ts passes into OnboardingDeps/SessionWelcomeDeps.
  const live = () => cfg().landingChannelIds;
  // The control: a plain array captured once, which is what shipped before
  // this card (`registerOnboarding`/`registerSessionWelcome` destructured the
  // list itself rather than a thunk).
  const fixed = cfg().landingChannelIds;

  assert.deepEqual(live(), ['100000000000000001', '100000000000000002']);

  await store.set(GUILD, 'DISCORD_LANDING_CHANNEL_IDS', ['200000000000000003'], ADMIN);
  assert.equal(await store.refreshIfChanged(), true, 'the version poll saw the write');

  assert.deepEqual(
    live(),
    ['200000000000000003'],
    'the thunk this card wires into onboarding/session welcome sees the new list',
  );
  assert.deepEqual(
    fixed,
    ['100000000000000001', '100000000000000002'],
    'a value captured once, the way it shipped before this card, does not move',
  );
});

const AUTOMOD_POLICY: AutomodPolicy = {
  badWords: [],
  blockedAttachmentExtensions: [],
  allowedDomains: [],
  // Overridden per-call by the live/fixed thunk below; irrelevant here.
  repeatedMessageCount: 4,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [{ violations: 1, action: 'delete' }],
};

function repeatMessage(id: string, at: number): AutomodMessage {
  return {
    guildId: GUILD,
    channelId: '900000000000000001',
    messageId: id,
    authorId: '800000000000000001',
    authorIsBot: false,
    roleIds: [],
    content: 'buy discounted widgets now',
    mentionedUserIds: [],
    attachmentNames: [],
    observedTimestamp: at,
  };
}

/** Dry run so the only thing exercised is `matchAutomod` and the live thunk - no Discord, no moderation execution. */
function dryRunAutomod(liveRepeatedMessageCount: () => number): AutomodService {
  const moderationStore = {
    claim: async () => ({ state: 'claimed' as const }),
    recordAudit: async () => {},
    complete: async () => {},
    release: async () => {},
  } as unknown as ModerationStore;
  const resolver = {
    target: async () => {
      throw new Error('dry run must never resolve a target');
    },
  } as unknown as AutomodTargetResolver;
  return new AutomodService(
    {} as ModerationDiscordClient,
    { targetProtection: () => undefined } as unknown as ModerationService,
    moderationStore,
    {} as AutomodStore,
    resolver,
    { dryRun: true, owenUserId: 'owen', botHighestRolePosition: 0, policy: AUTOMOD_POLICY },
    undefined,
    liveRepeatedMessageCount,
  );
}

test('a stored repeat-count threshold reaches an AutomodService built before the write', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const { cfg } = bootLikeIndex(store);
  const live = dryRunAutomod(() => cfg().automodRepeatedMessageCount);
  // The control: the exact default `AutomodServiceOptions` falls back to when
  // TOG-3536 never reaches the call site - a number captured once.
  const fixed = dryRunAutomod(() => 4);

  assert.equal(cfg().automodRepeatedMessageCount, 4, 'the environment value is the starting point');

  // Two repeats each: under 4, so neither tracker fires yet.
  for (let i = 0; i < 2; i++) {
    const at = T0 + i * 1000;
    assert.equal((await live.inspect(repeatMessage(`m${i}`, at))).matched, false);
    assert.equal((await fixed.inspect(repeatMessage(`f${i}`, at))).matched, false);
  }

  await store.set(GUILD, 'TWO_AUTOMOD_REPEAT_COUNT', 2, ADMIN);
  assert.equal(await store.refreshIfChanged(), true, 'the version poll saw the write');
  assert.equal(cfg().automodRepeatedMessageCount, 2, 'the store beat the environment');

  // The third identical message from the same author: both trackers have now
  // seen 3 repeats, but only the live threshold moved (2 <= 3; the control's
  // stayed at 4, and 3 < 4).
  const at = T0 + 2000;
  const liveResult = await live.inspect(repeatMessage('m2', at));
  const fixedResult = await fixed.inspect(repeatMessage('f2', at));
  assert.equal(fixedResult.matched, false, 'the control must not match yet');
  assert.equal(liveResult.matched, true, 'the live service matches on a threshold it was never constructed with');
  assert.equal(liveResult.filter, 'repeated_message');
});

/** Insert straight into the table, bypassing `store.set()` and its TypeScript guard. */
function rawInsert(key: string, value: string): Promise<unknown> {
  return testDb.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, key, value, version, updated_by)
       VALUES (?, ?, ?::jsonb, nextval('guild_settings_version_seq'), ?)`,
    )
    .run(GUILD, key, JSON.stringify(value), ADMIN);
}

test('an env-only key cannot become a row at all, even with the TypeScript bypassed', async () => {
  // TOG-3183: TWO_MODERATION co-gates nine moderation verbs from outside the
  // TWO_INTERNAL_ namespace, which is why it is env_only in the catalog rather
  // than merely un-prefixed. This is the layer that holds when the writer is a
  // psql session rather than this codebase.
  await assert.rejects(
    () => rawInsert('TWO_MODERATION', '1'),
    (err: { code?: string; constraint?: string }) => {
      assert.equal(err.code, '23514');
      assert.equal(err.constraint, 'guild_settings_env_only_keys');
      return true;
    },
  );
});

test('a key the schema allows but the catalog has never heard of is still dropped on read', async () => {
  // The constraint can only list names somebody thought of. A key invented
  // after migration 0027 gets past it, so the read side has to be fail-closed
  // on its own - this is the layer that decides what an unclassified name does,
  // and the answer is nothing.
  const store = new SettingsStore(testDb.db);
  await rawInsert('TWO_NOT_IN_THE_CATALOG', 'boo');
  await store.load();

  assert.equal(store.get(GUILD, 'TWO_NOT_IN_THE_CATALOG'), 'boo', 'the row really is there');
  assert.equal(store.envSnapshot(GUILD).has('TWO_NOT_IN_THE_CATALOG'), false);
  assert.equal(storeFirst(store.envSnapshot(GUILD)).get('TWO_NOT_IN_THE_CATALOG'), undefined);

  // Anti-vacuity: the same two calls do carry a catalogued key, so the two
  // assertions above are the filter working and not an empty snapshot.
  await rawInsert('TWO_RAID_JOIN_THRESHOLD', '3');
  await store.load();
  assert.equal(store.envSnapshot(GUILD).get('TWO_RAID_JOIN_THRESHOLD'), '3');
  assert.equal(storeFirst(store.envSnapshot(GUILD)).get('TWO_RAID_JOIN_THRESHOLD'), '3');
});

/**
 * The review of `f538689` (TOG-3217 finding #5) left one claim untested for want
 * of a database: the refusal above was only ever exercised on INSERT. Every test
 * before this one reaches the constraint by creating a row, so a constraint that
 * somehow applied to INSERT alone would pass all of them.
 *
 * That matters because the row an attacker would use already exists and is
 * already legal. `TWO_RAID_JOIN_THRESHOLD` is settable by design from the admin
 * UI in slice 3; renaming that row is a strictly easier move than inserting a
 * fresh one, and it is the shape `settings.set()` actually emits - an upsert,
 * whose `DO UPDATE` arm never goes through the INSERT path at all.
 */
async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  return {};
}

test('an UPDATE cannot rename a legal row into an env-only key', async () => {
  // The control: the row exists and is legal, so a refusal below is the
  // constraint rejecting the new key and not the statement matching no rows.
  await rawInsert('TWO_RAID_JOIN_THRESHOLD', '5');
  const rename = (to: string) =>
    testDb.db
      .prepare(`UPDATE guild_settings SET key = ? WHERE guild_id = ? AND key = 'TWO_RAID_JOIN_THRESHOLD'`)
      .run(to, GUILD);

  for (const [key, constraint] of [
    ['TWO_INTERNAL_ALLOW_MODERATION', 'guild_settings_no_internal_keys'],
    ['TWO_MODERATION', 'guild_settings_env_only_keys'],
    ['DISCORD_TOKEN', 'guild_settings_env_only_keys'],
  ] as const) {
    const err = await refusal(() => rename(key));
    assert.equal(err.code, '23514', `UPDATE to ${key} was not refused`);
    assert.equal(err.constraint, constraint);
  }

  // Anti-vacuity: the identical UPDATE to a catalogued key does land, so the
  // three refusals are about the key and not about UPDATE being broken here.
  await rename('TWO_RAID_WINDOW_SECONDS');
  const rows = await testDb.db
    .prepare(`SELECT key FROM guild_settings WHERE guild_id = ?`)
    .all(GUILD);
  assert.deepEqual(
    (rows as Array<{ key: string }>).map((r) => r.key),
    ['TWO_RAID_WINDOW_SECONDS'],
  );
});

test("an upsert's DO UPDATE arm is checked, not just its INSERT arm", async () => {
  await rawInsert('TWO_RAID_JOIN_THRESHOLD', '5');

  // The shape store.set() emits. The conflict fires, so the INSERT arm is
  // never the thing evaluated - only DO UPDATE is.
  const viaKey = await refusal(() =>
    testDb.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, key, value, version, updated_by)
         VALUES (?, 'TWO_RAID_JOIN_THRESHOLD', '6'::jsonb, nextval('guild_settings_version_seq'), ?)
         ON CONFLICT (guild_id, key) DO UPDATE SET key = 'TWO_INTERNAL_ALLOW_MODERATION'`,
      )
      .run(GUILD, ADMIN),
  );
  assert.equal(viaKey.code, '23514');
  assert.equal(viaKey.constraint, 'guild_settings_no_internal_keys');

  // And the INSERT arm of an upsert naming an env-only key outright.
  const viaInsert = await refusal(() =>
    testDb.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, key, value, version, updated_by)
         VALUES (?, 'TWO_MODERATION', '"1"'::jsonb, nextval('guild_settings_version_seq'), ?)
         ON CONFLICT (guild_id, key) DO UPDATE SET value = EXCLUDED.value`,
      )
      .run(GUILD, ADMIN),
  );
  assert.equal(viaInsert.code, '23514');
  assert.equal(viaInsert.constraint, 'guild_settings_env_only_keys');
});

test('all settings refusals are VALID constraints, checked on every write', async () => {
  // `convalidated` is the half that can actually move: ADD CONSTRAINT ... NOT
  // VALID is accepted by Postgres and skips the scan of existing rows, so a
  // key already in the table when 0027 lands would stay. Mutation-checked -
  // adding NOT VALID to 0027 fails this test and only this test.
  //
  // `condeferrable` is NOT a live guard and is not claimed as one: Postgres
  // rejects `DEFERRABLE` on a CHECK constraint outright (0A000, "CHECK
  // constraints cannot be marked DEFERRABLE"), so this can only fail if one of
  // these stops being a CHECK - a trigger or FK rewrite, where deferral is
  // reachable and `SET CONSTRAINTS ALL DEFERRED` would hold an illegal key
  // live inside a transaction. It is a tripwire on the constraint type, and it
  // survives mutation because there is no mutation to make.
  //
  // Read from the catalog rather than attempted: an attempted deferral refuses
  // either way, so the attempt cannot tell a non-deferrable constraint from a
  // deferred one.
  const rows = (await testDb.db
    .prepare(
      `SELECT conname, convalidated, condeferrable
         FROM pg_constraint
        WHERE conrelid = 'guild_settings'::regclass AND contype = 'c'
        ORDER BY conname`,
    )
    .all()) as Array<{ conname: string; convalidated: boolean; condeferrable: boolean }>;

  assert.deepEqual(
    rows.map((r) => r.conname),
    ['guild_settings_env_only_keys', 'guild_settings_no_internal_keys', 'guild_settings_rota_env_only_keys',
      'guild_settings_rota_primary_env_only'],
    'all CHECK constraints are present on the table',
  );
  for (const r of rows) {
    assert.equal(r.convalidated, true, `${r.conname} is NOT VALID: existing rows were never checked`);
    assert.equal(r.condeferrable, false, `${r.conname} is DEFERRABLE and can be postponed past a write`);
  }
});
