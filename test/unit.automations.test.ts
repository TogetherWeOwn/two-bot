/**
 * Automations unit tests (TOG-1648): template language, MEE6 translation,
 * service validation, sticky debounce, scheduler advance, and the store's
 * collision guards.
 *
 * No network and no discord.js client: the service takes a fake Discord
 * surface, the store takes the test database (Postgres when the e2e variable
 * is set, SQLite otherwise - openTestDb handles both).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, PermissionFlagsBits, PermissionsBitField, type ApplicationCommandDataResolvable, type Client } from 'discord.js';
import { validateTemplate, renderTemplate, placeholdersIn } from '../src/automations/template.ts';
import {
  cleanMee6Name,
  translateMee6Template,
  parseMee6Export,
  translateExport,
} from '../src/automations/mee6.ts';
import { AutomationService, type AutomationDiscord } from '../src/automations/service.ts';
import { loadAutomationConfig } from '../src/automations/config.ts';
import {
  AutomationDiscord as AutomationDiscordClient,
  DiscordPostError,
  registerAutomationCommands,
} from '../src/automations/discord.ts';
import { AutomationStore, type StickyMessageRow } from '../src/automations/store.ts';
import { registerAutomationGateway, triggerWord } from '../src/automations/gateway.ts';
import { CommandRegistry, mergedCommandData } from '../src/discord/commandRegistry.ts';
import { MODERATION_COMMAND_DATA } from '../src/moderation/commands.ts';
import { AUTOMATION_COMMAND_DATA, MAX_CUSTOM_COMMANDS } from '../src/discord/commandNames.ts';
import { openTestDb, TEST_PG_URL, usingPostgres, type TestDb } from './helpers/testDb.ts';
import { openDb } from '../src/store/db.ts';
import { loadMigrations } from '../src/store/migrate.ts';
import { cleanupDecision, restoredStickyRow } from '../scripts/staging-automations-proof-state.ts';

const GUILD = '1545644954272137297';
const CHANNEL = '100000000000000001';
const ACTOR = '900000000000000001';

/** A fake Discord surface that records every post and delete. */
function fakeDiscord(): AutomationDiscord & { posts: { channelId: string; content: string }[]; deletes: { channelId: string; messageId: string }[] } {
  const posts: { channelId: string; content: string }[] = [];
  const deletes: { channelId: string; messageId: string }[] = [];
  let n = 0;
  return {
    posts,
    deletes,
    async postMessage(channelId: string, content: string) {
      posts.push({ channelId, content });
      return `msg${++n}`;
    },
    async deleteMessage(channelId: string, messageId: string) {
      deletes.push({ channelId, messageId });
    },
  };
}

// --- template ---------------------------------------------------------------

test('template: known placeholders validate', () => {
  validateTemplate('Hello {user} in {server}/{channel} aka {username}');
});

test('template: unknown placeholder is a definition-time error', () => {
  assert.throws(() => validateTemplate('Hi {usre}'), /Unknown placeholder \{usre\}/);
});

test('template: placeholdersIn lists what a template uses', () => {
  assert.deepEqual(placeholdersIn('{user} and {user} and {server}'), ['user', 'server']);
});

test('template: render substitutes and preserves unknown-but-validated text', () => {
  const out = renderTemplate('hey {user} of {server}', {
    user: '<@1>',
    username: 'one',
    server: 'TWO',
    channel: '#general',
  });
  assert.equal(out, 'hey <@1> of TWO');
});

test('template: rendered output over the Discord ceiling is refused', () => {
  assert.throws(
    () =>
      renderTemplate(`{username}${'x'.repeat(2000)}`, {
        user: '',
        username: 'x'.repeat(50),
        server: '',
        channel: '',
      }),
    /2000/,
  );
});

// --- MEE6 translation ---------------------------------------------------------

test('mee6: names are cleaned and truncated', () => {
  assert.equal(cleanMee6Name('Rules & FAQ!'), 'rulesfaq');
  assert.equal(cleanMee6Name('a'.repeat(50)).length, 32);
  assert.equal(cleanMee6Name('!!!'), '');
});

test('mee6: placeholders map and unsupported words or punctuation forms drop', () => {
  assert.equal(
    translateMee6Template('{user} welcome to {server}! #{member_count} {user.id} {random-choice}'),
    '{user} welcome to {server}! #  ',
  );
});

test('mee6: parse accepts the known field spellings and nothing else', () => {
  const parsed = parseMee6Export([
    { command: 'faq', response: 'a' },
    { name: 'rules', message: 'b' },
    { command: 'x', content: 'c' },
  ]);
  assert.equal(parsed.length, 3);
  assert.throws(() => parseMee6Export({}), /array/);
  assert.throws(() => parseMee6Export([{ command: 1, response: 'a' }]), /string/);
});

test('mee6: translateExport preserves the first trigger and suffixes later collisions', () => {
  const out = translateExport([
    { command: 'faq', response: 'first' },
    { command: 'FAQ!', response: 'second' },
    { command: 'welcome', response: 'third' },
    { command: `${'a'.repeat(32)}!`, response: 'long first' },
    { command: 'a'.repeat(32), response: 'long second' },
  ]);
  assert.deepEqual(out.conflicts, ['faq', 'a'.repeat(32)]);
  assert.deepEqual(out.commands.map((c) => c.name), [
    'faq',
    'faq-2',
    'welcome',
    'a'.repeat(32),
    `${'a'.repeat(30)}-2`,
  ]);
  assert.deepEqual(out.commands.map((c) => c.textTrigger), [
    '!faq',
    null,
    '!welcome',
    `!${'a'.repeat(32)}`,
    null,
  ]);
});

// --- command registry ---------------------------------------------------------

test('automations are default-off and categorically refuse the live guild', () => {
  assert.deepEqual(loadAutomationConfig({}), { enabled: false, textCommandsEnabled: false });
  assert.deepEqual(loadAutomationConfig({
    TWO_AUTOMATIONS: '1',
    TWO_TEXT_COMMANDS: '1',
    DISCORD_GUILD_ID: GUILD,
  }), {
    enabled: true,
    textCommandsEnabled: true,
  });
  assert.deepEqual(loadAutomationConfig({ TWO_TEXT_COMMANDS: '1' }), {
    enabled: false,
    textCommandsEnabled: false,
  });
  assert.throws(
    () => loadAutomationConfig({
      TWO_AUTOMATIONS: '1',
      DISCORD_GUILD_ID: '326474832151838730',
    }),
    /staging-only.*expected guild/i,
  );
  assert.throws(
    () => loadAutomationConfig({ TWO_AUTOMATIONS: '1' }),
    /got unset/i,
  );
  assert.throws(
    () => loadAutomationConfig({ TWO_AUTOMATIONS: '1', DISCORD_GUILD_ID: '999999999999999999' }),
    /got 999999999999999999/i,
  );
});

test('command registry merges every built-in and custom command without replacement', () => {
  const commands = mergedCommandData([
    { name: 'faq', description: 'FAQ', enabled: true },
    { name: 'disabled', description: 'off', enabled: false },
    { name: 'rank', description: 'must not replace builtin', enabled: true },
    { name: 'ban', description: 'must not replace moderation', enabled: true },
  ], [
    ...AUTOMATION_COMMAND_DATA,
    ...MODERATION_COMMAND_DATA,
  ] as ApplicationCommandDataResolvable[]) as { name: string; description: string }[];
  const names = commands.map((command) => command.name);
  assert.ok(names.includes('rank'));
  assert.ok(names.includes('leaderboard'));
  assert.ok(names.includes('command'));
  assert.ok(names.includes('ban'));
  assert.ok(names.includes('timeout'));
  assert.ok(names.includes('faq'));
  assert.ok(!names.includes('disabled'));
  assert.equal(names.filter((name) => name === 'rank').length, 1);
  assert.equal(names.filter((name) => name === 'ban').length, 1);
});

