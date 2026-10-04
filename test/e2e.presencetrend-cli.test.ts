/**
 * TOG-6488 slice: the presence-trend operator CLI, driven through the real
 * script on a scratch schema (never prod TWO_DATABASE_URL).
 *
 * WHY THIS EXISTS. `scripts/presence-trend.ts` (`npm run presence:trend`) is
 * the ONLY way anyone sees the presence numbers, and those numbers feed
 * staffing/event-slot decisions — yet as of the 2026-09-27 scan no test file
 * referenced the script at all. `test/unit.presenceprobe.test.ts` pins the
 * collector, the trigger constants and the report renderer as library calls,
 * but nothing pinned the script itself: its `TWO_DATABASE_URL` /
 * `DISCORD_GUILD_ID` wiring, its `--days` query window, its `--json` shape,
 * or its exit-code contract. A query that forgot the guild fence, a `--json`
 * flag that printed log lines around the object, or an exit code that stopped
 * distinguishing "fires" from "nothing to do" would all stay green.
 *
 * These tests seed `presence_probe` (two readings a day — a low and the day's
 * peak — for ten trailing days, floor 23 on the first row) and spawn the real
 * entry, asserting end to end:
 *
 *   closed text: exit 0, the INTERNAL ONLY header, ten day-bucket rows each
 *     `n=2 low peak`, exactly one `>= 45` marker on the 46 day, the
 *     `20 over 10 day(s)` tally, `peak in window 46`, `bot floor 23`, the
 *     `humans (rough) ~23` derivation with its caveat, and `trigger CLOSED`
 *     with the `1/3 qualifying days` line.
 *   --days slice: `--days 3` shows the last three buckets only, while the
 *     verdict still sees the full window (still CLOSED 1/3) — the display
 *     window must never shrink the decision.
 *   --json: stdout parses as exactly one object with `guildId`, `readings 20`
 *     and the full verdict (`closed`, 1 qualifying day, peak 46, floor 23).
 *   --web-live fires: three qualifying days plus the human assertion exits 2
 *     with `trigger FIRES`, `3/3 qualifying days`, `web_v1 live: yes` and
 *     three markers. Without the flag the same numbers top out at `armed`
 *     (pinned in unit.presenceprobe.test.ts) — a number alone never fires.
 *   empty window: no rows exits 0 with `No readings yet.` plus the
 *     `presence_probe_enabled` pointer, and `--json` reports
 *     `insufficient_data` with zero readings — a thin series declines to
 *     answer rather than saying no.
 *
 * Fixture (one scratch schema, never live/staging): migrations, then
 * `node scripts/presence-trend.ts` with
 * TWO_DATABASE_URL=<TEST_PG_URL>?options=-c+search_path=<schema> (the
 * TOG-6492 URL-options trick: URL options win over inherited PGOPTIONS, so
 * the child cannot land anywhere but this file's schema) and
 * DISCORD_GUILD_ID=<synthetic guild>. Probe edges (collection, intents,
 * containment) stay in test/unit.presenceprobe.test.ts; this file proves the
 * CLI output only.
 *
 * Reproduce by hand (reviewer path): point TWO_TEST_DATABASE_URL at a scratch
 * DB, take the openTestDb schema S for this file, seed ten days of
 * presence_probe rows for a guild via recordReading, then run
 *   TWO_DATABASE_URL=<url>?options=-c+search_path=S DISCORD_GUILD_ID=<guild> node scripts/presence-trend.ts
 *   ... --json / ... --web-live
 * and compare the bucket rows, the verdict lines and the exit codes with the
 * asserts below.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/presence-trend.ts', import.meta.url));

// Synthetic guild in the 700... range used by other script fixtures; 005 is
// free (000-004 and 009 are taken by sibling fixtures). Isolation here is the
// scratch schema anyway — the script fences every query by guild.
const GUILD = '700000000000000005';
const DAY_MS = 86_400_000;

let harness: TestDb;
/** Routes the child CLI at this file's scratch schema, and nowhere else. */
let cliEnv: NodeJS.ProcessEnv;

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const url = new URL(TEST_PG_URL);
  // URL options win over inherited PGOPTIONS, including URLs with their own
  // options — the TOG-6492 trick. The CLI child reads TWO_DATABASE_URL, so
  // this is the one value that decides which schema it reads.
  url.searchParams.set('options', `-c search_path=${harness.schema}`);
  cliEnv = { TWO_DATABASE_URL: url.toString(), DISCORD_GUILD_ID: GUILD };
});

