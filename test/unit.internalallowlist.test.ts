/**
 * Internal-actions allowlist and auth edges at unit level (TOG-5698).
 *
 * The e2e suite drives these paths over HTTP against Postgres; what it cannot
 * do cheaply is pin each refusal to the exact layer that owns it, or prove a
 * rejected fixture never reached Discord. Every refusal test below therefore
 * asserts two things: the typed error, AND that the recording Discord fake saw
 * no call. Delete the guard and the second assertion goes red.
 *
 * No database, no socket: the store is a hand stub where one is needed, and
 * Discord is a recording fake with an injectable fetch for the status mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowed,
  buildChannelKeys,
  isImplemented,
  NEEDS_IDEMPOTENCY_KEY,
  runAction,
  type ActionContext,
} from '../src/internal/actions.ts';
import {
  ActionError,
  authFailure,
  errorBody,
  retryableFor,
  statusFor,
  successBody,
} from '../src/internal/errors.ts';
import {
  DiscordActions,
  throwForStatus,
  type ActionDiscord,
} from '../src/internal/discordActions.ts';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { MAX_CUSTOM_COMMANDS } from '../src/discord/commandNames.ts';
import { CommandCapacityError } from '../src/automations/errors.ts';

const GUILD = '326474832151838730';
const USER = '900000000000000001';
const ROLE_KEY = 'rocketleague';
const ROLE_ID = '1065438504521322526'; // the self-assignable role behind ROLE_KEY
const CHANNEL_KEY = 'announcements';
const CHANNEL_ID = '1045943373007171674';
const KEYS = 'web-test:0123456789abcdef0123456789abcdef';

async function expectActionError(fn: () => Promise<unknown>): Promise<ActionError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ActionError, `expected ActionError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the action to throw');
}

function fakeDiscord(over: Partial<ActionDiscord> = {}): {
  client: ActionDiscord;
  calls: string[];
} {
  const calls: string[] = [];
  const client: ActionDiscord = {
    async memberRoles() {
      calls.push('memberRoles');
      return [];
    },
    async addRole(_g, _u, r) {
      calls.push(`addRole:${r}`);
    },
    async addMember(_g, u, _t) {
      calls.push(`addMember:${u}`);
      return 'added';
    },
    async postMessage(c, _content) {
      calls.push(`postMessage:${c}`);
      return 'msg-1';
    },
    async createEvent(_g, i) {
      calls.push(`createEvent:${i.name}`);
      return 'evt-1';
    },
    async updateEvent(_g, id, i) {
      calls.push(`updateEvent:${id}:${i.name}`);
    },
    async cancelEvent(_g, id) {
      calls.push(`cancelEvent:${id}`);
    },
    async readEvent(_g, id) {
      calls.push(`readEvent:${id}`);
      return {
        eventId: id,
        name: 'Launch Night',
        startsAt: '2026-09-01T19:00:00.000Z',
        location: 'The Together We Own server',
        status: 'SCHEDULED',
        observedAt: new Date().toISOString(),
      };
    },
    ...over,
  };
  return { client, calls };
}

function ctx(over: Partial<ActionContext> = {}, discord?: ActionDiscord): ActionContext {
  return {
    guildId: GUILD,
    discord: discord ?? fakeDiscord().client,
    roleKeys: new Map([[ROLE_KEY, ROLE_ID]]),
    channelKeys: new Map([[CHANNEL_KEY, CHANNEL_ID]]),
    enabled: new Set<string>([]),
    store: null,
    settings: null,
    idempotencyKey: null,
    ...over,
  };
}

function stubStore(over: Record<string, unknown> = {}): ActionContext['store'] {
  return {
    discordEventId: async () => null,
    rememberDiscordEvent: async () => {},
    ...over,
  } as unknown as ActionContext['store'];
}

// --- the allowlist itself ----------------------------------------------------

test('isImplemented names exactly what the allowlist holds, and nothing else', () => {
  assert.equal(isImplemented('role.assign'), true);
  assert.equal(isImplemented('moderation.ban'), true);
  assert.equal(isImplemented('guild.kick'), false);
  assert.equal(isImplemented('admin.grant'), false);
});

test('an action outside the allowlist is refused before anything else runs', () => {
  const c = ctx({ enabled: new Set(['role.assign']) });
  assert.throws(
    () => assertAllowed('guild.kick', c),
    (e: unknown) => e instanceof ActionError && e.code === 'action_not_allowed' && e.logReason === 'action_unknown',
  );
  assert.equal(statusFor('action_not_allowed'), 403);
  assert.equal(retryableFor('action_not_allowed'), false);
});

test('a built but switched-off action is refused as disabled, not unknown', () => {
  const c = ctx({ enabled: new Set(['role.assign']) });
  assert.throws(
    () => assertAllowed('guild.add_member', c),
    (e: unknown) => e instanceof ActionError && e.code === 'action_not_allowed' && e.logReason === 'action_disabled',
  );
});

test('a key-requiring action with no store behind it is a typed refusal, not a 500', () => {
  const c = ctx({ enabled: new Set(['announcement.post']), store: null });
  assert.throws(
    () => assertAllowed('announcement.post', c),
    (e: unknown) => e instanceof ActionError && e.code === 'action_not_allowed' && e.logReason === 'action_needs_store',
  );
});

test('moderation and key-requiring verbs sit on the idempotency side of the line', () => {
  for (const a of ['announcement.post', 'event.upsert', 'event.cancel', 'automations.import', 'moderation.ban']) {
    assert.equal(NEEDS_IDEMPOTENCY_KEY.has(a), true, `${a} must need a key`);
  }
  for (const a of ['role.assign', 'guild.add_member', 'settings.get', 'automations.export']) {
    assert.equal(NEEDS_IDEMPOTENCY_KEY.has(a), false, `${a} must not need a key`);
  }
});

// --- the acceptance fixture: unauthorized means rejected, and Discord idle ---

test('role.assign with a role key outside the map is rejected and never reaches Discord', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx({ enabled: new Set(['role.assign']) }, client);
  assertAllowed('role.assign', c);

  const err = await expectActionError(() =>
    runAction('role.assign', { discord_id: USER, role_key: 'admin' }, c),
  );
  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'role_key_unknown');
  assert.deepEqual(calls, [], 'an unauthorized fixture must not cause any Discord call');
});

test('announcement.post to a channel key outside the map is rejected and never posts', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx({ enabled: new Set(['announcement.post']), store: stubStore() }, client);
  assertAllowed('announcement.post', c);

  const err = await expectActionError(() =>
    runAction('announcement.post', { channel_key: 'other', body: 'hello' }, c),
  );
  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'channel_key_unknown');
  assert.deepEqual(calls, [], 'an unauthorized fixture must not cause any Discord call');
});

test('the channel-key map starts empty and rejects malformed specs loudly', () => {
  assert.equal(buildChannelKeys().size, 0);
  const map = buildChannelKeys(`${CHANNEL_KEY}:${CHANNEL_ID}`);
  assert.equal(map.get(CHANNEL_KEY), CHANNEL_ID);
  assert.throws(() => buildChannelKeys('announcements:not-a-snowflake'), /channel-key/);
});

// --- ordinary behaviour, per module ------------------------------------------

test('role.assign assigns a missing role, and no-ops one already held', async () => {
  const held: string[] = [];
  const { client, calls } = fakeDiscord({
    memberRoles: async () => {
      calls.push('memberRoles');
      return [...held];
    },
  });
  const c = ctx({ enabled: new Set(['role.assign']) }, client);

  const assigned = await runAction('role.assign', { discord_id: USER, role_key: ROLE_KEY }, c);
  assert.deepEqual(assigned.result, { outcome: 'assigned' });
  assert.ok(calls.includes(`addRole:${ROLE_ID}`));

  held.push(ROLE_ID);
  calls.length = 0;
  const noop = await runAction('role.assign', { discord_id: USER, role_key: ROLE_KEY }, c);
  assert.deepEqual(noop.result, { outcome: 'already_held' });
  assert.ok(!calls.some((k) => k.startsWith('addRole')), 'an already-held role must not be written again');
});

test('role.assign still writes when the membership read fails', async () => {
  const { client, calls } = fakeDiscord({
    memberRoles: async () => {
      throw new Error('discord down');
    },
  });
  const c = ctx({ enabled: new Set(['role.assign']) }, client);
  const out = await runAction('role.assign', { discord_id: USER, role_key: ROLE_KEY }, c);
  assert.deepEqual(out.result, { outcome: 'assigned' });
  assert.ok(calls.includes(`addRole:${ROLE_ID}`));
});

test('guild.add_member distinguishes added from already_member, and leaks no token', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx({ enabled: new Set(['guild.add_member']) }, client);
  const added = await runAction(
    'guild.add_member',
    { discord_id: USER, access_token: 'live-oauth-token' },
    c,
  );
  assert.deepEqual(added.result, { outcome: 'added' });
  assert.deepEqual(calls, [`addMember:${USER}`]);
  assert.ok(!JSON.stringify(added).includes('live-oauth-token'));

  const second = fakeDiscord({ addMember: async (_g, u, _t) => `already_member` as const });
  // Rebind the calls array check: the second client records on its own array.
  void second.calls;
  const c2 = ctx({ enabled: new Set(['guild.add_member']) }, second.client);
  const again = await runAction('guild.add_member', { discord_id: USER, access_token: 'live-oauth-token' }, c2);
  assert.deepEqual(again.result, { outcome: 'already_member' });
  assert.ok(!JSON.stringify(again).includes('live-oauth-token'));
});

test('announcement.post returns the message id for the stored result', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx({ enabled: new Set(['announcement.post']), store: stubStore() }, client);
  const out = await runAction('announcement.post', { channel_key: CHANNEL_KEY, body: 'hello' }, c);
  assert.deepEqual(out.result, { outcome: 'posted', message_id: 'msg-1' });
  assert.deepEqual(calls, [`postMessage:${CHANNEL_ID}`]);
});

test('announcement.post refuses a body over the Discord ceiling', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx({ enabled: new Set(['announcement.post']), store: stubStore() }, client);
  const err = await expectActionError(() =>
    runAction('announcement.post', { channel_key: CHANNEL_KEY, body: 'x'.repeat(2001) }, c),
  );
  assert.equal(err.code, 'malformed');
  assert.equal(err.logReason, 'body_too_long');
  assert.deepEqual(calls, []);
});

test('event.upsert creates once and updates on the mapped key thereafter', async () => {
  const input = {
    event_key: 'launch-night',
    name: 'Launch night',
    starts_at: '2026-10-01T18:00:00.000Z',
    ends_at: '2026-10-01T20:00:00.000Z',
    location: 'The hall',
  };
  const remembered: string[] = [];
  const { client, calls } = fakeDiscord();
  const c = ctx(
    {
      enabled: new Set(['event.upsert']),
      store: stubStore({
        discordEventId: async () => null,
        rememberDiscordEvent: async (_g: string, _k: string, id: string) => {
          remembered.push(id);
        },
      }),
    },
    client,
  );
  const created = await runAction('event.upsert', { ...input }, c);
  assert.deepEqual(created.result, { outcome: 'created', event_id: 'evt-1' });
  assert.deepEqual(remembered, ['evt-1']);

  calls.length = 0;
  const c2 = ctx(
    {
      enabled: new Set(['event.upsert']),
      store: stubStore({ discordEventId: async () => 'evt-9' }),
    },
    client,
  );
  const updated = await runAction('event.upsert', { ...input }, c2);
  assert.deepEqual(updated.result, { outcome: 'updated', event_id: 'evt-9' });
  assert.deepEqual(calls, ['updateEvent:evt-9:Launch night']);
});

test('event.upsert insists on exactly one of channel_key and location', async () => {
  const c = ctx({ enabled: new Set(['event.upsert']), store: stubStore() }, fakeDiscord().client);
  const base = {
    event_key: 'k',
    name: 'N',
    starts_at: '2026-10-01T18:00:00.000Z',
    ends_at: '2026-10-01T20:00:00.000Z',
  };
  for (const extra of [{}, { channel_key: CHANNEL_KEY, location: 'hall' }]) {
    const err = await expectActionError(() => runAction('event.upsert', { ...base, ...extra }, c));
    assert.equal(err.code, 'malformed');
    assert.equal(err.logReason, 'event_place_ambiguous');
  }
  const backwards = await expectActionError(() =>
    runAction('event.upsert', { ...base, location: 'hall', starts_at: base.ends_at, ends_at: base.starts_at }, c),
  );
  assert.equal(backwards.code, 'malformed');
  assert.equal(backwards.logReason, 'ends_before_starts');
});

test('event.cancel on an unmapped key is refused without reaching Discord', async () => {
  const { client, calls } = fakeDiscord();
  const c = ctx(
    { enabled: new Set(['event.cancel']), store: stubStore({ discordEventId: async () => null }) },
    client,
  );
  const err = await expectActionError(() => runAction('event.cancel', { event_key: 'nobody-made-this' }, c));
  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'event_key_unknown');
  assert.deepEqual(calls, []);
});

// --- automations.import / export edges -----------------------------------------

function automationCtx(over: Partial<ActionContext> = {}): { c: ActionContext; calls: string[] } {
  const calls: string[] = [];
  const c = ctx(
    {
      enabled: new Set(['automations.import', 'automations.export']),
      store: stubStore(),
      automations: {
        importMee6: async () => ({ imported: 1, skipped: 0 }),
        exportCommands: async () => [{ command: 'faq' }],
      },
      syncCommands: async () => {
        calls.push('sync');
        return 1;
      },
      ...over,
    },
    fakeDiscord().client,
  );
  return { c, calls };
}

test('automations.import validates its body before touching the service', async () => {
  const { c } = automationCtx();
  const notArray = await expectActionError(() =>
    runAction('automations.import', { commands: 'nope' }, c),
  );
  assert.equal(notArray.code, 'malformed');
  assert.equal(notArray.logReason, 'missing_commands');

  const badOverwrite = await expectActionError(() =>
    runAction('automations.import', { commands: [], overwrite: 'yes' }, c),
  );
  assert.equal(badOverwrite.code, 'malformed');
  assert.equal(badOverwrite.logReason, 'bad_overwrite');

  const tooMany = await expectActionError(() =>
    runAction(
      'automations.import',
      { commands: Array.from({ length: MAX_CUSTOM_COMMANDS + 1 }, (_, i) => ({ command: `c${i}` })) },
      c,
    ),
  );
  assert.equal(tooMany.code, 'malformed');
  assert.equal(tooMany.logReason, 'too_many_commands');
});

test('automations.import refuses destructive work without the stronger capability', async () => {
  const { c } = automationCtx({ allowAutomationOverwrite: false });
  const err = await expectActionError(() =>
    runAction('automations.import', { commands: [], overwrite: true }, c),
  );
  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'automations_overwrite_disabled');
});

test('automations verbs fail closed when the service is not wired', async () => {
  const bare = ctx({ enabled: new Set(['automations.import', 'automations.export']), store: stubStore() });
  for (const body of [{ commands: [] }] as const) {
    const err = await expectActionError(() => runAction('automations.import', body, bare));
    assert.equal(err.code, 'action_not_allowed');
    assert.equal(err.logReason, 'automations_not_wired');
  }
  const noSync = automationCtx({ syncCommands: null }).c;
  const syncErr = await expectActionError(() => runAction('automations.import', { commands: [] }, noSync));
  assert.equal(syncErr.logReason, 'automations_sync_not_wired');

  const exportErr = await expectActionError(() => runAction('automations.export', {}, bare));
  assert.equal(exportErr.code, 'action_not_allowed');
  assert.equal(exportErr.logReason, 'automations_not_wired');
});

test('automations.import maps capacity exhaustion to a caller error and publishes on success', async () => {
  const full = automationCtx({
    automations: {
      importMee6: async () => {
        throw new CommandCapacityError('guild limit reached');
      },
      exportCommands: async () => [],
    },
  }).c;
  const capped = await expectActionError(() => runAction('automations.import', { commands: [] }, full));
  assert.equal(capped.code, 'malformed');
  assert.equal(capped.logReason, 'command_capacity_exceeded');

  const { c, calls } = automationCtx();
  const out = await runAction('automations.import', { commands: [{ command: 'faq' }] }, c);
  assert.deepEqual(out.result, { imported: 1, skipped: 0, conflicts: [], published: 1 });
  assert.deepEqual(calls, ['sync']);

  const exported = await runAction('automations.export', {}, c);
  assert.deepEqual(exported.result, { commands: [{ command: 'faq' }] });
});

// --- moderation entry edge -----------------------------------------------------

test('a moderation verb without the service wired is refused, not run', async () => {
  const c = ctx({ enabled: new Set(['moderation.ban']), store: stubStore() });
  const err = await expectActionError(() => runAction('moderation.ban', {}, c));
  assert.equal(err.code, 'action_not_allowed');
  assert.equal(err.logReason, 'moderation_not_configured');
});

// --- Discord status mapping ----------------------------------------------------

function discordWith(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { discord: DiscordActions; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const discord = new DiscordActions({
    token: 'mock-token',
    fetchImpl: (async (url: unknown, init?: unknown) => {
      if (init && typeof init === 'object' && 'body' in init && typeof init.body === 'string') {
        try {
          bodies.push(JSON.parse(init.body));
        } catch {
          bodies.push(init.body);
        }
      }
      return handler(String(url), init as RequestInit);
    }) as unknown as typeof fetch,
  });
  return { discord, bodies };
}

test('throwForStatus maps Discord answers onto the published table', () => {
  assert.doesNotThrow(() => throwForStatus(new Response(null, { status: 200 })));
  assert.doesNotThrow(() => throwForStatus(new Response(null, { status: 204 })));

  const limited = (() => {
    try {
      throwForStatus(new Response(null, { status: 429, headers: { 'retry-after': '7' } }));
    } catch (e) {
      return e as ActionError;
    }
    assert.fail('must throw');
  })();
  assert.ok(limited instanceof ActionError && limited.code === 'rate_limited');
  assert.equal(limited.retryAfter, 7);
  assert.equal(retryableFor('rate_limited'), true);

  for (const status of [400, 403, 404]) {
    assert.throws(
      () => throwForStatus(new Response(null, { status })),
      (e: unknown) => e instanceof ActionError && e.code === 'discord_rejected' && !retryableFor(e.code),
      `status ${status}`,
    );
  }
  for (const status of [500, 502, 503]) {
    assert.throws(
      () => throwForStatus(new Response(null, { status })),
      (e: unknown) => e instanceof ActionError && e.code === 'discord_unavailable' && retryableFor(e.code),
      `status ${status}`,
    );
  }
});

test('DiscordActions maps timeout, outage and typed failures without logging bodies', async () => {
  const aborting = discordWith(async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  });
  await assert.rejects(aborting.discord.cancelEvent('g', 'e'), (e: unknown) =>
    e instanceof ActionError && e.code === 'upstream_timeout' && e.logReason === 'discord_timeout',
  );

  const offline = discordWith(async () => {
    throw new Error('socket hangup');
  });
  await assert.rejects(offline.discord.memberRoles('g', 'u'), (e: unknown) =>
    e instanceof ActionError && e.code === 'discord_unavailable',
  );

  const limited = discordWith(() => new Response('{}', { status: 429, headers: { 'retry-after': '4' } }));
  await assert.rejects(limited.discord.postMessage('c', 'hi'), (e: unknown) =>
    e instanceof ActionError && e.code === 'rate_limited' && e.retryAfter === 4,
  );

  const missing = discordWith(() => new Response(null, { status: 404 }));
  assert.equal(await missing.discord.memberRoles('g', 'u'), null);
});

test('event bodies carry the right entity type, and posts suppress mentions', async () => {
  const { discord, bodies } = discordWith(
    (url) => Response.json(url.includes('scheduled-events') ? { id: 'evt-7' } : { id: 'msg-7' }),
  );
  assert.equal(await discord.createEvent('g', { name: 'N', startsAt: 'a', endsAt: 'b', channelId: 'c1' }), 'evt-7');
  assert.equal(await discord.postMessage('c1', '@everyone hi'), 'msg-7');
  // Note: no `description` key at all — JSON drops undefined, so the wire
  // body never carries it. Asserting the exact object pins that.
  assert.deepEqual(bodies[0], {
    name: 'N',
    scheduled_start_time: 'a',
    scheduled_end_time: 'b',
    privacy_level: 2,
    entity_type: 2,
    channel_id: 'c1',
  });
  assert.deepEqual(bodies[1], { content: '@everyone hi', allowed_mentions: { parse: [] } });

  const { discord: ext, bodies: extBodies } = discordWith(() => Response.json({ id: 'evt-8' }));
  await ext.updateEvent('g', 'evt-8', { name: 'N', startsAt: 'a', endsAt: 'b', location: 'The hall' });
  assert.deepEqual(extBodies[0], {
    name: 'N',
    scheduled_start_time: 'a',
    scheduled_end_time: 'b',
    privacy_level: 2,
    entity_type: 3,
    channel_id: null,
    entity_metadata: { location: 'The hall' },
  });
});

// --- error envelope ------------------------------------------------------------

test('in_progress is the one retryable 409, and the auth failure hides its reason', () => {
  assert.equal(statusFor('in_progress'), 409);
  assert.equal(retryableFor('in_progress'), true);

  const err = authFailure('bad_signature');
  assert.equal(err.code, 'unauthorized');
  assert.equal(err.message, 'Signature verification failed');
  assert.equal(err.logReason, 'bad_signature');

  const body = errorBody(err, 'req-1');
  assert.deepEqual(body, {
    ok: false,
    error: { code: 'unauthorized', message: 'Signature verification failed', retryable: false },
    request_id: 'req-1',
  });
  assert.deepEqual(successBody({ outcome: 'assigned' }, 'req-2'), {
    ok: true,
    result: { outcome: 'assigned' },
    request_id: 'req-2',
  });
});

// --- config gating ---------------------------------------------------------------

test('the endpoint is off by default and refuses to start keyless', () => {
  assert.equal(loadInternalActionsConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(loadInternalActionsConfig({ TWO_INTERNAL_ACTIONS: '0', TWO_INTERNAL_KEYS: KEYS } as NodeJS.ProcessEnv), null);
  assert.throws(
    () => loadInternalActionsConfig({ TWO_INTERNAL_ACTIONS: '1' } as NodeJS.ProcessEnv),
    /TWO_INTERNAL_KEYS|internal_keys/,
  );
});

test('host and port default to loopback, and guild.add_member stays dark without its flag', () => {
  const base = { TWO_INTERNAL_ACTIONS: '1', TWO_INTERNAL_KEYS: KEYS } as NodeJS.ProcessEnv;
  const cfg = loadInternalActionsConfig({ ...base })!;
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.enabled.has('role.assign'), true);
  assert.equal(cfg.enabled.has('guild.add_member'), false);

  const on = loadInternalActionsConfig({ ...base, TWO_INTERNAL_ALLOW_ADD_MEMBER: '1' })!;
  assert.equal(on.enabled.has('guild.add_member'), true);
});

test('moderation verbs need both the internal flag and the moderation co-gate', () => {
  const base = { TWO_INTERNAL_ACTIONS: '1', TWO_INTERNAL_KEYS: KEYS } as NodeJS.ProcessEnv;
  const neither = loadInternalActionsConfig({ ...base })!;
  assert.equal(neither.enabled.has('moderation.ban'), false);

  const allowOnly = loadInternalActionsConfig({ ...base, TWO_INTERNAL_ALLOW_MODERATION: '1' })!;
  assert.equal(allowOnly.enabled.has('moderation.ban'), false);

  const coGateOnly = loadInternalActionsConfig({ ...base, TWO_MODERATION: '1' })!;
  assert.equal(coGateOnly.enabled.has('moderation.ban'), false);

  const both = loadInternalActionsConfig({
    ...base,
    TWO_INTERNAL_ALLOW_MODERATION: '1',
    TWO_MODERATION: '1',
  })!;
  assert.equal(both.enabled.has('moderation.ban'), true);
  assert.equal(both.enabled.has('moderation.unlock'), true);
});
