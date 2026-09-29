/**
 * presenceReport PII minimization (TOG-8679).
 *
 * The presence report is the one human-readable surface of the internal
 * presence instrument (TOG-469). Its inputs are already aggregate-only — a
 * PresenceReading is { observedAt, presence, botFloor } with no per-member
 * field, and the collector hands back a bare count (see `countBotFloor` in
 * src/jobs/presenceProbe.ts). This file pins the output side of that promise:
 * whatever readings and verdict go in, the rendered text — and the --json
 * machine surface in scripts/presence-trend.ts — must carry no member IDs
 * and no tokens, only dates, counts and the one guild scope key.
 *
 * Offline: pure functions only. No database, no Discord, no live guild.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrigger, type PresenceReading } from '../src/analytics/presence.ts';
import { renderPresenceReport } from '../src/analytics/presenceReport.ts';

// Fixture scope key. A guild ID is public to every member of the server and
// is the report's documented scope line (`guild <id>`); it is the ONE
// snowflake-shaped value the output is allowed to carry.
const GUILD = '119988877766655440';

// Decoy member IDs. The report signature takes no per-member input, so these
// can never legitimately appear in its output; they are asserted absent so a
// future refactor that threads IDs toward the report reds here instead of
// shipping them to a terminal.
const MEMBER_IDS = ['100000000000000011', '100000000000000022', '100000000000000033'];

// A 17-20 digit run is a Discord snowflake written as a literal value — the
// same shape scripts/ci/check-src-snowflakes.sh counts in src/.
const SNOWFLAKE = /\d{17,20}/g;

// Discord credential shapes (see .gitleaks.toml): a bot token is three
// base64url segments, a user token starts with `mfa.`, a webhook embeds its
// id plus secret in the URL. Fixtures carry none of these; the scans below
// are tripwires for future edits.
const TOKEN_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'bot token', re: /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'user token', re: /\bmfa\.[A-Za-z0-9_-]{20,}/i },
  { name: 'webhook url', re: /discord(?:app)?\.com\/api\/webhooks\//i },
];

function readings(): PresenceReading[] {
  const base = Date.parse('2026-08-26T12:00:00.000Z');
  return Array.from({ length: 10 }, (_, i) => ({
    observedAt: new Date(base - i * 86_400_000).toISOString(),
    presence: 27 + (i % 4),
    botFloor: i === 0 ? 23 : null,
  }));
}

const NOW = new Date(Date.parse('2026-08-27T12:00:00.000Z')).toISOString();

/** Every snowflake-shaped run in `text` other than the guild scope key. */
function straySnowflakes(text: string): string[] {
  return (text.match(SNOWFLAKE) ?? []).filter((n) => n !== GUILD);
}

function assertMinimized(text: string, label: string): void {
  assert.deepEqual(
    straySnowflakes(text),
    [],
    `${label} carries a snowflake that is not the guild scope key`,
  );
  for (const id of MEMBER_IDS) {
    assert.ok(!text.includes(id), `${label} leaks decoy member id ${id}`);
  }
  for (const { name, re } of TOKEN_SHAPES) {
    assert.ok(!re.test(text), `${label} matches a ${name} shape`);
  }
}

describe('presenceReport PII minimization (TOG-8679)', () => {
  test('the full report carries aggregates, the guild scope key, and nothing else shaped like PII', () => {
    const rs = readings();
    const verdict = evaluateTrigger(rs, { now: NOW });
    const text = renderPresenceReport(rs, { guildId: GUILD, verdict });

    assertMinimized(text, 'presence report');

    // Minimization must not nuke the content: the aggregates stay.
    assert.match(text, /readings\s+10 over 10 day\(s\)/);
    assert.match(text, /bot floor\s+23/);
    assert.match(text, /trigger\s+CLOSED/);
    assert.ok(text.includes(GUILD), 'the scope line keeps its guild key');
  });

  test('the empty-series report is minimized too', () => {
    const verdict = evaluateTrigger([], { now: NOW });
    const text = renderPresenceReport([], { guildId: GUILD, verdict });
    assertMinimized(text, 'empty presence report');
    assert.match(text, /No readings yet/);
  });

  test('the --json machine surface carries a count, not rows', () => {
    // Mirrors scripts/presence-trend.ts --json: { guildId, readings, verdict }.
    const rs = readings();
    const verdict = evaluateTrigger(rs, { now: NOW });
    const payload = JSON.stringify({ guildId: GUILD, readings: rs.length, verdict });
    assertMinimized(payload, 'presence --json payload');
    assert.match(payload, /"readings":10/);
  });

  test('the days-limited table is minimized too', () => {
    const rs = readings();
    const verdict = evaluateTrigger(rs, { now: NOW });
    const text = renderPresenceReport(rs, { guildId: GUILD, verdict, days: 3 });
    assertMinimized(text, 'days-limited presence report');
    assert.match(text, /readings\s+10 over 10 day\(s\)/);
  });
});