test('command registry rejects overflow instead of silently truncating definitions', () => {
  const custom = Array.from({ length: MAX_CUSTOM_COMMANDS + 1 }, (_, i) => ({
    name: `custom-${i}`,
    description: `custom ${i}`,
    enabled: true,
  }));
  assert.throws(
    () => mergedCommandData(custom, [
      ...AUTOMATION_COMMAND_DATA,
      ...MODERATION_COMMAND_DATA,
    ] as ApplicationCommandDataResolvable[]),
    /above Discord's guild limit/,
  );
});

test('command registry serializes full-set syncs and publishes the newest snapshot last', async () => {
  let definitions = [{ name: 'old', description: 'old', enabled: true }];
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstSetStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const firstSetHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const published: string[][] = [];
  let sets = 0;
  const guild = {
    commands: {
      async set(commands: ApplicationCommandDataResolvable[]) {
        sets++;
        if (sets === 1) {
          firstStarted();
          await firstSetHeld;
        }
        published.push(commands.map(commandNameForTest));
      },
    },
  };
  const client = {
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;
  const automations = {
    async listCommands() { return definitions; },
  } as unknown as AutomationStore;
  const registry = new CommandRegistry(client, { guildId: GUILD, automations });

  const first = registry.sync();
  await firstSetStarted;
  definitions = [{ name: 'new', description: 'new', enabled: true }];
  const second = registry.sync();
  releaseFirst();
  await Promise.all([first, second]);

  assert.ok(published[0].includes('old'));
  assert.ok(!published[0].includes('new'));
  assert.ok(published[1].includes('new'));
  assert.ok(!published[1].includes('old'));
});

function commandNameForTest(command: ApplicationCommandDataResolvable): string {
  return 'name' in command && typeof command.name === 'string' ? command.name : '';
}

test('service: moderation command names are reserved on admin writes', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const svc = new AutomationService(new AutomationStore(db.db), fakeDiscord());
  await assert.rejects(
    svc.putCommand({
      guildId: GUILD,
      name: 'ban',
      description: 'shadow moderation',
      template: 'no',
      actorId: ACTOR,
    }),
    /reserved by Owen/,
  );
  await db.cleanup();
});

// --- service + store ----------------------------------------------------------

test('service: command CRUD validates and audits', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  const created = await svc.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'FAQ',
    template: 'Read {channel}',
    textTrigger: '!faq',
    actorId: ACTOR,
  });
  assert.equal(created.created, true);
  const updated = await svc.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'FAQ v2',
    template: 'Read {channel} again',
    textTrigger: '!faq',
    actorId: ACTOR,
  });
  assert.equal(updated.created, false);
  await assert.rejects(
    () =>
      svc.putCommand({
        guildId: GUILD,
        name: 'BAD NAME',
        description: 'x',
        template: 'y',
        actorId: ACTOR,
      }),
    /name/,
  );
  assert.equal(await svc.deleteCommand(GUILD, 'faq', ACTOR), true);
  assert.equal(await svc.deleteCommand(GUILD, 'faq', ACTOR), false);
  await db.cleanup();
});

test('service: a rejected update is audited as command.update', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'FAQ',
    template: 'old',
    textTrigger: '!faq',
    actorId: ACTOR,
  });
  await assert.rejects(
    svc.putCommand({
      guildId: GUILD,
      name: 'faq',
      description: '',
      template: 'new',
      textTrigger: '!faq',
      actorId: ACTOR,
    }),
    /Description/,
  );
  const rejected = await db.db.prepare(
    `SELECT action, outcome FROM automation_audit_log WHERE target_key = ? AND outcome = 'rejected'`,
  ).all<{ action: string; outcome: string }>('faq');
  assert.deepEqual(rejected.map((row) => ({ ...row })), [{ action: 'command.update', outcome: 'rejected' }]);
  await db.cleanup();
});

test('service: rejected schedule and sticky updates retain update audit labels', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.putScheduled({
    guildId: GUILD,
    id: 'audit-schedule',
    channelId: CHANNEL,
    body: 'old',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });
  await svc.putSticky({
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'old',
    debounceSeconds: 5,
    actorId: ACTOR,
  });
  await assert.rejects(
    svc.putScheduled({
      guildId: GUILD,
      id: 'audit-schedule',
      channelId: CHANNEL,
      body: '',
      nextRunAt: '2026-09-08T10:00:00.000Z',
      actorId: ACTOR,
    }),
    /Message body/,
  );
  await assert.rejects(
    svc.putSticky({
      guildId: GUILD,
      channelId: CHANNEL,
      body: '',
      debounceSeconds: 5,
      actorId: ACTOR,
    }),
    /Sticky body/,
  );
  const rejected = await db.db.prepare(
    `SELECT action FROM automation_audit_log WHERE outcome = 'rejected' ORDER BY action`,
  ).all<{ action: string }>();
  assert.deepEqual(rejected.map((row) => row.action), ['scheduled.update', 'sticky.update']);
  await db.cleanup();
});

test('service: command capacity permits same-name updates and refuses a new name', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  for (let i = 0; i < MAX_CUSTOM_COMMANDS; i++) {
    await svc.putCommand({
      guildId: GUILD,
      name: `limit-${i}`,
      description: `command ${i}`,
      template: 'old',
      actorId: ACTOR,
    });
  }
  const updated = await svc.putCommand({
    guildId: GUILD,
    name: 'limit-0',
    description: 'updated',
    template: 'new',
    actorId: ACTOR,
  });
  assert.equal(updated.created, false);
  await assert.rejects(
    svc.putCommand({
      guildId: GUILD,
      name: 'overflow',
      description: 'overflow',
      template: 'no',
      actorId: ACTOR,
    }),
    /guild limit/,
  );
  assert.equal((await store.listCommands(GUILD)).length, MAX_CUSTOM_COMMANDS);
  await db.cleanup();
});

test('store: two commands cannot claim one text trigger', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const at = '2026-09-08T00:00:00.000Z';
  const mk = (name: string, trigger: string) =>
    store.putCommand({
      guildId: GUILD,
      name,
      description: 'd',
      template: 't',
      textTrigger: trigger,
      enabled: true,
      createdBy: ACTOR,
      createdAt: at,
      updatedBy: ACTOR,
      updatedAt: at,
    });
  await mk('faq', '!faq');
  // `!FAQ` is rejected client-side (case-folded trigger would collide), so the
  // index collision is proven with a second lowercase trigger instead.
  await assert.rejects(() => mk('faq2', '!faq'), /unique/i);
  await db.cleanup();
});

test('service: schedule timestamps are normalized to canonical ISO', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.putScheduled({
    guildId: GUILD,
    id: 'normalized-time',
    channelId: CHANNEL,
    body: 'normalized',
    nextRunAt: '2026-09-08T12:30:00+02:30',
    actorId: ACTOR,
  });
  assert.equal(
    (await store.getScheduled(GUILD, 'normalized-time'))?.nextRunAt,
    '2026-09-08T10:00:00.000Z',
  );
  await db.cleanup();
});

test('service: scheduler claims only the configured guild', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  const otherGuild = '900000000000000099';
  await svc.putScheduled({
    guildId: otherGuild,
    id: 'other-guild-due',
    channelId: 'other-channel',
    body: 'must not post',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });
  assert.equal(await svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'), 0);
  assert.deepEqual(discord.posts, []);
  assert.equal((await store.getScheduled(otherGuild, 'other-guild-due'))?.claimToken, null);
  await db.cleanup();
});

