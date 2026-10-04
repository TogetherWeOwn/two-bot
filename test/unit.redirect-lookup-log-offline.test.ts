/**
 * Redirect failure logging (TOG-9994, round-5 gap B5).
 *
 * Hermetic by construction: a throwing in-memory campaign store, a no-op
 * recorder, a real listener on loopback driven with real fetch calls. No
 * Postgres, no token, no network beyond 127.0.0.1. The property being proved
 * is the acceptance on the card: trigger a lookup failure and find the slug
 * AND the error class in the logs, with the 302 behavior unchanged.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.redirect-lookup-log-offline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRedirectServer, type ClickRecorder } from '../src/redirect/server.ts';
import type { CampaignStore } from '../src/redirect/campaigns.ts';

const GUILD = '111222333444555667';
const FALLBACK = 'fallbackCode';

/** Everything written to stderr while `fn` runs (log.error writes there). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  const fake = ((chunk: unknown, ...rest: unknown[]) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    lines.push(text);
    if (text.includes('"msg":"invite_redirect_')) return true;
    return (real as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.stderr.write = fake;
  try {
    await fn();
  } finally {
    process.stderr.write = real;
  }
  return lines.join('');
}

/** A store whose lookup always throws looks exactly like a dead database. */
const throwingStore = (thrown: unknown): CampaignStore =>
  ({
    lookup: async () => {
      throw thrown;
    },
  }) as unknown as CampaignStore;

const quietRecorder: ClickRecorder = {
  onInviteClick: async () => {},
};

const get = async (port: number, path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });

test('a lookup failure still 302s and logs the slug plus the error class', async () => {
  // A TypeError on purpose: the class must come from the constructor, not the
  // message, so a coding bug is distinguishable from a dead database at 3am.
  const down = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns: throwingStore(new TypeError('simulated outage')),
    recorder: quietRecorder,
    fallbackInviteCode: FALLBACK,
  });
  try {
    const logs = await captureStderr(async () => {
      const res = await get(down.port, '/reddit');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), `https://discord.gg/${FALLBACK}`);
      await down.drain();
    });
    assert.ok(
      logs.includes('"msg":"invite_redirect_lookup_failed"'),
      `expected the lookup-failure log line, got: ${logs}`,
    );
    assert.ok(logs.includes('"slug":"reddit"'), `log must name the slug, got: ${logs}`);
    assert.ok(
      logs.includes('"errorClass":"TypeError"'),
      `log must name the error class, got: ${logs}`,
    );
  } finally {
    await down.close();
  }
});

test('a non-Error throw still logs a class (its typeof) instead of nothing', async () => {
  const down = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns: throwingStore('a string, not an Error'),
    recorder: quietRecorder,
    fallbackInviteCode: FALLBACK,
  });
  try {
    const logs = await captureStderr(async () => {
      const res = await get(down.port, '/reddit');
      assert.equal(res.status, 302);
      await down.drain();
    });
    assert.ok(logs.includes('"slug":"reddit"'), `log must name the slug, got: ${logs}`);
    assert.ok(logs.includes('"errorClass":"string"'), `log must name the typeof, got: ${logs}`);
  } finally {
    await down.close();
  }
});

test('a malformed percent-escape is a logged 404 carrying the error class', async () => {
  // decodeURIComponent throws URIError on a bad escape; the bare `catch {}`
  // this replaces swallowed that silently. The log carries the raw path (the
  // requested campaign slot) and the class — never visitor data.
  const srv = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns: throwingStore(new Error('must not be reached')),
    recorder: quietRecorder,
    fallbackInviteCode: FALLBACK,
  });
  try {
    const logs = await captureStderr(async () => {
      const res = await get(srv.port, '/%E0%A4%A');
      assert.equal(res.status, 404);
      await srv.drain();
    });
    assert.ok(
      logs.includes('"msg":"invite_redirect_decode_failed"'),
      `expected the decode-failure log line, got: ${logs}`,
    );
    assert.ok(
      logs.includes('"errorClass":"URIError"'),
      `log must name the error class, got: ${logs}`,
    );
    for (const leak of ['Mozilla', '127.0.0.1', 'cookie']) {
      assert.ok(!logs.includes(leak), `failure log must not contain ${leak}: ${logs}`);
    }
  } finally {
    await srv.close();
  }
});
