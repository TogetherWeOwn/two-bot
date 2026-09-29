/**
 * Flow-builder coverage for src/e2e/flows.ts (TOG-9141).
 *
 * Each of the five flows is driven to a pass AND to each of its failure
 * steps against an in-memory mock transport. No token is read, no socket is
 * opened, and no id here names a real server: every guild, channel, user and
 * role id is a fake string in this file's scope. The flows never validate
 * guild ids themselves (the session fence does that; it is covered in
 * test/unit.e2eharness.test.ts), so fake ids exercise the builders exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TICKET_CLAIM_ID, TICKET_CLOSE_ID, TICKET_OPEN_ID } from '../src/discord/tickets.ts';
import { HarnessGuard, HarnessHalt, type Acted, type HarnessClock } from '../src/e2e/guard.ts';
import {
  FLOWS,
  FlowAssertionFailed,
  flowByKey,
  missingTargets,
  type FlowContext,
  type FlowTargets,
} from '../src/e2e/flows.ts';
import type { GatewayEvent, HarnessTransport } from '../src/e2e/transport.ts';

/** MessageFlags.Ephemeral, as a literal: the flows assert the bit, not the import. */
const EPHEMERAL = 64;

function instantClock(): HarnessClock {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

/** Real budgets, no wall-clock cost. Pacing is covered elsewhere. */
function fastGuard(): HarnessGuard {
  return new HarnessGuard({ clock: instantClock(), random: () => 0 });
}

/**
 * Records every call and answers gateway waits from scripted buffers,
 * applying the predicate like a real client: a mock that returned whatever
 * it was handed could not fail a flow on a wrong userId, which is one of
 * the things these flows exist to check. A miss is a 504 timeout, which
 * fails the flow without halting, per the transport contract.
 */
class MockTransport implements HarnessTransport {
  readonly calls: string[] = [];
  readonly buttonCalls: { channelId: string; messageId: string; customId: string }[] = [];
  readonly reactionCalls: { channelId: string; messageId: string; emoji: string }[] = [];
  readonly voiceJoins: string[] = [];
  accepts = 0;
  leaves = 0;
  statuses: Record<string, number> = {};
  events: Record<string, GatewayEvent[]> = {};
  private counts: Record<string, number> = {};

  private answer<T>(verb: string, value: T): Promise<Acted<T>> {
    this.calls.push(verb);
    const n = (this.counts[verb] = (this.counts[verb] ?? 0) + 1);
    const status = this.statuses[`${verb}:${n}`] ?? this.statuses[verb] ?? 200;
    return Promise.resolve({ status, value });
  }

  acceptRules(): Promise<Acted<void>> {
    this.accepts++;
    return this.answer('acceptRules', undefined);
  }
  sendMessage(): Promise<Acted<{ id: string }>> {
    return this.answer('sendMessage', { id: 'msg-1' });
  }
  addReaction(channelId: string, messageId: string, emoji: string): Promise<Acted<void>> {
    this.reactionCalls.push({ channelId, messageId, emoji });
    return this.answer('addReaction', undefined);
  }
  clickButton(channelId: string, messageId: string, customId: string): Promise<Acted<void>> {
    this.buttonCalls.push({ channelId, messageId, customId });
    return this.answer(`clickButton:${customId}`, undefined);
  }
  joinVoice(channelId: string): Promise<Acted<void>> {
    this.voiceJoins.push(channelId);
    return this.answer('joinVoice', undefined);
  }
  leaveVoice(): Promise<Acted<void>> {
    this.leaves++;
    return this.answer('leaveVoice', undefined);
  }
  awaitEvent(
    name: string,
    pred: (e: GatewayEvent) => boolean,
  ): Promise<Acted<GatewayEvent | null>> {
    this.calls.push(`awaitEvent:${name}`);
    const buffer = this.events[name] ?? [];
    const index = buffer.findIndex(pred);
    const event = index < 0 ? null : buffer.splice(index, 1)[0]!;
    return Promise.resolve({ status: event ? 200 : 504, value: event });
  }
}

const TARGETS: FlowTargets = {
  guildId: 'guild-1',
  accountId: 'account-1',
  welcomeChannelId: 'welcome-1',
  selfRolePanelChannelId: 'panel-1',
  selfRolePanelMessageId: 'panel-msg-1',
  selfRoleEmoji: 'bell-emoji',
  selfRoleId: 'role-1',
  ticketPanelChannelId: 'tickets-1',
  ticketPanelMessageId: 'tickets-msg-1',
  ticketBotId: 'ticket-bot-1',
  voiceLobbyChannelId: 'lobby-1',
};

function ctx(t: MockTransport, targets: FlowTargets = TARGETS, handoffs: string[] | null = null): FlowContext {
  const base = { guard: fastGuard(), transport: t, targets, timeoutMs: 10 };
  return handoffs === null
    ? base
    : { ...base, noteCleanupHandoff: (h: string) => { handoffs.push(h); } };
}

async function rejectsWithStep(run: Promise<unknown>, step: string): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof FlowAssertionFailed, `expected FlowAssertionFailed, got ${String(err)}`);
    assert.equal(err.step, step);
    return true;
  });
}

