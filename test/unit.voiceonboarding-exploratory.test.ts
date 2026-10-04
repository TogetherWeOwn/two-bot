/**
 * TOG-5695: exploratory voice/onboarding coverage - the paths the existing
 * suites skip, pinned as passing behavior, with the live bugs they surfaced
 * filed as child cards (one fixed and pinned in section G, one still open).
 *
 * Isolated test Postgres exercises the shipping membership projection and
 * its locking/JSON behavior. No live Discord token, gateway or paid services;
 * script probes remain offline.
 *
 * What this pins (all passing, all current behavior):
 *   A. restart-mid-session: start -> clear() (what the gateway adapter does
 *      on ShardResume) -> leave records startKnown:false, null duration, and
 *      falls back to the caller's channel. The duration column stays honest.
 *   B. double-start: two starts then one leave write 2 start rows and 1 end
 *      row credited to the LATEST start. Tracker holds one session per member
 *      (Discord allows one voice channel at a time), so the second start
 *      silently replaces the first and the first visit's duration is lost.
 *      The count asymmetry (starts != ends) is the observable signal.
 *   C. never-posted list: a voice-only member (first_voice_at set, no
 *      message) is excluded from joinedNeverPosted; a truly silent member is
 *      included. The list reads both first_message_at and first_voice_at.
 *   D. inactivity flags: voice touchActivity moves last_active_at, so a
 *      recently-in-voice member is spared by flagInactive - but a member
 *      whose voice visit is older than the threshold IS flagged. Voice
 *      presence is recency, not immunity.
 *   E. self-role panel dry-run: rendering the panel config (no --apply) never
 *      touches the network and needs no token. The script posts only with an
 *      explicit --apply plus a staging token. Probed with a stubbed fetch
 *      that throws on any call.
 *   F. session picker script: stale/unknown keys are reported, never routed -
 *      planSession/ack-text level pin mirroring the e2e.session.test.ts
 *      stale-selection case, kept offline.
 *
 * Bugs found (filed as child cards):
 *   - server-leave mid-voice orphaned the tracker entry: GuildMemberRemove
 *     recorded member_leave but never closed the open voice session, so the
 *     tracker stayed open and a later voice leave invented a duration spanning
 *     the member's absence. Fixed by TOG-6122, pinned in section G below.
 *   - fresh-session reconnect never clears the tracker: only ShardResume
 *     drops open sessions; a new session (READY/ShardReady after an
 *     unresumable disconnect - InvalidSession with no session, Reconnect
 *     opcode) keeps pre-outage starts, so post-outage leaves report measured
 *     durations that silently include the outage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { openTestDb } from './helpers/testDb.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import { planSession, sessionAckText } from '../src/onboarding/session.ts';
import type { Db } from '../src/store/db.ts';

const run = promisify(execFile);
const G = 'g5695';
const CH = 'chan-a';

async function fixture() {
  const harness = await openTestDb(import.meta.filename);
  const db = harness.db;
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  return { db, store, handlers, cleanup: harness.cleanup };
}

type EndMeta = { startKnown: boolean; startedAt: string | null; durationSeconds: number | null };
async function endMetas(db: Db, memberId: string): Promise<EndMeta[]> {
  const rows = await db
    .prepare(`SELECT metadata FROM events WHERE event_type='voice_session_end' AND member_id=? ORDER BY id`)
    .all<{ metadata: string }>(memberId);
  return rows.map((r) => JSON.parse(r.metadata) as EndMeta);
}
async function countByType(db: Db, type: string, memberId?: string): Promise<number> {
  const row = await db
    .prepare(
      memberId
        ? `SELECT COUNT(*) AS n FROM events WHERE event_type=? AND member_id=?`
        : `SELECT COUNT(*) AS n FROM events WHERE event_type=?`,
    )
    .get<{ n: number }>(...(memberId ? [type, memberId] : [type]));
  return Number(row?.n ?? 0);
}

// --- A. restart-mid-session -------------------------------------------------

test('restart-mid-session: clear-then-leave ends startKnown:false with null duration', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'r', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:00:00.000Z' });
    // What src/discord/client.ts does on ShardResume: every open session is
    // now unproven, so drop them rather than measure through the outage.
    handlers.voiceSessions.clear();
    await handlers.onVoiceLeave({ guildId: G, memberId: 'r', isBot: false, channelId: CH, occurredAt: '2026-08-02T20:00:00.000Z' });
    const [end] = await endMetas(db, 'r');
    assert.equal(end.startKnown, false, 'the bot did not see this session start');
    assert.equal(end.durationSeconds, null, 'no invented duration across the outage');
    assert.equal(end.startedAt, null);
    assert.equal(await countByType(db, 'voice_session_start', 'r'), 1, 'the pre-outage start row is untouched');
  } finally {
    await cleanup();
  }
});

test('restart-mid-session: unknown-start end falls back to the caller channel', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    handlers.voiceSessions.clear();
    await handlers.onVoiceLeave({ guildId: G, memberId: 'u', isBot: false, channelId: 'chan-b', occurredAt: '2026-08-02T20:00:00.000Z' });
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('u');
    assert.equal(row?.source, 'channel:chan-b', 'no open session: credit the channel the caller named');
  } finally {
    await cleanup();
  }
});

// --- B. double-start ----------------------------------------------------------

test('double-start: two starts then one leave write 2 starts, 1 end on the latest start', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'd', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'd', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:05:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'd', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:30:00.000Z' });
    // voice_session_start is repeatable BY DESIGN, so both rows land - but the
    // tracker holds one session per member, so only one end exists and it is
    // measured from the LATEST start. The first visit's duration is lost.
    assert.equal(await countByType(db, 'voice_session_start', 'd'), 2);
    const [end] = await endMetas(db, 'd');
    assert.equal(end.startKnown, true);
    assert.equal(end.startedAt, '2026-08-02T19:05:00.000Z');
    assert.equal(end.durationSeconds, 25 * 60);
  } finally {
    await cleanup();
  }
});

// --- C. never-posted list ------------------------------------------------------

test('never-posted: voice-only members are out, truly silent members are in', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onJoin({ guildId: G, memberId: 'voiceonly', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'voiceonly', isBot: false, channelId: CH, occurredAt: '2026-02-01T00:00:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'voiceonly', isBot: false, channelId: CH, occurredAt: '2026-02-01T01:00:00.000Z' });
    await handlers.onJoin({ guildId: G, memberId: 'silent', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onJoin({ guildId: G, memberId: 'chatty', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onMessage({ guildId: G, memberId: 'chatty', isBot: false, channelId: 'c1', occurredAt: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual(await joinedNeverPosted(db, G), ['silent']);
  } finally {
    await cleanup();
  }
});

// --- D. inactivity flags ---------------------------------------------------------

test('inactivity: recent voice spares, stale voice does not immunize', async () => {
  const { db, store, handlers, cleanup } = await fixture();
  try {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const recentVoice = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const staleVoice = new Date(Date.now() - 60 * 86_400_000).toISOString();
    for (const id of ['fresh-voice', 'stale-voice', 'quiet']) {
      await handlers.onJoin({ guildId: G, memberId: id, isBot: false, source: 'invite:x', occurredAt: old });
    }
    await handlers.onVoiceJoin({ guildId: G, memberId: 'fresh-voice', isBot: false, channelId: CH, occurredAt: recentVoice });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'fresh-voice', isBot: false, channelId: CH, occurredAt: recentVoice });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'stale-voice', isBot: false, channelId: CH, occurredAt: staleVoice });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'stale-voice', isBot: false, channelId: CH, occurredAt: staleVoice });
    const flagged = await flagInactive(db, store, 14);
    assert.ok(!flagged.includes('fresh-voice'), 'voice yesterday is recency');
    assert.ok(flagged.includes('stale-voice'), 'voice two months ago is not immunity');
    assert.ok(flagged.includes('quiet'));
  } finally {
    await cleanup();
  }
});

// --- E. self-role panel dry-run ----------------------------------------------------
// The script refuses non-loopback API bases and demands a staging token for
// --apply, so a dry-run render is fully offline. fetch is stubbed to throw on
// any call: a dry-run that dials out fails instead of silently passing.

// The script demands a staging-shaped token even to render (guard order:
// config -> guild -> token -> render), so the offline token is minted the
// same way unit.selfrolepanel-script.test.ts does: base64(appId) + suffix.
// It never leaves the process - the dry-run path returns before any fetch,
// and SELF_ROLE_PANEL_API_BASE points at a dead port so a regression that
// dials out fails loudly instead of hanging.
const STAGING_APP_ID = '1469137636663758888';
const STAGING_GUILD_ID = '1545644954272137297';
const offlineStagingToken = `${Buffer.from(STAGING_APP_ID).toString('base64url')}.offline.dryrun`;

test('self-role panel dry-run renders locally with no network', async () => {
  const panels = JSON.stringify([{
    id: 'colors', channelId: '111111111111111111', messageId: '222222222222222222',
    mode: 'button', options: [{ key: 'red', label: 'Red', roleId: '333333333333333333', permissions: '0' }],
  }]);
  const { stdout } = await run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'colors'], {
    env: {
      ...process.env,
      TWO_SELF_ROLE_PANELS: panels,
      DISCORD_STAGING_GUILD_ID: STAGING_GUILD_ID,
      DISCORD_STAGING_BOT_TOKEN: offlineStagingToken,
      SELF_ROLE_PANEL_API_BASE: 'http://127.0.0.1:9',
    },
  });
  assert.match(stdout, /self-role panel colors/);
  assert.match(stdout, /Dry run\. Nothing was posted/);
});

test('self-role panel script gates: unknown panel and bad base fail before network', async () => {
  const panels = JSON.stringify([{
    id: 'colors', channelId: '111111111111111111', messageId: '222222222222222222',
    mode: 'button', options: [{ key: 'red', label: 'Red', roleId: '333333333333333333', permissions: '0' }],
  }]);
  await assert.rejects(
    run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'nope'], { env: { ...process.env, TWO_SELF_ROLE_PANELS: panels } }),
    /not in TWO_SELF_ROLE_PANELS/,
  );
  await assert.rejects(
    run(process.execPath, ['scripts/self-role-panel.ts', '--panel', 'colors'], {
      env: { ...process.env, TWO_SELF_ROLE_PANELS: panels, SELF_ROLE_PANEL_API_BASE: 'https://example.com' },
    }),
    /may only override Discord with a loopback/,
  );
});

// --- F. session picker stale keys --------------------------------------------------

test('session picker: stale keys are reported, never routed', () => {
  const planned = planSession(['survival-games'], () => true);
  assert.deepEqual(planned.channelIds, [], 'nothing to route a stale key to');
  assert.deepEqual(planned.unknownKeys, ['survival-games']);
  assert.match(sessionAckText(planned), /stale/i, 'the member gets a retry message, not silence');
});

// --- G. server-leave mid-voice (TOG-6122) --------------------------------------
// GuildMemberRemove used to record member_leave but never close the open voice
// session: the tracker leaked one entry per such leave, the member got NO
// voice_session_end row, and a later voice leave invented a duration spanning
// the absence. onLeave now closes the session first (end credited to the open
// channel, duration to leave time).

test('server-leave mid-voice closes the session: end credited to the open channel, duration to leave time', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'leaver', isBot: false, channelId: 'chan-a', occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onLeave(G, 'leaver', '2026-08-02T19:30:00.000Z');
    const [end] = await endMetas(db, 'leaver');
    assert.equal(end.startKnown, true, 'the bot saw this session start');
    assert.equal(end.startedAt, '2026-08-02T19:00:00.000Z');
    assert.equal(end.durationSeconds, 30 * 60, 'measured to leave time, not to a later frame');
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('leaver');
    assert.equal(row?.source, 'channel:chan-a', 'credited to the open channel');
    assert.equal(handlers.voiceSessions.isOpen(G, 'leaver'), false, 'tracker entry closed, not leaked');
    assert.equal(await countByType(db, 'member_leave', 'leaver'), 1, 'the gone marker still lands');
  } finally {
    await cleanup();
  }
});

test('server-leave with no open session writes no end row', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onLeave(G, 'quiet', '2026-08-02T19:30:00.000Z');
    assert.equal(await countByType(db, 'voice_session_end', 'quiet'), 0, 'no session open, nothing to close');
    assert.equal(await countByType(db, 'member_leave', 'quiet'), 1);
    assert.equal(handlers.voiceSessions.openCount, 0);
  } finally {
    await cleanup();
  }
});

test('a voice leave after a server-leave is unknown-start, not a duration spanning the absence', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    // The issue's probe: join -> server-leave -> a stale voice frame 2h later.
    await handlers.onVoiceJoin({ guildId: G, memberId: 'gone-then-frame', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onLeave(G, 'gone-then-frame', '2026-08-02T19:30:00.000Z');
    await handlers.onVoiceLeave({ guildId: G, memberId: 'gone-then-frame', isBot: false, channelId: CH, occurredAt: '2026-08-02T21:30:00.000Z' });
    const ends = await endMetas(db, 'gone-then-frame');
    assert.equal(ends.length, 2, 'the close-on-leave plus the stale frame');
    assert.equal(ends[0].durationSeconds, 30 * 60, 'the real session, measured to leave time');
    assert.equal(ends[1].startKnown, false, 'the bot never saw this session start');
    assert.equal(ends[1].durationSeconds, null, 'no invented 7200s spanning the absence');
  } finally {
    await cleanup();
  }
});

test('a repeated server-leave writes one end row, not two', async () => {
  const { db, handlers, cleanup } = await fixture();
  try {
    await handlers.onVoiceJoin({ guildId: G, memberId: 'twice', isBot: false, channelId: CH, occurredAt: '2026-08-02T19:00:00.000Z' });
    await handlers.onLeave(G, 'twice', '2026-08-02T19:30:00.000Z');
    await handlers.onLeave(G, 'twice', '2026-08-02T19:30:00.000Z'); // Discord retrying the removal
    assert.equal(await countByType(db, 'voice_session_end', 'twice'), 1, 'second leave peeks no open session');
    assert.equal(await countByType(db, 'member_leave', 'twice'), 1, 'repeatable key dedupes');
  } finally {
    await cleanup();
  }
});
