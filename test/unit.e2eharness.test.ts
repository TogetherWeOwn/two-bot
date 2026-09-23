/**
 * The session fence and the flow runner (TOG-3978).
 *
 * `unit.e2eguard.test.ts` covers the volume conditions. This file covers the
 * other two: the harness only ever points at TWO Staging, and only one session
 * exists at a time. Then it covers the runner's contract, which is the reason a
 * single run can serve four blocked cards - a failed assertion is about the BOT
 * and the next flow still runs, a halt is about the ACCOUNT and everything
 * stops.
 *
 * The transport here is a fake with a scripted status per call. No socket is
 * opened and no credential is read from the real environment: `openSession`
 * takes an injected `CredentialSource`, so the token in these tests is a string
 * in this file's scope and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HarnessGuard, type Acted, type HarnessClock } from '../src/e2e/guard.ts';
import {
  E2E_TOKEN_ENV,
  assertStagingGuild,
  openSession,
  sessionIsOpen,
} from '../src/e2e/session.ts';
import type { GatewayEvent, HarnessTransport } from '../src/e2e/transport.ts';
import { FLOWS, flowByKey, missingTargets, type FlowTargets } from '../src/e2e/flows.ts';
import { exitCodeFor, runFlows } from '../src/e2e/runner.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const FAKE_TOKEN = 'not.a.real.token';

function instantClock(): HarnessClock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

/** A guard with real budgets but no wall-clock cost. Pacing is tested elsewhere. */
function fastGuard(): HarnessGuard {
  return new HarnessGuard({ clock: instantClock(), random: () => 0 });
}

/**
 * A transport that records every call and answers from a script.
 *
 * `statuses` maps a verb (or `verb:n` for the nth call of it) to the status to
 * return, so a test can make exactly one action in the middle of a flow fail.
 * `events` is the gateway traffic per event name: `awaitEvent` returns the
 * first entry the predicate accepts and removes it. An empty array means
 * nothing matched before the timeout. This models consumption, not live timing.
 */
class FakeTransport implements HarnessTransport {
  readonly calls: string[] = [];
  readonly buttonCalls: { channelId: string; messageId: string; customId: string }[] = [];
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
    return this.answer('acceptRules', undefined);
  }
  sendMessage(): Promise<Acted<{ id: string }>> {
    return this.answer('sendMessage', { id: 'msg' });
  }
  addReaction(): Promise<Acted<void>> {
    return this.answer('addReaction', undefined);
  }
  clickButton(channelId: string, messageId: string, customId: string): Promise<Acted<void>> {
    this.buttonCalls.push({ channelId, messageId, customId });
    return this.answer(`clickButton:${customId}`, undefined);
  }
  joinVoice(): Promise<Acted<void>> {
    return this.answer('joinVoice', undefined);
  }
  leaveVoice(): Promise<Acted<void>> {
    return this.answer('leaveVoice', undefined);
  }
  awaitEvent(
    name: string,
    pred: (e: GatewayEvent) => boolean,
  ): Promise<Acted<GatewayEvent | null>> {
    this.calls.push(`awaitEvent:${name}`);
    // The predicate is applied here, exactly as a real gateway client applies
    // it: a fake that returned whatever it was handed could not fail a flow on
    // a wrong userId, which is one of the things these flows exist to check.
    const buffer = this.events[name] ?? [];
    const index = buffer.findIndex(pred);
    const event = index < 0 ? null : buffer.splice(index, 1)[0]!;
    // A timeout is reported as 504 by contract, and must NOT halt the session.
    return Promise.resolve({ status: event ? 200 : 504, value: event });
  }
}

const TARGETS: FlowTargets = {
  guildId: TWO_STAGING_GUILD_ID,
  accountId: 'account-1',
  welcomeChannelId: 'welcome-1',
  selfRolePanelChannelId: 'panel-1',
  selfRolePanelMessageId: 'panel-msg-1',
  selfRoleEmoji: 'ok',
  selfRoleId: 'role-1',
  ticketPanelChannelId: 'tickets-1',
  ticketPanelMessageId: 'tickets-msg-1',
  ticketBotId: 'ticket-bot-1',
  voiceLobbyChannelId: 'lobby-1',
};

