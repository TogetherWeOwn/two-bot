/**
 * Invite-counter differencing for the host-less capture path.
 *
 * This is the arithmetic behind every attributed join we record while there is
 * no always-on bot, and a wrong answer here is not loud - it writes a
 * confident, plausible, wrong invite code into the funnel and nobody notices
 * until a growth push gets credited to the wrong channel.
 *
 * The shapes below are the ones the live server actually produces: 16 standing
 * codes that mostly never move, plus new codes appearing between readings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteGrowth, attributeJoins, InviteTracker } from '../src/core/inviteTracker.ts';

const inv = (code: string, uses: number) => ({
  code,
  uses,
  inviterId: null,
  channelId: null,
});

test('one code moving is the ordinary case and yields a clean delta', () => {
  const g = inviteGrowth(new Map([['aB3xY9', 4]]), [inv('aB3xY9', 5)]);
  assert.deepEqual([...g], [['aB3xY9', 1]]);
});

test('a code created inside the window contributes all of its uses', () => {
  // The newest invite is usually the one a growth push is handing out, so
  // treating an unseen code as delta 0 would lose exactly the attribution we
  // most want.
  const g = inviteGrowth(new Map([['old', 10]]), [inv('old', 10), inv('brandnew', 3)]);
  assert.deepEqual([...g], [['brandnew', 3]]);
});

test('nothing moving yields no growth at all', () => {
  const g = inviteGrowth(new Map([['a', 2], ['b', 7]]), [inv('a', 2), inv('b', 7)]);
  assert.equal(g.size, 0);
});

test('a counter going backwards is not negative growth and cannot cancel a real rise', () => {
  // Deleted-and-recreated codes reset to zero. Left unclamped, that would
  // subtract from the total and make a genuine join look like a vanity join.
  const g = inviteGrowth(new Map([['reset', 9], ['real', 1]]), [inv('reset', 0), inv('real', 2)]);
  assert.deepEqual([...g], [['real', 1]]);
});

test('a code that disappeared does not count as growth', () => {
  const g = inviteGrowth(new Map([['gone', 5], ['here', 1]]), [inv('here', 1)]);
  assert.equal(g.size, 0);
});

test('attribution: one code named, several ambiguous, none is vanity or unknown', () => {
  const t = new InviteTracker(null as never); // attribute() touches no database
  assert.equal(t.attribute(['aB3xY9'], false), 'invite:aB3xY9');
  assert.equal(t.attribute(['a', 'b'], false), 'ambiguous:a+b');
  assert.equal(t.attribute([], true), 'vanity');
  assert.equal(t.attribute([], false), 'unknown');
});

/**
 * Multi-code windows (TWO-73).
 *
 * The campaign runs 7 listing codes at once, so "several codes moved" stops
 * being the rare case and becomes the normal one. These assert against
 * inviteGrowth() output directly rather than a hand-built map, because the
 * thing being tested is that the magnitudes it already computes survive all
 * the way to the event.
 */

test('several codes moving with the arithmetic closing splits joins by magnitude', () => {
  // A +2, B +1, three new members. Fully determined in aggregate.
  const g = inviteGrowth(new Map([['aaa', 5], ['bbb', 1]]), [inv('aaa', 7), inv('bbb', 2)]);
  assert.deepEqual([...g], [['aaa', 2], ['bbb', 1]]);

  const out = attributeJoins(g, 3, false);
  assert.deepEqual(
    out.map((a) => a.source),
    ['invite:aaa', 'invite:aaa', 'invite:bbb'],
  );
  // Per-code counts are exact. Per-member pairing is not, and must say so or
  // somebody will quote an AM7 off a placement.
  assert.deepEqual(out.map((a) => a.exact), [false, false, false]);
});

test('a code created inside a multi-code window still claims all of its uses', () => {
  // The newest code is the one a listing push is handing out, and it has no
  // previous reading to difference against.
  const g = inviteGrowth(new Map([['old', 4]]), [inv('old', 5), inv('fresh', 3)]);
  const out = attributeJoins(g, 4, false);
  const counts = out.reduce<Record<string, number>>((acc, a) => {
    acc[a.source] = (acc[a.source] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { 'invite:fresh': 3, 'invite:old': 1 });
});

test('several codes moving without the arithmetic closing stays ambiguous', () => {
  // Counters say 3, the member list gained 2 - somebody joined and left inside
  // the window. Any split here would be a guess printed as a number.
  const g = inviteGrowth(new Map([['aaa', 5], ['bbb', 1]]), [inv('aaa', 7), inv('bbb', 2)]);
  const out = attributeJoins(g, 2, false);
  assert.deepEqual(
    out.map((a) => a.source),
    ['ambiguous:aaa+bbb', 'ambiguous:aaa+bbb'],
  );
  assert.equal(out.every((a) => a.exact === false), true);
});

test('a single code moving is unchanged, and is the only case that is exact', () => {
  const g = inviteGrowth(new Map([['aB3xY9', 4]]), [inv('aB3xY9', 5)]);
  assert.deepEqual(attributeJoins(g, 1, false), [{ source: 'invite:aB3xY9', exact: true }]);
});

test('one code moving less than the member list gained is still the best guess, but not proof', () => {
  // +1 on the counter, 2 new members: one of them did not come through it.
  // Behaviour is deliberately unchanged - the run prints the mismatch - but
  // calling this proven would be a lie.
  const g = inviteGrowth(new Map([['aB3xY9', 4]]), [inv('aB3xY9', 5)]);
  const out = attributeJoins(g, 2, false);
  assert.deepEqual(out.map((a) => a.source), ['invite:aB3xY9', 'invite:aB3xY9']);
  assert.equal(out.every((a) => a.exact === false), true);
});

test('no code moving is vanity or unknown, and never claims to be exact', () => {
  const g = inviteGrowth(new Map([['a', 2]]), [inv('a', 2)]);
  assert.deepEqual(attributeJoins(g, 1, true), [{ source: 'vanity', exact: false }]);
  assert.deepEqual(attributeJoins(g, 1, false), [{ source: 'unknown', exact: false }]);
});

test('a window with no new members emits nothing whatever the counters did', () => {
  const g = inviteGrowth(new Map([['a', 2]]), [inv('a', 9)]);
  assert.deepEqual(attributeJoins(g, 0, false), []);
});

test('the seven-code campaign case: every code keeps its own count in one window', () => {
  // The shape TWO-71 is about to create. Before this change the whole window
  // recorded as one ambiguous:a+b+c+... string and the campaign had to stagger
  // the listing launches to get readable numbers.
  const prev = new Map(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((c) => [c, 0]));
  const gains = [3, 0, 1, 0, 2, 0, 4];
  const g = inviteGrowth(
    prev,
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((c, i) => inv(c, gains[i])),
  );
  const out = attributeJoins(g, 10, false);
  assert.equal(out.length, 10);
  const counts = out.reduce<Record<string, number>>((acc, a) => {
    acc[a.source] = (acc[a.source] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { 'invite:c1': 3, 'invite:c3': 1, 'invite:c5': 2, 'invite:c7': 4 });
  // Codes that produced nothing produce no rows - the zero is the finding, and
  // scripts/attribution.ts prints it from the live invite list, not from here.
  assert.equal(Object.keys(counts).length, 4);
});
