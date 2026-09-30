import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { DiscordAnnouncements } from '../src/announcements/discord.ts';
import { AnnouncementsService } from '../src/announcements/service.ts';
import type { AnnouncementsStore, RsvpStatus } from '../src/announcements/store.ts';

const GUILD = '1550000000000000001';
const EVENT = '1550000000000000003';
const USER = '1550000000000000004';
const NOW = new Date('2026-09-10T10:00:00.000Z');
const BASE = 'https://discord.invalid/api/v10';
const INPUT = { guildId: GUILD, eventId: EVENT, userId: USER, status: 'going' as const, now: NOW };

const originalFetch = globalThis.fetch;
let networkCalls = 0;
before(() => {
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('RSVP regression suite attempted a live network call.');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkCalls, 0, 'only injected fetch may be called');
});

function fixture(read: () => Promise<Response>) {
  const writes: Array<Parameters<AnnouncementsStore['putRsvp']>[0]> = [];
  const audits: Array<Parameters<AnnouncementsStore['audit']>> = [];
  const store: Pick<AnnouncementsStore, 'putRsvp' | 'audit'> = {
    putRsvp: async (row) => { writes.push(row); },
    audit: async (...args) => { audits.push(args); },
  };
  const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const discord = new DiscordAnnouncements({
    token: 'test-token',
    base: BASE,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), signal: init?.signal });
      return read();
    },
  });
  return {
    service: new AnnouncementsService(store as AnnouncementsStore, discord),
    writes,
    audits,
    assertRead(count = 1) {
      assert.equal(requests.length, count, 'one event read per RSVP, no extra Discord writes');
      for (const request of requests) {
        assert.equal(request.url, `${BASE}/guilds/${GUILD}/scheduled-events/${EVENT}`);
        assert.ok(request.signal instanceof AbortSignal, 'event read must be bounded by a signal');
      }
    },
    assertNoWrites() {
      assert.equal(writes.length, 0, 'refused RSVP must not reach putRsvp');
      assert.equal(audits.length, 0, 'refused RSVP must not audit a saved response');
    },
  };
}

for (const status of [403, 429, 503]) {
  test(`rsvp refuses upstream HTTP ${status} without writing or auditing`, async () => {
    // Even a valid-looking event body must not hide an upstream failure.
    const f = fixture(async () => Response.json({ status: 1 }, { status }));
    await assert.rejects(f.service.rsvp(INPUT), { message: `Discord request failed: HTTP ${status}` });
    f.assertRead();
    f.assertNoWrites();
  });
}

const malformed: Array<{ name: string; response: () => Response }> = [
  { name: 'invalid JSON', response: () => new Response('{', { status: 200 }) },
  { name: 'missing status', response: () => Response.json({}) },
  { name: 'string status', response: () => Response.json({ status: '1' }) },
  { name: 'fractional status', response: () => Response.json({ status: 1.5 }) },
  { name: 'status below range', response: () => Response.json({ status: 0 }) },
  { name: 'status above range', response: () => Response.json({ status: 5 }) },
  { name: 'null body', response: () => Response.json(null) },
  { name: 'empty 204 body', response: () => new Response(null, { status: 204 }) },
];

for (const { name, response } of malformed) {
  test(`rsvp refuses successful response with ${name} without writing or auditing`, async () => {
    const f = fixture(async () => response());
    await assert.rejects(f.service.rsvp(INPUT), { message: 'Discord returned an invalid scheduled event status.' });
    f.assertRead();
    f.assertNoWrites();
  });
}

test('rsvp propagates a rejected fetch without treating it as a missing event or saved response', async () => {
  const error = new TypeError('synthetic fetch rejection');
  const f = fixture(async () => { throw error; });
  await assert.rejects(f.service.rsvp(INPUT), (caught) => caught === error);
  f.assertRead();
  f.assertNoWrites();
});

for (const status of [1, 2, 3]) {
  test(`rsvp saves and audits valid event status ${status}`, async () => {
    const f = fixture(async () => Response.json({ status }));
    for (const response of ['going', 'interested', 'declined'] as RsvpStatus[]) {
      assert.equal(await f.service.rsvp({ ...INPUT, status: response }), response);
      assert.deepEqual(f.writes.at(-1), { ...INPUT, status: response, respondedAt: NOW.toISOString() });
      assert.deepEqual(f.audits.at(-1), [{
        guildId: GUILD, actorId: USER, action: 'event.rsvp', targetKey: EVENT, outcome: response,
      }, NOW.toISOString()]);
    }
    f.assertRead(3);
    assert.equal(f.writes.length, 3);
    assert.equal(f.audits.length, 3);
  });
}

for (const { name, response, message } of [
  { name: 'cancelled status 4', response: () => Response.json({ status: 4 }), message: 'That scheduled event is cancelled.' },
  { name: 'missing HTTP 404', response: () => new Response(null, { status: 404 }), message: 'No scheduled event with that id exists in this server.' },
]) {
  test(`rsvp preserves refusal for ${name} without writing or auditing`, async () => {
    const f = fixture(async () => response());
    await assert.rejects(f.service.rsvp(INPUT), { message });
    f.assertRead();
    f.assertNoWrites();
  });
}