function ticketControls(data: Record<string, unknown> = {}): GatewayEvent {
  return {
    name: 'messageCreate',
    data: {
      id: 'ticket-controls-42', channelId: 'ticket-42', authorId: TARGETS.ticketBotId,
      content: `<@${TARGETS.accountId}> Thanks — staff will be with you shortly.`,
      componentCustomIds: ['two:tickets:claim', 'two:tickets:close'],
      ...data,
    },
  };
}

function claimAcknowledgment(data: Record<string, unknown> = {}): GatewayEvent {
  return {
    name: 'messageCreate',
    data: {
      id: 'claim-reply-42', channelId: 'ticket-42', authorId: TARGETS.ticketBotId,
      content: `Claimed by <@${TARGETS.accountId}>.`, flags: 64,
      ...data,
    },
  };
}

function ticketTransport(): FakeTransport {
  const t = new FakeTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'ticket-42' } }];
  t.events.messageCreate = [ticketControls(), claimAcknowledgment()];
  t.events.channelDelete = [{ name: 'channelDelete', data: { id: 'ticket-42' } }];
  return t;
}

function ctx(transport: FakeTransport, targets: FlowTargets = TARGETS) {
  return { guard: fastGuard(), transport, targets, timeoutMs: 100 };
}

// --- the guild fence ---------------------------------------------------------

test('the live guild is refused by name, not by a generic error', () => {
  assert.throws(() => assertStagingGuild(LIVE_GUILD_ID), /live guild \(TogetherWeOwn\)/);
  assert.throws(() => assertStagingGuild(LIVE_GUILD_ID), /new owner decision/);
});

test('any guild that is not staging is refused too', () => {
  assert.throws(() => assertStagingGuild('123456789012345678'), /not the staging guild/);
  assert.doesNotThrow(() => assertStagingGuild(TWO_STAGING_GUILD_ID));
});

// --- the session -------------------------------------------------------------

const creds = (env: NodeJS.ProcessEnv) => ({ dir: null, env });

test('openSession refuses the live guild before it reads any credential', async () => {
  let read = false;
  await assert.rejects(
    () =>
      openSession({
        guildId: LIVE_GUILD_ID,
        connect: () => {
          read = true;
          return new FakeTransport();
        },
        credentials: creds({ [E2E_TOKEN_ENV]: FAKE_TOKEN }),
      }),
    /live guild/,
  );
  assert.equal(read, false);
  assert.equal(sessionIsOpen(), false);
});

test('a missing credential is refused by naming the env var, and says where it is not', async () => {
  await assert.rejects(
    () =>
      openSession({
        guildId: TWO_STAGING_GUILD_ID,
        connect: () => new FakeTransport(),
        credentials: creds({}),
      }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : '';
      assert.match(msg, new RegExp(E2E_TOKEN_ENV));
      assert.match(msg, /never read from a file in this repo/);
      return true;
    },
  );
  assert.equal(sessionIsOpen(), false);
});

test('one session at a time; close() releases it', async () => {
  const open = () =>
    openSession({
      guildId: TWO_STAGING_GUILD_ID,
      connect: (token) => {
        assert.equal(token, FAKE_TOKEN, 'the transport is the only thing handed the credential');
        return new FakeTransport();
      },
      credentials: creds({ [E2E_TOKEN_ENV]: FAKE_TOKEN }),
    });

  const first = await open();
  assert.equal(sessionIsOpen(), true);
  // Refused, not queued: two gateway connections from one user account is the
  // most legible automation signal there is.
  await assert.rejects(open, /a session is already open/);

  first.close();
  assert.equal(sessionIsOpen(), false);
  const second = await open();
  second.close();
});

test('a connect that throws does not strand the singleton', async () => {
  await assert.rejects(
    () =>
      openSession({
        guildId: TWO_STAGING_GUILD_ID,
        connect: () => {
          throw new Error(`gateway refused: ${FAKE_TOKEN}`);
        },
        credentials: creds({ [E2E_TOKEN_ENV]: FAKE_TOKEN }),
      }),
    (error: Error) => /connection failed/.test(error.message) && !error.message.includes(FAKE_TOKEN),
  );
  assert.equal(sessionIsOpen(), false, 'the next run in this process would be refused for nothing');
});

