/**
 * The Sunday Squad recurrence and copy.
 *
 * The cases here are the ones that would actually publish something wrong: an
 * occurrence an hour out after the clocks change, a series anchored on run 2
 * instead of run 1, and a member being told about next Sunday while the event
 * is running in the room they are reading.
 *
 * Every expected epoch below is one the Community Manager published on TOG-93,
 * so this file is a check against the spec and not against my own arithmetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEAR_EVENT_MS,
  SUNDAY_SQUAD,
  anchorWelcomeText,
  individualEventPayloads,
  liveSeriesStartEpoch,
  nextOccurrenceMs,
  occurrenceContext,
  occurrencesFrom,
  scheduledEventPayload,
  zonedEpochMs,
} from '../src/onboarding/anchorEvent.ts';

const MEMBER = '<@900000000000007777>';
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

const ms = (iso: string) => Date.parse(iso);

// --- the six epochs the CM published -----------------------------------------

test('the first six occurrences are the ones the spec names', () => {
  // Standing just before run 1: Saturday 22 August 2026.
  const got = occurrencesFrom(ms('2026-08-22T12:00:00Z'), 6);
  assert.deepEqual(got, [
    1787529600, // Sun 23 Aug
    1788134400, // Sun 30 Aug
    1788739200, // Sun 6 Sep
    1789344000, // Sun 13 Sep
    1789948800, // Sun 20 Sep
    1790553600, // Sun 27 Sep
  ]);
});

test('the series starts on run 1, not run 2', () => {
  // The trap named in the spec: 1788134400 is 30 August and is run 2. A series
  // anchored there puts the sidebar card a week behind every actual run.
  assert.equal(SUNDAY_SQUAD.seriesStartEpoch, 1787529600);
  assert.equal(nyClock(SUNDAY_SQUAD.seriesStartEpoch), '2026-08-23, 20:00');
});

// --- the DST case this issue exists for --------------------------------------

test('every occurrence is 20:00 in New York, on both sides of the DST change', () => {
  // A year of Sundays from before the change to after the spring one.
  let cursor = ms('2026-10-01T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    const next = nextOccurrenceMs(cursor);
    const [date, time] = nyClock(Math.floor(next / 1000)).split(', ');
    assert.equal(time, '20:00', `occurrence on ${date} is not 20:00 local`);
    assert.equal(new Date(next).getUTCDay() === 0 || new Date(next).getUTCDay() === 1, true);
    cursor = next;
  }
});

test('the week US DST ends does not drift', () => {
  // 25 Oct is EDT (UTC-4), 1 Nov is EST (UTC-5). Adding 604800 seconds to the
  // 25 Oct instant gives 1793577600 - which is 19:00 local, an hour early, and
  // is exactly the bug the spec warns about.
  const beforeChange = occurrencesFrom(ms('2026-10-20T00:00:00Z'), 1)[0];
  const afterChange = occurrencesFrom(ms('2026-10-27T00:00:00Z'), 1)[0];

  assert.equal(nyClock(beforeChange), '2026-10-25, 20:00');
  assert.equal(nyClock(afterChange), '2026-11-01, 20:00');

  assert.equal(afterChange - beforeChange, 608_400, 'the DST week is 169 hours, not 168');
  assert.notEqual(afterChange, beforeChange + 604_800);
});

test('zonedEpochMs resolves a wall time on the changeover day itself', () => {
  // 1 November 2026: the clocks go back at 02:00 local. 20:00 that evening is
  // EST, so the naive first guess lands on the wrong side of the boundary and
  // only the second pass is right.
  assert.equal(zonedEpochMs(2026, 11, 1, 20, 0, TZ) / 1000, 1793581200);
  assert.equal(nyClock(1793581200), '2026-11-01, 20:00');

  // The same on the spring-forward Sunday, where the offset moves the other way.
  assert.equal(zonedEpochMs(2026, 3, 8, 20, 0, TZ) / 1000, 1773014400);
  assert.equal(nyClock(1773014400), '2026-03-08, 20:00');
});

test('an occurrence exactly on the boundary is not skipped or repeated', () => {
  const runOne = SUNDAY_SQUAD.seriesStartEpoch * 1000;
  // Standing one millisecond before the start, run 1 is still ahead of us.
  assert.equal(nextOccurrenceMs(runOne - 1), runOne);
  // Standing exactly on it, "next" has moved on - the current one is handled by
  // occurrenceContext, not by nextOccurrenceMs.
  assert.equal(nextOccurrenceMs(runOne), runOne + 604_800_000);
});

// --- which occurrence, and in which voice ------------------------------------

test('a quiet Wednesday gets the normal copy and the next Sunday', () => {
  const ctx = occurrenceContext(ms('2026-08-26T15:00:00Z')); // Wed 26 Aug
  assert.equal(ctx.startEpoch, 1788134400); // Sun 30 Aug
  assert.equal(ctx.near, false);
  assert.equal(ctx.live, false);
});

test('two hours before is the boundary the spec names', () => {
  const start = 1787529600 * 1000;

  const justOutside = occurrenceContext(start - NEAR_EVENT_MS);
  assert.equal(justOutside.near, false, 'exactly two hours out is not "less than two hours"');

  const justInside = occurrenceContext(start - NEAR_EVENT_MS + 1);
  assert.equal(justInside.near, true);
  assert.equal(justInside.startEpoch, 1787529600);
});

test('a member who joins mid-event is told about that event, not next week', () => {
  // 20:30 local on run 1. The literal "less than two hours before" rule alone
  // would name 30 August here, while Sunday Squad is audibly running in the
  // room the message is posted in.
  const ctx = occurrenceContext(1787529600 * 1000 + 30 * 60_000);
  assert.equal(ctx.startEpoch, 1787529600);
  assert.equal(ctx.live, true);
  assert.equal(ctx.near, true);
});

test('once the hour is up we are back to the normal copy', () => {
  const ctx = occurrenceContext(1787529600 * 1000 + 60 * 60_000); // 21:00 exactly
  assert.equal(ctx.startEpoch, 1788134400);
  assert.equal(ctx.live, false);
  assert.equal(ctx.near, false);
});

// --- the copy ----------------------------------------------------------------

test('the normal welcome is the spec string, and nothing else', () => {
  const text = anchorWelcomeText(MEMBER, ms('2026-08-26T15:00:00Z'));
  assert.equal(
    text,
    [
      `Hey ${MEMBER} — glad you're here.`,
      '',
      'The thing to know: **Sunday Squad**, every Sunday at 8pm Eastern in <#1175127344072118405>. We play Fall Guys for about an hour. Next one is <t:1788134400:R>.',
      '',
      "You don't need to sign up or say anything first — just join the voice room and I'll get you into the party. Haven't got Fall Guys? Come anyway, there's something we can play right there in the room. If you can't make Sunday, hop in whenever and see who's about.",
    ].join('\n'),
  );
});

test('the near-event variant replaces the second paragraph and only that', () => {
  const near = anchorWelcomeText(MEMBER, 1787529600 * 1000 - 60 * 60_000).split('\n\n');
  const normal = anchorWelcomeText(MEMBER, ms('2026-08-26T15:00:00Z')).split('\n\n');

  assert.equal(near.length, 3);
  assert.equal(near[0], normal[0], 'first paragraph should be untouched');
  assert.equal(near[2], normal[2], 'third paragraph should be untouched');
  assert.equal(
    near[1],
    "The thing to know: **Sunday Squad** is happening right now in <#1175127344072118405> — Fall Guys, for about another hour. Come say hi. You don't need it installed to join in.",
  );
});

test('the welcome names a live relative timestamp, never a written-out date', () => {
  const text = anchorWelcomeText(MEMBER, ms('2026-11-20T15:00:00Z'));
  assert.match(text, /<t:\d{10}:R>/);
  // A hardcoded date would still read correctly on the day it was written and
  // be wrong forever after, so assert the year is nowhere in the string.
  assert.doesNotMatch(text, /2026|2027|August|November/);
});

test('the welcome pings the member and nothing else', () => {
  const text = anchorWelcomeText(MEMBER, ms('2026-08-26T15:00:00Z'));
  assert.doesNotMatch(text, /@everyone|@here|<@&/);
  assert.equal(text.match(/<@\d+>/g)?.length, 1);
});

test('the welcome fits in one Discord message', () => {
  assert.ok(anchorWelcomeText(MEMBER, ms('2026-08-26T15:00:00Z')).length <= 2000);
});

// --- the scheduled event -----------------------------------------------------

test('the live series starts on run 1 before launch, then advances past missed runs', () => {
  assert.equal(liveSeriesStartEpoch(ms('2026-08-22T12:00:00Z')), 1787529600);
  assert.equal(liveSeriesStartEpoch(ms('2026-09-06T00:00:00Z')), 1788739200);
  assert.equal(nyClock(liveSeriesStartEpoch(ms('2026-11-02T12:00:00Z'))), '2026-11-08, 20:00');
});

test('the scheduled event is a weekly Sunday series anchored on run 1', () => {
  const p = scheduledEventPayload();
  assert.equal(p.name, 'Sunday Squad');
  assert.equal(p.channel_id, '1175127344072118405');
  assert.equal(p.entity_type, 2); // VOICE
  assert.equal(p.privacy_level, 2); // GUILD_ONLY
  assert.equal(p.scheduled_start_time, '2026-08-24T00:00:00.000Z'); // 23 Aug, 20:00 EDT
  assert.equal(p.scheduled_end_time, '2026-08-24T01:00:00.000Z'); // 60 minutes
  assert.equal(p.recurrence_rule.frequency, 2); // WEEKLY
  assert.equal(p.recurrence_rule.interval, 1);
  assert.deepEqual(p.recurrence_rule.by_weekday, [6]); // Discord's Sunday
  assert.equal(p.recurrence_rule.start, p.scheduled_start_time);
  assert.ok(p.description.includes('Fall Guys'));
  assert.ok(p.description.length <= 1000);
});

test('the fallback creates six real occurrences, not six copies of one', () => {
  const payloads = individualEventPayloads(ms('2026-08-22T12:00:00Z'), 6);
  assert.equal(payloads.length, 6);
  assert.equal(new Set(payloads.map((p) => p.scheduled_start_time)).size, 6);
  for (const p of payloads) {
    assert.ok(!('recurrence_rule' in p));
    const [, time] = nyClock(Date.parse(p.scheduled_start_time) / 1000).split(', ');
    assert.equal(time, '20:00');
  }
});

test('the fallback also holds across the DST change', () => {
  const dates = individualEventPayloads(ms('2026-10-20T00:00:00Z'), 3).map(
    (p) => nyClock(Date.parse(p.scheduled_start_time) / 1000),
  );
  assert.deepEqual(dates, ['2026-10-25, 20:00', '2026-11-01, 20:00', '2026-11-08, 20:00']);
});

// --- host independence -------------------------------------------------------

test('the answer does not depend on the box the bot runs on', () => {
  // The production host is UTC and my machine is not. Anything that reads
  // process-local time would pass here and fail there, or the reverse.
  const original = process.env.TZ;
  const answers = new Set<string>();
  for (const tz of ['UTC', 'America/Los_Angeles', 'Australia/Sydney', 'Europe/London']) {
    process.env.TZ = tz;
    answers.add(occurrencesFrom(ms('2026-10-27T00:00:00Z'), 3).join(','));
  }
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
  assert.equal(answers.size, 1, `host timezone changed the answer: ${[...answers].join(' | ')}`);
});
