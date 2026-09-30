import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RawMember } from '../src/discord/rest.ts';
import type { CaptureFixture, CaptureResult } from './helpers/captureOffline.ts';

const since = '2026-09-29T10:00:00.000Z';
const capturedAt = '2026-09-30T10:00:00.000Z';
const lateAt = '2026-09-30T10:00:01.000Z';
const member = (id: string, joined_at: string, bot = false): RawMember => ({
  user: { id, bot }, joined_at,
});

function capture(members: RawMember[], options: Partial<CaptureFixture> = {}, dryRun = false) {
  const fixture: CaptureFixture = {
    since, capturedAt, rosterReadAt: lateAt, uses: 5, members, ...options,
  };
  const child = spawnSync(process.execPath, [
    '--import', new URL('./helpers/captureOffline.ts', import.meta.url).href,
    fileURLToPath(new URL('../scripts/capture.ts', import.meta.url)),
    ...(dryRun ? ['--dry-run'] : []),
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      DISCORD_BOT_TOKEN: 'fixture-not-a-token',
      DISCORD_GUILD_ID: 'fixture-guild',
      TWO_DATABASE_URL: 'fixture-not-a-database',
      CAPTURE_TEST_FIXTURE: JSON.stringify(fixture),
    },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const result = child.stdout.split('\n').find((line) => line.startsWith('CAPTURE_FIXTURE_RESULT '));
  assert.ok(result, child.stdout);
  return {
    output: child.stdout,
    result: JSON.parse(result.slice('CAPTURE_FIXTURE_RESULT '.length)) as CaptureResult,
  };
}

test('capture defers a post-stamp join exposed by the delayed roster read', () => {
  const { result, output } = capture([member('late', lateAt)]);
  assert.deepEqual(result.events, []);
  assert.match(output, /new joins in window\s+0/);
  assert.deepEqual(result.calls, [
    '/guilds/fixture-guild/invites',
    '/guilds/fixture-guild/members?limit=1000&after=0',
    '/guilds/fixture-guild',
  ]);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.windowEnds, [capturedAt]);

  // The next fixture uses the persisted window end, now with invite growth.
  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture([member('late', lateAt)], {
    previousRows: result.rows, previousEvents: result.storedEvents,
    capturedAt: nextAt, rosterReadAt: nextAt, uses: 6,
  }).result;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].memberId, 'late');
  assert.equal(next.events[0].occurredAt, lateAt);
  assert.equal(next.events[0].source, 'invite:fixture');
  assert.deepEqual(next.events[0].metadata?.window, { from: capturedAt, to: nextAt });
});

test('capture retains early counter growth for a deferred join across real tracker runs', () => {
  const first = capture([member('late', lateAt)], { uses: 6 });
  assert.deepEqual(first.result.events, []);
  assert.deepEqual(first.result.snapshots, []);
  assert.deepEqual(first.result.windowEnds, []);
  assert.equal(first.result.rows[0].uses, 5);
  assert.equal(first.result.rows[0].updated_at, since);
  assert.match(first.output, /retaining previous counters and window/);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture([member('late', lateAt)], {
    previousRows: first.result.rows, previousEvents: first.result.storedEvents,
    capturedAt: nextAt, rosterReadAt: nextAt, uses: 6,
  }).result;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].source, 'invite:fixture');
  assert.equal(next.events[0].metadata?.attribution_exact, true);
  assert.deepEqual(next.events[0].metadata?.window, { from: since, to: nextAt });
  assert.equal(next.rows[0].uses, 6);
  assert.equal(next.rows[0].updated_at, nextAt);

  const thirdAt = '2026-10-02T10:00:00.000Z';
  const third = capture([member('late', lateAt)], {
    previousRows: next.rows, previousEvents: next.storedEvents,
    capturedAt: thirdAt, rosterReadAt: thirdAt, uses: 6,
  }).result;
  assert.deepEqual(third.events, []);
  assert.equal(third.storedEvents.length, 1);
});

