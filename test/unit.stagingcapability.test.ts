/**
 * Construction-side proof for the capability-scoped staging restart connection
 * (TOG-4011). The socket-side proof - what actually reaches the Identify frame -
 * is in test/e2e.rotaprocess.test.ts against the real loopback gateway; this
 * file pins the numbers and proves the flag is inert for every other value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits, Partials, type Client } from 'discord.js';
import {
  createClient,
  capabilityScoped,
  intents,
  intentsFor,
  needsMessageContent,
  ticketsConfigured,
  INTENTS,
  PARTIALS,
  STAGING_RESTART_CONTAINMENT_FLAG,
} from '../src/discord/client.ts';

/**
 * Literal bitfields, not a sum of names: the point of the acceptance criterion
 * is that a rename or a reordering cannot quietly change what we ask for.
 *
 *   FULL    = Guilds 1 + GuildMembers 2 + GuildModeration 4 + GuildInvites 64
 *           + GuildVoiceStates 128 + GuildMessages 512
 *           + GuildMessageReactions 1024 + MessageContent 32768
 *   GATED   = FULL without MessageContent (TOG-5258: requested only when
 *             automod is enabled or tickets are configured)
 *   REDUCED = Guilds 1 + GuildMembers 2 + GuildVoiceStates 128 + GuildMessages 512
 */
const FULL_INTENT_BITS = 34503;
const GATED_INTENT_BITS = 1735;
const REDUCED_INTENT_BITS = 643;

const TICKETS_ENV = {
  DISCORD_TICKET_CATEGORY_ID: '111111111111111111',
  DISCORD_TICKET_STAFF_ROLE_ID: '222222222222222222',
  DISCORD_TICKET_PANEL_CHANNEL_ID: '333333333333333333',
};

/** Every value that must leave the connection exactly as production has it. */
const INERT_VALUES = ['0', 'true', 'TRUE', 'yes', '', ' 1', '1 ', '01', '1.0'];

function bits(values: GatewayIntentBits[]): number {
  return values.reduce((acc, bit) => acc | bit, 0);
}

/**
 * Everything about a constructed client that the containment path could
 * possibly reach, in a form `deepEqual` can compare. `makeCache` and the
 * sweeper callbacks are functions, so they are reduced to a stable marker -
 * identity would differ between two constructions even on unchanged code.
 */
function shape(client: Client): unknown {
  const options = client.options as unknown as Record<string, unknown>;
  const ws = options.ws as { presence?: unknown; intents?: unknown } | undefined;
  return JSON.parse(
    JSON.stringify(
      {
        keys: Object.keys(options).sort(),
        intents: client.options.intents.bitfield.toString(),
        partials: client.options.partials,
        presence: options.presence,
        wsPresence: ws?.presence,
        wsIntents: typeof ws?.intents === 'number' ? ws.intents : String(ws?.intents ?? ''),
        allowedMentions: options.allowedMentions,
        failIfNotExists: options.failIfNotExists,
        shardCount: options.shardCount,
      },
      (_key, value) => (typeof value === 'function' ? '[function]' : typeof value === 'bigint' ? value.toString() : value),
    ),
  );
}

test('the reduced intent set is exactly the four the rota needs', () => {
  const reduced = intentsFor({ [STAGING_RESTART_CONTAINMENT_FLAG]: '1' });
  const gated = intentsFor({});
  const full = intentsFor({ TWO_AUTOMOD: '1' });
  assert.equal(bits(reduced), REDUCED_INTENT_BITS);
  assert.equal(bits(gated), GATED_INTENT_BITS);
  assert.equal(bits(full), FULL_INTENT_BITS);

  // GuildMembers stays: GUILD_MEMBER_ADD is where the rota's clock starts.
  assert.ok((bits(reduced) & GatewayIntentBits.GuildMembers) !== 0, 'GuildMembers must stay');
  for (const dropped of [
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessageReactions,
  ]) {
    assert.equal(bits(reduced) & dropped, 0, `intent ${dropped} must be clear under containment`);
  }
  // A strict subset of whichever main set is active, so scoping can only
  // ever remove capability.
  assert.equal(bits(reduced) & bits(gated), bits(reduced));
  assert.equal(bits(reduced) & bits(full), bits(reduced));
  assert.notEqual(bits(reduced), bits(gated));
  assert.notEqual(bits(reduced), bits(full));
});

