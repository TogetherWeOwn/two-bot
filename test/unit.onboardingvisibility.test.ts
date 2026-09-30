import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionsBitField,
  type ActionRowBuilder,
  type StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { handleGameSelect } from '../src/discord/onboarding.ts';
import { OnboardingRecorder } from '../src/onboarding/flow.ts';
import { GAME_PICKS, pickByKey } from '../src/onboarding/catalog.ts';
import type { EventStore } from '../src/store/eventStore.ts';
import type { FunnelEvent } from '../src/core/events.ts';

const GUILD = 'guild';
const MEMBER = 'member';

interface FakeMember {
  id: string;
  guild: { id: string };
  roles: {
    cache: Map<string, unknown>;
    add(ids: string[]): Promise<FakeMember>;
    remove(ids: string[]): Promise<FakeMember>;
  };
}

type Reply = { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] };

function fixture(
  keys: string[],
  visible: (channelId: string, roles: ReadonlyMap<string, unknown>) => boolean,
  initialRoleIds: string[] = [],
) {
  const events: FunnelEvent[] = [];
  let timingQueries = 0;
  const store = {
    async record(event: FunnelEvent) { events.push(event); return true; },
    async secondsBetween() { timingQueries++; return null; },
  } as unknown as EventStore;
  const recorder = new OnboardingRecorder(store);
  const channelIds = new Set(GAME_PICKS.flatMap((p) => [p.primaryChannelId, p.fallbackChannelId]).filter(Boolean));
  const checks: string[] = [];
  const channels = new Map([...channelIds].map((id) => [id, {
    permissionsFor(subject: FakeMember) {
      assert.equal(subject.id, MEMBER, 'visibility must use the selecting member');
      assert.equal(subject.guild, guild);
      checks.push(id!);
      return new PermissionsBitField(visible(id!, subject.roles.cache) ? PermissionsBitField.Flags.ViewChannel : 0n);
    },
  }]));
  const guild = { id: GUILD, channels: { cache: channels } };
  const roleWrites: string[][] = [];
  // discord.js returns an updated clone; no gateway event refreshes the original.
  function snapshot(roleIds: string[]): FakeMember {
    const roles = new Map(roleIds.map((id) => [id, {}]));
    return {
      id: MEMBER, guild,
      roles: {
        cache: roles,
        async add(ids) {
          const next = [...new Set([...roles.keys(), ...ids])];
          roleWrites.push(next);
          return latestMember = snapshot(next);
        },
        async remove(ids) {
          const next = [...roles.keys()].filter((id) => !ids.includes(id));
          roleWrites.push(next);
          return latestMember = snapshot(next);
        },
      },
    };
  }
  const member = snapshot(initialRoleIds);
  let latestMember = member;
  const replies: Reply[] = [];
  const interaction = {
    guild, member, values: keys,
    async deferReply() {},
    async editReply(reply: Reply) { replies.push(reply); },
  } as unknown as StringSelectMenuInteraction;
  return {
    interaction, recorder, events, replies, member, roleWrites, checks, channels,
    get roles() { return latestMember.roles.cache; },
    timingQueries: () => timingQueries,
  };
}

function selectedKeys(reply: Reply): string[] {
  return reply.components[0].toJSON().components[0].options
    .filter((option) => option.default).map((option) => option.value);
}

