import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionError } from '../src/internal/errors.ts';
import { ModerationDiscord } from '../src/moderation/discord.ts';
import { ModerationService, type ModerationExecution } from '../src/moderation/service.ts';
import type { LockdownRecord, ModerationStore } from '../src/moderation/store.ts';

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const ACTOR = '900000000000000003';
const BOT = '900000000000000004';
const OTHER_ROLE = '900000000000000005';

function request(action: 'moderation.lockdown' | 'moderation.unlock', key: string = action): ModerationExecution {
  return {
    action, guildId: GUILD, requestId: key, idempotencyKey: key,
    actor: { userId: ACTOR, roleIds: [], highestRolePosition: 10, permissions: ~0n },
    channel: { channelId: CHANNEL, type: 0 },
    reason: 'Synthetic lockdown recovery proof',
  };
}

function fixture(initialBody: string) {
  let body = initialBody;
  let recovery: LockdownRecord | null = null;
  const saved: LockdownRecord[] = [];
  const mutations: Array<{ method: string; body?: unknown }> = [];
  let reads = 0;
  let releases = 0;
  let completions = 0;
  const discord = new ModerationDiscord({
    token: 'synthetic-test-token',
    fetchImpl: async (url, init) => {
      if (init?.method === 'GET') {
        assert.equal(String(url), `https://discord.com/api/v10/channels/${CHANNEL}`);
        reads++;
        return new Response(body, { status: 200 });
      }
      assert.equal(String(url), `https://discord.com/api/v10/channels/${CHANNEL}/permissions/${GUILD}`);
      assert.ok(init?.method === 'PUT' || init?.method === 'DELETE');
      const overwrite = init.body ? JSON.parse(String(init.body)) : undefined;
      mutations.push({ method: init.method, body: overwrite });
      body = JSON.stringify({ permission_overwrites: overwrite ? [{ id: GUILD, ...overwrite }] : [] });
      return new Response(null, { status: 204 });
    },
  });
  // Only the service's channel-action store boundary is faked; no DB driver or
  // network is used. Record attempts are counted even if later cleared.
  const store = {
    async serializeChannel<T>(_channel: string, fn: () => Promise<T>) { return fn(); },
    async claim() { return { state: 'claimed' as const }; },
    async release() { releases++; },
    async complete() { completions++; },
    async recordAudit() {},
    async getLockdown() { return recovery; },
    async recordLockdown(record: LockdownRecord) {
      saved.push({ ...record });
      recovery ??= { ...record };
      return recovery;
    },
    async clearLockdown() { recovery = null; },
  } satisfies Pick<ModerationStore,
    'serializeChannel' | 'claim' | 'release' | 'complete' | 'recordAudit'
    | 'getLockdown' | 'recordLockdown' | 'clearLockdown'>;
  const service = new ModerationService(discord, store as unknown as ModerationStore, {
    owenUserId: BOT, botUserId: BOT, protectedRoleIds: new Set(),
  });
  return {
    service, saved, mutations,
    setBody(next: string) { body = next; },
    get recovery() { return recovery; },
    get reads() { return reads; },
    get releases() { return releases; },
    get completions() { return completions; },
  };
}

function invalidRead(error: unknown): boolean {
  return error instanceof ActionError && error.code === 'discord_rejected'
    && error.logReason === 'discord_invalid_channel_overwrites';
}

const invalidBodies: Array<[string, string]> = [
  ['invalid JSON', '{'],
  ['null channel', 'null'],
  ['array channel', '[]'],
  ['primitive channel', '"channel"'],
  ['missing overwrites', '{}'],
  ['null overwrites', '{"permission_overwrites":null}'],
  ['object overwrites', '{"permission_overwrites":{}}'],
  ['string overwrites', '{"permission_overwrites":"[]"}'],
  ['null row', '{"permission_overwrites":[null]}'],
  ['missing row identity', '{"permission_overwrites":[{}]}'],
  ['invalid everyone type', JSON.stringify({ permission_overwrites: [{ id: GUILD, type: '0', allow: '0', deny: '0' }] })],
  ['duplicate everyone rows', JSON.stringify({ permission_overwrites: [
    { id: GUILD, type: 0, allow: '1024', deny: '8192' },
    { id: GUILD, type: 0, allow: '0', deny: '0' },
  ] })],
];

for (const [name, body] of invalidBodies) {
  test(`lockdown refuses ${name} before recording or mutating overwrites`, async () => {
    const f = fixture(body);
    await assert.rejects(() => f.service.execute(request('moderation.lockdown')), invalidRead);
    assert.equal(f.reads, 1);
    assert.deepEqual(f.saved, []);
    assert.equal(f.recovery, null);
    assert.deepEqual(f.mutations, []);
    assert.equal(f.completions, 0);
    assert.equal(f.releases, 1, 'known pre-mutation refusal releases the claim');
  });
}

