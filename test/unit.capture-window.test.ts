import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { FunnelEvent } from '../src/core/events.ts';
import type { RawMember } from '../src/discord/rest.ts';
import type { CaptureFixture } from './helpers/captureOffline.ts';

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
    new URL('../scripts/capture.ts', import.meta.url).pathname,
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
    result: JSON.parse(result.slice('CAPTURE_FIXTURE_RESULT '.length)) as {
      calls: string[];
      events: FunnelEvent[];
      bots: string[];
      snapshots: unknown[];
      windowEnds: string[];
    },
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
    since: result.windowEnds[0], capturedAt: nextAt, rosterReadAt: nextAt, uses: 6,
  }).result;
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].memberId, 'late');
  assert.equal(next.events[0].occurredAt, lateAt);
  assert.equal(next.events[0].source, 'invite:fixture');
  assert.deepEqual(next.events[0].metadata?.window, { from: capturedAt, to: nextAt });
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
    since: capturedAt, capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['future']);
});

test('capture dry-run writes no events, bot marks, counters or window timestamp', () => {
  const { result, output } = capture([
    member('within', capturedAt), member('late', lateAt), member('bot', capturedAt, true),
  ], {}, true);
  assert.match(output, /new joins in window\s+1/);
  assert.match(output, /written\s+0 \(dry run\)/);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.bots, []);
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.windowEnds, []);
});

test('first capture remains baseline-only even with historical and deferred members', () => {
  const { result, output } = capture([
    member('historical', since), member('boundary', capturedAt), member('late', lateAt),
  ], { since: null });
  assert.match(output, /first capture - baseline only/);
  assert.deepEqual(result.events, []);
  assert.equal(result.snapshots.length, 1);
  assert.deepEqual(result.windowEnds, [capturedAt]);
});
