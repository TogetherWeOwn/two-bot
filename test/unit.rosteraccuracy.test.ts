/**
 * Roster accuracy: never-posted list vs roster welcome output (TOG-7766,
 * eng slice of TOG-7218).
 *
 * Adjacent to PR #218 (`test/unit.rosterwelcome.test.ts`, TOG-5721) — this
 * file uses INDEPENDENT seeds: guild `g7766` (vs `g5721`), member ids
 * `m7766-*` (vs `silent`/`voiceonly`/`chatty`), join day 2026-09-10 (vs
 * 2026-09-20) and invite codes `zz9911`/`qq4455` (vs `abc123`).
 *
 * What this pins, fixture-driven, with no Postgres, no token, no network:
 *
 *   1. `joinedNeverPosted` reads BOTH firsts: a voice-only member is OUT
 *      (first_voice_at set), while the roster `posted?` column reads messages
 *      only, so that same member still shows NO under `posted?`. The two
 *      "never posted" meanings differ on purpose; this is the test that says
 *      so on fresh seeds.
 *   2. Agreement: the never-posted list is a subset of the roster
 *      re-engagement set (still-here AND no first message), and the exact
 *      difference is the voice-only set. The roster rows come from the same
 *      SELECT shape `scripts/roster.ts` runs (guild + since window + NOT
 *      bot), executed against the seeded offline DB.
 *   3. Welcome-output smoke: the pure renderers behind the welcome posts
 *      (`sessionWelcomeText`, `goodbyeText` + `daysInGuild`, and
 *      `anchorWelcomeText`) name the member/event on these seeds.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { joinedNeverPosted } from '../src/jobs/inactivity.ts';
import type { Db, Statement } from '../src/store/db.ts';
import {
  formatRosterText,
  type RosterTextRow,
} from '../src/analytics/cliFormat.ts';
import {
  daysInGuild,
  goodbyeText,
  sessionWelcomeText,
} from '../src/onboarding/session.ts';
import { anchorWelcomeText } from '../src/onboarding/anchorEvent.ts';

// Fresh seeds, disjoint from PR #218 (g5721, silent/voiceonly, 2026-09-20).
const GUILD = 'g7766';
const JOIN = '2026-09-10T08:00:00.000Z';
const VOICE = '2026-09-11T09:30:00.000Z';
const MESSAGE = '2026-09-11T10:15:00.000Z';
const LEFT = '2026-09-12T00:00:00.000Z';
const SINCE = '2026-09-05T00:00:00.000Z';
const DAYS = 30;

const QUIET = 'm7766-quiet';
const VOICE_ONLY = 'm7766-voice';
const CHATTY = 'm7766-chat';
const BOTH = 'm7766-both';
const GONE = 'm7766-gone';
const BOT = 'm7766-bot';

// --- offline Db over node:sqlite (same narrow shape as the other offline suites) ---

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
  joinSource?: string | null;
  firstMessageAt?: string | null;
  firstVoiceAt?: string | null;
  isBot?: boolean;
  leftAt?: string | null;
}

async function seedMember(db: Db, id: string, o: SeedOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, join_source, first_message_at,
                            first_voice_at, is_bot, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      GUILD, id, JOIN, o.joinSource ?? null, o.firstMessageAt ?? null,
      o.firstVoiceAt ?? null, o.isBot ? 1 : 0, o.leftAt ?? null,
    );
}

/** The six shapes: silent, voice-only, message-only, both, leaver, bot. */
async function seedGuild(db: Db): Promise<void> {
  await seedMember(db, QUIET, { joinSource: 'invite:zz9911' });
  await seedMember(db, VOICE_ONLY, { joinSource: 'invite:zz9911', firstVoiceAt: VOICE });
  await seedMember(db, CHATTY, { joinSource: 'vanity', firstMessageAt: MESSAGE });
  await seedMember(db, BOTH, { joinSource: 'invite:qq4455', firstMessageAt: MESSAGE, firstVoiceAt: VOICE });
  await seedMember(db, GONE, { joinSource: 'backfill:log:member-join', leftAt: LEFT });
  await seedMember(db, BOT, { firstMessageAt: MESSAGE, isBot: true });
}

interface RosterQueryRow {
  member_id: string;
  joined_at: string;
  join_source: string | null;
  first_message_at: string | null;
  first_voice_at: string | null;
  left_at: string | null;
}