test('close tears down once, sanitizes teardown errors and does not release a later session', async () => {
  let closes = 0;
  const transport = Object.assign(new FakeTransport(), { close() { closes++; throw new Error(FAKE_TOKEN); } });
  const options = { guildId: TWO_STAGING_GUILD_ID, connect: () => transport,
    credentials: creds({ [E2E_TOKEN_ENV]: FAKE_TOKEN }) };
  const first = await openSession(options);
  assert.doesNotThrow(() => first.close());
  assert.equal(sessionIsOpen(), false);
  const second = await openSession(options);
  first.close();
  assert.equal(sessionIsOpen(), true);
  assert.equal(closes, 1);
  second.close();
  assert.equal(closes, 2);
  assert.equal(sessionIsOpen(), false);
});

// --- the flows ---------------------------------------------------------------

test('the join-screen flow accepts the rules and then waits for the bot, in that order', async () => {
  const t = new FakeTransport();
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: TARGETS.accountId, pending: false } },
  ];
  t.events.messageCreate = [
    { name: 'messageCreate', data: { channelId: TARGETS.welcomeChannelId } },
  ];

  await flowByKey('join-screen')!.run(ctx(t));

  assert.deepEqual(t.calls, [
    'acceptRules',
    'awaitEvent:guildMemberUpdate',
    'awaitEvent:messageCreate',
  ]);
});

test('the ticket flow presses the panel to open, then the new controls to claim and close', async () => {
  const t = ticketTransport();

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
    { channelId: TARGETS.ticketPanelChannelId, messageId: TARGETS.ticketPanelMessageId, customId: 'two:tickets:open' },
    { channelId: 'ticket-42', messageId: 'ticket-controls-42', customId: 'two:tickets:claim' },
    { channelId: 'ticket-42', messageId: 'ticket-controls-42', customId: 'two:tickets:close' },
  ]);
});

const notClaimAcknowledgments: [string, Record<string, unknown>][] = [
  ['ticket greeting', { content: `<@${TARGETS.accountId}> Thanks — staff will be with you shortly.` }],
  ['staff refusal', { content: 'Only staff can claim tickets.' }],
  ['already claimed', { content: 'This ticket is already claimed or not open.' }],
  ['handler failure', { content: 'The ticket action failed. Please try again.' }],
  ['another claimant', { content: 'Claimed by <@somebody-else>.' }],
  ['another channel', { channelId: 'another-ticket' }],
  ['another author', { authorId: 'somebody-else' }],
  ['public message', { flags: 0 }],
  ['absent flags', { flags: undefined }],
  ['non-numeric flags', { flags: '64' }],
  ['missing content', { content: undefined }],
];
for (const [name, data] of notClaimAcknowledgments) {
  test(`the ticket claim rejects ${name} and does not press close`, async () => {
    const t = ticketTransport();
    t.events.messageCreate = [ticketControls(), claimAcknowledgment(data)];
    const transcript = await runFlows([flowByKey('ticket-buttons')!], ctx(t), { dryRun: true });
    assert.equal(transcript.flows[0]!.outcome, 'failed');
    assert.match(transcript.flows[0]!.detail!, /claim-acknowledged/);
    assert.ok(!t.calls.includes('clickButton:two:tickets:close'));
    assert.equal(transcript.halt, null);
  });
}

test('a real claim after unrelated traffic still passes, including extra message flags', async () => {
  const t = ticketTransport();
  t.events.messageCreate = [
    ticketControls(),
    ...notClaimAcknowledgments.map(([, data]) => claimAcknowledgment(data)),
    claimAcknowledgment({ flags: 64 | 4 }),
  ];
  const transcript = await runFlows([flowByKey('ticket-buttons')!], ctx(t), { dryRun: true });
  assert.equal(transcript.flows[0]!.outcome, 'passed');
  assert.equal(exitCodeFor(transcript), 0);
});

test('a missing ticket bot id is reported as unconfigured without pressing any button', async () => {
  const t = ticketTransport();
  const transcript = await runFlows(
    [flowByKey('ticket-open-denial')!], ctx(t, { ...TARGETS, ticketBotId: '' }), { dryRun: false },
  );
  assert.equal(transcript.flows[0]!.outcome, 'skipped');
  assert.match(transcript.flows[0]!.detail!, /missing targets: ticketBotId/);
  assert.deepEqual(t.calls, []);
});