after(async () => {
  // Guarded: if `before` failed halfway (no database), the cleanup must not
  // throw a second error that masks the real one.
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[]): Promise<CliResult> {
  try {
    const result = await run(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, ...cliEnv },
      timeout: 120_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Ten trailing days ending yesterday: each day a low reading at +6h and the
 * day's peak at +18h, so every bucket holds exactly n=2 with a known low and
 * peak. The floor rides on the first row only — NULL is the common case, and
 * the newest observed floor is the reader's answer.
 */
async function seedSeries(peaks: number[]): Promise<{ dates: string[]; lows: number[] }> {
  const t = Date.now();
  const todayMidnight = Date.UTC(
    new Date(t).getUTCFullYear(),
    new Date(t).getUTCMonth(),
    new Date(t).getUTCDate(),
  );
  const insert = harness.db.prepare(
    `INSERT INTO presence_probe (guild_id, observed_at, approximate_presence_count, bot_floor)
     VALUES (?, ?, ?, ?)`,
  );
  const dates: string[] = [];
  const lows: number[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i]!;
    const low = peak - 12;
    const dayMidnight = todayMidnight - (peaks.length - i) * DAY_MS;
    dates.push(new Date(dayMidnight).toISOString().slice(0, 10));
    lows.push(low);
    await insert.run(
      GUILD,
      new Date(dayMidnight + 6 * 3_600_000).toISOString(),
      low,
      i === 0 ? 23 : null,
    );
    await insert.run(GUILD, new Date(dayMidnight + 18 * 3_600_000).toISOString(), peak, null);
  }
  return { dates, lows };
}

/** One quiet series: a single 46 day, everything else in the twenties. */
const QUIET_PEAKS = [27, 46, 29, 25, 24, 28, 27, 30, 26, 27];
/** Three qualifying days — the numbers half of the trigger. */
const BUSY_PEAKS = [46, 27, 48, 25, 24, 28, 47, 30, 26, 27];

test('closed text pins every bucket row, the tally and the verdict lines', { timeout: 120_000 }, async () => {
  const { dates, lows } = await seedSeries(QUIET_PEAKS);

  const out = await cli([]);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  // The banner travels with every print — this is internal-only data.
  assert.match(out.stdout, /INTERNAL ONLY, never published/);
  assert.match(out.stdout, new RegExp(`guild ${GUILD}`));

  // Ten day buckets, each `n=2 low peak` exactly as seeded. A bucket that
  // merged days, dropped the low, or mis-averaged the peak reds here.
  for (let i = 0; i < QUIET_PEAKS.length; i++) {
    assert.match(
      out.stdout,
      new RegExp(`${dates[i]} +2 +${lows[i]} +${QUIET_PEAKS[i]} `),
      `bucket row for ${dates[i]} should read n=2 low=${lows[i]} peak=${QUIET_PEAKS[i]}`,
    );
  }

  // Exactly one day qualifies, and the marker sits on its row.
  assert.match(out.stdout, new RegExp(`${dates[1]} +2 +${lows[1]} +46 .*<- >= 45`));
  assert.equal(
    (out.stdout.match(/<- >= 45/g) ?? []).length,
    1,
    'only the 46 day may carry the threshold marker',
  );

  // The tally block: counts, window peak, floor, and the one derivation with
  // its caveat attached.
  assert.match(out.stdout, /readings +20 over 10 day\(s\)/);
  assert.match(out.stdout, /window +trailing 14 days/);
  assert.match(out.stdout, /peak in window +46 +at /);
  assert.match(out.stdout, /bot floor +23/);
  assert.match(out.stdout, /humans \(rough\) +~23 at peak/);
  assert.match(out.stdout, /Never publish this number/);

  // The verdict: looked, not close, C stands.
  assert.match(out.stdout, /trigger +CLOSED/);
  assert.match(out.stdout, /1\/3 qualifying days \(peak >= 45\), web_v1 live: not asserted/);
});

test('--days slices the table but never the verdict', { timeout: 120_000 }, async () => {
  const { dates } = await seedSeries(QUIET_PEAKS);

  const out = await cli(['--days', '3']);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  // Only the last three buckets print. Bucket rows start at the line head
  // (`  YYYY-MM-DD ...`); anchoring there matters because the `peak in
  // window 46 at <iso>` line still names the peak day even when its row is
  // sliced off.
  for (const d of dates.slice(-3)) assert.match(out.stdout, new RegExp(`^  ${d} `, 'm'));
  for (const d of dates.slice(0, -3)) {
    assert.ok(!new RegExp(`^  ${d} `, 'm').test(out.stdout), `${d} row must be sliced off`);
  }

  // The decision still sees the full 14-day window: same CLOSED 1/3.
  assert.match(out.stdout, /trigger +CLOSED/);
  assert.match(out.stdout, /1\/3 qualifying days/);
  assert.match(out.stdout, /readings +20 over 10 day\(s\)/);
});

test('--json is exactly one object with the guild, the count and the verdict', { timeout: 120_000 }, async () => {
  await seedSeries(QUIET_PEAKS);

  const out = await cli(['--json']);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  // Stdout must be exactly one JSON object — a log line on stdout would break
  // every cron consumer that parses this.
  let body: unknown;
  assert.doesNotThrow(() => {
    body = JSON.parse(out.stdout);
  }, 'stdout must be exactly one JSON object');
  const report = body as {
    guildId: string;
    readings: number;
    verdict: {
      status: string;
      qualifyingDays: number;
      requiredDays: number;
      threshold: number;
      windowDays: number;
      daysObserved: number;
      readingsInWindow: number;
      peak: number;
      botFloor: number | null;
      webV1Live: boolean;
    };
  };
  assert.equal(report.guildId, GUILD);
  assert.equal(report.readings, 20);
  assert.equal(report.verdict.status, 'closed');
  assert.equal(report.verdict.qualifyingDays, 1);
  assert.equal(report.verdict.requiredDays, 3);
  assert.equal(report.verdict.threshold, 45);
  assert.equal(report.verdict.windowDays, 14);
  assert.equal(report.verdict.daysObserved, 10);
  assert.equal(report.verdict.readingsInWindow, 20);
  assert.equal(report.verdict.peak, 46);
  assert.equal(report.verdict.botFloor, 23);
  assert.equal(report.verdict.webV1Live, false);
});

test('--web-live on three qualifying days fires with exit 2', { timeout: 120_000 }, async () => {
  await seedSeries(BUSY_PEAKS);

  // The numbers alone top out at `armed` — covered at library level in
  // unit.presenceprobe.test.ts. The script's second half is the human
  // assertion, and with it the trigger fires.
  const out = await cli(['--web-live']);
  assert.equal(out.code, 2, `fires must exit 2 for cron:\n${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /trigger +FIRES/);
  assert.match(out.stdout, /3\/3 qualifying days \(peak >= 45\), web_v1 live: yes/);
  assert.match(out.stdout, /peak in window +48 +at /);
  assert.match(out.stdout, /humans \(rough\) +~25 at peak/);
  assert.equal(
    (out.stdout.match(/<- >= 45/g) ?? []).length,
    3,
    'all three qualifying days carry the marker',
  );

  // Same numbers as JSON: the machine shape agrees with the text.
  const machine = await cli(['--json', '--web-live']);
  assert.equal(machine.code, 2, machine.stdout + machine.stderr);
  const report = JSON.parse(machine.stdout) as { verdict: { status: string; qualifyingDays: number } };
  assert.equal(report.verdict.status, 'fires');
  assert.equal(report.verdict.qualifyingDays, 3);
});

test('an empty window explains itself and reports insufficient_data as JSON', { timeout: 120_000 }, async () => {
  const out = await cli([]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /No readings yet\./);
  assert.match(out.stdout, /presence_probe_enabled/);

  const machine = await cli(['--json']);
  assert.equal(machine.code, 0, machine.stdout + machine.stderr);
  const report = JSON.parse(machine.stdout) as {
    readings: number;
    verdict: { status: string; daysObserved: number; peak: null };
  };
  // A thin series declines to answer — `insufficient_data` is a different
  // sentence from "we looked and the answer is no".
  assert.equal(report.readings, 0);
  assert.equal(report.verdict.status, 'insufficient_data');
  assert.equal(report.verdict.daysObserved, 0);
  assert.equal(report.verdict.peak, null);
});
