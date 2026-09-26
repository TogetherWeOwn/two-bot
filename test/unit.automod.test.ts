import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAutomodConfig } from '../src/automod/config.ts';
import { ActionError } from '../src/internal/errors.ts';
import { matchAutomod, MemoryRepeatTracker } from '../src/automod/matcher.ts';
import { AutomodService } from '../src/automod/service.ts';
import { AutomodStore } from '../src/automod/store.ts';
import { AutomodProcessingError, type AutomodMessage, type AutomodPolicy } from '../src/automod/types.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import { ModerationService } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import type { ModerationTarget } from '../src/moderation/types.ts';
import { openTestDb } from './helpers/testDb.ts';

const STAGING_TOKEN = `${Buffer.from('1469137636663758888').toString('base64url')}.mock.signature`;

const GUILD = '1545644954272137297';
const CHANNEL = '1546211375251066941';
const USER = '900000000000000001';
const OWEN = '1469137636663758888';
const BYPASS = '900000000000000002';
const EXEMPT = '900000000000000003';
const STAFF = '900000000000000004';

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
    observedTimestamp: Date.parse('2026-09-09T06:00:00.000Z'),
    ...overrides,
  };
}

/**
 * An ordinary member: no roles, not the owner, not a bot. Since TOG-3092 every
 * enforcing match resolves its target before deleting, so a resolver that
 * throws is only correct where resolution genuinely must not happen.
 */
const unprotected = {
  target: async (_guild: string, userId: string): Promise<ModerationTarget> => ({
    userId,
    roleIds: [],
    highestRolePosition: 1,
    isBot: false,
    isGuildOwner: false,
  }),
};

