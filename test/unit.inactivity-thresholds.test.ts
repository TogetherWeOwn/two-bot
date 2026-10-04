/**
 * TOG-7201: pin the inactivity job's threshold boundaries.
 *
 * `flagInactive` compares `COALESCE(last_active_at, joined_at) < cutoff` as
 * ISO text, and `joinedNeverPosted` excludes anybody with any first signal.
 * Neither edge had a test; the surrounding suites (unit.store,
 * unit.inactivity-nomessage, unit.voiceonboarding-exploratory) only cover the
 * clear-cut cases. These pin:
 *
 *   1. exactly-at-threshold is spared (strict `<`), one millisecond earlier is
 *      flagged - on both sides of the cutoff;
 *   2. never-active members are judged by join date (the COALESCE fallback);
 *   3. timezone edge: the same instant read in another zone behaves
 *      identically - PROVIDED it is stored Z-normalized. The comparison is
 *      lexicographic TEXT, so a raw `+02:00` suffix would misorder; production
 *      writes `toISOString()` Zulu (see `nowIso`), and the seeds below prove
 *      the Z form is zone-agnostic;
 *   4. never-posted exclusion: any first signal (message, voice, or both)
 *      excludes, as do bots, departed members, and rows with no join date;
 *      survivors come back newest-join first.
 *
 * Runs without Postgres or a token: node:sqlite backs the narrow Db surface
 * the job touches. The clock is frozen so the cutoff is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../src/store/eventStore.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import type { Db, Statement } from '../src/store/db.ts';

const G = 'g1';
const DAYS = 14;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const CUTOFF = new Date(NOW - DAYS * DAY).toISOString();
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

// --- minimal Db over node:sqlite (same shape as unit.inactivity-nomessage) ---

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

interface SeedOpts {
  joinedAt?: string | null;
  lastActiveAt?: string | null;
  firstMessageAt?: string | null;
  firstVoiceAt?: string | null;
  isBot?: boolean;
  leftAt?: string | null;
}

async function seedMember(db: Db, id: string, o: SeedOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, last_active_at,
                            first_message_at, first_voice_at, is_bot, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      G, id,
      o.joinedAt ?? null, o.lastActiveAt ?? null,
      o.firstMessageAt ?? null, o.firstVoiceAt ?? null,
      o.isBot ? 1 : 0, o.leftAt ?? null,
    );
}

/** Freeze Date.now so the job's cutoff is exactly CUTOFF. */
async function withFrozenClock(fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

// --- 1. exactly-at-threshold ---------------------------------------------------

test('exactly-at-threshold is spared; one millisecond earlier is flagged', async () => {
  const db = openOfflineDb();
  const store = new EventStore(db);
  try {
    await withFrozenClock(async () => {
      const oneMsBefore = new Date(Date.parse(CUTOFF) - 1).toISOString();
      const oneMsAfter = new Date(Date.parse(CUTOFF) + 1).toISOString();
      await seedMember(db, 'at-threshold', { joinedAt: daysAgo(300), lastActiveAt: CUTOFF });
      await seedMember(db, 'one-ms-quiet', { joinedAt: daysAgo(300), lastActiveAt: oneMsBefore });
      await seedMember(db, 'one-ms-fresh', { joinedAt: daysAgo(300), lastActiveAt: oneMsAfter });

      // The query is strict `<`: equality with the cutoff is not quiet.
      assert.deepEqual(await flagInactive(db, store, DAYS), ['one-ms-quiet']);

      const rows = await db
        .prepare(`SELECT source, metadata FROM events WHERE event_type = 'member_inactive'`)
        .all<{ source: string; metadata: string }>();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'job:inactivity');
      assert.equal((JSON.parse(rows[0].metadata) as { thresholdDays: number }).thresholdDays, DAYS);
    });
  } finally {
    await db.close();
  }
});

// --- 2. COALESCE fallback -------------------------------------------------------

test('never-active members are judged by join date, not spared for having no activity', async () => {
  const db = openOfflineDb();
  const store = new EventStore(db);
  try {
    await withFrozenClock(async () => {
      await seedMember(db, 'old-join-never-active', { joinedAt: daysAgo(300) });
      await seedMember(db, 'recent-join-never-active', { joinedAt: daysAgo(1) });
      assert.deepEqual(await flagInactive(db, store, DAYS), ['old-join-never-active']);
    });
  } finally {
    await db.close();
  }
});

// --- 3. timezone edge -----------------------------------------------------------

test('timezone edge: the same instant reads the same in any zone once stored as Zulu', async () => {
  const db = openOfflineDb();
  const store = new EventStore(db);
  try {
    await withFrozenClock(async () => {
      // 14:00 on a +02:00 wall clock IS the 12:00Z cutoff. Stored via
      // toISOString, it is byte-identical to the cutoff and must be spared.
      const viaOffset = new Date(Date.parse('2026-09-13T14:00:00+02:00')).toISOString();
      assert.equal(viaOffset, CUTOFF, 'test premise: the offset instant equals the cutoff');
      // 13:00+02:00 is 11:00Z, an hour inside the quiet side.
      const hourBefore = new Date(Date.parse('2026-09-13T13:00:00+02:00')).toISOString();

      await seedMember(db, 'offset-at-threshold', { joinedAt: daysAgo(300), lastActiveAt: viaOffset });
      await seedMember(db, 'offset-quiet', { joinedAt: daysAgo(300), lastActiveAt: hourBefore });
      assert.deepEqual(await flagInactive(db, store, DAYS), ['offset-quiet']);
    });
  } finally {
    await db.close();
  }
});

// --- 4. never-posted exclusion ---------------------------------------------------

test('never-posted: any first signal excludes; survivors come back newest-join first', async () => {
  const db = openOfflineDb();
  try {
    await seedMember(db, 'silent-old', { joinedAt: '2026-01-01T00:00:00.000Z' });
    await seedMember(db, 'silent-new', { joinedAt: '2026-03-01T00:00:00.000Z' });
    await seedMember(db, 'text-only', { joinedAt: '2026-01-01T00:00:00.000Z', firstMessageAt: '2026-02-01T00:00:00.000Z' });
    await seedMember(db, 'voice-only', { joinedAt: '2026-01-01T00:00:00.000Z', firstVoiceAt: '2026-02-01T00:00:00.000Z' });
    await seedMember(db, 'both', {
      joinedAt: '2026-01-01T00:00:00.000Z',
      firstMessageAt: '2026-02-01T00:00:00.000Z',
      firstVoiceAt: '2026-02-02T00:00:00.000Z',
    });
    await seedMember(db, 'bot-silent', { joinedAt: '2026-01-01T00:00:00.000Z', isBot: true });
    await seedMember(db, 'left-silent', { joinedAt: '2026-01-01T00:00:00.000Z', leftAt: '2026-04-01T00:00:00.000Z' });
    // A presence-only row (e.g. from touchActivity) with no join date is not a
    // "joined and never posted" finding.
    await seedMember(db, 'no-join-row', { joinedAt: null, lastActiveAt: daysAgo(100) });

    assert.deepEqual(await joinedNeverPosted(db, G), ['silent-new', 'silent-old']);
  } finally {
    await db.close();
  }
});
