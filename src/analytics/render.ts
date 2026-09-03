/**
 * Render a DashboardData to one self-contained HTML file.
 *
 * Self-contained is a requirement, not a convenience: no CDN, no fonts, no
 * fetch, no build step. The file can be emailed, dropped in a Discord channel,
 * opened off a USB stick, or served by `npm run dashboard -- --serve`, and it
 * shows the same thing every time. Nothing here phones home.
 *
 * Charting choices follow the house data-viz rules:
 *  - Every bar chart on this page compares magnitude within one category, so
 *    every bar is the SAME hue. Colour never encodes identity here, which is
 *    also why there is no legend to read.
 *  - Status colours (good / warning / critical) are always shipped with a word
 *    next to them. Nothing on this page means anything by colour alone.
 *  - Every chart has the numbers written next to it, so the page degrades to a
 *    plain table if the CSS never loads.
 */
import type {
  CohortRow,
  DashboardData,
  GateConversion,
  RetentionCell,
  WeekRow,
} from './dashboard.ts';

export function renderHtml(d: DashboardData): string {
  return `<!doctype html>
<html lang="en" data-generated="${esc(d.generatedAt)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TWO growth dashboard — ${esc(d.generatedAt.slice(0, 10))}</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
  <header class="head">
    <h1>TWO growth dashboard</h1>
    <p class="meta">Generated ${esc(fmtStamp(d.generatedAt))} · covers the last ${d.weeks.length} weeks${
      d.guildId ? ` · guild ${esc(d.guildId)}` : ''
    }</p>
  </header>

  ${section('The three questions', headline(d))}
  ${section('How many joined, and when', weeklyChart(d.weeks))}
  ${section('Where they came from', sourceChart(d))}
  ${section('How many are still here', retention(d))}
  ${section('Which channels are alive', channels(d))}
  ${section('What these numbers do not tell you', caveats(d))}

  <footer class="foot">
    <p>Built by <code>npm run dashboard</code> from the bot's own event log. Every
    number on this page is derived from the same table the bot writes to — there
    is no second copy that can drift.</p>
  </footer>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Appends the as-of date to any tile fed by the dated snapshot rather than the
 * live funnel, so a number that is a photograph never reads as a feed.
 */
function memberNote(d: DashboardData, base: string): string {
  if (d.memberCountSource !== 'snapshot' || !d.memberCountAsOf) return base;
  return `${base} · snapshot ${d.memberCountAsOf.slice(0, 10)}, not live`;
}

function headline(d: DashboardData): string {
  const snap = d.memberCountSource === 'snapshot';
  const delta = d.thisWeek.joins - d.lastWeek.joins;
  const joinTone = d.thisWeek.joins > 0 ? 'good' : 'critical';
  const joinNote =
    d.thisWeek.joins > 0
      ? `${signed(delta)} vs last week (${d.lastWeek.joins})`
      : `nobody joined. Last week: ${d.lastWeek.joins}`;

  const attributed = d.sourcesAllTime.filter((s) => !s.unattributed).reduce((n, s) => n + s.joins, 0);

  return `
  <div class="tiles">
    ${tile('Joined this week', String(d.thisWeek.joins), joinNote, joinTone)}
    ${tile(
      'Where they came from',
      attributed > 0 ? String(attributed) : '—',
      attributed > 0
        ? `${attributed} joins on record have a known invite`
        : 'no join yet has a known invite source',
      attributed > 0 ? 'good' : 'warning',
    )}
    ${tile(
      'Still here and active',
      snap ? '—' : String(d.active7d),
      snap
        ? 'needs the bot running; the snapshot cannot say who was active'
        : `posted or spoke in the last 7 days, out of ${d.realHumans} real members`,
      snap ? 'warning' : d.active7d > 0 ? 'good' : 'critical',
    )}
  </div>
  <div class="tiles secondary">
    ${tile('Members Discord shows', String(d.humansInServer), memberNote(d, 'humans, excluding bots'), 'plain')}
    ${tile(
      snap ? 'Of those, stuck at the rules screen' : 'Of those, raid accounts',
      String(d.raidAccountsStillCounted),
      snap
        ? 'never cleared screening, cannot see or post anywhere'
        : 'never posted, never left, still counted',
      d.raidAccountsStillCounted > 0 ? 'warning' : 'plain',
    )}
    ${tile('Real members', String(d.realHumans), memberNote(d, 'the number worth growing'), 'plain')}
    ${tile(
      'Joined but never spoke',
      String(d.joinedNeverSpoke),
      'still in the server, never said a word',
      'plain',
    )}
  </div>`;
}

function weeklyChart(weeks: WeekRow[]): string {
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.joins, w.leaves)));
  const rows = weeks
    .map((w) => {
      const setAside = w.setAside > 0 ? ` <span class="pill warn">+${w.setAside} set aside</span>` : '';
      return `<tr>
        <th scope="row">${esc(fmtWeek(w.weekStart))}</th>
        <td class="barcell">${bar(w.joins, max, 'series')}<span class="barval">${w.joins}</span>${setAside}</td>
        <td class="barcell">${bar(w.leaves, max, 'muted')}<span class="barval">${w.leaves}</span></td>
        <td class="num ${w.net > 0 ? 'up' : w.net < 0 ? 'down' : ''}">${signed(w.net)}</td>
      </tr>`;
    })
    .join('\n');
  const totalJoins = weeks.reduce((n, w) => n + w.joins, 0);
  const totalLeaves = weeks.reduce((n, w) => n + w.leaves, 0);
  return `
  <table class="chart">
    <thead><tr><th scope="col">Week of</th><th scope="col">Joined</th><th scope="col">Left</th><th scope="col">Net</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th scope="row">Total</th><td class="num">${totalJoins}</td><td class="num">${totalLeaves}</td><td class="num ${
      totalJoins - totalLeaves >= 0 ? 'up' : 'down'
    }">${signed(totalJoins - totalLeaves)}</td></tr></tfoot>
  </table>
  <p class="note">"Set aside" is a known bot raid or mass prune. Those days are listed
  at the bottom of this page and are never averaged into the numbers above.</p>`;
}

function sourceChart(d: DashboardData): string {
  const all = d.sourcesAllTime;
  if (all.length === 0) return `<p class="empty">No joins on record.</p>`;
  const max = Math.max(1, ...all.map((s) => s.joins));
  const rows = all
    .slice(0, 12)
    .map(
      (s) => `<tr>
      <th scope="row">${esc(s.label)}${s.unattributed ? ' <span class="pill">not attributable</span>' : ''}</th>
      <td class="barcell">${bar(s.joins, max, s.unattributed ? 'muted' : 'series')}<span class="barval">${s.joins}</span></td>
    </tr>`,
    )
    .join('\n');

  const week = d.weeks[d.weeks.length - 1];
  const thisWeekList =
    week.bySource.length === 0
      ? `<p class="empty">Nobody joined this week, so there is nothing to attribute.</p>`
      : `<ul class="plainlist">${week.bySource
          .map((s) => `<li><strong>${s.joins}</strong> ${esc(s.label)}</li>`)
          .join('')}</ul>`;

  return `
  <h3>This week</h3>
  ${thisWeekList}
  <h3>All time</h3>
  <table class="chart">
    <thead><tr><th scope="col">Source</th><th scope="col">Joins</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">A source only exists if the bot saw the join happen. Joins imported
  from the server's own log have no invite attached — Discord does not record which
  invite was used, so those are marked <em>not attributable</em> rather than guessed at.</p>`;
}

function retention(d: DashboardData): string {
  const o = d.retentionOverall;
  // Gate conversion sits first and in the same row as D1/D7/D30 on purpose.
  // It is the step BEFORE any of them: a member who never accepted the rules
  // cannot post, so they are a guaranteed zero in every retention column to
  // the right of this tile. Reading D7 without reading this one is how three
  // months of intake converted at under 10% for a year unnoticed (TOG-76).
  const overall = `
  <h3>All time — every member who ever joined</h3>
  <div class="tiles secondary">
    ${gateTile(d.gateOverall)}
    ${retentionTile('D1', o.d1)}
    ${retentionTile('D7', o.d7)}
    ${retentionTile('D30', o.d30)}
  </div>${gateNote(d.gateOverall)}`;

  const withPeople = d.cohorts.filter((c) => c.size > 0);
  const table =
    withPeople.length === 0
      ? `<p class="empty">No cohort in the last ${d.cohorts.length} weeks has anyone in it — nobody joined.</p>`
      : `<table class="chart">
      <thead><tr>
        <th scope="col">Joined week of</th><th scope="col">People</th>
        <th scope="col">Got in</th>
        <th scope="col">D1</th><th scope="col">D7</th><th scope="col">D30</th>
      </tr></thead>
      <tbody>${withPeople.map(cohortRow).join('\n')}</tbody>
    </table>`;

  return `${overall}
  <h3>By join cohort</h3>
  ${table}
  <p class="note"><strong>Got in</strong> is how many of that week's joins accepted the
  server rules. Everyone else is stuck behind the membership screen and structurally
  cannot appear in any column to the right of it.
  <strong>Stayed</strong> is exact — a leave is logged for every member.
  <strong>Active</strong> means they posted or entered voice on or after that day, which is
  the number that actually matters and the one we under-count for old cohorts.
  A dash means that cohort has not aged that far yet, which is not the same as zero.</p>`;
}

function cohortRow(c: CohortRow): string {
  return `<tr>
    <th scope="row">${esc(fmtWeek(c.weekStart))}</th>
    <td class="num">${c.size}</td>
    ${gateCell(c.gate)}
    ${cell(c.d1)}${cell(c.d7)}${cell(c.d30)}
  </tr>`;
}

/**
 * The gate tile. Tone is deliberately loud below 50%: a cohort where half the
 * arrivals never got through the door is not a soft signal, and the whole
 * reason this number exists is that it went unnoticed for a year.
 */
function gateTile(g: GateConversion | null): string {
  if (!g) {
    return tile(
      'Cleared the rules gate',
      '—',
      'not measured yet — run npm run backfill',
      'warning',
    );
  }
  const rate = g.cleared / g.observed;
  const tone = rate >= 0.9 ? 'good' : rate >= 0.5 ? 'warning' : 'critical';
  const stuck = g.stuck > 0 ? `, ${g.stuck} still stuck` : '';
  return tile(
    'Cleared the rules gate',
    pct(g.cleared, g.observed),
    `${g.cleared} of ${g.observed} got in${stuck}`,
    tone,
  );
}

function gateNote(g: GateConversion | null): string {
  if (!g) {
    return `<p class="note">This server has Discord's membership screening on, so joining
    and being able to post are two different events. Nothing has recorded a gate clearing
    yet, so the retention numbers below cannot tell "never got in" apart from "got in and
    said nothing".</p>`;
  }
  const parts = [`<strong>${g.cleared}</strong> accepted the rules`];
  if (g.stuck > 0) {
    parts.push(
      // Singular and plural both read badly under one wording ("1 are", or
      // "1 is ... and never have"), and this line is the one a human acts on.
      `<strong>${g.stuck}</strong> ${
        g.stuck === 1
          ? 'is in the server right now and never has'
          : 'are in the server right now and never have'
      } — they cannot post, react, or use the onboarding picker`,
    );
  }
  if (g.leftAtTheGate > 0) {
    parts.push(`<strong>${g.leftAtTheGate}</strong> joined and left without ever getting in`);
  }
  const unknown =
    g.unknowable > 0
      ? ` <strong>${g.unknowable}</strong> more joined and left before we watched the gate;
        Discord keeps no history of it, so they are left out of the percentage rather than
        counted against it.`
      : '';
  return `<p class="note">${parts.join('; ')}.${unknown}</p>`;
}

