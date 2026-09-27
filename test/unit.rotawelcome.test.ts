/**
 * onboardingRota.promptShown hooks on the three welcome variants.
 *
 * Focused: the hooks report the *returned* Message (identity, not a copy) and
 * the variant's action destination, only after a successful send. Failed sends
 * report nothing. Dry-run semantics differ per variant (session still sends;
 * legacy/anchor send nothing). Bots and pending members are excluded. Each
 * prompt sends exactly one message and writes no roles.
 *
 * No Postgres: recorder/store/discord doubles only. Runnable with node --test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { registerOnboarding } from '../src/discord/onboarding.ts';
import { registerSessionWelcome } from '../src/discord/sessionWelcome.ts';
import { sendAnchorWelcome } from '../src/discord/anchorWelcome.ts';
import { INTRO_CHANNEL_ID } from '../src/onboarding/catalog.ts';
import { SESSION_PICKS } from '../src/onboarding/session.ts';

const GUILD = '326474832151838730';
const LANDING = '111111111111111111';
const ANCHOR_CHANNEL = '222222222222222222';
const FIND_PLAYERS = SESSION_PICKS.find((p) => p.key === 'find-players')!.channelId;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface HookCall {
  member: any;
  message: any;
  variant: string;
  actionChannelId: string;
}

function makeHook() {
  const calls: HookCall[] = [];
  return {
    calls,
    async promptShown(input: HookCall): Promise<void> {
      calls.push(input);
    },
  };
}

function makeClient() {
  const emitter = new EventEmitter() as any;
  emitter.channels = { cache: new Map<string, any>() };
  emitter.user = { id: '999999999999999999' };
  return emitter;
}

/** A channel discord.js would let the bot post in. */
function addPostableChannel(
  client: any,
  channelId: string,
  opts: { guildId?: string; sends: { channelId: string; payload: any }[]; failSend?: boolean; messageId?: string } ,
) {
  const guildId = opts.guildId ?? GUILD;
  const returned: any[] = [];
  const channel: any = {
    id: channelId,
    guild: { id: guildId, members: { me: { id: 'bot' } } },
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: any) => {
      opts.sends.push({ channelId, payload });
      if (opts.failSend) throw new Error('send failed');
      const message = {
        id: opts.messageId ?? `msg-${channelId.slice(-4)}`,
        guildId,
        channelId,
        createdTimestamp: Date.parse('2026-09-01T12:05:00.000Z'),
      };
      returned.push(message);
      return message;
    },
    /** Every Message object this double's send() has resolved with, in order. */
    __returned: returned,
  };
  client.channels.cache.set(channelId, channel);
  return channel;
}

let memberSeq = 0;
function makeMember(overrides: Record<string, any> = {}) {
  memberSeq += 1;
  const roleWrites: string[] = [];
  const member: any = {
    id: `40000000000000000${memberSeq}`,
    guild: { id: GUILD },
    user: { bot: false },
    pending: false,
    roles: {
      cache: new Map<string, any>(),
      add: async (...args: any[]) => {
        roleWrites.push(`add:${JSON.stringify(args)}`);
      },
      remove: async (...args: any[]) => {
        roleWrites.push(`remove:${JSON.stringify(args)}`);
      },
    },
    __roleWrites: roleWrites,
  };
  Object.assign(member, overrides);
  if (overrides.guildId) member.guild = { id: overrides.guildId };
  return member;
}

/** Legacy/anchor recorder double: bots and pending members are never promptable. */
function makeGateRecorder() {
  const prompted: any[] = [];
  const routed: any[] = [];
  return {
    prompted,
    routed,
    async shouldPrompt(i: { isBot: boolean; pending: boolean }) {
      if (i.isBot) return { shouldPrompt: false, reason: 'bot' };
      if (i.pending) return { shouldPrompt: false, reason: 'still_pending' };
      return { shouldPrompt: true, reason: 'ok' };
    },
    async promptedFn(guildId: string, memberId: string, channelId: string) {
      prompted.push([guildId, memberId, channelId]);
    },
    async routedFn(guildId: string, memberId: string, plan: any) {
      routed.push([guildId, memberId, plan]);
    },
  };
}

// --- legacy -------------------------------------------------------------------

