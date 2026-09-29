/**
 * TOG-6498: staging-discord-fetch fixture acceptance over mock HTTP.
 *
 * WHY THIS EXISTS. scripts/staging-discord-fetch.ts is the transport every
 * staging proof fetches live state through (staging-announcements-proof.ts,
 * staging-announcements-verify.ts), but its only coverage was an in-process
 * stub fetchImpl returning canned Response objects - nothing ever pinned the
 * wire shape (method, auth header, path) or the named errors through the real
 * composition (proofDiscordFetch wrapping + DiscordActions mapping) that the
 * proofs actually run. A stub that never touches HTTP cannot catch a wrong
 * base join, a dropped Authorization header, or a status mapped to the wrong
 * ActionError code.
 *
 * WHAT IT PINS, against a loopback node:http server (no live Discord, no
 * guild writes, no token, no Postgres):
 * - one canned endpoint: GET /guilds/{guild}/members/{user} returns the
 *   { roles } shape and DiscordActions.memberRoles hands back exactly it,
 *   with method GET and `Bot <token>` auth observed on the wire;
 * - named error on 429: three 429s exhaust the proof transport's bounded
 *   retry budget, then DiscordActions maps the survivor to `rate_limited`
 *   (retryable, HTTP 429) with the header delay preserved;
 * - named error on 5xx: a 500 passes through un-retried and maps to
 *   `discord_unavailable` (retryable, HTTP 502).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { proofDiscordFetch } from '../scripts/staging-discord-fetch.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { ActionError, retryableFor, statusFor } from '../src/internal/errors.ts';

const GUILD = '100000000000000001';
const USER = '100000000000000002';
const TOKEN = 'fixture-bot-token';
const ROLES = ['100000000000000010', '100000000000000011'];

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

async function startMock(handler: (seen: Seen[], url: string) => { status: number; body: unknown; headers?: Record<string, string> }): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let server: Server;
  server = createServer((req, res) => {
    seen.push({
      method: req.method ?? 'GET',
      path: req.url ?? '',
      authorization: req.headers.authorization ?? null,
    });
    const out = handler(seen, req.url ?? '');
    json(res, out.status, out.body, out.headers);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/v10`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function clientFor(base: string, sleeps: number[]): DiscordActions {
  const wrapped = proofDiscordFetch({
    fetchImpl: fetch,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return new DiscordActions({ token: TOKEN, base, fetchImpl: wrapped });
}

test('staging fetch pins canned member-roles shape over mock HTTP', async (t) => {
  const mock = await startMock((_seen, url) => {
    assert.equal(url, `/api/v10/guilds/${GUILD}/members/${USER}`);
    return { status: 200, body: { roles: ROLES } };
  });
  t.after(() => mock.close());
  const sleeps: number[] = [];
  const roles = await clientFor(mock.base, sleeps).memberRoles(GUILD, USER);
  assert.deepEqual(roles, ROLES);
  assert.deepEqual(sleeps, [], 'success performs no rate-limit sleep');
  assert.equal(mock.seen.length, 1);
  assert.equal(mock.seen[0]!.method, 'GET');
  assert.equal(mock.seen[0]!.authorization, `Bot ${TOKEN}`);
  assert.ok(!JSON.stringify(mock.seen).includes('discord.com'), 'no live Discord host touched');
});

test('staging fetch surfaces named error on 429 after bounded retries', async (t) => {
  const mock = await startMock(() => ({
    status: 429,
    body: { retry_after: 0 },
    headers: { 'retry-after': '2' },
  }));
  t.after(() => mock.close());
  const sleeps: number[] = [];
  const error = await clientFor(mock.base, sleeps).memberRoles(GUILD, USER).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(error instanceof ActionError, 'expected ActionError');
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.retryAfter, 2, 'header delay preserved for the caller');
  assert.equal(retryableFor(error.code), true);
  assert.equal(statusFor(error.code), 429);
  assert.equal(mock.seen.length, 3, 'one initial request plus two bounded retries');
  assert.deepEqual(sleeps, [250, 250], 'body retry_after 0s + 250ms pacing per retry');
});

test('staging fetch surfaces named error on 5xx without retry', async (t) => {
  const mock = await startMock(() => ({ status: 500, body: {} }));
  t.after(() => mock.close());
  const sleeps: number[] = [];
  const error = await clientFor(mock.base, sleeps).memberRoles(GUILD, USER).then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(error instanceof ActionError, 'expected ActionError');
  assert.equal(error.code, 'discord_unavailable');
  assert.equal(retryableFor(error.code), true);
  assert.equal(statusFor(error.code), 502);
  assert.equal(mock.seen.length, 1, '5xx is never retried: a write may already have happened');
  assert.deepEqual(sleeps, []);
});
