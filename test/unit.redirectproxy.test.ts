/**
 * The redirect behind a reverse proxy (TOG-9924).
 *
 * DB-free: stub campaigns and a stub recorder over a real listener on a real
 * socket. The thing being proved is bucketing: two visitors arriving on one
 * proxy socket must not share a throttle bucket, while a burst from one
 * client - and a spoofed X-Forwarded-For from an untrusted socket - still 429.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startRedirectServer,
  type ClickRecorder,
  type RedirectServer,
  type RedirectServerOptions,
} from '../src/redirect/server.ts';
import type { CampaignStore } from '../src/redirect/campaigns.ts';

const CODE = 'aB3xY9';

const stubCampaigns = {
  lookup: async (slug: string) =>
    slug === 'reddit'
      ? { slug, inviteCode: CODE, label: 'a place we post', disabledAt: null, createdAt: '2026-09-03T12:00:00.000Z' }
      : null,
} as unknown as CampaignStore;

const stubRecorder: ClickRecorder = {
  onInviteClick: async () => {},
};

let clicks = 0;
const countingRecorder: ClickRecorder = {
  onInviteClick: async () => {
    clicks += 1;
  },
};

async function start(
  overrides: Partial<RedirectServerOptions> = {},
): Promise<RedirectServer> {
  return startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: '111222333444555666',
    campaigns: stubCampaigns,
    recorder: countingRecorder,
    // Capacity 1 with a frozen clock: the first request consumes the bucket
    // and refill cannot rescue it, so the verdict is deterministic.
    bucket: { capacity: 1, refillPerSecond: 0 },
    now: () => 1_000_000,
    ...overrides,
  });
}

const get = async (server: RedirectServer, path: string, xff?: string) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    redirect: 'manual',
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });
  await server.drain();
  return res;
};

let server: RedirectServer;

before(async () => {
  clicks = 0;
});

after(async () => {
  await server?.close();
});

test('two visitors behind one proxy socket do not share a bucket (the TOG-9924 repro)', async () => {
  server = await start();
  try {
    // Before the fix both requests keyed on the one socket IP: the second
    // 429d and no click was recorded. After the fix each XFF gets its bucket.
    assert.equal((await get(server, '/reddit', '198.51.100.9')).status, 302);
    assert.equal((await get(server, '/reddit', '198.51.100.10')).status, 302);
    assert.equal(clicks, 2);
    // And the first visitor bursting again still hits their own cap.
    assert.equal((await get(server, '/reddit', '198.51.100.9')).status, 429);
    assert.equal(clicks, 2);
  } finally {
    await server.close();
  }
});

test('one client bursting through the proxy still 429s', async () => {
  server = await start();
  try {
    assert.equal((await get(server, '/reddit', '198.51.100.9')).status, 302);
    assert.equal((await get(server, '/reddit', '198.51.100.9')).status, 429);
  } finally {
    await server.close();
  }
});

test('a spoofed header from an untrusted socket buys nothing', async () => {
  // No trusted proxies: even loopback is untrusted, so X-Forwarded-For is
  // ignored and every request shares the socket bucket.
  server = await start({ trustedProxies: [] });
  try {
    assert.equal((await get(server, '/reddit', '198.51.100.9')).status, 302);
    assert.equal((await get(server, '/reddit', '198.51.100.99')).status, 429);
  } finally {
    await server.close();
  }
});

test('direct requests with no header still throttle on the socket', async () => {
  server = await start();
  try {
    assert.equal((await get(server, '/reddit')).status, 302);
    assert.equal((await get(server, '/reddit')).status, 429);
  } finally {
    await server.close();
  }
});
