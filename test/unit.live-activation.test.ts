import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertActivationPermitted,
  evaluateActivation,
  LIVE_CAPABILITIES,
  LIVE_CLEARED_CAPABILITIES,
} from '../src/live/activation.ts';
import { loadAnnouncementsConfig } from '../src/announcements/config.ts';
import { loadAutomationConfig } from '../src/automations/config.ts';
import { loadAutomodConfig } from '../src/automod/config.ts';
import { loadModerationConfig } from '../src/moderation/config.ts';

// Written out rather than imported from spec.ts, so a mutated constant in src
// cannot drag the expectation along with it.
const LIVE_GUILD = '326474832151838730';
const LIVE_APP = '1539711683898118154';
const STAGING_GUILD = '1545644954272137297';
const STAGING_APP = '1469137636663758888';
const THIRD_GUILD = '1555555555555555555';
const THIRD_APP = '1555555555555555556';

const tokenFor = (id: string) => `${Buffer.from(id).toString('base64url')}.mock.signature`;
const LIVE_TOKEN = tokenFor(LIVE_APP);
const STAGING_TOKEN = tokenFor(STAGING_APP);

for (const capability of LIVE_CAPABILITIES) {
  const others = LIVE_CAPABILITIES.filter((c) => c !== capability);

  test(`${capability}: live guild + live app + cleared -> permitted`, () => {
    assert.equal(assertActivationPermitted(capability, LIVE_GUILD, LIVE_TOKEN, [capability]), 'live');
  });

  test(`${capability}: live guild + live app, not cleared -> refused (clearing the others does not clear it)`, () => {
    assert.throws(() => assertActivationPermitted(capability, LIVE_GUILD, LIVE_TOKEN, others), /not cleared/);
    assert.throws(() => assertActivationPermitted(capability, LIVE_GUILD, LIVE_TOKEN, []), /not cleared/);
  });

  test(`${capability}: live guild + staging app -> refused, even when cleared`, () => {
    assert.throws(() => assertActivationPermitted(capability, LIVE_GUILD, STAGING_TOKEN, [capability]), /refused/);
  });

  test(`${capability}: staging guild + live app -> refused, even when cleared`, () => {
    assert.throws(() => assertActivationPermitted(capability, STAGING_GUILD, LIVE_TOKEN, [capability]), /refused/);
  });

  test(`${capability}: unknown guild -> refused with either app, even when cleared`, () => {
    assert.throws(() => assertActivationPermitted(capability, THIRD_GUILD, LIVE_TOKEN, [capability]), /refused/);
    assert.throws(() => assertActivationPermitted(capability, THIRD_GUILD, STAGING_TOKEN, [capability]), /refused/);
    assert.throws(() => assertActivationPermitted(capability, null, STAGING_TOKEN, [capability]), /guild unset/);
  });

  test(`${capability}: unknown app on the staging guild -> refused`, () => {
    assert.throws(() => assertActivationPermitted(capability, STAGING_GUILD, tokenFor(THIRD_APP)), /refused/);
  });

  test(`${capability}: staging pair -> permitted without any live clearance`, () => {
    assert.equal(assertActivationPermitted(capability, STAGING_GUILD, STAGING_TOKEN, []), 'staging');
  });
}

test('the shipped clearance list clears self_roles only (TOG-5356)', () => {
  assert.deepEqual([...LIVE_CLEARED_CAPABILITIES], ['self_roles']);
  assert.equal(assertActivationPermitted('self_roles', LIVE_GUILD, LIVE_TOKEN), 'live');
  for (const capability of LIVE_CAPABILITIES.filter((c) => c !== 'self_roles')) {
    assert.throws(() => assertActivationPermitted(capability, LIVE_GUILD, LIVE_TOKEN), /not cleared/);
  }
});

test('fails closed on an unknown capability name, even for the staging pair', () => {
  assert.throws(() => assertActivationPermitted('tickets', STAGING_GUILD, STAGING_TOKEN), /unknown capability "tickets"/);
  assert.throws(() => assertActivationPermitted('', LIVE_GUILD, LIVE_TOKEN, ['']), /unknown capability/);
});

