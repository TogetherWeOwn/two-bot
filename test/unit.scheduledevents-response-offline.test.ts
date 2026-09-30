import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db } from '../src/store/db.ts';
import { runScheduledEventsCycle } from '../src/jobs/scheduledEvents.ts';
import { stubRest } from './helpers/stubRest.ts';

const GUILD = '326474832151838730';
const OBSERVED_AT = '2026-09-04T18:00:00.000Z';
const GOOD_EVENT = {
  id: 'event-1',
  name: 'Good event',
  scheduled_start_time: '2026-09-06T18:00:00.000Z',
  status: 1,
};

function poisonDb(touches: string[]): Db {
  const fail = (operation: string): never => {
    touches.push(operation);
    throw new Error(`Unexpected database ${operation}`);
  };
  return {
    prepare: () => fail('prepare'),
    exec: async () => fail('exec'),
    transaction: async () => fail('transaction'),
    close: async () => fail('close'),
  };
}

for (const malformed of [null, true, false, 0, 42, '', 'not an event', [], {}]) {
  test(`malformed element ${JSON.stringify(malformed)} rejects the entire snapshot before database access`, async () => {
    for (const snapshot of [[malformed], [GOOD_EVENT, malformed], [malformed, GOOD_EVENT]]) {
      const touches: string[] = [];
      const db = poisonDb(touches);
      const { rest, paths } = stubRest(() => snapshot);

      const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });

      assert.deepEqual(result, {
        recorded: false,
        reason: 'invalid_response',
        eventCount: null,
        observedAt: OBSERVED_AT,
      });
      assert.deepEqual(touches, []);
      assert.deepEqual(paths, [`/guilds/${GUILD}/scheduled-events`]);
    }
  });
}

for (const response of [undefined, null, { message: 'Something went wrong', code: 0 }]) {
  test(`non-array response ${JSON.stringify(response)} remains a failed read without database access`, async () => {
    const touches: string[] = [];
    const { rest } = stubRest(() => response);

    const result = await runScheduledEventsCycle({
      db: poisonDb(touches), rest, guildId: GUILD, now: () => OBSERVED_AT,
    });

    assert.deepEqual(result, {
      recorded: false,
      reason: 'discord_read_failed',
      eventCount: null,
      observedAt: OBSERVED_AT,
    });
    assert.deepEqual(touches, []);
  });
}

for (const snapshot of [[], [GOOD_EVENT]]) {
  test(`a successful ${snapshot.length === 0 ? 'empty' : 'valid'} array still enters the replacement transaction`, async () => {
    const touches: string[] = [];
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const tx: Db = {
      ...poisonDb(touches),
      prepare(sql) {
        return {
          get: async () => { throw new Error('Unexpected read'); },
          all: async () => { throw new Error('Unexpected read'); },
          run: async (...params) => {
            writes.push({ sql, params });
            return { changes: 1 };
          },
        };
      },
    };
    let transactions = 0;
    const db: Db = {
      ...poisonDb(touches),
      async transaction(fn) {
        transactions++;
        return fn(tx);
      },
    };
    const { rest } = stubRest(() => snapshot);

    const result = await runScheduledEventsCycle({ db, rest, guildId: GUILD, now: () => OBSERVED_AT });

    assert.deepEqual(result, { recorded: true, eventCount: snapshot.length, observedAt: OBSERVED_AT });
    assert.equal(transactions, 1);
    assert.equal(writes.length, snapshot.length + 2);
    assert.deepEqual(writes[0], { sql: 'DELETE FROM scheduled_events WHERE guild_id = ?', params: [GUILD] });
    assert.deepEqual(writes.at(-1), {
      sql: 'UPDATE web_contract_meta SET guild_id = ? WHERE singleton = TRUE', params: [GUILD],
    });
    if (snapshot.length > 0) {
      assert.match(writes[1].sql, /INSERT INTO scheduled_events/);
      assert.deepEqual(writes[1].params, [
        GUILD, GOOD_EVENT.id, GOOD_EVENT.name, GOOD_EVENT.scheduled_start_time,
        null, null, 'scheduled', OBSERVED_AT,
      ]);
    }
    assert.deepEqual(touches, []);
  });
}
