/**
 * TOG-7198: the moderation kill switch flipped mid-flow, proved by execution.
 *
 * PR #216 pins the static half: with `TWO_MODERATION` unset no verb is in the
 * allowlist and the boot wiring nulls the resolver, the service and every
 * downstream path. What it cannot show is the arc an operator actually runs:
 * traffic flowing, the switch flipped, every verb refusing, the switch
 * restored, every verb working again.
 *
 * There is no softer flip to test. `TWO_MODERATION` is `env_only`
 * (src/core/settingsCatalog.ts) and `loadModerationConfig()` runs once at
 * boot (src/index.ts), so "flip the switch mid-flow" is an environment edit
 * plus a restart. This file performs exactly that cycle in-process: boot the
 * live internal-actions endpoint with the slice on, drive all nine verbs
 * through signed HTTP, close it, reboot with the flag unset, and assert every
 * verb refuses with no Discord mutation - then reboot with it set and assert
 * all nine recover.
 *
 * Each boot mirrors src/index.ts: the enabled set comes from the real
 * `loadInternalActionsConfig` co-gate (so the flip is the actual env flag,
 * not a hand-built set), `actionsForOnboardingMode` is applied as boot
 * applies it, and the moderation dependency is the pair or null, as the
 * `moderationResolver && moderationService ? {...} : null` wiring demands.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadInternalActionsConfig } from '../src/internal/config.ts';
import { startInternalActions, type InternalServer } from '../src/internal/server.ts';
import { sign, KeyRing } from '../src/internal/signing.ts';
import { buildRoleKeys } from '../src/internal/actions.ts';
import { actionsForOnboardingMode } from '../src/onboarding/mode.ts';
import type { ActionDiscord } from '../src/internal/discordActions.ts';
import type { ModerationResolver } from '../src/moderation/resolver.ts';
import type { ModerationDiscordClient } from '../src/moderation/discord.ts';
import { ModerationService } from '../src/moderation/service.ts';
import { ModerationStore } from '../src/moderation/store.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { MODERATION_ACTIONS, type ModerationActionName } from '../src/moderation/types.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const SECRET = 'm'.repeat(48);
const KEY_ID = 'web-test';
const INTERNAL_KEYS = `${KEY_ID}:0123456789abcdef0123456789abcdef`;
const GUILD = '1545644954272137297';
const ACTOR = '900000000000000001';
const TARGET = '900000000000000002';
const OWEN = '900000000000000003';
const STAFF_ROLE = '900000000000000004';
const CHANNEL = '900000000000000005';

let db: TestDb;
const servers: InternalServer[] = [];

before(async () => { db = await openTestDb(import.meta.filename); });
beforeEach(async () => { await db.reset(); });
after(async () => {
  for (const server of servers) await server.close();
  await db.cleanup();
});

const noopDiscord: ActionDiscord = {
  async memberRoles() { return []; }, async addRole() {}, async addMember() { return 'added'; },
  async postMessage() { return 'message'; }, async createEvent() { return 'event'; }, async updateEvent() {},
  async cancelEvent() {},
};

function fixture() {
  const calls: string[] = [];
  const moderationDiscord: ModerationDiscordClient = {
    async ban(_g, u) { calls.push(`ban:${u}`); }, async unban() {},
    async kick(_g, u) { calls.push(`kick:${u}`); }, async timeout(_g, u) { calls.push(`timeout:${u}`); },
    async purge(_c, count) { calls.push(`purge:${count}`); return count; },
    async setSlowmode(_c, seconds) { calls.push(`slowmode:${seconds}`); },
    async getEveryoneOverwrite() { return { allow: '0', deny: '0' }; },
    async deleteEveryoneOverwrite() {},
    async putEveryoneOverwrite(_c, _g, ow) { calls.push(`overwrite:${ow.allow}/${ow.deny}`); },
  };
  const resolver: ModerationResolver = {
    async actor(_g, userId) { return { userId, roleIds: [], highestRolePosition: 10, permissions: ~0n }; },
    async target(_g, userId) {
      return { userId, roleIds: [], highestRolePosition: 1, isBot: false, isGuildOwner: false };
    },
    async channel(channelId) { return { channelId, type: 0 }; },
    async botHighestRolePosition() { return 20; },
  };
  const service = new ModerationService(moderationDiscord, new ModerationStore(db.db), {
    owenUserId: OWEN, botUserId: OWEN, protectedRoleIds: new Set([STAFF_ROLE]),
  });
  return { resolver, service, calls };
}

/**
 * Boot the endpoint the way src/index.ts does, with the kill switch either
 * set (`TWO_MODERATION=1`) or flipped off (unset). The enabled set is derived
 * from the real config co-gate, not hand-built, so dropping the co-gate
 * breaks this fixture the same way it would break the boot.
 */
async function startWithSwitch(moderationOn: boolean) {
  const cfg = loadInternalActionsConfig({
    TWO_INTERNAL_ACTIONS: '1',
    TWO_INTERNAL_KEYS: INTERNAL_KEYS,
    TWO_INTERNAL_ALLOW_MODERATION: '1',
    ...(moderationOn ? { TWO_MODERATION: '1' } : {}),
  } as NodeJS.ProcessEnv)!;
  const mod = fixture();
  const server = await startInternalActions({
    host: '127.0.0.1', port: 0, keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
    guildId: GUILD, discord: noopDiscord, roleKeys: buildRoleKeys(),
    enabled: actionsForOnboardingMode('legacy', cfg.enabled),
    store: new InternalActionStore(db.db),
    moderation: moderationOn ? { resolver: mod.resolver, service: mod.service } : null,
  });
  servers.push(server);
  return { server, calls: mod.calls };
}

