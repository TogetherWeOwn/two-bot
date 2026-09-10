import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { AnnouncementsService, normalizeFeedSource, parseRoleSpec, type FeedItem } from '../src/announcements/service.ts';
import { loadAnnouncementsConfig } from '../src/announcements/config.ts';
import { AnnouncementsStore, type FeedRelayRow } from '../src/announcements/store.ts';
import { announcementCommandData, parseXmlFeed } from '../src/announcements/discord.ts';
import { openTestDb } from './helpers/testDb.ts';

const GUILD = '1545644954272137297';
const CHANNEL = '1546451670500642826';
const EVENT = '1546451670500642999';
const USER = '1546451670500642888';
const dbFixture = await openTestDb(import.meta.filename);
const store = new AnnouncementsStore(dbFixture.db);

class FakeDiscord {
  posts: Array<{ channelId: string; content: string; nonce?: string; components?: unknown[] }> = [];
  edits: Array<{ channelId: string; messageId: string; content: string; components?: unknown[] }> = [];

  async postMessage(channelId: string, content: string, options: { nonce?: string; components?: unknown[] } = {}) {
    this.posts.push({ channelId, content, ...options });
    return String(1600000000000000000n + BigInt(this.posts.length));
  }

  async editMessage(channelId: string, messageId: string, content: string, components?: unknown[]) {
    this.edits.push({ channelId, messageId, content, components });
  }
}

beforeEach(async () => dbFixture.reset());
after(async () => dbFixture.cleanup());

test('feature is default-off and categorically staging-only', () => {
  assert.deepEqual(loadAnnouncementsConfig({}), { enabled: false, feedPollSeconds: 300 });
  assert.throws(
    () => loadAnnouncementsConfig({ TWO_ANNOUNCEMENTS: '1', DISCORD_GUILD_ID: '326474832151838730' }),
    /staging-only/,
  );
  assert.deepEqual(
    loadAnnouncementsConfig({ TWO_ANNOUNCEMENTS: '1', DISCORD_GUILD_ID: GUILD, TWO_FEED_POLL_SECONDS: '60' }),
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

test('feed parser accepts RSS and Atom entries without executing markup', () => {
  const rss = parseXmlFeed(`<?xml version="1.0"?><rss><channel><item><guid>a&amp;b</guid><title><![CDATA[News <one>]]></title><link>https://example.com/a</link></item></channel></rss>`);
  const atom = parseXmlFeed(`<feed><entry><id>yt:1</id><title>Video</title><link rel="alternate" href="https://youtube.example/1" /></entry></feed>`);
  assert.deepEqual(rss, [{ key: 'a&b', title: 'News <one>', url: 'https://example.com/a' }]);
  assert.deepEqual(atom, [{ key: 'yt:1', title: 'Video', url: 'https://youtube.example/1' }]);
});

test('feed sources require HTTPS and normalize YouTube channel ids', () => {
  assert.equal(
    normalizeFeedSource('youtube', 'UC1234567890123456789012'),
    'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012',
  );
  assert.throws(() => normalizeFeedSource('rss', 'http://example.com/feed'), /HTTPS/);
  assert.throws(() => normalizeFeedSource('rss', 'https://localhost/feed'), /loopback/);
});
