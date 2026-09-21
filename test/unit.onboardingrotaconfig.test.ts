import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOnboardingRotaConfig } from '../src/analytics/onboardingRotaConfig.ts';
import { storeFirst } from '../src/core/config.ts';
import { classifyKey, isEnvOnlyKey } from '../src/core/settingsCatalog.ts';
import { LIVE_GUILD_ID } from '../src/staging/spec.ts';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const KEY = 'fixture-only-not-a-real-key-12345678';
const enabledEnv = (): NodeJS.ProcessEnv => ({
  TWO_ONBOARDING_ROTA_MEASUREMENT: '1',
  DISCORD_GUILD_ID: GUILD,
  DISCORD_STAGING_GUILD_ID: GUILD,
  TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: KEY,
});
const protectedKeys = [
  'TWO_ONBOARDING_ROTA_MEASUREMENT',
  'TWO_ONBOARDING_ROTA_NOTICE',
  'TWO_ONBOARDING_ROTA_PSEUDONYM_KEY',
  'TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID',
];

test('rota defaults off and only exact 1 opts into measurement', () => {
  for (const flag of [undefined, '', '0', 'false', 'true', 'yes', ' 1 ']) {
    assert.deepEqual(loadOnboardingRotaConfig({ TWO_ONBOARDING_ROTA_MEASUREMENT: flag }), {
      enabled: false, noticeEnabled: false,
    });
  }
});

test('master rollback disables notice and does not read even an unreadable credential', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-rota-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'onboarding_rota_pseudonym_key'));
  assert.deepEqual(loadOnboardingRotaConfig({
    TWO_ONBOARDING_ROTA_MEASUREMENT: '0',
    TWO_ONBOARDING_ROTA_NOTICE: '1',
    CREDENTIALS_DIRECTORY: dir,
    DISCORD_GUILD_ID: LIVE_GUILD_ID,
  }), { enabled: false, noticeEnabled: false });
});

test('measurement can run with notices off and no notice destination', () => {
  assert.deepEqual(loadOnboardingRotaConfig(enabledEnv()), {
    enabled: true, noticeEnabled: false, guildId: GUILD, pseudonymKey: KEY, noticeChannelId: null,
  });
});

test('notice opt-in requires measurement and a valid explicit destination', () => {
  for (const channel of [undefined, '', 'general', '123', '1'.repeat(21)]) {
    assert.throws(() => loadOnboardingRotaConfig({
      ...enabledEnv(), TWO_ONBOARDING_ROTA_NOTICE: '1', DISCORD_STAFF_ALERT_CHANNEL_ID: channel,
    }), /require DISCORD_STAFF_ALERT_CHANNEL_ID/);
  }
  const cfg = loadOnboardingRotaConfig({
    ...enabledEnv(), TWO_ONBOARDING_ROTA_NOTICE: '1', DISCORD_STAFF_ALERT_CHANNEL_ID: CHANNEL,
  });
  assert.ok(cfg.enabled);
  assert.equal(cfg.noticeEnabled, true);
  assert.equal(cfg.noticeChannelId, CHANNEL);
});

test('primary binding is optional, explicit, validated and ignored during master rollback', () => {
  const primary = '333333333333333333';
  const cfg = loadOnboardingRotaConfig({ ...enabledEnv(), TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID: ` ${primary} ` });
  assert.ok(cfg.enabled);
  assert.equal(cfg.primaryActorId, primary);
  assert.equal(cfg.noticeEnabled, false, 'primary acknowledgement does not opt into notices');
  for (const value of ['', ' ', 'owner', '123', '1'.repeat(21)]) {
    assert.throws(() => loadOnboardingRotaConfig({ ...enabledEnv(), TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID: value }),
      { message: 'Onboarding rota primary binding requires a valid Discord user id.' });
    assert.deepEqual(loadOnboardingRotaConfig({ TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID: value }),
      { enabled: false, noticeEnabled: false });
  }
});

test('notice rollback leaves measurement enabled and ignores stale destination', () => {
  for (const flag of [undefined, '', '0', 'true', ' 1 ']) {
    const cfg = loadOnboardingRotaConfig({
      ...enabledEnv(), TWO_ONBOARDING_ROTA_NOTICE: flag, DISCORD_STAFF_ALERT_CHANNEL_ID: 'invalid',
    });
    assert.ok(cfg.enabled);
    assert.equal(cfg.noticeEnabled, false);
    assert.equal(cfg.noticeChannelId, null);
  }
});

test('enabled measurement refuses live, unscoped, malformed and mismatched guilds', () => {
  for (const [guild, staging] of [
    [LIVE_GUILD_ID, LIVE_GUILD_ID], [GUILD, LIVE_GUILD_ID],
    [undefined, GUILD], ['', GUILD], ['123', '123'],
    [GUILD, undefined], [GUILD, '333333333333333333'],
  ]) {
    assert.throws(() => loadOnboardingRotaConfig({
      ...enabledEnv(), DISCORD_GUILD_ID: guild, DISCORD_STAGING_GUILD_ID: staging,
    }), /staging-only/);
  }
});

test('enabled measurement requires at least 32 UTF-8 bytes without echoing a bad key', () => {
  for (const key of [undefined, '', 'short-private-fixture', 'x'.repeat(31), ' '.repeat(32)]) {
    assert.throws(() => loadOnboardingRotaConfig({
      ...enabledEnv(), TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: key,
    }), { message: 'Onboarding rota requires a pseudonym key of at least 32 bytes.' });
  }
  const cfg = loadOnboardingRotaConfig({
    ...enabledEnv(), TWO_ONBOARDING_ROTA_PSEUDONYM_KEY: 'é'.repeat(16),
  });
  assert.ok(cfg.enabled);
  assert.equal(Buffer.byteLength(cfg.pseudonymKey), 32);
});

test('systemd credential wins and is normalized through the existing reader', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-rota-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = 'fixture-credential-key-123456789012';
  writeFileSync(join(dir, 'onboarding_rota_pseudonym_key'), key + '\n', { mode: 0o600 });
  const cfg = loadOnboardingRotaConfig({ ...enabledEnv(), CREDENTIALS_DIRECTORY: dir });
  assert.ok(cfg.enabled);
  assert.equal(cfg.pseudonymKey, key);
});

test('invalid existing credential cannot silently fall back to a valid env key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-rota-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'onboarding_rota_pseudonym_key'), 'short', { mode: 0o600 });
  assert.throws(() => loadOnboardingRotaConfig({ ...enabledEnv(), CREDENTIALS_DIRECTORY: dir }), /32 bytes/);
});

test('rota gates and key cannot be substituted through the settings store', () => {
  const stored = new Map(protectedKeys.map((key) => [key, 'injected-through-dashboard']));
  const source = storeFirst(stored, { get: () => 'environment' });
  for (const key of protectedKeys) {
    assert.equal(classifyKey(key), 'env_only');
    assert.equal(isEnvOnlyKey(key), true);
    assert.equal(source.get(key), 'environment');
  }
});
