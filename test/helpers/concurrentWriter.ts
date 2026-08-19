/**
 * A second writer, in a second OS process.
 *
 * Spawned by test/e2e.concurrency.test.ts. It has to be a real process, not
 * another async task in the test's event loop: the thing we are proving is
 * that two independent connections can write the funnel log at the same time,
 * which is exactly what SQLite could not do and why the website was blocked.
 *
 * Usage: node test/helpers/concurrentWriter.ts <json-payload>
 * Prints one line of JSON to stdout with what it managed to write.
 */
import { openDb } from '../../src/store/db.ts';
import { EventStore } from '../../src/store/eventStore.ts';
import type { EventType } from '../../src/core/events.ts';

interface Job {
  url: string;
  schema: string;
  guildId: string;
  /** Members this worker writes for. Overlapping lists are the point. */
  memberIds: string[];
  eventType: EventType;
  /** ISO timestamp used for every event, so the idempotency keys collide. */
  occurredAt: string;
  /** Also bump last_active_at to this, to race the members projection. */
  touchAt?: string;
  label: string;
}

const job: Job = JSON.parse(process.argv[2]);

const db = await openDb(job.url, {
  schema: job.schema,
  applicationName: `two-bot-test-writer:${job.label}`,
  skipMigrations: true, // the test process already migrated
  poolMax: 4,
});
const store = new EventStore(db);

let inserted = 0;
let duplicate = 0;
const errors: string[] = [];

// Fire them all at once rather than in sequence - a serial loop would barely
// overlap with the other process.
await Promise.all(
  job.memberIds.map(async (memberId) => {
    try {
      const r = await store.record({
        guildId: job.guildId,
        memberId,
        eventType: job.eventType,
        occurredAt: job.occurredAt,
        source: `worker:${job.label}`,
      });
      if (r.inserted) inserted++;
      else duplicate++;
      if (job.touchAt) await store.touchActivity(job.guildId, memberId, job.touchAt);
    } catch (err) {
      errors.push(String(err));
    }
  }),
);

await db.close();
process.stdout.write(JSON.stringify({ label: job.label, inserted, duplicate, errors }) + '\n');
