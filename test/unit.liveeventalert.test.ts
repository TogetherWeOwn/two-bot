// TOG-7185. Staging-only live-event alert: log, never post.
//
// Acceptance: a simulated live event produces exactly one log entry, and the
// channel-post code path never executes (asserted with a poster that throws
// if called). A repeat detection logs nothing; a non-staging guild throws
// before the sink or the poster is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileLiveEventAlertSink,
  handleLiveEventAlert,
  type LiveEventAlertRecord,
} from '../src/live/liveEventAlert.ts';

// Written out rather than imported from spec.ts, so a mutated constant in src
// cannot drag the expectation along with it.
const STAGING_GUILD = '1545644954272137297';
const EVENT_ID = '111111111111111111';
const DETECTED_AT = '2026-09-27T19:30:00.000Z';

function explodingPoster(): never {
  throw new Error('channel post code path must never execute in staging');
}

test('simulated live event writes exactly one log entry and never posts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tog-7185-'));
  const evidence = join(dir, 'live-event-alerts.jsonl');
  let posterCalls = 0;
  const result = await handleLiveEventAlert(
    {
      guildId: STAGING_GUILD,
      eventId: EVENT_ID,
      eventName: 'Sunday Squad',
      scheduledStartTime: '2026-09-28T18:00:00.000Z',
      voiceChannelId: '222222222222222222',
    },
    {
      sink: fileLiveEventAlertSink(evidence),
      poster: async () => {
        posterCalls++;
        return explodingPoster();
      },
      channelId: '333333333333333333',
      seenEventIds: new Set(),
      now: () => DETECTED_AT,
    },
  );
  assert.deepEqual(result, { logged: true, posted: false, duplicate: false });
  assert.equal(posterCalls, 0);
  const lines = readFileSync(evidence, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as LiveEventAlertRecord;
  assert.deepEqual(record, {
    kind: 'live_event_alert',
    environment: 'staging',
    guildId: STAGING_GUILD,
    eventId: EVENT_ID,
    eventName: 'Sunday Squad',
    scheduledStartTime: '2026-09-28T18:00:00.000Z',
    voiceChannelId: '222222222222222222',
    detectedAt: DETECTED_AT,
  });
});

test('repeat detection for the same event logs nothing and posts nothing', async () => {
  const logged: LiveEventAlertRecord[] = [];
  let posterCalls = 0;
  const deps = {
    sink: (record: LiveEventAlertRecord) => {
      logged.push(record);
    },
    poster: async () => {
      posterCalls++;
      return explodingPoster();
    },
    seenEventIds: new Set<string>(),
    now: () => DETECTED_AT,
  };
  const detection = { guildId: STAGING_GUILD, eventId: EVENT_ID, eventName: 'Sunday Squad' };
  assert.deepEqual(await handleLiveEventAlert(detection, deps), {
    logged: true,
    posted: false,
    duplicate: false,
  });
  assert.deepEqual(await handleLiveEventAlert(detection, deps), {
    logged: false,
    posted: false,
    duplicate: true,
  });
  assert.equal(logged.length, 1);
  assert.equal(posterCalls, 0);
});

test('non-staging guild throws before the sink or poster is touched', async () => {
  let sinkCalls = 0;
  let posterCalls = 0;
  await assert.rejects(
    () =>
      handleLiveEventAlert(
        { guildId: '326474832151838730', eventId: EVENT_ID, eventName: 'Sunday Squad' },
        {
          sink: () => {
            sinkCalls++;
          },
          poster: async () => {
            posterCalls++;
            return explodingPoster();
          },
          now: () => DETECTED_AT,
        },
      ),
    /staging-only/,
  );
  assert.equal(sinkCalls, 0);
  assert.equal(posterCalls, 0);
});
