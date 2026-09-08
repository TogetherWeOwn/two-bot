import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { startInternalActions, type InternalServer } from '../src/internal/server.ts';
import { sign, KeyRing } from '../src/internal/signing.ts';
import { buildRoleKeys } from '../src/internal/actions.ts';
import type { ActionDiscord } from '../src/internal/discordActions.ts';
import type { ModerationResolver } from '../src/moderation/resolver.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import { ModerationService } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const SECRET = 'm'.repeat(48);
const ACTOR = '900000000000000001';
const TARGET = '900000000000000002';
const OWEN = '900000000000000003';
const STAFF_ROLE = '900000000000000004';
const CHANNEL = '900000000000000005';
let db: TestDb;
const servers: InternalServer[] = [];

before(async () => { db = await openTestDb(import.meta.filename); });
after(async () => {
  for (const server of servers) await server.close();
  await db.cleanup();
});

const noopDiscord: ActionDiscord = {
  async memberRoles() { return []; }, async addRole() {}, async addMember() { return 'added'; },
  async postMessage() { return 'message'; }, async createEvent() { return 'event'; }, async updateEvent() {},
};

function fixture(targetOver: Partial<Awaited<ReturnType<ModerationResolver['target']>>> = {}) {
  const calls: string[] = [];
  const moderationDiscord: ModerationDiscordClient = {
    async ban(_g, u) { calls.push(`ban:${u}`); }, async unban() {},
    async kick(_g, u) { calls.push(`kick:${u}`); }, async timeout(_g, u) { calls.push(`timeout:${u}`); },
    async purge(_c, count) { calls.push(`purge:${count}`); return count; },
    async setSlowmode(_c, seconds) { calls.push(`slowmode:${seconds}`); },
    async setLockdown(_c, _g, locked) { calls.push(locked ? 'lockdown' : 'unlock'); },
  };
  const resolver: ModerationResolver = {
    async actor(_g, userId) { return { userId, roleIds: [], highestRolePosition: 10, permissions: ~0n }; },
    async target(_g, userId) {
      return { userId, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false, ...targetOver };
    },
    async channel(channelId) { return { channelId, type: 0 }; },
    async botHighestRolePosition() { return 20; },
  };
  const store = new ModerationStore(db.db);
  const service = new ModerationService(moderationDiscord, store, {
    owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set([STAFF_ROLE]),
  });
  return { resolver, service, calls };
}

async function start(targetOver = {}) {
  const mod = fixture(targetOver);
  const server = await startInternalActions({
    host: '127.0.0.1', port: 0, keys: new KeyRing([{ id: 'web-staging', secret: SECRET }]),
    guildId: '1545644954272137297', discord: noopDiscord, roleKeys: buildRoleKeys(),
    enabled: new Set(['moderation.ban', 'moderation.tempban', 'moderation.kick', 'moderation.timeout',
      'moderation.warn', 'moderation.purge', 'moderation.slowmode', 'moderation.lockdown', 'moderation.unlock']),
    store: new InternalActionStore(db.db), moderation: { resolver: mod.resolver, service: mod.service },
  });
  servers.push(server);
  return { server, ...mod };
}

async function call(server: InternalServer, body: Record<string, unknown>, idempotencyKey = 'moderation-idem-0001') {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(server.url, {
    method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-two-key-id': 'web-staging', 'x-two-timestamp': timestamp,
      'x-two-nonce': nonce, 'x-two-signature': sign(SECRET, timestamp, nonce, raw), 'idempotency-key': idempotencyKey,
    },
  });
  return { status: res.status, replayed: res.headers.get('idempotent-replay'), body: await res.json() as any };
}

test('internal moderation action executes once and replays by idempotency key', async () => {
  const { server, calls } = await start();
  const body = { action: 'moderation.ban', actor_id: ACTOR, target_id: TARGET, reason: 'staging QA' };
  const first = await call(server, body);
  const second = await call(server, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.result.outcome, 'banned');
  assert.equal(second.status, 200);
  assert.equal(second.replayed, 'true');
  assert.deepEqual(calls, [`ban:${TARGET}`]);
});

test('mandatory reason refusal reaches no Discord mutation', async () => {
  const { server, calls } = await start();
  const res = await call(server, { action: 'moderation.kick', actor_id: ACTOR, target_id: TARGET });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'malformed');
  assert.deepEqual(calls, []);
});

test('protected bot and staff targets are refused before Discord', async () => {
  for (const over of [{ isBot: true }, { roleIds: [STAFF_ROLE] }]) {
    const { server, calls } = await start(over);
    const res = await call(server, {
      action: 'moderation.timeout', actor_id: ACTOR, target_id: TARGET,
      reason: 'staging QA', duration_seconds: 60,
    }, `protected-${JSON.stringify(over)}`.replace(/[^A-Za-z0-9._:-]/g, 'x'));
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'action_not_allowed');
    assert.deepEqual(calls, []);
  }
});

test('permission failure is typed and non-retryable', async () => {
  const { server, calls, resolver } = await start();
  resolver.actor = async (_g, userId) => ({ userId, roleIds: [], highestRolePosition: 10, permissions: PermissionFlagsBits.KickMembers });
  const res = await call(server, { action: 'moderation.ban', actor_id: ACTOR, target_id: TARGET, reason: 'staging QA' }, 'permission-failure-0001');
  assert.equal(res.status, 403);
  assert.equal(res.body.error.retryable, false);
  assert.deepEqual(calls, []);
});
