/**
 * Dashboard `--json` contract (TOG-7188).
 *
 * `npm run dashboard -- --json` prints the `DashboardData` object from
 * src/analytics/dashboard.ts. Anything downstream that parses that output
 * breaks silently when a key is renamed or removed, so this file pins the
 * exact key set and the type of every field on seeded data.
 *
 * It runs against an in-memory `Db` stub, deliberately - not Postgres - so the
 * contract is checked on every run, including environments without a database.
 * The arithmetic itself is covered by test/unit.dashboard.test.ts; what fails
 * here is a renamed key, a removed key, an added key nobody documented, or a
 * field whose type changed (number where null was possible, and so on).
 *
 * When you change `DashboardData`, update this file AND the `--json` section
 * of docs/DASHBOARD.md in the same commit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../src/analytics/dashboard.ts';
import { dashboardDb, assertDashboardGuildReads, type DashboardFixture, type DashboardRead } from './helpers/dashboardDbFixture.ts';
import type { Anomaly } from '../src/analytics/anomalies.ts';

const NOW = new Date('2026-03-02T12:00:00.000Z'); // a Monday
const GUILD = 'guild-123';

const SEED_ANOMALY: Anomaly = {
  id: 'test-raid',
  kind: 'raid',
  start: '2026-01-15',
  end: '2026-01-15',
  eventTypes: ['member_join'],
  status: 'confirmed',
  label: 'test raid with no seed joins inside it',
  note: 'kept clear of the seed weeks so only the shape is exercised',
};

// ---------------------------------------------------------------------------
// Seed rows. Every value below is asserted somewhere in this file, so a seed
// that stops reaching the output fails loudly instead of going stale.
// ---------------------------------------------------------------------------

const MEMBERS = [
  {
    member_id: 'a',
    joined_at: '2026-02-24T10:00:00.000Z',
    join_source: 'invite:promoAAA',
    gate_cleared_at: '2026-02-24T10:05:00.000Z',
    first_message_at: '2026-02-25T10:00:00.000Z',
    first_voice_at: null,
    last_active_at: '2026-03-01T00:00:00.000Z',
    left_at: null,
  },
  {
    member_id: 'b',
    joined_at: '2026-02-25T10:00:00.000Z',
    join_source: 'invite:promoAAA',
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: null,
    last_active_at: '2026-03-01T00:00:00.000Z',
    left_at: null,
  },
  // Joined before the gate was watched, left without clearing: unknowable.
  {
    member_id: 'c',
    joined_at: '2026-01-01T00:00:00.000Z',
    join_source: 'backfill:log:member-join',
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: null,
    last_active_at: null,
    left_at: '2026-01-10T00:00:00.000Z',
  },
  // Joined mid-February, left within the window: exercises leaves + cohorts.
  {
    member_id: 'd',
    joined_at: '2026-02-10T10:00:00.000Z',
    join_source: 'invite:promoAAA',
    gate_cleared_at: null,
    first_message_at: '2026-02-11T10:00:00.000Z',
    first_voice_at: null,
    last_active_at: '2026-02-12T00:00:00.000Z',
    left_at: '2026-02-26T00:00:00.000Z',
  },
  // Joined this week through the vanity URL.
  {
    member_id: 'e',
    joined_at: '2026-03-02T08:00:00.000Z',
    join_source: 'vanity',
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: '2026-03-02T09:00:00.000Z',
    last_active_at: '2026-03-02T09:00:00.000Z',
    left_at: null,
  },
];

const JOINS = [
  { member_id: 'a', occurred_at: '2026-02-24T10:00:00.000Z', source: 'invite:promoAAA' },
  { member_id: 'b', occurred_at: '2026-02-25T10:00:00.000Z', source: 'invite:promoAAA' },
  { member_id: 'c', occurred_at: '2026-01-01T00:00:00.000Z', source: 'backfill:log:member-join' },
  { member_id: 'd', occurred_at: '2026-02-10T10:00:00.000Z', source: 'invite:promoAAA' },
  { member_id: 'e', occurred_at: '2026-03-02T08:00:00.000Z', source: 'vanity' },
];

const LEAVES = [{ occurred_at: '2026-02-26T00:00:00.000Z' }];

const VOICE_ENDS = [
  { metadata: JSON.stringify({ startKnown: true, durationSeconds: 120 }) },
  { metadata: JSON.stringify({ startKnown: false, durationSeconds: 60 }) },
];

const CHANNEL_EVENTS = [
  { source: 'channel:5', occurred_at: '2026-02-27T10:00:00.000Z' },
  { source: 'channel:5', occurred_at: '2026-02-28T10:00:00.000Z' },
  { source: 'channel:9', occurred_at: '2026-02-20T10:00:00.000Z' },
];

const GATE_EVENTS = [
  // The live listener's first clearing: from 2026-02-24 on, a missing clearing
  // is a measurement. No backfill rows, so rosterCheckedAt stays null.
  { source: 'gateway', occurred_at: '2026-02-24T10:05:00.000Z', recorded_at: '2026-02-24T10:05:00.000Z' },
];

function seedFixture(guild = GUILD): DashboardFixture {
  const event = (event_type: string, row: Partial<DashboardFixture['events'][number]>) => ({
    id: 0, guild_id: guild, event_type, member_id: null,
    occurred_at: '2026-03-01T00:00:00.000Z', recorded_at: '2026-03-01T00:00:00.000Z',
    source: 'gateway', metadata: null, ...row,
  });
  return {
    members: MEMBERS.map((m) => ({ ...m, guild_id: guild, is_bot: false })),
    events: [
      ...JOINS.map((r) => event('member_join', r)),
      ...LEAVES.map((r) => event('member_leave', r)),
      ...VOICE_ENDS.map((r) => event('voice_session_end', r)),
      ...CHANNEL_EVENTS.map((r) => event('first_message', r)),
      ...GATE_EVENTS.map((r) => event('gate_cleared', r)),
    ].map((r, i) => ({ ...r, id: i + 1 })),
  };
}

function fakeDb(fixture = seedFixture(), reads: DashboardRead[] = []) {
  return dashboardDb(fixture, reads);
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

type Expect = 'string' | 'number' | 'boolean' | 'string|null' | 'number|null' | 'array' | 'object';

function checkType(value: unknown, expect: Expect, path: string): void {
  switch (expect) {
    case 'string':
      assert.equal(typeof value, 'string', `${path} should be a string`);
      return;
    case 'number':
      assert.equal(typeof value, 'number', `${path} should be a number`);
      return;
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${path} should be a boolean`);
      return;
    case 'string|null':
      assert.ok(typeof value === 'string' || value === null, `${path} should be a string or null`);
      return;
    case 'number|null':
      assert.ok(typeof value === 'number' || value === null, `${path} should be a number or null`);
      return;
    case 'array':
      assert.ok(Array.isArray(value), `${path} should be an array`);
      return;
    case 'object':
      assert.equal(typeof value, 'object', `${path} should be an object`);
      assert.notEqual(value, null, `${path} should not be null`);
      assert.ok(!Array.isArray(value), `${path} should be an object, not an array`);
      return;
  }
}

/** The object has exactly these keys - no renames, no removals, no additions. */
function assertKeys(value: unknown, expected: string[], path: string): void {
  checkType(value, 'object', path);
  assert.deepEqual(Object.keys(value as Record<string, unknown>).sort(), [...expected].sort(), `${path} keys changed`);
}

