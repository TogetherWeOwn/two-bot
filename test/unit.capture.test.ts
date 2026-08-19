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
import { inviteGrowth, InviteTracker } from '../src/core/inviteTracker.ts';

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
