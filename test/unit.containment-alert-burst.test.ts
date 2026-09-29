import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertBurstThrottle,
  STAFF_ALERT_BURST_MAX_BUFFERED,
  STAFF_ALERT_BURST_MAX_SENDS,
  STAFF_ALERT_BURST_WINDOW_MS,
  summarizeContainmentBurst,
  summarizeJoinRiskBurst,
  throttledContainmentAnnouncer,
  throttledJoinRiskAnnouncer,
} from '../src/moderation/containmentAlert.ts';
import type { ContainmentAlert, JoinRiskAlert } from '../src/moderation/containment.ts';

const GUILD = '1545644954272137297';
const OTHER_GUILD = '326474832151838730';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function joinFlag(memberId: string, score = 3, reasons = ['account younger than 24 hours']): JoinRiskAlert {
  return { guildId: GUILD, memberId, score, reasons, bulkJoinWindow: false };
}

function containmentAlert(
  executorId: string | null,
  outcome = 'contained',
  heat = 6,
): ContainmentAlert {
  return {
    kind: 'containment',
    guildId: GUILD,
    executorId,
    action: 'channel.delete',
    targetId: '222222222222222222',
    heat,
    threshold: 5,
    outcome,
  };
}

function stringThrottle() {
  let clock = NOW;
  const throttle = new AlertBurstThrottle<string>({
    now: () => clock,
    keyOf: () => GUILD,
    summarize: (_guild, sample, total) => `digest(${total}):${sample.length}`,
  });
  return { throttle, advance: (ms: number) => { clock += ms; } };
}

test('a raid-scale join burst yields bounded sends plus one digest', async () => {
  const sent: JoinRiskAlert[] = [];
  const announcer = throttledJoinRiskAnnouncer(async (alert) => void sent.push(alert), {
    now: () => NOW,
  });
  for (let index = 0; index < 50; index++) {
    await announcer.announce(joinFlag(`member-${index}`));
  }
  assert.equal(
    sent.length,
    STAFF_ALERT_BURST_MAX_SENDS,
    `50-flag burst forwards exactly ${STAFF_ALERT_BURST_MAX_SENDS}, got ${sent.length}`,
  );
  assert.equal(announcer.pendingCount(GUILD), 50 - STAFF_ALERT_BURST_MAX_SENDS);

  await announcer.flush();
  assert.equal(sent.length, STAFF_ALERT_BURST_MAX_SENDS + 1, 'flush adds exactly one digest');
  const digest = sent[sent.length - 1];
  assert.equal(announcer.pendingCount(GUILD), 0, 'flush drains the backlog');
  assert.match(digest.note ?? '', new RegExp(`${50 - STAFF_ALERT_BURST_MAX_SENDS} join-risk flag\\(s\\)`));
  assert.match(digest.note ?? '', /50 member\(s\)|member\(s\)/);
  assert.match(digest.reasons.join(' '), /join_risk_flags/, 'digest names where the detail lives');
  assert.equal(digest.score, 3, 'digest keeps the peak score');
});

test('sustained spam across windows stays bounded', () => {
  const { throttle, advance } = stringThrottle();
  let forwarded = 0;
  const windows = 3;
  for (let window = 0; window < windows; window++) {
    for (let index = 0; index < 40; index++) forwarded += throttle.admit(`w${window}-a${index}`).length;
    advance(STAFF_ALERT_BURST_WINDOW_MS);
  }
  // Final window rolls over only on the next admit; flush the pending digest.
  forwarded += throttle.flush().length;
  assert.ok(
    forwarded <= windows * (STAFF_ALERT_BURST_MAX_SENDS + 1),
    `120 alerts over 3 windows forward at most ${windows * (STAFF_ALERT_BURST_MAX_SENDS + 1)}, got ${forwarded}`,
  );
  assert.equal(throttle.pendingCount(), 0);
});

test('window rollover delivers the pending digest before resuming', () => {
  const { throttle, advance } = stringThrottle();
  const first: string[] = [];
  for (let index = 0; index < 5; index++) first.push(...throttle.admit(`a${index}`));
  assert.deepEqual(first.slice(0, STAFF_ALERT_BURST_MAX_SENDS), ['a0', 'a1', 'a2']);
  assert.equal(first.length, STAFF_ALERT_BURST_MAX_SENDS);

  advance(STAFF_ALERT_BURST_WINDOW_MS);
  const rolled = throttle.admit('fresh');
  assert.equal(rolled.length, 2, 'digest for the old window, then the fresh alert');
  assert.match(rolled[0], /digest\(2\):2/);
  assert.equal(rolled[1], 'fresh');
});

