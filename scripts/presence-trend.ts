/**
 * Read the internal presence series (TOG-469).
 *
 *   node scripts/presence-trend.ts               # the whole series + verdict
 *   node scripts/presence-trend.ts --days 14     # last 14 days in the table
 *   node scripts/presence-trend.ts --json        # same verdict, machine readable
 *   node scripts/presence-trend.ts --web-live    # assert web_v1 is actually serving
 *
 * Reads TWO_DATABASE_URL and DISCORD_GUILD_ID. Postgres only - the table
 * arrives in migration 0004.
 *
 * This prints to a terminal and that is the ONLY way anyone sees these
 * numbers. There is no view, no endpoint and no page. If you are here because
 * you want to put the online count on the website, the answer is in the
 * verdict at the bottom, and it is `closed` until the series says otherwise.
 *
 * `--web-live` exists because half the trigger is not observable from this
 * repo: contract views existing is not the same as a live site, so a human
 * asserts it. Without the flag the trigger reports `armed` at most, never
 * `fires` - a number alone must not reopen the decision.
 */
import { openDb, isPostgresSpec } from '../src/store/db.ts';
import { readSeries } from '../src/jobs/presenceProbe.ts';
import { evaluateTrigger } from '../src/analytics/presence.ts';
import { renderPresenceReport } from '../src/analytics/presenceReport.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const daysArg = argv[argv.indexOf('--days') + 1];
const days = args.has('--days') && /^\d+$/.test(daysArg ?? '') ? Number(daysArg) : undefined;

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url) {
  console.error('presence-trend: TWO_DATABASE_URL is not set.');
  process.exit(1);
}
if (!isPostgresSpec(url)) {
  console.error('presence-trend: TWO_DATABASE_URL is not a Postgres URL.');
  process.exit(1);
}

const guildId = process.env.DISCORD_GUILD_ID?.trim();
if (!guildId) {
  console.error('presence-trend: DISCORD_GUILD_ID is not set - the series is per guild.');
  process.exit(1);
}

const db = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-presence-trend' });

try {
  // Push the --days window into the query (TOG-7206): without it the script
  // pulled every hourly row ever collected and sliced in memory. The verdict
  // needs the trailing REOPEN_WINDOW_DAYS (14) regardless of the display
  // window, so the query bound is the wider of the two.
  const { REOPEN_WINDOW_DAYS } = await import('../src/analytics/presence.ts');
  const daysBack = Math.max(days ?? 0, REOPEN_WINDOW_DAYS);
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const readings = await readSeries(db, guildId, { since });
  const verdict = evaluateTrigger(readings, {
    now: new Date().toISOString(),
    webV1Live: args.has('--web-live'),
  });

  if (args.has('--json')) {
    console.log(JSON.stringify({ guildId, readings: readings.length, verdict }, null, 2));
  } else {
    console.log(renderPresenceReport(readings, { guildId, verdict, days }));
  }

  // Exit code carries the verdict so a cron can act without parsing text.
  // 0 = nothing to do (including "not enough data"), 2 = the trigger fired.
  process.exitCode = verdict.status === 'fires' ? 2 : 0;
} finally {
  await db.close();
}