test('missing ticket controls fail before pressing claim, never falling back to the panel id', async () => {
  const t = ticketTransport();
  t.events.messageCreate = [
    ticketControls({ authorId: 'somebody-else' }),
    ticketControls({ componentCustomIds: ['two:tickets:close'] }),
    ticketControls({ id: undefined }),
  ];
  const transcript = await runFlows([flowByKey('ticket-buttons')!], ctx(t), { dryRun: true });
  assert.equal(transcript.flows[0]!.outcome, 'failed');
  assert.match(transcript.flows[0]!.detail!, /ticket-controls-posted/);
  assert.equal(t.buttonCalls.length, 1);
});

test('buffered matches are consumed once and unmatched events remain available', async () => {
  const t = new FakeTransport();
  const ticket = { name: 'channelCreate', data: { id: 'ticket-42' } };
  const voice = { name: 'channelCreate', data: { id: 'voice-42' } };
  t.events.channelCreate = [ticket, voice];
  const first = await t.awaitEvent('channelCreate', (e) => e.data.id === 'voice-42');
  assert.equal(first.value, voice);
  const second = await t.awaitEvent('channelCreate', () => true);
  assert.equal(second.value, ticket, 'matching voice must not discard an unmatched ticket');
  const empty = await t.awaitEvent('channelCreate', () => true);
  assert.deepEqual(empty, { status: 504, value: null }, 'a matched event cannot satisfy a second await');
});

test('ticket then voice consumes the ticket channel so voice binds its own channel', async () => {
  const t = ticketTransport();
  t.events.channelCreate!.push({ name: 'channelCreate', data: { id: 'voice-42' } });
  t.events.channelDelete!.push({ name: 'channelDelete', data: { id: 'voice-42' } });
  t.events.voiceStateUpdate = [
    { name: 'voiceStateUpdate', data: { userId: TARGETS.accountId, channelId: 'voice-42' } },
  ];
  const transcript = await runFlows(
    [flowByKey('ticket-buttons')!, flowByKey('voice-verify')!], ctx(t), { dryRun: true },
  );
  assert.deepEqual(transcript.flows.map((f) => f.outcome), ['passed', 'passed']);
  assert.equal(exitCodeFor(transcript), 0);
});

test('a gateway event belonging to someone else does not satisfy an assertion', async () => {
  const t = new FakeTransport();
  // The role landed - on a different member. Without the userId check this
  // would pass and TOG-2796 would be "proved" by a stranger's role.
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: 'somebody-else', roles: [TARGETS.selfRoleId] } },
  ];
  const c = ctx(t);
  const transcript = await runFlows([flowByKey('reaction')!], c, { dryRun: false });
  assert.equal(transcript.flows[0]!.outcome, 'failed');
});

test('the voice flow requires being MOVED, not just a channel appearing', async () => {
  const t = new FakeTransport();
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'spawned-1' } }];
  t.events.channelDelete = [{ name: 'channelDelete', data: { id: 'spawned-1' } }];
  // The bot made the channel but left the member sitting in the lobby, which is
  // the half of TOG-3122 that a channelCreate alone would wrongly call a pass.
  t.events.voiceStateUpdate = [
    { name: 'voiceStateUpdate', data: { userId: TARGETS.accountId, channelId: TARGETS.voiceLobbyChannelId } },
  ];

  const stuck = await runFlows([flowByKey('voice-verify')!], ctx(t), { dryRun: false });
  assert.equal(stuck.flows[0]!.outcome, 'failed');
  assert.match(stuck.flows[0]!.detail!, /moved-into-channel/);

  // A second run needs a fresh channelCreate: the first run consumed its event.
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'spawned-1' } }];
  t.events.voiceStateUpdate = [
    { name: 'voiceStateUpdate', data: { userId: TARGETS.accountId, channelId: 'spawned-1' } },
  ];
  const moved = await runFlows([flowByKey('voice-verify')!], ctx(t), { dryRun: false });
  assert.equal(moved.flows[0]!.outcome, 'passed');
});

