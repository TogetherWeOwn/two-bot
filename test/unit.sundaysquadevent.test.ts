/**
 * TOG-6485: `scripts/sunday-squad-event.ts` dry-run acceptance test on fixtures.
 *
 * The gap: as of the 2026-09-27 scan no test file referenced the script at
 * all. It drives the Sunday Squad ritual (TOG-1964 pilot), so a payload
 * regression - wrong channel, lost recurrence rule, drifted start - would only
 * surface against live Discord.
 *
 * What this pins, with no token, no database and no live Discord:
 *
 *   1. the seeded unit payload: `scheduledEventPayload(SUNDAY_SQUAD, run 1)`
 *      is the exact weekly Sunday series card the spec names;
 *   2. the real script as a subprocess with a scrubbed environment (no
 *      `DISCORD_*` credentials at all) exits 0 on `--dry-run` and prints one
 *      POST body matching that shape - proving dry-run posts nothing because
 *      there is nothing to post *with* and no network is attempted;
 *   3. `--dry-run --individual` prints six POST bodies with distinct starts,
 *      each a Sunday 20:00 America/New_York, and no `recurrence_rule`;
 *   4. without `--dry-run` and without credentials the script exits 2 with
 *      guidance instead of touching the network;
 *   5. static pin: the dry-run exit sits before the credential check and the
 *      only `fetch` in the file, so a future refactor cannot silently move a
 *      network call ahead of it.
 *
 * Reviewer acceptance: `node scripts/sunday-squad-event.ts --dry-run` and
 * compare the printed body against the assertions below. No live guild action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  SUNDAY_SQUAD,
  liveSeriesStartEpoch,
  scheduledEventPayload,
} from '../src/onboarding/anchorEvent.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/sunday-squad-event.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

const TZ = 'America/New_York';

/** What a wall clock in New York reads at an instant. Test-side, on purpose. */
function nyClock(epochSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochSeconds * 1000));
}

/** Scrubbed environment: no credentials of any kind, so a run that exits 0
 *  with a payload proves the dry-run path needs - and uses - nothing live. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    assert.ok(
      !/TOKEN|SECRET|KEY|DATABASE|DISCORD|STAGING|E2E|PASSWORD/i.test(`${k}=${env[k]}`),
      `scrubbed env leaked a credential-looking variable: ${k}`,
    );
  }
  return env;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: scrubbedEnv(),
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Every `{...}` JSON body block printed after a `POST ...` line. */
function printedBodies(stdout: string): Array<Record<string, unknown>> {
  const blocks = stdout.split('POST /guilds/{guild}/scheduled-events').slice(1);
  assert.ok(blocks.length > 0, 'dry-run should print at least one POST body');
  return blocks.map((block) => {
    const match = block.match(/\{[\s\S]*?\n\}/);
    assert.ok(match, `expected a JSON body in block: ${block.slice(0, 120)}`);
    return JSON.parse(match[0]) as Record<string, unknown>;
  });
}

// --- seeded unit payload -------------------------------------------------------

test('the seeded series payload is the weekly Sunday card the spec names', () => {
  // Run 1: Sunday 23 August 2026, 20:00 America/New_York.
  const payload = scheduledEventPayload(SUNDAY_SQUAD, 1787529600);
  assert.equal(payload.name, 'Sunday Squad');
  assert.equal(payload.channel_id, SUNDAY_SQUAD.channelId);
  assert.equal(payload.entity_type, 2); // VOICE
  assert.equal(payload.privacy_level, 2); // GUILD_ONLY
  assert.equal(payload.scheduled_start_time, '2026-08-24T00:00:00.000Z'); // 23 Aug, 20:00 EDT
  assert.equal(payload.scheduled_end_time, '2026-08-24T01:00:00.000Z'); // 60 minutes
  assert.equal(payload.recurrence_rule.frequency, 2); // WEEKLY
  assert.equal(payload.recurrence_rule.interval, 1);
  assert.deepEqual(payload.recurrence_rule.by_weekday, [6]); // Discord's Sunday
  assert.equal(payload.recurrence_rule.start, payload.scheduled_start_time);
  assert.ok(payload.description.includes('Fall Guys'));
  assert.ok(payload.description.length <= 1000);
});

