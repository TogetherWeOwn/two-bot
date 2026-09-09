import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAutomodConfig } from '../src/automod/config.ts';
import { matchAutomod, MemoryRepeatTracker } from '../src/automod/matcher.ts';
import { AutomodService } from '../src/automod/service.ts';
import { AutomodStore } from '../src/automod/store.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import { ModerationService } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import { openTestDb } from './helpers/testDb.ts';

const GUILD = '1545644954272137297';
const CHANNEL = '1546211375251066941';
const USER = '900000000000000001';
const OWEN = '1469137636663758888';
const BYPASS = '900000000000000002';
const EXEMPT = '900000000000000003';

const policy: AutomodPolicy = {
  badWords: ['very bad'],
  blockedAttachmentExtensions: ['exe'],
  allowedDomains: ['two.gg'],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set([BYPASS]),
  exemptChannelIds: new Set([EXEMPT]),
  sanctions: [
    { violations: 1, action: 'delete' },
    { violations: 2, action: 'warn' },
    { violations: 3, action: 'timeout', timeoutSeconds: 600 },
  ],
};

function message(overrides: Partial<AutomodMessage> = {}): AutomodMessage {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: '900000000000000010',
    authorId: USER,
    authorIsBot: false,
    roleIds: [],
    content: 'ordinary message',
    mentionedUserIds: [],
    attachmentNames: [],
    createdTimestamp: Date.parse('2026-09-09T06:00:00.000Z'),
    ...overrides,
  };
}

test('loads default-off configuration and validates the sanction ladder', () => {
  assert.equal(loadAutomodConfig({}).enabled, false);
  assert.equal(loadAutomodConfig({ TWO_AUTOMOD: '1' }).dryRun, true);
  assert.equal(loadAutomodConfig({ TWO_AUTOMOD: '1', TWO_AUTOMOD_ENFORCE: '1' }).dryRun, false);
  assert.throws(
    () => loadAutomodConfig({ TWO_AUTOMOD: '1', DISCORD_GUILD_ID: '326474832151838730' }),
    /staging-only.*live TWO guild/i,
  );
  const cfg = loadAutomodConfig({
    TWO_AUTOMOD: '1',
    TWO_AUTOMOD_BAD_WORDS: 'one,two',
    TWO_AUTOMOD_SANCTIONS: '1:delete,2:warn,4:timeout:900',
    TWO_AUTOMOD_BYPASS_ROLE_IDS: BYPASS,
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.policy.badWords, ['one', 'two']);
  assert.deepEqual(cfg.policy.sanctions[2], { violations: 4, action: 'timeout', timeoutSeconds: 900 });
  assert.throws(() => loadAutomodConfig({ TWO_AUTOMOD_SANCTIONS: '1:ban' }));
  assert.throws(() => loadAutomodConfig({ TWO_AUTOMOD_SANCTIONS: '2:timeout:600' }));
});

test('matches every configured filter and avoids common false positives', () => {
  const cases: Array<[string, Partial<AutomodMessage>, string | null]> = [
    ['whole bad phrase', { content: 'that was VERY   BAD.' }, 'bad_words'],
    ['zero-width bad phrase', { content: 'that was very​bad' }, 'bad_words'],
    ['bad phrase boundary', { content: 'very badly written' }, null],
    ['mention spam', { mentionedUserIds: ['1', '1', '1'] }, 'mention_spam'],
    ['invite', { content: 'join https://discord.gg/example' }, 'invite_link'],
    ['zero-width invite', { content: 'join discord​.gg/example' }, 'invite_link'],
    ['allowed domain', { content: 'read https://www.two.gg/rules' }, null],
    ['allowed bare domain', { content: 'read two.gg/rules' }, null],
    ['allowed angle link', { content: 'read <https://two.gg/rules>' }, null],
    ['allowed punctuated link', { content: 'read https://two.gg/rules.' }, null],
    ['email address', { content: 'email person@example.net' }, null],
    ['external link', { content: 'read https://example.net/rules' }, 'external_link'],
    ['scheme-less external link', { content: 'read www.evil.example/path' }, 'external_link'],
    ['bare external domain', { content: 'read example.net/path' }, 'external_link'],
    ['zero-width external domain', { content: 'read example​.net/path' }, 'external_link'],
    ['blocked attachment', { attachmentNames: ['payload.EXE'] }, 'attachment_type'],
    ['safe attachment', { attachmentNames: ['screenshot.png'] }, null],
  ];
  for (const [name, patch, expected] of cases) {
    assert.equal(matchAutomod(message(patch), policy, new MemoryRepeatTracker()), expected, name);
  }
});

test('repeat filter requires distinct message ids inside the window and tracks edits', () => {
  const tracker = new MemoryRepeatTracker();
  assert.equal(matchAutomod(message({ messageId: '1', content: 'repeat me' }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '1', content: 'other text' }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '2', content: 'repeat me', createdTimestamp: message().createdTimestamp + 1000 }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '3', content: 'repeat me', createdTimestamp: message().createdTimestamp + 2000 }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '1', content: 'repeat me', createdTimestamp: message().createdTimestamp + 3000 }), policy, tracker), 'repeated_message');
});

