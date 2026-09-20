/**
 * Disable-time removal of DB-backed custom slash commands (TOG-3189).
 *
 * The acceptance here is by execution against a counted HTTP surface, not
 * against a log line: `fakeDiscordApi` records every request the registrar
 * makes, so "exactly N deletes" is an assertion about calls that were issued.
 *
 * The registered command list deliberately contains commands the database does
 * NOT back - a built-in (`rank`) and another feature's command (`event`). A
 * suite whose Discord list holds only DB-backed commands cannot tell a correct
 * scoped delete apart from a wipe, so those two are the load-bearing fixtures.
 *
 * No Postgres: the delete set is read through the `CommandNameSource` seam, and
 * the handler tests use the same store fakes the main suite already uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, PermissionFlagsBits, PermissionsBitField, type ApplicationCommandDataResolvable, type Client } from 'discord.js';
import {
  AUTOMATIONS_DISABLED_REPLY,
  registerAutomationCommands,
} from '../src/automations/discord.ts';
import {
  AutomationDisableIncomplete,
  RestGuildCommandRegistrar,
  removeDbBackedCommands,
  summariseDisable,
  type CommandNameSource,
} from '../src/automations/disable.ts';
import type { AutomationCommandRow, AutomationStore } from '../src/automations/store.ts';
import type { AutomationService } from '../src/automations/service.ts';
import { CommandRegistry } from '../src/discord/commandRegistry.ts';

const GUILD = '1545644954272137297';
const APP = '1400000000000000001';
const ACTOR = '900000000000000001';
const BASE = 'https://discord.test/api/v10';
const COMMANDS_PATH = `/applications/${APP}/guilds/${GUILD}/commands`;

/** The three admin-defined commands under test, plus two Owen must not touch. */
const DB_BACKED = ['faq', 'rules', 'welcome'] as const;
const REGISTERED: { id: string; name: string }[] = [
  { id: '200000000000000001', name: 'faq' },
  { id: '200000000000000002', name: 'rank' }, // built-in, not DB-backed
  { id: '200000000000000003', name: 'rules' },
  { id: '200000000000000004', name: 'event' }, // another feature's, not DB-backed
  { id: '200000000000000005', name: 'welcome' },
];

function row(name: string): AutomationCommandRow {
  return {
    guildId: GUILD,
    name,
    description: name,
    template: 'x',
    textTrigger: null,
    enabled: true,
    createdBy: ACTOR,
    createdAt: 't',
    updatedBy: ACTOR,
    updatedAt: 't',
  };
}

function fakeStore(names: readonly string[] = DB_BACKED): CommandNameSource {
  return { async listCommands() { return names.map(row); } };
}

interface ApiCall { method: string; url: string }

/**
 * A counted Discord command API. `published` is the mutable registry: a DELETE
 * removes from it, so a second sweep sees the world the first one left behind.
 * `failDeleteNumber` forces an HTTP 500 on the nth delete of the run.
 */