test('invisible primary and fallback save roles without links or a successful route', async () => {
  const shooters = pickByKey('shooters')!;
  const f = fixture(['shooters', 'rocketleague'], () => false);
  await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
  assert.ok(f.roles.has(shooters.roleId));
  assert.ok(f.roles.has(pickByKey('rocketleague')!.roleId));
  assert.match(f.replies[0].content, /Game roles saved/);
  assert.match(f.replies[0].content, /No channel is available/);
  assert.doesNotMatch(f.replies[0].content, /discord\.com\/channels|<#|Here is where to go/);
  assert.deepEqual(f.events.map((e) => e.eventType), ['game_roles_selected']);
  assert.deepEqual(f.events[0].metadata, { picks: ['shooters', 'rocketleague'] });
  assert.equal(f.timingQueries(), 0);
  assert.ok(f.checks.includes(shooters.primaryChannelId!));
  assert.ok(f.checks.includes(shooters.fallbackChannelId));
});

test('missing cached channels are unavailable instead of linked', async () => {
  const f = fixture(['shooters'], () => true);
  f.channels.clear();
  await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
  assert.doesNotMatch(f.replies[0].content, /discord\.com\/channels|<#/);
  assert.deepEqual(f.events.map((e) => e.eventType), ['game_roles_selected']);
});

for (const destination of ['primary', 'fallback'] as const) {
  test(`visible ${destination} is linked and recorded with unchanged metadata`, async () => {
    const shooters = pickByKey('shooters')!;
    const channelId = destination === 'primary' ? shooters.primaryChannelId! : shooters.fallbackChannelId;
    const f = fixture(['shooters'], (id) => id === channelId);
    await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
    assert.match(f.replies[0].content, /Done\. Here is where to go:/);
    assert.ok(f.replies[0].content.includes(`https://discord.com/channels/${GUILD}/${channelId}`));
    assert.deepEqual(f.events.find((e) => e.eventType === 'channel_routed')?.metadata, {
      channels: [channelId], degraded: destination === 'primary' ? 0 : 1,
    });
    assert.equal(f.timingQueries(), 1);
  });
}

for (const destination of ['primary', 'fallback'] as const) {
  test(`returned role-grant clone reveals the ${destination} without a gateway update`, async () => {
    const shooters = pickByKey('shooters')!;
    const channelId = destination === 'primary' ? shooters.primaryChannelId! : shooters.fallbackChannelId;
    const f = fixture(['shooters'], (id, roles) => roles.has(shooters.roleId) && id === channelId);
    await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
    assert.equal(f.member.roles.cache.has(shooters.roleId), false, 'original snapshot stays stale');
    assert.ok(f.roles.has(shooters.roleId));
    assert.ok(f.replies[0].content.includes(`/${channelId}`));
    assert.deepEqual(f.events.find((e) => e.eventType === 'channel_routed')?.metadata, {
      channels: [channelId], degraded: destination === 'primary' ? 0 : 1,
    });
    assert.deepEqual(selectedKeys(f.replies[0]), ['shooters']);
  });
}

for (const wasVisible of [true, false]) {
  test(`returned removal clone ${wasVisible ? 'hides' : 'reveals'} the fallback and preserves the grant`, async () => {
    const shooters = pickByKey('shooters')!;
    const horror = pickByKey('horror')!;
    const f = fixture(['shooters'], (id, roles) => id === shooters.fallbackChannelId
      && roles.has(horror.roleId) === wasVisible, [horror.roleId]);
    await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
    assert.deepEqual(f.roleWrites, [[horror.roleId, shooters.roleId], [shooters.roleId]]);
    assert.deepEqual([...f.member.roles.cache.keys()], [horror.roleId], 'no gateway update');
    assert.deepEqual([...f.roles.keys()], [shooters.roleId]);
    assert.deepEqual(selectedKeys(f.replies[0]), ['shooters']);
    if (wasVisible) {
      assert.doesNotMatch(f.replies[0].content, /discord\.com\/channels|<#|Here is where to go/);
      assert.deepEqual(f.events.map((e) => e.eventType), ['game_roles_selected']);
      assert.equal(f.timingQueries(), 0);
    } else {
      assert.ok(f.replies[0].content.includes(`/${shooters.fallbackChannelId}`));
      assert.deepEqual(f.events.find((e) => e.eventType === 'channel_routed')?.metadata, {
        channels: [shooters.fallbackChannelId], degraded: 1,
      });
    }
  });
}

test('an empty selection clears roles through a returned clone without routing', async () => {
  const shooters = pickByKey('shooters')!;
  const f = fixture([], () => true, [shooters.roleId]);
  await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
  assert.deepEqual(f.roleWrites, [[]]);
  assert.equal(f.roles.size, 0);
  assert.deepEqual(selectedKeys(f.replies[0]), []);
  assert.match(f.replies[0].content, /Cleared your game roles/);
  assert.deepEqual(f.events, []);
});

test('mixed visibility links only the reachable destination and reports unavailable picks', async () => {
  const shooters = pickByKey('shooters')!;
  const f = fixture(['shooters', 'rocketleague'], (id) => id === shooters.primaryChannelId);
  await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
  assert.ok(f.replies[0].content.includes(`/${shooters.primaryChannelId}`));
  assert.ok(!f.replies[0].content.includes(shooters.fallbackChannelId));
  assert.match(f.replies[0].content, /No channel is available/);
  assert.deepEqual(f.events.find((e) => e.eventType === 'channel_routed')?.metadata, {
    channels: [shooters.primaryChannelId], degraded: 0, unavailable: ['rocketleague'],
  });
});
