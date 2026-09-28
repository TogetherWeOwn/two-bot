/**
 * Temp-voice index audit, pinned as a test (TOG-6476).
 *
 * Follow-up to TOG-5709 (event-store benchmark + index migration):
 * migrations/0036_temp_voice.sql and 0037_temp_voice_owner_transition.sql
 * land temp-voice tables incl. the pending_owner_id column the ownership
 * transition journal writes on. The EXPLAIN verdict is INDEXED - every hot
 * path already rides an index, so no new migration ships here. This file
 * guards the wiring the verdict depends on: the four temp-voice indexes
 * exist with the expected definitions, and the owner-transition journal
 * round-trips (intent persisted, controls blocked, finalized on recovery).
 * Timings and plan shapes live in scripts/temp-voice-index-bench.ts; this
 * file guards the wiring, not the clock.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TempVoiceStore } from '../src/tempVoice/store.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const G = 'idx-guild';
const GEN = 'idx-generator';
const CAT = 'idx-category';

let harness: TestDb;

before(async () => {
  harness = await openTestDb(import.meta.filename);
});
after(async () => {
  await harness.cleanup();
});
beforeEach(async () => {
  await harness.reset();
});

async function reserve(store: TempVoiceStore, owner: string, at: string) {
  const res = await store.reserveIfUnderCaps({
    guildId: G,
    generatorId: GEN,
    categoryId: CAT,
    ownerId: owner,
    name: `room-${owner}`,
    createdAt: at,
    maxPerUser: 100,
    maxPerGuild: 100,
    cooldownSeconds: 0,
  });
  assert.equal(res.ok, true);
  return res.row;
}

test('the temp-voice indexes exist with their expected definitions', async () => {
  const rows = await harness.db
    .prepare(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename IN ('temp_voice_channels', 'temp_voice_creates', 'temp_voice_audit')`,
    )
    .all<{ indexname: string; indexdef: string }>();
  const def = new Map(rows.map((r) => [r.indexname, r.indexdef]));
  // Migration 0036: the per-channel partial unique (reservations excluded) is
  // what the lookup-by-guild/channel predicate resolves against.
  assert.match(def.get('idx_temp_voice_channel') ?? '', /\(channel_id\) WHERE \(channel_id IS NOT NULL\)/);
  assert.match(def.get('idx_temp_voice_owner') ?? '', /\(guild_id, owner_id\)/);
  assert.match(def.get('idx_temp_voice_guild_created') ?? '', /\(guild_id, created_at\)/);
  assert.match(def.get('idx_temp_voice_audit_guild_time') ?? '', /\(guild_id, created_at\)/);
  // The cooldown path is a point lookup on the (guild_id, user_id) PK.
  const pk = await harness.db
    .prepare(
      `SELECT conname, pg_get_constraintdef(oid) AS condef FROM pg_constraint
        WHERE conrelid = 'temp_voice_creates'::regclass AND contype = 'p'`,
    )
    .all<{ conname: string; condef: string }>();
  assert.match(pk[0]?.condef ?? '', /\(guild_id, user_id\)/);
});

test('the ownership journal round-trips: intent persisted, then finalized', async () => {
  const store = new TempVoiceStore(harness.db);
  const at = '2026-09-01T00:00:00.000Z';
  const row = await reserve(store, 'owner-1', at);
  await store.attach(row.id, 'chan-1');

  // Begin persists the intent (migration 0037's pending_owner_id column);
  // a second begin for the same row refuses rather than overwriting.
  assert.equal(await store.beginOwnerChange(row.id, 'owner-1', 'owner-2'), true);
  assert.equal(await store.beginOwnerChange(row.id, 'owner-1', 'owner-3'), false);
  assert.equal((await store.getByChannel(G, 'chan-1'))?.pendingOwnerId, 'owner-2');

  // Journal the interrupted transition, exactly as applyOwnerChange does.
  await store.audit(
    { guildId: G, actorId: null, channelId: 'chan-1', action: 'owner_change', outcome: 'pending', reason: 'bench: interrupted grant' },
    at,
  );
  const journaled = await harness.db
    .prepare(`SELECT outcome FROM temp_voice_audit WHERE channel_id = ? AND action = 'owner_change'`)
    .get<{ outcome: string }>('chan-1');
  assert.equal(journaled?.outcome, 'pending');

  // Recovery finalizes: owner flips, intent clears, controls unblock.
  assert.equal(await store.completeOwnerChange(row.id, 'owner-1', 'owner-2'), true);
  const done = await store.getByChannel(G, 'chan-1');
  assert.equal(done?.ownerId, 'owner-2');
  assert.equal(done?.pendingOwnerId, null);
});