function ticketControls(data: Record<string, unknown> = {}): GatewayEvent {
  return {
    name: 'messageCreate',
    data: {
      id: 'controls-42',
      channelId: 'ticket-42',
      authorId: TARGETS.ticketBotId,
      content: `<@${TARGETS.accountId}> Thanks — staff will be with you shortly.`,
      componentCustomIds: [TICKET_CLAIM_ID, TICKET_CLOSE_ID],
      ...data,
    },
  };
}

function claimAck(data: Record<string, unknown> = {}): GatewayEvent {
  return {
    name: 'messageCreate',
    data: {
      id: 'claim-reply-42',
      channelId: 'ticket-42',
      authorId: TARGETS.ticketBotId,
      content: `Claimed by <@${TARGETS.accountId}>.`,
      flags: EPHEMERAL,
      ...data,
    },
  };
}

function staffRefusal(content: string, data: Record<string, unknown> = {}): GatewayEvent {
  return {
    name: 'messageCreate',
    data: {
      id: `refusal-${content.length}`,
      channelId: 'ticket-42',
      authorId: TARGETS.ticketBotId,
      content,
      flags: EPHEMERAL,
      ...data,
    },
  };
}

function ticketSuccessTransport(): MockTransport {
  const t = new MockTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'ticket-42' } }];
  t.events.messageCreate = [ticketControls(), claimAck()];
  t.events.channelDelete = [{ name: 'channelDelete', data: { id: 'ticket-42' } }];
  return t;
}

function denialSuccessTransport(): MockTransport {
  const t = new MockTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'ticket-42' } }];
  t.events.messageCreate = [
    ticketControls(),
    staffRefusal('Only staff can claim tickets.'),
    staffRefusal('Only staff can close tickets.'),
  ];
  return t;
}

// --- registry and helpers ----------------------------------------------------

test('FLOWS holds exactly the five member journeys, each retrievable by key', () => {
  assert.deepEqual(FLOWS.map((f) => f.key), [
    'join-screen',
    'reaction',
    'ticket-buttons',
    'ticket-open-denial',
    'voice-verify',
  ]);
  for (const flow of FLOWS) {
    assert.equal(flowByKey(flow.key), flow);
    assert.ok(flow.title.length > 0);
    assert.ok(flow.unblocks.length > 0);
    assert.ok(flow.requires.length > 0);
  }
  assert.equal(flowByKey('no-such-flow'), null);
  assert.deepEqual(
    [...new Set(FLOWS.map((f) => f.unblocks))].sort(),
    ['TOG-2796', 'TOG-3085', 'TOG-3122', 'TOG-3690'],
  );
});

test('the full ticket sequence is live-ineligible; the denial carries the residual', () => {
  assert.match(flowByKey('ticket-buttons')!.liveIneligibleReason!, /ordinary member/);
  assert.match(flowByKey('ticket-open-denial')!.coverageResidual!, /successful staff claim\/close stays residual/);
  assert.equal(flowByKey('ticket-open-denial')!.liveIneligibleReason, undefined);
  for (const key of ['join-screen', 'reaction', 'voice-verify']) {
    assert.equal(flowByKey(key)!.liveIneligibleReason, undefined);
    assert.equal(flowByKey(key)!.coverageResidual, undefined);
  }
});

test('FlowAssertionFailed carries its step for the runner transcript', () => {
  const err = new FlowAssertionFailed('role-granted', 'no guildMemberUpdate matched within 10ms');
  assert.equal(err.name, 'FlowAssertionFailed');
  assert.equal(err.step, 'role-granted');
  assert.match(err.message, /role-granted/);
});