/** The same SELECT shape `scripts/roster.ts` runs: guild + since + NOT bot. */
async function rosterRows(db: Db): Promise<RosterTextRow[]> {
  const rows = await db
    .prepare(
      `SELECT member_id, joined_at, join_source, first_message_at, first_voice_at, left_at
         FROM members
        WHERE guild_id = ? AND joined_at IS NOT NULL AND joined_at >= ? AND NOT is_bot
        ORDER BY joined_at DESC`,
    )
    .all<RosterQueryRow>(GUILD, SINCE);
  return rows.map((r) => ({
    memberId: r.member_id,
    displayName: null,
    joinedAt: r.joined_at,
    joinSource: r.join_source,
    firstMessageAt: r.first_message_at,
    firstVoiceAt: r.first_voice_at,
    leftAt: r.left_at,
  }));
}

describe('never-posted list reads both firsts', () => {
  test('only the truly silent, still-here, non-bot member is listed', async () => {
    const db = openOfflineDb();
    try {
      await seedGuild(db);
      assert.deepEqual(await joinedNeverPosted(db, GUILD), [QUIET]);
    } finally {
      await db.close();
    }
  });
});

describe('roster welcome output agrees with the never-posted list', () => {
  test('voice-only is OUT of never-posted but still NO under posted?, on the same rows', async () => {
    const db = openOfflineDb();
    try {
      await seedGuild(db);
      const neverPosted = await joinedNeverPosted(db, GUILD);
      const rows = await rosterRows(db);

      // The roster query sees every non-bot join in the window, including the leaver.
      assert.deepEqual(
        rows.map((r) => r.memberId).sort(),
        [BOTH, CHATTY, GONE, QUIET, VOICE_ONLY].sort(),
      );

      const text = formatRosterText(rows, DAYS, SINCE);
      assert.ok(text.includes('5 members joined, 2 posted, 3 never posted'));
      assert.ok(text.includes('2 members still in the server and have never posted - the re-engagement list.'));

      const line = (id: string) => text.split('\n').find((l) => l.includes(id))!;
      assert.match(line(QUIET), /NO\s+no\s+yes/);
      assert.match(line(VOICE_ONLY), /NO\s+yes\s+yes/);
      assert.match(line(CHATTY), /yes\s+no\s+yes/);
      assert.match(line(BOTH), /yes\s+yes\s+yes/);
      assert.match(line(GONE), /NO\s+no\s+left/);
      assert.ok(!text.includes('invite:zz9911'), 'raw invite: prefix must not leak');
      assert.ok(!text.includes('invite:qq4455'), 'raw invite: prefix must not leak');
      assert.ok(!text.includes('backfill:'), 'raw backfill: prefix must not leak');

      // Agreement, with the intentional split pinned: never-posted is the
      // re-engagement set minus exactly the voice-only members.
      const reengaged = rows
        .filter((r) => !r.firstMessageAt && !r.leftAt)
        .map((r) => r.memberId)
        .sort();
      assert.deepEqual(reengaged, [QUIET, VOICE_ONLY].sort());
      assert.ok(neverPosted.every((id) => reengaged.includes(id)), 'never-posted must sit inside the re-engagement set');
      const split = reengaged.filter((id) => !neverPosted.includes(id));
      assert.deepEqual(split, [VOICE_ONLY], 'the only intentional difference is voice-only');
      const voiceRows = rows.filter((r) => !r.firstMessageAt && r.firstVoiceAt && !r.leftAt);
      assert.deepEqual(
        voiceRows.map((r) => r.memberId),
        split,
        'the split is exactly the voice-only members',
      );
    } finally {
      await db.close();
    }
  });
});

describe('welcome renderers name the member and the event', () => {
  test('session welcome mentions the never-posted member and points at the picker', () => {
    const text = sessionWelcomeText(`<@${QUIET}>`);
    assert.ok(text.includes(`<@${QUIET}>`), 'the mention is the whole point of the message');
    assert.ok(text.includes('What do you want to do right now?'), 'picker lead matches the select placeholder');
  });

  test('goodbye text carries the name and the stay length from the same pure functions', () => {
    const leftAt = '2026-09-12T08:00:00.000Z';
    assert.equal(daysInGuild(JOIN, leftAt), 2);
    const text = goodbyeText('quiet-one', daysInGuild(JOIN, leftAt));
    assert.ok(text.includes('**quiet-one** left the server'), 'names who left');
    assert.ok(text.includes('(was here 2 days)'), 'says how long they stayed');
  });

  test('anchor welcome names Sunday Squad for a mid-week join', () => {
    // A quiet Wednesday in September, disjoint from the August seed in #218.
    const at = Date.parse('2026-09-02T15:00:00.000Z');
    const text = anchorWelcomeText(`<@${QUIET}>`, at);
    assert.ok(text.includes(`<@${QUIET}>`), 'greets the member');
    assert.ok(text.includes('Sunday Squad'), 'names the anchor event');
  });
});