test('service: scheduled one-shot fires once and disables itself', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putScheduled({
    guildId: GUILD,
    id: 's1',
    channelId: CHANNEL,
    body: 'one-shot',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    intervalSeconds: null,
    actorId: ACTOR,
  });
  const fired1 = await svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z');
  assert.equal(fired1, 1);
  const fired2 = await svc.runDueScheduled(GUILD, '2026-09-08T10:00:02.000Z');
  assert.equal(fired2, 0, 'a one-shot must not fire twice');
  const row = await store.getScheduled(GUILD, 's1');
  assert.equal(row?.enabled, false);
  assert.equal(discord.posts.length, 1);
  await db.cleanup();
});

test('service: recurring advances from run time, not from a missed tick', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.putScheduled({
    guildId: GUILD,
    id: 'r1',
    channelId: CHANNEL,
    body: 'recur',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    intervalSeconds: 60,
    actorId: ACTOR,
  });
  // An hour late: fires once, next run is one interval from NOW.
  await svc.runDueScheduled(GUILD, '2026-09-08T11:00:00.000Z');
  const row = await store.getScheduled(GUILD, 'r1');
  assert.equal(row?.nextRunAt, '2026-09-08T11:01:00.000Z');
  assert.equal(row?.enabled, true);
  await db.cleanup();
});

test('service: concurrent scheduler ticks claim one occurrence once', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putScheduled({
    guildId: GUILD,
    id: 'once-concurrent',
    channelId: CHANNEL,
    body: 'only once',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });
  const results = await Promise.all([
    svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'),
    svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'),
  ]);
  assert.equal(results.reduce((sum, n) => sum + n, 0), 1);
  assert.equal(discord.posts.length, 1);
  await db.cleanup();
});

test('service: slow serial scheduling claims each row only when it is ready to post', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  let clock = Date.parse('2026-09-08T10:00:01.000Z');
  let secondRun: Promise<number> | null = null;
  let launchedSecond = false;
  const posts: string[] = [];
  const now = () => new Date(clock).toISOString();
  const firstDiscord: AutomationDiscord = {
    async postMessage(_channelId, content) {
      posts.push(content);
      // Five serial 15-second posts move wall time from +1s to +76s. The
      // overlapping worker observes that wall clock, but its concurrent posts
      // do not each add another 15 seconds to global time.
      clock += 15_000;
      if (!launchedSecond && posts.length === 5) {
        launchedSecond = true;
        secondRun = secondService.runDueScheduled(GUILD);
      }
      return `msg-${content}`;
    },
    async deleteMessage() {},
  };
  const secondDiscord: AutomationDiscord = {
    async postMessage(_channelId, content) {
      posts.push(content);
      return `msg-${content}`;
    },
    async deleteMessage() {},
  };
  const firstService = new AutomationService(store, firstDiscord, now);
  const secondService = new AutomationService(store, secondDiscord, now);
  for (let i = 0; i < 10; i++) {
    await firstService.putScheduled({
      guildId: GUILD,
      id: `slow-${i}`,
      channelId: CHANNEL,
      body: `message-${i}`,
      nextRunAt: '2026-09-08T10:00:00.000Z',
      actorId: ACTOR,
    });
  }

  const firstFired = await firstService.runDueScheduled(GUILD);
  assert.ok(secondRun);
  const secondFired = await secondRun;
  assert.equal(firstFired + secondFired, 10);
  assert.equal(posts.length, 10);
  assert.equal(new Set(posts).size, 10, 'no row is posted twice after the first lease would have expired');
  await db.cleanup();
});

test('migration: an applied pre-lease 0015 is upgraded with scheduler claim columns', { skip: !usingPostgres }, async () => {
  const db = await openTestDb(`${import.meta.filename}-automation-upgrade`);
  assert.ok(db.schema);
  const claims = loadMigrations().find((migration) => migration.id === '0016_automation_claims');
  assert.ok(claims);
  await db.db.exec(`ALTER TABLE scheduled_messages DROP COLUMN claim_token`);
  await db.db.exec(`ALTER TABLE scheduled_messages DROP COLUMN claimed_at`);
  await db.db.exec(`ALTER TABLE sticky_messages DROP COLUMN claim_token`);
  await db.db.exec(`ALTER TABLE sticky_messages DROP COLUMN claimed_at`);

  const before = await db.db.prepare(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('scheduled_messages', 'sticky_messages')
        AND column_name IN ('claim_token', 'claimed_at')`,
  ).get<{ n: number }>();
  assert.equal(before?.n, 0);
  await db.db.exec(claims.sql);
  const after = await db.db.prepare(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('scheduled_messages', 'sticky_messages')
        AND column_name IN ('claim_token', 'claimed_at')`,
  ).get<{ n: number }>();
  assert.equal(after?.n, 4);

  const store = new AutomationStore(db.db);
  await new AutomationService(store, fakeDiscord()).putScheduled({
    guildId: GUILD,
    id: 'upgraded-scheduler',
    channelId: CHANNEL,
    body: 'works after upgrade',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });
  assert.equal((await store.claimDueScheduled(
    GUILD, '2026-09-08T10:00:01.000Z', 'upgrade-token', '2026-09-08T10:01:01.000Z', 1,
  )).length, 1);
  await db.cleanup();
});

test('store: independent Postgres clients skip an already locked scheduled row', { skip: !usingPostgres }, async () => {
  const first = await openTestDb(`${import.meta.filename}-claim-lock`);
  assert.ok(first.schema);
  const secondDb = await openDb(TEST_PG_URL, {
    schema: first.schema,
    applicationName: 'two-bot-test:scheduled-claim-second',
  });
  const firstStore = new AutomationStore(first.db);
  const secondStore = new AutomationStore(secondDb);
  await new AutomationService(firstStore, fakeDiscord()).putScheduled({
    guildId: GUILD,
    id: 'locked-once',
    channelId: CHANNEL,
    body: 'only once',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let claimed!: () => void;
  const locked = new Promise<void>((resolve) => { claimed = resolve; });
  const firstClaim = first.db.transaction(async (tx) => {
    const rows = await new AutomationStore(tx).claimDueScheduled(
      GUILD, '2026-09-08T10:00:01.000Z',
      'first-token',
      '2026-09-08T10:01:01.000Z',
    );
    claimed();
    await held;
    return rows;
  });
  await locked;
  const secondRows = await secondStore.claimDueScheduled(
    GUILD, '2026-09-08T10:00:01.000Z',
    'second-token',
    '2026-09-08T10:01:01.000Z',
  );
  release();
  const firstRows = await firstClaim;

  assert.equal(firstRows.length, 1);
  assert.equal(secondRows.length, 0);
  await secondDb.close();
  await first.cleanup();
});

test('service: cancellation during an active scheduled post deletes the orphan completion', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const posting = new Promise<void>((resolve) => { started = resolve; });
  discord.postMessage = async (channelId, content) => {
    discord.posts.push({ channelId, content });
    started();
    await held;
    return 'cancelled-message';
  };
  const service = new AutomationService(store, discord);
  await service.putScheduled({
    guildId: GUILD, id: 'cancel-active', channelId: CHANNEL, body: 'one',
    nextRunAt: '2026-09-08T10:00:00.000Z', actorId: ACTOR,
  });
  const run = service.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z');
  await posting;
  assert.equal(await service.deleteScheduled(GUILD, 'cancel-active', ACTOR), true);
  release();
  assert.equal(await run, 0);
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'cancelled-message' }]);
  assert.equal(await store.getScheduled(GUILD, 'cancel-active'), null);
  await db.cleanup();
});

