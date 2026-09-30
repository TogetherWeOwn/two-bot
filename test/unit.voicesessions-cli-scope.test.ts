/** Guild isolation through the real CLI and a predicate-sensitive fake Db. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { VoiceReportEvent } from './helpers/voiceReportDbFixture.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/voice-sessions.ts', import.meta.url));
const FIXTURE = new URL('./helpers/voiceReportDbFixture.ts', import.meta.url).href;
const GUILD = 'voice-report-target';
const FOREIGN = 'voice-report-foreign';
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

function event(
  guild: string,
  type: string,
  member: string | null,
  hoursAgo: number,
  recordedHoursAgo = hoursAgo,
  metadata: object | null = null,
): VoiceReportEvent {
  return {
    guild_id: guild,
    event_type: type,
    member_id: member,
    occurred_at: at(hoursAgo),
    recorded_at: at(recordedHoursAgo),
    source: 'channel:fixture',
    metadata: metadata === null ? null : JSON.stringify(metadata),
  };
}

function targetRows(): VoiceReportEvent[] {
  return [
    ...[30, 29, 28, 18].map((h) => event(GUILD, 'first_message', 'hb', h)),
    event(GUILD, 'voice_session_start', 'm1', 25, 20),
    event(GUILD, 'voice_session_start', 'm1', 23, 20),
    event(GUILD, 'voice_session_start', 'm2', 22, 20),
    event(GUILD, 'voice_session_start', 'm3', 21, 20),
    event(GUILD, 'voice_session_start', null, 21, 20),
    event(GUILD, 'voice_session_end', 'm1', 24.8, 20, { startKnown: true, durationSeconds: 600 }),
    event(GUILD, 'voice_session_end', 'm1', 22.5, 19, { startKnown: true, durationSeconds: 1800 }),
    event(GUILD, 'voice_session_end', 'm2', 21.5, 20, { startKnown: false, durationSeconds: null }),
    event(GUILD, 'voice_session_end', 'm4', 19, 19, { startKnown: false, durationSeconds: 3600 }),
    event(GUILD, 'voice_session_start', 'old', 100 * 24),
    event(GUILD, 'voice_session_end', 'old', 100 * 24, 100 * 24, {
      startKnown: true, durationSeconds: 90_000,
    }),
  ];
}

function foreignRows(): VoiceReportEvent[] {
  return [
    // Same member IDs across guilds must not promote m1 to a regular or alter
    // m1's duration. A separate foreign member also tests distinct-member counts.
    ...[25, 24, 23, 22].map((h) => event(FOREIGN, 'voice_session_start', 'm1', h)),
    event(FOREIGN, 'voice_session_start', 'foreign-only', 1),
    event(FOREIGN, 'voice_session_end', 'm1', 20, 20, { startKnown: true, durationSeconds: 86_400 }),
    event(FOREIGN, 'voice_session_end', 'm2', 19, 19, { startKnown: false, durationSeconds: 360_000 }),
    // These writes fill the target's eight-hour blind window if unscoped.
    ...[27, 26, 25, 24, 23, 22, 21].map((h) => event(FOREIGN, 'first_message', 'hb', h)),
    event(FOREIGN, 'voice_session_start', 'old', 120 * 24),
  ];
}

async function cli(events: VoiceReportEvent[], guild: string | null = GUILD) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TWO_DATABASE_URL: 'fixture://voice-report',
    VOICE_REPORT_EVENTS: JSON.stringify(events),
  };
  if (guild === null) delete env.DISCORD_GUILD_ID;
  else env.DISCORD_GUILD_ID = guild;
  try {
    const out = await run(process.execPath, ['--import', FIXTURE, SCRIPT, '2', '--offset=-5'], {
      env,
      timeout: 10_000,
    });
    return { code: 0, ...out };
  } catch (error) {
    const out = error as { code?: number; stdout?: string; stderr?: string };
    return { code: out.code ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  }
}

function assertOpenedAndClosed(out: Awaited<ReturnType<typeof cli>>) {
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stderr, 'fixture: openDb\nfixture: close\n');
}

test('foreign starts, ends and writes cannot alter any target voice-report number', async () => {
  const baseline = await cli(targetRows());
  const mixed = await cli([...targetRows(), ...foreignRows()], `  ${GUILD}\t`);
  assertOpenedAndClosed(baseline);
  assertOpenedAndClosed(mixed);
  assert.equal(mixed.stdout, baseline.stdout, 'the entire report must be guild-invariant');

  assert.match(baseline.stdout, /\n\s+4\s+sessions\n/);
  assert.match(baseline.stdout, /\n\s+3\s+distinct members\n/);
  assert.match(baseline.stdout, /\n\s+2\s+came once and not again\n/);
  assert.match(baseline.stdout, /\n\s+1\s+came 2-3 times\n/);
  assert.match(baseline.stdout, /\n\s+0\s+came 4\+ times/);
  assert.match(baseline.stdout, /20m over 2 measured session\(s\); 2 unknown-start session\(s\) excluded/);
  assert.ok(baseline.stdout.includes(
    `Blind window ${at(28)} -> ${at(20)} (8.0h gap): 2 session(s) with unknown start`,
  ));
  const cells = Array.from({ length: 24 }, (_, h) =>
    ([6, 8, 9, 10].includes(h) ? '1' : '.').padStart(3),
  ).join('');
  assert.ok(baseline.stdout.includes(`    Tue${cells}\n`), 'pin the offset day/hour grid');
  assert.ok(!baseline.stdout.includes('windows derived from session starts'));
});

test('empty-window all-time counts remain scoped when foreign sessions are recent', async () => {
  const oldTarget = [
    event(GUILD, 'voice_session_start', 'old', 100 * 24),
    event(GUILD, 'first_message', 'old', 100 * 24),
    event(GUILD, 'first_message', 'recent', 1),
  ];
  const baseline = await cli(oldTarget);
  const mixed = await cli([...oldTarget, ...foreignRows()]);
  assertOpenedAndClosed(baseline);
  assertOpenedAndClosed(mixed);
  assert.equal(mixed.stdout, baseline.stdout);
  assert.match(mixed.stdout, /No voice sessions on file for this window/);
  assert.match(mixed.stdout, /voice_session_start rows, all time: 1/);
  assert.match(mixed.stdout, /events on file, all time:\s+3/);
});

test('a guild with no events remains empty even if other guilds have voice history', async () => {
  const baseline = await cli([]);
  const mixed = await cli(foreignRows());
  assertOpenedAndClosed(baseline);
  assertOpenedAndClosed(mixed);
  assert.equal(mixed.stdout, baseline.stdout);
  assert.match(mixed.stdout, /voice_session_start rows, all time: 0/);
  assert.match(mixed.stdout, /events on file, all time:\s+0/);
});

for (const guild of [null, '', ' \t\n ']) {
  test(`missing/empty guild ${JSON.stringify(guild)} refuses before openDb`, async () => {
    const out = await cli(foreignRows(), guild);
    assert.equal(out.code, 1);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, 'voice-sessions: DISCORD_GUILD_ID is not set.\n');
    assert.ok(!out.stderr.includes('fixture: openDb'));
  });
}