function gateCell(g: GateConversion | null): string {
  if (!g) return `<td class="num dim" title="gate state not observed for this cohort">—</td>`;
  return `<td class="num">
    <span class="stayed">${pct(g.cleared, g.observed)}</span>
    <span class="sub">${g.cleared}/${g.observed} got in${g.stuck > 0 ? ` · ${g.stuck} stuck` : ''}</span>
  </td>`;
}

function cell(r: RetentionCell | null): string {
  if (!r || r.eligible === 0) return `<td class="num dim" title="cohort has not aged this far">—</td>`;
  return `<td class="num">
    <span class="stayed">${pct(r.stayed, r.eligible)}</span>
    <span class="sub">${r.stayed}/${r.eligible} stayed · ${r.active} active</span>
  </td>`;
}

function retentionTile(label: string, r: RetentionCell | null): string {
  if (!r) return tile(`${label} retention`, '—', 'no cohort has aged this far', 'plain');
  return tile(
    `${label} retention`,
    pct(r.stayed, r.eligible),
    `${r.stayed} of ${r.eligible} stayed · ${r.active} still active`,
    'plain',
  );
}

function channels(d: DashboardData): string {
  if (d.channels.length === 0) {
    return `<p class="empty">No channel activity data. Run <code>npm run audit:collect</code>.</p>`;
  }
  const alive = d.channels.filter((c) => c.state === 'alive');
  const quiet = d.channels.filter((c) => c.state === 'quiet');
  const silent = d.channels.filter((c) => c.state === 'silent');
  const max = Math.max(1, ...d.channels.map((c) => c.humanMsgs90d ?? c.events30d));

  const row = (c: (typeof d.channels)[number]) => `<tr>
    <th scope="row">${esc(c.name)}${c.category ? `<span class="sub">${esc(c.category)}</span>` : ''}</th>
    <td class="barcell">${bar(c.humanMsgs90d ?? c.events30d, max, c.state === 'alive' ? 'series' : 'muted')}<span class="barval">${
      c.humanMsgs90d ?? '—'
    }</span></td>
    <td class="num">${c.humanMsgs30d ?? '—'}</td>
    <td class="num">${c.uniqueHumans30d ?? '—'}</td>
    <td class="num">${c.daysSilent === null ? '—' : `${c.daysSilent}d`}</td>
    <td>${stateBadge(c.state)}</td>
  </tr>`;

  const shown = [...alive, ...quiet].slice(0, 25);
  return `
  <div class="tiles secondary">
    ${tile('Alive', String(alive.length), 'a human posted in the last 30 days', alive.length > 0 ? 'good' : 'critical')}
    ${tile('Quiet', String(quiet.length), 'last human post 30–90 days ago', 'warning')}
    ${tile('Silent', String(silent.length), 'nothing in 90 days or more', silent.length > 0 ? 'warning' : 'plain')}
  </div>
  <table class="chart">
    <thead><tr>
      <th scope="col">Channel</th><th scope="col">Human messages, 90d</th>
      <th scope="col">30d</th><th scope="col">People, 30d</th><th scope="col">Silent for</th><th scope="col">State</th>
    </tr></thead>
    <tbody>${shown.map(row).join('\n')}</tbody>
  </table>
  <p class="note">${
    d.channelSnapshotAt
      ? `Message counts from the server snapshot taken ${esc(d.channelSnapshotAt.slice(0, 10))}. `
      : ''
  }Showing the ${shown.length} channels with any life in them; the other ${silent.length} have been
  silent for 90 days or more.</p>`;
}