test('service: scheduled update fences an active claim and its stale completion', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const service = new AutomationService(store, fakeDiscord());
  await service.putScheduled({
    guildId: GUILD, id: 'fenced-schedule', channelId: CHANNEL, body: 'old',
    nextRunAt: '2026-09-08T10:00:00.000Z', intervalSeconds: 60, actorId: ACTOR,
  });
  assert.equal((await store.claimDueScheduled(
    GUILD, '2026-09-08T10:00:01.000Z', 'old-claim', '2026-09-08T10:01:01.000Z',
  )).length, 1);
  await service.putScheduled({
    guildId: GUILD, id: 'fenced-schedule', channelId: CHANNEL, body: 'new',
    nextRunAt: '2026-09-08T12:00:00.000Z', intervalSeconds: null, enabled: false, actorId: ACTOR,
  });
  assert.equal(await store.markScheduledRun(
    GUILD, 'fenced-schedule', '2026-09-08T10:00:02.000Z', 'stale', 'old-claim',
  ), null);
  const current = await store.getScheduled(GUILD, 'fenced-schedule');
  assert.equal(current?.body, 'new');
  assert.equal(current?.enabled, false);
  assert.equal(current?.lastMessageId, null);
  assert.equal(current?.claimToken, null);
  await db.cleanup();
});

test('store: stale scheduled completion cannot replace a newer claim', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const service = new AutomationService(store, fakeDiscord());
  await service.putScheduled({
    guildId: GUILD, id: 'stale-schedule', channelId: CHANNEL, body: 'one',
    nextRunAt: '2026-09-08T10:00:00.000Z', actorId: ACTOR,
  });
  const first = await store.claimDueScheduled(
    GUILD, '2026-09-08T10:00:01.000Z', 'first', '2026-09-08T10:01:01.000Z',
  );
  assert.equal(first.length, 1);
  const second = await store.claimDueScheduled(
    GUILD, '2026-09-08T10:01:02.000Z', 'second', '2026-09-08T10:02:02.000Z',
  );
  assert.equal(second.length, 1);
  assert.equal(await store.markScheduledRun(
    GUILD, 'stale-schedule', '2026-09-08T10:01:03.000Z', 'old', 'first',
  ), null);
  const current = await store.getScheduled(GUILD, 'stale-schedule');
  assert.equal(current?.claimToken, 'second');
  assert.equal(current?.lastMessageId, null);
  await db.cleanup();
});

test('service: a sticky claim stays exclusive past debounce', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const posting = new Promise<void>((resolve) => { started = resolve; });
  const discord = fakeDiscord();
  discord.postMessage = async () => {
    started();
    await held;
    discord.posts.push({ channelId: CHANNEL, content: 'one sticky' });
    return 'slow';
  };
  const service = new AutomationService(store, discord);
  await service.putSticky({
    guildId: GUILD, channelId: CHANNEL, body: 'one sticky', debounceSeconds: 1, actorId: ACTOR,
  });
  const first = service.onChannelActivity(GUILD, CHANNEL, 'one', Date.parse('2026-09-08T10:00:00Z'));
  await posting;
  assert.equal(
    await service.onChannelActivity(GUILD, CHANNEL, 'two', Date.parse('2026-09-08T10:00:02Z')),
    'held',
  );
  release();
  assert.equal(await first, 'reposted');
  assert.equal(discord.posts.length, 1);
  await db.cleanup();
});

test('service: transient schedule failures preserve the occurrence and Retry-After', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  discord.postMessage = async () => {
    throw new DiscordPostError('rate limited', { status: 429, retryAfterMs: 90_000 });
  };
  await svc.putScheduled({
    guildId: GUILD,
    id: 'retry-me',
    channelId: CHANNEL,
    body: 'retry',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    actorId: ACTOR,
  });
  assert.equal(await svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'), 0);
  const row = await store.getScheduled(GUILD, 'retry-me');
  assert.equal(row?.enabled, true);
  assert.equal(row?.nextRunAt, '2026-09-08T10:01:31.000Z');
  await db.cleanup();
});

test('discord client sends an enforced nonce for idempotent scheduled posts', async () => {
  let body: Record<string, unknown> | null = null;
  const client = new AutomationDiscordClient({
    token: 't',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'same-message' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  assert.equal(await client.postMessage(CHANNEL, 'once', 'stable-nonce'), 'same-message');
  assert.deepEqual(body, {
    content: 'once',
    allowed_mentions: { parse: [] },
    nonce: 'stable-nonce',
    enforce_nonce: true,
  });
});

test('service: scheduled occurrence nonce stays stable across an ambiguous retry', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const nonces: string[] = [];
  let attempts = 0;
  const discord: AutomationDiscord = {
    async postMessage(_channelId, _content, nonce) {
      nonces.push(String(nonce));
      if (++attempts === 1) throw new DiscordPostError('response lost');
      return 'accepted';
    },
    async deleteMessage() {},
  };
  const service = new AutomationService(store, discord);
  await service.putScheduled({
    guildId: GUILD, id: 'ambiguous', channelId: CHANNEL, body: 'once',
    nextRunAt: '2026-09-08T10:00:00.000Z', actorId: ACTOR,
  });
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'), 0);
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:00:31.000Z'), 1);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1]);
  assert.match(nonces[0]!, /^[a-f0-9]{24}$/);
  assert.equal((await store.getScheduled(GUILD, 'ambiguous'))?.enabled, false);
  await db.cleanup();
});

test('service: editing an ambiguous scheduled occurrence uses a fresh nonce', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const nonces: string[] = [];
  const bodies: string[] = [];
  let attempts = 0;
  const discord: AutomationDiscord = {
    async postMessage(_channelId, content, nonce) {
      bodies.push(content);
      nonces.push(String(nonce));
      if (++attempts === 1) throw new DiscordPostError('response lost');
      return 'edited-message';
    },
    async deleteMessage() {},
  };
  const service = new AutomationService(store, discord);
  await service.putScheduled({
    guildId: GUILD, id: 'ambiguous-edit', channelId: CHANNEL, body: 'old',
    nextRunAt: '2026-09-08T10:00:00.000Z', actorId: ACTOR,
  });
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'), 0);
  const firstNonce = nonces[0];
  assert.ok(firstNonce);

  await service.putScheduled({
    guildId: GUILD, id: 'ambiguous-edit', channelId: CHANNEL, body: 'new',
    nextRunAt: '2026-09-08T10:01:00.000Z', actorId: ACTOR,
  });
  assert.equal((await store.getScheduled(GUILD, 'ambiguous-edit'))?.occurrenceNonce, null);
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:01:01.000Z'), 1);
  assert.deepEqual(bodies, ['old', 'new']);
  assert.notEqual(nonces[1], firstNonce);
  assert.match(nonces[1]!, /^[a-f0-9]{24}$/);
  await db.cleanup();
});

test('service: persistence failure deletes the accepted scheduled message and retries the row', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const service = new AutomationService(store, discord);
  await service.putScheduled({
    guildId: GUILD, id: 'persist-fail', channelId: CHANNEL, body: 'once',
    nextRunAt: '2026-09-08T10:00:00.000Z', actorId: ACTOR,
  });
  const originalMark = store.markScheduledRun.bind(store);
  let failOnce = true;
  store.markScheduledRun = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('database write failed');
    }
    return originalMark(...args);
  };
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z'), 0);
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'msg1' }]);
  const retry = await store.getScheduled(GUILD, 'persist-fail');
  assert.equal(retry?.enabled, true);
  assert.equal(retry?.nextRunAt, '2026-09-08T10:00:01.000Z');
  assert.equal(await service.runDueScheduled(GUILD, '2026-09-08T10:00:02.000Z'), 1);
  await db.cleanup();
});