function bodyFor(action: ModerationActionName): Record<string, unknown> {
  const base = { action, actor_id: ACTOR, reason: 'kill-switch flip QA' };
  switch (action) {
    case 'moderation.tempban':
    case 'moderation.timeout':
      return { ...base, target_id: TARGET, duration_seconds: 60 };
    case 'moderation.purge':
      return { ...base, channel_id: CHANNEL, count: 5 };
    case 'moderation.slowmode':
      return { ...base, channel_id: CHANNEL, seconds: 10 };
    case 'moderation.lockdown':
    case 'moderation.unlock':
      return { ...base, channel_id: CHANNEL };
    default:
      return { ...base, target_id: TARGET };
  }
}

const EXPECTED_OUTCOME: Record<ModerationActionName, string> = {
  'moderation.ban': 'banned',
  'moderation.tempban': 'temporarily_banned',
  'moderation.kick': 'kicked',
  'moderation.timeout': 'timed_out',
  'moderation.warn': 'warned',
  'moderation.purge': 'purged',
  'moderation.slowmode': 'slowmode_updated',
  'moderation.lockdown': 'locked_down',
  'moderation.unlock': 'unlocked',
};

async function call(server: InternalServer, action: ModerationActionName, tag: string) {
  const raw = Buffer.from(JSON.stringify(bodyFor(action)));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(server.url, {
    method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-two-key-id': KEY_ID, 'x-two-timestamp': timestamp,
      'x-two-nonce': nonce, 'x-two-signature': sign(SECRET, timestamp, nonce, raw),
      'idempotency-key': `flip-${tag}-${action.replace('moderation.', '')}-0001`,
    },
  });
  return { status: res.status, body: await res.json() as any };
}

test('the flip covers every verb: no silent tenth verb', () => {
  // Both the flip and PR #216 iterate MODERATION_ACTIONS, so a tenth verb
  // added to the product would pass both suites by never being exercised.
  // This fails closed: the new verb must be added to the flip cycle here.
  assert.equal(MODERATION_ACTIONS.length, 9);
});

test('mid-flow flip: all nine verbs refuse through the live endpoint after a disable restart', async () => {
  // Mid-flow evidence: with the switch on, every verb executes for real.
  const on = await startWithSwitch(true);
  for (const action of MODERATION_ACTIONS) {
    const res = await call(on.server, action, 'on');
    assert.equal(res.status, 200, `${action} must execute while the switch is on`);
    assert.equal(res.body.result.outcome, EXPECTED_OUTCOME[action]);
  }
  // Eight verbs reach Discord; warn is a database write, so its execution is
  // proved by the stored row instead. The rows lock the count at one per
  // verb: a duplicated side effect would show up here.
  assert.equal(on.calls.length, 8, 'every Discord-backed verb must have called Discord once while on');
  assert.equal(
    (await db.db.prepare('SELECT COUNT(*) AS n FROM moderation_warnings').get<{ n: number }>())?.n,
    1,
    'warn must have stored its row while on',
  );

  // The flip: same process, fresh boot, flag unset - the operator restart.
  await on.server.close();
  const off = await startWithSwitch(false);
  for (const action of MODERATION_ACTIONS) {
    // Full valid bodies, so the refusal is provably the gate, not the shape.
    const res = await call(off.server, action, 'off');
    assert.equal(res.status, 403, `${action} must refuse while the switch is off`);
    assert.equal(res.body.error.code, 'action_not_allowed');
    assert.equal(res.body.error.retryable, false);
    // The allowlist gate fires first (not the unwired-service fallback): the
    // message names the disabled verb, not an unconfigured dependency.
    assert.match(res.body.error.message, /not enabled on this bot/, `${action} must refuse at the allowlist gate`);
  }
  assert.deepEqual(off.calls, [], 'a refused verb must cause zero Discord calls');
  assert.equal(
    (await db.db.prepare('SELECT COUNT(*) AS n FROM moderation_warnings').get<{ n: number }>())?.n,
    1,
    'the refused warn must not have stored a second row while off',
  );
  await off.server.close();
});

test('re-enable: all nine verbs recover after the switch is restored', async () => {
  const on = await startWithSwitch(true);
  for (const action of MODERATION_ACTIONS) {
    const res = await call(on.server, action, 're');
    assert.equal(res.status, 200, `${action} must execute after re-enable`);
    assert.equal(res.body.result.outcome, EXPECTED_OUTCOME[action]);
  }
  // Eight Discord calls plus the warn row, as in the on-phase above.
  assert.equal(on.calls.length, 8, 'every Discord-backed verb must have called Discord once after re-enable');
  assert.equal(
    (await db.db.prepare('SELECT COUNT(*) AS n FROM moderation_warnings').get<{ n: number }>())?.n,
    1,
    'warn must have stored its row after re-enable',
  );
  await on.server.close();
});