/** Every key present with the expected type; fails on additions too. */
function assertShape(value: unknown, spec: Record<string, Expect>, path: string): void {
  assertKeys(value, Object.keys(spec), path);
  for (const [key, expect] of Object.entries(spec)) {
    checkType((value as Record<string, unknown>)[key], expect, `${path}.${key}`);
  }
}

const RETENTION_CELL: Record<string, Expect> = { eligible: 'number', stayed: 'number', active: 'number' };
const GATE: Record<string, Expect> = {
  observed: 'number',
  cleared: 'number',
  stuck: 'number',
  leftAtTheGate: 'number',
  unknowable: 'number',
};

function assertRetentionCell(value: unknown, path: string): void {
  if (value === null) return; // unaged cohort: null, never zero
  assertShape(value, RETENTION_CELL, path);
}

function assertGate(value: unknown, path: string): void {
  if (value === null) return; // never observed: null, never 0%
  assertShape(value, GATE, path);
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('dashboard guild isolation', () => {
  const opts = { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] };

  test('a complete foreign mirror with colliding member IDs cannot change the target dashboard', async () => {
    const target = seedFixture();
    const foreign = seedFixture('foreign-guild');
    // A long foreign session changes the mean if the duration read is unscoped.
    foreign.events.find((e) => e.event_type === 'voice_session_end')!.metadata =
      JSON.stringify({ startKnown: true, durationSeconds: 86_400 });
    // Older live history turns target leavers from unknowable into measured.
    foreign.events.find((e) => e.event_type === 'gate_cleared')!.occurred_at =
      '2025-01-01T00:00:00.000Z';
    // Latest event must not relabel a target dashboard. Foreign roster reads
    // also must not make target gate state look observed.
    foreign.events.push({
      id: 10_000, guild_id: 'foreign-guild', event_type: 'gate_cleared', member_id: 'a',
      source: 'backfill:roster', occurred_at: NOW.toISOString(),
      recorded_at: NOW.toISOString(), metadata: null,
    });
    const baseline = await buildDashboard(fakeDb(target), opts);
    const reads: DashboardRead[] = [];
    const mixed = await buildDashboard(fakeDb({
      members: [...target.members, ...foreign.members],
      events: [...target.events, ...foreign.events],
    }, reads), opts);
    assert.deepEqual(mixed, baseline, 'every JSON field must be guild-invariant');
    assert.equal(mixed.guildId, GUILD);
    assert.equal(mixed.avgVoiceSessionSeconds, 120);
    assert.deepEqual(mixed.gateOverall, {
      observed: 3, cleared: 1, stuck: 2, leftAtTheGate: 0, unknowable: 2,
    });
    assertDashboardGuildReads(reads, GUILD);
  });

  test('foreign gate history alone cannot make an unwatched target gate observed', async () => {
    const target = seedFixture();
    target.events = target.events.filter((e) => e.event_type !== 'gate_cleared');
    target.members = target.members.map((m) => ({ ...m, gate_cleared_at: null }));
    const foreign = seedFixture('foreign-guild');
    foreign.events.push({ ...foreign.events.at(-1)!, id: 10_000, source: 'backfill:roster' });
    const baseline = await buildDashboard(fakeDb(target), opts);
    assert.equal(baseline.gateOverall, null);
    const mixed = await buildDashboard(fakeDb({
      members: target.members, events: [...target.events, ...foreign.events],
    }), opts);
    assert.deepEqual(mixed, baseline);
  });

  test('foreign-only data does not populate an empty target or override its snapshot census', async () => {
    const foreign = seedFixture('foreign-guild');
    for (const channelSnapshot of [null, {
      collected_at: NOW.toISOString(), channels: [], members: { human_members: 84 },
    }]) {
      const baseline = await buildDashboard(fakeDb({ members: [], events: [] }), { ...opts, channelSnapshot });
      const mixed = await buildDashboard(fakeDb(foreign), { ...opts, channelSnapshot });
      assert.deepEqual(mixed, baseline);
      assert.equal(mixed.guildId, GUILD);
      assert.equal(mixed.memberCountSource, channelSnapshot ? 'snapshot' : 'none');
    }
  });

  test('a trimmed guild is bound on every read', async () => {
    const reads: DashboardRead[] = [];
    const data = await buildDashboard(fakeDb(seedFixture(), reads), { ...opts, guildId: `  ${GUILD}\t` });
    assert.equal(data.guildId, GUILD);
    assertDashboardGuildReads(reads, GUILD);
  });

  for (const guildId of ['', ' \t\n ']) {
    test(`empty guild ${JSON.stringify(guildId)} refuses before preparing SQL`, async () => {
      const reads: DashboardRead[] = [];
      await assert.rejects(buildDashboard(fakeDb(seedFixture(), reads), { ...opts, guildId }), /guildId/);
      assert.deepEqual(reads, []);
    });
  }
});

