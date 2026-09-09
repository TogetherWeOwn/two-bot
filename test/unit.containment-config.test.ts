import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContainmentConfig } from '../src/moderation/containmentConfig.ts';

const GUILD = '1545644954272137297';
const BOT = '1469137636663758888';

test('containment is off without an explicit switch', () => {
  const config = loadContainmentConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.guildId, null);
});

test('enabled containment requires a guild and Owen id', () => {
  assert.throws(() => loadContainmentConfig({ TWO_ANTI_NUKE: '1' }), /requires DISCORD_GUILD_ID/);
  assert.throws(
    () => loadContainmentConfig({ TWO_ANTI_NUKE: '1', DISCORD_GUILD_ID: GUILD }),
    /requires TWO_OWEN_USER_ID/,
  );
});

test('enabled containment defaults to dry-run', () => {
  const config = loadContainmentConfig({
    TWO_ANTI_NUKE: '1',
    DISCORD_GUILD_ID: GUILD,
    TWO_OWEN_USER_ID: BOT,
  });
  assert.equal(config.dryRun, true);
  assert.equal(loadContainmentConfig({
    TWO_ANTI_NUKE: '1',
    TWO_ANTI_NUKE_DRY_RUN: '0',
    DISCORD_GUILD_ID: GUILD,
    TWO_OWEN_USER_ID: BOT,
  }).dryRun, false);
});

test('bulk join window and allowlists are normalized', () => {
  const config = loadContainmentConfig({
    TWO_ANTI_NUKE: '1',
    DISCORD_GUILD_ID: GUILD,
    TWO_OWEN_USER_ID: BOT,
    TWO_ANTI_NUKE_PROTECTED_USER_IDS: '111111111111111111',
    TWO_ANTI_NUKE_TRUSTED_USER_IDS: '222222222222222222',
    TWO_BULK_JOIN_WINDOW_UNTIL: '2026-09-09T16:00:00Z',
  });
  assert.equal(config.bulkJoinWindowUntil, '2026-09-09T16:00:00.000Z');
  assert.equal(config.protectedUserIds.has(BOT), true);
  assert.equal(config.protectedUserIds.has('111111111111111111'), true);
  assert.equal(config.trustedUserIds.has('222222222222222222'), true);
});