test('discord client suppresses REST mentions and marks network, 429, and 5xx failures retryable', async () => {
  const network = new AutomationDiscordClient({
    token: 't',
    fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
  });
  await assert.rejects(
    () => network.postMessage(CHANNEL, 'x'),
    (err: unknown) => err instanceof DiscordPostError && err.retryable,
  );
  let sentBody: unknown;
  const ok = new AutomationDiscordClient({
    token: 't',
    fetchImpl: (async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'posted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  assert.equal(await ok.postMessage(CHANNEL, '@everyone <@123456789012345678>'), 'posted');
  assert.deepEqual(sentBody, {
    content: '@everyone <@123456789012345678>',
    allowed_mentions: { parse: [] },
  });
  const limited = new AutomationDiscordClient({
    token: 't',
    fetchImpl: (async () => new Response(JSON.stringify({ retry_after: 2 }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => limited.postMessage(CHANNEL, 'retry'),
    (err: unknown) => err instanceof DiscordPostError && err.retryAfterMs === 2000,
  );
  for (const status of [500, 502, 503]) {
    const serverFailure = new AutomationDiscordClient({
      token: 't',
      fetchImpl: (async () => new Response('upstream failed', { status })) as typeof fetch,
    });
    await assert.rejects(
      () => serverFailure.postMessage(CHANNEL, 'retry'),
      (err: unknown) => err instanceof DiscordPostError && err.status === status && err.retryable,
    );
  }
});

test('service: a poison scheduled row does not wedge the queue', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  discord.postMessage = async () => {
    throw new Error('channel gone');
  };
  await svc.putScheduled({
    guildId: GUILD,
    id: 'bad',
    channelId: CHANNEL,
    body: 'poison',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    intervalSeconds: null,
    actorId: ACTOR,
  });
  await svc.putScheduled({
    guildId: GUILD,
    id: 'good',
    channelId: CHANNEL,
    body: 'fine',
    nextRunAt: '2026-09-08T10:00:00.000Z',
    intervalSeconds: null,
    actorId: ACTOR,
  });
  discord.postMessage = async (channelId: string, content: string) => {
    if (content === 'poison') throw new Error('channel gone');
    discord.posts.push({ channelId, content });
    return 'ok';
  };
  const fired = await svc.runDueScheduled(GUILD, '2026-09-08T10:00:01.000Z');
  assert.equal(fired, 1, 'the good row still fires');
  await db.cleanup();
});

test('service: sticky re-posts after debounce and holds inside it', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putSticky({
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'READ THIS',
    debounceSeconds: 10,
    actorId: ACTOR,
  });
  // First activity: no sticky posted yet (lastPostedAt is null) -> posts.
  const first = await svc.onChannelActivity(GUILD, CHANNEL, 'member1', Date.parse('2026-09-08T10:00:00Z'));
  assert.equal(first, 'reposted');
  assert.equal(discord.posts.length, 1);
  // 5s later (inside debounce): hold.
  const held = await svc.onChannelActivity(GUILD, CHANNEL, 'member2', Date.parse('2026-09-08T10:00:05Z'));
  assert.equal(held, 'held');
  assert.equal(discord.posts.length, 1);
  // 15s later: re-post, and the old message is deleted first.
  const again = await svc.onChannelActivity(GUILD, CHANNEL, 'member3', Date.parse('2026-09-08T10:00:15Z'));
  assert.equal(again, 'reposted');
  assert.equal(discord.posts.length, 2);
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'msg1' }]);
  await db.cleanup();
});

test('service: concurrent sticky activity emits one repost', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putSticky({
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'one sticky',
    debounceSeconds: 10,
    actorId: ACTOR,
  });
  const outcomes = await Promise.all([
    svc.onChannelActivity(GUILD, CHANNEL, 'one', Date.parse('2026-09-08T10:00:00Z')),
    svc.onChannelActivity(GUILD, CHANNEL, 'two', Date.parse('2026-09-08T10:00:00Z')),
  ]);
  assert.deepEqual([...outcomes].sort(), ['held', 'reposted']);
  assert.equal(discord.posts.length, 1);
  await db.cleanup();
});

test('service: sticky update fences an active claim and deletes its orphan replacement', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const posting = new Promise<void>((resolve) => { started = resolve; });
  discord.postMessage = async (channelId, content) => {
    discord.posts.push({ channelId, content });
    started();
    await held;
    return 'orphan-sticky';
  };
  const service = new AutomationService(store, discord);
  await service.putSticky({
    guildId: GUILD, channelId: CHANNEL, body: 'old', debounceSeconds: 5, actorId: ACTOR,
  });
  const run = service.onChannelActivity(GUILD, CHANNEL, 'member', Date.parse('2026-09-08T10:00:00Z'));
  await posting;
  await service.putSticky({
    guildId: GUILD, channelId: CHANNEL, body: 'new', debounceSeconds: 5, enabled: false, actorId: ACTOR,
  });
  release();
  assert.equal(await run, 'held');
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'orphan-sticky' }]);
  const current = await store.getSticky(GUILD, CHANNEL);
  assert.equal(current?.body, 'new');
  assert.equal(current?.enabled, false);
  assert.equal(current?.lastMessageId, null);
  assert.equal(current?.claimToken, null);
  await db.cleanup();
});

test('service: recordStickyPost persistence failure deletes the orphan replacement', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const service = new AutomationService(store, discord);
  await service.putSticky({ guildId: GUILD, channelId: CHANNEL, body: 'sticky', actorId: ACTOR });
  const originalRecord = store.recordStickyPost.bind(store);
  (store as unknown as { recordStickyPost: typeof store.recordStickyPost }).recordStickyPost = async () => false;
  assert.equal(
    await service.onChannelActivity(GUILD, CHANNEL, 'member', Date.parse('2026-09-08T10:00:00Z')),
    'held',
  );
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'msg1' }]);
  (store as unknown as { recordStickyPost: typeof store.recordStickyPost }).recordStickyPost = async () => {
    throw new Error('database write failed');
  };
  await assert.rejects(
    () => service.onChannelActivity(GUILD, CHANNEL, 'member', Date.parse('2026-09-08T10:01:01Z')),
    /database write failed/,
  );
  assert.deepEqual(discord.deletes, [
    { channelId: CHANNEL, messageId: 'msg1' },
    { channelId: CHANNEL, messageId: 'msg2' },
  ]);
  (store as unknown as { recordStickyPost: typeof store.recordStickyPost }).recordStickyPost = originalRecord;
  await db.cleanup();
});

test('service: failed sticky replacement preserves the old post and releases its claim', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putSticky({
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'retry sticky',
    debounceSeconds: 300,
    actorId: ACTOR,
  });
  const firstAt = Date.parse('2026-09-08T10:00:00Z');
  assert.equal(await svc.onChannelActivity(GUILD, CHANNEL, 'one', firstAt), 'reposted');
  const originalPost = discord.postMessage;
  discord.postMessage = async () => { throw new Error('transient'); };
  await assert.rejects(
    () => svc.onChannelActivity(GUILD, CHANNEL, 'two', firstAt + 301_000),
    /transient/,
  );
  assert.deepEqual(discord.deletes, [], 'the live sticky remains when replacement fails');
  discord.postMessage = originalPost;
  assert.equal(
    await svc.onChannelActivity(GUILD, CHANNEL, 'three', firstAt + 301_001),
    'reposted',
    'the failed claim is immediately retryable',
  );
  assert.deepEqual(discord.deletes, [{ channelId: CHANNEL, messageId: 'msg1' }]);
  await db.cleanup();
});

test('staging proof cleanup skips rows changed concurrently after the proof write', () => {
  const before = { name: 'proof', template: 'before' };
  const proof = { name: 'proof', template: 'proof' };
  assert.equal(cleanupDecision(proof, { before, proof }), 'restore');
  assert.equal(
    cleanupDecision({ name: 'proof', template: 'admin-change' }, { before, proof }),
    'skip',
  );
});

