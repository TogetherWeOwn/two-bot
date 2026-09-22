import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { classifyKey } from '../src/core/settingsCatalog.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { ActionError } from '../src/internal/errors.ts';

const env = { TWO_INTERNAL_ACTIONS: '1', TWO_INTERNAL_KEYS: `test:${'k'.repeat(48)}` };

test('event cancellation is an explicit environment-only capability, not enabled by event.upsert', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const config = loadInternalActionsConfig({ ...env, TWO_INTERNAL_ALLOW_EVENT_CANCEL: value })!;
    assert.equal(config.enabled.has('event.upsert'), true);
    assert.equal(config.enabled.has('event.cancel'), false);
  }
  const config = loadInternalActionsConfig({ ...env, TWO_INTERNAL_ALLOW_EVENT_CANCEL: '1' })!;
  assert.equal(config.enabled.has('event.cancel'), true);
  assert.equal(classifyKey('TWO_INTERNAL_ALLOW_EVENT_CANCEL'), 'env_only');
});

test('event cancellation preserves typed upstream failures instead of claiming success', async () => {
  for (const [status, code] of [[400, 'discord_rejected'], [403, 'discord_rejected'], [404, 'discord_rejected'], [429, 'rate_limited'], [503, 'discord_unavailable']] as const) {
    const discord = new DiscordActions({
      token: 'mock-bot-token',
      fetchImpl: async () => new Response('{}', { status }),
    });
    await assert.rejects(discord.cancelEvent('guild', 'event'), (error: unknown) =>
      error instanceof ActionError && error.code === code);
  }
});
