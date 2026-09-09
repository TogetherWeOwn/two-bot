import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, usingPostgres, type TestDb } from './helpers/testDb.ts';
import { DestructiveContainment } from '../src/moderation/containment.ts';
import { ContainmentStore } from '../src/moderation/containmentStore.ts';
import type { ContainmentConfig } from '../src/moderation/containmentConfig.ts';

const GUILD = '1545644954272137297';
const EXECUTOR = '111111111111111111';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

const config: ContainmentConfig = {
  enabled: true,
  dryRun: false,
  guildId: GUILD,
  botUserId: '1469137636663758888',
  protectedUserIds: new Set(),
  trustedUserIds: new Set(),
  alertChannelId: null,
  snapshotPath: null,
  windowSeconds: 60,
  heatThreshold: 5,
  eventMaxAgeSeconds: 120,
  joinRiskWindowSeconds: 60,
  joinRiskThreshold: 5,
  bulkJoinWindowUntil: null,
};

describe('Postgres containment concurrency', { skip: !usingPostgres && 'needs TWO_TEST_DATABASE_URL' }, () => {
  let harness: TestDb;
  before(async () => { harness = await openTestDb(import.meta.filename); });
  after(async () => harness.cleanup());
  beforeEach(async () => harness.reset());

  test('parallel threshold crossings produce exactly one quarantine', async () => {
    let quarantines = 0;
    const containment = new DestructiveContainment({
      store: new ContainmentStore(harness.db, () => NOW),
      discord: { quarantine: async () => (quarantines++, { removedRoleIds: ['danger'], skippedRoleIds: [] }) },
      config,
      announce: async () => undefined,
      now: () => NOW,
    });
    await Promise.all(Array.from({ length: 7 }, (_, index) => containment.observe({
      auditEntryId: `parallel-${index}`,
      guildId: GUILD,
      executorId: EXECUTOR,
      action: 'member.kick',
      targetId: `member-${index}`,
      occurredAt: new Date(NOW + index).toISOString(),
      weight: 1,
    })));
    assert.equal(quarantines, 1);
    const rows = await harness.db.prepare('SELECT state, heat FROM containment_incidents').all<{ state: string; heat: number }>();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'contained');
    assert.ok(rows[0].heat >= 5);
  });

  test('parallel bulk joins are counted atomically', async () => {
    const store = new ContainmentStore(harness.db, () => NOW);
    const rows = await Promise.all(Array.from({ length: 5 }, (_, index) => store.recordJoinRisk({
      eventId: `join-${index}`,
      guildId: GUILD,
      memberId: `member-${index}`,
      accountCreatedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
      joinedAt: new Date(NOW + index).toISOString(),
      source: 'unknown',
      accountScore: 1,
      accountReasons: ['account younger than 7 days'],
      bulkJoinWindow: false,
      windowSeconds: 60,
      joinThreshold: 5,
    })));
    assert.equal(rows.filter((row) => row.flagged).length, 1);
    const stored = await harness.db.prepare('SELECT score FROM join_risk_flags ORDER BY score').all<{ score: number }>();
    assert.deepEqual(stored.map((row) => row.score), [1, 1, 1, 1, 3]);
  });
});