describe('dashboard --json contract', () => {
  test('top-level keys and types are exactly the documented set', async () => {
    const d = await buildDashboard(fakeDb(), { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] });
    assertShape(d, {
      generatedAt: 'string',
      guildId: 'string|null',
      thisWeek: 'object',
      lastWeek: 'object',
      active7d: 'number',
      active30d: 'number',
      humansInServer: 'number',
      raidAccountsStillCounted: 'number',
      realHumans: 'number',
      memberCountSource: 'string',
      memberCountAsOf: 'string|null',
      joinedNeverSpoke: 'number',
      avgVoiceSessionSeconds: 'number|null',
      measuredVoiceSessions: 'number',
      excludedUnknownStarts: 'number',
      weeks: 'array',
      cohorts: 'array',
      retentionOverall: 'object',
      gateOverall: 'object',
      sourcesAllTime: 'array',
      channels: 'array',
      channelSnapshotAt: 'string|null',
      caveats: 'array',
      anomalies: 'array',
    }, 'dashboard');
  });

  test('headline numbers come from the seed', async () => {
    const d = await buildDashboard(fakeDb(), { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] });
    assert.equal(d.guildId, GUILD);
    assert.ok(!Number.isNaN(Date.parse(d.generatedAt)), 'generatedAt is an ISO instant');
    assert.deepEqual(d.thisWeek, { start: '2026-03-02', joins: 1, leaves: 0, net: 1 });
    assert.deepEqual(d.lastWeek, { start: '2026-02-23', joins: 2, leaves: 1, net: 1 });
    assert.equal(d.active7d, 3, 'a, b and e were active in the last 7 days');
    assert.equal(d.active30d, 3, 'leavers never count, even when recently active');
    assert.equal(d.humansInServer, 3);
    assert.equal(d.raidAccountsStillCounted, 0);
    assert.equal(d.realHumans, 3);
    assert.equal(d.memberCountSource, 'funnel');
    assert.equal(d.memberCountAsOf, null);
    assert.equal(d.joinedNeverSpoke, 1, 'only b never posted nor spoke');
    assert.equal(d.avgVoiceSessionSeconds, 120, 'the unknown-start 60s end is excluded, never averaged');
    assert.equal(d.measuredVoiceSessions, 1);
    assert.equal(d.excludedUnknownStarts, 1);
    assert.equal(d.channelSnapshotAt, null, 'no snapshot was passed');
  });

  test('weeks pin the per-week shape and the seed counts', async () => {
    const d = await buildDashboard(fakeDb(), { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] });
    assert.equal(d.weeks.length, 4);
    for (const w of d.weeks) {
      assertShape(w, {
        weekStart: 'string',
        joins: 'number',
        setAside: 'number',
        leaves: 'number',
        net: 'number',
        bySource: 'array',
      }, 'weeks[]');
      for (const s of w.bySource) {
        assertShape(s, { source: 'string', label: 'string', unattributed: 'boolean', joins: 'number' }, 'weeks[].bySource[]');
      }
    }
    const byWeek = new Map(d.weeks.map((w) => [w.weekStart, w]));
    assert.equal(byWeek.get('2026-02-23')!.joins, 2);
    assert.equal(byWeek.get('2026-02-23')!.leaves, 1);
    assert.equal(byWeek.get('2026-02-23')!.setAside, 0);
    assert.deepEqual(byWeek.get('2026-02-23')!.bySource.map((s) => s.label), ['Invite promoAAA']);
  });

  test('cohorts, retention and gate pin their nested shapes', async () => {
    const d = await buildDashboard(fakeDb(), { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] });
    assert.equal(d.cohorts.length, 4);
    for (const c of d.cohorts) {
      assertKeys(c, ['weekStart', 'size', 'd1', 'd7', 'd30', 'gate'], 'cohorts[]');
      assert.equal(typeof c.weekStart, 'string');
      assert.equal(typeof c.size, 'number');
      assertRetentionCell(c.d1, 'cohorts[].d1');
      assertRetentionCell(c.d7, 'cohorts[].d7');
      assertRetentionCell(c.d30, 'cohorts[].d30');
      assertGate(c.gate, 'cohorts[].gate');
    }
    assertKeys(d.retentionOverall, ['d1', 'd7', 'd30'], 'retentionOverall');
    assertRetentionCell(d.retentionOverall.d1, 'retentionOverall.d1');
    assertRetentionCell(d.retentionOverall.d7, 'retentionOverall.d7');
    assertRetentionCell(d.retentionOverall.d30, 'retentionOverall.d30');
    // a cleared, b + e stuck (joined while watched, still here), c + d unknowable.
    assert.deepEqual(d.gateOverall, { observed: 3, cleared: 1, stuck: 2, leftAtTheGate: 0, unknowable: 2 });
    // The seed's young cohort has no D30 yet: the field exists and is null.
    const young = d.cohorts.find((c) => c.weekStart === '2026-03-02')!;
    assert.equal(young.d30, null);
  });

  test('sources, channels, caveats and anomalies pin their shapes', async () => {
    const d = await buildDashboard(fakeDb(), {
      guildId: GUILD,
      now: NOW,
      weeks: 4,
      anomalies: [SEED_ANOMALY],
      channelSnapshot: {
        collected_at: '2026-03-01T00:00:00.000Z',
        channels: [
          { id: '5', name: 'general', parent_name: 'TWO', human_msgs_30d: 12, human_msgs_90d: 40, unique_humans_30d: 4, days_silent: 0 },
          { id: '6', name: 'ghost-town', parent_name: 'TWO', human_msgs_30d: 0, human_msgs_90d: 0, unique_humans_30d: 0, days_silent: 400 },
        ],
      },
    });
    for (const s of d.sourcesAllTime) {
      assertShape(s, { source: 'string', label: 'string', unattributed: 'boolean', joins: 'number' }, 'sourcesAllTime[]');
    }
    const labels = new Map(d.sourcesAllTime.map((s) => [s.label, s]));
    assert.equal(labels.get('Invite promoAAA')!.joins, 3);
    assert.equal(labels.get('Before tracking (imported history)')!.unattributed, true);
    assert.equal(labels.get('Vanity URL')!.joins, 1);

    assert.equal(d.channelSnapshotAt, '2026-03-01T00:00:00.000Z');
    for (const c of d.channels) {
      assertShape(c, {
        channelId: 'string',
        name: 'string',
        category: 'string|null',
        humanMsgs30d: 'number|null',
        humanMsgs90d: 'number|null',
        uniqueHumans30d: 'number|null',
        lastMessageAt: 'string|null',
        daysSilent: 'number|null',
        events30d: 'number',
        state: 'string',
      }, 'channels[]');
      assert.ok(c.state === 'alive' || c.state === 'quiet' || c.state === 'silent', `channels[].state is an enum, got ${c.state}`);
    }
    // Snapshot rows first by activity, then the events-only channel, then silent.
    assert.deepEqual(d.channels.map((c) => c.name), ['general', '#9', 'ghost-town']);
    assert.deepEqual(d.channels.map((c) => c.state), ['alive', 'alive', 'silent']);

    checkType(d.caveats, 'array', 'caveats');
    for (const c of d.caveats) assert.equal(typeof c, 'string', 'caveats[] should be strings');
    assert.ok(d.caveats.some((c) => c.includes('are in the server right now')), 'stuck members are named');

    assert.equal(d.anomalies.length, 1);
    assertShape(d.anomalies[0], {
      id: 'string',
      kind: 'string',
      start: 'string',
      end: 'string',
      eventTypes: 'array',
      status: 'string',
      label: 'string',
      note: 'string',
    }, 'anomalies[]');
    assert.equal(d.anomalies[0].id, 'test-raid');
  });

  test('the output survives a JSON round trip unchanged', async () => {
    const d = await buildDashboard(fakeDb(), { guildId: GUILD, now: NOW, weeks: 4, anomalies: [SEED_ANOMALY] });
    // This is the actual `--json` path: stringify on the host, parse downstream.
    // Anything non-serializable (undefined, functions) fails here, not in prod.
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  });
});