test('deletes, warns, then times out through the reviewed moderation service', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const calls: string[] = [];
  const discord: ModerationDiscordClient = {
    async deleteMessage(_channel, id) { calls.push(`delete:${id}`); },
    async timeout(_guild, user, _until, reason) { calls.push(`timeout:${user}:${reason}`); },
    async ban() {}, async unban() {}, async kick() {},
    async purge(_channel, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const moderation = new ModerationService(discord, moderationStore, {
    owenUserId: OWEN,
    botUserId: OWEN,
    protectedRoleIds: new Set(),
  });
  const service = new AutomodService(
    discord,
    moderation,
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async (_guild, userId) => ({ userId, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false }) },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );

  const first = await service.inspect(message({ messageId: 'm1', content: 'very bad' }));
  const second = await service.inspect(message({ messageId: 'm2', content: 'very bad' }));
  const third = await service.inspect(message({ messageId: 'm3', content: 'very bad' }));
  assert.deepEqual([first.sanction, second.sanction, third.sanction], ['delete', 'warn', 'timeout']);
  assert.deepEqual(calls, ['delete:m1', 'delete:m2', 'delete:m3', `timeout:${USER}:Automod bad words; violation 3`]);
  assert.equal((await testDb.db.prepare('SELECT COUNT(*) AS n FROM moderation_warnings').get<{ n: number }>())?.n, 1);
  assert.equal((await testDb.db.prepare('SELECT COUNT(*) AS n FROM moderation_audit').get<{ n: number }>())?.n, 5);
  const audit = await testDb.db.prepare(`SELECT metadata_json FROM moderation_audit WHERE action = 'automod.bad_words' ORDER BY created_at`).all<{ metadata_json: string }>();
  assert.equal(audit.length, 3);
  assert.ok(audit.every((row) => !row.metadata_json.includes('very bad')), 'message content is absent from audit metadata');

  const replay = await service.inspect(message({ messageId: 'm3', content: 'very bad' }));
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 4, 'gateway replay made no second Discord call');
  await testDb.cleanup();
});

test('dry-run matches do not advance the enforceable sanctions ledger', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const calls: string[] = [];
  const discord: ModerationDiscordClient = {
    async deleteMessage(_channel, id) { calls.push(`delete:${id}`); }, async timeout() { calls.push('timeout'); },
    async ban() {}, async unban() {}, async kick() {}, async purge(_channel, count) { return count; },
    async setSlowmode() {}, async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const dryRun = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new Error('not reached'); } },
    { dryRun: true, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  await dryRun.inspect(message({ messageId: 'dry-1', content: 'very bad' }));
  await dryRun.inspect(message({ messageId: 'dry-2', content: 'very bad' }));
  assert.equal((await testDb.db.prepare('SELECT COUNT(*) AS n FROM automod_violations').get<{ n: number }>())?.n, 0);

  const enforce = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new Error('not reached'); } },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  const first = await enforce.inspect(message({ messageId: 'enforce-1', content: 'very bad' }));
  assert.equal(first.sanction, 'delete');
  assert.deepEqual(calls, ['delete:enforce-1']);
  await testDb.cleanup();
});

test('delayed retry of an older message does not advance the sanctions ledger', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const store = new AutomodStore(testDb.db);
  assert.equal(await store.recordViolation(GUILD, USER, 'bad_words', 'm1'), 1);
  assert.equal(await store.recordViolation(GUILD, USER, 'bad_words', 'm2'), 2);
  assert.equal(await store.recordViolation(GUILD, USER, 'bad_words', 'm1'), 2);
  assert.equal((await testDb.db.prepare('SELECT COUNT(*) AS n FROM automod_processed_messages').get<{ n: number }>())?.n, 2);
  await testDb.cleanup();
});

test('uncertain post-mutation failure keeps the outer claim in flight', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async deleteMessage() {}, async timeout() {}, async ban() {}, async unban() {}, async kick() {},
    async purge(_channel, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const realComplete = moderationStore.complete.bind(moderationStore);
  let failOuterComplete = true;
  moderationStore.complete = async (guildId, key, stored) => {
    if (key === 'automod:uncertain' && failOuterComplete) {
      failOuterComplete = false;
      throw new Error('completion unavailable');
    }
    await realComplete(guildId, key, stored);
  };
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new Error('not reached'); } },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  await assert.rejects(() => service.inspect(message({ messageId: 'uncertain', content: 'very bad' })), /completion unavailable/);
  await assert.rejects(() => service.inspect(message({ messageId: 'uncertain', content: 'very bad' })), /uncertain outcome/);
  await testDb.cleanup();
});

test('bypass roles, channel exceptions, bots, and dry-run make no Discord mutation', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let calls = 0;
  const discord: ModerationDiscordClient = {
    async deleteMessage() { calls++; }, async timeout() { calls++; },
    async ban() {}, async unban() {}, async kick() {}, async purge(_channel, count) { return count; },
    async setSlowmode() {}, async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new Error('not reached'); } },
    { dryRun: true, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  assert.equal((await service.inspect(message({ content: 'very bad', roleIds: [BYPASS] }))).matched, false);
  assert.equal((await service.inspect(message({ content: 'very bad', channelId: EXEMPT }))).matched, false);
  assert.equal((await service.inspect(message({ content: 'very bad', authorIsBot: true }))).matched, false);
  const dry = await service.inspect(message({ messageId: 'dry', content: 'very bad' }));
  assert.deepEqual(dry, { matched: true, deleted: false, filter: 'bad_words', sanction: 'delete' });
  assert.equal(calls, 0);
  await testDb.cleanup();
});

test('sanction hierarchy and protected-target checks come from moderation primitives', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async deleteMessage() {}, async timeout() {}, async ban() {}, async unban() {}, async kick() {},
    async purge(_channel, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set([BYPASS]) }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async (_guild, userId) => ({ userId, roleIds: [BYPASS], highestRolePosition: 1, isBot: false, isGuildOwner: false }) },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy: { ...policy, sanctions: [{ violations: 1, action: 'timeout', timeoutSeconds: 600 }] } },
  );
  await assert.rejects(() => service.inspect(message({ content: 'very bad' })), /Staff roles are protected/);
  await testDb.cleanup();
});