test('legacy success reports the returned message, legacy variant, intro action channel', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  const channel = addPostableChannel(client, LANDING, { sends });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  registerOnboarding(client, {
    recorder: {
      shouldPrompt: gate.shouldPrompt,
      prompted: gate.promptedFn,
    } as any,
    landingChannelIds: () => [LANDING],
    onboardingRota: hook as any,
  });

  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await waitFor(() => hook.calls.length === 1, 'legacy hook');

  assert.equal(sends.length, 1, 'exactly one welcome message');
  assert.equal(sends[0].channelId, LANDING);
  const sent = sends[0];
  const call = hook.calls[0];
  // Identity, not just shape: the hook must receive the exact Message object
  // the send resolved with, not a copy rebuilt from its fields.
  assert.equal(channel.__returned.length, 1, 'the send resolved exactly one Message');
  assert.equal(call.message, channel.__returned[0], 'hook message is the returned Message object');
  assert.ok(call.message.id, 'hook message carries the delivered message id');
  assert.equal(call.variant, 'legacy');
  assert.equal(call.actionChannelId, INTRO_CHANNEL_ID, 'legacy destination is the intro channel, not the send channel');
  assert.equal(call.member, member, 'hook member is the welcomed member');
  assert.deepEqual(gate.prompted, [[GUILD, member.id, LANDING]], 'recorded only after the send');
  assert.deepEqual(member.__roleWrites, [], 'legacy prompt writes no roles');
  assert.match(String(sent.payload.content), new RegExp(member.id), 'welcome mentions the member');
});

test('legacy failed send reports no hook and records nothing', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, LANDING, { sends, failSend: true });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  registerOnboarding(client, {
    recorder: { shouldPrompt: gate.shouldPrompt, prompted: gate.promptedFn } as any,
    landingChannelIds: () => [LANDING],
    onboardingRota: hook as any,
  });

  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await tick(50);
  assert.equal(sends.length, 1, 'the send was attempted');
  assert.equal(hook.calls.length, 0, 'failed send reports no hook');
  assert.equal(gate.prompted.length, 0, 'failed send records no prompt');
});

test('legacy dry run sends nothing and reports no hook', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, LANDING, { sends });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  registerOnboarding(client, {
    recorder: { shouldPrompt: gate.shouldPrompt, prompted: gate.promptedFn } as any,
    landingChannelIds: () => [LANDING],
    dryRun: true,
    onboardingRota: hook as any,
  });

  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await tick(50);
  assert.equal(sends.length, 0, 'legacy dry run posts nothing');
  assert.equal(hook.calls.length, 0);
  assert.equal(gate.prompted.length, 0);
});

test('legacy excludes bots and pending members', async () => {
  for (const overrides of [{ user: { bot: true } }, { pending: true }]) {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, LANDING, { sends });
    const gate = makeGateRecorder();
    const hook = makeHook();
    // GuildMemberAdd path: pending members are filtered by the listener itself.
    const member = makeMember(overrides);

    registerOnboarding(client, {
      recorder: { shouldPrompt: gate.shouldPrompt, prompted: gate.promptedFn } as any,
      landingChannelIds: () => [LANDING],
      onboardingRota: hook as any,
    });

    client.emit(Events.GuildMemberAdd, member);
    await tick(50);
    assert.equal(sends.length, 0, `bot/pending must not send (${JSON.stringify(overrides)})`);
    assert.equal(hook.calls.length, 0);
    assert.equal(gate.prompted.length, 0);
  }
});

test('legacy works with no hook configured', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, LANDING, { sends });
  const gate = makeGateRecorder();
  const member = makeMember();

  registerOnboarding(client, {
    recorder: { shouldPrompt: gate.shouldPrompt, prompted: gate.promptedFn } as any,
    landingChannelIds: () => [LANDING],
  });

  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await waitFor(() => gate.prompted.length === 1, 'legacy prompted without hook');
  assert.equal(sends.length, 1);
});

// --- session ------------------------------------------------------------------

function makeSessionDeps(
  sends: { channelId: string; payload: any }[],
  hook: ReturnType<typeof makeHook>,
  opts: { failSend?: boolean; dryRun?: boolean } = {},
) {
  const prompted: any[] = [];
  return {
    prompted,
    deps: {
      recorder: {
        async prompted(guildId: string, memberId: string, channelId: string) {
          prompted.push([guildId, memberId, channelId]);
        },
        async routed() {},
      },
      store: { async hasEvent() { return false; } },
      guildId: GUILD,
      landingChannelIds: () => [LANDING],
      goodbyeChannelIds: () => [] as string[],
      picks: SESSION_PICKS,
      dryRun: opts.dryRun,
      onboardingRota: hook as any,
    } as any,
  };
}

