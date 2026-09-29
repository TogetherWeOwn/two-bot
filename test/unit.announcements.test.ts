import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { AnnouncementsService, normalizeFeedSource, parseRoleSpec, type FeedItem } from '../src/announcements/service.ts';
import { loadAnnouncementsConfig } from '../src/announcements/config.ts';
import { AnnouncementsStore, type FeedRelayRow } from '../src/announcements/store.ts';
import { announcementCommandData, DiscordAnnouncements, parseXmlFeed, XmlFeedReader } from '../src/announcements/discord.ts';
import { assertPublicHostname, createPublicLookup, isPublicAddress, readLimitedText } from '../src/announcements/feedHttp.ts';
import { openTestDb } from './helpers/testDb.ts';

const GUILD = '1545644954272137297';
const STAGING_TOKEN = `${Buffer.from('1469137636663758888').toString('base64url')}.mock.signature`;
const CHANNEL = '1546451670500642826';
const EVENT = '1546451670500642999';
const USER = '1546451670500642888';
const dbFixture = await openTestDb(import.meta.filename);
const store = new AnnouncementsStore(dbFixture.db);

class FakeDiscord {
  posts: Array<{ channelId: string; content: string; nonce?: string; components?: unknown[] }> = [];
  edits: Array<{ channelId: string; messageId: string; content: string; components?: unknown[] }> = [];
  nonceMessages = new Map<string, string>();
  scheduledEventStatuses = new Map<string, number>([[EVENT, 1]]);

  async postMessage(channelId: string, content: string, options: { nonce?: string; components?: unknown[] } = {}) {
    this.posts.push({ channelId, content, ...options });
    const id = String(1600000000000000000n + BigInt(this.posts.length));
    if (options.nonce) this.nonceMessages.set(options.nonce, id);
    return id;
  }

  async editMessage(channelId: string, messageId: string, content: string, components?: unknown[]) {
    this.edits.push({ channelId, messageId, content, components });
  }

  async findMessageByNonce(_channelId: string, nonce: string) {
    return this.nonceMessages.get(nonce) ?? null;
  }

  async getScheduledEventStatus(_guildId: string, eventId: string) {
    return this.scheduledEventStatuses.get(eventId) ?? null;
  }
}

beforeEach(async () => dbFixture.reset());
after(async () => dbFixture.cleanup());

test('feature is default-off and fenced by the live-activation allowlist', () => {
  assert.deepEqual(loadAnnouncementsConfig({}, null), { enabled: false, feedPollSeconds: 300 });
  assert.throws(
    () => loadAnnouncementsConfig({ TWO_ANNOUNCEMENTS: '1', DISCORD_GUILD_ID: '326474832151838730' }, STAGING_TOKEN),
    /allowlist refused announcements/,
  );
  assert.deepEqual(
    loadAnnouncementsConfig({ TWO_ANNOUNCEMENTS: '1', DISCORD_GUILD_ID: GUILD, TWO_FEED_POLL_SECONDS: '60' }, STAGING_TOKEN),
    { enabled: true, feedPollSeconds: 60 },
  );
});

test('command registry reserves RSVP, attendance, LFG, and feed commands', () => {
  assert.deepEqual(
    announcementCommandData().map((command) => command.name),
    ['rsvp', 'attendance', 'lfg', 'lfg-close', 'feed-add', 'feed-remove', 'feed-list'],
  );
});

test('RSVP updates one durable attendance row and audits every response', async () => {
  const service = new AnnouncementsService(store, new FakeDiscord());
  await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: USER, status: 'going', now: new Date('2026-09-10T10:00:00Z') });
  await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: USER, status: 'interested', now: new Date('2026-09-10T10:01:00Z') });
  const attendance = await service.attendance(GUILD, EVENT);
  assert.deepEqual(attendance, { going: [], interested: [USER], declined: [] });
  const count = await dbFixture.db.prepare(
    `SELECT COUNT(*) AS total FROM announcements_audit_log WHERE action = 'event.rsvp'`,
  ).get<{ total: number }>();
  assert.equal(Number(count?.total), 2);
});