function fakeDiscordApi(options: { failDeleteNumber?: number } = {}) {
  const calls: ApiCall[] = [];
  let published = [...REGISTERED];
  let deletes = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'GET') {
      return new Response(JSON.stringify(published), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'DELETE') {
      deletes++;
      if (options.failDeleteNumber === deletes) return new Response(null, { status: 500 });
      const id = url.slice(url.lastIndexOf('/') + 1);
      published = published.filter((command) => command.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
  return {
    calls,
    fetchImpl,
    deleteCalls: () => calls.filter((call) => call.method === 'DELETE'),
    publishedNames: () => published.map((command) => command.name),
  };
}

function registrar(fetchImpl: typeof fetch): RestGuildCommandRegistrar {
  return new RestGuildCommandRegistrar({
    token: 'test-token',
    applicationId: APP,
    guildId: GUILD,
    base: BASE,
    fetchImpl,
  });
}

// --- 1: exactly N deletes, counted at the API ---------------------------------

test('disable issues exactly one delete per DB-backed command', async () => {
  const api = fakeDiscordApi();
  const result = await removeDbBackedCommands(GUILD, fakeStore(), registrar(api.fetchImpl));

  assert.equal(api.deleteCalls().length, DB_BACKED.length);
  assert.deepEqual(result.removed, ['faq', 'rules', 'welcome']);
  assert.deepEqual(result.alreadyAbsent, []);
  assert.deepEqual(result.failed, []);
  // Every delete addressed the guild command route for this application only.
  for (const call of api.deleteCalls()) {
    assert.ok(call.url.startsWith(`${BASE}${COMMANDS_PATH}/`), call.url);
  }
});

// --- 3: nothing that is not DB-backed is deleted -------------------------------

test('disable never deletes a command the database does not back', async () => {
  const api = fakeDiscordApi();
  const result = await removeDbBackedCommands(GUILD, fakeStore(), registrar(api.fetchImpl));

  const deletedIds = api.deleteCalls().map((call) => call.url.slice(call.url.lastIndexOf('/') + 1));
  const untouchedIds = REGISTERED
    .filter((command) => !(DB_BACKED as readonly string[]).includes(command.name))
    .map((command) => command.id);
  assert.equal(untouchedIds.length, 2, 'fixture must contain non-DB-backed commands');
  for (const id of untouchedIds) assert.ok(!deletedIds.includes(id), `deleted non-DB-backed ${id}`);
  assert.deepEqual(api.publishedNames().sort(), ['event', 'rank']);
  assert.deepEqual(result.untouched, ['event', 'rank']);
});

test('a DB name Discord does not publish is skipped, not guessed at', async () => {
  const api = fakeDiscordApi();
  const result = await removeDbBackedCommands(
    GUILD,
    fakeStore([...DB_BACKED, 'never-published']),
    registrar(api.fetchImpl),
  );
  assert.equal(api.deleteCalls().length, 3);
  assert.deepEqual(result.alreadyAbsent, ['never-published']);
});

// --- idempotency ---------------------------------------------------------------

test('disable run twice is not an error and issues no second round of deletes', async () => {
  const api = fakeDiscordApi();
  const first = await removeDbBackedCommands(GUILD, fakeStore(), registrar(api.fetchImpl));
  assert.equal(first.removed.length, 3);
  const deletesAfterFirst = api.deleteCalls().length;

  // The rows stay in the database - disable is not a destructive admin action -
  // so the second run re-derives the same delete set and finds it already gone.
  const second = await removeDbBackedCommands(GUILD, fakeStore(), registrar(api.fetchImpl));
  assert.equal(api.deleteCalls().length, deletesAfterFirst, 'second run must issue no deletes');
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.alreadyAbsent, ['faq', 'rules', 'welcome']);
  assert.deepEqual(second.dbBacked, ['faq', 'rules', 'welcome']);
});

// --- 4: a partial failure reports the partial state ----------------------------

test('a failed delete reports what is still published instead of claiming success', async () => {
  const api = fakeDiscordApi({ failDeleteNumber: 2 });
  const error = await removeDbBackedCommands(GUILD, fakeStore(), registrar(api.fetchImpl)).then(
    () => null,
    (err: unknown) => err,
  );

  assert.ok(error instanceof AutomationDisableIncomplete, `expected a throw, got ${String(error)}`);
  const result = error.result;
  assert.deepEqual(result.failed.map((f) => f.name), ['rules']);
  assert.equal(result.failed[0].commandId, '200000000000000003');
  assert.match(result.failed[0].error, /HTTP 500/);
  // The sweep carries on: the third command is still worth removing.
  assert.deepEqual(result.removed, ['faq', 'welcome']);
  assert.equal(api.deleteCalls().length, 3);
  assert.ok(api.publishedNames().includes('rules'), 'the failed one is genuinely still published');
  assert.match(error.message, /rules/);
  assert.match(summariseDisable(result), /removed=2 .*failed=1/);
});

test('a delete Discord answers 404 is already-gone, not a failure', async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(REGISTERED), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const result = await removeDbBackedCommands(GUILD, fakeStore(), registrar(fetchImpl));
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, ['faq', 'rules', 'welcome']);
});

test('an unreadable command list refuses rather than deleting from a guess', async () => {
  const fetchImpl = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(
    removeDbBackedCommands(GUILD, fakeStore(), registrar(fetchImpl)),
    /HTTP 503/,
  );
});

// --- 2: handlers refuse while disabled -----------------------------------------

function fakeCustomInteraction(commandName: string) {
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

function fakeAdminInteraction(commandName: string) {
  const replies: unknown[] = [];
  return {
    replies,
    interaction: {
      isChatInputCommand: () => true,
      commandName,
      inGuild: () => true,
      guildId: GUILD,
      user: { id: ACTOR },
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      reply: async (reply: unknown) => { replies.push(reply); },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a custom command invoked after disable refuses and never executes', async () => {
  const bus = new EventEmitter();
  let runs = 0;
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    enabled: false,
    service: { runCommand: async () => { runs++; } } as unknown as AutomationService,
    store: { getCommand: async (_g: string, name: string) => row(name) } as unknown as AutomationStore,
  });
  const { interaction, replies } = fakeCustomInteraction('faq');
  bus.emit(Events.InteractionCreate, interaction);
  await settle();

  assert.deepEqual(replies, [{ content: AUTOMATIONS_DISABLED_REPLY, ephemeral: true }]);
  assert.equal(runs, 0);
});

