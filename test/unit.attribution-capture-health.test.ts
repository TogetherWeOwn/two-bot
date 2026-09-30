import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AttributionFixture } from './helpers/attributionOffline.ts';

const GUILD = 'fixture-guild';
const OTHER = 'other-guild';
const NOW = '2026-09-30T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
const WARNING = 'VOICE IS NOT BEING RECORDED';
const EXPECTED_CSV = [
  'source,clicks,joins,joins_inexact,am7,am7_eligible,am7_voice,am7_messages,am7_message_proxy,am30,am30_eligible,am30_proven_in_window,am30_proven_later',
  'invite:CODE,1,1,0,1,1,1,0,0,1,1,0,1',
  'TOTAL,1,1,0,1,1,1,0,0,1,1,0,1',
].join('\n');

function event(event_type: string, occurred_at: string, guild_id = GUILD): AttributionFixture['events'][number] {
  return { event_type, occurred_at, guild_id, member_id: 'a', source: 'invite:CODE', metadata: null };
}

function fixture(voice: AttributionFixture['events']): AttributionFixture {
  return {
    now: NOW,
    events: [
      event('member_join', '2026-07-31T12:00:00.000Z'),
      event('invite_click', '2026-07-31T12:00:00.000Z'),
      ...voice,
    ],
    members: [{
      guild_id: GUILD, member_id: 'a', first_message_at: null, third_message_at: null,
      first_voice_at: OLD, last_active_at: NOW, left_at: null, is_bot: 0,
    }],
  };
}

function attribution(data: AttributionFixture, csv = false): string {
  const child = spawnSync(process.execPath, [
    '--import', new URL('./helpers/attributionOffline.ts', import.meta.url).href,
    fileURLToPath(new URL('../scripts/attribution.ts', import.meta.url)),
    'all', ...(csv ? ['--csv'] : []),
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      TWO_DATABASE_URL: 'fixture-not-a-database',
      DISCORD_GUILD_ID: GUILD,
      ATTRIBUTION_TEST_FIXTURE: JSON.stringify(data),
    },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return child.stdout;
}

function checkCounts(data: AttributionFixture, text: string) {
  assert.equal(attribution(data, true).trim(), EXPECTED_CSV);
  assert.match(text, /TOTAL\s+1\s+1\s+1\s*\/\s*1\s+\(100%\)\s+1\s*\/\s*1\s+\(100%\)/);
  assert.match(text, /1 real members\. Discord shows 1/);
}

test('old first-ever voice plus a fresh repeat session suppresses the outage banner', () => {
  const data = fixture([event('first_voice_session', OLD), event('voice_session_start', NOW)]);
  const text = attribution(data);
  assert.ok(!text.includes(WARNING), text);
  checkCounts(data, text);
});

test('truly stale repeat voice with fresh text activity still warns', () => {
  const data = fixture([event('first_voice_session', OLD), event('voice_session_start', OLD)]);
  data.members[0]!.first_message_at = NOW;
  const text = attribution(data);
  assert.ok(text.includes(WARNING), text);
  assert.match(text, /Newest voice session on file: 2026-08-01, 60 days ago/);
  assert.match(text, /Newest activity of any kind: 2026-09-30, 0 days ago/);
  checkCounts(data, text);
});

test('no recorded voice events still warns even with an old member milestone', () => {
  const data = fixture([]);
  const text = attribution(data);
  assert.ok(text.includes(WARNING), text);
  assert.match(text, /No voice session has ever been recorded/);
  checkCounts(data, text);
});

test('old first-ever voice plus a fresh session end suppresses the outage banner', () => {
  const data = fixture([event('first_voice_session', OLD), event('voice_session_start', OLD), event('voice_session_end', NOW)]);
  const text = attribution(data);
  assert.ok(!text.includes(WARNING), text);
  checkCounts(data, text);
});

test('fresh foreign-guild voice cannot hide the target guild capture gap', () => {
  const data = fixture([event('first_voice_session', OLD), event('voice_session_start', OLD)]);
  const baseline = attribution(data);
  data.events.push(event('voice_session_start', NOW, OTHER), event('voice_session_end', NOW, OTHER), event('first_voice_session', NOW, OTHER));
  const text = attribution(data);
  assert.ok(text.includes(WARNING), text);
  assert.equal(text, baseline);
  checkCounts(data, text);
});

test('historical first-ever voice remains a diagnostic signal without repeat rows', () => {
  const data = fixture([event('first_voice_session', NOW)]);
  const text = attribution(data);
  assert.ok(!text.includes(WARNING), text);
  checkCounts(data, text);
});

test('equally quiet voice and overall activity do not imply a capture outage', () => {
  const data = fixture([event('first_voice_session', OLD), event('voice_session_start', OLD)]);
  data.members[0]!.last_active_at = OLD;
  const text = attribution(data);
  assert.ok(!text.includes(WARNING), text);
});
