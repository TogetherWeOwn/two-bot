/**
 * TOG-5685: the inactivity and reengagement jobs produce lists, never messages.
 *
 * docs/PRIVACY.md draws the line here, not later: the inactivity job writes an
 * event and returns IDs; the reengagement list is worked by a human by hand.
 * Anything outbound needs explicit CEO sign-off before it is built, not after.
 *
 * These tests are the thing that fails first if an outbound feature is ever
 * added. Each one installs traps that fail on any Discord send/message call -
 * a hostile mock client and a counting global fetch stub - then runs both jobs
 * across the edge fixtures (empty list, large list, repeat run) and asserts:
 *
 *   1. the jobs return the right lists,
 *   2. the only event type written is `member_inactive`,
 *   3. no trap fired.
 *
 * The jobs take no Discord client at all - their signatures are `(db, store,
 * ...)` only - which is itself part of the guarantee, so arity and the import
 * surface are pinned too: if a client parameter or a discord import appears,
 * the pin fails before any fixture runs.
 *
 * Runs without Postgres or a token: node:sqlite backs the narrow Db surface
 * the jobs touch (`?` placeholders, UPSERT, RETURNING). The Postgres-backed
 * suites still cover the same jobs against the real driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from '../src/store/eventStore.ts';
import { flagInactive, joinedNeverPosted } from '../src/jobs/inactivity.ts';
import { buildList, markListed } from '../src/jobs/reengagement.ts';
import type { Db, Statement } from '../src/store/db.ts';

const G = 'g1';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

// --- no-send traps ----------------------------------------------------------
// Any outbound Discord path goes through fetch (REST) or a discord.js object
// (channel/user send, DM create). Both are trapped: the mock client throws on
// any messaging-shaped access, and fetch counts every call. The jobs under
// test accept neither, so a silent trap at the end of each test is the pass.

interface Trap {
  sends: string[];
  fetchCalls: string[];
  hostileClient: unknown;
  restore: () => void;
}

function installTrap(): Trap {
  const sends: string[] = [];
  const fetchCalls: string[] = [];
  const fail = (where: string): never => {
    sends.push(where);
    throw new Error(`TOG-5685: outbound Discord call attempted at ${where}`);
  };
  const hostileClient = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop === 'string' && /send|message|dm|channel|user|webhook|rest|create|post|put|delete|fetch/i.test(prop)) {
          fail(`client.${prop}`);
        }
        return () => fail(`client.${String(prop)}()`);
      },
    },
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    return fail(`fetch ${String(input)}`);
  }) as unknown as typeof fetch;
  return { sends, fetchCalls, hostileClient, restore: () => { globalThis.fetch = originalFetch; } };
}

function assertSilent(trap: Trap): void {
  assert.deepEqual(trap.sends, [], 'a send/message API was invoked by a list-only job');
  assert.deepEqual(trap.fetchCalls, [], 'a job made a network call; lists come from the funnel tables only');
}

// --- minimal Db over node:sqlite ---------------------------------------------

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
  joinedAt: string;
  lastActiveAt?: string | null;
  isBot?: boolean;
  leftAt?: string | null;
}

async function seedMember(db: Db, id: string, o: SeedOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, last_active_at, is_bot, left_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(G, id, o.joinedAt, o.lastActiveAt ?? null, o.isBot ? 1 : 0, o.leftAt ?? null);
}

async function eventTypes(db: Db): Promise<string[]> {
  return (await db.prepare(`SELECT DISTINCT event_type AS t FROM events`).all<{ t: string }>())
    .map((r) => r.t)
    .sort();
}

// --- the static pin: no Discord surface in the job sources -------------------

test('inactivity/reengagement sources import no Discord surface and call no send API', () => {
  for (const file of ['src/jobs/inactivity.ts', 'src/jobs/reengagement.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // Comments state the guarantee ("no Discord call"); strip them so the
    // statement of the rule cannot satisfy the check for the rule.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const line of code.split('\n')) {
      if (/^\s*import/.test(line)) {
        assert.ok(!/discord/i.test(line), `${file} imports a discord module: ${line.trim()}`);
      }
    }
    assert.ok(!/\.send\s*\(/.test(code), `${file} calls a .send() API`);
    assert.ok(!/createDM|channels\.fetch|users\.fetch|Webhook/i.test(code), `${file} reaches a messaging API`);
  }
});

test('the jobs take no Discord client - arity is part of the guarantee', () => {
  // If a future change adds a client parameter so the jobs *can* message,
  // these fail before any fixture runs.
  assert.equal(flagInactive.length, 3, 'flagInactive(db, store, days)');
  assert.equal(joinedNeverPosted.length, 2, 'joinedNeverPosted(db, guildId)');
  assert.equal(buildList.length, 2, 'buildList(db, guildId, opts?)');
  assert.equal(markListed.length, 3, 'markListed(store, guildId, entries)');
});

// --- edge fixture: empty list -------------------------------------------------

test('empty server: both jobs return empty lists and send nothing', async () => {
  const trap = installTrap();
  try {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      assert.deepEqual(await flagInactive(db, store, 14), []);
      assert.deepEqual(await joinedNeverPosted(db, G), []);
      const list = await buildList(db, G, { now: NOW });
      assert.deepEqual(list.entries, []);
      assert.equal(await markListed(store, G, list.entries), 0);
      assert.deepEqual(await eventTypes(db), [], 'an empty run writes no events at all');
      assertSilent(trap);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});

// --- edge fixture: large list ---------------------------------------------------

test('large list: 500 quiet flagged, 500 active spared, and nothing sent', async () => {
  const trap = installTrap();
  try {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      // Joined 2026-02-01: outside every raid window, so all 500 are real list
      // candidates rather than set-aside accounts.
      for (let i = 0; i < 500; i++) {
        await seedMember(db, `quiet-${i}`, { joinedAt: '2026-02-01T00:00:00.000Z', lastActiveAt: '2026-02-01T00:00:00.000Z' });
        await seedMember(db, `active-${i}`, { joinedAt: '2026-02-01T00:00:00.000Z', lastActiveAt: new Date(NOW).toISOString() });
      }
      await seedMember(db, 'bot-1', { joinedAt: '2026-02-01T00:00:00.000Z', lastActiveAt: '2026-02-01T00:00:00.000Z', isBot: true });

      const flagged = await flagInactive(db, store, 14);
      assert.equal(flagged.length, 500, 'every quiet human flagged, no active member, no bot');
      assert.ok(!flagged.some((id) => id.startsWith('active-') || id.startsWith('bot-')));

      const list = await buildList(db, G, { now: NOW });
      assert.equal(list.entries.length, 500);
      assert.equal(await markListed(store, G, list.entries), 500);

      assert.deepEqual(await eventTypes(db), ['member_inactive'], 'list-only jobs write one event type and no others');
      assertSilent(trap);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});

// --- edge fixture: repeat run -----------------------------------------------------

test('repeat run: second sweep flags nothing new and still sends nothing', async () => {
  const trap = installTrap();
  try {
    const db = openOfflineDb();
    const store = new EventStore(db);
    try {
      for (const id of ['q1', 'q2', 'q3']) {
        await seedMember(db, id, { joinedAt: daysAgo(300), lastActiveAt: daysAgo(30) });
      }

      assert.deepEqual((await flagInactive(db, store, 14)).sort(), ['q1', 'q2', 'q3']);
      // Re-running the sweep must not re-flag the same members - and must not
      // message them either.
      assert.deepEqual(await flagInactive(db, store, 14), []);

      // The sweep records the handover, so the weekly list already knows these
      // names are not new - that linkage is what keeps the team from working
      // the same forty names every Monday.
      const first = await buildList(db, G, { now: NOW });
      assert.equal(first.entries.length, 3);
      assert.ok(first.entries.every((e) => e.previouslyListedAt !== null), 'sweep already handed them over');
      assert.equal(await markListed(store, G, first.entries), 3);

      const second = await buildList(db, G, { now: NOW });
      assert.equal(second.entries.length, 3);
      assert.ok(second.entries.every((e) => e.previouslyListedAt !== null), 'carried over, not new');

      assert.deepEqual(await eventTypes(db), ['member_inactive']);
      assertSilent(trap);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});
