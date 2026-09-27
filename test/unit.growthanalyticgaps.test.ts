/**
 * Gap coverage for TOG-5697: exported functions in src/growth + src/analytics
 * with zero direct unit coverage.
 *
 * Each of these is exercised only indirectly today (or not at all): the
 * join-link parser is only reached through stubbed network observers, `utcDay`
 * only through dailyPeaks, `wrap` not at all from the presence report, the two
 * roster/cell formatters only through full-report snapshots, and the scorecard
 * voice-union helper only through the DB-backed builder. Every block below
 * pins one function's happy path plus its error/edge path, with no database
 * and no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackedJoinPathFromHtml } from '../src/growth/joinPath.ts';
import { utcDay } from '../src/analytics/presence.ts';
import { renderPresenceReport, wrap } from '../src/analytics/presenceReport.ts';
import type { TriggerVerdict } from '../src/analytics/presence.ts';
import { describeRosterSource, fitCell } from '../src/analytics/cliFormat.ts';
import { unionVoiceSeconds } from '../src/analytics/communityScorecard.ts';

// --- trackedJoinPathFromHtml -------------------------------------------------

test('join-link parser accepts the tracked /join link, either attribute order', () => {
  const hrefFirst = '<a href="/join" data-testid="discord-join">Join the Discord</a>';
  const testidFirst = '<a data-testid="discord-join" href="/join">Join the Discord</a>';
  for (const html of [hrefFirst, testidFirst]) {
    const url = trackedJoinPathFromHtml('https://togetherweown.com', html);
    assert.ok(url instanceof URL, `expected a URL for ${html}`);
    assert.equal(url.href, 'https://togetherweown.com/join');
  }
});

test('join-link parser rejects an untracked link, a wrong path, and link-free HTML', () => {
  const site = 'https://togetherweown.com';
  assert.equal(
    trackedJoinPathFromHtml(site, '<a href="/join">Untracked link</a>'),
    undefined,
  );
  assert.equal(
    trackedJoinPathFromHtml(site, '<a data-testid="discord-join" href="/about">Join</a>'),
    undefined,
  );
  assert.equal(trackedJoinPathFromHtml(site, '<h1>About us</h1>'), undefined);
  assert.equal(trackedJoinPathFromHtml(site, ''), undefined);
});

// --- utcDay ------------------------------------------------------------------

test('utcDay slices the UTC calendar day, not the local one', () => {
  assert.equal(utcDay('2026-08-25T02:00:00.000Z'), '2026-08-25');
  assert.equal(utcDay('2026-08-25T23:59:59.999Z'), '2026-08-25');
  // Just past midnight UTC is the next day even where it is still evening locally.
  assert.equal(utcDay('2026-08-26T00:00:00.000Z'), '2026-08-26');
});

test('utcDay rejects a non-date rather than returning a garbage day', () => {
  assert.throws(() => utcDay('not-a-date'), RangeError);
});

// --- wrap --------------------------------------------------------------------

test('wrap keeps short text on one line and breaks long text within width', () => {
  assert.deepEqual(wrap('hello world', 62), ['hello world']);
  const lines = wrap('Presence qualifies - 3 days peaked at >= 45 in the trailing 14 days', 20);
  assert.ok(lines.length > 1, `expected wrapping, got ${JSON.stringify(lines)}`);
  for (const line of lines) assert.ok(line.length <= 20, `line too long: ${line}`);
});

test('wrap handles empty and whitespace-only input without emitting blank lines', () => {
  assert.deepEqual(wrap('', 62), []);
  assert.deepEqual(wrap('   ', 62), []);
});

// --- renderPresenceReport `days` option ---------------------------------------

function verdict(over: Partial<TriggerVerdict> = {}): TriggerVerdict {
  return {
    status: 'closed',
    qualifyingDays: 0,
    requiredDays: 3,
    threshold: 45,
    windowDays: 14,
    daysObserved: 10,
    readingsInWindow: 20,
    peak: 30,
    peakAt: '2026-08-25T12:00:00.000Z',
    botFloor: 23,
    webV1Live: false,
    reason: 'short',
    ...over,
  };
}

function readings(days: number) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.parse('2026-08-25T12:00:00.000Z') - i * 86_400_000).toISOString();
    out.push({ observedAt: day, presence: 20 + i, botFloor: i === 0 ? 23 : null });
  }
  return out;
}

test('report `days` option limits the table but keeps the full total', () => {
  const full = renderPresenceReport(readings(10), { guildId: 'g', verdict: verdict() });
  const limited = renderPresenceReport(readings(10), { guildId: 'g', verdict: verdict(), days: 3 });
  assert.ok(limited.split('\n').length < full.split('\n').length, 'expected a shorter table');
  assert.match(limited, /readings +10 over 10 day\(s\)/);
});

// --- fitCell -----------------------------------------------------------------

test('fitCell passes short values through and truncates long ones with an ellipsis', () => {
  assert.equal(fitCell('short', 10), 'short');
  assert.equal(fitCell('exactly-ten!', 12), 'exactly-ten!');
  assert.equal(fitCell('a-very-long-campaign-slug-that-keeps-going', 24), 'a-very-long-campaign-...');
});

test('fitCell with a tiny width never emits a longer string than asked', () => {
  assert.equal(fitCell('abcdef', 3), 'abc');
  assert.equal(fitCell('abcdef', 0), '');
  assert.ok(fitCell('abcdef', 2).length <= 2);
});

// --- describeRosterSource -----------------------------------------------------

test('describeRosterSource translates each stored source prefix', () => {
  assert.equal(describeRosterSource(null), 'unknown');
  assert.equal(describeRosterSource(''), 'unknown');
  assert.equal(describeRosterSource('invite:CODE123'), 'CODE123');
  assert.equal(describeRosterSource('ambiguous:CODE1/CODE2'), 'ambiguous (CODE1/CODE2)');
  assert.equal(describeRosterSource('backfill:legacy'), 'unknown (pre-tracking)');
  assert.equal(describeRosterSource('vanity'), 'vanity URL');
});

test('describeRosterSource passes unknown formats through unchanged', () => {
  assert.equal(describeRosterSource('qr-poster'), 'qr-poster');
});

// --- unionVoiceSeconds ---------------------------------------------------------

function voiceFact(actorId: string, start: string, end: string, classification = 'eligible_human') {
  return {
    id: 1,
    guild_id: 'g',
    event_type: 'voice_session_ended' as const,
    source_event_id: `${actorId}:${start}`,
    actor_id: actorId,
    occurred_at: end,
    recorded_at: end,
    source: 'channel:voice',
    classifier_version: 'v1',
    classification: classification as 'eligible_human' | 'bot',
    matched_rule: 'test',
    metadata: { startedAt: start, durationSeconds: (Date.parse(end) - Date.parse(start)) / 1000 },
    idempotency_key: `voice-end:${actorId}:${start}`,
  };
}

const WEEK_START = '2026-08-31T00:00:00.000Z';
const WEEK_END = '2026-09-07T00:00:00.000Z';

test('voice union sums disjoint sessions and merges overlapping ones once', () => {
  const totals = unionVoiceSeconds(
    [
      voiceFact('a', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z'),
      voiceFact('a', '2026-09-01T11:00:00.000Z', '2026-09-01T11:05:00.000Z'),
      // Overlaps the first session by 5 minutes: union is 15 min, not 20.
      voiceFact('b', '2026-09-02T10:00:00.000Z', '2026-09-02T10:10:00.000Z'),
      voiceFact('b', '2026-09-02T10:05:00.000Z', '2026-09-02T10:15:00.000Z'),
    ],
    WEEK_START,
    WEEK_END,
  );
  assert.equal(totals.get('a'), 900);
  assert.equal(totals.get('b'), 900);
});

test('voice union ignores non-human, malformed, and out-of-week sessions', () => {
  const totals = unionVoiceSeconds(
    [
      // Bot traffic never counts toward the human numerator.
      voiceFact('bot', '2026-09-01T10:00:00.000Z', '2026-09-01T12:00:00.000Z', 'bot'),
      // Negative duration is corrupt input, not negative presence.
      { ...voiceFact('neg', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z'),
        metadata: { startedAt: '2026-09-01T10:00:00.000Z', durationSeconds: -5 } },
      // Entirely before the week.
      voiceFact('old', '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z'),
      // Wrong event type.
      { ...voiceFact('msg', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z'),
        event_type: 'message_created' as const },
    ],
    WEEK_START,
    WEEK_END,
  );
  assert.equal(totals.size, 0);
  assert.equal(unionVoiceSeconds([], WEEK_START, WEEK_END).size, 0);
});
