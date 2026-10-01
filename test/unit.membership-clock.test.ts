import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipClock } from '../src/core/membershipClock.ts';

test('membership observations order same-tick dispatches without altering the occurrence clock', () => {
  let ms = Date.parse('2026-09-30T01:00:00.000Z');
  const observe = createMembershipClock(() => ms);
  assert.equal(observe(), '2026-09-30T01:00:00.000000Z');
  assert.equal(observe(), '2026-09-30T01:00:00.000001Z');
  ms += 1;
  assert.equal(observe(), '2026-09-30T01:00:00.001000Z');
  ms -= 1;
  assert.equal(observe(), '2026-09-30T01:00:00.001001Z', 'a wall-clock correction cannot reverse dispatch order');
});
