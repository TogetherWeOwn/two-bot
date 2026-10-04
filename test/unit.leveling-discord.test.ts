import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, MessageFlags, type Client, type Interaction, type InteractionReplyOptions } from 'discord.js';
import { registerLeveling, type LevelingDiscordDeps } from '../src/leveling/discord.ts';
import { type LevelingService, type LevelProfile } from '../src/leveling/service.ts';

const GUILD = 'configured-guild';
const OTHER_GUILD = 'other-guild';
const MEMBER = 'member';
const COMMANDS = ['rank', 'leaderboard'] as const;

function fixture(config: Pick<LevelingDiscordDeps, 'guildId'>, profileOverrides: Partial<LevelProfile> = {}) {
  const reads: Array<{ method: string; guildId: string; memberId?: string; limit?: number }> = [];
  const replies: InteractionReplyOptions[] = [];
  const profile: LevelProfile = {
    guildId: GUILD,
    memberId: MEMBER,
    xp: 100,
    level: 1,
    messageXp: 100,
    voiceXp: 0,
    importedXp: 0,
    rank: 1,
    memberCount: 1,
    nextLevelXp: 255,
    ...profileOverrides,
  };
  const service = {
    async profile(guildId: string, memberId: string) {
      reads.push({ method: 'profile', guildId, memberId });
      return { ...profile, guildId, memberId };
    },
    async leaderboard(guildId: string, limit?: number) {
      reads.push({ method: 'leaderboard', guildId, limit });
      return [{ memberId: MEMBER, xp: 100, level: 1, rank: 1 }];
    },
  } satisfies Pick<LevelingService, 'profile' | 'leaderboard'>;
  let handler: ((interaction: Interaction) => Promise<void>) | undefined;
  const client = {
    on(event: string, listener: (interaction: Interaction) => Promise<void>) {
      assert.equal(event, Events.InteractionCreate);
      handler = listener;
    },
  } as unknown as Client;
  registerLeveling(client, { service: service as unknown as LevelingService, ...config });

  return {
    reads,
    replies,
    async dispatch(commandName: string, guildId: string | null, chatInput = true) {
      assert.ok(handler);
      await handler({
        isChatInputCommand: () => chatInput,
        guildId,
        commandName,
        options: { getUser: () => null },
        user: { id: MEMBER, globalName: 'Player One', username: 'player' },
        async reply(reply: InteractionReplyOptions) { replies.push(reply); },
      } as unknown as Interaction);
    },
  };
}

function assertHandled(f: ReturnType<typeof fixture>, command: typeof COMMANDS[number], guildId: string) {
  assert.equal(f.replies.length, 1);
  if (command === 'rank') {
    assert.deepEqual(f.reads, [{ method: 'profile', guildId, memberId: MEMBER }]);
    assert.match(String(f.replies[0].content), /\*\*Player One\*\*/);
    assert.match(String(f.replies[0].content), /Level \*\*1\*\* · Rank \*\*#1\*\*/);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  } else {
    assert.deepEqual(f.reads, [{ method: 'leaderboard', guildId, limit: 10 }]);
    assert.equal(f.replies[0].content, '**TWO XP Leaderboard**\n**1.** <@member> · level **1** · 100 XP');
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
  }
}

for (const command of COMMANDS) {
  test(`${command} from another guild performs no service reads or replies`, async () => {
    const f = fixture({ guildId: GUILD });
    await f.dispatch(command, OTHER_GUILD);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.replies, []);
  });

  test(`${command} from the configured guild retains its normal response`, async () => {
    const f = fixture({ guildId: GUILD });
    await f.dispatch(command, GUILD);
    assertHandled(f, command, GUILD);
  });

  for (const [name, config] of [
    ['omitted', {}],
    ['undefined', { guildId: undefined }],
    ['null', { guildId: null }],
  ] as const) {
    test(`${command} accepts either guild with ${name} guild configuration`, async () => {
      for (const guildId of [GUILD, OTHER_GUILD]) {
        const f = fixture(config);
        await f.dispatch(command, guildId);
        assertHandled(f, command, guildId);
      }
    });
  }
}

for (const memberCount of [0, 1, 3]) {
  test(`rank renders an absent member as unranked with ${memberCount} stored members`, async () => {
    const f = fixture({ guildId: GUILD }, {
      rank: null, memberCount, xp: 0, level: 0, messageXp: 0, nextLevelXp: 100,
    });
    await f.dispatch('rank', GUILD);
    assert.deepEqual(f.reads, [{ method: 'profile', guildId: GUILD, memberId: MEMBER }]);
    assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0].content,
      '**Player One**\nLevel **0** · Rank **Unranked** (no XP recorded)\nXP **0** · 0/100 this level · **100** to level 1');
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  });
}

test('rank renders an existing zero-XP member with a numeric rank', async () => {
  const f = fixture({ guildId: GUILD }, {
    rank: 3, memberCount: 3, xp: 0, level: 0, messageXp: 0, nextLevelXp: 100,
  });
  await f.dispatch('rank', GUILD);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].content,
    '**Player One**\nLevel **0** · Rank **#3** of **3**\nXP **0** · 0/100 this level · **100** to level 1');
});

test('registration still ignores DMs, non-chat-input interactions and unrelated commands', async () => {
  for (const config of [{ guildId: GUILD }, {}]) {
    const f = fixture(config);
    for (const command of COMMANDS) {
      await f.dispatch(command, null);
      await f.dispatch(command, GUILD, false);
    }
    await f.dispatch('unrelated', GUILD);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.replies, []);
  }
});
