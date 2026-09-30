import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, type StringSelectMenuInteraction } from 'discord.js';
import { handleGameSelect } from '../src/discord/onboarding.ts';
import { OnboardingRecorder } from '../src/onboarding/flow.ts';
import { GAME_PICKS, pickByKey } from '../src/onboarding/catalog.ts';
import type { EventStore } from '../src/store/eventStore.ts';
import type { FunnelEvent } from '../src/core/events.ts';

const GUILD = 'guild';
const MEMBER = 'member';

function fixture(keys: string[], visible: (channelId: string, granted: boolean) => boolean) {
  const events: FunnelEvent[] = [];
  let timingQueries = 0;
  const store = {
    async record(event: FunnelEvent) { events.push(event); return true; },
    async secondsBetween() { timingQueries++; return null; },
  } as unknown as EventStore;
  const recorder = new OnboardingRecorder(store);
  const roles = new Map<string, unknown>();
  let granted = false;
  const channelIds = new Set(GAME_PICKS.flatMap((p) => [p.primaryChannelId, p.fallbackChannelId]).filter(Boolean));
  const checks: string[] = [];
  const channels = new Map([...channelIds].map((id) => [id, {
    permissionsFor(subject: unknown) {
      assert.equal(subject, member, 'visibility must use the selecting member');
      checks.push(id!);
      return new PermissionsBitField(visible(id!, granted) ? PermissionsBitField.Flags.ViewChannel : 0n);
    },
  }]));
  const guild = { id: GUILD, channels: { cache: channels } };
  const member = {
    id: MEMBER, guild,
    roles: {
      cache: roles,
      async add(ids: string[]) {
        for (const id of ids) roles.set(id, {});
        granted = true;
      },
      async remove(ids: string[]) { for (const id of ids) roles.delete(id); },
    },
  };
  const replies: { content: string }[] = [];
  const interaction = {
    guild, member, values: keys,
    async deferReply() {},
    async editReply(reply: { content: string }) { replies.push(reply); },
  } as unknown as StringSelectMenuInteraction;
  return { interaction, recorder, events, replies, roles, checks, channels, timingQueries: () => timingQueries };
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

test('role grant visibility is rechecked before choosing a destination', async () => {
  const shooters = pickByKey('shooters')!;
  const f = fixture(['shooters'], (id, granted) => granted && id === shooters.primaryChannelId);
  await handleGameSelect(f.interaction, { recorder: f.recorder, landingChannelIds: () => [] });
  assert.ok(f.replies[0].content.includes(`/${shooters.primaryChannelId}`));
  assert.deepEqual(f.events.find((e) => e.eventType === 'channel_routed')?.metadata, {
    channels: [shooters.primaryChannelId], degraded: 0,
  });
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