test('session success still sends, reports returned message with find-players destination', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  const channel = addPostableChannel(client, LANDING, { sends, messageId: 'msg-session-1' });
  const hook = makeHook();
  const { prompted, deps } = makeSessionDeps(sends, hook);
  const member = makeMember();

  registerSessionWelcome(client, deps);
  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await waitFor(() => hook.calls.length === 1, 'session hook');

  assert.equal(sends.length, 1, 'exactly one welcome message');
  const call = hook.calls[0];
  assert.equal(channel.__returned.length, 1, 'the send resolved exactly one Message');
  assert.equal(call.message, channel.__returned[0], 'hook message is the returned Message object');
  assert.equal(call.message.id, 'msg-session-1', 'hook carries the delivered message id');
  assert.equal(call.variant, 'session');
  assert.equal(call.actionChannelId, FIND_PLAYERS, 'session destination is the find-players room, not the send channel');
  assert.equal(call.member, member);
  assert.deepEqual(prompted, [[GUILD, member.id, LANDING]]);
  assert.deepEqual(member.__roleWrites, [], 'session prompt writes no roles');
});

test('session dry run STILL sends and still reports the hook', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, LANDING, { sends, messageId: 'msg-session-dry' });
  const hook = makeHook();
  const { prompted, deps } = makeSessionDeps(sends, hook, { dryRun: true });
  const member = makeMember();

  registerSessionWelcome(client, deps);
  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await waitFor(() => hook.calls.length === 1, 'session dry-run hook');

  assert.equal(sends.length, 1, 'session dry run still posts the picker');
  assert.equal(hook.calls[0].variant, 'session');
  assert.equal(hook.calls[0].actionChannelId, FIND_PLAYERS);
  assert.equal(hook.calls[0].message.id, 'msg-session-dry');
  assert.equal(prompted.length, 1, 'session dry run still records after the post');
});

test('session failed send reports no hook and records nothing', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, LANDING, { sends, failSend: true });
  const hook = makeHook();
  const { prompted, deps } = makeSessionDeps(sends, hook);
  const member = makeMember();

  registerSessionWelcome(client, deps);
  client.emit(Events.GuildMemberUpdate, { pending: true }, member);
  await tick(50);
  assert.equal(sends.length, 1, 'the send was attempted');
  assert.equal(hook.calls.length, 0);
  assert.equal(prompted.length, 0);
});

test('session excludes bots and pending members with no send and no hook', async () => {
  for (const overrides of [{ user: { bot: true } }, { pending: true }]) {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, LANDING, { sends });
    const hook = makeHook();
    const { prompted, deps } = makeSessionDeps(sends, hook);
    const member = makeMember(overrides);

    registerSessionWelcome(client, deps);
    client.emit(Events.GuildMemberAdd, member);
    await tick(50);
    assert.equal(sends.length, 0, `bot/pending must not send (${JSON.stringify(overrides)})`);
    assert.equal(hook.calls.length, 0);
    assert.equal(prompted.length, 0);
  }
});

// --- anchor -------------------------------------------------------------------

test('anchor success reports the returned message with the anchor room as destination', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  const channel = addPostableChannel(client, ANCHOR_CHANNEL, { sends, messageId: 'msg-anchor-1' });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  const ok = await sendAnchorWelcome(client, member, {
    recorder: {
      shouldPrompt: gate.shouldPrompt,
      prompted: gate.promptedFn,
      routed: gate.routedFn,
    } as any,
    channelId: ANCHOR_CHANNEL,
    onboardingRota: hook as any,
  });

  assert.equal(ok, true);
  assert.equal(sends.length, 1, 'exactly one anchor message');
  assert.equal(sends[0].channelId, ANCHOR_CHANNEL);
  const sentPayload = sends[0].payload;
  assert.ok(!sentPayload.components || sentPayload.components.length === 0, 'anchor message carries nothing appended');
  const call = hook.calls[0];
  assert.equal(hook.calls.length, 1);
  assert.equal(channel.__returned.length, 1, 'the send resolved exactly one Message');
  assert.equal(call.message, channel.__returned[0], 'hook message is the returned Message object');
  assert.equal(call.message.id, 'msg-anchor-1', 'hook carries the delivered message id');
  assert.equal(call.variant, 'anchor');
  assert.equal(call.actionChannelId, ANCHOR_CHANNEL, 'anchor destination is the room posted in');
  assert.equal(call.member, member);
  assert.equal(gate.prompted.length, 1, 'prompted recorded after the send');
  assert.equal(gate.routed.length, 1, 'routed recorded after the send');
  assert.deepEqual(member.__roleWrites, [], 'anchor writes no roles');
});

