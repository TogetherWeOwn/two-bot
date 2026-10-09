import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRest, fetchAllMembersObserved } from '../src/discord/rest.ts';

const START = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T10:01:00.000Z';
const FINISHED = '2026-09-30T10:02:00.000Z';

test('roster evidence uses request start even when headers and body arrive later', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(START) });
  try {
    const rest = new DiscordRest({
      token: 'fixture', minIntervalMs: 0,
      fetchImpl: async () => {
        mock.timers.setTime(Date.parse(LATER));
        class DelayedResponse extends Response {
          override readonly json = async () => {
            mock.timers.setTime(Date.parse(FINISHED));
            return [{ user: { id: 'member' }, joined_at: START }];
          };
        }
        return new DelayedResponse();
      },
    });
    assert.deepEqual(await fetchAllMembersObserved(rest, 'guild'), [
      { member: { user: { id: 'member' }, joined_at: START }, observedAt: START },
    ]);
  } finally { mock.timers.reset(); }
});

test('a retried roster read carries the successful request bound, not the failed attempt', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(START) });
  try {
    let calls = 0;
    const rest = new DiscordRest({
      token: 'fixture', minIntervalMs: 0,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) {
          mock.timers.setTime(Date.parse(LATER));
          return new Response(null, { status: 503 });
        }
        mock.timers.setTime(Date.parse(FINISHED));
        return Response.json([{ user: { id: 'member' }, joined_at: START }]);
      },
    });
    assert.deepEqual(await fetchAllMembersObserved(rest, 'guild'), [
      { member: { user: { id: 'member' }, joined_at: START }, observedAt: LATER },
    ]);
    assert.equal(calls, 2);
    assert.equal(rest.requests, 2);
  } finally { mock.timers.reset(); }
});

test('observed roster reads refuse a failed page and ordinary GET retains its data contract', async () => {
  const rest = new DiscordRest({
    token: 'fixture', minIntervalMs: 0,
    fetchImpl: async (url) => String(url).includes('/members?')
      ? new Response(null, { status: 403 })
      : Response.json({ value: 1 }),
  });
  assert.equal(await fetchAllMembersObserved(rest, 'guild'), null);
  assert.deepEqual(await rest.get('/other'), { value: 1 });
});