test('MessageContent is requested only for automod-on or configured tickets', () => {
  // Neither: the 7-intent gated set without the privileged bit.
  assert.equal(bits(intentsFor({})), GATED_INTENT_BITS);
  assert.equal(bits(intents(false, {})), GATED_INTENT_BITS);
  assert.equal(intents(false, {}).length, 7);
  assert.equal(needsMessageContent({}), false);

  // Automod-on (exact '1'): the full 8-intent set.
  assert.equal(bits(intentsFor({ TWO_AUTOMOD: '1' })), FULL_INTENT_BITS);
  assert.equal(bits(intents(true, {})), FULL_INTENT_BITS);
  assert.equal(intents(true, {}).length, 8);
  assert.equal(needsMessageContent({ TWO_AUTOMOD: '1' }), true);

  // Tickets-configured (all three present): the full set, no automod needed.
  assert.equal(bits(intentsFor({ ...TICKETS_ENV })), FULL_INTENT_BITS);
  assert.equal(bits(intents(false, { ...TICKETS_ENV })), FULL_INTENT_BITS);
  assert.equal(needsMessageContent({ ...TICKETS_ENV }), true);
  assert.equal(ticketsConfigured({ ...TICKETS_ENV }), true);

  // Exact-'1' semantics: anything other than '1' is inert, even 'true'.
  // (INERT_VALUES already covers 'true'/'TRUE'/'yes' alongside numerics.)
  for (const value of INERT_VALUES) {
    assert.equal(needsMessageContent({ TWO_AUTOMOD: value }), false, `"${value}" must not justify MessageContent`);
    assert.equal(bits(intentsFor({ TWO_AUTOMOD: value })), GATED_INTENT_BITS, `"${value}" must stay gated`);
  }

  // Partial tickets (any one missing/empty) stays gated: same
  // all-three-present check as the registration guard in src/index.ts.
  const keys = [
    'DISCORD_TICKET_CATEGORY_ID',
    'DISCORD_TICKET_STAFF_ROLE_ID',
    'DISCORD_TICKET_PANEL_CHANNEL_ID',
  ] as const;
  for (const drop of keys) {
    const partial: NodeJS.ProcessEnv = { ...TICKETS_ENV, [drop]: '' };
    assert.equal(ticketsConfigured(partial), false, `${drop} empty must read as unconfigured`);
    assert.equal(bits(intentsFor(partial)), GATED_INTENT_BITS, `${drop} empty must stay gated`);
    const absent: NodeJS.ProcessEnv = { ...TICKETS_ENV };
    delete absent[drop];
    assert.equal(ticketsConfigured(absent), false, `${drop} absent must read as unconfigured`);
    assert.equal(bits(intentsFor(absent)), GATED_INTENT_BITS, `${drop} absent must stay gated`);
  }

  // The gated set is exactly full minus MessageContent.
  assert.equal(FULL_INTENT_BITS - GATED_INTENT_BITS, Number(GatewayIntentBits.MessageContent));
  assert.equal(GATED_INTENT_BITS, 1735);
});

test('only the exact value "1" scopes the connection', () => {
  assert.equal(capabilityScoped({ [STAGING_RESTART_CONTAINMENT_FLAG]: '1' }), true);
  assert.equal(capabilityScoped({}), false);
  for (const value of INERT_VALUES) {
    assert.equal(capabilityScoped({ [STAGING_RESTART_CONTAINMENT_FLAG]: value }), false, `"${value}" must be inert`);
    assert.deepEqual(intentsFor({ [STAGING_RESTART_CONTAINMENT_FLAG]: value }), intentsFor({}), `"${value}" must be inert`);
  }
});

