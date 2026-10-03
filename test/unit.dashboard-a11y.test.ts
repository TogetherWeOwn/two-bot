/**
 * Dashboard accessibility pass (TOG-8291).
 *
 * Pure unit test — `renderHtml` takes a `DashboardData` literal, so no
 * database is needed. Pins the keyboard/contrast/labels contract:
 *
 *   - keyboard: skip link → main target, scroll regions focusable in DOM
 *     order, no positive tabindex, no accesskeys, visible focus styles
 *   - labels: every table has a caption, scroll regions are labelled,
 *     title-only tooltips carry a visually-hidden twin, bars are decorative
 *   - contrast: text pairs meet 4.5:1, non-text (bars, focus rings) meet 3:1,
 *     in both light and dark palettes
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../src/analytics/render.ts';
import type { DashboardData } from '../src/analytics/dashboard.ts';

const FIXTURE: DashboardData = {
  generatedAt: '2026-03-02T12:00:00.000Z',
  guildId: 'guild-123',
  thisWeek: { start: '2026-03-02', joins: 2, leaves: 0, net: 2 },
  lastWeek: { start: '2026-02-23', joins: 1, leaves: 1, net: 0 },
  active7d: 3,
  active30d: 3,
  humansInServer: 3,
  raidAccountsStillCounted: 0,
  realHumans: 3,
  memberCountSource: 'funnel',
  memberCountAsOf: null,
  joinedNeverSpoke: 1,
  avgVoiceSessionSeconds: 120,
  measuredVoiceSessions: 1,
  excludedUnknownStarts: 1,
  weeks: [
    {
      weekStart: '2026-02-23',
      joins: 1,
      setAside: 5,
      leaves: 1,
      net: 0,
      bySource: [{ source: 'invite:promoAAA', label: 'Invite promoAAA', unattributed: false, joins: 1 }],
    },
    {
      weekStart: '2026-03-02',
      joins: 2,
      setAside: 0,
      leaves: 0,
      net: 2,
      bySource: [{ source: 'vanity', label: 'Vanity URL', unattributed: false, joins: 2 }],
    },
  ],
  cohorts: [
    {
      weekStart: '2026-02-23',
      size: 1,
      d1: { eligible: 1, stayed: 1, active: 1 },
      d7: null, // unaged cohort: renders the dash cell with the vh twin
      d30: null,
      gate: null, // never observed: renders the gate dash cell
    },
    {
      weekStart: '2026-03-02',
      size: 2,
      d1: { eligible: 2, stayed: 2, active: 1 },
      d7: null,
      d30: null,
      gate: { observed: 2, cleared: 1, stuck: 1, leftAtTheGate: 0, unknowable: 0 },
    },
  ],
  retentionOverall: {
    d1: { eligible: 3, stayed: 3, active: 2 },
    d7: null,
    d30: null,
  },
  gateOverall: { observed: 3, cleared: 2, stuck: 1, leftAtTheGate: 0, unknowable: 0 },
  sourcesAllTime: [
    { source: 'invite:promoAAA', label: 'Invite promoAAA', unattributed: false, joins: 3 },
    { source: 'backfill:log:member-join', label: 'Before tracking (imported history)', unattributed: true, joins: 10 },
  ],
  channels: [
    {
      channelId: '5',
      name: 'general',
      category: 'TWO',
      humanMsgs30d: 12,
      humanMsgs90d: 40,
      uniqueHumans30d: 4,
      lastMessageAt: '2026-03-01T00:00:00.000Z',
      daysSilent: 0,
      events30d: 2,
      state: 'alive',
    },
    {
      channelId: '6',
      name: 'quiet-room',
      category: null,
      humanMsgs30d: 0,
      humanMsgs90d: 9,
      uniqueHumans30d: 0,
      lastMessageAt: '2026-01-15T00:00:00.000Z',
      daysSilent: 45,
      events30d: 0,
      state: 'quiet', // exercises the muted bar tone
    },
  ],
  channelSnapshotAt: '2026-03-01T00:00:00.000Z',
  caveats: ['No join has an invite source yet.'],
  anomalies: [
    {
      id: 'test-raid',
      kind: 'raid',
      start: '2026-02-04',
      end: '2026-02-04',
      eventTypes: ['member_join'],
      status: 'confirmed',
      label: 'test raid',
      note: 'set aside, never averaged in',
    },
  ],
};

function html(): string {
  return renderHtml(FIXTURE);
}

// ---------------------------------------------------------------------------
// Contrast helpers (WCAG 2.x relative luminance, same math as axe)
// ---------------------------------------------------------------------------

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const f = (i: number): number => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}

function ratio(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

/** Pulls `--var: #hex` pairs out of the rendered `<style>` block per theme. */
function palette(h: string, dark: boolean): Map<string, string> {
  const style = h.match(/<style>([\s\S]*)<\/style>/)![1];
  const block = dark ? style.split('@media (prefers-color-scheme: dark)')[1] : style.split('@media')[0];
  const vars = new Map<string, string>();
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) vars.set(m[1], m[2].toLowerCase());
  return vars;
}

