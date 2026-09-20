import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAllowed,
  runAction,
  type ActionContext,
} from '../src/internal/actions.ts';
import { SettingsStore } from '../src/core/settings.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const GUILD = '326474832151838730';
const ADMIN = '111111111111111111';

let testDb: TestDb;

before(async () => {
  testDb = await openTestDb(import.meta.filename);
});

after(async () => {
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.reset();
});

function ctx(): ActionContext {
  return {
    guildId: GUILD,
    discord: {} as ActionContext['discord'],
    roleKeys: new Map(),
    channelKeys: new Map(),
    enabled: new Set(['settings.set']),
    store: {} as ActionContext['store'],
    settings: new SettingsStore(testDb.db),
    idempotencyKey: '11111111-2222-4333-8444-555555555555',
  };
}

test('settings.set records the Filament actor and timestamp in the audit trail', async () => {
  const actionCtx = ctx();
  assertAllowed('settings.set', actionCtx);

  const outcome = await runAction(
    'settings.set',
    { key: 'TWO_ONBOARDING_DRY_RUN', value: true, updated_by: ADMIN },
    actionCtx,
  );

  assert.deepEqual(outcome.result, {
    key: 'TWO_ONBOARDING_DRY_RUN',
    outcome: 'saved',
  });

  const audit = await testDb.db
    .prepare(
      `SELECT old_value, new_value, actor, at
         FROM guild_settings_audit
        WHERE guild_id = ? AND key = ?`,
    )
    .get<{ old_value: unknown; new_value: unknown; actor: string; at: string }>(
      GUILD,
      'TWO_ONBOARDING_DRY_RUN',
    );

  assert.deepEqual(
    audit && {
      old_value: audit.old_value,
      new_value: audit.new_value,
      actor: audit.actor,
    },
    { old_value: null, new_value: true, actor: ADMIN },
  );
  assert.equal(typeof audit?.at, 'string');
  assert.ok(Number.isFinite(Date.parse(audit?.at ?? '')), 'the audit row must carry a timestamp');
});

test('settings.set validation failure writes no audit row', async () => {
  const actionCtx = ctx();
  assertAllowed('settings.set', actionCtx);

  await assert.rejects(
    () =>
      runAction(
        'settings.set',
        { key: 'TWO_ONBOARDING_DRY_RUN', value: true, updated_by: 'not-a-discord-id' },
        actionCtx,
      ),
    /must be a Discord id/,
  );

  const audit = await testDb.db
    .prepare(`SELECT count(*)::int AS n FROM guild_settings_audit`)
    .get<{ n: number }>();
  assert.equal(audit?.n, 0);
});