function caveats(d: DashboardData): string {
  const list = d.caveats.map((c) => `<li>${esc(c)}</li>`).join('');
  const anomalies = d.anomalies
    .map(
      (a) => `<li>
      <strong>${esc(a.start)}${a.end !== a.start ? ` → ${esc(a.end)}` : ''}</strong>
      ${statusBadge(a.status)} ${esc(a.label)}
      <span class="sub">${esc(a.note)}</span>
    </li>`,
    )
    .join('');
  return `
  <ul class="caveats">${list}</ul>
  <h3>Days that are set aside</h3>
  <p class="note">These days are excluded from every number above and listed here instead.
  Nothing is deleted — the events are still in the database exactly as recorded.</p>
  <ul class="caveats">${anomalies}</ul>`;
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function section(title: string, body: string): string {
  return `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;
}

function tile(label: string, value: string, note: string, tone: 'good' | 'warning' | 'critical' | 'plain'): string {
  const badge = tone === 'plain' ? '' : `<span class="dot ${tone}" aria-hidden="true"></span>`;
  return `<div class="tile">
    <p class="tlabel">${esc(label)}</p>
    <p class="tvalue">${badge}${esc(value)}</p>
    <p class="tnote">${esc(note)}</p>
  </div>`;
}

/** A bar is magnitude only. Same hue everywhere; width is the whole message. */
function bar(value: number, max: number, tone: 'series' | 'muted'): string {
  const w = max <= 0 ? 0 : Math.max(value > 0 ? 2 : 0, (value / max) * 100);
  return `<span class="bar ${tone}" style="width:${w.toFixed(1)}%"></span>`;
}

function stateBadge(s: 'alive' | 'quiet' | 'silent'): string {
  const tone = s === 'alive' ? 'good' : s === 'quiet' ? 'warning' : 'critical';
  return `<span class="badge ${tone}"><span class="dot ${tone}" aria-hidden="true"></span>${s}</span>`;
}

function statusBadge(s: string): string {
  const tone = s === 'confirmed' ? 'good' : 'warning';
  return `<span class="badge ${tone}"><span class="dot ${tone}" aria-hidden="true"></span>${esc(s)}</span>`;
}

function pct(a: number, b: number): string {
  return b === 0 ? '—' : `${Math.round((a / b) * 100)}%`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function fmtWeek(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtStamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Style. One hue for data, four reserved status colours, nothing else.
// Light and dark are both chosen steps, not one flipped into the other.
// ---------------------------------------------------------------------------

const CSS = `
:root {
  color-scheme: light dark;
  --surface: #fcfcfb;
  --raised: #ffffff;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --ink-3: #77766f;
  --line: #e3e2dd;
  --series: #2a78d6;
  --series-quiet: #cde2fb;
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #131312;
    --raised: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #8f8e86;
    --line: #2e2e2b;
    --series: #3987e5;
    --series-quiet: #184f95;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px 64px;
  background: var(--surface); color: var(--ink);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 960px; margin: 0 auto; }
.head h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.02em; }
.meta { margin: 0 0 24px; color: var(--ink-2); font-size: 13px; }
.card {
  background: var(--raised); border: 1px solid var(--line); border-radius: 8px;
  padding: 20px; margin-bottom: 20px;
}
.card > h2 { margin: 0 0 16px; font-size: 18px; letter-spacing: -0.01em; }
.card h3 { margin: 24px 0 8px; font-size: 14px; color: var(--ink-2); font-weight: 600; }
.card h3:first-of-type { margin-top: 4px; }

.tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.tiles.secondary { margin-top: 12px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.tlabel { margin: 0; font-size: 12px; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.04em; }
.tvalue { margin: 4px 0 2px; font-size: 34px; font-weight: 650; letter-spacing: -0.03em;
          font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 8px; }
.tnote { margin: 0; font-size: 12px; color: var(--ink-3); }

.dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; flex: none; }
.dot.good { background: var(--good); }
.dot.warning { background: var(--warning); }
.dot.critical { background: var(--critical); }
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-2); }

