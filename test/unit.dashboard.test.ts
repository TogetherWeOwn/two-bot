/**
 * The dashboard's arithmetic.
 *
 * This is the page the CEO makes decisions from, so the numbers are tested
 * rather than eyeballed. The failure modes that matter and are covered here:
 *
 *   - a cohort that has not aged 30 days reads as 0% instead of "not yet"
 *   - a raid lands in the retention denominator and makes the community look
 *     three times worse than it is
 *   - backfilled joins get counted as a real invite source
 *   - "active" counts somebody who joined and left without ever speaking
 *   - week boundaries drift, so a join lands in the wrong week
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import {
  buildDashboard,
  channelState,
  countBySource,
  gateConversion,
  labelSource,
  recentWeeks,
  retentionAt,
  weekStart,
  type MemberRow,
} from '../src/analytics/dashboard.ts';
import { renderHtml } from '../src/analytics/render.ts';
import type { Anomaly } from '../src/analytics/anomalies.ts';

const GUILD = '999';
const NOW = new Date('2026-03-02T12:00:00.000Z'); // a Monday

// One raid day, so the exclusion path is exercised without depending on the
// real ANOMALIES list (which will keep growing).
// The cast is deliberate: anomalies.ts grows fields (`kind` arrived with the
// raid watcher) and this fixture only cares about the window. Without it every
// new field breaks a test that has nothing to do with it.
const TEST_ANOMALIES: Anomaly[] = [
  {
    id: 'test-raid',
    kind: 'raid',
    start: '2026-02-04',
    end: '2026-02-04',
    eventTypes: ['member_join'],
    status: 'confirmed',
    label: 'test raid',
    note: '',
  } as Anomaly,
];

let t: TestDb;
before(async () => {
  t = await openTestDb(import.meta.filename);
});
after(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.reset();
});

// ---------------------------------------------------------------------------
// Pure arithmetic - no database needed
// ---------------------------------------------------------------------------

test('a week starts on Monday, and the boundary does not drift', () => {
  assert.equal(weekStart('2026-03-02T00:00:00.000Z'), '2026-03-02'); // Monday
  assert.equal(weekStart('2026-03-08T23:59:59.999Z'), '2026-03-02'); // Sunday, same week
  assert.equal(weekStart('2026-03-09T00:00:00.000Z'), '2026-03-09'); // next Monday
  assert.equal(weekStart('2026-03-01T12:00:00.000Z'), '2026-02-23'); // Sunday, previous week
});

test('recentWeeks ends with the week we are in and runs backwards', () => {
  const w = recentWeeks(new Date('2026-03-04T09:00:00.000Z'), 3);
  assert.deepEqual(w, ['2026-02-16', '2026-02-23', '2026-03-02']);
});

test('anything the backfill wrote is marked unattributable, not counted as a source', () => {
  assert.deepEqual(labelSource('backfill:log:member-join'), {
    label: 'Before tracking (imported history)',
    unattributed: true,
  });
  assert.deepEqual(labelSource(null), { label: 'Unknown', unattributed: true });
  assert.deepEqual(labelSource('unknown'), { label: 'Unknown', unattributed: true });
  assert.deepEqual(labelSource('invite:aB3xY9'), { label: 'Invite aB3xY9', unattributed: false });
  assert.deepEqual(labelSource('vanity'), { label: 'Vanity URL', unattributed: false });
});

test('sources come back biggest first', () => {
  const counts = countBySource(['invite:a', 'invite:b', 'invite:a', null, 'invite:a']);
  assert.deepEqual(
    counts.map((c) => [c.source, c.joins]),
    [
      ['invite:a', 3],
      ['invite:b', 1],
      ['unknown', 1],
    ],
  );
  assert.equal(counts[2].unattributed, true);
});

test('a cohort that has not aged that far is null, not zero', () => {
  const m: MemberRow[] = [
    {
      member_id: '1',
      joined_at: '2026-03-01T00:00:00.000Z', // 1.5 days before NOW
      join_source: null,
      gate_cleared_at: null,
      first_message_at: null,
      first_voice_at: null,
      last_active_at: null,
      left_at: null,
    },
  ];
  assert.equal(retentionAt(m, 30, NOW), null, 'D30 cannot be known yet');
  assert.equal(retentionAt(m, 7, NOW), null, 'D7 cannot be known yet');
  assert.deepEqual(retentionAt(m, 1, NOW), { eligible: 1, stayed: 1, active: 0 });
});

test('stayed and active are different numbers, and both are counted honestly', () => {
  const base = {
    join_source: null,
    gate_cleared_at: null,
    first_message_at: null,
    first_voice_at: null,
  };
  const members: MemberRow[] = [
    // joined, still here, spoke well after D7 -> stayed AND active
    { member_id: 'a', joined_at: '2026-01-01T00:00:00.000Z', last_active_at: '2026-02-01T00:00:00.000Z', left_at: null, ...base },
    // joined, still here, never spoke -> stayed, not active
    { member_id: 'b', joined_at: '2026-01-01T00:00:00.000Z', last_active_at: null, left_at: null, ...base },
    // joined and left on day 3 -> not stayed at D7
    { member_id: 'c', joined_at: '2026-01-01T00:00:00.000Z', last_active_at: null, left_at: '2026-01-04T00:00:00.000Z', ...base },
    // spoke on day 2 then left on day 4: active at D1, not at D7
    { member_id: 'd', joined_at: '2026-01-01T00:00:00.000Z', last_active_at: '2026-01-03T00:00:00.000Z', left_at: '2026-01-05T00:00:00.000Z', ...base },
  ];
  assert.deepEqual(retentionAt(members, 1, NOW), { eligible: 4, stayed: 4, active: 2 });
  assert.deepEqual(retentionAt(members, 7, NOW), { eligible: 4, stayed: 2, active: 1 });
});

// --- the rules gate --------------------------------------------------------
//
// The trap this guards is a confident 0%. Every one of these members has a null
// gate_cleared_at, and what that null MEANS is entirely decided by whether
// anybody was watching - which is the difference between "nobody is getting in"
// and "we are not measuring".

const gateMember = (o: Partial<MemberRow> & { member_id: string }): MemberRow => ({
  joined_at: '2026-01-01T00:00:00.000Z',
  join_source: null,
  gate_cleared_at: null,
  first_message_at: null,
  first_voice_at: null,
  last_active_at: null,
  left_at: null,
  ...o,
});

test('gate conversion is null when nobody ever watched the gate', () => {
  const members = [gateMember({ member_id: 'a' }), gateMember({ member_id: 'b' })];
  assert.equal(
    gateConversion(members, null, null),
    null,
    'no clearing observed and no roster read is not 0% conversion',
  );
});

test('a roster read makes a missing clearing mean "stuck", for everyone still here', () => {
  const members = [
    gateMember({ member_id: 'in', gate_cleared_at: '2026-01-01T00:05:00.000Z' }),
    gateMember({ member_id: 'stuck' }),
    // joined long before anything was watching, and left. Unknowable, because
    // the roster read can only see people who are still on it.
    gateMember({ member_id: 'gone', left_at: '2026-01-09T00:00:00.000Z' }),
  ];
  assert.deepEqual(gateConversion(members, null, '2026-08-19T00:00:00.000Z'), {
    observed: 2,
    cleared: 1,
    stuck: 1,
    leftAtTheGate: 0,
    unknowable: 1,
  });
});

test('somebody who joined while we were watching and left without clearing is counted, not lost', () => {
  const since = '2026-02-01T00:00:00.000Z';
  const members = [
    gateMember({ member_id: 'before', joined_at: '2026-01-01T00:00:00.000Z', left_at: '2026-01-10T00:00:00.000Z' }),
    gateMember({ member_id: 'after', joined_at: '2026-02-10T00:00:00.000Z', left_at: '2026-02-12T00:00:00.000Z' }),
  ];
  const g = gateConversion(members, since, null)!;
  assert.equal(g.leftAtTheGate, 1, 'the one whose whole tenure we saw');
  assert.equal(g.unknowable, 1, 'the one who predates the listener');
  assert.equal(g.observed, 1, 'and only the measured one is in the denominator');
});

test('members with no join date at all are not a gate conversion of 0%', () => {
  const members = [gateMember({ member_id: 'x', joined_at: null })];
  assert.equal(gateConversion(members, '2026-01-01T00:00:00.000Z', null), null);
});

test('channel state needs a human, not just a funnel event', () => {
  assert.equal(channelState({ humanMsgs30d: 4, humanMsgs90d: 9, events30d: 0 }), 'alive');
  assert.equal(channelState({ humanMsgs30d: 0, humanMsgs90d: 9, events30d: 0 }), 'quiet');
  assert.equal(channelState({ humanMsgs30d: 0, humanMsgs90d: 0, events30d: 0 }), 'silent');
  // the snapshot can be stale; a live event still counts as a sign of life
  assert.equal(channelState({ humanMsgs30d: 0, humanMsgs90d: 0, events30d: 2 }), 'alive');
});

// ---------------------------------------------------------------------------
// End to end against a real database
// ---------------------------------------------------------------------------

let seq = 0;
async function join(memberId: string, at: string, source: string) {
  await t.db
    .prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, recorded_at, source, idempotency_key)
       VALUES ('member_join', ?, ?, ?, ?, ?, ?)`,
    )
    .run(memberId, GUILD, at, at, source, `k${seq++}`);
}
async function member(m: Partial<MemberRow> & { member_id: string }, isBot = 0) {
  await t.db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, join_source, gate_cleared_at,
                            first_message_at, first_voice_at, last_active_at, left_at, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      GUILD,
      m.member_id,
      m.joined_at ?? null,
      m.join_source ?? null,
      m.gate_cleared_at ?? null,
      m.first_message_at ?? null,
      m.first_voice_at ?? null,
      m.last_active_at ?? null,
      m.left_at ?? null,
      isBot,
    );
}

test('a raid never reaches the headline numbers, and is never deleted either', async () => {
  // 3 real joins in the raid week, plus 50 raid accounts on the raid day.
  for (let i = 0; i < 3; i++) {
    const at = `2026-02-05T1${i}:00:00.000Z`;
    await join(`real${i}`, at, 'invite:good');
    await member({ member_id: `real${i}`, joined_at: at, last_active_at: '2026-03-01T00:00:00.000Z' });
  }
  for (let i = 0; i < 50; i++) {
    const at = `2026-02-04T20:0${i % 10}:00.000Z`;
    await join(`raid${i}`, at, 'unknown');
    await member({ member_id: `raid${i}`, joined_at: at });
  }

  const d = await buildDashboard(t.db, { now: NOW, weeks: 6, anomalies: TEST_ANOMALIES });
  const raidWeek = d.weeks.find((w) => w.weekStart === '2026-02-02')!;

  assert.equal(raidWeek.joins, 3, 'only the real joins count');
  assert.equal(raidWeek.setAside, 50, 'the raid is reported, on its own line');
  assert.equal(d.raidAccountsStillCounted, 50, 'and named in the member total');
  assert.equal(d.realHumans, 3);
  assert.equal(d.humansInServer, 53, 'because Discord still shows all 53');

  // The retention denominator is the thing a raid quietly destroys.
  assert.equal(d.retentionOverall.d7!.eligible, 3);
  assert.equal(d.retentionOverall.d7!.active, 3);

  // Nothing was deleted.
  const total = await t.db.prepare(`SELECT COUNT(*) AS n FROM events`).get<{ n: number }>();
  assert.equal(Number(total!.n), 53);
});

async function gateCleared(memberId: string, at: string, source = 'gateway') {
  await t.db
    .prepare(
      `INSERT INTO events (event_type, member_id, guild_id, occurred_at, recorded_at, source, idempotency_key)
       VALUES ('gate_cleared', ?, ?, ?, ?, ?, ?)`,
    )
    .run(memberId, GUILD, at, at, source, `k${seq++}`);
}

test('the gate number reaches the page, and a backfilled row does not fake a start date', async () => {
  // Two members joined the same week. One cleared, one is still at the door.
  // Both predate the live listener, so only the backfill's roster read makes
  // the second one's missing clearing mean anything.
  for (const [id, cleared] of [
    ['in', true],
    ['stuck', false],
  ] as const) {
    const at = '2026-02-24T10:00:00.000Z';
    await join(id, at, 'invite:good');
    await member({
      member_id: id,
      joined_at: at,
      gate_cleared_at: cleared ? at : null,
      last_active_at: '2026-03-01T00:00:00.000Z',
    });
    if (cleared) await gateCleared(id, at, 'backfill:member_list');
  }

  const d = await buildDashboard(t.db, { now: NOW, weeks: 4, anomalies: TEST_ANOMALIES });
  assert.deepEqual(d.gateOverall, {
    observed: 2,
    cleared: 1,
    stuck: 1,
    leftAtTheGate: 0,
    unknowable: 0,
  });
  assert.ok(
    d.caveats.some((c) => c.includes('are in the server right now')),
    'the stuck member is named as an action, not just a percentage',
  );

  const html = renderHtml(d);
  assert.ok(html.includes('Got in'), 'the cohort table carries the gate column');
  assert.ok(html.includes('50%'), 'and the headline conversion is on the page');
});

test('bots are not members, and never land in a cohort', async () => {
  await join('human', '2026-02-24T10:00:00.000Z', 'invite:good');
  await member({ member_id: 'human', joined_at: '2026-02-24T10:00:00.000Z' });
  await join('botty', '2026-02-24T11:00:00.000Z', 'invite:good');
  await member({ member_id: 'botty', joined_at: '2026-02-24T11:00:00.000Z' }, 1);

  const d = await buildDashboard(t.db, { now: NOW, weeks: 4, anomalies: TEST_ANOMALIES });
  assert.equal(d.weeks.find((w) => w.weekStart === '2026-02-23')!.joins, 1);
  assert.equal(d.humansInServer, 1);
  assert.equal(d.cohorts.find((c) => c.weekStart === '2026-02-23')!.size, 1);
});

test('active means the last 7 days, and leavers do not count as active', async () => {
  await member({
    member_id: 'here',
    joined_at: '2026-01-01T00:00:00.000Z',
    first_message_at: '2026-01-02T00:00:00.000Z',
    last_active_at: '2026-03-01T00:00:00.000Z',
  });
  // active recently, but we never caught a first message or voice session for
  // them - the backfill gap. They still count as never-spoke until we do.
  await member({ member_id: 'stale', joined_at: '2026-01-01T00:00:00.000Z', last_active_at: '2026-02-01T00:00:00.000Z' });
  await member({
    member_id: 'gone',
    joined_at: '2026-01-01T00:00:00.000Z',
    last_active_at: '2026-03-01T00:00:00.000Z',
    left_at: '2026-03-01T06:00:00.000Z',
  });
  await member({ member_id: 'lurker', joined_at: '2026-01-01T00:00:00.000Z' });

  const d = await buildDashboard(t.db, { now: NOW, weeks: 4, anomalies: TEST_ANOMALIES });
  assert.equal(d.active7d, 1, 'only "here"');
  assert.equal(d.active30d, 2, '"here" and "stale"');
  assert.equal(d.joinedNeverSpoke, 2, '"stale" has no first message/voice recorded, and "lurker"');
});

test('this week counts [weekStart, generatedAt), never exactly-now or future events', async () => {
  const now = new Date('2026-09-30T12:00:00.000Z'); // Wednesday: tomorrow is in the same week.
  const boundaries = [
    ['previous-week', '2026-09-27T23:59:59.999Z'],
    ['week-start', '2026-09-28T00:00:00.000Z'],
    ['just-before-now', '2026-09-30T11:59:59.999Z'],
    ['exactly-now', now.toISOString()],
    ['future', '2026-10-01T12:00:00.000Z'],
  ] as const;
  for (const [id, at] of boundaries) {
    await member({ member_id: id, joined_at: at });
    await join(id, at, `invite:${id}`);
    await t.db
      .prepare(
        `INSERT INTO events (event_type, member_id, guild_id, occurred_at, recorded_at, source, idempotency_key)
         VALUES ('member_leave', ?, ?, ?, ?, 'gateway', ?)`,
      )
      .run(id, GUILD, at, at, `k${seq++}`);
  }

  const d = await buildDashboard(t.db, {
    now,
    weeks: 2,
    anomalies: [{ ...TEST_ANOMALIES[0], start: '2026-10-01', end: '2026-10-01' }],
  });
  assert.equal(d.generatedAt, now.toISOString());
  assert.deepEqual(d.thisWeek, { start: '2026-09-28', joins: 2, leaves: 2, net: 0 });
  assert.deepEqual(d.lastWeek, { start: '2026-09-21', joins: 1, leaves: 1, net: 0 });
  assert.equal(d.weeks[1].setAside, 0, 'future raid joins are not observations yet either');
  assert.deepEqual(
    d.weeks[1].bySource.map((s) => s.source).sort(),
    ['invite:just-before-now', 'invite:week-start'],
  );
});

test('rolling activity includes its lower bounds and excludes generatedAt and future rows', async () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  const boundaries = [
    '2026-08-31T11:59:59.999Z', // before the 30-day window
    '2026-08-31T12:00:00.000Z', // 30-day lower bound
    '2026-09-23T11:59:59.999Z', // before the 7-day window, within 30 days
    '2026-09-23T12:00:00.000Z', // 7-day lower bound
    '2026-09-30T11:59:59.999Z',
    now.toISOString(),
    '2026-10-01T12:00:00.000Z',
  ];
  for (const [i, at] of boundaries.entries()) {
    await member({ member_id: `active-${i}`, joined_at: '2026-01-01T00:00:00.000Z', last_active_at: at });
  }

  const d = await buildDashboard(t.db, { now, anomalies: [] });
  assert.equal(d.active7d, 2, '7-day lower bound and now-1ms');
  assert.equal(d.active30d, 4, '30-day lower bound, both 7-day boundaries, and now-1ms');
  assert.equal(d.humansInServer, boundaries.length, 'membership state is not reconstructed');
});

for (const [label, advancedAt] of [
  ['exactly-now', '2026-09-30T12:00:00.000Z'],
  ['future', '2026-10-01T12:00:00.000Z'],
] as const) {
  test(`${label} last activity does not hide earlier in-window message or voice evidence`, async () => {
    const now = new Date('2026-09-30T12:00:00.000Z');
    const recent = '2026-09-29T12:00:00.000Z';
    const since30 = '2026-08-31T12:00:00.000Z';
    const stale = '2026-08-31T11:59:59.999Z';
    const fixtures: Array<Partial<MemberRow> & { member_id: string }> = [
      { member_id: 'recent-message', first_message_at: recent, last_active_at: recent },
      { member_id: 'recent-voice', first_voice_at: recent, last_active_at: recent },
      { member_id: 'both', first_message_at: recent, first_voice_at: recent, last_active_at: recent },
      { member_id: 'month-message', first_message_at: since30, last_active_at: since30 },
      { member_id: 'month-voice', first_voice_at: since30, last_active_at: since30 },
      { member_id: 'stale', first_message_at: stale, first_voice_at: stale, last_active_at: stale },
      { member_id: 'no-earlier-evidence' },
      { member_id: 'future-only', first_message_at: advancedAt, first_voice_at: advancedAt },
      { member_id: 'gone', first_message_at: recent, last_active_at: recent, left_at: recent },
    ];
    for (const fixture of fixtures) {
      await member({ joined_at: '2026-01-01T00:00:00.000Z', ...fixture });
    }
    await member({ member_id: 'bot', first_message_at: recent, last_active_at: recent }, 1);

    const before = await buildDashboard(t.db, { now, anomalies: [] });
    assert.equal(before.active7d, 3);
    assert.equal(before.active30d, 5);

    const store = new EventStore(t.db);
    for (const id of [...fixtures.map((m) => m.member_id), 'bot']) {
      await store.touchActivity(GUILD, id, advancedAt);
    }
    const after = await buildDashboard(t.db, { now, anomalies: [] });
    assert.equal(after.active7d, 3, 'earlier message/voice evidence survives; each human counts once');
    assert.equal(after.active30d, 5, '30-day lower-bound evidence survives too');
    assert.equal(after.humansInServer, before.humansInServer, 'membership state stays unchanged');
  });
}

for (const eventType of ['third_message', 'voice_session_start', 'voice_session_end'] as const) {
  for (const [label, advancedAt] of [
    ['exactly-now', '2026-09-30T12:00:00.000Z'],
    ['future', '2026-10-01T12:00:00.000Z'],
  ] as const) {
    test(`returning member ${eventType} evidence survives ${label} last activity`, async () => {
      const now = new Date('2026-09-30T12:00:00.000Z');
      const old = '2026-01-01T12:00:00.000Z';
      const recent = '2026-09-29T12:00:00.000Z';
      await member({
        member_id: 'returning', joined_at: old, first_message_at: old,
        first_voice_at: old, last_active_at: recent,
      });
      const store = new EventStore(t.db);
      await store.record({ guildId: GUILD, memberId: 'returning', eventType, occurredAt: recent, source: 'channel:tracked' });
      const before = await buildDashboard(t.db, { now, anomalies: [] });
      assert.deepEqual([before.active7d, before.active30d], [1, 1]);

      await store.touchActivity(GUILD, 'returning', advancedAt);
      const after = await buildDashboard(t.db, { now, anomalies: [] });
      assert.deepEqual([after.active7d, after.active30d], [1, 1], 'retained recent activity still counts');
    });
  }
}

test('retained activity events respect rolling bounds, human membership and deduplication', async () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  const old = '2026-01-01T12:00:00.000Z';
  const future = '2026-10-01T12:00:00.000Z';
  const boundaries = [
    ['stale', '2026-08-31T11:59:59.999Z'],
    ['month-start', '2026-08-31T12:00:00.000Z'],
    ['before-week', '2026-09-23T11:59:59.999Z'],
    ['week-start', '2026-09-23T12:00:00.000Z'],
    ['now-minus-ms', '2026-09-30T11:59:59.999Z'],
    ['exactly-now', now.toISOString()],
    ['future', future],
  ] as const;
  const store = new EventStore(t.db);
  for (const [id, at] of boundaries) {
    await member({ member_id: id, joined_at: old, first_message_at: old, first_voice_at: old, last_active_at: future });
    for (const eventType of ['third_message', 'voice_session_start', 'voice_session_end'] as const) {
      await store.record({ guildId: GUILD, memberId: id, eventType, occurredAt: at, source: 'channel:tracked' });
    }
  }
  for (const [id, isBot, leftAt] of [['bot', 1, null], ['gone', 0, old]] as const) {
    await member({ member_id: id, joined_at: old, first_message_at: old, last_active_at: future, left_at: leftAt }, isBot);
    await store.record({ guildId: GUILD, memberId: id, eventType: 'third_message', occurredAt: '2026-09-29T12:00:00.000Z', source: 'channel:tracked' });
  }
  await member({ member_id: 'gate-only', joined_at: old, last_active_at: future });
  await gateCleared('gate-only', '2026-09-29T12:00:00.000Z');
  await store.record({ guildId: GUILD, memberId: null, eventType: 'voice_session_start', occurredAt: '2026-09-29T12:00:00.000Z', source: 'channel:tracked' });

  const d = await buildDashboard(t.db, { now, anomalies: [] });
  assert.equal(d.active7d, 2, '7-day lower bound and now-1ms, each human once');
  assert.equal(d.active30d, 4, '30-day lower bound through now-1ms');
});

test('channel events count [now-30d, generatedAt) for snapshot and live-only channels', async () => {
  const now = new Date('2026-09-30T12:00:00.000Z');
  for (const at of [
    '2026-08-31T11:59:59.999Z',
    '2026-08-31T12:00:00.000Z',
    '2026-09-30T11:59:59.999Z',
    now.toISOString(),
    '2026-10-01T12:00:00.000Z',
  ]) {
    await gateCleared('channel-member', at, 'channel:tracked');
  }
  for (const at of [now.toISOString(), '2026-10-01T12:00:00.000Z']) {
    await gateCleared('channel-member', at, 'channel:future-snapshot');
    await gateCleared('channel-member', at, 'channel:future-only');
  }
  await gateCleared('channel-member', '2026-09-30T11:59:59.999Z', 'channel:live-only');

  const d = await buildDashboard(t.db, {
    now,
    anomalies: [],
    channelSnapshot: {
      collected_at: now.toISOString(),
      channels: [
        { id: 'tracked', name: 'tracked', human_msgs_30d: 0, human_msgs_90d: 0 },
        { id: 'future-snapshot', name: 'future-snapshot', human_msgs_30d: 0, human_msgs_90d: 0 },
      ],
    },
  });
  assert.equal(d.channels.find((c) => c.channelId === 'tracked')!.events30d, 2);
  const futureSnapshot = d.channels.find((c) => c.channelId === 'future-snapshot')!;
  assert.equal(futureSnapshot.events30d, 0);
  assert.equal(futureSnapshot.state, 'silent', 'future events cannot make a quiet channel alive');
  assert.equal(d.channels.find((c) => c.channelId === 'live-only')!.events30d, 1);
  assert.equal(d.channels.some((c) => c.channelId === 'future-only'), false);
});

test('with no joins at all the page still renders, and says nothing rather than zero', async () => {
  const d = await buildDashboard(t.db, { now: NOW, weeks: 4, anomalies: TEST_ANOMALIES });
  assert.equal(d.thisWeek.joins, 0);
  assert.equal(d.retentionOverall.d7, null, 'no cohort at all is not 0% retention');
  assert.ok(d.caveats.some((c) => c.includes('No join has a known invite source yet')));

  const html = renderHtml(d);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('TWO growth dashboard'));
  // no external requests - the whole point of a self-contained file
  assert.equal(/<(script|link|img|iframe)\b/i.test(html), false);
  assert.equal(/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, '')), false);
});

test('the rendered page carries the real numbers, not just a template', async () => {
  await join('a', '2026-02-24T10:00:00.000Z', 'invite:promoAAA');
  await member({ member_id: 'a', joined_at: '2026-02-24T10:00:00.000Z', last_active_at: '2026-03-01T00:00:00.000Z' });

  const d = await buildDashboard(t.db, {
    now: NOW,
    weeks: 4,
    anomalies: TEST_ANOMALIES,
    channelSnapshot: {
      collected_at: '2026-03-01T00:00:00.000Z',
      channels: [
        { id: '5', name: 'general', parent_name: 'TWO', human_msgs_30d: 12, human_msgs_90d: 40, unique_humans_30d: 4, days_silent: 0 },
        { id: '6', name: 'ghost-town', parent_name: 'TWO', human_msgs_30d: 0, human_msgs_90d: 0, unique_humans_30d: 0, days_silent: 400 },
      ],
    },
  });

  assert.equal(d.channels[0].name, 'general');
  assert.equal(d.channels[0].state, 'alive');
  assert.equal(d.channels[1].state, 'silent');
  assert.equal(d.channelSnapshotAt, '2026-03-01T00:00:00.000Z');

  const html = renderHtml(d);
  assert.ok(html.includes('Invite promoAAA'), 'the invite source is on the page');
  assert.ok(html.includes('general'));
});

test('with an empty funnel the member count falls back to the snapshot census, labelled', async () => {
  // The state before the bot is deployed: nothing in the members table, but a
  // real audit on disk. Reporting 0 real members would be false, not cautious.
  const d = await buildDashboard(t.db, {
    now: NOW,
    weeks: 4,
    anomalies: TEST_ANOMALIES,
    channelSnapshot: {
      collected_at: '2026-08-19T20:19:24.719Z',
      channels: [],
      members: { human_members: 84, bot_members: 23, stuck_at_rules_screening: 31 },
    },
  });

  assert.equal(d.memberCountSource, 'snapshot');
  assert.equal(d.humansInServer, 84);
  assert.equal(d.raidAccountsStillCounted, 31);
  assert.equal(d.realHumans, 53, '84 humans minus 31 stuck at screening');
  assert.equal(d.memberCountAsOf, '2026-08-19T20:19:24.719Z');

  // A dated number must never be presented as a live one.
  const html = renderHtml(d);
  assert.ok(html.includes('53'));
  assert.ok(html.includes('snapshot 2026-08-19, not live'));
  assert.ok(
    d.caveats.some((c) => c.includes('not from the bot')),
    'the page states where the number came from',
  );
});

test('a live funnel always beats the snapshot, however stale the snapshot is', async () => {
  await join('a', '2026-02-24T10:00:00.000Z', 'invite:promoAAA');
  await member({ member_id: 'a', joined_at: '2026-02-24T10:00:00.000Z', last_active_at: '2026-03-01T00:00:00.000Z' });

  const d = await buildDashboard(t.db, {
    now: NOW,
    weeks: 4,
    anomalies: TEST_ANOMALIES,
    channelSnapshot: {
      collected_at: '2026-08-19T20:19:24.719Z',
      channels: [],
      members: { human_members: 84, stuck_at_rules_screening: 31 },
    },
  });

  assert.equal(d.memberCountSource, 'funnel');
  assert.equal(d.humansInServer, 1, 'the live table wins; 84 is not blended in');
  assert.equal(d.memberCountAsOf, null);
});

test('no funnel and no census reports nothing rather than inventing a number', async () => {
  const d = await buildDashboard(t.db, { now: NOW, weeks: 4, anomalies: TEST_ANOMALIES });
  assert.equal(d.memberCountSource, 'none');
  assert.equal(d.realHumans, 0);
  assert.equal(d.memberCountAsOf, null);
});

test('html escaping: a channel name cannot inject markup', async () => {
  const d = await buildDashboard(t.db, {
    now: NOW,
    weeks: 2,
    anomalies: TEST_ANOMALIES,
    channelSnapshot: {
      collected_at: NOW.toISOString(),
      channels: [{ id: '7', name: '<script>alert(1)</script>', human_msgs_30d: 1, human_msgs_90d: 1 }],
    },
  });
  const html = renderHtml(d);
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});
