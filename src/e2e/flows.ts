/**
 * The five member journeys the harness can drive, and what each one proves.
 *
 * Every flow here is a card that is currently blocked on a human doing the
 * member half by hand:
 *
 *   join-screen        TOG-3085  a member clears the rules gate and gets welcomed
 *   reaction           TOG-2796  a reaction on the self-role panel grants the role
 *   ticket-buttons     TOG-3690  open / claim / close to success (dry-run-only for members)
 *   ticket-open-denial TOG-3690  open as an ordinary member; staff claim/close refused
 *   voice-verify       TOG-3122  joining the lobby makes an auto-voice channel
 *
 * THE FULL TICKET SEQUENCE IS INELIGIBLE FOR LIVE ORDINARY-MEMBER RUNS
 * (TOG-4122). `ticket-buttons` presses Claim/Close to success, which requires
 * staff, so the runner refuses it in live runs before any side effect and
 * records it `skipped` with an `ineligible:` detail; dry runs still execute
 * it. `ticket-open-denial` is the live member path instead: it opens a real
 * ticket, proves Claim and Close are refused with the bot's exact staff-only
 * replies, leaves the ticket open, and hands the channel to authorized staff
 * for cleanup. A passed denial flow is partial TOG-3690 coverage by
 * construction; successful Claim/Close stays an explicit residual, never a
 * silent one.
 *
 * WHAT COUNTS AS PROOF. Every assertion in this file waits for a GATEWAY
 * event, never for the response to the request that caused it. The distinction
 * is the point: a 204 from `PUT /reactions` proves the reaction was accepted,
 * and proves nothing about whether the bot noticed it and granted a role.
 * `guildMemberUpdate` carrying the new role is the only thing that does, and it
 * is also exactly the evidence these cards are stuck waiting for a human to
 * screenshot.
 *
 * A TIMEOUT IS A FAILED TEST, NOT A BROKEN HARNESS. `expectEvent` throws
 * `FlowAssertionFailed`, which the runner records as a failing flow and which
 * does NOT halt the session - the remaining flows still run, the same way a
 * failing assertion does not abort a test file. Only the guard's own refusals
 * (403/401/429, budgets) stop everything, because those are about the account
 * rather than about the bot.
 *
 * NO SNOWFLAKES LIVE IN THIS FILE. Channel, message and role ids arrive as
 * `FlowTargets` from the runner, which reads them from the environment. That
 * keeps `scripts/ci/check-src-snowflakes.sh` satisfied and, more usefully,
 * means pointing the harness at a rebuilt staging guild is a config change.
 */

// Imported rather than retyped so a rename in the bot breaks this flow at
// compile time instead of at 2am on staging.
import { MessageFlags } from 'discord.js';
import { TICKET_CLAIM_ID, TICKET_CLOSE_ID, TICKET_OPEN_ID } from '../discord/tickets.ts';
import type { HarnessGuard } from './guard.ts';
import type { GatewayEvent, HarnessTransport } from './transport.ts';

/**
 * The ids a flow needs, supplied by the caller. Each flow declares the subset
 * it requires so the runner can refuse a half-configured run up front instead
 * of failing three actions in.
 */
export interface FlowTargets {
  guildId: string;
  /** The test account's own user id, so assertions can tell its events from anyone else's. */
  accountId: string;
  welcomeChannelId: string;
  selfRolePanelChannelId: string;
  selfRolePanelMessageId: string;
  /** Unicode emoji or `name:id`, as Discord's reaction API takes it. */
  selfRoleEmoji: string;
  /** The role the reaction is expected to grant. */
  selfRoleId: string;
  ticketPanelChannelId: string;
  ticketPanelMessageId: string;
  /** The ticket bot's user id, to exclude another author's messages. */
  ticketBotId: string;
  voiceLobbyChannelId: string;
}

export type TargetKey = keyof FlowTargets;

export class FlowAssertionFailed extends Error {
  readonly step: string;
  constructor(step: string, detail: string) {
    super(`${step}: ${detail}`);
    this.name = 'FlowAssertionFailed';
    this.step = step;
  }
}

export interface FlowContext {
  guard: HarnessGuard;
  transport: HarnessTransport;
  targets: FlowTargets;
  /** How long to wait for each gateway assertion. */
  timeoutMs: number;
  /**
   * Optional sink the runner provides per flow. A flow that creates a live
   * resource records its handoff here the moment the resource exists, so the
   * transcript hands it to staff even when a later step fails. Absent when a
   * flow is run directly (tests); flows must treat it as optional.
   */
  noteCleanupHandoff?: (handoff: string) => void;
}

