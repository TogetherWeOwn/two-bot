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

for (const uses of [5, 6]) {
  test(`zero-growth read preserves a departed post-stamp join for retry with counter ${uses}`, () => {
    const first = capture([member('late', lateAt)]).result;
    assert.deepEqual(first.events, []);
    assert.deepEqual(first.pending, [{ id: 'late', joinedAt: lateAt }]);
    assert.equal(first.rows[0].uses, 5);
    assert.equal(first.rows[0].updated_at, capturedAt);

    const nextAt = '2026-10-01T10:00:00.000Z';
    const options = {
      previousRows: first.rows, previousEvents: first.storedEvents,
      previousPending: first.pending, capturedAt: nextAt, rosterReadAt: nextAt, uses,
    };
    const dry = capture([member('old', since)], options, true).result;
    assert.deepEqual(dry.pending, first.pending);
    assert.deepEqual(dry.rows, first.rows);
    assert.deepEqual(dry.events, []);
    assert.equal(dry.pendingWrites, 0);

    const next = capture([member('old', since)], options).result;
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0].memberId, 'late');
    assert.equal(next.events[0].occurredAt, lateAt);
    assert.equal(next.events[0].source, uses === 6 ? 'invite:fixture' : 'unknown');
    assert.deepEqual(next.events[0].metadata?.window, { from: capturedAt, to: nextAt });
    assert.deepEqual(next.pending, []);

    const replay = capture([member('old', since)], {
      previousRows: next.rows, previousEvents: next.storedEvents,
      previousPending: next.pending, uses,
      capturedAt: '2026-10-02T10:00:00.000Z', rosterReadAt: nextAt,
    }).result;
    assert.deepEqual(replay.events, []);
    assert.equal(replay.storedEvents.length, 1);
  });
}

test('a corroborated lone post-stamp join emits with the observed growth', () => {
  // The only observed member joined after the stamp, but the invite counters
  // moved: nothing else in-window competes for the growth, so this is a
  // genuine new spell rather than a stamp-race artifact and it emits
  // immediately instead of retaining. (Uncorroborated post-stamp joins with no
  // growth still defer; see the tests above.)
  const first = capture([member('late', lateAt)], { uses: 6 });
  assert.equal(first.result.events.length, 1);
  assert.equal(first.result.events[0].memberId, 'late');
  assert.equal(first.result.events[0].occurredAt, lateAt);
  assert.equal(first.result.events[0].source, 'invite:fixture');
  assert.equal(first.result.events[0].metadata?.attribution_exact, true);
  assert.deepEqual(first.result.events[0].metadata?.window, { from: since, to: capturedAt });
  assert.deepEqual(first.result.pending, []);
  assert.equal(first.result.rows[0].uses, 6);
  assert.equal(first.result.rows[0].updated_at, capturedAt);
  assert.deepEqual(first.result.windowEnds, [capturedAt]);

  // Replay is idempotent: the recorded join does not re-emit.
  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture([member('late', lateAt)], {
    previousRows: first.result.rows, previousEvents: first.result.storedEvents,
    previousPending: first.result.pending,
    capturedAt: nextAt, rosterReadAt: nextAt, uses: 6,
  }).result;
  assert.deepEqual(next.events, []);
  assert.equal(next.storedEvents.length, 1);
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
    previousRows: first.rows, previousEvents: first.storedEvents,
    previousPending: first.pending, invites,
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['within', 'late']);
  assert.deepEqual(next.events.map((event) => event.source), ['invite:a', 'invite:b']);
  assert.ok(next.events.every((event) => event.metadata?.attribution_exact === false));
  assert.ok(next.rows.every((row) => row.uses === 6 && row.updated_at === nextAt));
});

