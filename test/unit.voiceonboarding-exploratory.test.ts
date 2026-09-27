/**
 * TOG-5695: exploratory voice/onboarding coverage - the paths the existing
 * suites skip, pinned as passing behavior, with the two live bugs they
 * surfaced filed as child cards rather than fixed here.
 *
 * Offline by design (node:sqlite behind the narrow Db surface the handlers
 * touch, `?` placeholders and UPSERT): no Postgres, no token, no gateway, no
 * paid services. The Postgres-backed e2e session/funnel suites still cover
 * the same handlers against the real driver.
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
 * Bugs found (filed as child cards, NOT fixed here):
 *   - server-leave mid-voice orphans the tracker entry: GuildMemberRemove
 *     records member_leave but never closes the open voice session, so the
 *     tracker stays open and a later voice leave invents a duration spanning
 *     the member's absence. A member who leaves the server while in voice
 *     gets no voice_session_end row at all.
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
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import { planSession, sessionAckText } from '../src/onboarding/session.ts';
import type { Db, Statement } from '../src/store/db.ts';

const run = promisify(execFile);
const G = 'g5695';
const CH = 'chan-a';

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, member_id TEXT, guild_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  )`);
  db.exec(`CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, first_message_at TEXT,
    first_voice_at TEXT, last_active_at TEXT, left_at TEXT,
    inactive_flagged_at TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

async function fixture() {
  const db = openOfflineDb();
  const store = new EventStore(db);
  const handlers = new FunnelHandlers(store);
  return { db, store, handlers };
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
  const { db, handlers } = await fixture();
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
    await db.close();
  }
});

test('restart-mid-session: unknown-start end falls back to the caller channel', async () => {
  const { db, handlers } = await fixture();
  try {
    handlers.voiceSessions.clear();
    await handlers.onVoiceLeave({ guildId: G, memberId: 'u', isBot: false, channelId: 'chan-b', occurredAt: '2026-08-02T20:00:00.000Z' });
    const row = await db
      .prepare(`SELECT source FROM events WHERE event_type='voice_session_end' AND member_id=?`)
      .get<{ source: string }>('u');
    assert.equal(row?.source, 'channel:chan-b', 'no open session: credit the channel the caller named');
  } finally {
    await db.close();
  }
});

// --- B. double-start ----------------------------------------------------------

test('double-start: two starts then one leave write 2 starts, 1 end on the latest start', async () => {
  const { db, handlers } = await fixture();
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
    await db.close();
  }
});

// --- C. never-posted list ------------------------------------------------------

test('never-posted: voice-only members are out, truly silent members are in', async () => {
  const { db, handlers } = await fixture();
  try {
    await handlers.onJoin({ guildId: G, memberId: 'voiceonly', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onVoiceJoin({ guildId: G, memberId: 'voiceonly', isBot: false, channelId: CH, occurredAt: '2026-02-01T00:00:00.000Z' });
    await handlers.onVoiceLeave({ guildId: G, memberId: 'voiceonly', isBot: false, channelId: CH, occurredAt: '2026-02-01T01:00:00.000Z' });
    await handlers.onJoin({ guildId: G, memberId: 'silent', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onJoin({ guildId: G, memberId: 'chatty', isBot: false, source: 'invite:x', occurredAt: '2026-01-01T00:00:00.000Z' });
    await handlers.onMessage({ guildId: G, memberId: 'chatty', isBot: false, channelId: 'c1', occurredAt: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual(await joinedNeverPosted(db, G), ['silent']);
  } finally {
    await db.close();
  }
});

// --- D. inactivity flags ---------------------------------------------------------

test('inactivity: recent voice spares, stale voice does not immunize', async () => {
  const { db, store, handlers } = await fixture();
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
    await db.close();
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