test('retaining a window also defers eligible join writes to preserve multi-code attribution', () => {
  const roster = [member('within', capturedAt), member('late', lateAt)];
  const previousRows = ['a', 'b'].map((code) => ({
    code, uses: 5, inviterId: null, channelId: null, updated_at: since,
  }));
  const invites = previousRows.map((row) => ({ ...row, uses: 6 }));
  const first = capture(roster, { previousRows, invites }).result;
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.snapshots, []);
  assert.deepEqual(first.rows, previousRows);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture(roster, {
    previousRows: first.rows, previousEvents: first.storedEvents, invites,
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['within', 'late']);
  assert.deepEqual(next.events.map((event) => event.source), ['invite:a', 'invite:b']);
  assert.ok(next.events.every((event) => event.metadata?.attribution_exact === false));
  assert.ok(next.rows.every((row) => row.uses === 6 && row.updated_at === nextAt));
});

test('a retained window preserves already-recorded first-wins events on replay', () => {
  const roster = [member('within', capturedAt), member('late', lateAt)];
  const previous = capture([roster[0]], { uses: 7 }).result.events[0];
  const first = capture(roster, { uses: 7, previousEvents: [previous] }).result;
  assert.deepEqual(first.events, []);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture(roster, {
    previousRows: first.rows, previousEvents: first.storedEvents,
    capturedAt: nextAt, rosterReadAt: nextAt, uses: 7,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['late']);
  assert.equal(next.events[0].source, 'invite:fixture');
  assert.equal(next.storedEvents.length, 2);
  assert.deepEqual(next.storedEvents[0], previous);
  assert.equal(next.rows[0].uses, 7);
  assert.equal(next.rows[0].updated_at, nextAt);
});

test('counter growth with no deferred members advances the snapshot normally', () => {
  const { result } = capture([member('within', capturedAt)], { uses: 6 });
  assert.equal(result.events[0].source, 'invite:fixture');
  assert.equal(result.events[0].metadata?.attribution_exact, true);
  assert.equal(result.rows[0].uses, 6);
  assert.equal(result.rows[0].updated_at, capturedAt);
});

test('capture selects (since, capturedAt] and preserves join ordering', () => {
  const within = '2026-09-30T09:59:59.999Z';
  const { result } = capture([
    member('upper', capturedAt), member('future', lateAt),
    member('lower', since), member('within', within),
    member('older', '2026-09-29T09:59:59.999Z'),
    member('bot', within, true),
  ]);
  assert.deepEqual(result.events.map((event) => event.memberId), ['within', 'upper']);
  for (const event of result.events) {
    assert.ok(event.occurredAt > since && event.occurredAt <= capturedAt);
    assert.deepEqual(event.metadata?.window, { from: since, to: capturedAt });
  }
  assert.deepEqual(result.bots, ['bot']);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture([member('upper', capturedAt), member('future', lateAt)], {
    previousRows: result.rows, previousEvents: result.storedEvents,
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['future']);
});

for (const uses of [5, 6]) {
  test(`capture dry-run with counter ${uses} writes no events, bots, counters or timestamp`, () => {
    const { result, output } = capture([
      member('within', capturedAt), member('late', lateAt), member('bot', capturedAt, true),
    ], { uses }, true);
    assert.match(output, /new joins in window\s+1/);
    assert.match(output, /written\s+0 \(dry run\)/);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.bots, []);
    assert.deepEqual(result.snapshots, []);
    assert.deepEqual(result.windowEnds, []);
    assert.equal(result.rows[0].uses, 5);
    assert.equal(result.rows[0].updated_at, since);
  });
}

test('first capture remains baseline-only even with historical and deferred members', () => {
  const { result, output } = capture([
    member('historical', since), member('boundary', capturedAt), member('late', lateAt),
  ], { since: null, uses: 6 });
  assert.match(output, /first capture - baseline only/);
  assert.deepEqual(result.events, []);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.windowEnds, [capturedAt]);
});
