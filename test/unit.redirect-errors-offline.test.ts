/**
 * Redirect response contracts over real loopback HTTP, with no database or
 * Discord calls. Run: node --test test/unit.redirect-errors-offline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Campaign, CampaignStore } from '../src/redirect/campaigns.ts';
import { startRedirectServer } from '../src/redirect/server.ts';

const CAMPAIGN: Campaign = {
  slug: 'reddit',
  inviteCode: 'aB3xY9',
  label: 'fixture',
  disabledAt: null,
  createdAt: '2026-09-03T12:00:00.000Z',
};
const FALLBACK = 'fallbackCode';
const OUTAGE = 'simulated backend failure: fixture-only detail';

interface ResponseCase {
  name: string;
  lookup: () => Promise<Campaign | null>;
  fallbackInviteCode?: string;
  status: number;
  body: string;
  location?: string;
  retryAfter?: string;
}

const missing = async () => null;
const badCode = async () => ({ ...CAMPAIGN, inviteCode: 'has space' });
const outage = async (): Promise<Campaign | null> => { throw new Error(OUTAGE); };
const cases: ResponseCase[] = [
  { name: 'unknown slug', lookup: missing, status: 404, body: 'not found\n' },
  {
    name: 'unknown slug even with a fallback', lookup: missing, fallbackInviteCode: FALLBACK,
    status: 404, body: 'not found\n',
  },
  { name: 'bad campaign code', lookup: badCode, status: 500, body: 'misconfigured campaign\n' },
  {
    name: 'bad campaign code even with a fallback', lookup: badCode, fallbackInviteCode: FALLBACK,
    status: 500, body: 'misconfigured campaign\n',
  },
  {
    name: 'backend lookup failure without a fallback', lookup: outage,
    status: 503, body: 'temporarily unavailable\n', retryAfter: '30',
  },
  {
    name: 'backend lookup failure with an invalid fallback', lookup: outage, fallbackInviteCode: 'has space',
    status: 503, body: 'temporarily unavailable\n', retryAfter: '30',
  },
  {
    name: 'backend lookup failure with a valid fallback', lookup: outage, fallbackInviteCode: FALLBACK,
    status: 302, body: `redirecting to https://discord.gg/${FALLBACK}\n`,
    location: `https://discord.gg/${FALLBACK}`,
  },
];

for (const fixture of cases) {
  for (const method of ['GET', 'HEAD']) {
    test(`${method}: ${fixture.name} pins status, headers and body without recording`, async (t) => {
      const lookups: string[] = [];
      let recordings = 0;
      // The server only needs lookup; fake that boundary, not the HTTP handler.
      const campaigns: Pick<CampaignStore, 'lookup'> = {
        lookup: async (slug) => {
          lookups.push(slug);
          return fixture.lookup();
        },
      };
      const server = await startRedirectServer({
        host: '127.0.0.1',
        port: 0,
        guildId: 'fixture-guild',
        campaigns: campaigns as CampaignStore,
        recorder: { onInviteClick: async () => { recordings++; } },
        fallbackInviteCode: fixture.fallbackInviteCode,
      });
      t.after(() => server.close());

      // Manual redirect is essential: never follow a fallback to Discord.
      const response = await fetch(`http://127.0.0.1:${server.port}/reddit`, {
        method, redirect: 'manual',
      });
      assert.equal(response.status, fixture.status);
      assert.equal(response.headers.get('content-type'), 'text/plain');
      assert.equal(response.headers.get('location'), fixture.location ?? null);
      assert.equal(response.headers.get('retry-after'), fixture.retryAfter ?? null);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(
        response.headers.get('cache-control'),
        fixture.location ? 'no-store, no-cache, must-revalidate' : null,
      );
      assert.equal(response.headers.get('referrer-policy'), fixture.location ? 'no-referrer' : null);
      // Exact text (including newline) also excludes backend details and the
      // invalid invite code. HEAD retains the status/headers but sends no body.
      assert.equal(await response.text(), method === 'HEAD' ? '' : fixture.body);
      await server.drain();
      assert.deepEqual(lookups, ['reddit']);
      assert.equal(recordings, 0);
    });
  }
}

for (const failRecording of [false, true]) {
  test(`a valid campaign pins its 302 shape when click recording ${failRecording ? 'fails' : 'succeeds'}`, async (t) => {
    let recordings = 0;
    const campaigns: Pick<CampaignStore, 'lookup'> = { lookup: async () => CAMPAIGN };
    const server = await startRedirectServer({
      host: '127.0.0.1',
      port: 0,
      guildId: 'fixture-guild',
      campaigns: campaigns as CampaignStore,
      recorder: {
        onInviteClick: async () => {
          recordings++;
          if (failRecording) throw new Error(OUTAGE);
        },
      },
      fallbackInviteCode: FALLBACK,
    });
    t.after(() => server.close());

    const response = await fetch(`http://127.0.0.1:${server.port}/reddit`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('location'), 'https://discord.gg/aB3xY9');
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('retry-after'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), 'redirecting to https://discord.gg/aB3xY9\n');
    await server.drain();
    assert.equal(recordings, 1);
  });
}
