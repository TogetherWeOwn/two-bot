/**
 * Reading the voice session log (TOG-99).
 *
 * The assertion that matters most is that one enthusiastic person cannot pick
 * the community's event time. Everything else here is bucket arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attendanceGrid,
  bestSlot,
  coverage,
  dowClaimIsSupported,
  frequency,
  slotLabel,
  zoneLabel,
  type SessionRow,
} from '../src/analytics/voiceSessions.ts';

const at = (iso: string, memberId: string): SessionRow => ({ memberId, occurredAt: iso });

// --- frequency -------------------------------------------------------------

test('members split into once / occasional / regular', () => {
  const rows = [
    at('2026-08-02T19:00:00.000Z', 'one'),
    at('2026-08-02T19:00:00.000Z', 'occ'),
    at('2026-08-09T19:00:00.000Z', 'occ'),
    ...['02', '09', '16', '23'].map((d) => at(`2026-08-${d}T19:00:00.000Z`, 'reg')),
  ];
  const f = frequency(rows);
  assert.equal(f.sessions, 7);
  assert.equal(f.members, 3);
  assert.equal(f.once, 1);
  assert.equal(f.occasional, 1);
  assert.equal(f.regular, 1);
  assert.deepEqual(f.top[0], { memberId: 'reg', sessions: 4 });
});

test('ties break on member id so two runs print the same list', () => {
  const rows = [at('2026-08-02T19:00:00.000Z', 'b'), at('2026-08-02T19:00:00.000Z', 'a')];
  assert.deepEqual(
    frequency(rows).top.map((m) => m.memberId),
    ['a', 'b'],
  );
});

test('no rows is not an error', () => {
  const f = frequency([]);
  assert.equal(f.members, 0);
  assert.equal(f.sessions, 0);
  assert.deepEqual(f.top, []);
  assert.equal(bestSlot(attendanceGrid([])), null);
});

// --- the grid --------------------------------------------------------------

test('one person hopping in and out cannot outrank a real crowd', () => {
  const rows = [
    // Tuesday 12:00 - one person, eleven times.
    ...Array.from({ length: 11 }, (_, i) =>
      at(`2026-08-04T12:${String(i).padStart(2, '0')}:00.000Z`, 'hopper'),
    ),
    // Sunday 19:00 - four different people, once each.
    ...['w', 'x', 'y', 'z'].map((m) => at('2026-08-02T19:00:00.000Z', m)),
  ];
  const best = bestSlot(attendanceGrid(rows));
  assert.equal(best?.day, 0, 'Sunday');
  assert.equal(best?.hour, 19);
  assert.equal(best?.members, 4);

  // The hopper's slot is still reported, just below - it has more sessions.
  const tue = attendanceGrid(rows).find((s) => s.day === 2);
  assert.equal(tue?.sessions, 11);
  assert.equal(tue?.members, 1);
});

test('the offset shifts the bucket and the label says which offset', () => {
  // 01:00 UTC on Monday is 20:00 Sunday at UTC-5. Getting this wrong moves an
  // event a whole day, which is the failure this argument exists to prevent.
  const rows = [at('2026-08-03T01:00:00.000Z', 'm')];
  const utc = bestSlot(attendanceGrid(rows, 0));
  assert.equal(utc?.day, 1);
  assert.equal(utc?.hour, 1);
  assert.equal(slotLabel(utc!), 'Mon 01:00');
  assert.equal(zoneLabel(0), 'UTC+00:00');

  const local = bestSlot(attendanceGrid(rows, -5 * 60));
  assert.equal(local?.day, 0, 'Sunday at UTC-5');
  assert.equal(local?.hour, 20);
  assert.equal(slotLabel(local!), 'Sun 20:00');
  assert.equal(zoneLabel(-5 * 60), 'UTC-05:00');
});

test('every slot label is the same width, so a column lines up', () => {
  const widths = new Set(
    [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
      [0, 9, 12, 23].map((hour) => slotLabel({ day, hour, sessions: 1, members: 1 }).length),
    ),
  );
  assert.equal(widths.size, 1, `labels vary in width: ${[...widths]}`);
});

test('a half-hour offset still labels correctly', () => {
  // UTC+05:30 exists and rounding it to +05:00 would move an event 30 minutes.
  assert.equal(zoneLabel(330), 'UTC+05:30');
  assert.equal(zoneLabel(-210), 'UTC-03:30');
});

test('a malformed timestamp is skipped, not bucketed into hour zero', () => {
  const rows = [at('2026-08-02T19:00:00.000Z', 'a'), at('not-a-date', 'b')];
  const grid = attendanceGrid(rows);
  assert.equal(grid.length, 1);
  assert.equal(grid[0].sessions, 1);
});

// --- coverage: the guard on the whole report -------------------------------

test('coverage reports the observed span, not the requested window', () => {
  const c = coverage([
    at('2026-08-02T19:00:00.000Z', 'a'),
    at('2026-08-02T21:00:00.000Z', 'b'), // same day
    at('2026-08-09T19:00:00.000Z', 'a'),
  ]);
  assert.equal(c.firstObserved, '2026-08-02T19:00:00.000Z');
  assert.equal(c.lastObserved, '2026-08-09T19:00:00.000Z');
  assert.equal(c.observedDays, 2, 'two calendar days, three sessions');
});

test('two Sundays are not evidence for a day-of-week claim', () => {
  const twoWeeks = coverage([
    at('2026-08-02T19:00:00.000Z', 'a'),
    at('2026-08-09T19:00:00.000Z', 'a'),
  ]);
  assert.equal(dowClaimIsSupported(twoWeeks), false);

  const fiveWeeks = coverage([
    at('2026-07-05T19:00:00.000Z', 'a'),
    at('2026-08-09T19:00:00.000Z', 'a'),
  ]);
  assert.equal(dowClaimIsSupported(fiveWeeks), true);
});

test('an empty log supports no claim at all', () => {
  const c = coverage([]);
  assert.equal(c.firstObserved, null);
  assert.equal(c.observedDays, 0);
  assert.equal(dowClaimIsSupported(c), false);
});
