/**
 * CLI human-readable formatting polish (TOG-5723, impl TOG-6157).
 *
 * The funnel / dashboard / roster scripts used to build their console text
 * inline next to their DB queries, so the text was untestable without a live
 * database and the three reports drifted apart. The pure renderers in
 * src/analytics/cliFormat.ts fix both: this file feeds them one populated
 * fixture and one empty fixture per renderer and pins the result.
 *
 * Each block asserts the three acceptance properties:
 *   1. populated output has aligned tables (every body row as wide as the
 *      header rule) plus units on counts (`joins`, `members`, `clicks`, ...)
 *      and rates (`%`, `days`);
 *   2. the empty case prints guidance (a next command), never blank output;
 *   3. stable widths: one long slug/name cannot push the columns off screen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDashboardSummary,
  emptyFunnelInput,
  formatDashboardSummary,
  formatFunnelText,
  formatPct,
  formatRosterText,
  sampleDashboardSummary,
  sampleFunnelInput,
  sampleRosterRows,
  sectionHeader,
  topHeader,
} from '../src/analytics/cliFormat.ts';

/** Every non-blank line of a table body must match the header rule width. */
function assertAlignedTable(lines: string[], headerIndex: number, bodyCount: number): void {
  const rule = lines[headerIndex + 1];
  assert.ok(/^  -+/.test(rule), `line ${headerIndex + 1} should be the dash rule`);
  const width = rule.length;
  for (let i = 0; i < bodyCount; i++) {
    const body = lines[headerIndex + 2 + i];
    assert.equal(body.length, width, `body row should align with the rule:\n${rule}\n${body}`);
  }
}

describe('shared pieces', () => {
  test('one header style across reports', () => {
    assert.equal(topHeader('funnel', 7, '2026-09-20T00:00:00.000Z'), 'TWO funnel - last 7 days (since 2026-09-20)');
    assert.equal(topHeader('new members', 30, '2026-08-28T05:00:00.000Z'), 'TWO new members - last 30 days (since 2026-08-28)');
    assert.equal(sectionHeader('Where joins came from'), '  Where joins came from:');
  });

  test('rates print % with n/a, never NaN', () => {
    assert.equal(formatPct(2, 4), '  50%');
    assert.equal(formatPct(1, 3), '  33%');
    assert.equal(formatPct(0, 0), '   n/a');
    assert.equal(formatPct(5, 0), '   n/a');
  });
});

describe('funnel text renderer', () => {
  test('populated: aligned headlines, units on counts and rates', () => {
    const text = formatFunnelText(sampleFunnelInput());
    assert.ok(text.includes('TWO funnel - last 7 days (since 2026-09-20)'));
    // Counts carry units; rates carry %.
    assert.match(text, /invite clicks\s+\d+ clicks/);
    assert.match(text, /joins\s+\d+ joins\s+\d+%\s+of clicks/);
    assert.match(text, /cleared rules gate\s+\d+ members\s+\d+%\s+of joiners/);
    assert.match(text, /posted first message\s+\d+ members\s+\d+%\s+of joins/);
    assert.match(text, /first voice session\s+\d+ members\s+\d+%\s+of joins/);
    assert.match(text, /left\s+\d+ leaves/);
    // Attribution rows name the source plus the unit.
    assert.match(text, /25 joins  invite:abc123/);
    assert.match(text, /0 joins  ambiguous \(several invites grew at once\)/);
    assert.match(text, /5 joins  unknown \(no invite grew, no vanity URL\)/);
    // Tracked-link row: slug, clicks, joins, rate, label, retired flag.
    assert.match(text, /test-link\s+90 clicks\s+25 joins\s+\d+%  Test listing/);
    assert.match(text, /old-link\s+30 clicks\s+0 joins\s+\d+%  Old listing  \(retired\)/);
    // Retention rows carry the day unit and the retained unit.
    assert.match(text, /D1\s+\(1 day\)\s+20 \/ 40\s+retained\s+\d+%/);
    assert.match(text, /D7\s+\(7 days\)/);
    // Voice average uses the compact duration plus its denominator.
    assert.match(text, /avg voice session.*47m avg.*over 9 measured, 1 unknown-start excluded/);
    assert.match(text, /Total events on file: 1234 events/);
    assert.match(text, /never posted.*: 12 members/);
  });

  test('populated: empty-denominator retention and null voice average stay honest', () => {
    const text = formatFunnelText(sampleFunnelInput());
    // D30 cohort is 0: not 0%, an unaged cohort line with the day unit.
    assert.match(text, /D30\s+\(30 days\)\s+no members aged 30 days yet/);
    assert.doesNotMatch(text, /D30.*0\s*\/\s*0/);
  });

  test('empty: guidance on every section, never blank', () => {
    const text = formatFunnelText(emptyFunnelInput());
    assert.ok(text.includes('TWO funnel - last 7 days (since 2026-09-20)'));
    assert.ok(text.includes('no tracked links yet - see npm run campaigns'));
    assert.ok(text.includes('no clicks or joins in window - share a tracked link'));
    assert.ok(text.includes('no joiners in window - gate conversion needs a join first'));
    assert.ok(text.includes('no joins yet - share an invite'));
    assert.ok(text.includes('(no measured session in window)'));
    assert.ok(text.includes('no members aged 1 day yet'));
    assert.ok(text.includes('everyone on record has posted or spoken - see npm run reengage'));
    assert.ok(text.includes('Total events on file: 0 events'));
    // No bare column without a unit, no NaN rate.
    assert.doesNotMatch(text, /NaN/);
  });

  test('stable widths: a long slug cannot move the campaign columns', () => {
    const input = sampleFunnelInput();
    input.campaigns = [
      {
        slug: 'a-very-long-campaign-slug-that-keeps-going-forever',
        label: 'Long',
        inviteCode: 'zzz',
        clicks: 1,
        joins: 1,
        retired: false,
      },
    ];
    const text = formatFunnelText(input);
    const line = text.split('\n').find((l) => l.includes('Long'))!;
    assert.ok(line.includes('a-very-long-campaign-...'), `slug should ellipsize:\n${line}`);
    assert.match(line, /1 clicks\s+1 joins/);
  });
});

