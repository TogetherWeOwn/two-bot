/**
 * TOG-7189: reengagement dry-run on a seeded DB, with an evidence log.
 *
 * What "dry-run" means here: `buildList` with no `markListed` afterwards -
 * exactly what `npm run reengage` does without `--mark`. The job reads the
 * funnel tables and returns IDs; it writes nothing and calls nobody.
 *
 * The seed covers the three member shapes the card names (active, quiet,
 * never-posted) plus the rows that must stay off the list (fresh join in
 * grace, bot, left member, raid-window join). The test asserts:
 *
 *   1. the quiet list is exactly the expected members, in rank order, with
 *      the expected segments,
 *   2. the run wrote zero rows (members snapshot identical, events empty),
 *   3. the run made zero network calls (fetch trap),
 *   4. the script in scope (`scripts/reengagement.ts`) only ever reaches the
 *      read path of the Discord client (`rest.get`), and the client itself
 *      exposes no mutating verb.
 *
 * Runs without Postgres or a token: node:sqlite backs the narrow Db surface
 * the job touches. The Postgres-backed `unit.reengagement` suite covers the
 * same job against the real driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildList } from '../src/jobs/reengagement.ts';
import type { Db, Statement } from '../src/store/db.ts';

const G = 'g1';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

// --- no-send traps ----------------------------------------------------------
// The job takes no Discord client, so any network call is a failure. The fetch
// trap throws on use; silence at the end of the dry-run is the pass.

function installFetchTrap(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error(`TOG-7189: dry-run attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
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
  firstMessageAt?: string | null;
  firstVoiceAt?: string | null;
  isBot?: boolean;
  leftAt?: string | null;
}

async function seedMember(db: Db, id: string, o: SeedOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (guild_id, member_id, joined_at, first_message_at, first_voice_at,
                            last_active_at, is_bot, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(G, id, o.joinedAt, o.firstMessageAt ?? null, o.firstVoiceAt ?? null,
      o.lastActiveAt ?? null, o.isBot ? 1 : 0, o.leftAt ?? null);
}

// --- the static pin: the script only reads, never sends ----------------------

test('scripts/reengagement.ts only reaches the read path - no send surface', () => {
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const script = strip(readFileSync(new URL('../scripts/reengagement.ts', import.meta.url), 'utf8'));
  const rest = strip(readFileSync(new URL('../src/discord/rest.ts', import.meta.url), 'utf8'));

  // The script resolves display names at print time. That is a GET per listed
  // member, and it must stay the only network shape the script can reach.
  // The call-shape match (`rest.<verb>(` or `rest.<verb><`) skips the
  // `rest.ts` import path, which is a file extension, not a method call.
  const restCalls = [...script.matchAll(/rest\.(\w+)\s*[<(]/g)].map((m) => m[1]);
  assert.ok(restCalls.length > 0, 'expected the name-lookup call to still be pinned here');
  assert.deepEqual(
    [...new Set(restCalls)],
    ['get'],
    'scripts/reengagement.ts must only read (rest.get); a new verb is a send path',
  );
  for (const pat of [/\.send\s*\(/, /createDM/, /users\.fetch/, /channels\.fetch/, /Webhook/, /\.post\s*\(/, /\.put\s*\(/]) {
    assert.ok(!pat.test(script), `scripts/reengagement.ts reaches a send-shaped API: ${pat}`);
  }

  // The client the script holds cannot send even if misused: it exposes GET
  // and nothing else. A post/put/patch/delete method appearing here fails
  // this test before any fixture runs.
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    assert.ok(
      !new RegExp(`async\\s+${verb}\\s*[<\\(]`).test(rest),
      `DiscordRest gained a mutating verb: ${verb}`,
    );
  }
});

// --- the dry-run ---------------------------------------------------------------

test('dry-run on seeded DB: exact quiet list, zero writes, zero network', async () => {
  const trap = installFetchTrap();
  try {
    const db = openOfflineDb();
    try {
      await seedMember(db, 'm-active', { joinedAt: daysAgo(300), lastActiveAt: daysAgo(2) });
      await seedMember(db, 'm-quiet', {
        joinedAt: daysAgo(300), firstMessageAt: daysAgo(100), lastActiveAt: daysAgo(30),
      });
      await seedMember(db, 'm-dormant', {
        joinedAt: daysAgo(400), firstVoiceAt: daysAgo(200), lastActiveAt: daysAgo(90),
      });
      await seedMember(db, 'm-never', { joinedAt: daysAgo(30) });
      await seedMember(db, 'm-fresh', { joinedAt: daysAgo(1) });
      await seedMember(db, 'm-bot', {
        joinedAt: daysAgo(300), lastActiveAt: daysAgo(200), isBot: true,
      });
      await seedMember(db, 'm-left', {
        joinedAt: daysAgo(300), lastActiveAt: daysAgo(200), leftAt: daysAgo(10),
      });
      await seedMember(db, 'm-raid', { joinedAt: '2025-07-06T20:40:00.000Z' });

      const membersBefore = await db
        .prepare(`SELECT * FROM members ORDER BY member_id`)
        .all<Record<string, unknown>>();
      const eventsBefore = await db
        .prepare(`SELECT COUNT(*) AS n FROM events`)
        .get<{ n: number }>();

      // The dry-run: build the list, hand it to nobody.
      const list = await buildList(db, G, { now: NOW });

      // 1. The quiet list matches expectation, best save first.
      assert.deepEqual(
        list.entries.map((e) => `${e.memberId}:${e.segment}`),
        ['m-never:never_engaged', 'm-quiet:slipping', 'm-dormant:dormant'],
      );
      assert.deepEqual(
        list.entries.map((e) => e.daysQuiet),
        [null, 30, 90],
      );
      assert.deepEqual(
        list.entries.map((e) => e.engagedVia),
        ['never', 'text', 'voice'],
      );
      assert.deepEqual(
        list.counts,
        { never_engaged: 1, slipping: 1, dormant: 1, lapsed: 0 },
      );
      assert.equal(list.totals.stillActive, 1, 'only m-active is recently active');
      assert.equal(list.setAside.inGracePeriod, 1, 'only m-fresh joined too recently');
      assert.equal(list.setAside.raidAccounts, 1, 'm-raid is set aside, not listed');

      // 2. Nothing was written: same member rows, still no events.
      const membersAfter = await db
        .prepare(`SELECT * FROM members ORDER BY member_id`)
        .all<Record<string, unknown>>();
      const eventsAfter = await db
        .prepare(`SELECT COUNT(*) AS n FROM events`)
        .get<{ n: number }>();
      assert.deepEqual(membersAfter, membersBefore, 'dry-run mutated the members table');
      assert.equal(Number(eventsBefore?.n ?? -1), 0);
      assert.equal(Number(eventsAfter?.n ?? -1), 0, 'dry-run wrote events');

      // 3. Nothing was sent: the job never reached the network.
      assert.deepEqual(trap.calls, [], 'dry-run made a network call');

      // The evidence log: this block is the dry-run record. A green run prints
      // the list it proved; a red run fails above before printing anything.
      console.log(`REENGAGEMENT_DRYRUN_EVIDENCE ${JSON.stringify({
        seeds: 8,
        quietList: list.entries.map((e) => ({
          memberId: e.memberId, segment: e.segment,
          daysQuiet: e.daysQuiet, engagedVia: e.engagedVia,
        })),
        counts: list.counts,
        stillActive: list.totals.stillActive,
        inGracePeriod: list.setAside.inGracePeriod,
        raidAccounts: list.setAside.raidAccounts,
        memberRowsBefore: membersBefore.length,
        memberRowsAfter: membersAfter.length,
        eventsAfter: Number(eventsAfter?.n ?? -1),
        fetchCalls: trap.calls.length,
      })}`);
    } finally {
      await db.close();
    }
  } finally {
    trap.restore();
  }
});
