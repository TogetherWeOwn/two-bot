// TOG-7185. Staging-only live-event alert: log, never post.
//
// Acceptance: a simulated live event produces exactly one log entry, and the
// channel-post code path never executes (asserted with a poster that throws
// if called). A repeat detection logs nothing; a non-staging guild throws
// before the sink or the poster is touched.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStagingLiveEventGuild,
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

// --- TOG-9122: thin-coverage backfill -------------------------------------------
// liveEventAlert.ts is one detection-to-log path: it has no schedule/change/
// cancel state machine and no disabled flag, so the new tests below pin its
// real branches instead — record shaping, refuse-before-touch validation,
// dedup/no-second-send, and never-post. Hermetic by construction: node:test +
// assert only, in-memory sinks except where the file sink itself is the
// subject, a fetch trap that fails the run on any real network call, and every
// poster is an exploding stub whose call count is asserted zero.

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9122: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function countingPoster(counter: { calls: number }) {
  return async () => {
    counter.calls++;
    return explodingPoster();
  };
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

// --- TOG-9122 backfill: shaping, validation, dedup, never-post ------------------

test('omitted optional fields shape to null and the name is trimmed', async () => {
  const logged: LiveEventAlertRecord[] = [];
  const poster = { calls: 0 };
  const result = await handleLiveEventAlert(
    { guildId: STAGING_GUILD, eventId: EVENT_ID, eventName: '  Sunday Squad  ' },
    {
      sink: (record: LiveEventAlertRecord) => {
        logged.push(record);
      },
      poster: countingPoster(poster),
      channelId: '333333333333333333',
      now: () => DETECTED_AT,
    },
  );
  assert.deepEqual(result, { logged: true, posted: false, duplicate: false });
  assert.equal(poster.calls, 0);
  assert.deepEqual(logged, [
    {
      kind: 'live_event_alert',
      environment: 'staging',
      guildId: STAGING_GUILD,
      eventId: EVENT_ID,
      eventName: 'Sunday Squad',
      scheduledStartTime: null,
      voiceChannelId: null,
      detectedAt: DETECTED_AT,
    },
  ]);
});

test('explicit null optionals stay null in the record', async () => {
  const logged: LiveEventAlertRecord[] = [];
  const poster = { calls: 0 };
  await handleLiveEventAlert(
    {
      guildId: STAGING_GUILD,
      eventId: EVENT_ID,
      eventName: 'Sunday Squad',
      scheduledStartTime: null,
      voiceChannelId: null,
    },
    {
      sink: (record: LiveEventAlertRecord) => {
        logged.push(record);
      },
      poster: countingPoster(poster),
      now: () => DETECTED_AT,
    },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.scheduledStartTime, null);
  assert.equal(logged[0]!.voiceChannelId, null);
  assert.equal(poster.calls, 0);
});

test('non-snowflake event id throws before the sink or poster is touched', async () => {
  for (const eventId of ['event-1', '123', '']) {
    let sinkCalls = 0;
    const poster = { calls: 0 };
    await assert.rejects(
      () =>
        handleLiveEventAlert(
          { guildId: STAGING_GUILD, eventId, eventName: 'Sunday Squad' },
          {
            sink: () => {
              sinkCalls++;
            },
            poster: countingPoster(poster),
            now: () => DETECTED_AT,
          },
        ),
      /Discord id/,
    );
    assert.equal(sinkCalls, 0, `sink touched for event id ${JSON.stringify(eventId)}`);
    assert.equal(poster.calls, 0, `poster touched for event id ${JSON.stringify(eventId)}`);
  }
});

test('blank event name throws before the sink or poster is touched', async () => {
  for (const eventName of ['', '   ']) {
    let sinkCalls = 0;
    const poster = { calls: 0 };
    await assert.rejects(
      () =>
        handleLiveEventAlert(
          { guildId: STAGING_GUILD, eventId: EVENT_ID, eventName },
          {
            sink: () => {
              sinkCalls++;
            },
            poster: countingPoster(poster),
            now: () => DETECTED_AT,
          },
        ),
      /must not be blank/,
    );
    assert.equal(sinkCalls, 0, `sink touched for name ${JSON.stringify(eventName)}`);
    assert.equal(poster.calls, 0, `poster touched for name ${JSON.stringify(eventName)}`);
  }
});

test('distinct events each log once; a repeat dedupes without a second send', async () => {
  const logged: LiveEventAlertRecord[] = [];
  let sinkCalls = 0;
  const poster = { calls: 0 };
  const deps = {
    sink: (record: LiveEventAlertRecord) => {
      sinkCalls++;
      logged.push(record);
    },
    poster: countingPoster(poster),
    seenEventIds: new Set<string>(),
    now: () => DETECTED_AT,
  };
  const otherId = '222222222222222222';
  assert.deepEqual(
    await handleLiveEventAlert({ guildId: STAGING_GUILD, eventId: EVENT_ID, eventName: 'A' }, deps),
    { logged: true, posted: false, duplicate: false },
  );
  assert.deepEqual(
    await handleLiveEventAlert({ guildId: STAGING_GUILD, eventId: otherId, eventName: 'B' }, deps),
    { logged: true, posted: false, duplicate: false },
    'a different event id is not a duplicate',
  );
  assert.deepEqual(
    await handleLiveEventAlert({ guildId: STAGING_GUILD, eventId: EVENT_ID, eventName: 'A' }, deps),
    { logged: false, posted: false, duplicate: true },
  );
  assert.equal(sinkCalls, 2, 'the repeat must not reach the sink again');
  assert.equal(logged.length, 2);
  assert.equal(poster.calls, 0, 'no detection may reach the channel-post path');
});

test('assertStagingLiveEventGuild accepts staging and refuses anything else', () => {
  assert.doesNotThrow(() => assertStagingLiveEventGuild(STAGING_GUILD));
  assert.throws(() => assertStagingLiveEventGuild('326474832151838730'), /staging-only/);
  assert.throws(() => assertStagingLiveEventGuild(''), /staging-only/);
});

test('file sink appends one JSON line per alert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tog-9122-'));
  const evidence = join(dir, 'live-event-alerts.jsonl');
  const sink = fileLiveEventAlertSink(evidence);
  const poster = { calls: 0 };
  const deps = {
    sink,
    poster: countingPoster(poster),
    seenEventIds: new Set<string>(),
    now: () => DETECTED_AT,
  };
  await handleLiveEventAlert({ guildId: STAGING_GUILD, eventId: EVENT_ID, eventName: 'A' }, deps);
  await handleLiveEventAlert(
    { guildId: STAGING_GUILD, eventId: '222222222222222222', eventName: 'B' },
    deps,
  );
  const lines = readFileSync(evidence, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]!) as LiveEventAlertRecord).eventName, 'A');
  assert.equal((JSON.parse(lines[1]!) as LiveEventAlertRecord).eventName, 'B');
  assert.equal(poster.calls, 0);
});

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every sink and poster in this file is a fake');
});