const invalidMasks: Array<[string, unknown]> = [
  ['missing', undefined], ['null', null], ['number', 1024], ['unsafe number', 2 ** 60],
  ['boolean', false], ['object', {}], ['array', []], ['empty', ''], ['negative', '-1'],
  ['signed', '+1'], ['hexadecimal', '0x800'], ['fraction', '1.5'], ['exponent', '1e3'],
  ['whitespace', ' 2048 '], ['trailing newline', '2048\n'], ['nondecimal', 'invalid'],
];
for (const field of ['allow', 'deny']) {
  for (const [name, mask] of invalidMasks) {
    test(`lockdown refuses ${name} ${field} mask before saving recovery`, async () => {
      const body = JSON.stringify({ permission_overwrites: [{ id: GUILD, type: 0, allow: '1024', deny: '8192', [field]: mask }] });
      const f = fixture(body);
      await assert.rejects(() => f.service.execute(request('moderation.lockdown')), invalidRead);
      assert.deepEqual(f.saved, []);
      assert.equal(f.recovery, null);
      assert.deepEqual(f.mutations, []);
      assert.equal(f.completions, 0);
    });
  }
}

for (const overwrites of [[], [{ id: OTHER_ROLE, type: 0, allow: '1024', deny: '0' }]]) {
  test(`valid absence (${overwrites.length} other rows) records absence and unlock deletes only the new overwrite`, async () => {
    const f = fixture(JSON.stringify({ permission_overwrites: overwrites }));
    assert.equal((await f.service.execute(request('moderation.lockdown'))).outcome, 'locked_down');
    assert.deepEqual(f.saved, [{ channelId: CHANNEL, guildId: GUILD, priorAllow: '0', priorDeny: '0',
      priorExists: false, reason: request('moderation.lockdown').reason }]);
    assert.equal((await f.service.execute(request('moderation.unlock'))).outcome, 'unlocked');
    assert.deepEqual(f.mutations, [
      { method: 'PUT', body: { type: 0, allow: '0', deny: '2048' } },
      { method: 'DELETE', body: undefined },
    ]);
    assert.equal(f.recovery, null);
    assert.equal(f.reads, 1, 'unlock uses the saved recovery record');
  });
}

for (const mask of ['0', '0000']) {
  test(`an existing ${mask} overwrite is restored, not deleted`, async () => {
    const f = fixture(JSON.stringify({ permission_overwrites: [{ id: GUILD, type: 0, allow: mask, deny: mask }] }));
    await f.service.execute(request('moderation.lockdown'));
    assert.equal(f.recovery?.priorExists, true);
    await f.service.execute(request('moderation.unlock'));
    assert.deepEqual(f.mutations, [
      { method: 'PUT', body: { type: 0, allow: '0', deny: '2048' } },
      { method: 'PUT', body: { type: 0, allow: mask, deny: mask } },
    ]);
    assert.equal(f.recovery, null);
  });
}

test('valid decimal masks preserve unrelated high bits and restore the exact first overwrite', async () => {
  const allow = ((1n << 60n) | 1024n | 2048n).toString();
  const deny = ((1n << 61n) | 8192n).toString();
  const f = fixture(JSON.stringify({ permission_overwrites: [
    { id: GUILD, type: 1, allow: '0', deny: '0' },
    { id: GUILD, type: 0, allow, deny },
  ] }));
  await f.service.execute(request('moderation.lockdown'));
  const original = { ...f.recovery! };
  f.setBody('{');
  await assert.rejects(() => f.service.execute(request('moderation.lockdown', 'bad-repeat')), invalidRead);
  assert.deepEqual(f.recovery, original);
  assert.equal(f.saved.length, 1, 'unreadable repeated lockdown cannot attempt a recovery write');
  assert.equal(f.mutations.length, 1);
  await f.service.execute(request('moderation.unlock'));
  assert.deepEqual(f.mutations, [
    { method: 'PUT', body: { type: 0, allow: (BigInt(allow) & ~2048n).toString(), deny: (BigInt(deny) | 2048n).toString() } },
    { method: 'PUT', body: { type: 0, allow, deny } },
  ]);
  assert.equal(f.recovery, null);
});

test('unlock without recovery also refuses an unreadable channel without mutation', async () => {
  const f = fixture('{}');
  await assert.rejects(() => f.service.execute(request('moderation.unlock')), invalidRead);
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.mutations, []);
});