test('missingTargets reports exactly the required keys that are absent', () => {
  assert.deepEqual(missingTargets(flowByKey('join-screen')!, TARGETS), []);
  assert.deepEqual(missingTargets(flowByKey('reaction')!, TARGETS), []);
  const partial: Partial<FlowTargets> = { ...TARGETS, selfRoleId: '', voiceLobbyChannelId: '' };
  assert.deepEqual(missingTargets(flowByKey('reaction')!, partial), ['selfRoleId']);
  assert.deepEqual(missingTargets(flowByKey('voice-verify')!, partial), ['voiceLobbyChannelId']);
  assert.deepEqual(
    missingTargets(flowByKey('ticket-buttons')!, {}),
    ['guildId', 'accountId', 'ticketPanelChannelId', 'ticketPanelMessageId', 'ticketBotId'],
  );
});

// --- join-screen -------------------------------------------------------------

test('join-screen accepts the rules, then waits for the gate and the welcome', async () => {
  const t = new MockTransport();
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: TARGETS.accountId, pending: false } },
  ];
  // A welcome anywhere else is not the proof; the right channel still passes.
  t.events.messageCreate = [
    { name: 'messageCreate', data: { channelId: 'somewhere-else' } },
    { name: 'messageCreate', data: { channelId: TARGETS.welcomeChannelId } },
  ];

  await flowByKey('join-screen')!.run(ctx(t));

  assert.equal(t.accepts, 1);
  assert.deepEqual(t.calls, ['acceptRules', 'awaitEvent:guildMemberUpdate', 'awaitEvent:messageCreate']);
});

test('join-screen fails when the gate never opens, after accepting the rules', async () => {
  const t = new MockTransport();
  t.events.messageCreate = [{ name: 'messageCreate', data: { channelId: TARGETS.welcomeChannelId } }];
  await rejectsWithStep(flowByKey('join-screen')!.run(ctx(t)), 'gate-opened');
  assert.equal(t.accepts, 1, 'the rules were accepted before the bot failed to respond');
});

test("join-screen ignores another member's gate opening", async () => {
  const t = new MockTransport();
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: 'somebody-else', pending: false } },
  ];
  await rejectsWithStep(flowByKey('join-screen')!.run(ctx(t)), 'gate-opened');
});

test('join-screen fails when the welcome never lands in the welcome channel', async () => {
  const t = new MockTransport();
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: TARGETS.accountId, pending: false } },
  ];
  t.events.messageCreate = [{ name: 'messageCreate', data: { channelId: 'somewhere-else' } }];
  await rejectsWithStep(flowByKey('join-screen')!.run(ctx(t)), 'welcome-posted');
});

// --- reaction ----------------------------------------------------------------

test('reaction presses the panel emoji and passes when our role lands', async () => {
  const t = new MockTransport();
  t.events.guildMemberUpdate = [
    {
      name: 'guildMemberUpdate',
      data: { userId: TARGETS.accountId, roles: ['other-role', TARGETS.selfRoleId] },
    },
  ];

  await flowByKey('reaction')!.run(ctx(t));

  assert.deepEqual(t.reactionCalls, [{
    channelId: TARGETS.selfRolePanelChannelId,
    messageId: TARGETS.selfRolePanelMessageId,
    emoji: TARGETS.selfRoleEmoji,
  }]);
  assert.deepEqual(t.calls, ['addReaction', 'awaitEvent:guildMemberUpdate']);
});

const notOurRole: [string, Record<string, unknown>][] = [
  ['another member', { userId: 'somebody-else', roles: [TARGETS.selfRoleId] }],
  ['roles without the role', { userId: TARGETS.accountId, roles: ['other-role'] }],
  ['roles not an array', { userId: TARGETS.accountId, roles: TARGETS.selfRoleId }],
  ['roles absent', { userId: TARGETS.accountId }],
];
for (const [name, data] of notOurRole) {
  test(`reaction rejects ${name}`, async () => {
    const t = new MockTransport();
    t.events.guildMemberUpdate = [{ name: 'guildMemberUpdate', data }];
    await rejectsWithStep(flowByKey('reaction')!.run(ctx(t)), 'role-granted');
  });
}

