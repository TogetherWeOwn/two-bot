/**
 * Join-burst detection.
 *
 * Two failure modes, and they cost different things. A missed raid is what
 * already happened three times: 30 fake accounts sat in the member count for
 * five months and every per-member rate we published was wrong. A false alarm
 * is worse than it sounds too - the one week TWO actually gets a surge of real
 * people is the week nobody wants the bot crying raid.
 *
 * So both directions are tested, including against the real shape of all three
 * recorded raids and against the busiest genuine day in the server's history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RaidWatch,
  formatRaidAlert,
  scanJoinsForBursts,
  type RaidAlert,
} from '../src/analytics/raidWatch.ts';

const G = '326474832151838730';
const t = (iso: string) => Date.parse(iso);

/** n joins starting at `startIso`, one every `gapSeconds`. */
function burst(startIso: string, n: number, gapSeconds: number, prefix = 'm') {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({
    guildId: G,
    memberId: `${prefix}${i}`,
    occurredAt: new Date(start + i * gapSeconds * 1000).toISOString(),
  }));
}

test('five joins inside the window trips on the fifth, not the fourth', () => {
  const w = new RaidWatch();
  for (let i = 0; i < 4; i++) {
    assert.equal(w.observe(G, `m${i}`, t(`2026-01-01T10:00:0${i}Z`)), null);
  }
  const alert = w.observe(G, 'm4', t('2026-01-01T10:00:04Z'));
  assert.ok(alert);
  assert.equal(alert.count, 5);
  assert.equal(alert.spanSeconds, 4);
  assert.equal(alert.repeat, false);
  assert.deepEqual(alert.memberIds, ['m0', 'm1', 'm2', 'm3', 'm4']);
});

test('joins spread wider than the window never trip it', () => {
  const w = new RaidWatch();
  // 20 people over 20 minutes - a busy evening, not a raid
  for (let i = 0; i < 20; i++) {
    assert.equal(w.observe(G, `m${i}`, t('2026-01-01T10:00:00Z') + i * 60_000), null);
  }
});

test('the window slides: old joins stop counting', () => {
  const w = new RaidWatch({ windowSeconds: 60, threshold: 3 });
  w.observe(G, 'a', t('2026-01-01T10:00:00Z'));
  w.observe(G, 'b', t('2026-01-01T10:00:30Z'));
  // 'a' is now outside the 60s window, so this is only the 2nd live join
  assert.equal(w.observe(G, 'c', t('2026-01-01T10:01:10Z')), null);
  assert.equal(w.windowSize(G), 2);
  assert.ok(w.observe(G, 'd', t('2026-01-01T10:01:20Z')));
});

test('a redelivered join is not a second join', () => {
  const w = new RaidWatch({ threshold: 3 });
  w.observe(G, 'a', t('2026-01-01T10:00:00Z'));
  w.observe(G, 'a', t('2026-01-01T10:00:01Z'));
  w.observe(G, 'a', t('2026-01-01T10:00:02Z'));
  assert.equal(w.windowSize(G), 1);
});

test('a long raid alerts on a cooldown, not once per account', () => {
  // The 2025-07-06 shape: 1,015 accounts over 56 minutes, ~18 a minute.
  const joins = burst('2025-07-06T20:31:00Z', 1015, 56 * 60 / 1015);
  const alerts = scanJoinsForBursts(joins, { cooldownSeconds: 900 });
  // 56 minutes at a 15 minute cooldown: first alert, then roughly one per
  // cooldown. Enough to be noticed, few enough to read.
  assert.ok(alerts.length >= 3 && alerts.length <= 6, `got ${alerts.length} alerts`);
  assert.equal(alerts[0].repeat, false);
  assert.equal(alerts[1].repeat, true);
});

test('both small raids are caught, and caught within seconds', () => {
  // 2025-09-12: 15 accounts in 6 seconds. 2025-12-15: 15 in 7 seconds.
  for (const [start, span] of [
    ['2025-09-12T17:42:59Z', 6],
    ['2025-12-15T21:16:49Z', 7],
  ] as const) {
    const alerts = scanJoinsForBursts(burst(start, 15, span / 15));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].count, 5, 'fires on the 5th account, not after all 15');
    assert.ok(alerts[0].spanSeconds <= span);
  }
});

test("the server's busiest genuine month would not have alerted", () => {
  // 2023-04 was the biggest real intake on record: 7 joins in a month.
  // Even if all 7 arrived on one evening, they are minutes apart.
  const joins = burst('2023-04-14T19:00:00Z', 7, 8 * 60);
  assert.deepEqual(scanJoinsForBursts(joins), []);
});

test('guilds are counted separately', () => {
  const w = new RaidWatch({ threshold: 3 });
  w.observe('g1', 'a', t('2026-01-01T10:00:00Z'));
  w.observe('g2', 'b', t('2026-01-01T10:00:01Z'));
  w.observe('g1', 'c', t('2026-01-01T10:00:02Z'));
  assert.equal(w.observe('g2', 'd', t('2026-01-01T10:00:03Z')), null);
  assert.ok(w.observe('g1', 'e', t('2026-01-01T10:00:04Z')));
});

test('an alert past the id cap counts everyone and lists some', () => {
  // 400 accounts, ten a second. The first alert fires the instant the window
  // hits the threshold, so it carries five IDs - the point is speed. The
  // follow-up is the one that has to say how big this got without pasting
  // hundreds of snowflakes into a staff channel.
  const alerts = scanJoinsForBursts(burst('2025-07-06T20:31:00Z', 400, 0.1), {
    maxIds: 10,
    cooldownSeconds: 10,
  });
  assert.equal(alerts[0].memberIds.length, 5);
  assert.equal(alerts[0].truncated, false);

  const later = alerts[1];
  assert.ok(later, 'a sustained raid alerts again after the cooldown');
  assert.equal(later.repeat, true);
  assert.equal(later.memberIds.length, 10);
  assert.equal(later.truncated, true);
  assert.ok(later.count > 10);
});

test('the staff text names IDs and claims no action was taken', () => {
  const alert: RaidAlert = {
    guildId: G,
    count: 15,
    windowSeconds: 60,
    firstJoinAt: '2025-12-15T21:16:49.000Z',
    lastJoinAt: '2025-12-15T21:17:00.000Z',
    spanSeconds: 11,
    memberIds: ['111', '222'],
    truncated: true,
    repeat: false,
  };
  const text = formatRaidAlert(alert);
  assert.match(text, /15 accounts joined in 11s/);
  assert.match(text, /`111`/);
  assert.match(text, /and 13 more/);
  assert.match(text, /kicked, banned and messaged nobody/);
  assert.match(text, /1\. Run `node scripts\/roster\.ts 1`/);
  assert.match(text, /2\. If it is a raid, Server Settings -> Safety Setup -> pause invites/);
  // No pings, ever - not even by accident in the template.
  assert.doesNotMatch(text, /@everyone|@here|<@/);
});