test('the flag off constructs the client with the gated intents by default', () => {
  const client = createClient(false, {});
  try {
    // Pinned to observable construction, not re-derived from INTENTS:
    // if the intent list drifts, this fails and the drift is the conversation.
    // TOG-5258: with neither automod nor tickets, the default is the gated
    // 7-intent set - the gateway never receives MessageContent it cannot use.
    assert.equal(Number(client.options.intents.bitfield), GATED_INTENT_BITS);
    assert.deepEqual(client.options.partials, PARTIALS);
    assert.deepEqual(PARTIALS, [Partials.Message, Partials.Reaction, Partials.User]);
    // discord.js's own default, after `ClientPresence` mutates the options
    // object it was handed. This is what broadcasts an online presence today.
    assert.deepEqual(client.options.presence, { status: 'online', user: { id: null } });
  } finally {
    void client.destroy();
  }
});

test('automod-on and tickets-configured still construct the full intent set', () => {
  // No regression for the two features whose comments justify MessageContent:
  // ticket export and enabled-automod in-memory inspection.
  for (const [label, flag, env] of [
    ['automod flag', true, {}],
    ['automod env', false, { TWO_AUTOMOD: '1' }],
    ['tickets env', false, { ...TICKETS_ENV }],
  ] as const) {
    const client = createClient(flag, { ...env });
    try {
      assert.equal(Number(client.options.intents.bitfield), FULL_INTENT_BITS, label);
    } finally {
      void client.destroy();
    }
  }
});

test('containment still wins over automod and tickets', () => {
  const client = createClient(true, {
    [STAGING_RESTART_CONTAINMENT_FLAG]: '1',
    TWO_AUTOMOD: '1',
    ...TICKETS_ENV,
  });
  try {
    assert.equal(Number(client.options.intents.bitfield), REDUCED_INTENT_BITS);
  } finally {
    void client.destroy();
  }
});

test('every inert flag value constructs an identical client to the flag being absent', () => {
  const absent = createClient(false, {});
  const baseline = shape(absent);
  void absent.destroy();

  for (const value of INERT_VALUES) {
    const client = createClient(false, { [STAGING_RESTART_CONTAINMENT_FLAG]: value });
    try {
      assert.deepEqual(shape(client), baseline, `"${value}" changed the constructed client`);
    } finally {
      void client.destroy();
    }
  }

  // The comparison has to be able to fail, or it proves nothing.
  const scoped = createClient(false, { [STAGING_RESTART_CONTAINMENT_FLAG]: '1' });
  try {
    assert.notDeepEqual(shape(scoped), baseline, 'containment must change the constructed client');
  } finally {
    void scoped.destroy();
  }
});

test('the flag on asks for invisible presence and the reduced intents', () => {
  const client = createClient(false, { [STAGING_RESTART_CONTAINMENT_FLAG]: '1' });
  try {
    assert.equal(Number(client.options.intents.bitfield), REDUCED_INTENT_BITS);
    assert.deepEqual(client.options.presence, { status: 'invisible', user: { id: null } });
    // `Client#login` parses this into `options.ws.presence`, which @discordjs/ws
    // copies onto `d.presence` of the Identify frame. That last hop only exists
    // at login time - e2e.rotaprocess.test.ts asserts it on a real socket.
    // Scoping the capability must not change caching or partials.
    assert.deepEqual(client.options.partials, PARTIALS);
  } finally {
    void client.destroy();
  }
});

test('containment leaves the automod cache decision to TWO_AUTOMOD alone', () => {
  const scoped = createClient(true, { [STAGING_RESTART_CONTAINMENT_FLAG]: '1' });
  const plain = createClient(true, {});
  try {
    assert.deepEqual(scoped.options.partials, plain.options.partials);
    assert.ok(scoped.options.partials?.includes(Partials.Channel));
  } finally {
    void scoped.destroy();
    void plain.destroy();
  }
});