test('a 403 on the reaction halts rather than failing the flow', async () => {
  const t = new MockTransport();
  t.statuses.addReaction = 403;
  await assert.rejects(flowByKey('reaction')!.run(ctx(t)), (err: unknown) => {
    assert.ok(err instanceof HarnessHalt);
    assert.equal(err.reason, 'forbidden');
    return true;
  });
});

// --- ticket-buttons ----------------------------------------------------------

test('ticket-buttons opens on the panel, then claims and closes on the new channel', async () => {
  const t = ticketSuccessTransport();

  await flowByKey('ticket-buttons')!.run(ctx(t));

  assert.deepEqual(t.calls, [
    'clickButton:two:tickets:open',
    'awaitEvent:channelCreate',
    'awaitEvent:messageCreate',
    'clickButton:two:tickets:claim',
    'awaitEvent:messageCreate',
    'clickButton:two:tickets:close',
    'awaitEvent:channelDelete',
  ]);
  assert.deepEqual(t.buttonCalls, [
    {
      channelId: TARGETS.ticketPanelChannelId,
      messageId: TARGETS.ticketPanelMessageId,
      customId: TICKET_OPEN_ID,
    },
    { channelId: 'ticket-42', messageId: 'controls-42', customId: TICKET_CLAIM_ID },
    { channelId: 'ticket-42', messageId: 'controls-42', customId: TICKET_CLOSE_ID },
  ]);
});

test('ticket-buttons fails when no channel is created, pressing only open', async () => {
  const t = ticketSuccessTransport();
  t.events.channelCreate = [];
  await rejectsWithStep(flowByKey('ticket-buttons')!.run(ctx(t)), 'ticket-channel-created');
  assert.equal(t.buttonCalls.length, 1);
});

test('ticket-buttons fails when the controls greeting never arrives, pressing only open', async () => {
  const t = ticketSuccessTransport();
  t.events.messageCreate = [];
  await rejectsWithStep(flowByKey('ticket-buttons')!.run(ctx(t)), 'ticket-controls-posted');
  assert.deepEqual(t.buttonCalls.map((b) => b.customId), [TICKET_OPEN_ID]);
});

test('ticket-buttons fails when the claim ack is not ephemeral, never pressing close', async () => {
  const t = ticketSuccessTransport();
  t.events.messageCreate = [ticketControls(), claimAck({ flags: 0 })];
  await rejectsWithStep(flowByKey('ticket-buttons')!.run(ctx(t)), 'claim-acknowledged');
  assert.ok(!t.calls.includes(`clickButton:${TICKET_CLOSE_ID}`));
});

test('ticket-buttons fails when the channel never closes', async () => {
  const t = ticketSuccessTransport();
  t.events.channelDelete = [];
  await rejectsWithStep(flowByKey('ticket-buttons')!.run(ctx(t)), 'ticket-closed');
});

// --- ticket-open-denial ------------------------------------------------------

test('denial hands the open ticket to staff up front and ends with it still open', async () => {
  const t = denialSuccessTransport();
  const handoffs: string[] = [];

  await flowByKey('ticket-open-denial')!.run(ctx(t, TARGETS, handoffs));

  assert.equal(handoffs.length, 2);
  assert.match(handoffs[0]!, /not yet observed/);
  assert.match(handoffs[0]!, new RegExp(TARGETS.accountId));
  assert.match(handoffs[1]!, /ticket-42.*authorized staff/);
  assert.deepEqual(t.buttonCalls.map((b) => b.customId), [TICKET_OPEN_ID, TICKET_CLAIM_ID, TICKET_CLOSE_ID]);
  assert.ok(
    !t.calls.includes('awaitEvent:channelDelete'),
    'the member must not close what staff own',
  );
});

test('denial runs without a handoff sink when executed directly', async () => {
  const t = denialSuccessTransport();
  await flowByKey('ticket-open-denial')!.run(ctx(t));
});

test('denial fails when no channel is created, keeping only the pre-open handoff', async () => {
  const t = denialSuccessTransport();
  t.events.channelCreate = [];
  const handoffs: string[] = [];
  await rejectsWithStep(flowByKey('ticket-open-denial')!.run(ctx(t, TARGETS, handoffs)), 'ticket-channel-created');
  assert.equal(handoffs.length, 1, 'the channel-bound handoff cannot exist without a channel');
  assert.deepEqual(t.buttonCalls.map((b) => b.customId), [TICKET_OPEN_ID]);
});