export interface Flow {
  key: string;
  title: string;
  /** The card this flow un-gates, for the transcript and the board comment. */
  unblocks: string;
  requires: TargetKey[];
  /**
   * When set, live runs skip this flow before any side effect with an
   * `ineligible:` detail. Dry runs still execute it. Used when the sequence
   * needs privileges the approved ordinary-member account must never hold.
   */
  liveIneligibleReason?: string;
  /**
   * What a pass does NOT prove, copied into every result for this flow. A flow
   * that is partial coverage by design says so here rather than letting a
   * green transcript imply the whole card.
   */
  coverageResidual?: string;
  run(ctx: FlowContext): Promise<void>;
}

/** Wait for a gateway event, and fail the flow if it never arrives. */
async function expectEvent(
  ctx: FlowContext,
  step: string,
  name: string,
  pred: (e: GatewayEvent) => boolean,
): Promise<GatewayEvent> {
  const event = await ctx.guard.act('observe', step, () =>
    ctx.transport.awaitEvent(name, pred, ctx.timeoutMs),
  );
  if (!event) {
    throw new FlowAssertionFailed(step, `no ${name} matched within ${ctx.timeoutMs}ms`);
  }
  return event;
}

/** `data.userId === the test account`. Every member-scoped assertion needs this. */
function isOurs(ctx: FlowContext, e: GatewayEvent): boolean {
  return e.data.userId === ctx.targets.accountId;
}

/**
 * The bot's exact staff-only refusal for a ticket button, as an ephemeral
 * reply in the ticket channel from the ticket bot (`claimTicket` /
 * `closeTicket` in src/discord/tickets.ts). Retyped literally, like the Claim
 * predicate below: these strings are inline in the bot, not exported
 * constants, so a reword there must fail this flow loudly, not pass it weakly.
 */
function isStaffRefusal(
  ctx: FlowContext,
  ticketChannelId: string,
  content: 'Only staff can claim tickets.' | 'Only staff can close tickets.',
): (e: GatewayEvent) => boolean {
  return (e) =>
    e.data.channelId === ticketChannelId &&
    e.data.authorId === ctx.targets.ticketBotId &&
    e.data.content === content &&
    typeof e.data.flags === 'number' &&
    (e.data.flags & MessageFlags.Ephemeral) !== 0;
}

const joinScreen: Flow = {
  key: 'join-screen',
  title: 'Join, clear the rules gate, get welcomed',
  unblocks: 'TOG-3085',
  requires: ['guildId', 'accountId', 'welcomeChannelId'],
  async run(ctx) {
    await ctx.guard.act('message', 'accept-rules', () => ctx.transport.acceptRules());

    // Discord reports screening as `pending`. The member object flipping it to
    // false is the gate opening; there is no separate event for it.
    await expectEvent(
      ctx,
      'gate-opened',
      'guildMemberUpdate',
      (e) => isOurs(ctx, e) && e.data.pending === false,
    );

    // The bot's side: it must notice the gate opening and post the welcome.
    await expectEvent(
      ctx,
      'welcome-posted',
      'messageCreate',
      (e) => e.data.channelId === ctx.targets.welcomeChannelId,
    );
  },
};

const reaction: Flow = {
  key: 'reaction',
  title: 'React on the self-role panel and receive the role',
  unblocks: 'TOG-2796',
  requires: [
    'guildId',
    'accountId',
    'selfRolePanelChannelId',
    'selfRolePanelMessageId',
    'selfRoleEmoji',
    'selfRoleId',
  ],
  async run(ctx) {
    await ctx.guard.act('reaction', 'add-reaction', () =>
      ctx.transport.addReaction(
        ctx.targets.selfRolePanelChannelId,
        ctx.targets.selfRolePanelMessageId,
        ctx.targets.selfRoleEmoji,
      ),
    );

    // The role landing on the member is the assertion. The 204 from the
    // reaction request is not - it only says Discord accepted the reaction.
    await expectEvent(
      ctx,
      'role-granted',
      'guildMemberUpdate',
      (e) =>
        isOurs(ctx, e) &&
        Array.isArray(e.data.roles) &&
        (e.data.roles as unknown[]).includes(ctx.targets.selfRoleId),
    );
  },
};