test('the live-series start used by the script advances past missed runs', () => {
  // The script calls liveSeriesStartEpoch(Date.now()): before run 1 it anchors
  // on run 1, afterwards on the next independently-computed local Sunday.
  assert.equal(liveSeriesStartEpoch(Date.parse('2026-08-22T12:00:00Z')), 1787529600);
  assert.equal(nyClock(liveSeriesStartEpoch(Date.parse('2026-11-02T12:00:00Z'))), '2026-11-08, 20:00');
});

// --- the real script as a subprocess -------------------------------------------

test('dry-run exits 0 with no credentials and prints the expected event payload', async () => {
  const out = await cli(['--dry-run']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /1 request\(s\) that would be sent to Discord/);
  assert.match(out.stdout, /dry run: nothing was sent\./);

  const [body] = printedBodies(out.stdout);
  assert.equal(body!['name'], 'Sunday Squad');
  assert.equal(body!['channel_id'], SUNDAY_SQUAD.channelId);
  assert.equal(body!['entity_type'], 2);
  assert.equal(body!['privacy_level'], 2);
  const rule = body!['recurrence_rule'] as Record<string, unknown>;
  assert.equal(rule['frequency'], 2);
  assert.equal(rule['interval'], 1);
  assert.deepEqual(rule['by_weekday'], [6]);
  assert.equal(rule['start'], body!['scheduled_start_time']);
  assert.ok(String(body!['description']).includes('Fall Guys'));

  // The start is live-derived (Date.now inside the script), so pin its shape,
  // not its value: a Sunday 20:00 America/New_York, ending an hour later.
  const startEpoch = Date.parse(String(body!['scheduled_start_time'])) / 1000;
  const endEpoch = Date.parse(String(body!['scheduled_end_time'])) / 1000;
  assert.ok(Number.isFinite(startEpoch), 'start time parses');
  assert.equal(endEpoch - startEpoch, 3600, 'the event runs an hour');
  const [date, time] = nyClock(startEpoch).split(', ');
  assert.equal(time, '20:00', `dry-run start on ${date} is not 20:00 local`);
  assert.equal(new Date(startEpoch * 1000).getUTCDay(), 1, '20:00 EDT Sunday reads as Monday UTC');
});

test('individual dry-run prints six distinct Sunday payloads with no recurrence rule', async () => {
  const out = await cli(['--dry-run', '--individual']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /6 request\(s\) that would be sent to Discord/);
  assert.match(out.stdout, /dry run: nothing was sent\./);

  const bodies = printedBodies(out.stdout);
  assert.equal(bodies.length, 6);
  assert.equal(new Set(bodies.map((b) => String(b['scheduled_start_time']))).size, 6);
  for (const body of bodies) {
    assert.ok(!('recurrence_rule' in body), 'individual cards carry no recurrence rule');
    assert.equal(body['name'], 'Sunday Squad');
    const startEpoch = Date.parse(String(body['scheduled_start_time'])) / 1000;
    const [, time] = nyClock(startEpoch).split(', ');
    assert.equal(time, '20:00');
  }
});

test('without dry-run and without credentials the script exits 2 with guidance', async () => {
  const out = await cli([]);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stderr + out.stdout, /need DISCORD_BOT_TOKEN/);
  assert.ok(!out.stdout.includes('POST /guilds'), 'no payload without dry-run');
});

// --- static pin: dry-run exits before any network -------------------------------

test('the dry-run exit sits before the credential check and the only fetch', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const dryRunExit = source.indexOf('dry run: nothing was sent.');
  const credentialCheck = source.indexOf('need DISCORD_BOT_TOKEN');
  const firstFetch = source.indexOf('fetch(');
  assert.ok(dryRunExit !== -1 && credentialCheck !== -1 && firstFetch !== -1);
  assert.ok(dryRunExit < credentialCheck, 'dry-run must exit before credentials are required');
  assert.ok(dryRunExit < firstFetch, 'dry-run must exit before any network call');
  // The API base constant is defined at the top but only used through `call`,
  // which sits after the dry-run exit: the printed `POST ...` lines are text,
  // not requests.
  assert.ok(source.indexOf('async function call') > dryRunExit);
});