test('denial fails when the controls greeting never arrives, after handing the channel to staff', async () => {
  const t = denialSuccessTransport();
  t.events.messageCreate = [];
  const handoffs: string[] = [];
  await rejectsWithStep(flowByKey('ticket-open-denial')!.run(ctx(t, TARGETS, handoffs)), 'ticket-controls-posted');
  assert.match(handoffs[1]!, /ticket-42/, 'the open channel is handed off even though controls never arrive');
  assert.deepEqual(t.buttonCalls.map((b) => b.customId), [TICKET_OPEN_ID]);
});

const notARefusal: [string, Record<string, unknown>][] = [
  ['a successful claim', { content: `Claimed by <@${TARGETS.accountId}>.` }],
  ['another author', { authorId: 'somebody-else' }],
  ['another channel', { channelId: 'another-ticket' }],
  ['a public reply', { flags: 0 }],
  ['non-numeric flags', { flags: '64' }],
];
for (const [name, data] of notARefusal) {
  test(`denial rejects ${name} as a claim refusal but keeps the cleanup handoff`, async () => {
    const t = denialSuccessTransport();
    t.events.messageCreate = [
      ticketControls(),
      staffRefusal('Only staff can claim tickets.', data),
      staffRefusal('Only staff can close tickets.'),
    ];
    const handoffs: string[] = [];
    await rejectsWithStep(flowByKey('ticket-open-denial')!.run(ctx(t, TARGETS, handoffs)), 'claim-denied');
    assert.match(handoffs[1]!, /ticket-42/);
    assert.equal(t.buttonCalls.length, 2, 'close must not be pressed after a failed claim step');
  });
}

test('denial rejects a close refusal with the wrong text', async () => {
  const t = denialSuccessTransport();
  t.events.messageCreate = [
    ticketControls(),
    staffRefusal('Only staff can claim tickets.'),
    staffRefusal('Only staff can claim tickets.'),
  ];
  await rejectsWithStep(flowByKey('ticket-open-denial')!.run(ctx(t)), 'close-denied');
});

// --- voice-verify ------------------------------------------------------------

test('voice-verify joins the lobby, follows the move, leaves, and sees cleanup', async () => {
  const t = new MockTransport();
  // A create for the lobby itself is not the spawn; the flow must bind the fresh channel.
  t.events.channelCreate = [
    { name: 'channelCreate', data: { id: TARGETS.voiceLobbyChannelId } },
    { name: 'channelCreate', data: { id: 'spawned-7' } },
  ];
  t.events.voiceStateUpdate = [
    { name: 'voiceStateUpdate', data: { userId: TARGETS.accountId, channelId: 'spawned-7' } },
  ];
  t.events.channelDelete = [{ name: 'channelDelete', data: { id: 'spawned-7' } }];

  await flowByKey('voice-verify')!.run(ctx(t));

  assert.deepEqual(t.voiceJoins, [TARGETS.voiceLobbyChannelId]);
  assert.equal(t.leaves, 1);
});

test('voice-verify fails when only the lobby channel exists', async () => {
  const t = new MockTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: TARGETS.voiceLobbyChannelId } }];
  await rejectsWithStep(flowByKey('voice-verify')!.run(ctx(t)), 'ephemeral-channel-created');
});

test('voice-verify fails when the member is left sitting in the lobby', async () => {
  const t = new MockTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'spawned-7' } }];
  t.events.voiceStateUpdate = [
    {
      name: 'voiceStateUpdate',
      data: { userId: TARGETS.accountId, channelId: TARGETS.voiceLobbyChannelId },
    },
  ];
  await rejectsWithStep(flowByKey('voice-verify')!.run(ctx(t)), 'moved-into-channel');
});

test('voice-verify fails when the ephemeral channel never cleans up, after leaving', async () => {
  const t = new MockTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'spawned-7' } }];
  t.events.voiceStateUpdate = [
    { name: 'voiceStateUpdate', data: { userId: TARGETS.accountId, channelId: 'spawned-7' } },
  ];
  t.events.channelDelete = [];
  await rejectsWithStep(flowByKey('voice-verify')!.run(ctx(t)), 'ephemeral-channel-removed');
  assert.equal(t.leaves, 1, 'leave still runs before the cleanup assertion');
});