for (const departed of ['within', 'late']) {
  test(`a retained window recovers observed ${departed} after they leave before retry`, () => {
    const roster = [member('within', capturedAt), member('late', lateAt)];
    const previousRows = ['a', 'b'].map((code) => ({
      code, uses: 5, inviterId: null, channelId: null, updated_at: since,
    }));
    const invites = previousRows.map((row) => ({ ...row, uses: 6 }));
    const first = capture(roster, { previousRows, invites }).result;
    assert.deepEqual(first.events, []);
    assert.deepEqual(first.rows, previousRows);

    const nextAt = '2026-10-01T10:00:00.000Z';
    const next = capture(roster.filter((m) => m.user?.id !== departed), {
      previousRows: first.rows, previousEvents: first.storedEvents,
      previousPending: first.pending, invites,
      capturedAt: nextAt, rosterReadAt: nextAt,
    }).result;
    assert.deepEqual(next.events.map((event) => event.memberId), ['within', 'late']);
    assert.deepEqual(next.events.map((event) => event.source), ['invite:a', 'invite:b']);
    assert.ok(next.events.every((event) => event.metadata?.attribution_exact === false));
    assert.deepEqual(next.events.map((event) => event.occurredAt), [capturedAt, lateAt]);
    assert.deepEqual(next.pending, []);
    assert.ok(next.rows.every((row) => row.uses === 6 && row.updated_at === nextAt));

    const replay = capture(roster, {
      previousRows: next.rows, previousEvents: next.storedEvents,
      previousPending: next.pending, invites,
      capturedAt: '2026-10-02T10:00:00.000Z', rosterReadAt: nextAt,
    }).result;
    assert.deepEqual(replay.events, []);
    assert.equal(replay.storedEvents.length, 2);
  });
}

