import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { classifyKey, ENV_ONLY_KEY_PREFIXES } from '../src/core/settingsCatalog.ts';
import { DiscordActions, eventStatusName } from '../src/internal/discordActions.ts';
import { ActionError } from '../src/internal/errors.ts';

const env = { TWO_INTERNAL_ACTIONS: '1', TWO_INTERNAL_KEYS: `test:${'k'.repeat(48)}` };

test('event read is an explicit environment-only capability, not enabled by event.upsert', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const config = loadInternalActionsConfig({ ...env, TWO_INTERNAL_ALLOW_EVENT_READ: value })!;
    assert.equal(config.enabled.has('event.upsert'), true);
    assert.equal(config.enabled.has('event.read'), false);
  }
  const config = loadInternalActionsConfig({ ...env, TWO_INTERNAL_ALLOW_EVENT_READ: '1' })!;
  assert.equal(config.enabled.has('event.read'), true);
  assert.equal(classifyKey('TWO_INTERNAL_ALLOW_EVENT_READ'), 'env_only');
  assert.ok(
    (ENV_ONLY_KEY_PREFIXES as readonly string[]).some((p) => 'TWO_INTERNAL_ALLOW_EVENT_READ'.startsWith(p)),
    'the new gate inherits the namespace prefix refusal as well as its exact-name entry',
  );
});

function mirrorBody(over: Record<string, unknown> = {}) {
  return {
    id: '900000000000007777',
    name: 'Launch Night',
    scheduled_start_time: '2026-09-01T19:00:00.000Z',
    entity_metadata: { location: 'The Together We Own server' },
    status: 1,
    ...over,
  };
}

function discordReturning(payload: unknown, status = 200) {
  const requests: { url: string; method: string; body: string | undefined }[] = [];
  const discord = new DiscordActions({
    token: 'mock-bot-token',
    fetchImpl: (async (url, options) => {
      requests.push({ url: String(url), method: options!.method!, body: options!.body as string | undefined });
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch,
  });
  return { discord, requests };
}

test('event read returns only the proof-owned mirror fields over one GET', async () => {
  const { discord, requests } = discordReturning(mirrorBody());
  const mirror = await discord.readEvent('900000000000008888', '900000000000007777');
  assert.equal(mirror.eventId, '900000000000007777');
  assert.equal(mirror.name, 'Launch Night');
  assert.equal(mirror.startsAt, '2026-09-01T19:00:00.000Z');
  assert.equal(mirror.location, 'The Together We Own server');
  assert.equal(mirror.status, 'SCHEDULED');
  assert.ok(!Number.isNaN(Date.parse(mirror.observedAt)), 'observed_at is a parseable instant');
  assert.deepEqual(requests, [{
    url: 'https://discord.com/api/v10/guilds/900000000000008888/scheduled-events/900000000000007777',
    method: 'GET',
    body: undefined,
  }]);
  assert.ok(!JSON.stringify(mirror).includes('member'), 'no attendee or member data crosses the boundary');
});

test('event read reports a voice-channel mirror with a null location', async () => {
  const { discord } = discordReturning(mirrorBody({ entity_metadata: null, status: 2 }));
  const mirror = await discord.readEvent('guild', 'event');
  assert.equal(mirror.location, null);
  assert.equal(mirror.status, 'ACTIVE');
});

test('event read propagates typed upstream failures instead of claiming success', async () => {
  for (const [status, code] of [[400, 'discord_rejected'], [403, 'discord_rejected'], [404, 'discord_rejected'], [429, 'rate_limited'], [503, 'discord_unavailable']] as const) {
    const discord = new DiscordActions({
      token: 'mock-bot-token',
      fetchImpl: async () => new Response('{}', { status }),
    });
    await assert.rejects(discord.readEvent('guild', 'event'), (error: unknown) =>
      error instanceof ActionError && error.code === code);
  }
});

test('event read refuses a mirror without its identity instead of half-verifying', async () => {
  for (const body of [
    mirrorBody({ id: undefined }),
    mirrorBody({ name: 42 }),
    mirrorBody({ scheduled_start_time: null }),
    mirrorBody({ status: 'SCHEDULED' }),
    null,
  ]) {
    const { discord } = discordReturning(body);
    await assert.rejects(discord.readEvent('guild', 'event'), (error: unknown) =>
      error instanceof ActionError && error.code === 'discord_unavailable');
  }
});

test('event lifecycle names match the wire codes, unknown codes pass through as numbers', () => {
  assert.equal(eventStatusName(1), 'SCHEDULED');
  assert.equal(eventStatusName(2), 'ACTIVE');
  assert.equal(eventStatusName(3), 'COMPLETED');
  assert.equal(eventStatusName(4), 'CANCELED');
  assert.equal(eventStatusName(9), '9');
  assert.equal(eventStatusName('SCHEDULED'), null);
  assert.equal(eventStatusName(undefined), null);
});
