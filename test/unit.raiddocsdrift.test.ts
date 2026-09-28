/**
 * TOG-5716. RAID-RESPONSE / ANTI-NUKE docs-vs-code drift pins.
 *
 * Every number in `docs/RAID-RESPONSE.md` and `docs/ANTI-NUKE.md` must match a
 * constant (or constant-derived behaviour) asserted here. The failure that
 * motivated this file: the 2025-12-15 raid window was "11 seconds" in the doc
 * table, the detector comment and this suite's own test, while
 * `src/analytics/anomalies.ts` — the checked-in ground truth, with the actual
 * timestamps 21:16:49 to 21:16:56 UTC — said 7 seconds. Three places agreed
 * with each other and all three were wrong.
 *
 * Convention: docs are read as text and compared against imported code
 * constants or against behaviour of the default-constructed detector, never
 * against literals copied from the docs. A literal on both sides would agree
 * with itself and prove nothing.
 *
 * Repo-local only: reads checked-in files and fixtures, opens no socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLogEvent } from 'discord.js';

import { ANOMALIES } from '../src/analytics/anomalies.ts';
import { RaidWatch, scanJoinsForBursts, type RaidAlert } from '../src/analytics/raidWatch.ts';
import { auditEvent } from '../src/moderation/containment.ts';
import { loadContainmentConfig } from '../src/moderation/containmentConfig.ts';
import { RULES_GATE_TIMEOUT_DAYS } from '../src/moderation/rulesGateTimeout.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../src/staging/spec.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const RAID_DOC = read('docs/RAID-RESPONSE.md');
const NUKEDOC = read('docs/ANTI-NUKE.md');

const anomaly = (id: string) => ANOMALIES.find((a) => a.id === id)!;

/** n joins starting at `startIso`, one every `gapSeconds`. */
function burst(startIso: string, n: number, gapSeconds: number, prefix = 'm') {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({
    guildId: '326474832151838730',
    memberId: `${prefix}${i}`,
    occurredAt: new Date(start + i * gapSeconds * 1000).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The raid table
// ---------------------------------------------------------------------------

test('the 2025-12-15 window is 7 seconds everywhere, per its own timestamps', () => {
  const raid = anomaly('2025-12-15-raid');
  assert.ok(raid.note.includes('21:16:49') && raid.note.includes('21:16:56'));
  const span =
    (Date.parse('2025-12-15T21:16:56Z') - Date.parse('2025-12-15T21:16:49Z')) / 1000;
  assert.equal(span, 7);
  assert.match(raid.label, /7 seconds/);
  assert.match(RAID_DOC, /\| 2025-12-15 \| 15 \| 7 seconds \| none \| 15 \|/);
});

test('the other two raid rows match the anomaly labels', () => {
  assert.match(anomaly('2025-09-12-raid').label, /15 accounts joined in 6 seconds/);
  assert.match(RAID_DOC, /\| 2025-09-12 \| 15 \| 6 seconds \| 11 \| 4 \|/);
  assert.match(anomaly('2025-07-06-raid').label, /1,015 accounts joined in 56 minutes/);
  assert.match(RAID_DOC, /\| 2025-07-06 \| 1,015 \| 56 minutes \| 976, a month later \| 11 \|/);
});

test('the audit envelope (84 humans, 31 pending, 30 raid accounts) agrees', () => {
  const audit = JSON.parse(read('audit/summary.json'));
  assert.equal(audit.members.human_members, 84);
  assert.equal(audit.members.stuck_at_rules_screening, 31);
  assert.match(RAID_DOC, /84 human members, 31 stuck at the rules gate/);
  assert.match(anomaly('2025-12-15-raid').note, /30 of the server's 84 "humans" are raid accounts/);
  assert.match(RAID_DOC, /30 of those accounts are still members today/);
});

// ---------------------------------------------------------------------------
// Join-burst detector thresholds
// ---------------------------------------------------------------------------

test('documented threshold is five joins in sixty seconds, re-alerting every 15 minutes', () => {
  assert.match(RAID_DOC, /Five joins in\s*sixty seconds raises an alert/);
  assert.match(RAID_DOC, /re-alerts every 15 minutes/);
  const alerts = scanJoinsForBursts(burst('2025-12-15T21:16:49Z', 15, 7 / 15));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 5);
  const watch = new RaidWatch();
  const t = Date.parse('2026-01-01T10:00:00Z');
  for (let i = 0; i < 4; i++) assert.equal(watch.observe('g', `a${i}`, t + i * 1000), null);
  assert.ok(watch.observe('g', 'a4', t + 4000), 'fifth join inside 60s trips the default');
  // A sustained burst: the opening five trip the first alert; five more inside
  // one window ten minutes later stay silent (inside the 15-minute cooldown);
  // five more at sixteen minutes re-alert with repeat set.
  const cool = new RaidWatch();
  let first: RaidAlert | null = null;
  for (let i = 0; i < 6; i++) {
    const alert = cool.observe('g', `b${i}`, t + i * 1000);
    if (alert) first = alert;
  }
  assert.ok(first && !first.repeat);
  let mid: RaidAlert | null = null;
  for (let i = 0; i < 5; i++) mid = cool.observe('g', `c${i}`, t + 600_000 + i * 1000);
  assert.equal(mid, null, 'a full window inside the cooldown stays silent');
  let again: RaidAlert | null = null;
  for (let i = 0; i < 5; i++) again = cool.observe('g', `d${i}`, t + 960_000 + i * 1000);
  assert.ok(again && again.repeat, '15-minute cooldown re-alerts a sustained burst');
});

// ---------------------------------------------------------------------------
// Anti-nuke containment numbers
// ---------------------------------------------------------------------------

test('the documented heat table matches the coded audit weights', () => {
  assert.match(NUKEDOC, /\| kick, ban, webhook create\/update\/delete \| 1 \|/);
  assert.match(NUKEDOC, /\| channel delete, role delete \| 3 \|/);
  const entry = (action: AuditLogEvent) =>
    auditEvent(
      { id: 'e', action, executorId: 'x', targetId: 'y', createdTimestamp: 0 } as never,
      'g',
    );
  for (const action of [
    AuditLogEvent.MemberKick,
    AuditLogEvent.MemberBanAdd,
    AuditLogEvent.WebhookCreate,
    AuditLogEvent.WebhookUpdate,
    AuditLogEvent.WebhookDelete,
  ]) {
    assert.equal(entry(action)?.weight, 1, String(action));
  }
  for (const action of [AuditLogEvent.ChannelDelete, AuditLogEvent.RoleDelete]) {
    assert.equal(entry(action)?.weight, 3, String(action));
  }
  assert.equal(entry(AuditLogEvent.MessageDelete), null, 'non-destructive entries score nothing');
});

test('the documented trigger (heat 5 in 60s, entries older than 120s ignored) matches defaults', () => {
  assert.match(NUKEDOC, /heat 5 inside 60 seconds/);
  assert.match(NUKEDOC, />120 seconds/);
  const config = loadContainmentConfig({
    TWO_ANTI_NUKE: '1',
    DISCORD_GUILD_ID: TWO_STAGING_GUILD_ID,
    TWO_OWEN_USER_ID: STAGING_BOT_APPLICATION_ID,
  });
  assert.equal(config.heatThreshold, 5);
  assert.equal(config.windowSeconds, 60);
  assert.equal(config.eventMaxAgeSeconds, 120);
  assert.equal(config.dryRun, true);
});

test('the staged guild and application ids in the doc match the staging spec', () => {
  assert.ok(NUKEDOC.includes(TWO_STAGING_GUILD_ID));
  assert.ok(NUKEDOC.includes(STAGING_BOT_APPLICATION_ID));
  assert.notEqual(TWO_STAGING_GUILD_ID, LIVE_GUILD_ID, 'staging must never name the live guild');
});

// ---------------------------------------------------------------------------
// Alert path and operating numbers
// ---------------------------------------------------------------------------

// Publication scrub (TOG-4817, PR #192): `.env.example` leaves the staff
// channel blank and the operator sources the live id at deploy time, so no
// live id may be checked in here. Pin the scrubbed shape instead: the
// example stays blank while the doc still routes to the guild safety
// channel. Reads no raw dump (audit/raw/ is gitignored since TOG-8963).
test('the staff alert channel is staff-only and the live id is never committed', () => {
  const envExample = read('.env.example');
  assert.match(
    envExample,
    /DISCORD_STAFF_ALERT_CHANNEL_ID=\s*(?:\n|$)/,
    'env example leaves the alert channel blank for the operator',
  );
  assert.ok(
    RAID_DOC.includes('safety_alerts_channel_id'),
    'the doc routes alerts to the guild safety channel by name, never a live id',
  );
  assert.ok(
    !/\d{17,20}/.test(
      RAID_DOC.slice(RAID_DOC.indexOf('### Turning it on'), RAID_DOC.indexOf('## Removing the accounts')),
    ),
    'the alert-setup section names no live channel id',
  );
  assert.match(RAID_DOC, /staff-only/, 'the doc requires a staff-only channel');
});

test('the rules-gate timeout (14 days, 04:43 UTC report, 30-day report-only) matches code', () => {
  assert.equal(RULES_GATE_TIMEOUT_DAYS, 14);
  assert.match(RAID_DOC, /after 14 days/);
  const timer = read('deploy/two-bot-rules-gate-timeout.timer');
  assert.match(timer, /OnCalendar=\*-\*-\* 04:43/);
  assert.match(RAID_DOC, /04:43 UTC/);
  assert.match(RAID_DOC, /report-only for its first 30 days/);
  assert.match(read('scripts/rules-gate-timeout.ts'), /30-day report-only/);
  const service = read('deploy/two-bot-rules-gate-timeout.service');
  assert.ok(service.includes('scripts/rules-gate-timeout.ts'));
  assert.ok(!service.includes('--execute'), 'the deployed timer reports; it never executes');
});

test('three consecutive failures stop a removal run, as documented', () => {
  assert.match(RAID_DOC, /Three consecutive failures end the run/);
  assert.match(read('src/moderation/raidRemoval.ts'), /maxConsecutiveFailures \?\? 3/);
});

test('both removal scripts document exit codes 0 clean, 1 failed, 2 refused', () => {
  assert.match(RAID_DOC, /Exit codes: `0` clean/);
  for (const script of ['scripts/raid-remove.ts', 'scripts/rules-gate-timeout.ts']) {
    assert.match(read(script), /EXIT CODES\s+0 clean/);
  }
});