test('a retained window preserves already-recorded first-wins events on replay', () => {
  const roster = [member('within', capturedAt), member('late', lateAt)];
  const previous = capture([roster[0]], { uses: 7 }).result.events[0];
  const first = capture(roster, { uses: 7, previousEvents: [previous] }).result;
  assert.deepEqual(first.events, []);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture(roster, {
    previousRows: first.rows, previousEvents: first.storedEvents,
    previousPending: first.pending, capturedAt: nextAt, rosterReadAt: nextAt, uses: 7,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['late']);
  assert.equal(next.events[0].source, 'invite:fixture');
  assert.equal(next.storedEvents.length, 2);
  assert.deepEqual(next.storedEvents[0], previous);
  assert.equal(next.rows[0].uses, 7);
  assert.equal(next.rows[0].updated_at, nextAt);
});

test('pending observations survive another retained run and dry-run cannot consume them', () => {
  const first = capture([member('within', capturedAt), member('late', lateAt)], { uses: 7 }).result;
  assert.equal(first.pending.length, 2);
  const options = {
    previousRows: first.rows, previousEvents: first.storedEvents,
    previousPending: first.pending, previousRetained: first.retained, uses: 7,
    capturedAt: '2026-09-30T10:00:00.500Z', rosterReadAt: lateAt,
  };
  const retained = capture([member('old', since)], options).result;
  assert.deepEqual(retained.pending, first.pending);
  assert.deepEqual(retained.rows, first.rows);
  assert.deepEqual(retained.events, []);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const dry = capture([member('old', since)], {
    ...options, capturedAt: nextAt, rosterReadAt: nextAt,
  }, true).result;
  assert.deepEqual(dry.pending, first.pending);
  assert.deepEqual(dry.rows, first.rows);
  assert.deepEqual(dry.events, []);
  assert.equal(dry.pendingWrites, 0);

  const next = capture([member('old', since)], {
    ...options, previousPending: retained.pending, previousRetained: retained.retained,
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['within', 'late']);
  assert.ok(next.events.every((event) => event.source === 'invite:fixture'));
  assert.deepEqual(next.pending, []);
});

test('an independent snapshot advance cannot discard saved unrecorded joins', () => {
  // The live bot rewrites invite_snapshots.updated_at on ready and the
  // backfill seeds it independently; neither path drains pending capture
  // joins. A departed member cannot be recovered from the roster, so pending
  // existence is capture-owned processing evidence and the next run must
  // consume it regardless of the shared watermark.
  const first = capture([member('late', lateAt)]).result;
  assert.deepEqual(first.pending, [{ id: 'late', joinedAt: lateAt }]);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const advancedAt = '2026-09-30T12:00:00.000Z';
  const advanced = capture([member('old', since)], {
    previousRows: first.rows.map((row) => ({ ...row, updated_at: advancedAt })),
    previousEvents: first.storedEvents,
    previousPending: first.pending, previousRetained: first.retained,
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.equal(advanced.events.length, 1);
  assert.equal(advanced.events[0].memberId, 'late');
  assert.equal(advanced.events[0].source, 'unknown');
  // The retry attributes with the live baseline's evidence window, even though
  // an unrelated writer advanced it past the saved observation. The pending
  // row is what proves the join is unrecorded — not the watermark — so the
  // event is emitted rather than silently discarded.
  assert.deepEqual(advanced.events[0].metadata?.window, { from: advancedAt, to: nextAt });
  assert.deepEqual(advanced.pending, []);

  const replay = capture([member('old', since)], {
    previousRows: advanced.rows, previousEvents: advanced.storedEvents,
    previousPending: advanced.pending, previousRetained: advanced.retained,
    capturedAt: '2026-10-02T10:00:00.000Z', rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(replay.events, []);
  assert.equal(replay.storedEvents.length, 1);
});

test('a retained window replays after its baseline rows are gone', () => {
  const first = capture([member('late', lateAt)]).result;
  assert.deepEqual(first.pending, [{ id: 'late', joinedAt: lateAt }]);

  const nextAt = '2026-10-01T10:00:00.000Z';
  const replay = capture([member('old', since)], {
    previousRows: [], previousEvents: first.storedEvents,
    previousPending: first.pending, previousRetained: first.retained,
    invites: [], capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].memberId, 'late');
  assert.equal(replay.events[0].source, 'unknown');
  assert.deepEqual(replay.pending, []);
});

test('a retry after a vanished invite keeps the observed growth honest', () => {
  // Baseline A=5, B=5; the first read sees A=6 with a deferred post-stamp
  // join, so the window is retained with its observed read. Before retry, A
  // disappears (deleted/expired/reset) while B climbs to 7. The retained
  // A+1 survives, so the combined growth is A+1 and B+2 over two observed
  // joins: the arithmetic does not close on B alone, and both events stay
  // ambiguous rather than collapsing to a false exact invite:b.
  const previousRows = ['a', 'b'].map((code) => ({
    code, uses: 5, inviterId: null, channelId: null, updated_at: since,
  }));
  const invites = previousRows.map((row) => ({ ...row, uses: row.code === 'a' ? 6 : 5 }));
  const first = capture([member('within', capturedAt), member('late', lateAt)], {
    previousRows, invites,
  }).result;
  assert.deepEqual(first.events, []);
  assert.equal(first.pending.length, 2);
  assert.ok(first.retained.some((r) => r.code === 'a' && r.uses === 6));

  const nextAt = '2026-10-01T10:00:00.000Z';
  const next = capture([member('late', lateAt)], {
    previousRows: first.rows, previousEvents: first.storedEvents,
    previousPending: first.pending, previousRetained: first.retained,
    invites: [{ code: 'b', uses: 7, inviterId: null, channelId: null }],
    capturedAt: nextAt, rosterReadAt: nextAt,
  }).result;
  assert.deepEqual(next.events.map((event) => event.memberId), ['within', 'late']);
  assert.deepEqual(next.events.map((event) => event.source), ['ambiguous:a+b', 'ambiguous:a+b']);
  assert.ok(next.events.every((event) => event.metadata?.attribution_exact === false));
  assert.deepEqual(next.pending, []);
  assert.deepEqual(next.retained, []);
});

test('pending joins keep distinct arrivals for the same member and dedupe roster overlap', () => {
  const first = capture([member('returning', capturedAt), member('late', lateAt)], { uses: 8 }).result;
  const nextAt = '2026-10-01T10:00:00.000Z';
  const returnedAt = '2026-09-30T11:00:00.000Z';
  const next = capture([member('returning', returnedAt), member('late', lateAt)], {
    previousRows: first.rows, previousEvents: first.storedEvents, previousPending: first.pending,
    capturedAt: nextAt, rosterReadAt: nextAt, uses: 8,
  }).result;
  assert.deepEqual(next.events.map((event) => [event.memberId, event.occurredAt]), [
    ['returning', capturedAt], ['late', lateAt], ['returning', returnedAt],
  ]);
  assert.ok(next.events.every((event) => event.metadata?.attribution_exact === true));
  assert.deepEqual(next.pending, []);
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
    assert.deepEqual(result.pending, []);
    assert.equal(result.pendingWrites, 0);
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