describe('dashboard console summary', () => {
  test('populated: units on every count', () => {
    const text = formatDashboardSummary(sampleDashboardSummary());
    assert.equal(
      text,
      '  joined this week 3 joins · active last 7 days 5 members · real members 53 members',
    );
  });

  test('empty: guidance, not a bare zero line', () => {
    const text = formatDashboardSummary(emptyDashboardSummary());
    assert.ok(text.includes('joined this week 0 joins'));
    assert.ok(text.includes('active last 7 days 0 members'));
    assert.ok(text.includes('real members 0 members'));
    assert.ok(text.includes('no joins this week - see npm run funnel'));
    assert.ok(text.includes('nobody active in 7 days - see npm run reengage'));
    assert.ok(text.includes('no members on record - run npm run backfill'));
  });

  test('partial zero: only the zero measures get hints', () => {
    const text = formatDashboardSummary({ joinsThisWeek: 0, active7d: 4, realHumans: 10 });
    assert.ok(text.includes('no joins this week - see npm run funnel'));
    assert.ok(!text.includes('nobody active'));
    assert.ok(!text.includes('no members on record'));
  });
});

describe('roster text renderer', () => {
  test('populated: one header style, aligned table, units in the summary', () => {
    const text = formatRosterText(sampleRosterRows(), 7, '2026-09-20T00:00:00.000Z');
    const lines = text.split('\n');
    assert.ok(lines.some((l) => l === 'TWO new members - last 7 days (since 2026-09-20)'));
    const headerIndex = lines.findIndex((l) => l.includes('posted?'));
    assert.ok(headerIndex > 0, 'table header should be present');
    assertAlignedTable(lines, headerIndex, 3);
    // Source rendering: invite code stripped, backfill honest, unknown plain.
    assert.ok(lines.some((l) => l.includes('abc123')));
    assert.ok(lines.some((l) => l.includes('unknown (pre-tracking)')));
    assert.ok(!text.includes('invite:abc123'), 'raw invite: prefix should not leak');
    assert.ok(!text.includes('backfill:'), 'raw backfill: prefix should not leak');
    // Summary lines carry units.
    assert.ok(text.includes('3 members joined, 1 posted, 2 never posted'));
    assert.ok(text.includes('1 of 3 members attributed to a specific invite code'));
    assert.ok(text.includes('1 members still in the server and have never posted - the re-engagement list.'));
  });

  test('empty: guidance, never a blank table', () => {
    const text = formatRosterText([], 7, '2026-09-20T00:00:00.000Z');
    assert.ok(text.includes('TWO new members - last 7 days (since 2026-09-20)'));
    assert.ok(text.includes('No joins recorded in this window.'));
    assert.ok(text.includes('node scripts/roster.ts 30'));
    assert.ok(text.includes('npm run backfill'));
    assert.ok(!text.includes('posted?'), 'no table header on the empty path');
  });

  test('stable widths: a long display name cannot move the columns', () => {
    const rows = sampleRosterRows();
    rows[0].displayName = 'A display name far too long for any table column here';
    const text = formatRosterText(rows, 7, '2026-09-20T00:00:00.000Z');
    const lines = text.split('\n');
    const headerIndex = lines.findIndex((l) => l.includes('posted?'));
    assertAlignedTable(lines, headerIndex, 3);
    const longLine = lines.find((l) => l.includes('A display name'))!;
    assert.ok(longLine.includes('...'), `long name should ellipsize:\n${longLine}`);
    assert.ok(!longLine.includes('for any table column here'), 'full name should not leak into the table');
  });
});