test('fails closed when the clearance list names an unknown capability', () => {
  assert.throws(
    () => assertActivationPermitted('moderation', LIVE_GUILD, LIVE_TOKEN, ['moderation', 'everything']),
    /unknown capability "everything"/,
  );
});

test('fails closed on a missing or unparseable token, even for the staging guild', () => {
  for (const token of [null, undefined, '', 'not-a-token', `${Buffer.from('owen').toString('base64')}.x.y`]) {
    const decision = evaluateActivation('self_roles', STAGING_GUILD, token);
    assert.equal(decision.permitted, false);
    assert.match(decision.permitted ? '' : decision.reason, /missing or unparseable/);
  }
});

// --- the five call sites --------------------------------------------------------

const loaders = {
  announcements: (env: NodeJS.ProcessEnv, token: string | null) => loadAnnouncementsConfig(env, token),
  automations: (env: NodeJS.ProcessEnv, token: string | null) => loadAutomationConfig(env, token),
  automod: (env: NodeJS.ProcessEnv, token: string | null) => loadAutomodConfig(env, token),
  moderation: (env: NodeJS.ProcessEnv, token: string | null) =>
    loadModerationConfig({ ...env, TWO_OWEN_USER_ID: '123456789012345678' }, token),
} as const;
const flags = {
  announcements: 'TWO_ANNOUNCEMENTS',
  automations: 'TWO_AUTOMATIONS',
  automod: 'TWO_AUTOMOD',
  moderation: 'TWO_MODERATION',
} as const;

for (const [name, load] of Object.entries(loaders)) {
  const flag = flags[name as keyof typeof flags];

  test(`${name} loader: staging pair loads; live, third guild, unset guild and no token are refused`, () => {
    assert.equal(load({ [flag]: '1', DISCORD_GUILD_ID: STAGING_GUILD }, STAGING_TOKEN).enabled, true);
    assert.throws(() => load({ [flag]: '1', DISCORD_GUILD_ID: LIVE_GUILD }, LIVE_TOKEN), /allowlist refused/);
    assert.throws(() => load({ [flag]: '1', DISCORD_GUILD_ID: THIRD_GUILD }, STAGING_TOKEN), /allowlist refused/);
    assert.throws(() => load({ [flag]: '1' }, STAGING_TOKEN), /guild unset/);
    assert.throws(() => load({ [flag]: '1', DISCORD_GUILD_ID: STAGING_GUILD }, null), /unparseable/);
  });

  test(`${name} loader: disabled needs neither guild nor token`, () => {
    assert.equal(load({}, null).enabled, false);
  });

  test(`${name} loader: reads the bot token from DISCORD_TOKEN when not passed`, () => {
    const env = { [flag]: '1', DISCORD_GUILD_ID: STAGING_GUILD, DISCORD_TOKEN: STAGING_TOKEN };
    const withDefault = name === 'moderation'
      ? loadModerationConfig({ ...env, TWO_OWEN_USER_ID: '123456789012345678' })
      : name === 'announcements' ? loadAnnouncementsConfig(env)
      : name === 'automations' ? loadAutomationConfig(env)
      : loadAutomodConfig(env);
    assert.equal(withDefault.enabled, true);
  });
}

test('TOG-3186 regression: TWO_AUTOMOD=1 on an arbitrary third guild is refused (the old denylist passed it)', () => {
  assert.throws(
    () => loadAutomodConfig({ TWO_AUTOMOD: '1', DISCORD_GUILD_ID: THIRD_GUILD, DISCORD_TOKEN: STAGING_TOKEN }),
    /allowlist refused automod/,
  );
  assert.throws(
    () => loadAutomodConfig({ TWO_AUTOMOD: '1', DISCORD_GUILD_ID: THIRD_GUILD, DISCORD_TOKEN: LIVE_TOKEN }),
    /allowlist refused automod/,
  );
});

test('TOG-3186 regression: TWO_MODERATION=1 now has a guild fence', () => {
  assert.throws(
    () => loadModerationConfig({ TWO_MODERATION: '1', TWO_OWEN_USER_ID: '123456789012345678', DISCORD_GUILD_ID: THIRD_GUILD, DISCORD_TOKEN: STAGING_TOKEN }),
    /allowlist refused moderation/,
  );
});
