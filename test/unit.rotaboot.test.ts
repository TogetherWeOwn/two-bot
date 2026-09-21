import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GUILD = '111111111111111111';
const KEY = 'fixture-only-boot-key-not-a-real-secret';

function boot(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['src/index.ts'], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    // Deliberately no ambient secrets, credential directory, or deployment flags.
    env: {
      PATH: process.env.PATH,
      DISCORD_BOT_TOKEN: 'fixture-token',
      TWO_DATABASE_URL: 'postgres://two@127.0.0.1:1/unused',
      DISCORD_GUILD_ID: GUILD,
      DISCORD_STAGING_GUILD_ID: GUILD,
      TWO_ONBOARDING_ROTA_MEASUREMENT: '1',
      TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: KEY,
      TWO_ONBOARDING_MODE: 'session',
      ...env,
    },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, new RegExp(KEY));
  assert.doesNotMatch(output, /datastore_open/);
  return output;
}

test('boot rejects enabled notices rather than silently accepting an unwired sender', () => {
  const output = boot({ TWO_ONBOARDING_ROTA_NOTICE: '1', DISCORD_STAFF_ALERT_CHANNEL_ID: '222222222222222222' });
  assert.match(output, /notice sender is not implemented/);
});

test('measurement with notices off reaches the existing session guard, not an unwired boot path', () => {
  const output = boot({ TWO_ONBOARDING_ROTA_NOTICE: '0' });
  assert.match(output, /session requires DISCORD_GUILD_ID/);
  assert.doesNotMatch(output, /notice sender is not implemented/);
});

test('master-off skips key and notice validation in actual boot even with stale opt-ins', () => {
  const output = boot({
    TWO_ONBOARDING_ROTA_MEASUREMENT: '0', TWO_ONBOARDING_ROTA_NOTICE: '1',
    TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: '', DISCORD_STAGING_GUILD_ID: '',
  });
  assert.match(output, /session requires DISCORD_GUILD_ID/);
  assert.doesNotMatch(output, /notice sender is not implemented|rota requires|rota is staging-only/);
});

test('boot refuses the live guild even when explicitly configured as staging', () => {
  const output = boot({ DISCORD_GUILD_ID: '326474832151838730', DISCORD_STAGING_GUILD_ID: '326474832151838730' });
  assert.match(output, /Onboarding rota is staging-only/);
});