test('anchor hook stays uncalled while the send is pending, then reports the resolved message', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  const channel = addPostableChannel(client, ANCHOR_CHANNEL, { sends });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  // Withhold the send resolution: the hook must not fire on intent-to-send,
  // only on the Message the send actually resolves with.
  let sendStarted = false;
  let releaseSend!: (message: any) => void;
  channel.send = (payload: any) => {
    sends.push({ channelId: ANCHOR_CHANNEL, payload });
    sendStarted = true;
    return new Promise<any>((resolve) => {
      releaseSend = resolve;
    });
  };

  const pending = sendAnchorWelcome(client, member, {
    recorder: {
      shouldPrompt: gate.shouldPrompt,
      prompted: gate.promptedFn,
      routed: gate.routedFn,
    } as any,
    channelId: ANCHOR_CHANNEL,
    onboardingRota: hook as any,
  });

  await waitFor(() => sendStarted, 'anchor send to start');
  await tick(50);
  assert.equal(sends.length, 1, 'the send was attempted');
  assert.equal(hook.calls.length, 0, 'hook must not fire while the send is still pending');
  assert.equal(gate.prompted.length, 0, 'no funnel writes before the send resolves');
  assert.equal(gate.routed.length, 0, 'no funnel writes before the send resolves');

  const message = {
    id: 'msg-anchor-deferred',
    guildId: GUILD,
    channelId: ANCHOR_CHANNEL,
    createdTimestamp: Date.parse('2026-09-01T12:05:00.000Z'),
  };
  releaseSend(message);
  const ok = await pending;

  assert.equal(ok, true);
  assert.equal(hook.calls.length, 1, 'hook fires once the send resolves');
  assert.equal(hook.calls[0].message, message, 'hook message is the resolved Message object');
  assert.equal(hook.calls[0].variant, 'anchor');
  assert.equal(hook.calls[0].actionChannelId, ANCHOR_CHANNEL);
  assert.equal(gate.prompted.length, 1, 'funnel writes follow the send, not the intent');
  assert.equal(gate.routed.length, 1, 'funnel writes follow the send, not the intent');
});

test('anchor failed send returns false with no hook and no funnel writes', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, ANCHOR_CHANNEL, { sends, failSend: true });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  const ok = await sendAnchorWelcome(client, member, {
    recorder: {
      shouldPrompt: gate.shouldPrompt,
      prompted: gate.promptedFn,
      routed: gate.routedFn,
    } as any,
    channelId: ANCHOR_CHANNEL,
    onboardingRota: hook as any,
  });

  assert.equal(ok, false);
  assert.equal(sends.length, 1, 'the send was attempted');
  assert.equal(hook.calls.length, 0, 'failed send reports no hook');
  assert.equal(gate.prompted.length, 0);
  assert.equal(gate.routed.length, 0);
});

test('anchor dry run posts nothing and reports no hook', async () => {
  const client = makeClient();
  const sends: { channelId: string; payload: any }[] = [];
  addPostableChannel(client, ANCHOR_CHANNEL, { sends });
  const gate = makeGateRecorder();
  const hook = makeHook();
  const member = makeMember();

  const ok = await sendAnchorWelcome(client, member, {
    recorder: {
      shouldPrompt: gate.shouldPrompt,
      prompted: gate.promptedFn,
      routed: gate.routedFn,
    } as any,
    channelId: ANCHOR_CHANNEL,
    dryRun: true,
    onboardingRota: hook as any,
  });

  assert.equal(ok, false);
  assert.equal(sends.length, 0, 'anchor dry run posts nothing');
  assert.equal(hook.calls.length, 0);
  assert.equal(gate.prompted.length, 0);
  assert.equal(gate.routed.length, 0);
});

test('anchor excludes bots and pending members', async () => {
  for (const overrides of [{ user: { bot: true } }, { pending: true }]) {
    const client = makeClient();
    const sends: { channelId: string; payload: any }[] = [];
    addPostableChannel(client, ANCHOR_CHANNEL, { sends });
    const gate = makeGateRecorder();
    const hook = makeHook();
    const member = makeMember(overrides);

    const ok = await sendAnchorWelcome(client, member, {
      recorder: {
        shouldPrompt: gate.shouldPrompt,
        prompted: gate.promptedFn,
        routed: gate.routedFn,
      } as any,
      channelId: ANCHOR_CHANNEL,
      onboardingRota: hook as any,
    });

    assert.equal(ok, false);
    assert.equal(sends.length, 0, `bot/pending must not send (${JSON.stringify(overrides)})`);
    assert.equal(hook.calls.length, 0);
    assert.equal(gate.prompted.length, 0);
    assert.equal(gate.routed.length, 0);
  }
});