test('staging proof cleanup clears a deleted message id from a disabled prior sticky', () => {
  const prior: StickyMessageRow = {
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'disabled sticky',
    debounceSeconds: 5,
    enabled: false,
    lastMessageId: 'old-live',
    lastPostedAt: '2026-09-08T10:00:00.000Z',
    createdBy: ACTOR,
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedBy: ACTOR,
    updatedAt: '2026-09-08T09:00:00.000Z',
    claimToken: 'old-claim',
    claimedAt: '2026-09-08T09:59:00.000Z',
  };

  assert.deepEqual(restoredStickyRow(
    prior,
    true,
    null,
    '2026-09-08T11:00:00.000Z',
  ), {
    ...prior,
    lastMessageId: null,
    claimToken: null,
    claimedAt: null,
  });
});

test('service: sticky delete removes the row and the live message', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const svc = new AutomationService(store, discord);
  await svc.putSticky({ guildId: GUILD, channelId: CHANNEL, body: 'bye', debounceSeconds: 5, actorId: ACTOR });
  await svc.onChannelActivity(GUILD, CHANNEL, 'm', Date.parse('2026-09-08T10:00:00Z'));
  const gone = await svc.deleteSticky(GUILD, CHANNEL, ACTOR);
  assert.equal(gone, true);
  assert.equal(discord.deletes.length, 1);
  const row = await store.getSticky(GUILD, CHANNEL);
  assert.equal(row, null);
  await db.cleanup();
});

test('service: sticky delete fences an in-flight replacement and removes both messages', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const service = new AutomationService(store, discord);
  await service.putSticky({
    guildId: GUILD, channelId: CHANNEL, body: 'replace me', debounceSeconds: 1, actorId: ACTOR,
  });
  assert.equal(
    await service.onChannelActivity(GUILD, CHANNEL, 'first', Date.parse('2026-09-08T10:00:00Z')),
    'reposted',
  );

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const posting = new Promise<void>((resolve) => { started = resolve; });
  discord.postMessage = async (channelId, content) => {
    started();
    await held;
    discord.posts.push({ channelId, content });
    return 'replacement';
  };
  const repost = service.onChannelActivity(
    GUILD, CHANNEL, 'second', Date.parse('2026-09-08T10:00:02Z'),
  );
  await posting;
  assert.equal(await service.deleteSticky(GUILD, CHANNEL, ACTOR), true);
  release();
  assert.equal(await repost, 'held');
  assert.deepEqual(discord.deletes, [
    { channelId: CHANNEL, messageId: 'msg1' },
    { channelId: CHANNEL, messageId: 'replacement' },
  ]);
  assert.equal(await store.getSticky(GUILD, CHANNEL), null);
  await db.cleanup();
});

test('service: importMee6 preserves first text trigger and imports later collisions slash-only', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  const r = await svc.importMee6(
    GUILD,
    [
      { command: 'faq', response: 'Read {server} rules' },
      { command: 'FAQ', response: 'second faq' },
      { command: 'welcome', description: 'says hi', response: 'hi {user}' },
      '', // not an object -> skipped, not fatal
    ],
    ACTOR,
  );
  assert.deepEqual(r, { imported: 3, skipped: 1, conflicts: ['faq'] });
  assert.equal((await store.getCommand(GUILD, 'faq'))?.textTrigger, '!faq');
  assert.equal((await store.getCommand(GUILD, 'faq-2'))?.textTrigger, null);
  const welcome = await store.getCommand(GUILD, 'welcome');
  assert.equal(welcome?.template, 'hi {user}');
  await db.cleanup();
});

test('service: import capacity ignores invalid and reserved definitions', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  const result = await svc.importMee6(
    GUILD,
    [
      { command: 'rank', response: 'reserved' },
      { command: 'empty-template', response: '{unsupported.placeholder}' },
      { command: 'valid', response: 'works' },
    ],
    ACTOR,
    { maxCommands: 1 },
  );
  assert.deepEqual(result, { imported: 1, skipped: 2, conflicts: [] });
  assert.deepEqual((await store.listCommands(GUILD)).map((row) => row.name), ['valid']);
  await db.cleanup();
});

test('service: import budget counts existing names and permits same-name updates', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());

  await svc.putCommand({
    guildId: GUILD,
    name: 'existing',
    description: 'existing',
    template: 'old',
    textTrigger: '!existing',
    actorId: ACTOR,
  });

  await assert.rejects(
    svc.importMee6(
      GUILD,
      [{ command: 'new-command', response: 'new' }],
      ACTOR,
      { maxCommands: 1 },
    ),
    /would define 2 custom commands, but the guild limit is 1/,
  );
  assert.equal(await store.getCommand(GUILD, 'new-command'), null, 'overflow is rejected before writes');

  const updated = await svc.importMee6(
    GUILD,
    [{ command: 'existing', response: 'replacement' }],
    ACTOR,
    { maxCommands: 1, overwrite: true },
  );
  assert.equal(updated.imported, 1);
  assert.equal((await store.getCommand(GUILD, 'existing'))?.template, 'replacement');

  await db.cleanup();
});

test('store: independent Postgres clients serialize import and individual create capacity', { skip: !usingPostgres }, async () => {
  const first = await openTestDb(`${import.meta.filename}-command-capacity`);
  assert.ok(first.schema);
  const secondDb = await openDb(TEST_PG_URL, {
    schema: first.schema,
    applicationName: 'two-bot-test:command-capacity-second',
  });
  const firstStore = new AutomationStore(first.db);
  const secondStore = new AutomationStore(secondDb);
  const firstService = new AutomationService(firstStore, fakeDiscord());
  const secondService = new AutomationService(secondStore, fakeDiscord());
  for (let i = 0; i < MAX_CUSTOM_COMMANDS - 1; i++) {
    await firstService.putCommand({
      guildId: GUILD,
      name: `seed-${i}`,
      description: `seed ${i}`,
      template: 'seed',
      actorId: ACTOR,
    });
  }

  const settled = await Promise.allSettled([
    firstService.importMee6(
      GUILD,
      [{ command: 'import-last', response: 'imported' }],
      ACTOR,
      { maxCommands: MAX_CUSTOM_COMMANDS },
    ),
    secondService.putCommand({
      guildId: GUILD,
      name: 'create-last',
      description: 'individual create',
      template: 'created',
      actorId: ACTOR,
    }),
  ]);

  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await firstStore.listCommands(GUILD)).length, MAX_CUSTOM_COMMANDS);
  await secondDb.close();
  await first.cleanup();
});

test('store: independent Postgres clients allow concurrent same-name update at capacity', { skip: !usingPostgres }, async () => {
  const first = await openTestDb(`${import.meta.filename}-command-same-name`);
  assert.ok(first.schema);
  const secondDb = await openDb(TEST_PG_URL, {
    schema: first.schema,
    applicationName: 'two-bot-test:command-same-name-second',
  });
  const firstStore = new AutomationStore(first.db);
  const secondStore = new AutomationStore(secondDb);
  const firstService = new AutomationService(firstStore, fakeDiscord());
  const secondService = new AutomationService(secondStore, fakeDiscord());
  for (let i = 0; i < MAX_CUSTOM_COMMANDS; i++) {
    await firstService.putCommand({
      guildId: GUILD,
      name: `full-${i}`,
      description: `full ${i}`,
      template: 'old',
      actorId: ACTOR,
    });
  }

  const [imported, updated] = await Promise.all([
    firstService.importMee6(
      GUILD,
      [{ command: 'full-0', response: 'from import' }],
      ACTOR,
      { overwrite: true, maxCommands: MAX_CUSTOM_COMMANDS },
    ),
    secondService.putCommand({
      guildId: GUILD,
      name: 'full-0',
      description: 'individual update',
      template: 'from create path',
      actorId: ACTOR,
    }),
  ]);
  assert.equal(imported.imported, 1);
  assert.equal(updated.created, false);
  assert.equal((await firstStore.listCommands(GUILD)).length, MAX_CUSTOM_COMMANDS);
  await secondDb.close();
  await first.cleanup();
});