test('loads default-off configuration and validates the sanction ladder', () => {
  const staging = { DISCORD_GUILD_ID: '1545644954272137297', DISCORD_TOKEN: STAGING_TOKEN };
  assert.equal(loadAutomodConfig({}).enabled, false);
  assert.equal(loadAutomodConfig({ ...staging, TWO_AUTOMOD: '1' }).dryRun, true);
  assert.equal(loadAutomodConfig({ ...staging, TWO_AUTOMOD: '1', TWO_AUTOMOD_ENFORCE: '1' }).dryRun, false);
  assert.throws(
    () => loadAutomodConfig({ TWO_AUTOMOD: '1', DISCORD_GUILD_ID: '326474832151838730', DISCORD_TOKEN: STAGING_TOKEN }),
    /allowlist refused automod/i,
  );
  const cfg = loadAutomodConfig({
    ...staging,
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
    ['bare external subdomain', { content: 'read foo.example.com/path' }, 'external_link'],
    ['zero-width external domain', { content: 'read example​.net/path' }, 'external_link'],
    ['package filename', { content: 'inspect package.json' }, null],
    ['source path', { content: 'inspect src/config.ts' }, null],
    ['readme filename', { content: 'inspect README.md' }, null],
    ['tsconfig filename', { content: 'inspect tsconfig.json' }, null],
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
  assert.equal(matchAutomod(message({ messageId: '2', content: 'repeat me', observedTimestamp: message().observedTimestamp + 1000 }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '3', content: 'repeat me', observedTimestamp: message().observedTimestamp + 2000 }), policy, tracker), null);
  assert.equal(matchAutomod(message({ messageId: '1', content: 'repeat me', observedTimestamp: message().observedTimestamp + 3000 }), policy, tracker), 'repeated_message');
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
    moderationAuditSecret: 's'.repeat(32),
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
  assert.deepEqual(calls.slice(0, 3), ['delete:m1', 'delete:m2', 'delete:m3']);
  assert.match(
    calls[3]!,
    new RegExp(`^timeout:${USER}:\\[two-audit:v1:[a-f0-9]{32}:moderation\\.timeout:${OWEN}:[a-f0-9]{16}\\] Automod bad words; violation 3$`),
  );
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
  await dryRun.inspect(message({ messageId: 'same-message', content: 'very bad' }));
  await dryRun.inspect(message({ messageId: 'dry-2', content: 'very bad' }));
  assert.equal((await testDb.db.prepare('SELECT COUNT(*) AS n FROM automod_violations').get<{ n: number }>())?.n, 0);

  const enforce = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    unprotected,
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  const first = await enforce.inspect(message({ messageId: 'same-message', content: 'very bad' }));
  assert.equal(first.sanction, 'delete');
  assert.deepEqual(calls, ['delete:same-message']);
  await testDb.cleanup();
});

test('a definite message deletion refusal releases the claim for retry', async () => {
  const testDb = await openTestDb(import.meta.filename);
  let calls = 0;
  const discord: ModerationDiscordClient = {
    async deleteMessage() {
      calls++;
      if (calls === 1) throw new ActionError('discord_rejected', 'Discord refused the request with 403');
    },
    async timeout() {}, async ban() {}, async unban() {}, async kick() {},
    async purge(_channel, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    unprotected,
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  await assert.rejects(() => service.inspect(message({ messageId: 'retry-delete', content: 'very bad' })), /Discord refused/);
  const retried = await service.inspect(message({ messageId: 'retry-delete', content: 'very bad' }));
  assert.equal(retried.deleted, true);
  assert.equal(calls, 2);
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

test('an in-flight duplicate remains matched for the gateway', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    {
      async deleteMessage() {}, async timeout() {}, async ban() {}, async unban() {}, async kick() {},
      async purge(_channel, count) { return count; }, async setSlowmode() {},
      async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
    },
    {} as ModerationService,
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new Error('not reached'); } },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );
  await moderationStore.claim(
    GUILD,
    'automod:duplicate',
    'automod.bad_words',
    createHash('sha256').update(JSON.stringify({ filter: 'bad_words', authorId: USER, channelId: CHANNEL })).digest('hex'),
  );
  await assert.rejects(
    () => service.inspect(message({ messageId: 'duplicate', content: 'very bad' })),
    (err: unknown) => err instanceof AutomodProcessingError && err.matched,
  );
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
    unprotected,
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

/**
 * The two refusal families are deliberately not treated alike (TOG-3092).
 * A *protection* - who the target is - stops the delete too. A *hierarchy*
 * limit does not: Manage Messages lets Owen delete a message from someone
 * ranked above them, so only the timeout rung is out of reach.
 */
test('sanction refusals are audited and replay without a second mutation', async () => {
  const refusals = [
    {
      name: 'protected role',
      target: { userId: USER, roleIds: [BYPASS], highestRolePosition: 1, isBot: false, isGuildOwner: false },
      botHighestRolePosition: 10,
      protectedRoleIds: new Set([BYPASS]),
      reason: 'target_staff_role',
      deletes: false,
    },
    {
      name: 'role hierarchy',
      target: { userId: USER, roleIds: [], highestRolePosition: 10, isBot: false, isGuildOwner: false },
      botHighestRolePosition: 10,
      protectedRoleIds: new Set<string>(),
      reason: 'actor_hierarchy',
      deletes: true,
    },
  ];

  for (const refusal of refusals) {
    const testDb = await openTestDb(import.meta.filename);
    const calls: string[] = [];
    const discord: ModerationDiscordClient = {
      async deleteMessage(_channel, id) { calls.push(`delete:${id}`); },
      async timeout() { calls.push('timeout'); },
      async ban() {}, async unban() {}, async kick() {},
      async purge(_channel, count) { return count; }, async setSlowmode() {},
      async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
    };
    const moderationStore = new ModerationStore(testDb.db);
    const service = new AutomodService(
      discord,
      new ModerationService(discord, moderationStore, {
        owenUserId: OWEN,
        botUserId: OWEN,
        protectedRoleIds: refusal.protectedRoleIds,
      }),
      moderationStore,
      new AutomodStore(testDb.db),
      { target: async () => refusal.target },
      {
        dryRun: false,
        owenUserId: OWEN,
        botHighestRolePosition: refusal.botHighestRolePosition,
        policy: { ...policy, sanctions: [{ violations: 1, action: 'timeout', timeoutSeconds: 600 }] },
      },
    );
    const messageId = `refused-${refusal.reason}`;
    const expectedCalls = refusal.deletes ? [`delete:${messageId}`] : [];
    const first = await service.inspect(message({ messageId, content: 'very bad' }));
    assert.deepEqual(
      first,
      { matched: true, deleted: refusal.deletes, filter: 'bad_words', sanction: 'timeout' },
      refusal.name,
    );
    assert.deepEqual(calls, expectedCalls, `${refusal.name}: no refused sanction reached Discord`);

    const audit = await testDb.db.prepare(
      `SELECT outcome, metadata_json FROM moderation_audit WHERE action = 'automod.bad_words'`,
    ).get<{ outcome: string; metadata_json: string }>();
    assert.equal(audit?.outcome, 'refused', refusal.name);
    assert.deepEqual(JSON.parse(audit?.metadata_json ?? '{}'), {
      message_id: messageId,
      filter: 'bad_words',
      violation_count: 1,
      sanction: 'timeout',
      timeout_seconds: 600,
      dry_run: false,
      refusal_reason: refusal.reason,
    });
    assert.ok(!audit?.metadata_json.includes('very bad'), `${refusal.name}: message content is absent from audit metadata`);

    const replay = await service.inspect(message({ messageId, content: 'very bad' }));
    assert.equal(replay.replayed, true, refusal.name);
    assert.deepEqual(calls, expectedCalls, `${refusal.name}: replay made no second Discord call`);
    assert.equal((await testDb.db.prepare(`SELECT COUNT(*) AS n FROM automod_violations`).get<{ n: number }>())?.n, 1);
    assert.equal((await testDb.db.prepare(
      `SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'automod.bad_words'`,
    ).get<{ n: number }>())?.n, 1);
    await testDb.cleanup();
  }
});

/**
 * TOG-3092. Owen deleted the guild owner's own message in TWO Staging on a
 * FIRST violation - `violation_count=1 sanction=delete` - because the delete ran
 * unconditionally and the owner/staff guard only ran on the rung above it. The
 * ladder here is therefore the default one, not a timeout-at-one: the point is
 * that the delete rung itself must consult protection.
 */
test('a protected target is refused before the delete, never after it', async () => {
  const scenarios = [
    {
      name: 'guild owner',
      target: { userId: USER, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: true },
      reason: 'target_guild_owner',
    },
    {
      name: 'protected staff role',
      target: { userId: USER, roleIds: [STAFF], highestRolePosition: 1, isBot: false, isGuildOwner: false },
      reason: 'target_staff_role',
    },
  ];

  for (const scenario of scenarios) {
    const testDb = await openTestDb(import.meta.filename);
    const calls: string[] = [];
    const discord: ModerationDiscordClient = {
      async deleteMessage(_channel, id) { calls.push(`delete:${id}`); },
      async timeout(_guild, user) { calls.push(`timeout:${user}`); },
      async ban() {}, async unban() {}, async kick() {},
      async purge(_channel, count) { return count; }, async setSlowmode() {},
      async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
    };
    const moderationStore = new ModerationStore(testDb.db);
    const service = new AutomodService(
      discord,
      new ModerationService(discord, moderationStore, {
        owenUserId: OWEN,
        botUserId: OWEN,
        protectedRoleIds: new Set([STAFF]),
      }),
      moderationStore,
      new AutomodStore(testDb.db),
      { target: async () => scenario.target },
      { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
    );

    const messageId = `protected-${scenario.reason}`;
    const first = await service.inspect(message({ messageId, content: 'very bad' }));
    assert.deepEqual(
      first,
      { matched: true, deleted: false, filter: 'bad_words', sanction: 'delete' },
      `${scenario.name}: the match is reported, the deletion is not`,
    );
    assert.deepEqual(calls, [], `${scenario.name}: a protected target takes zero Discord mutations`);

    const audit = await testDb.db.prepare(
      `SELECT outcome, metadata_json FROM moderation_audit WHERE action = 'automod.bad_words'`,
    ).all<{ outcome: string; metadata_json: string }>();
    assert.equal(audit.length, 1, `${scenario.name}: exactly one audit row`);
    assert.equal(audit[0]?.outcome, 'refused', scenario.name);
    assert.deepEqual(JSON.parse(audit[0]?.metadata_json ?? '{}'), {
      message_id: messageId,
      filter: 'bad_words',
      violation_count: 1,
      sanction: 'delete',
      dry_run: false,
      refusal_reason: scenario.reason,
    }, scenario.name);

    const replay = await service.inspect(message({ messageId, content: 'very bad' }));
    assert.equal(replay.replayed, true, scenario.name);
    assert.deepEqual(calls, [], `${scenario.name}: replay stayed silent too`);
    await testDb.cleanup();
  }
});

test('an unprotected target keeps the delete and the full sanction ladder', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const calls: string[] = [];
  const discord: ModerationDiscordClient = {
    async deleteMessage(_channel, id) { calls.push(`delete:${id}`); },
    async timeout(_guild, user) { calls.push(`timeout:${user}`); },
    async ban() {}, async unban() {}, async kick() {},
    async purge(_channel, count) { return count; }, async setSlowmode() {},
    async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, {
      owenUserId: OWEN,
      botUserId: OWEN,
      // STAFF is protected in the policy, but this target does not hold it.
      protectedRoleIds: new Set([STAFF]),
    }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async (_guild, userId) => ({ userId, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false }) },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy },
  );

  const first = await service.inspect(message({ messageId: 'plain-1', content: 'very bad' }));
  const second = await service.inspect(message({ messageId: 'plain-2', content: 'very bad' }));
  const third = await service.inspect(message({ messageId: 'plain-3', content: 'very bad' }));
  assert.deepEqual([first.sanction, second.sanction, third.sanction], ['delete', 'warn', 'timeout']);
  assert.deepEqual([first.deleted, second.deleted, third.deleted], [true, true, true]);
  assert.deepEqual(calls.slice(0, 3), ['delete:plain-1', 'delete:plain-2', 'delete:plain-3']);
  assert.equal(calls[3], `timeout:${USER}`, 'the third violation still reaches the timeout rung');
  const outcomes = await testDb.db.prepare(
    `SELECT outcome FROM moderation_audit WHERE action = 'automod.bad_words' ORDER BY created_at`,
  ).all<{ outcome: string }>();
  assert.deepEqual(outcomes.map((row) => row.outcome), ['deleted', 'warn', 'timeout']);
  await testDb.cleanup();
});

/**
 * Before TOG-3092 the resolver ran after the delete, so a resolver failure left
 * a deleted message behind and a claim stranded in flight. It now runs first,
 * which makes the failure fail closed: nothing reaches Discord, and because
 * nothing was mutated the claim is released for an honest retry.
 */
test('an unexpected resolver refusal mutates nothing and stays retryable', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const calls: string[] = [];
  const discord: ModerationDiscordClient = {
    async deleteMessage(_channel, id) { calls.push(`delete:${id}`); }, async timeout() { calls.push('timeout'); },
    async ban() {}, async unban() {}, async kick() {}, async purge(_channel, count) { return count; },
    async setSlowmode() {}, async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async () => { throw new ActionError('action_not_allowed', 'Unexpected resolver refusal', { logReason: 'unexpected_resolver_refusal' }); } },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy: { ...policy, sanctions: [{ violations: 1, action: 'timeout', timeoutSeconds: 600 }] } },
  );
  await assert.rejects(() => service.inspect(message({ messageId: 'unexpected-resolver', content: 'very bad' })), /Unexpected resolver refusal/);
  await assert.rejects(() => service.inspect(message({ messageId: 'unexpected-resolver', content: 'very bad' })), /Unexpected resolver refusal/);
  assert.deepEqual(calls, [], 'an unresolvable target is never deleted on the strength of not knowing');
  assert.equal((await testDb.db.prepare(
    `SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'automod.bad_words'`,
  ).get<{ n: number }>())?.n, 0);
  await testDb.cleanup();
});