test('an admin automation command after disable refuses instead of writing', async () => {
  const bus = new EventEmitter();
  let listed = 0;
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    enabled: false,
    service: {} as AutomationService,
    store: {
      listCommands: async () => { listed++; return []; },
      getCommand: async () => null,
    } as unknown as AutomationStore,
  });
  const { interaction, replies } = fakeAdminInteraction('command-list');
  bus.emit(Events.InteractionCreate, interaction);
  await settle();

  assert.deepEqual(replies, [{ content: AUTOMATIONS_DISABLED_REPLY, ephemeral: true }]);
  assert.equal(listed, 0, 'a refused admin command must not reach the store');
});

test('a disabled handler still leaves commands it does not own alone', async () => {
  const bus = new EventEmitter();
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    enabled: false,
    service: {} as AutomationService,
    store: { getCommand: async () => null } as unknown as AutomationStore,
  });
  // A built-in, and a name no automation row claims: both belong to somebody
  // else, and answering either would break that owner's command.
  const builtin = fakeCustomInteraction('rank');
  const foreign = fakeCustomInteraction('somebody-elses-command');
  bus.emit(Events.InteractionCreate, builtin.interaction);
  bus.emit(Events.InteractionCreate, foreign.interaction);
  await settle();

  assert.deepEqual(builtin.replies, []);
  assert.deepEqual(foreign.replies, []);
});

test('the enabled handler is unchanged by the disable option defaulting on', async () => {
  const bus = new EventEmitter();
  let runs = 0;
  registerAutomationCommands(bus as unknown as Client, {
    guildId: GUILD,
    service: {
      runCommand: async (_g: string, _n: string, _a: string, run: () => Promise<void>) => {
        runs++;
        await run();
      },
    } as unknown as AutomationService,
    store: { getCommand: async (_g: string, name: string) => row(name) } as unknown as AutomationStore,
  });
  const { interaction, replies } = fakeCustomInteraction('faq');
  bus.emit(Events.InteractionCreate, interaction);
  await settle();

  assert.equal(runs, 1);
  assert.deepEqual(replies, [{ content: 'x', allowedMentions: { parse: [] } }]);
});

// --- the removal must stay removed ---------------------------------------------

test('a disabled registry never republishes DB-backed commands on the next sync', async () => {
  const published: string[][] = [];
  const guild = {
    commands: {
      async set(commands: ApplicationCommandDataResolvable[]) {
        published.push(commands.map((c) => ('name' in c && typeof c.name === 'string' ? c.name : '')));
      },
    },
  };
  const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
  let reads = 0;
  const automations = {
    async listCommands() { reads++; return DB_BACKED.map(row); },
  } as unknown as AutomationStore;

  const disabled = new CommandRegistry(client, {
    guildId: GUILD,
    automations,
    automationsEnabled: false,
  });
  await disabled.sync();
  for (const name of DB_BACKED) {
    assert.ok(!published[0].includes(name), `${name} was republished while disabled`);
  }
  assert.equal(reads, 0, 'a disabled registry has no reason to read the command table');

  // The same registry with automations on is the control: it does publish them,
  // so the assertion above is about the flag and not about an empty fixture.
  const enabled = new CommandRegistry(client, { guildId: GUILD, automations });
  await enabled.sync();
  for (const name of DB_BACKED) assert.ok(published[1].includes(name), `${name} missing when enabled`);
});

// --- the sweep must run before the first full-set replace -----------------------

/** A ready-emitting client whose `guild.commands.set` records into `order`. */
function fakeReadyClient(order: string[]) {
  const bus = new EventEmitter();
  const guild = {
    commands: {
      async set() { order.push('set'); },
    },
  };
  Object.assign(bus, { guilds: { cache: new Map([[GUILD, guild]]) } });
  return bus;
}

test('the disable sweep completes before the registry replaces the command set', async () => {
  const order: string[] = [];
  const bus = fakeReadyClient(order);
  const registry = new CommandRegistry(bus as unknown as Client, {
    guildId: GUILD,
    automations: { async listCommands() { return []; } } as unknown as AutomationStore,
    automationsEnabled: false,
    beforeFirstSync: async () => {
      // Awaits inside the sweep are the whole point: Discord's list read and N
      // deletes all have to land before `set` replaces the registry.
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('sweep');
    },
  });
  registry.register();
  bus.emit(Events.ClientReady);
  await settle();

  assert.deepEqual(order, ['sweep', 'set']);
});

test('a sweep that throws still lets the registry publish', async () => {
  const order: string[] = [];
  const bus = fakeReadyClient(order);
  const registry = new CommandRegistry(bus as unknown as Client, {
    guildId: GUILD,
    automations: { async listCommands() { return []; } } as unknown as AutomationStore,
    automationsEnabled: false,
    beforeFirstSync: async () => { throw new Error('Discord refused the command list: HTTP 503'); },
  });
  registry.register();
  bus.emit(Events.ClientReady);
  await settle();

  assert.deepEqual(order, ['set'], 'a failed sweep must not cost the guild its commands');
});