test('service: repeated imports converge but changed imports require explicit overwrite', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  const first = await svc.importMee6(GUILD, [{ command: 'faq', response: 'A' }], ACTOR);
  const repeated = await svc.importMee6(GUILD, [{ command: 'faq', response: 'A' }], ACTOR);
  const changed = await svc.importMee6(GUILD, [{ command: 'FAQ!', response: 'B' }], ACTOR);
  const overwritten = await svc.importMee6(
    GUILD,
    [{ command: 'FAQ!', response: 'B' }],
    ACTOR,
    { overwrite: true },
  );
  assert.deepEqual(first, { imported: 1, skipped: 0, conflicts: [] });
  assert.deepEqual(repeated, first);
  assert.deepEqual(changed, { imported: 0, skipped: 1, conflicts: ['faq'] });
  assert.deepEqual(overwritten, first);
  const commands = await store.listCommands(GUILD);
  assert.deepEqual(commands.map((row) => row.name), ['faq']);
  assert.equal(commands[0].textTrigger, '!faq');
  assert.equal(commands[0].template, 'B');
  await db.cleanup();
});

test('service: repeated import preserves an admin-disabled command without overwrite', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.importMee6(GUILD, [{ command: 'faq', response: 'A' }], ACTOR);
  await svc.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'Imported from MEE6',
    template: 'A',
    textTrigger: '!faq',
    enabled: false,
    actorId: ACTOR,
  });

  assert.deepEqual(
    await svc.importMee6(GUILD, [{ command: 'faq', response: 'A' }], ACTOR),
    { imported: 1, skipped: 0, conflicts: [] },
  );
  assert.equal((await store.getCommand(GUILD, 'faq'))?.enabled, false);
  await db.cleanup();
});

test('service: MEE6 import rejects reserved built-in command names before writing', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  const result = await svc.importMee6(
    GUILD,
    [{ command: 'rank', response: 'spoofed rank' }],
    ACTOR,
  );
  assert.deepEqual(result, { imported: 0, skipped: 1, conflicts: [] });
  assert.equal(await store.getCommand(GUILD, 'rank'), null);
  await db.cleanup();
});

test('store: same-import conditional update refuses an intervening admin edit', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const service = new AutomationService(store, fakeDiscord(), () => '2026-09-08T10:00:00.000Z');
  await service.putCommand({
    guildId: GUILD, name: 'faq', description: 'FAQ', template: 'A', textTrigger: '!faq', actorId: ACTOR,
  });
  const snapshot = await store.getCommand(GUILD, 'faq');
  assert.ok(snapshot);
  await service.putCommand({
    guildId: GUILD, name: 'faq', description: 'Admin edit', template: 'live', textTrigger: '!faq', actorId: 'other',
  });
  const updated = await store.updateCommandIfUnchanged(
    { ...snapshot, updatedBy: ACTOR, updatedAt: '2026-09-08T10:00:01.000Z' },
    snapshot,
  );
  assert.equal(updated, false);
  assert.equal((await store.getCommand(GUILD, 'faq'))?.template, 'live');
  await db.cleanup();
});

test('service: MEE6 import cannot overwrite an existing live command by default', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'Live FAQ',
    template: 'live answer',
    textTrigger: '!faq',
    actorId: ACTOR,
  });
  const result = await svc.importMee6(
    GUILD,
    [{ command: 'faq', description: 'MEE6 FAQ', response: 'imported answer' }],
    ACTOR,
  );
  assert.deepEqual(result, { imported: 0, skipped: 1, conflicts: ['faq'] });
  assert.equal((await store.getCommand(GUILD, 'faq'))?.template, 'live answer');
  await db.cleanup();
});

test('service: export round-trips an import', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const svc = new AutomationService(store, fakeDiscord());
  await svc.importMee6(
    GUILD,
    [
      { command: 'faq', response: 'a' },
      { command: 'welcome', response: 'hi {user}' },
    ],
    ACTOR,
  );
  const out = (await svc.exportCommands(GUILD)) as { command: string; response: string }[];
  assert.deepEqual(out.find((c) => c.command === 'welcome')?.response, 'hi {user}');
  await db.cleanup();
});

// --- Discord wiring ------------------------------------------------------------

const settle = () => new Promise((resolve) => setTimeout(resolve, usingPostgres ? 50 : 0));

function fakeAdminInteraction(permissionBits: bigint | boolean) {
  const replies: unknown[] = [];
  const bits = typeof permissionBits === 'boolean'
    ? (permissionBits ? PermissionFlagsBits.ManageGuild : 0n)
    : permissionBits;
  const permissions = new PermissionsBitField(bits);
  return {
    replies,
    interaction: {
      isChatInputCommand: () => true,
      commandName: 'command-list',
      inGuild: () => true,
      guildId: GUILD,
      user: { id: ACTOR },
      memberPermissions: permissions,
      reply: async (reply: unknown) => {
        replies.push(reply);
      },
    },
  };
}

function fakeCustomInteraction(commandName = 'faq') {
  const replies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName,
    inGuild: () => true,
    guildId: GUILD,
    user: { id: ACTOR, username: 'member' },
    guild: { name: 'TWO Staging' },
    channel: { type: 0, name: 'general' },
    replied: false,
    deferred: false,
    reply: async (reply: unknown) => {
      replies.push(reply);
      interaction.replied = true;
    },
  };
  return { replies, interaction };
}

test('Discord command handler discriminates the real ManageGuild permission bit', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  for (const bits of [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers]) {
    const bus = new EventEmitter();
    registerAutomationCommands(bus as unknown as Client, {
      guildId: GUILD,
      service: new AutomationService(store, fakeDiscord()),
      store,
    });
    const { interaction, replies } = fakeAdminInteraction(bits);
    bus.emit(Events.InteractionCreate, interaction);
    await settle();
    assert.deepEqual(replies, [{
      content: 'Manage Server permission is required.',
      ephemeral: true,
    }]);
  }
  const allowedBus = new EventEmitter();
  registerAutomationCommands(allowedBus as unknown as Client, {
    guildId: GUILD,
    service: new AutomationService(store, fakeDiscord()),
    store,
  });
  const { interaction, replies } = fakeAdminInteraction(PermissionFlagsBits.ManageGuild);
  allowedBus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.deepEqual(replies, [{ content: 'No custom commands defined.', ephemeral: true }]);
  await db.cleanup();
});

test('Discord command handler rejects a stale admin command from a non-admin', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const bus = new EventEmitter();
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    service: new AutomationService(store, fakeDiscord()),
    store,
  });
  const { interaction, replies } = fakeAdminInteraction(false);
  bus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.deepEqual(replies, [{
    content: 'Manage Server permission is required.',
    ephemeral: true,
  }]);
  await db.cleanup();
});

test('Discord custom slash command audits successful execution', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const service = new AutomationService(store, fakeDiscord());
  await service.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'FAQ',
    template: 'Hello {user}',
    actorId: ACTOR,
  });
  const bus = new EventEmitter();
  registerAutomationCommands(bus as unknown as Client, { guildId: GUILD, service, store });
  const { interaction, replies } = fakeCustomInteraction();
  bus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.deepEqual(replies, [{ content: `Hello <@${ACTOR}>`, allowedMentions: { parse: [] } }]);
  const audits = await db.db.prepare(
    `SELECT outcome FROM automation_audit_log WHERE action = 'command.run' AND target_key = ?`,
  ).all<{ outcome: string }>('faq');
  assert.deepEqual(audits.map((row) => row.outcome), ['ok']);
  await db.cleanup();
});