const ticketButtons: Flow = {
  key: 'ticket-buttons',
  title: 'Open, claim and close a ticket by pressing the buttons',
  unblocks: 'TOG-3690',
  requires: ['guildId', 'accountId', 'ticketPanelChannelId', 'ticketPanelMessageId', 'ticketBotId'],
  // Claim and Close to success require staff. The approved account is an
  // ordinary member and must stay one, so live runs skip this flow entirely;
  // see ticket-open-denial for the live member path. Dry runs execute it so
  // the sequence stays exercised.
  liveIneligibleReason:
    'the approved live account is an ordinary member, and claim/close to success require staff ' +
    '(TOG-4122). Run ticket-open-denial live instead; successful staff claim/close stays residual on TOG-3690.',
  async run(ctx) {
    await ctx.guard.act('button', 'press-open', () =>
      ctx.transport.clickButton(
        ctx.targets.ticketPanelChannelId,
        ctx.targets.ticketPanelMessageId,
        TICKET_OPEN_ID,
      ),
    );
    const created = await expectEvent(
      ctx,
      'ticket-channel-created',
      'channelCreate',
      (e) => typeof e.data.id === 'string',
    );
    const ticketChannelId = String(created.data.id);

    // The panel only has Open. Claim and Close live on the bot's greeting in
    // the newly created channel, with a different message id (tickets.ts).
    const controls = await expectEvent(
      ctx,
      'ticket-controls-posted',
      'messageCreate',
      (e) =>
        e.data.channelId === ticketChannelId &&
        e.data.authorId === ctx.targets.ticketBotId &&
        typeof e.data.id === 'string' && e.data.id.length > 0 &&
        Array.isArray(e.data.componentCustomIds) &&
        e.data.componentCustomIds.includes(TICKET_CLAIM_ID) &&
        e.data.componentCustomIds.includes(TICKET_CLOSE_ID),
    );
    const controlsMessageId = String(controls.data.id);

    await ctx.guard.act('button', 'press-claim', () =>
      ctx.transport.clickButton(ticketChannelId, controlsMessageId, TICKET_CLAIM_ID),
    );
    // claimTicket replies ephemerally with this exact acknowledgment. A greeting,
    // permission refusal or generic error in the same channel is NOT a claim.
    // Claim and Close require staff; an ordinary member must fail this flow,
    // never be silently elevated or counted as a successful staff-action proof.
    await expectEvent(
      ctx,
      'claim-acknowledged',
      'messageCreate',
      (e) =>
        e.data.channelId === ticketChannelId &&
        e.data.authorId === ctx.targets.ticketBotId &&
        e.data.content === `Claimed by <@${ctx.targets.accountId}>.` &&
        typeof e.data.flags === 'number' &&
        (e.data.flags & MessageFlags.Ephemeral) !== 0,
    );

    await ctx.guard.act('button', 'press-close', () =>
      ctx.transport.clickButton(ticketChannelId, controlsMessageId, TICKET_CLOSE_ID),
    );
    // Closing archives or deletes the channel depending on configuration, so
    // the assertion is on the channel going away for us either way.
    await expectEvent(
      ctx,
      'ticket-closed',
      'channelDelete',
      (e) => e.data.id === ticketChannelId,
    );
  },
};