test('RSVP refuses missing and cancelled scheduled events before writing', async () => {
  const discord = new FakeDiscord();
  const cancelled = '1546451670500642998';
  discord.scheduledEventStatuses.set(cancelled, 4);
  const service = new AnnouncementsService(store, discord);

  await assert.rejects(
    service.rsvp({ guildId: GUILD, eventId: '1546451670500642997', userId: USER, status: 'going' }),
    /No scheduled event with that id exists/,
  );
  await assert.rejects(
    service.rsvp({ guildId: GUILD, eventId: cancelled, userId: USER, status: 'going' }),
    /scheduled event is cancelled/,
  );

  const rows = await dbFixture.db.prepare(`SELECT COUNT(*) AS total FROM event_rsvps`).get<{ total: number }>();
  const audits = await dbFixture.db.prepare(
    `SELECT COUNT(*) AS total FROM announcements_audit_log WHERE action = 'event.rsvp'`,
  ).get<{ total: number }>();
  assert.equal(Number(rows?.total), 0);
  assert.equal(Number(audits?.total), 0);
});

test('RSVP accepts an existing completed event when it is not cancelled', async () => {
  const discord = new FakeDiscord();
  discord.scheduledEventStatuses.set(EVENT, 3);
  const service = new AnnouncementsService(store, discord);

  assert.equal(await service.rsvp({ guildId: GUILD, eventId: EVENT, userId: USER, status: 'going' }), 'going');
  assert.equal((await store.getRsvp(GUILD, EVENT, USER))?.status, 'going');
});

test('scheduled event lookup distinguishes Discord 404 from a cancelled event', async () => {
  const requests: string[] = [];
  const discord = new DiscordAnnouncements({
    token: 'test-token',
    base: 'https://discord.invalid',
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/1546451670500642997')) return new Response(null, { status: 404 });
      return Response.json({ status: 4 });
    },
  });

  assert.equal(await discord.getScheduledEventStatus(GUILD, '1546451670500642997'), null);
  assert.equal(await discord.getScheduledEventStatus(GUILD, EVENT), 4);
  assert.deepEqual(requests, [
    `https://discord.invalid/guilds/${GUILD}/scheduled-events/1546451670500642997`,
    `https://discord.invalid/guilds/${GUILD}/scheduled-events/${EVENT}`,
  ]);
});

test('LFG role slots reject overflow and let a member move atomically', async () => {
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const post = await service.createLfg({
    id: 'lfg-proof', guildId: GUILD, channelId: CHANNEL, title: 'Friday raid',
    startsAt: '2026-09-11T20:00:00Z', roles: parseRoleSpec('tank:Tank:1,dps:DPS:1'),
    actorId: USER, now: new Date('2026-09-10T10:00:00Z'),
  });
  assert.match(post.messageId ?? '', /^\d{17,}$/);
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'tank', userId: USER }), 'joined');
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'tank', userId: '1546451670500642777' }), 'full');
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'dps', userId: USER }), 'moved');
  assert.deepEqual((await store.listLfgSignups(post.id)).map((row) => [row.userId, row.roleKey]), [[USER, 'dps']]);
  assert.ok(discord.edits.at(-1)?.content.includes('DPS** 1/1'));
});

test('closing an LFG disables future signups and clears components', async () => {
  const discord = new FakeDiscord();
  const service = new AnnouncementsService(store, discord);
  const post = await service.createLfg({
    id: 'lfg-close-proof', guildId: GUILD, channelId: CHANNEL, title: 'Closed raid',
    startsAt: '2026-09-11T20:00:00Z', roles: [{ key: 'any', label: 'Any', slots: 2 }],
    actorId: USER, now: new Date('2026-09-10T10:00:00Z'),
  });
  assert.equal(await service.closeLfg(GUILD, post.id, USER), true);
  assert.equal(await service.signupLfg({ guildId: GUILD, id: post.id, roleKey: 'any', userId: USER }), 'closed');
  assert.deepEqual(discord.edits.at(-1)?.components, []);
});

test('ambiguous LFG post recovers the accepted message by stable nonce', async () => {
  const discord = new FakeDiscord();
  const original = discord.postMessage.bind(discord);
  discord.postMessage = async (...args) => {
    await original(...args);
    throw new Error('connection reset after accept');
  };
  const service = new AnnouncementsService(store, discord);
  const post = await service.createLfg({
    id: 'lfg-recover-proof', guildId: GUILD, channelId: CHANNEL, title: 'Recovered raid',
    startsAt: '2026-09-11T20:00:00Z', roles: [{ key: 'any', label: 'Any', slots: 2 }],
    actorId: USER, now: new Date('2026-09-10T10:00:00Z'),
  });
  assert.equal(post.messageId, '1600000000000000001');
  assert.match(discord.posts[0]?.nonce ?? '', /^[a-f0-9]{24}$/);
  assert.equal((await store.getLfg(GUILD, post.id))?.messageId, post.messageId);
});

