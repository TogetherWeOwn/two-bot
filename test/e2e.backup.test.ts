/**
 * Backup and restore, exercised as a round trip.
 *
 * An untested backup is not a backup, and "the script exited 0" is not a test
 * of a backup - it is a test of the script's happy path. What is asserted here
 * is the property that actually matters during a recovery: dump a database,
 * wipe it, restore it, and the contents are the same, including the things
 * that are easy to lose and hard to notice - the `events` id sequence, and the
 * idempotency keys that stop a join being counted twice.
 *
 * Skipped unless TWO_TEST_DATABASE_URL is set. There is no SQLite dump format;
 * the SQLite path keeps `scripts/backup.sh` until it is deleted (TOG-37).
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { EventStore } from '../src/store/eventStore.ts';
import { dump, restore, DUMP_TABLES } from '../src/store/dump.ts';
import { openTestDb, usingPostgres, type TestDb } from './helpers/testDb.ts';

const G = 'guild-backup';

describe('backup round trip', { skip: !usingPostgres && 'needs TWO_TEST_DATABASE_URL' }, () => {
  let harness: TestDb;
  let store: EventStore;
  let dir: string;

  before(async () => {
    harness = await openTestDb(import.meta.filename);
    store = new EventStore(harness.db);
    dir = mkdtempSync(join(tmpdir(), 'two-backup-'));
  });
  after(async () => {
    await harness.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await harness.reset();
  });

  /** A small but structurally complete database: events, projection, invites. */
  async function seed(members = 5): Promise<void> {
    for (let i = 0; i < members; i++) {
      const id = `m${i}`;
      await store.record({
        guildId: G,
        memberId: id,
        eventType: 'member_join',
        occurredAt: `2026-08-0${(i % 9) + 1}T10:00:00.000Z`,
        source: 'invite:abc',
      });
      if (i % 2 === 0) {
        await store.record({
          guildId: G,
          memberId: id,
          eventType: 'first_message',
          occurredAt: `2026-08-0${(i % 9) + 1}T10:00:30.000Z`,
          source: 'channel:general',
          metadata: { channelId: 'c1' },
        });
      }
    }
    await harness.db
      .prepare(
        `INSERT INTO invite_snapshots (guild_id, code, uses, inviter_id, channel_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(G, 'abc', 12, 'owner', 'c1', '2026-08-09T00:00:00.000Z');
  }

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of DUMP_TABLES) {
      const r = await harness.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{ n: number }>();
      out[t] = Number(r?.n ?? 0);
    }
    return out;
  }

  test('a dump restores to the same contents', async () => {
    await seed();
    const before = await counts();
    const events = await harness.db
      .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
      .all();

    const file = join(dir, 'roundtrip.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.equal(manifest.tables.find((t) => t.name === 'events')?.count, before.events);

    // Lose everything, exactly as a dead disk would.
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    assert.equal((await counts()).events, 0);

    const report = await restore(harness.db, file);
    assert.ok(report.ok, 'restore reported a count mismatch');
    assert.deepEqual(await counts(), before);

    // Same rows, same ids, same order - not merely the same number of rows.
    const after = await harness.db
      .prepare(`SELECT id, event_type, occurred_at, idempotency_key FROM events ORDER BY id`)
      .all();
    assert.deepEqual(after, events);
  });

  test('the id sequence resumes past the restored rows', async () => {
    await seed();
    const file = join(dir, 'sequence.ndjson.gz');
    await dump(harness.db, file);
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const max = await harness.db.prepare(`SELECT MAX(id) AS n FROM events`).get<{ n: number }>();

    // The write that would collide if setval had been forgotten.
    const r = await store.record({
      guildId: G,
      memberId: 'after-restore',
      eventType: 'member_join',
      occurredAt: '2026-08-20T10:00:00.000Z',
      source: 'invite:abc',
    });
    assert.equal(r.inserted, true);
    assert.ok(
      Number(r.eventId) > Number(max!.n),
      `new id ${r.eventId} should be past the restored max ${max!.n}`,
    );
  });

  test('idempotency survives the round trip, so a replayed join is still one join', async () => {
    await seed();
    const file = join(dir, 'idem.ndjson.gz');
    await dump(harness.db, file);
    await harness.db.exec(`TRUNCATE ${DUMP_TABLES.join(', ')} RESTART IDENTITY`);
    await restore(harness.db, file);

    const before = (await counts()).events;
    // The same event the bot already recorded, re-delivered by Discord.
    const again = await store.record({
      guildId: G,
      memberId: 'm0',
      eventType: 'member_join',
      occurredAt: '2026-08-01T10:00:00.000Z',
      source: 'invite:abc',
    });
    assert.equal(again.inserted, false, 'a restored event was not recognised as already present');
    assert.equal((await counts()).events, before);
  });

  test('a truncated dump is refused rather than half-restored', async () => {
    await seed();
    const file = join(dir, 'whole.ndjson.gz');
    await dump(harness.db, file);

    // Chop the end marker off, which is what a full disk leaves behind.
    const lines = gunzipSync(readFileSync(file)).toString('utf8').trimEnd().split('\n');
    const cut = join(dir, 'truncated.ndjson.gz');
    writeFileSync(cut, gzipSync(lines.slice(0, -3).join('\n') + '\n'));

    const before = await counts();
    await assert.rejects(() => restore(harness.db, cut), /truncated|rows/i);
    // And the target is untouched: the transaction rolled back.
    assert.deepEqual(await counts(), before);
  });

  test('an empty database dumps and restores without inventing rows', async () => {
    const file = join(dir, 'empty.ndjson.gz');
    const manifest = await dump(harness.db, file);
    assert.equal(manifest.tables.find((t) => t.name === 'events')?.count, 0);

    const report = await restore(harness.db, file);
    assert.ok(report.ok);
    assert.equal((await counts()).events, 0);
  });
});