const ticketOpenDenial: Flow = {
  key: 'ticket-open-denial',
  title: 'Open a ticket as an ordinary member; staff claim/close are refused',
  unblocks: 'TOG-3690',
  requires: ['guildId', 'accountId', 'ticketPanelChannelId', 'ticketPanelMessageId', 'ticketBotId'],
  // A pass here is partial coverage by design. It must never read as the
  // whole card, so the runner copies this into every result for this flow.
  coverageResidual:
    'covers open-as-member plus staff-only claim/close refusals only; ' +
    'successful staff claim/close stays residual on TOG-3690 (TOG-4122).',
  async run(ctx) {
    ctx.noteCleanupHandoff?.(
      'cleanup handoff: Open attempted; ticket channel not yet observed. Authorized staff must check ' +
      `staging for a ticket belonging to account ${ctx.targets.accountId} and close it if created.`,
    );
    await ctx.guard.act('button', 'press-open', () =>
      ctx.transport.clickButton(
        ctx.targets.ticketPanelChannelId,
        ctx.targets.ticketPanelMessageId,
        TICKET_OPEN_ID,
      ),
    );
    const created = await expectEvent(
      ctx,
      'ticket-channel-created',
      'channelCreate',
      (e) => typeof e.data.id === 'string',
    );
    const ticketChannelId = String(created.data.id);

    // The handoff is recorded the moment the channel exists, before any later
    // assertion can fail. Whatever happens next - a missed refusal, a
    // timeout, an unknown channel on the follow-up press - the ticket is open
    // on staging and authorized staff must close it, because the member
    // cannot: Close is staff-only and the harness must not elevate them.
    ctx.noteCleanupHandoff?.(
      `cleanup handoff: ticket channel ${ticketChannelId} left open on staging for authorized staff ` +
        '(TOG-4122); the ordinary-member account cannot close it.',
    );

    // Same observed controls as the full sequence: Claim and Close live on
    // the bot's greeting in the new channel, not on the panel (tickets.ts).
    const controls = await expectEvent(
      ctx,
      'ticket-controls-posted',
      'messageCreate',
      (e) =>
        e.data.channelId === ticketChannelId &&
        e.data.authorId === ctx.targets.ticketBotId &&
        typeof e.data.id === 'string' && e.data.id.length > 0 &&
        Array.isArray(e.data.componentCustomIds) &&
        e.data.componentCustomIds.includes(TICKET_CLAIM_ID) &&
        e.data.componentCustomIds.includes(TICKET_CLOSE_ID),
    );
    const controlsMessageId = String(controls.data.id);

    // A member pressing Claim must be refused, not ignored and not claimed.
    // The content below is the bot's exact staff refusal, byte for byte; any
    // reword fails the flow rather than passing it on a generic error.
    await ctx.guard.act('button', 'press-claim-expect-denial', () =>
      ctx.transport.clickButton(ticketChannelId, controlsMessageId, TICKET_CLAIM_ID),
    );
    await expectEvent(
      ctx,
      'claim-denied',
      'messageCreate',
      isStaffRefusal(ctx, ticketChannelId, 'Only staff can claim tickets.'),
    );

    // Same for Close - and deliberately the last side effect. The flow ends
    // with the ticket OPEN: no channelDelete is awaited, because the member
    // must not close what staff own, and cleanup is the handoff above.
    await ctx.guard.act('button', 'press-close-expect-denial', () =>
      ctx.transport.clickButton(ticketChannelId, controlsMessageId, TICKET_CLOSE_ID),
    );
    await expectEvent(
      ctx,
      'close-denied',
      'messageCreate',
      isStaffRefusal(ctx, ticketChannelId, 'Only staff can close tickets.'),
    );
  },
};

const voiceVerify: Flow = {
  key: 'voice-verify',
  title: 'Join the auto-voice lobby and get moved into a fresh channel',
  unblocks: 'TOG-3122',
  requires: ['guildId', 'accountId', 'voiceLobbyChannelId'],
  async run(ctx) {
    await ctx.guard.act('voice', 'join-lobby', () =>
      ctx.transport.joinVoice(ctx.targets.voiceLobbyChannelId),
    );

    const spawned = await expectEvent(
      ctx,
      'ephemeral-channel-created',
      'channelCreate',
      (e) => typeof e.data.id === 'string' && e.data.id !== ctx.targets.voiceLobbyChannelId,
    );
    const spawnedId = String(spawned.data.id);

    // Being MOVED is the thing under test - the bot creates the channel and
    // drags the member into it. A `channelCreate` on its own would pass even if
    // the member were left sitting in the lobby.
    await expectEvent(
      ctx,
      'moved-into-channel',
      'voiceStateUpdate',
      (e) => isOurs(ctx, e) && e.data.channelId === spawnedId,
    );

    await ctx.guard.act('voice', 'leave-channel', () => ctx.transport.leaveVoice());

    // And the ephemeral channel must clean itself up, which is the half
    // TOG-3122 is actually about.
    await expectEvent(
      ctx,
      'ephemeral-channel-removed',
      'channelDelete',
      (e) => e.data.id === spawnedId,
    );
  },
};

export const FLOWS: ReadonlyArray<Flow> = [
  joinScreen,
  reaction,
  ticketButtons,
  ticketOpenDenial,
  voiceVerify,
];

export function flowByKey(key: string): Flow | null {
  return FLOWS.find((f) => f.key === key) ?? null;
}

/** Target keys a flow needs that are missing or empty. Empty array = runnable. */
export function missingTargets(flow: Flow, targets: Partial<FlowTargets>): TargetKey[] {
  return flow.requires.filter((k) => !targets[k]);
}