test('failed LFG post without reconciliation removes its fenced durable state', async () => {
  const discord = new FakeDiscord();
  discord.postMessage = async () => { throw new Error('connection failed before accept'); };
  const service = new AnnouncementsService(store, discord);
  await assert.rejects(service.createLfg({
    id: 'lfg-fail-proof', guildId: GUILD, channelId: CHANNEL, title: 'Failed raid',
    startsAt: '2026-09-11T20:00:00Z', roles: [{ key: 'any', label: 'Any', slots: 2 }],
    actorId: USER, now: new Date('2026-09-10T10:00:00Z'),
  }), /connection failed/);
  assert.equal(await store.getLfg(GUILD, 'lfg-fail-proof'), null);
});

test('feed relay deduplicates stable item keys and reuses the same Discord nonce', async () => {
  const discord = new FakeDiscord();
  const items: FeedItem[] = [{ key: 'video-1', title: 'Launch', url: 'https://example.com/watch/1' }];
  const reader = { read: async (_feed: FeedRelayRow) => items };
  const service = new AnnouncementsService(store, discord, reader);
  await service.addFeed({
    id: 'feed-proof', guildId: GUILD, channelId: CHANNEL, kind: 'rss', source: 'https://example.com/feed.xml', actorId: USER,
  });
  assert.equal(await service.pollFeeds(GUILD), 1);
  assert.equal(await service.pollFeeds(GUILD), 0);
  assert.equal(discord.posts.length, 1);
  assert.match(discord.posts[0]?.nonce ?? '', /^[a-f0-9]{24}$/);
  const delivery = await dbFixture.db.prepare(`SELECT state, message_id FROM feed_deliveries WHERE feed_id = ?`).get<{ state: string; message_id: string }>('feed-proof');
  assert.equal(delivery?.state, 'delivered');
  assert.equal(delivery?.message_id, '1600000000000000001');
});

test('feed delivery releases a failed pre-response claim for retry', async () => {
  let attempt = 0;
  const discord = new FakeDiscord();
  const original = discord.postMessage.bind(discord);
  discord.postMessage = async (...args) => {
    attempt++;
    if (attempt === 1) throw new Error('connection failed');
    return original(...args);
  };
  const reader = { read: async (_feed: FeedRelayRow) => [{ key: 'retry-1', title: 'Retry', url: 'https://example.com/retry' }] };
  const service = new AnnouncementsService(store, discord, reader);
  await service.addFeed({
    id: 'feed-retry', guildId: GUILD, channelId: CHANNEL, kind: 'rss', source: 'https://example.com/retry.xml', actorId: USER,
  });
  assert.equal(await service.pollFeeds(GUILD), 0);
  assert.equal(await service.pollFeeds(GUILD), 1);
  assert.equal(discord.posts.length, 1);
});

test('feed delivery claim has one owner and rejects stale completion or release', async () => {
  await store.putFeed({
    id: 'feed-claim', guildId: GUILD, channelId: CHANNEL, kind: 'rss', source: 'https://example.com/feed.xml',
    enabled: true, lastCheckedAt: null, createdBy: USER, createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T10:00:00.000Z',
  });
  const first = await store.claimDelivery({
    feedId: 'feed-claim', itemKey: 'item', nonce: 'nonce', state: 'pending', messageId: null,
    firstSeenAt: '2026-09-10T10:00:00.000Z', deliveredAt: null, claimToken: 'owner-a', claimedAt: '2026-09-10T10:00:00.000Z',
  });
  const second = await store.claimDelivery({
    feedId: 'feed-claim', itemKey: 'item', nonce: 'nonce', state: 'pending', messageId: null,
    firstSeenAt: '2026-09-10T10:00:00.000Z', deliveredAt: null, claimToken: 'owner-b', claimedAt: '2026-09-10T10:00:00.000Z',
  });
  assert.equal(first?.claimToken, 'owner-a');
  assert.equal(second, null);
  await store.releaseDelivery('feed-claim', 'item', 'owner-b');
  assert.equal(await store.markDelivered('feed-claim', 'item', 'owner-b', 'wrong', '2026-09-10T10:01:00.000Z'), false);
  assert.equal(await store.markDelivered('feed-claim', 'item', 'owner-a', 'right', '2026-09-10T10:01:00.000Z'), true);
});

