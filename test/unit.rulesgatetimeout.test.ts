import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RawMember } from '../src/discord/rest.ts';
import {
  RULES_GATE_TIMEOUT_DAYS,
  scanRulesGateTimeouts,
} from '../src/moderation/rulesGateTimeout.ts';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ID = (n: number) => String(100000000000000000n + BigInt(n));
const member = (
  n: number,
  joinedAt: string | null,
  pending: boolean | undefined,
  bot = false,
): RawMember => ({ user: { id: ID(n), bot }, joined_at: joinedAt, pending });

test('the timeout is a named fourteen-day constant', () => {
  assert.equal(RULES_GATE_TIMEOUT_DAYS, 14);
});

test('only human members still pending for at least fourteen days are targets', () => {
  const scan = scanRulesGateTimeouts(
    [
      member(1, '2026-08-21T12:00:00.000Z', true), // exactly 14 days
      member(2, '2026-08-21T12:00:00.001Z', true), // one millisecond too new
      member(3, '2026-01-01T00:00:00.000Z', false),
      member(4, '2026-01-01T00:00:00.000Z', undefined),
      member(5, '2026-01-01T00:00:00.000Z', true, true),
    ],
    NOW,
  );

  assert.deepEqual(scan.targets, [
    { memberId: ID(1), joinedAt: '2026-08-21T12:00:00.000Z' },
  ]);
  assert.equal(scan.humans, 4);
  assert.equal(scan.bots, 1);
  assert.equal(scan.pending, 2);
});

test('targets are oldest first and invalid join timestamps are held back by id', () => {
  const scan = scanRulesGateTimeouts(
    [
      member(2, 'not-a-date', true),
      member(3, '2026-07-01T00:00:00.000Z', true),
      member(1, '2026-08-01T00:00:00.000Z', true),
    ],
    NOW,
  );

  assert.deepEqual(scan.targets.map((target) => target.memberId), [ID(3), ID(1)]);
  assert.deepEqual(scan.invalidJoinedAt, [ID(2)]);
});