test('full staff-success flow is ineligible live before any side effect', async () => {
  const t = ticketTransport();
  const transcript = await runFlows([flowByKey('ticket-buttons')!], ctx(t), { dryRun: false });
  assert.equal(transcript.flows[0].outcome, 'skipped');
  assert.match(transcript.flows[0].detail!, /ineligible:.*ordinary member/);
  assert.equal(exitCodeFor(transcript), 1);
  assert.deepEqual(t.calls, []);
});

function denialTransport(): FakeTransport {
  const t = ticketTransport();
  t.events.messageCreate = [ticketControls(),
    claimAcknowledgment({ content: 'Only staff can claim tickets.' }),
    claimAcknowledgment({ id: 'close-denial', content: 'Only staff can close tickets.' }),
  ];
  return t;
}

test('ordinary-member denial flow records partial coverage and staff cleanup without claiming success', async () => {
  const t = denialTransport();
  const transcript = await runFlows([flowByKey('ticket-open-denial')!], ctx(t), { dryRun: false });
  const result = transcript.flows[0];
  assert.equal(result.outcome, 'passed');
  assert.match(result.coverageResidual!, /successful staff claim\/close stays residual/);
  assert.match(result.cleanupHandoffs![0], /ticket-42.*authorized staff/);
  assert.equal(exitCodeFor(transcript), 0);
  assert.equal(t.buttonCalls.length, 3);
  assert.ok(!t.calls.includes('awaitEvent:channelDelete'));
});

for (const override of [{ content: 'Claimed by <@account-1>.' }, { authorId: 'other' },
  { channelId: 'other' }, { flags: 0 }, { flags: '64' }, { content: 'Generic error' }]) {
  test(`denial rejects ${JSON.stringify(override)} and retains cleanup handoff`, async () => {
    const t = denialTransport();
    Object.assign(t.events.messageCreate![1].data, override);
    const transcript = await runFlows([flowByKey('ticket-open-denial')!], ctx(t), { dryRun: false });
    assert.equal(transcript.flows[0].outcome, 'failed');
    assert.match(transcript.flows[0].cleanupHandoffs![0], /ticket-42/);
    assert.equal(t.buttonCalls.length, 2);
    assert.equal(exitCodeFor(transcript), 1);
  });
}

test('denial flow retains cleanup on unknown channel, missing controls, close timeout and halt', async () => {
  for (const failure of ['unknown', 'controls', 'close', 'halt']) {
    const t = denialTransport();
    if (failure === 'unknown') t.events.channelCreate = [];
    if (failure === 'controls') t.events.messageCreate = [];
    if (failure === 'close') t.events.messageCreate!.pop();
    if (failure === 'halt') t.statuses['clickButton:two:tickets:claim'] = 403;
    const transcript = await runFlows([flowByKey('ticket-open-denial')!], ctx(t), { dryRun: false });
    const result = transcript.flows[0];
    assert.notEqual(result.outcome, 'passed');
    assert.match(result.cleanupHandoffs![0], failure === 'unknown' ? /not yet observed.*account-1/ : /ticket-42/);
    assert.ok(exitCodeFor(transcript) > 0);
  }
});

test('unexpected errors are sanitized and halted/empty live runs cannot exit zero', async () => {
  const t = new FakeTransport();
  t.acceptRules = async () => { throw new Error(FAKE_TOKEN); };
  const transcript = await runFlows([flowByKey('join-screen')!], ctx(t), { dryRun: false });
  assert.equal(transcript.flows[0].outcome, 'halted');
  assert.ok(!JSON.stringify(transcript).includes(FAKE_TOKEN));
  assert.equal(exitCodeFor(transcript), 2);
  assert.equal(exitCodeFor(await runFlows([], ctx(t), { dryRun: false })), 1);
});

// --- the runner --------------------------------------------------------------

