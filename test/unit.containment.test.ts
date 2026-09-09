import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  AuditLogEvent,
  Events,
  type Client,
  type GuildAuditLogsEntry,
  type GuildMember,
} from 'discord.js';
import type { Db } from '../src/store/driver.ts';
import { ActionError } from '../src/internal/errors.ts';
import { openDb } from '../src/store/db.ts';
import {
  DestructiveContainment,
  JoinRiskScorer,
  auditEvent,
  registerContainment,
  type ContainmentAlert,
  type DestructiveAuditEvent,
  type JoinRiskAlert,
} from '../src/moderation/containment.ts';
import type { ContainmentConfig } from '../src/moderation/containmentConfig.ts';
import type { ContainmentDiscordClient } from '../src/moderation/containmentDiscord.ts';
import { ContainmentStore } from '../src/moderation/containmentStore.ts';

const GUILD = '1545644954272137297';
const EXECUTOR = '111111111111111111';
const BOT = '1469137636663758888';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function config(overrides: Partial<ContainmentConfig> = {}): ContainmentConfig {
  return {
    enabled: true,
    dryRun: false,
    guildId: GUILD,
    botUserId: BOT,
    protectedUserIds: new Set([BOT]),
    trustedUserIds: new Set(),
    alertChannelId: null,
    snapshotPath: null,
    windowSeconds: 60,
    heatThreshold: 5,
    eventMaxAgeSeconds: 120,
    joinRiskWindowSeconds: 60,
    joinRiskThreshold: 5,
    bulkJoinWindowUntil: null,
    ...overrides,
  };
}

function destructive(
  auditEntryId: string,
  action: 'member.kick' | 'channel.delete',
  occurredAt = NOW,
  executorId: string | null = EXECUTOR,
) {
  return {
    auditEntryId,
    guildId: GUILD,
    executorId,
    action,
    targetId: `target-${auditEntryId}`,
    occurredAt: new Date(occurredAt).toISOString(),
    weight: action === 'channel.delete' ? 3 : 1,
  } as const;
}