test('budgets are per guild: one raided guild cannot eat another', () => {
  let clock = NOW;
  const throttle = new AlertBurstThrottle<string>({
    now: () => clock,
    keyOf: (alert) => alert.split(':')[0],
    summarize: (_guild, _sample, total) => `digest(${total})`,
  });
  for (let index = 0; index < 20; index++) throttle.admit(`${GUILD}:a${index}`);
  const quiet: string[] = [];
  for (let index = 0; index < STAFF_ALERT_BURST_MAX_SENDS; index++) {
    quiet.push(...throttle.admit(`${OTHER_GUILD}:b${index}`));
  }
  assert.equal(quiet.length, STAFF_ALERT_BURST_MAX_SENDS, 'quiet guild keeps its own budget');
  assert.equal(throttle.pendingCount(OTHER_GUILD), 0);
  assert.equal(throttle.pendingCount(GUILD), 20 - STAFF_ALERT_BURST_MAX_SENDS);
});

test('buffer cap keeps memory bounded while the digest count stays exact', () => {
  const { throttle } = stringThrottle();
  const burst = STAFF_ALERT_BURST_MAX_SENDS + STAFF_ALERT_BURST_MAX_BUFFERED + 50;
  for (let index = 0; index < burst; index++) throttle.admit(`a${index}`);
  const [digest] = throttle.flush();
  assert.match(digest, new RegExp(`digest\\(${burst - STAFF_ALERT_BURST_MAX_SENDS}\\):${STAFF_ALERT_BURST_MAX_BUFFERED}`));
});

test('containment burst digest keeps worst outcome, peak heat, and executors', async () => {
  const sent: ContainmentAlert[] = [];
  const announcer = throttledContainmentAnnouncer(async (alert) => void sent.push(alert), {
    now: () => NOW,
  });
  await announcer.announce(containmentAlert('111111111111111111', 'dry_run', 5));
  await announcer.announce(containmentAlert('111111111111111111', 'contained', 7));
  await announcer.announce(containmentAlert('222222222222222222', 'refused', 9));
  await announcer.announce(containmentAlert('333333333333333333', 'uncertain', 12));
  await announcer.announce(containmentAlert('333333333333333333', 'contained', 6));
  assert.equal(sent.length, STAFF_ALERT_BURST_MAX_SENDS);
  await announcer.flush();
  assert.equal(sent.length, STAFF_ALERT_BURST_MAX_SENDS + 1);
  const digest = sent[sent.length - 1];
  assert.equal(digest.outcome, 'uncertain', 'uncertain outranks contained/refused/dry_run');
  assert.equal(digest.heat, 12, 'digest keeps the peak heat');
  assert.equal(digest.threshold, 5);
  assert.match(digest.note ?? '', /2 alert\(s\)/);
  assert.match(digest.note ?? '', /333333333333333333/);
  assert.match(digest.note ?? '', /containment_events/);
});

test('join-risk digest names distinct reasons and member count', () => {
  const digest = summarizeJoinRiskBurst(
    GUILD,
    [joinFlag('a', 2, ['r1']), joinFlag('b', 5, ['r1', 'r2']), joinFlag('a', 5, ['r2'])],
    3,
  );
  assert.equal(digest.score, 5);
  assert.match(digest.memberId, /2 member\(s\)/);
  assert.ok(digest.reasons.includes('r1') && digest.reasons.includes('r2'));
  assert.match(digest.reasons.join(' '), /3 flag\(s\)/);
});

test('containment digest with one executor stays readable', () => {
  const digest = summarizeContainmentBurst(
    GUILD,
    [containmentAlert('111111111111111111'), containmentAlert('111111111111111111')],
    2,
  );
  assert.equal(digest.outcome, 'contained');
  assert.match(digest.note ?? '', /111111111111111111×2/);
  assert.equal(digest.executorId, null, 'digest is per burst, not per executor');
});

test('invalid options fail fast at construction', () => {
  assert.throws(() => new AlertBurstThrottle<string>({
    windowMs: 0, now: () => NOW, keyOf: (s) => s, summarize: () => '',
  }), /windowMs/);
  assert.throws(() => new AlertBurstThrottle<string>({
    maxBufferedPerGuild: 0, now: () => NOW, keyOf: (s) => s, summarize: () => '',
  }), /maxBufferedPerGuild/);
});

test('mid-window flush cannot smuggle extra posts past the bound', async () => {
  const sent: JoinRiskAlert[] = [];
  const announcer = throttledJoinRiskAnnouncer(async (alert) => void sent.push(alert), {
    now: () => NOW,
  });
  for (let index = 0; index < 10; index++) await announcer.announce(joinFlag(`m-${index}`));
  await announcer.flush();
  for (let index = 0; index < 10; index++) await announcer.announce(joinFlag(`n-${index}`));
  await announcer.flush();
  assert.equal(sent.length, STAFF_ALERT_BURST_MAX_SENDS + 2, 'posts stay capped, digests carry the rest');
});
