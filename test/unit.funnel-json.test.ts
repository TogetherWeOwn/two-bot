/**
 * Funnel `--json` contract (TOG-8290).
 *
 * `node scripts/funnel.ts --json` prints one JSON object (schema 1) that the
 * dashboard stopgap quotes: the same numbers a human reproduces from the text
 * report. Anything downstream that parses that output breaks silently when a
 * key is renamed or removed, so this file pins the exact key set, the type of
 * every field, and the units of every measured value.
 *
 * It drives `buildFunnelReport` directly - no database - so the contract is
 * checked on every run, including environments without Postgres. The script
 * itself only collects rows; the shape is written exactly once in
 * src/analytics/funnelReport.ts. The arithmetic is covered by
 * test/e2e.funnel-accuracy.test.ts; what fails here is a renamed key, a
 * removed key, an added key nobody documented, a field whose type changed,
 * or a unit mixup (seconds where milliseconds belong).
 *
 * Acceptance: rename any funnel JSON key (e.g. `firstMessage` to
 * `firstMsg`) in src/analytics/funnelReport.ts and this file goes red.
 *
 * Mutation map (each one flips exactly one assertion red):
 *   rename a funnel/voice/downtime key -> the assertKeys failure names it
 *   add an undocumented key            -> assertKeys fails on the addition
 *   gapMs in seconds (7200 not 7200000)-> the milliseconds assertion fails
 *   averageSeconds wired to `measured` -> the 600-vs-1 value assertions fail
 *   null average rendered as 0         -> the null-means-unmeasured assertion fails
 *   drop a bySource row               -> the exact-rows assertion fails
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFunnelReport,
  FUNNEL_JSON_SCHEMA_VERSION,
  type FunnelReportInput,
} from '../src/analytics/funnelReport.ts';

// ---------------------------------------------------------------------------
// Shape helpers (same contract-proving style as unit.dashboard-json.test.ts)
// ---------------------------------------------------------------------------

type Expect = 'string' | 'number' | 'boolean' | 'number|null' | 'array' | 'object';

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

// ---------------------------------------------------------------------------
// Fixture: one small community exercising every section of the report.
// ---------------------------------------------------------------------------

function sampleInput(): FunnelReportInput {
  return {
    windowDays: 7,
    since: '2026-09-20T00:00:00.000Z',
    clicks: 3,
    joins: 5,
    joinsSetAside: 0,
    gateCleared: 2,
    joiners: 4,
    stuckAtGate: 1,
    firstMessage: 2,
    firstVoice: 1,
    leaves: 1,
    leavesSetAside: 0,
    bySource: [
      { source: 'invite:abc123', joins: 3 },
      { source: 'unknown', joins: 1 },
      { source: 'ambiguous:xxx+yyy', joins: 1 },
    ],
    ambiguous: 1,
    unknown: 1,
    downtime: [
      {
        start: '2026-09-21T02:00:00.000Z',
        end: '2026-09-21T04:00:00.000Z',
        gapMs: 7_200_000,
        downtimeUnknown: 1,
      },
    ],
    downtimeUnknown: 1,
    campaigns: [
      { slug: 'acc-link', label: 'Accuracy listing', inviteCode: 'abc123', clicks: 3, joins: 3, retired: false },
      { slug: 'old-link', label: 'Old listing', inviteCode: 'old999', clicks: 30, joins: 0, retired: true },
    ],
    clickSpikes: [{ slug: 'old-link', spikes: [{ day: '2026-09-20', count: 25, factor: 5 }] }],
    firstVoiceSessions: 1,
    voice: { averageSeconds: 600, measured: 1, excludedUnknownStarts: 1 },
    retention: [
      { day: 1, retained: 2, cohort: 4 },
      { day: 7, retained: 0, cohort: 0 },
      { day: 30, retained: 0, cohort: 0 },
    ],
    neverPosted: 1,
    strandedRaid: 0,
    totalEvents: 16,
  };
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('funnel --json contract', () => {
  test('top-level keys and types are exactly the documented set', () => {
    const r = buildFunnelReport(sampleInput());
    assertShape(r, {
      schema: 'number',
      windowDays: 'number',
      since: 'string',
      funnel: 'object',
      attribution: 'object',
      downtime: 'object',
      campaigns: 'array',
      clickSpikes: 'array',
      voice: 'object',
      retention: 'array',
      neverPosted: 'number',
      strandedRaid: 'number',
      totalEvents: 'number',
    }, 'funnel report');
    assert.equal(r.schema, FUNNEL_JSON_SCHEMA_VERSION);
    assert.equal(r.schema, 1, 'schema version pins the dashboard stopgap contract');
  });

  test('funnel keys pin the dashboard-consumed counts', () => {
    const r = buildFunnelReport(sampleInput());
    assertShape(r.funnel, {
      clicks: 'number',
      joins: 'number',
      joinsSetAside: 'number',
      gateCleared: 'number',
      joiners: 'number',
      stuckAtGate: 'number',
      firstMessage: 'number',
      firstVoice: 'number',
      leaves: 'number',
      leavesSetAside: 'number',
    }, 'funnel');
    // Events vs people: 5 join events from 4 joiners (one rejoined).
    assert.deepEqual(r.funnel, {
      clicks: 3,
      joins: 5,
      joinsSetAside: 0,
      gateCleared: 2,
      joiners: 4,
      stuckAtGate: 1,
      firstMessage: 2,
      firstVoice: 1,
      leaves: 1,
      leavesSetAside: 0,
    });
  });

  test('attribution pins the per-source rows and the two honest buckets', () => {
    const r = buildFunnelReport(sampleInput());
    assertShape(r.attribution, { bySource: 'array', ambiguous: 'number', unknown: 'number' }, 'attribution');
    for (const s of r.attribution.bySource) {
      assertShape(s, { source: 'string', joins: 'number' }, 'attribution.bySource[]');
    }
    assert.deepEqual(r.attribution.bySource, [
      { source: 'invite:abc123', joins: 3 },
      { source: 'unknown', joins: 1 },
      { source: 'ambiguous:xxx+yyy', joins: 1 },
    ]);
    assert.equal(r.attribution.ambiguous, 1);
    assert.equal(r.attribution.unknown, 1);
  });

  test('downtime windows pin ISO instants and millisecond gaps', () => {
    const r = buildFunnelReport(sampleInput());
    assertShape(r.downtime, { windows: 'array', unknownInWindow: 'number' }, 'downtime');
    assert.equal(r.downtime.windows.length, 1);
    const w = r.downtime.windows[0]!;
    assertShape(w, { start: 'string', end: 'string', gapMs: 'number', downtimeUnknown: 'number' }, 'downtime.windows[]');
    assert.ok(!Number.isNaN(Date.parse(w.start)), 'start is an ISO instant');
    assert.ok(!Number.isNaN(Date.parse(w.end)), 'end is an ISO instant');
    // Units: gapMs is MILLISECONDS (2h = 7_200_000), never seconds.
    assert.equal(w.gapMs, 7_200_000, 'gapMs is milliseconds, not seconds');
    assert.equal(w.gapMs, Date.parse(w.end) - Date.parse(w.start), 'gapMs equals end minus start');
    assert.equal(w.downtimeUnknown, 1);
    assert.equal(r.downtime.unknownInWindow, 1);
  });

  test('campaigns and click spikes pin their nested shapes', () => {
    const r = buildFunnelReport(sampleInput());
    assert.equal(r.campaigns.length, 2);
    for (const c of r.campaigns) {
      assertShape(c, {
        slug: 'string',
        label: 'string',
        inviteCode: 'string',
        clicks: 'number',
        joins: 'number',
        retired: 'boolean',
      }, 'campaigns[]');
    }
    assert.deepEqual(r.campaigns[0], {
      slug: 'acc-link',
      label: 'Accuracy listing',
      inviteCode: 'abc123',
      clicks: 3,
      joins: 3,
      retired: false,
    });
    assert.equal(r.campaigns[1]!.retired, true, 'the retired flag rides on the row, not a second query');

    assert.equal(r.clickSpikes.length, 1);
    assertShape(r.clickSpikes[0], { slug: 'string', spikes: 'array' }, 'clickSpikes[]');
    assertShape(r.clickSpikes[0]!.spikes[0], { day: 'string', count: 'number', factor: 'number' }, 'clickSpikes[].spikes[]');
    assert.deepEqual(r.clickSpikes[0]!.spikes[0], { day: '2026-09-20', count: 25, factor: 5 });
  });

  test('voice pins seconds units and the null-means-unmeasured rule', () => {
    const r = buildFunnelReport(sampleInput());
    assertShape(r.voice, {
      firstVoiceSessions: 'number',
      avgSessionSeconds: 'number|null',
      measuredSessions: 'number',
      excludedUnknownStarts: 'number',
    }, 'voice');
    // Units: avgSessionSeconds is SECONDS (10 minutes = 600), never milliseconds.
    assert.equal(r.voice.avgSessionSeconds, 600, 'avgSessionSeconds is seconds, not milliseconds');
    assert.equal(r.voice.measuredSessions, 1, 'measured comes from voice.measured, not the mean');
    assert.equal(r.voice.excludedUnknownStarts, 1, 'unknown starts are counted, never averaged');
    assert.equal(r.voice.firstVoiceSessions, r.funnel.firstVoice, 'voice rides on the first-voice count');
  });

  test('retention pins day units and the closing counts', () => {
    const r = buildFunnelReport(sampleInput());
    assert.equal(r.retention.length, 3);
    for (const x of r.retention) {
      assertShape(x, { day: 'number', retained: 'number', cohort: 'number' }, 'retention[]');
    }
    // Units: day is DAYS after joining (1/7/30), retained/cohort are members.
    assert.deepEqual(
      r.retention.map((x) => [x.day, x.retained, x.cohort]),
      [
        [1, 2, 4],
        [7, 0, 0],
        [30, 0, 0],
      ],
    );
    assert.ok(!Number.isNaN(Date.parse(r.since)), 'since is an ISO instant');
    assert.equal(r.windowDays, 7, 'windowDays is days');
    assert.equal(r.neverPosted, 1);
    assert.equal(r.strandedRaid, 0);
    assert.equal(r.totalEvents, 16);
  });

  test('empty input renders honest empties: null average, empty arrays', () => {
    const r = buildFunnelReport({
      ...sampleInput(),
      bySource: [],
      downtime: [],
      downtimeUnknown: 0,
      campaigns: [],
      clickSpikes: [],
      voice: { averageSeconds: null, measured: 0, excludedUnknownStarts: 0 },
      retention: [
        { day: 1, retained: 0, cohort: 0 },
        { day: 7, retained: 0, cohort: 0 },
        { day: 30, retained: 0, cohort: 0 },
      ],
    });
    assert.deepEqual(r.attribution.bySource, []);
    assert.deepEqual(r.downtime.windows, []);
    assert.deepEqual(r.campaigns, []);
    assert.deepEqual(r.clickSpikes, []);
    // "No measured sessions" is null, never a zero-second average.
    assert.equal(r.voice.avgSessionSeconds, null);
    assert.equal(r.voice.measuredSessions, 0);
  });

  test('the output survives a JSON round trip unchanged', () => {
    const r = buildFunnelReport(sampleInput());
    // This is the actual `--json` path: stringify on the host, parse downstream.
    // Anything non-serializable (undefined, functions) fails here, not in prod.
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  });
});
