/**
 * Backfill-messages + automod-export acceptance tests (TOG-5700).
 *
 * Scope: `scripts/backfill-messages.ts` (via `src/backfill/messages.ts`) and
 * `scripts/automod-export.ts` (via `src/automod/rulesExport.ts`).
 *
 * What this pins, fixture-driven, with no Postgres, no token, no network:
 *
 *   backfill scan (`findEarlyMessages`):
 *   1. idempotent rerun: two scans over the same fixture produce identical
 *      ladders - same member, same three timestamps in the same order.
 *   2. empty source: no channels at all scans zero, writes zero, reports zero.
 *   3. malformed rows rejected, not silently skipped: a bad timestamp, a
 *      missing message id and a missing author id each increment
 *      `summary.malformed` and never reach a ladder. Before the fix the bad
 *      timestamp threw RangeError and aborted the whole scan, and the missing
 *      id was admitted with `undefined` as its dedupe key.
 *
 *   backfill write (`writeEarlyMessages`, node:sqlite behind the narrow Db):
 *   4. rerun over the same fixture writes the same rows: the second write
 *      inserts 0 new milestone events and the event count is unchanged.
 *   5. empty source writes nothing: zero events, zero members touched.
 *
 *   automod export (`validateAutomodRules`):
 *   6. idempotent rerun: validating the same payload twice yields byte-
 *      identical rules (JSON round trip compares equal).
 *   7. empty source: `[]` validates to `[]` - an empty guild exports an empty
 *      file, not an error.
 *   8. malformed rows rejected, not silently skipped: a rule with no id, one
 *      with no name and a non-object row throw `AutomodExportError` naming
 *      every bad row, and a non-array payload throws too. The script writes
 *      nothing on this path - partial files that look complete are the failure
 *      this exists to end.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  findEarlyMessages,
  writeEarlyMessages,
} from '../src/backfill/messages.ts';
import type { MemberMessages } from '../src/backfill/messages.ts';
import type { DiscordRest, RawMessage } from '../src/discord/rest.ts';
import { EventStore } from '../src/store/eventStore.ts';
import type { Db, Statement } from '../src/store/db.ts';
import {
  AutomodExportError,
  validateAutomodRules,
} from '../src/automod/rulesExport.ts';

const GUILD = 'g5700';

// --- a Discord REST stand-in -----------------------------------------------
// Same shape as test/unit.backfill.test.ts: `scanChannel` pages newest-first
// and stops on a short batch, so one page per channel in descending time is a
// complete scan.

function fakeRest(pages: Record<string, RawMessage[]>): DiscordRest {
  const get = async (path: string): Promise<unknown> => {
    if (path === '/guilds/g5700/channels') {
      return Object.keys(pages).map((id) => ({ id, type: 0, name: `chan-${id}` }));
    }
    if (path.startsWith('/guilds/g5700/threads/active')) return { threads: [] };
    const id = path.match(/^\/channels\/([^/]+)\/messages/)?.[1] ?? '';
    return [...(pages[id] ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  };
  return { get, requests: 0 } as unknown as DiscordRest;
}

const post = (id: string, authorId: string, timestamp: string, bot = false): RawMessage => ({
  id,
  timestamp,
  author: { id: authorId, bot },
});

const FIXTURE: Record<string, RawMessage[]> = {
  c1: [
    post('5', 'alice', '2026-03-05T00:00:00.000Z'),
    post('1', 'alice', '2026-03-01T00:00:00.000Z'),
    post('4', 'alice', '2026-03-04T00:00:00.000Z'),
    post('9', 'botly', '2026-03-06T00:00:00.000Z', true),
  ],
  c2: [
    post('3', 'alice', '2026-03-03T00:00:00.000Z'),
    post('2', 'alice', '2026-03-02T00:00:00.000Z'),
    post('6', 'bob', '2026-03-01T00:00:00.000Z'),
    post('7', 'bob', '2026-03-02T00:00:00.000Z'),
  ],
};

const EXPECTED_ALICE = [
  '2026-03-01T00:00:00.000Z',
  '2026-03-02T00:00:00.000Z',
  '2026-03-03T00:00:00.000Z',
];

function ladderSnapshot(early: Map<string, MemberMessages>): string {
  return JSON.stringify(
    [...early.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([memberId, m]) => [memberId, m.rungs.map((r) => [r.id, r.at, r.channelId])]),
  );
}

// --- offline Db over node:sqlite -------------------------------------------
// Same facade as unit.rosterwelcome.test.ts. Two adaptations for the
// Postgres-isms EventStore emits: `FOR UPDATE` is stripped (single-writer
// fixture, no concurrent process), and the projected `members` columns the
// backfill writes (gate_cleared_at, third_message_at) are created.

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  const clean = sql.replace(/ FOR UPDATE/g, '');
  const stmt = db.prepare(clean);
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
    joined_at TEXT, join_source TEXT, gate_cleared_at TEXT,
    first_message_at TEXT, third_message_at TEXT,
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

async function eventCount(db: Db): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM events`)
    .get<{ n: number }>();
  return Number(row?.n ?? 0);
}

// --- 1-3. the scan ----------------------------------------------------------

describe('backfill scan acceptance', () => {
  test('rerun over the same fixture produces identical ladders', async () => {
    const first = await findEarlyMessages(fakeRest(FIXTURE), {
      guildId: GUILD,
      maxPagesPerChannel: 10,
    });
    const second = await findEarlyMessages(fakeRest(FIXTURE), {
      guildId: GUILD,
      maxPagesPerChannel: 10,
    });
    assert.deepEqual(
      first.early.get('alice')?.rungs.map((r) => r.at),
      EXPECTED_ALICE,
    );
    assert.equal(ladderSnapshot(second.early), ladderSnapshot(first.early));
    assert.deepEqual(second.summary, first.summary);
  });

  test('empty source: zero channels, zero authors, zero malformed', async () => {
    const { early, lastActive, summary } = await findEarlyMessages(fakeRest({}), {
      guildId: GUILD,
      maxPagesPerChannel: 10,
    });
    assert.equal(early.size, 0);
    assert.equal(lastActive.size, 0);
    assert.equal(summary.channelsConsidered, 0);
    assert.equal(summary.messagesRead, 0);
    assert.equal(summary.authorsSeen, 0);
    assert.equal(summary.malformed, 0);
    assert.equal(summary.scannedBackTo, null);
  });

  test('malformed rows are rejected and counted, never laddered', async () => {
    const { early, summary } = await findEarlyMessages(
      fakeRest({
        c1: [
          post('1', 'alice', '2026-03-01T00:00:00.000Z'),
          // An unparseable timestamp: threw RangeError and aborted the whole
          // scan before TOG-5700.
          { id: '2', timestamp: 'not-a-date', author: { id: 'alice' } },
          // No message id: admitted with `undefined` as the dedupe key before.
          { timestamp: '2026-03-02T00:00:00.000Z', author: { id: 'alice' } } as RawMessage,
          // No author id: previously skipped without a trace; now counted.
          { id: '3', timestamp: '2026-03-03T00:00:00.000Z', author: {} } as RawMessage,
          post('4', 'alice', '2026-03-04T00:00:00.000Z'),
          // Bots are skipped, not malformed.
          post('5', 'botly', '2026-03-05T00:00:00.000Z', true),
        ],
      }),
      { guildId: GUILD, maxPagesPerChannel: 10 },
    );
    assert.equal(summary.malformed, 3);
    assert.deepEqual(
      early.get('alice')?.rungs.map((r) => r.id),
      ['1', '4'],
      'only the two well-formed rows reach the ladder',
    );
    assert.equal(early.has('botly'), false);
    assert.equal(summary.messagesRead, 6);
  });
});

// --- 4-5. the write ----------------------------------------------------------

describe('backfill write acceptance', () => {
  test('rerun over the same fixture writes identical output: second run inserts 0', async () => {
    const db = openOfflineDb();
    try {
      const store = new EventStore(db);
      const { early, lastActive } = await findEarlyMessages(fakeRest(FIXTURE), {
        guildId: GUILD,
        maxPagesPerChannel: 10,
      });
      const before = ladderSnapshot(early);
      const first = await writeEarlyMessages(store, GUILD, early, lastActive);
      assert.ok(first.written > 0, 'first run writes the fixture ladders');
      assert.equal(await eventCount(db), first.written);

      // A fresh scan of the same fixture, written again: the no-op re-run the
      // script's own report promises ("a re-run writes 0").
      const rescan = await findEarlyMessages(fakeRest(FIXTURE), {
        guildId: GUILD,
        maxPagesPerChannel: 10,
      });
      assert.equal(ladderSnapshot(rescan.early), before);
      const second = await writeEarlyMessages(store, GUILD, rescan.early, rescan.lastActive);
      assert.equal(second.written, 0);
      assert.equal(await eventCount(db), first.written, 'no duplicate milestone rows');
    } finally {
      await db.close();
    }
  });

  test('empty source writes nothing', async () => {
    const db = openOfflineDb();
    try {
      const store = new EventStore(db);
      const { early, lastActive } = await findEarlyMessages(fakeRest({}), {
        guildId: GUILD,
        maxPagesPerChannel: 10,
      });
      const result = await writeEarlyMessages(store, GUILD, early, lastActive);
      assert.equal(result.written, 0);
      assert.equal(result.laddersCompleted, 0);
      assert.equal(await eventCount(db), 0);
    } finally {
      await db.close();
    }
  });
});

// --- 6-8. the automod export ------------------------------------------------

const RULE_A = {
  id: '111111111111111111',
  name: 'slur blocklist',
  trigger_type: 1,
  actions: [{ type: 1 }],
};
const RULE_B = {
  id: '222222222222222222',
  name: 'spam throttle',
  trigger_type: 3,
  actions: [{ type: 2 }],
};

describe('automod export acceptance', () => {
  test('rerun over the same fixture produces identical output', () => {
    const payload = [RULE_A, RULE_B];
    const first = validateAutomodRules(structuredClone(payload));
    const second = validateAutomodRules(structuredClone(payload));
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(JSON.stringify(first), JSON.stringify(payload));
  });

  test('empty source exports an empty file, not an error', () => {
    assert.deepEqual(validateAutomodRules([]), []);
  });

  test('malformed rows are rejected with every bad row named', () => {
    let err: AutomodExportError | null = null;
    try {
      validateAutomodRules([
        RULE_A,
        { name: 'no id at all' },
        { id: '333333333333333333' },
        'just a string',
        RULE_B,
      ]);
    } catch (e) {
      assert.ok(e instanceof AutomodExportError);
      err = e;
    }
    assert.ok(err, 'expected AutomodExportError');
    assert.equal(err.problems.length, 3);
    assert.match(err.problems.join('\n'), /row 2.*invalid Discord rule id/);
    assert.match(err.problems.join('\n'), /row 3.*has no name/);
    assert.match(err.problems.join('\n'), /row 4 is not an object/);
  });

  test('a non-array payload is rejected', () => {
    assert.throws(() => validateAutomodRules({ rules: [] }), /must be an array/);
    assert.throws(() => validateAutomodRules(null), /must be an array/);
  });
});
