/**
 * The AM7 / AM30 rules, tested against the cases that are easy to get wrong.
 *
 * No database: rollUp() takes rows and a clock, so every case here is three
 * lines of literal instead of a fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activation,
  am30,
  rate,
  rollUp,
  type JoinRecord,
} from '../src/analytics/attribution.ts';

const DAY = 86_400_000;
const JOIN = Date.parse('2026-01-01T00:00:00.000Z');
const at = (dayOffset: number) => new Date(JOIN + dayOffset * DAY).toISOString();
/** Far enough past the join that every maturity gate is open. */
const NOW = JOIN + 365 * DAY;

function member(over: Partial<JoinRecord> = {}): JoinRecord {
  return {
    memberId: 'm1',
    joinedAt: at(0),
    source: 'invite:CODE',
    firstVoiceAt: null,
    firstMessageAt: null,
    thirdMessageAt: null,
    lastActiveAt: null,
    leftAt: null,
    ...over,
  };
}

test('voice alone activates - TWO is voice-first', () => {
  const a = activation(member({ firstVoiceAt: at(2), lastActiveAt: at(2) }));
  assert.equal(a?.basis, 'voice');
  assert.equal(a?.at, at(2));
});

test('one message does not activate once message counts are on file', () => {
  // Null thirdMessageAt means "we do not record counts", which is the proxy.
  assert.equal(activation(member({ firstMessageAt: at(1) }))?.basis, 'message-proxy');

  // Once a third message IS on file and it landed outside the window, the same
  // member is not AM7 - which is the whole point of the 3+ bar.
  assert.equal(activation(member({ firstMessageAt: at(1), thirdMessageAt: at(99) })), null);
});

test('three messages inside the window activate', () => {
  const a = activation(member({ firstMessageAt: at(1), thirdMessageAt: at(3) }));
  assert.equal(a?.basis, 'messages');
  assert.equal(a?.at, at(3));
});

test('day 8 is not activation', () => {
  assert.equal(activation(member({ firstVoiceAt: at(8) })), null);
  assert.equal(activation(member({ firstMessageAt: at(8) })), null);
});

test('day 7 exactly still counts', () => {
  assert.ok(activation(member({ firstVoiceAt: at(7) })));
});

test('activity before the join being credited is ignored (rejoin)', () => {
  // Somebody who left and came back: their first-ever message is years old and
  // belongs to their previous stay, not to this join.
  const a = activation(member({ joinedAt: at(0), firstMessageAt: at(-400), thirdMessageAt: at(-390) }));
  assert.equal(a, null);
});

test('earliest qualifying signal is the activation moment', () => {
  const a = activation(member({ firstVoiceAt: at(5), firstMessageAt: at(1), thirdMessageAt: at(2) }));
  assert.equal(a?.at, at(2));
  assert.equal(a?.basis, 'messages');
});

test('AM30 needs them to still be here', () => {
  const m = member({ firstVoiceAt: at(1), lastActiveAt: at(10), leftAt: at(40) });
  assert.equal(am30(m, activation(m)!), 'no');
});

test('AM30 needs a second activity, not just the activation', () => {
  const m = member({ firstVoiceAt: at(1), lastActiveAt: at(1) });
  assert.equal(am30(m, activation(m)!), 'no');
});

test('AM30 inside the window is proven, beyond it is proven-later', () => {
  const inWin = member({ firstVoiceAt: at(1), lastActiveAt: at(20) });
  assert.equal(am30(inWin, activation(inWin)!), 'proven-in-window');

  // Still here and still active, just last seen after day 30. Scoring this as
  // a failure would penalise the best-retained members - see the module header.
  const later = member({ firstVoiceAt: at(1), lastActiveAt: at(300) });
  assert.equal(am30(later, activation(later)!), 'proven-later');
});

test('a code with no joins still gets a row', () => {
  const r = rollUp([], { nowMs: NOW, alwaysShow: ['invite:DEAD', 'invite:ALSODEAD'] });
  assert.deepEqual(
    r.rows.map((x) => x.label).sort(),
    ['ALSODEAD', 'DEAD'],
  );
  assert.equal(r.rows[0].joins, 0);
});

test('immature joins count as joins but sit in no denominator', () => {
  const justJoined = member({ memberId: 'new', joinedAt: new Date(NOW - 2 * DAY).toISOString() });
  const r = rollUp([justJoined], { nowMs: NOW });
  assert.equal(r.totals.joins, 1);
  assert.equal(r.totals.am7Eligible, 0, 'two days old, has not had its 7 days');
  assert.equal(r.totals.am30Eligible, 0);
});

test('AM30 denominator is matured AM7, not all joins', () => {
  const rows = [
    member({ memberId: 'a', firstVoiceAt: at(1), lastActiveAt: at(20) }),
    member({ memberId: 'b' }), // joined, never did anything
  ];
  const r = rollUp(rows, { nowMs: NOW });
  assert.equal(r.totals.joins, 2);
  assert.equal(r.totals.am7Eligible, 2);
  assert.equal(r.totals.am7, 1);
  assert.equal(r.totals.am30Eligible, 1, 'only the AM7 member can be AM30');
  assert.equal(r.totals.am30, 1);
});

test('the proxy is flagged and the exact voice-only floor is kept', () => {
  const rows = [
    member({ memberId: 'a', firstVoiceAt: at(1) }),
    member({ memberId: 'b', firstMessageAt: at(1) }), // proxy: may have posted once
  ];
  const r = rollUp(rows, { nowMs: NOW });
  assert.equal(r.totals.am7, 2);
  assert.equal(r.totals.am7Voice, 1);
  assert.equal(r.totals.am7MessageProxy, 1);
  assert.equal(r.usedMessageProxy, true);
});

test('distinct joiners are counted once even across two codes', () => {
  const rows = [
    member({ memberId: 'a', source: 'invite:ONE', joinedAt: at(0) }),
    member({ memberId: 'a', source: 'invite:TWO', joinedAt: at(200) }),
  ];
  const r = rollUp(rows, { nowMs: NOW });
  assert.equal(r.totals.joins, 2, 'two arrivals');
  assert.equal(r.totals.distinctJoiners, 1, 'one person');
});

test('every rate carries its denominator, and zero never reads as a percentage', () => {
  assert.match(rate(1, 3), /1 \/\s+3\s+\(\s*33%\)/);
  assert.match(rate(0, 0), /n\/a/);
  assert.doesNotMatch(rate(0, 0), /0%/);
});
