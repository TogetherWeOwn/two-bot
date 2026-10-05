import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, type Client, type Interaction, type InteractionDeferReplyOptions, type InteractionEditReplyOptions } from 'discord.js';
import { registerAnnouncementCommands } from '../src/announcements/discord.ts';
import { AnnouncementsService, parseRoleSpec, type AnnouncementDiscord } from '../src/announcements/service.ts';
import type { AnnouncementsStore, LfgPostRow, LfgRoleRow, LfgSignupRow } from '../src/announcements/store.ts';

const GUILD = 'configured-guild';
const CHANNEL = 'lfg-channel';
const USER = 'member';
const NOW = new Date('2026-09-30T10:00:00.000Z');
const FUTURE = '2026-10-01T20:00:00.000Z';
const RESERVED_KEYS = ['__leave__', '__LEAVE__', ' __leave__ ', ' \t__LeAvE__\n'];

for (const key of RESERVED_KEYS) {
  test(`parseRoleSpec rejects reserved role key ${JSON.stringify(key)}`, () => {
    assert.throws(() => parseRoleSpec(`${key}:Tank:1`), /reserved/i);
    assert.throws(() => parseRoleSpec(`tank:Tank:1,${key}:Other:1`), /reserved/i);
  });

  test(`createLfg rejects reserved role key ${JSON.stringify(key)} before any store or transport call`, async () => {
    const calls: string[] = [];
    const poison = (kind: string) => ({
      get(_target: object, method: string | symbol) {
        return () => {
          calls.push(`${kind}.${String(method)}`);
          throw new Error('Unexpected side effect');
        };
      },
    });
    const store = new Proxy<AnnouncementsStore>({} as AnnouncementsStore, poison('store'));
    const discord = new Proxy<AnnouncementDiscord>({} as AnnouncementDiscord, poison('discord'));
    const service = new AnnouncementsService(store, discord);
    await assert.rejects(service.createLfg({
      guildId: GUILD, channelId: CHANNEL, title: 'Raid', startsAt: FUTURE,
      roles: [{ key: 'tank', label: 'Tank', slots: 1 }, { key, label: 'Other', slots: 1 }],
      actorId: USER, now: NOW,
    }), /reserved/i);
    assert.deepEqual(calls, [], 'refusal must happen before all store and transport methods');
  });
}

test('normal role values remain distinct from the working leave action in the registered handler', async () => {
  let post: LfgPostRow | undefined;
  let roles: LfgRoleRow[] = [];
  let signups: LfgSignupRow[] = [];
  const signupCalls: string[] = [];
  const leaveCalls: Array<{ id: string; userId: string }> = [];
  const store = {
    async putLfg(row: LfgPostRow, roleRows: LfgRoleRow[]) {
      post = row;
      roles = roleRows;
    },
    async listLfgRoles() { return roles; },
    async listLfgSignups() { return signups; },
    async getLfg() { return post ?? null; },
    async signupLfg(guildId: string, id: string, roleKey: string, userId: string, joinedAt: string) {
      assert.equal(guildId, GUILD);
      assert.equal(id, post?.id);
      signupCalls.push(roleKey);
      signups = [{ lfgId: id, roleKey, userId, joinedAt }];
      return 'joined' as const;
    },
    async leaveLfg(id: string, userId: string) {
      leaveCalls.push({ id, userId });
      const removed = signups.some((signup) => signup.lfgId === id && signup.userId === userId);
      signups = signups.filter((signup) => signup.lfgId !== id || signup.userId !== userId);
      return removed;
    },
    async audit() {},
  } satisfies Pick<AnnouncementsStore, 'putLfg' | 'listLfgRoles' | 'listLfgSignups' | 'getLfg' | 'signupLfg' | 'leaveLfg' | 'audit'>;
  const posts: Array<{ components?: unknown[] }> = [];
  const edits: string[] = [];
  const discord = {
    async postMessage(_channelId: string, _content: string, options?: { components?: unknown[] }) {
      posts.push(options ?? {});
      return 'message';
    },
    async editMessage(_channelId: string, _messageId: string, content: string) { edits.push(content); },
    async getScheduledEventStatus() { throw new Error('Unexpected event lookup'); },
  } satisfies AnnouncementDiscord;
  const service = new AnnouncementsService(store as unknown as AnnouncementsStore, discord);
  const created = await service.createLfg({
    id: 'raid', guildId: GUILD, channelId: CHANNEL, title: 'Raid', startsAt: FUTURE,
    roles: parseRoleSpec(' Tank :Tank:1,leave:Leave role:1,__leave___:Near sentinel:1'),
    actorId: USER, now: NOW,
  });
  assert.equal(posts.length, 1);
  const components = posts[0]?.components as Array<{
    components: Array<{ custom_id: string; options: Array<{ label: string; value: string }> }>;
  }>;
  const menu = components[0]?.components[0];
  assert.ok(menu);
  assert.deepEqual(menu.options.map((option) => option.value), ['tank', 'leave', '__leave___', '__leave__']);
  assert.equal(new Set(menu.options.map((option) => option.value)).size, 4);
  assert.deepEqual(menu.options.at(-1), { label: 'Leave this group', value: '__leave__' });

  let handler: ((interaction: Interaction) => Promise<void>) | undefined;
  const client = {
    on(event: string, listener: (interaction: Interaction) => Promise<void>) {
      assert.equal(event, Events.InteractionCreate);
      handler = listener;
    },
  } as unknown as Client;
  registerAnnouncementCommands(client, { guildId: GUILD, service, store: store as unknown as AnnouncementsStore });
  const replies: InteractionEditReplyOptions[] = [];
  const deferrals: InteractionDeferReplyOptions[] = [];
  async function select(value: string) {
    assert.ok(handler);
    const interaction = {
      inGuild: () => true,
      guildId: GUILD,
      isStringSelectMenu: () => true,
      isRepliable: () => true,
      customId: menu!.custom_id,
      values: [value],
      user: { id: USER },
      replied: false,
      deferred: false,
      async deferReply(options: InteractionDeferReplyOptions) {
        assert.equal(this.deferred, false);
        assert.equal(this.replied, false);
        deferrals.push(options);
        this.deferred = true;
      },
      async editReply(reply: InteractionEditReplyOptions) {
        assert.equal(this.deferred, true);
        replies.push(reply);
        this.replied = true;
      },
      async reply() { assert.fail('LFG select must complete its deferred reply'); },
    };
    await handler(interaction as unknown as Interaction);
  }
  for (const option of menu.options.slice(0, -1)) {
    await select(option.value);
    assert.equal(signups[0]?.roleKey, option.value);
    assert.equal(leaveCalls.length, 0);
  }
  assert.deepEqual(signupCalls, ['tank', 'leave', '__leave___']);
  await select(menu.options.at(-1)!.value);
  assert.deepEqual(signups, []);
  assert.deepEqual(leaveCalls, [{ id: created.id, userId: USER }]);
  assert.deepEqual(signupCalls, ['tank', 'leave', '__leave___'], 'leave must never dispatch signup');
  assert.equal(edits.length, 4, 'three signup refreshes and one leave refresh');
  assert.deepEqual(deferrals, Array.from({ length: 4 }, () => ({ ephemeral: true })));
  assert.deepEqual(replies, [
    { content: 'LFG joined.' },
    { content: 'LFG joined.' },
    { content: 'LFG joined.' },
    { content: 'LFG left.' },
  ]);
});
