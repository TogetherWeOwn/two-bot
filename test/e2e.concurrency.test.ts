/**
 * Two processes, one funnel log.
 *
 * This is the test the Postgres migration exists for. The bot writes joins and
 * messages; the website will write its own events and read the same tables.
 * These tests assert that racing writers cannot corrupt the log or the members
 * projection.
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EventStore } from '../src/store/eventStore.ts';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';

const run = promisify(execFile);
const WORKER = join(import.meta.dirname, 'helpers', 'concurrentWriter.ts');
const G = 'guild-concurrency';

interface WorkerResult {
  label: string;
  inserted: number;
  duplicate: number;
  errors: string[];
}

describe('concurrent writes from two processes', () => {
  let harness: TestDb;
  let schema: string;

  before(async () => {
    harness = await openTestDb(import.meta.filename);
    // The worker needs the same schema the harness just built.
    const row = await harness.db.prepare(`SELECT current_schema() AS s`).get<{ s: string }>();
    schema = row!.s;
  });
  after(async () => {
    await harness.cleanup();
  });
  beforeEach(async () => {
    await harness.reset();
  });

  async function spawnWriters(jobs: Record<string, unknown>[]): Promise<WorkerResult[]> {
    const out = await Promise.all(
      jobs.map((j) => run(process.execPath, [WORKER, JSON.stringify({ ...j, schema })])),
    );
    return out.map((o) => JSON.parse(o.stdout.trim()) as WorkerResult);
  }

  test('two processes writing the SAME events produce exactly one row each', async () => {
    const members = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const occurredAt = '2026-08-19T12:00:00.000Z';
    const base = { url: TEST_PG_URL, guildId: G, memberIds: members, eventType: 'member_join', occurredAt };

    const results = await spawnWriters([
      { ...base, label: 'bot' },
      { ...base, label: 'website' },
    ]);

    for (const r of results) {
      assert.deepEqual(r.errors, [], `${r.label} hit errors: ${r.errors.join(' | ')}`);
    }

    // Between them the two processes must have inserted each event exactly
    // once. If the idempotency race were unguarded this would be 120 rows, or
    // one of the workers would have died on a unique-violation.
    const totalInserted = results.reduce((n, r) => n + r.inserted, 0);
    assert.equal(totalInserted, members.length, 'each event inserted exactly once across both processes');

    const store = new EventStore(harness.db);
    assert.equal(await store.countByType('member_join'), members.length);

    // And both processes actually did work - if one had simply lost every
    // race the test would pass without proving concurrency.
    assert.ok(
      results.every((r) => r.inserted + r.duplicate === members.length),
      'both processes attempted every event',
    );
  });

  test('two processes writing DIFFERENT members both land', async () => {
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
    const occurredAt = '2026-08-19T13:00:00.000Z';

    const results = await spawnWriters([
      { url: TEST_PG_URL, guildId: G, memberIds: a, eventType: 'member_join', occurredAt, label: 'bot' },
      { url: TEST_PG_URL, guildId: G, memberIds: b, eventType: 'member_join', occurredAt, label: 'website' },
    ]);

    for (const r of results) assert.deepEqual(r.errors, [], r.errors.join(' | '));

    const store = new EventStore(harness.db);
    assert.equal(await store.countByType('member_join'), a.length + b.length);

    // The members projection must have a row for every one of them - the
    // INSERT ... ON CONFLICT DO NOTHING in project() is the thing under test.
    const n = await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE guild_id = ?`)
      .get<{ n: number }>(G);
    assert.equal(Number(n!.n), a.length + b.length);
  });

  test('racing recency updates settle on the latest, not the last to commit', async () => {
    const members = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const shared = {
      url: TEST_PG_URL,
      guildId: G,
      memberIds: members,
      eventType: 'member_join',
      occurredAt: '2026-08-19T14:00:00.000Z',
    };

    // Two writers push different last_active_at values for the same members.
    // touchActivity only moves recency forward, so whichever commits last, the
    // newer timestamp must win.
    const results = await spawnWriters([
      { ...shared, touchAt: '2026-08-19T15:00:00.000Z', label: 'older' },
      { ...shared, touchAt: '2026-08-20T09:00:00.000Z', label: 'newer' },
    ]);
    for (const r of results) assert.deepEqual(r.errors, [], r.errors.join(' | '));

    const stale = await harness.db
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE guild_id = ? AND last_active_at <> ?`)
      .get<{ n: number }>(G, '2026-08-20T09:00:00.000Z');
    assert.equal(Number(stale!.n), 0, 'an older write must never overwrite a newer last_active_at');
  });

  test('a reader sees a consistent log while a writer is mid-flight', async () => {
    // events and members must never disagree: record() writes both in one
    // transaction, so a concurrent reader can see neither or both, never one.
    const members = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const writer = spawnWriters([
      {
        url: TEST_PG_URL,
        guildId: G,
        memberIds: members,
        eventType: 'member_join',
        occurredAt: '2026-08-19T16:00:00.000Z',
        label: 'bot',
      },
    ]);

    let checks = 0;
    let done = false;
    void writer.then(() => {
      done = true;
    });
    while (!done && checks < 200) {
      const row = await harness.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM events WHERE event_type = 'member_join' AND guild_id = ?) AS e,
             (SELECT COUNT(*) FROM members WHERE guild_id = ?) AS m`,
        )
        .get<{ e: number; m: number }>(G, G);
      assert.equal(
        Number(row!.e),
        Number(row!.m),
        'events and members projection drifted apart mid-write',
      );
      checks++;
    }

    const results = await writer;
    assert.deepEqual(results[0].errors, []);
  });
});
