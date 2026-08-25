/**
 * The removal client.
 *
 * This is the only code in the repo that can take a member out of the server,
 * so the tests are about the endings rather than the happy path. A 404 that
 * gets reported as a failure makes a resumable run un-resumable; a 403 that
 * gets retried four times turns a missing permission into two minutes of
 * silence; a 429 that is not obeyed is how an automated cleanup becomes a
 * rate-limit ban on the bot itself.
 *
 * Every test here drives a fake `fetch`. Nothing opens a socket, and the sleep
 * is injected so obeying a 429 costs no wall-clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiscordKicker } from '../src/discord/kick.ts';

const GUILD = '326474832151838730';
const MEMBER = '1234567890123456789';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that replays the given responses in order, recording every call. */
function fakeFetch(responses: Response[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    return res!;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const res = (status: number, body?: unknown, headers?: Record<string, string>) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

/** A kicker whose pacing and backoff are recorded rather than slept. */
function kicker(responses: Response[], opts: { maxRetries?: number } = {}) {
  const { impl, calls } = fakeFetch(responses);
  const slept: number[] = [];
  const k = new DiscordKicker({
    token: 'test-token',
    guildId: GUILD,
    base: 'https://example.invalid/api/v10',
    minIntervalMs: 0,
    maxRetries: opts.maxRetries ?? 4,
    fetchImpl: impl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { k, calls, slept };
}

test('204 is a removal, and it is issued as DELETE on the member route', async () => {
  const { k, calls } = kicker([res(204)]);
  const r = await k.kick(MEMBER, 'because');

  assert.equal(r.outcome, 'kicked');
  assert.equal(r.status, 204);
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'DELETE');
  assert.equal(calls[0]!.url, `https://example.invalid/api/v10/guilds/${GUILD}/members/${MEMBER}`);
});

test('the removal reason reaches Discord, url-encoded so it can never break the request', async () => {
  const { k, calls } = kicker([res(204)]);
  await k.kick(MEMBER, 'Raid cleanup — TOG-411');
  assert.equal(calls[0]!.headers['X-Audit-Log-Reason'], encodeURIComponent('Raid cleanup — TOG-411'));
  assert.equal(calls[0]!.headers.Authorization, 'Bot test-token');
});

test('404 is `already_gone`, not a failure — this is what makes a re-run safe', async () => {
  const { k } = kicker([res(404, { message: 'Unknown Member' })]);
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'already_gone');
  assert.equal(r.status, 404);
});

test('403 is reported once and never retried — a missing permission does not improve', async () => {
  const { k, calls } = kicker([res(403, { message: 'Missing Permissions' })]);
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'forbidden');
  assert.equal(calls.length, 1);
  assert.match(r.detail, /Kick Members/);
});

test('401 is a failure, not a permission problem — the token is what is wrong', async () => {
  const { k, calls } = kicker([res(401, { message: '401: Unauthorized' })]);
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.status, 401);
  assert.equal(calls.length, 1);
});

test('a 429 is obeyed using the body`s retry_after, then the removal goes through', async () => {
  const { k, calls, slept } = kicker([
    res(429, { retry_after: 1.5 }, { 'retry-after': '1' }),
    res(204),
  ]);
  const r = await k.kick(MEMBER, 'because');

  assert.equal(r.outcome, 'kicked');
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2);
  // 1.5s from the body wins over 1s from the header, plus the safety margin.
  assert.ok(slept.includes(1750), `expected a 1750ms wait, got ${JSON.stringify(slept)}`);
});

test('a 429 with no body still waits, using the header', async () => {
  const { k, slept } = kicker([res(429, undefined, { 'retry-after': '2' }), res(204)]);
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'kicked');
  assert.ok(slept.includes(2250), JSON.stringify(slept));
});

test('an absurd retry-after is clamped, so one bad header cannot park the run for a day', async () => {
  const { k, slept } = kicker([res(429, { retry_after: 86_400 }), res(204)]);
  await k.kick(MEMBER, 'because');
  assert.ok(Math.max(...slept) <= 60_000, JSON.stringify(slept));
});

test('rate limiting that outlasts the retry budget gives up cleanly and changes nothing', async () => {
  const { k, calls } = kicker([res(429, { retry_after: 0.1 })], { maxRetries: 2 });
  const r = await k.kick(MEMBER, 'because');

  assert.equal(r.outcome, 'rate_limited');
  assert.equal(r.status, 429);
  assert.equal(calls.length, 3, 'one initial attempt plus two retries');
  assert.match(r.detail, /still rate limited/);
});

test('a 5xx is retried with backoff and then succeeds', async () => {
  const { k, calls, slept } = kicker([res(502), res(502), res(204)]);
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'kicked');
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [500, 1000]);
});

test('a 5xx that never clears is a failure, not a silent success', async () => {
  const { k } = kicker([res(503)], { maxRetries: 2 });
  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.status, 503);
});

test('a socket that never opens is retried, then reported — it never throws at the caller', async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;
  const k = new DiscordKicker({
    token: 't',
    guildId: GUILD,
    minIntervalMs: 0,
    maxRetries: 2,
    fetchImpl: impl,
    sleep: async () => {},
  });

  const r = await k.kick(MEMBER, 'because');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.status, null);
  assert.match(r.detail, /ECONNRESET/);
  assert.equal(n, 3);
});

test('there is no ban, and no verb other than DELETE on the member route', async () => {
  // The guarantee is structural: if a ban path is ever added this fails, and
  // whoever adds it has to come here and argue for it. TOG-411 chose kick
  // because it is reversible; a ban is not.
  const k = new DiscordKicker({ token: 't', guildId: GUILD });
  assert.equal(typeof (k as unknown as Record<string, unknown>).ban, 'undefined');
  assert.deepEqual(
    Object.getOwnPropertyNames(DiscordKicker.prototype).filter((n) => n !== 'constructor').sort(),
    ['kick', 'pace'],
  );
});