describe('destructive-action containment', () => {
  let db: Db;
  let store: ContainmentStore;

  before(async () => {
    db = await openDb(':memory:');
    store = new ContainmentStore(db, () => NOW);
  });
  after(async () => db.close());
  beforeEach(async () => {
    await db.exec('DELETE FROM containment_incidents; DELETE FROM containment_events; DELETE FROM join_risk_flags;');
  });

  test('claims audit ids and contains exactly once at the heat threshold', async () => {
    const calls: string[] = [];
    const alerts: ContainmentAlert[] = [];
    const discord: ContainmentDiscordClient = {
      quarantine: async (_guild, user) => {
        calls.push(user);
        return { removedRoleIds: ['role-1'], skippedRoleIds: [] };
      },
    };
    const containment = new DestructiveContainment({
      store,
      discord,
      config: config(),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });

    await containment.observe(destructive('a', 'channel.delete', NOW - 1_000));
    await containment.observe(destructive('b', 'member.kick', NOW - 500));
    assert.equal(calls.length, 0, 'heat 4 is below the threshold');
    await containment.observe(destructive('c', 'member.kick'));
    await containment.observe(destructive('c', 'member.kick'));

    assert.deepEqual(calls, [EXECUTOR]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outcome, 'contained');
    const incidents = await db.prepare('SELECT state, heat FROM containment_incidents').all<{ state: string; heat: number }>();
    assert.deepEqual(incidents.map((row) => ({ ...row })), [{ state: 'contained', heat: 5 }]);
  });

  test('concurrent audit entries serialize into one threshold crossing', async () => {
    if (db.kind !== 'postgres') return;
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config(),
      announce: async () => undefined,
      now: () => NOW,
    });
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      containment.observe(destructive(`parallel-${index}`, 'member.kick', NOW - index))));
    assert.equal(calls, 1);
  });

  test('different executors never share heat', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config(),
      announce: async () => undefined,
      now: () => NOW,
    });
    await containment.observe(destructive('a', 'channel.delete'));
    await containment.observe({ ...destructive('b', 'channel.delete'), executorId: '222222222222222222' });
    assert.equal(calls, 0);
  });

  test('stale, unknown, protected, and trusted executors are recorded but never contained', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config({
        protectedUserIds: new Set([BOT, EXECUTOR]),
        trustedUserIds: new Set(['222222222222222222']),
      }),
      announce: async () => undefined,
      now: () => NOW,
    });
    await containment.observe(destructive('stale', 'channel.delete', NOW - 121_000));
    await containment.observe(destructive('unknown', 'channel.delete', NOW, null));
    await containment.observe(destructive('protected', 'channel.delete'));
    await containment.observe({ ...destructive('trusted', 'channel.delete'), executorId: '222222222222222222' });
    assert.equal(calls, 0);
    const rows = await db.prepare('SELECT audit_entry_id, state FROM containment_events ORDER BY audit_entry_id').all<{ audit_entry_id: string; state: string }>();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { audit_entry_id: 'protected', state: 'ignored' },
      { audit_entry_id: 'stale', state: 'stale' },
      { audit_entry_id: 'trusted', state: 'ignored' },
      { audit_entry_id: 'unknown', state: 'ignored' },
    ]);
  });

  test('delayed audit entries outside the occurrence window do not add heat', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config({ heatThreshold: 5, windowSeconds: 60 }),
      announce: async () => undefined,
      now: () => NOW,
    });
    for (let index = 0; index < 4; index++) {
      await containment.observe(destructive(`old-${index}`, 'member.kick', NOW - 119_000 + index));
    }
    await containment.observe(destructive('fresh', 'member.kick', NOW));
    assert.equal(calls, 0);
  });

  test('reverse-delivered audit entries still trigger an occurrence-time threshold crossing', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config({ heatThreshold: 5, windowSeconds: 60 }),
      announce: async () => undefined,
      now: () => NOW,
    });
    await containment.observe(destructive('newest', 'channel.delete', NOW - 1_000));
    await containment.observe(destructive('middle', 'member.kick', NOW - 2_000));
    await containment.observe(destructive('oldest', 'member.kick', NOW - 3_000));
    assert.equal(calls, 1);
  });

  test('future audit entries are recorded but cannot contribute heat', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config({ heatThreshold: 5, windowSeconds: 60 }),
      announce: async () => undefined,
      now: () => NOW,
    });
    await containment.observe(destructive('future', 'channel.delete', NOW + 6_000));
    await containment.observe(destructive('fresh-a', 'member.kick', NOW));
    await containment.observe(destructive('fresh-b', 'member.kick', NOW - 1_000));
    assert.equal(calls, 0);
  });

  test('timeout is uncertain and never automatically retried', async () => {
    let calls = 0;
    const containment = new DestructiveContainment({
      store,
      discord: {
        quarantine: async () => {
          calls++;
          throw new ActionError('upstream_timeout', 'Discord timeout');
        },
      },
      config: config({ heatThreshold: 3 }),
      announce: async () => undefined,
      now: () => NOW,
    });
    await containment.observe(destructive('a', 'channel.delete'));
    await containment.observe(destructive('b', 'channel.delete'));
    assert.equal(calls, 1);
    const incident = await db.prepare('SELECT state FROM containment_incidents').get<{ state: string }>();
    assert.equal(incident?.state, 'uncertain');
  });

  test('a completed incident suppresses repeats only through its heat-window cooldown', async () => {
    let calls = 0;
    let clock = NOW;
    const containment = new DestructiveContainment({
      store: new ContainmentStore(db, () => clock),
      discord: { quarantine: async () => (calls++, { removedRoleIds: [], skippedRoleIds: [] }) },
      config: config({ heatThreshold: 3, windowSeconds: 1 }),
      announce: async () => undefined,
      now: () => clock,
    });
    await containment.observe(destructive('first', 'channel.delete', clock));
    await containment.observe(destructive('suppressed', 'channel.delete', clock + 500));
    assert.equal(calls, 1);
    clock += 2_000;
    await containment.observe(destructive('later', 'channel.delete', clock));
    assert.equal(calls, 2);
  });

  test('gateway wiring normalizes only destructive audit entries', async () => {
    const seen: string[] = [];
    const bus = new EventEmitter();
    registerContainment(
      bus as unknown as Client,
      { observe: async (event: DestructiveAuditEvent) => void seen.push(event.action) } as unknown as DestructiveContainment,
      GUILD,
    );
    const guild = { id: GUILD };
    bus.emit(Events.GuildAuditLogEntryCreate, {
      id: 'one',
      action: AuditLogEvent.ChannelDelete,
      executorId: EXECUTOR,
      targetId: 'channel',
      createdTimestamp: NOW,
    } as unknown as GuildAuditLogsEntry, guild);
    bus.emit(Events.GuildAuditLogEntryCreate, {
      id: 'two',
      action: AuditLogEvent.MessageDelete,
      executorId: EXECUTOR,
      targetId: 'message',
      createdTimestamp: NOW,
    } as unknown as GuildAuditLogsEntry, guild);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, ['channel.delete']);
  });

  test('audit normalization preserves executor, target, and Discord entry id', () => {
    const entry = {
      id: 'entry-1',
      action: AuditLogEvent.MemberBanAdd,
      executorId: EXECUTOR,
      targetId: 'member-1',
      createdTimestamp: NOW,
    } as unknown as GuildAuditLogsEntry;
    assert.deepEqual(auditEvent(entry, GUILD), {
      auditEntryId: 'entry-1',
      guildId: GUILD,
      executorId: EXECUTOR,
      action: 'member.ban',
      targetId: 'member-1',
      occurredAt: new Date(NOW).toISOString(),
      weight: 1,
    });
  });
});