describe('dashboard accessibility (TOG-8291)', () => {
  test('keyboard: skip link targets a focusable main, in DOM order', () => {
    const h = html();
    const skipAt = h.indexOf('class="skip"');
    const mainAt = h.indexOf('<main');
    assert.ok(skipAt !== -1 && mainAt !== -1 && skipAt < mainAt, 'skip link precedes main');
    assert.ok(h.includes('<a class="skip" href="#content">'), 'skip link points at #content');
    assert.ok(h.includes('<main class="page" id="content" tabindex="-1">'), 'main is the focus target');
  });

  test('keyboard: every scroll region is reachable, in DOM order, with no traps', () => {
    const h = html();
    const regions = [...h.matchAll(/<div class="tablewrap" tabindex="0" role="region" aria-label="([^"]+)">/g)];
    assert.ok(regions.length >= 3, `expected wide-table scroll regions, found ${regions.length}`);
    for (const r of regions) assert.ok(r[1].length > 0, 'each region names what it scrolls');
    assert.equal((h.match(/tabindex="[1-9][^"]*"/g) ?? []).length, 0, 'no positive tabindex');
    assert.ok(!/accesskey/i.test(h), 'no accesskeys to fight assistive tech with');
    assert.ok(h.includes('.skip:focus-visible'), 'skip link shows on focus');
    assert.ok(h.includes('.tablewrap:focus-visible'), 'scroll regions show focus');
  });

  test('labels: every table carries a caption naming it', () => {
    const h = html();
    const tables = (h.match(/<table/g) ?? []).length;
    const captions = [...h.matchAll(/<caption class="vh">([^<]+)<\/caption>/g)].map((m) => m[1]);
    assert.ok(tables > 0, 'fixture renders tables');
    assert.equal(captions.length, tables, `every table captioned (${captions.length}/${tables})`);
    for (const c of captions) assert.ok(c.length > 0, 'captions are non-empty');
  });

  test('labels: bars are decorative, dash cells announce their tooltip text', () => {
    const h = html();
    const bars = (h.match(/<span class="bar /g) ?? []).length;
    assert.ok(bars > 0, 'fixture renders bars');
    assert.equal((h.match(/<span class="bar [^>]*aria-hidden="true"/g) ?? []).length, bars, 'all bars hidden from AT');
    assert.ok(h.includes('cohort has not aged this far</span>'), 'retention dash has a vh twin');
    assert.ok(h.includes('gate state not observed for this cohort</span>'), 'gate dash has a vh twin');
    assert.ok(h.includes('.vh {'), 'the vh class is defined');
  });

  test('labels: sections are named regions, status dots stay decorative', () => {
    const h = html();
    const sections = [...h.matchAll(/<section class="card" aria-labelledby="([^\s"]+)"><h2 id="([^"]+)">/g)];
    assert.ok(sections.length >= 6, `all cards are labelled regions, found ${sections.length}`);
    for (const s of sections) assert.equal(s[1], s[2], 'aria-labelledby matches the heading id');
    const dots = (h.match(/<span class="dot /g) ?? []).length;
    assert.ok(dots > 0, 'fixture renders status dots');
    assert.equal((h.match(/<span class="dot [^>]*aria-hidden="true"/g) ?? []).length, dots, 'dots never carry meaning alone');
  });

  test('contrast: text meets 4.5:1 and non-text meets 3:1, light and dark', () => {
    const h = html();
    for (const dark of [false, true]) {
      const p = palette(h, dark);
      const raised = p.get('raised')!;
      const where = dark ? 'dark' : 'light';
      // Text: tiles, notes, table headers, badges.
      for (const v of ['ink-2', 'ink-3']) {
        assert.ok(ratio(p.get(v)!, raised) >= 4.5, `${where} --${v} on --raised = ${ratio(p.get(v)!, raised).toFixed(2)}:1`);
      }
      // Status text colours (.num.up/.down, tones reused on badges).
      for (const v of ['good', 'warning', 'critical']) {
        assert.ok(ratio(p.get(v)!, raised) >= 4.5, `${where} --${v} on --raised = ${ratio(p.get(v)!, raised).toFixed(2)}:1`);
      }
      // Non-text: bar fills and the focus ring.
      for (const v of ['series', 'series-quiet']) {
        assert.ok(ratio(p.get(v)!, raised) >= 3, `${where} --${v} on --raised = ${ratio(p.get(v)!, raised).toFixed(2)}:1`);
      }
    }
  });

  test('reduced motion: the skip-link transition opts out', () => {
    const h = html();
    assert.ok(h.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion block present');
  });

  test('page stays dependency-free', () => {
    const h = html();
    assert.equal(/<(script|link|img|iframe)\b/i.test(h), false, 'no external requests');
  });
});
