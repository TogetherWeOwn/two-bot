/**
 * The four member journeys the harness can drive, and what each one proves.
 *
 * Every flow here is a card that is currently blocked on a human doing the
 * member half by hand:
 *
 *   join-screen    TOG-3085  a member clears the rules gate and gets welcomed
 *   reaction       TOG-2796  a reaction on the self-role panel grants the role
 *   ticket-buttons TOG-3690  open / claim / close, pressed by a member
 *   voice-verify   TOG-3122  joining the lobby makes an auto-voice channel
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
}

export interface Flow {
  key: string;
  title: string;
  /** The card this flow un-gates, for the transcript and the board comment. */
  unblocks: string;
  requires: TargetKey[];
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
  requires: ['guildId', 'accountId', 'ticketPanelChannelId', 'ticketPanelMessageId'],
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

    await ctx.guard.act('button', 'press-claim', () =>
      ctx.transport.clickButton(ticketChannelId, ctx.targets.ticketPanelMessageId, TICKET_CLAIM_ID),
    );
    await expectEvent(
      ctx,
      'claim-acknowledged',
      'messageCreate',
      (e) => e.data.channelId === ticketChannelId,
    );

    await ctx.guard.act('button', 'press-close', () =>
      ctx.transport.clickButton(ticketChannelId, ctx.targets.ticketPanelMessageId, TICKET_CLOSE_ID),
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

export const FLOWS: ReadonlyArray<Flow> = [joinScreen, reaction, ticketButtons, voiceVerify];

export function flowByKey(key: string): Flow | null {
  return FLOWS.find((f) => f.key === key) ?? null;
}

/** Target keys a flow needs that are missing or empty. Empty array = runnable. */
export function missingTargets(flow: Flow, targets: Partial<FlowTargets>): TargetKey[] {
  return flow.requires.filter((k) => !targets[k]);
}