table.chart { width: 100%; border-collapse: collapse; font-size: 14px; }
table.chart th, table.chart td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
table.chart thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
                       color: var(--ink-3); font-weight: 600; text-align: left; border-bottom: 1px solid var(--line); }
table.chart tbody th { font-weight: 500; text-align: left; white-space: nowrap; }
table.chart tfoot th, table.chart tfoot td { font-weight: 650; border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.num.up { color: var(--good); }
.num.down { color: var(--critical); }
.dim { color: var(--ink-3); }
.sub { display: block; font-size: 11px; color: var(--ink-3); font-weight: 400; }
.stayed { font-weight: 600; }

.barcell { width: 46%; white-space: nowrap; }
.bar { display: inline-block; height: 10px; border-radius: 0 4px 4px 0; vertical-align: middle; }
.bar.series { background: var(--series); }
.bar.muted { background: var(--series-quiet); }
.barval { margin-left: 8px; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }

.pill { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 999px;
        border: 1px solid var(--line); color: var(--ink-3); }
.pill.warn { border-color: var(--warning); color: var(--ink-2); }

.note { margin: 12px 0 0; font-size: 12px; color: var(--ink-3); }
.empty { margin: 8px 0; font-size: 14px; color: var(--ink-2); }
.plainlist { margin: 4px 0 0; padding-left: 18px; font-size: 14px; }
.caveats { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
.caveats li { margin-bottom: 8px; }
.foot { color: var(--ink-3); font-size: 12px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
@media (max-width: 640px) { .barcell { width: 34%; } body { padding: 16px 10px 48px; } }
`;