test('feed parser accepts RSS and Atom entries without executing markup', () => {
  const rss = parseXmlFeed(`<?xml version="1.0"?><rss><channel><item><guid>a&amp;b</guid><title><![CDATA[News <one>]]></title><link>https://example.com/a</link></item></channel></rss>`);
  const atom = parseXmlFeed(`<feed><entry><id>yt:1</id><title>Video</title><link rel="alternate" href="https://youtube.example/1" /></entry></feed>`);
  const multi = parseXmlFeed(`<feed><entry><id>tag:1</id><title>Multi</title><link rel="alternate" href="https://example.com/alt" /><link rel="self" href="https://example.com/self" /></entry></feed>`);
  assert.deepEqual(rss, [{ key: 'a&b', title: 'News <one>', url: 'https://example.com/a' }]);
  assert.deepEqual(atom, [{ key: 'yt:1', title: 'Video', url: 'https://youtube.example/1' }]);
  assert.deepEqual(multi, [{ key: 'tag:1', title: 'Multi', url: 'https://example.com/alt' }]);
});

test('feed parser rejects excessive entries without pathological regex scanning', () => {
  const malformed = `${'<item>'.repeat(201)}${'x'.repeat(240_000)}`;
  const started = performance.now();
  assert.throws(() => parseXmlFeed(malformed), /too many items/);
  assert.ok(performance.now() - started < 500);
});

test('feed reader stops streamed bodies above the byte ceiling', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_500_000));
      controller.enqueue(new Uint8Array(600_000));
      controller.close();
    },
  });
  await assert.rejects(readLimitedText(new Response(stream, { headers: { 'content-type': 'application/xml' } })), /larger than 2 MB/);
  const reader = new XmlFeedReader({
    read: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      body: '<rss><channel><item><guid>x</guid><title>X</title><link>https://example.com/x</link></item></channel></rss>',
    }),
  });
  assert.equal((await reader.read({ source: 'https://example.com/feed.xml' } as FeedRelayRow))[0]?.key, 'x');
});

test('feed destinations reject private, link-local, metadata, and ULA addresses', async () => {
  for (const address of [
    '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::a00:1',
    '100:0:0:1::', '2002:0a00:0001::', '3fff::1', '5f00::1', 'fd00::1', 'fe80::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    '93.184.216.34', '100:0:0:2::', '3fef:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '4000::',
    '5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '6000::', '2606:2800:220:1:248:1893:25c8:1946',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  const privateLookup = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if ((options as { all?: boolean }).all) callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    else callback(null, '10.0.0.1', 4);
  }) as typeof import('node:dns').lookup;
  await assert.rejects(assertPublicHostname('metadata.internal', privateLookup), /public IP/);
});

test('feed connection lookup returns the all-address callback shape requested by Undici', async () => {
  const lookup = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    assert.equal((options as { all?: boolean }).all, true);
    callback(null, [{ address: '93.184.216.34', family: 4 }]);
  }) as typeof import('node:dns').lookup;
  const guardedLookup = createPublicLookup(lookup);
  const addresses = await new Promise<unknown[]>((resolve, reject) => {
    guardedLookup('example.com', { all: true }, (error, found) => {
      if (error) reject(error);
      else resolve(found as unknown[]);
    });
  });
  assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
});

test('feed connection lookup rechecks every resolved address', async () => {
  const lookup = ((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
  }) as typeof import('node:dns').lookup;
  const guardedLookup = createPublicLookup(lookup);
  await assert.rejects(new Promise((resolve, reject) => {
    guardedLookup('example.com', { all: true }, error => error ? reject(error) : resolve(undefined));
  }), /non-public IP/);
});

test('feed sources require HTTPS and normalize YouTube channel ids', () => {
  assert.equal(
    normalizeFeedSource('youtube', 'UC1234567890123456789012'),
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012',
  );
  assert.throws(() => normalizeFeedSource('rss', 'http://example.com/feed'), /HTTPS/);
  assert.throws(() => normalizeFeedSource('rss', 'https://localhost/feed'), /loopback/);
});