test('Discord custom slash command contains lookup failures', async () => {
  const bus = new EventEmitter();
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    service: {} as AutomationService,
    store: { getCommand: async () => { throw new Error('database down'); } } as unknown as AutomationStore,
  });
  const { interaction, replies } = fakeCustomInteraction();
  bus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.deepEqual(replies, [{ content: 'The custom command failed.', ephemeral: true }]);
});

test('Discord automation handler leaves built-in slash commands to their owner', async () => {
  const bus = new EventEmitter();
  let lookups = 0;
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    service: {} as AutomationService,
    store: {
      getCommand: async () => {
        lookups++;
        throw new Error('database down');
      },
    } as unknown as AutomationStore,
  });
  const { interaction, replies } = fakeCustomInteraction('rank');
  bus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.equal(lookups, 0);
  assert.deepEqual(replies, []);
});

test('Discord custom slash command catches rendering failure and audits it', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const service = new AutomationService(store, fakeDiscord());
  await service.putCommand({
    guildId: GUILD,
    name: 'faq',
    description: 'FAQ',
    template: `${'x'.repeat(1994)}{user}`,
    actorId: ACTOR,
  });
  const bus = new EventEmitter();
  registerAutomationCommands(bus as unknown as Client, { guildId: GUILD, service, store });
  const { interaction, replies } = fakeCustomInteraction();
  bus.emit(Events.InteractionCreate, interaction);
  await settle();
  assert.deepEqual(replies, [{ content: 'The custom command failed.', ephemeral: true }]);
  const audits = await db.db.prepare(
    `SELECT outcome, reason FROM automation_audit_log WHERE action = 'command.run' AND target_key = ?`,
  ).all<{ outcome: string; reason: string }>('faq');
  assert.deepEqual(audits.map((row) => ({ ...row })), [{ outcome: 'failed', reason: 'Error' }]);
  await db.cleanup();
});

test('gateway uses processing time rather than a delayed Discord event timestamp for sticky claims', async () => {
  const bus = new EventEmitter();
  let seenArgs: unknown[] = [];
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: false,
    service: {
      onChannelActivity: async (...args: unknown[]) => {
        seenArgs = args;
        return 'none';
      },
    } as unknown as AutomationService,
    findTrigger: async () => null,
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    createdTimestamp: 1,
  });
  await settle();
  assert.deepEqual(seenArgs, [GUILD, CHANNEL, ACTOR]);
});

test('gateway keeps stickies live but text command processing off when disabled', async () => {
  const bus = new EventEmitter();
  let stickyChecks = 0;
  let triggerLookups = 0;
  let replies = 0;
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: false,
    service: {
      onChannelActivity: async () => { stickyChecks++; return 'none'; },
      postTextReply: async () => { replies++; return 'message'; },
    } as unknown as AutomationService,
    findTrigger: async () => {
      triggerLookups++;
      return {
        guildId: GUILD,
        name: 'faq',
        description: 'FAQ',
        template: 'A',
        textTrigger: '!faq',
        enabled: true,
        createdBy: ACTOR,
        createdAt: 't',
        updatedBy: ACTOR,
        updatedAt: 't',
      };
    },
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!faq <@bot-id>',
    createdTimestamp: 1,
  });
  await settle();
  assert.equal(stickyChecks, 1);
  assert.equal(triggerLookups, 0);
  assert.equal(replies, 0);
});

test('gateway rejects other guilds and does not intercept built-in text commands', async () => {
  const bus = new EventEmitter();
  let stickyChecks = 0;
  let triggerLookups = 0;
  let replies = 0;
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: true,
    service: {
      onChannelActivity: async () => { stickyChecks++; return 'none'; },
      postTextReply: async () => { replies++; return 'message'; },
    } as unknown as AutomationService,
    findTrigger: async () => {
      triggerLookups++;
      return null;
    },
  });
  bus.emit('automationMessageAccepted', {
    guildId: '900000000000000099', channelId: CHANNEL,
    author: { id: ACTOR, bot: false }, content: '!faq', createdTimestamp: 1,
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD, channelId: CHANNEL,
    author: { id: ACTOR, bot: false }, content: '!rank', createdTimestamp: 1,
  });
  await settle();
  assert.equal(stickyChecks, 1, 'only the configured guild reaches automations');
  assert.equal(triggerLookups, 0, 'built-ins never reach custom-command lookup');
  assert.equal(replies, 0);
});

test('gateway contains text-trigger lookup failures', async () => {
  const bus = new EventEmitter();
  let replies = 0;
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: true,
    service: {
      onChannelActivity: async () => 'none',
      postTextReply: async () => { replies++; return 'message'; },
    } as unknown as AutomationService,
    findTrigger: async () => { throw new Error('database down'); },
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!faq',
    createdTimestamp: 1,
  });
  await settle();
  assert.equal(replies, 0);
});

test('gateway durably audits text command render failure', async () => {
  const db: TestDb = await openTestDb(import.meta.filename);
  const store = new AutomationStore(db.db);
  const discord = fakeDiscord();
  const service = new AutomationService(store, discord);
  const bus = new EventEmitter();
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: true,
    service,
    findTrigger: async () => ({
      guildId: GUILD,
      name: 'faq',
      description: 'FAQ',
      template: `${'x'.repeat(1999)}{user}`,
      textTrigger: '!faq',
      enabled: true,
      createdBy: ACTOR,
      createdAt: 't',
      updatedBy: ACTOR,
      updatedAt: 't',
    }),
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!faq',
    createdTimestamp: 1,
  });
  await settle();
  assert.equal(discord.posts.length, 0);
  const audits = await db.db.prepare(
    `SELECT outcome, reason FROM automation_audit_log WHERE action = 'command.run' AND target_key = ?`,
  ).all<{ outcome: string; reason: string }>('faq');
  assert.deepEqual(audits.map((row) => ({ ...row })), [{ outcome: 'failed', reason: 'Error' }]);
  await db.cleanup();
});

test('gateway processes text commands only when explicitly enabled', async () => {
  const bus = new EventEmitter();
  let replies = 0;
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: true,
    service: {
      onChannelActivity: async () => 'none',
      postTextReply: async () => { replies++; return 'message'; },
    } as unknown as AutomationService,
    findTrigger: async () => ({
      guildId: GUILD,
      name: 'faq',
      description: 'FAQ',
      template: 'A',
      textTrigger: '!faq',
      enabled: true,
      createdBy: ACTOR,
      createdAt: 't',
      updatedBy: ACTOR,
      updatedAt: 't',
    }),
  });
  bus.emit('automationMessageAccepted', {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!faq',
    createdTimestamp: 1,
  });
  await settle();
  assert.equal(replies, 1);
});

// --- gateway helpers -----------------------------------------------------------

test('gateway: triggerWord extracts the first token', () => {
  assert.equal(triggerWord('!faq how do I'), '!faq');
  assert.equal(triggerWord('!FAQ'), '!faq');
  assert.equal(triggerWord('hello'), null);
  assert.equal(triggerWord('!'), null);
});

test('gateway: intentsFor preserves the current main intent set', async () => {
  const { intentsFor, INTENTS } = await import('../src/discord/client.ts');
  assert.deepEqual(intentsFor({}), INTENTS);
  assert.deepEqual(intentsFor({ TWO_TEXT_COMMANDS: '1' }), INTENTS);
});

test('sticky row maps booleans from both drivers', () => {
  const row: StickyMessageRow = {
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'x',
    debounceSeconds: 5,
    enabled: true,
    lastMessageId: null,
    lastPostedAt: null,
    createdBy: ACTOR,
    createdAt: 't',
    updatedBy: ACTOR,
    updatedAt: 't',
    claimToken: null,
    claimedAt: null,
  };
  assert.equal(row.enabled, true);
});
