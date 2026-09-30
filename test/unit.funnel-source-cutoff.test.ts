/**
 * Attribution quality covers every filtered join, not just the top 15 sources.
 * Run the real CLI against a query double: no database or network is opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { excludeClause } from '../src/analytics/anomalies.ts';
import type { FunnelReport } from '../src/analytics/funnelReport.ts';

const run = promisify(execFile);
const SCRIPT = new URL('../scripts/funnel.ts', import.meta.url).pathname;
const DB_MODULE = new URL('../src/store/db.ts', import.meta.url).href;
const GUILD = 'funnel-cutoff-fixture';
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const SINCE = '2026-09-23T12:00:00.000Z';
type SourceRow = { source: string; n: number | string };

async function cli(rows: SourceRow[], asJson: boolean): Promise<string> {
  const joinExcl = excludeClause('member_join');
  const mockDb = `
    import assert from 'node:assert/strict';
    const rows = ${JSON.stringify(rows)};
    let groupedReads = 0;
    export async function openDb(url) {
      assert.equal(url, 'postgres://offline-fixture.invalid/unused');
      return {
        prepare(sql) {
          return {
            async get() {
              return { n: sql.includes("event_type='member_join'")
                ? rows.reduce((n, r) => n + Number(r.n), 0) : 0 };
            },
            async all(...params) {
              if (!sql.includes('GROUP BY source')) return [];
              groupedReads++;
              assert.ok(sql.includes(${JSON.stringify(`WHERE event_type='member_join' AND guild_id = ? AND occurred_at >= ?${joinExcl.sql}`)}),
                'source population must preserve event, guild, window and anomaly predicates');
              assert.deepEqual(params, ${JSON.stringify([GUILD, SINCE, ...joinExcl.params])});
              assert.match(sql, /ORDER BY n DESC/);
              const sorted = [...rows].sort((a, b) => Number(b.n) - Number(a.n));
              const limit = sql.match(/LIMIT\\s+(\\d+)/i);
              return limit ? sorted.slice(0, Number(limit[1])) : sorted;
            },
          };
        },
        async close() { assert.equal(groupedReads, 1); },
      };
    }
  `;
  const mockUrl = `data:text/javascript,${encodeURIComponent(mockDb)}`;
  const loader = `
    import { registerHooks } from 'node:module';
    Date.now = () => ${NOW};
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        return resolved.url === ${JSON.stringify(DB_MODULE)}
          ? { url: ${JSON.stringify(mockUrl)}, shortCircuit: true } : resolved;
      },
    });
  `;
  const { stdout } = await run(
    process.execPath,
    [
      '--import', new URL('./helpers/helpOffline.ts', import.meta.url).href,
      '--import', `data:text/javascript,${encodeURIComponent(loader)}`,
      SCRIPT, ...(asJson ? ['--json'] : []),
    ],
    {
      timeout: 15_000,
      env: {
        PATH: '',
        LANG: 'C',
        TZ: 'UTC',
        TWO_DATABASE_URL: 'postgres://offline-fixture.invalid/unused',
        DISCORD_GUILD_ID: GUILD,
      },
    },
  );
  return stdout;
}

const invites: SourceRow[] = Array.from({ length: 15 }, (_, i) => ({
  source: `invite:cutoff-${i}`,
  n: '2',
}));

for (const fixture of [
  {
    name: 'quality buckets below the display cutoff',
    rows: [...invites, { source: 'unknown', n: '1' }, { source: 'ambiguous:a+b', n: '1' }],
    joins: 32, ambiguous: 1, unknown: 1,
    displayed: invites.map((r) => ({ source: r.source, joins: Number(r.n) })),
  },
  {
    name: 'high-count quality buckets with ambiguous variants below the cutoff',
    rows: [
      ...invites,
      { source: 'unknown', n: '40' },
      { source: 'ambiguous:a+b', n: '10' },
      { source: 'ambiguous', n: '1' },
      { source: 'ambiguous:c+d', n: '1' },
      { source: 'vanity', n: '1' },
      { source: 'unknown:other', n: '1' },
    ],
    joins: 84, ambiguous: 12, unknown: 40,
    displayed: [
      { source: 'unknown', joins: 40 },
      { source: 'ambiguous:a+b', joins: 10 },
      ...invites.slice(0, 13).map((r) => ({ source: r.source, joins: Number(r.n) })),
    ],
  },
  {
    name: 'empty source population',
    rows: [], joins: 0, ambiguous: 0, unknown: 0, displayed: [],
  },
]) {
  test(`funnel text and JSON retain all attribution quality: ${fixture.name}`, async () => {
    const report = JSON.parse(await cli(fixture.rows, true)) as FunnelReport;
    assert.equal(report.funnel.joins, fixture.joins);
    assert.equal(report.attribution.unknown, fixture.unknown);
    assert.equal(report.attribution.ambiguous, fixture.ambiguous);
    assert.deepEqual(report.attribution.bySource, fixture.displayed);
    assert.ok(report.attribution.bySource.length <= 15, 'source display remains bounded');

    const text = await cli(fixture.rows, false);
    assert.match(text, new RegExp(`^\\s+${fixture.ambiguous} joins  ambiguous \\(several invites grew at once\\)`, 'm'));
    assert.match(text, new RegExp(`^\\s+${fixture.unknown} joins  unknown \\(no invite grew, no vanity URL\\)`, 'm'));
    const displayedLines = text.split('\n').filter((line) => /^\s+\d+ joins  /.test(line));
    assert.equal(displayedLines.length, fixture.displayed.length + 2);
    for (const row of fixture.displayed) {
      assert.ok(displayedLines.some((line) => line.trim() === `${row.joins} joins  ${row.source}`));
    }
  });
}