test('unexpected sanction failures keep the outer claim in flight', async () => {
  const testDb = await openTestDb(import.meta.filename);
  const discord: ModerationDiscordClient = {
    async deleteMessage() {}, async timeout() { throw new Error('timeout transport failed'); },
    async ban() {}, async unban() {}, async kick() {}, async purge(_channel, count) { return count; },
    async setSlowmode() {}, async getEveryoneOverwrite() { return null; }, async putEveryoneOverwrite() {}, async deleteEveryoneOverwrite() {},
  };
  const moderationStore = new ModerationStore(testDb.db);
  const service = new AutomodService(
    discord,
    new ModerationService(discord, moderationStore, { owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set() }),
    moderationStore,
    new AutomodStore(testDb.db),
    { target: async (_guild, userId) => ({ userId, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false }) },
    { dryRun: false, owenUserId: OWEN, botHighestRolePosition: 10, policy: { ...policy, sanctions: [{ violations: 1, action: 'timeout', timeoutSeconds: 600 }] } },
  );
  await assert.rejects(() => service.inspect(message({ messageId: 'unexpected-sanction', content: 'very bad' })), /timeout transport failed/);
  await assert.rejects(() => service.inspect(message({ messageId: 'unexpected-sanction', content: 'very bad' })), /uncertain outcome/);
  assert.equal((await testDb.db.prepare(
    `SELECT COUNT(*) AS n FROM moderation_audit WHERE action = 'automod.bad_words'`,
  ).get<{ n: number }>())?.n, 0);
  await testDb.cleanup();
});