test('a failed assertion fails one flow and the next flow still runs', async () => {
  const t = new FakeTransport();
  // The bot never opened the gate and never granted the role.
  t.events.guildMemberUpdate = [];
  // Both the welcome post and the ticket acknowledgement are on the wire; the
  // predicate is what tells them apart.
  t.events.messageCreate = [
    { name: 'messageCreate', data: { channelId: TARGETS.welcomeChannelId } },
    ticketControls(), claimAcknowledgment(),
  ];
  t.events.channelCreate = [{ name: 'channelCreate', data: { id: 'ticket-42' } }];
  t.events.channelDelete = [{ name: 'channelDelete', data: { id: 'ticket-42' } }];

  const transcript = await runFlows(
    [flowByKey('join-screen')!, flowByKey('reaction')!, flowByKey('ticket-buttons')!],
    ctx(t),
    { dryRun: false },
  );

  assert.deepEqual(
    transcript.flows.map((f) => f.outcome),
    ['failed', 'failed', 'skipped'],
  );
  assert.match(transcript.flows[0]!.detail!, /no guildMemberUpdate matched/);
  assert.equal(transcript.halt, null, 'a 504 timeout must not halt the session');
  assert.equal(exitCodeFor(transcript), 1);
});

test('a 403 mid-run halts and skips every remaining flow', async () => {
  const t = new FakeTransport();
  t.statuses.addReaction = 403;
  t.events.guildMemberUpdate = [
    { name: 'guildMemberUpdate', data: { userId: TARGETS.accountId, pending: false } },
  ];
  t.events.messageCreate = [
    { name: 'messageCreate', data: { channelId: TARGETS.welcomeChannelId } },
  ];

  const transcript = await runFlows(
    [flowByKey('join-screen')!, flowByKey('reaction')!, flowByKey('ticket-buttons')!],
    ctx(t),
    { dryRun: false },
  );

  assert.deepEqual(
    transcript.flows.map((f) => f.outcome),
    ['passed', 'halted', 'skipped'],
  );
  assert.equal(transcript.halt?.reason, 'forbidden');
  assert.ok(
    !t.calls.some((c) => c.startsWith('clickButton')),
    'the harness kept poking Discord after a 403',
  );
  assert.equal(exitCodeFor(transcript), 2);
});

test('a half-configured run is refused before it spends any traffic', async () => {
  const t = new FakeTransport();
  const partial: FlowTargets = { ...TARGETS, voiceLobbyChannelId: '', selfRoleId: '' };
  const transcript = await runFlows([flowByKey('voice-verify')!], ctx(t, partial), {
    dryRun: false,
  });

  assert.equal(transcript.flows[0]!.outcome, 'skipped');
  assert.match(transcript.flows[0]!.detail!, /missing targets: voiceLobbyChannelId/);
  assert.deepEqual(t.calls, [], 'a skipped flow reached Discord');
  assert.equal(exitCodeFor(transcript), 1);
});

test('missingTargets names only what the flow actually needs', () => {
  const partial: FlowTargets = { ...TARGETS, voiceLobbyChannelId: '', selfRoleId: '' };
  assert.deepEqual(missingTargets(flowByKey('voice-verify')!, partial), ['voiceLobbyChannelId']);
  assert.deepEqual(missingTargets(flowByKey('reaction')!, partial), ['selfRoleId']);
  assert.deepEqual(missingTargets(flowByKey('join-screen')!, partial), []);
});

test('the transcript is self-describing, non-secret, and marked as a dry run or not', async () => {
  const t = new FakeTransport();
  const transcript = await runFlows([flowByKey('join-screen')!], ctx(t), { dryRun: true });

  assert.equal(transcript.dryRun, true, 'a dry run must never be mistakable for evidence');
  assert.equal(transcript.guildId, TWO_STAGING_GUILD_ID);
  assert.equal(transcript.limits.minGapMs, 2_000, 'the transcript states the pacing it ran under');
  assert.ok(transcript.limits.maxMessagesPerRun < 10);
  assert.ok(!JSON.stringify(transcript).includes(FAKE_TOKEN));
});

test('every flow names the card it unblocks, and the four cards are distinct', () => {
  const unblocks = [...new Set(FLOWS.map((f) => f.unblocks))];
  assert.deepEqual(unblocks.slice().sort(), ['TOG-2796', 'TOG-3085', 'TOG-3122', 'TOG-3690']);
  assert.equal(new Set(FLOWS.map((f) => f.key)).size, FLOWS.length);
});