describe('join risk is flag-only', () => {
  let db: Db;
  before(async () => { db = await openDb(':memory:'); });
  after(async () => db.close());
  beforeEach(async () => db.exec('DELETE FROM join_risk_flags'));

  function member(
    id: string,
    createdAt: number,
    joinedAt = NOW,
  ): Pick<GuildMember, 'id' | 'guild' | 'user' | 'joinedTimestamp'> {
    return {
      id,
      guild: { id: GUILD } as GuildMember['guild'],
      user: { bot: false, createdTimestamp: createdAt } as GuildMember['user'],
      joinedTimestamp: joinedAt,
    };
  }

  test('a new account is flagged and no mutation dependency exists', async () => {
    const alerts: JoinRiskAlert[] = [];
    const scorer = new JoinRiskScorer({
      store: new ContainmentStore(db, () => NOW),
      config: config(),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await scorer.observe(member('new', NOW - 60_000), 'unknown');
    assert.equal(alerts.length, 1);
    const row = await db.prepare('SELECT score, flagged, reasons_json FROM join_risk_flags').get<{ score: number; flagged: number; reasons_json: string }>();
    assert.equal(row?.score, 3);
    assert.equal(Boolean(row?.flagged), true);
    assert.match(row?.reasons_json ?? '', /younger than 24 hours/);
  });

  test('rejoins and a restart still contribute to the durable burst window', async () => {
    const alerts: JoinRiskAlert[] = [];
    const oldAccount = NOW - 30 * 24 * 60 * 60 * 1000;
    const first = new JoinRiskScorer({
      store: new ContainmentStore(db, () => NOW),
      config: config({ joinRiskThreshold: 2 }),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await first.observe(member('same', oldAccount, NOW - 1_000), 'unknown');
    const restarted = new JoinRiskScorer({
      store: new ContainmentStore(db, () => NOW),
      config: config({ joinRiskThreshold: 2 }),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await restarted.observe(member('same', oldAccount, NOW), 'unknown');
    const rows = await db.prepare('SELECT event_id, flagged FROM join_risk_flags ORDER BY joined_at').all<{ event_id: string; flagged: number }>();
    assert.equal(rows.length, 2, 'both join observations are durable');
    assert.equal(Boolean(rows[1].flagged), false, 'burst-only score 2 stays below the flag threshold');
  });

  test('bulk join window records risk but suppresses the flag', async () => {
    const alerts: JoinRiskAlert[] = [];
    const scorer = new JoinRiskScorer({
      store: new ContainmentStore(db, () => NOW),
      config: config({ bulkJoinWindowUntil: new Date(NOW + 60_000).toISOString() }),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await scorer.observe(member('purchased', NOW - 60_000), 'web_one_click');
    assert.deepEqual(alerts, []);
    const row = await db.prepare('SELECT flagged, bulk_join_window FROM join_risk_flags').get<{ flagged: number; bulk_join_window: number }>();
    assert.equal(Boolean(row?.flagged), false);
    assert.equal(Boolean(row?.bulk_join_window), true);
  });
});
