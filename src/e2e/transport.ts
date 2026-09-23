/**
 * Everything the end-to-end harness is allowed to do to Discord (TOG-3978).
 *
 * This interface is the harness's blast radius written down. It has seven verbs
 * and none of them is administrative: the account can accept the rules, post,
 * react, press a button, move between voice channels, and watch. It cannot
 * kick, ban, edit a channel, or change a role, because there is no method here
 * that would let it - which is how the owner's least-privilege condition is
 * enforced rather than merely promised. TOG-740 and the TOG-3122 fixes stay
 * with a human for exactly that reason.
 *
 * WHY `awaitEvent` IS A TRANSPORT VERB AND NOT A TEST HELPER
 *
 * The assertions this harness makes are gateway-visible outcomes: the member
 * stopped being `pending`, a channel appeared, a role landed. Those arrive on
 * the websocket, not as the response to the request that caused them. So
 * waiting for one is an action with a cost and a failure mode, it goes through
 * the same guard as everything else, and it belongs in the same interface.
 *
 * THE CREDENTIAL LIVES HERE AND NOWHERE ELSE. An implementation holds the
 * token; the guard, the flows and the transcript never see it. That is what
 * makes a transcript publishable without redaction.
 */

import type { Acted } from './guard.ts';

/**
 * A gateway event, reduced to the fields a flow assertion actually reads.
 * Deliberately not discord.js's types: this harness must be usable from a
 * user-token client library, and the shape below is what both can produce.
 */
export interface GatewayEvent {
  /** discord.js event name, e.g. `guildMemberUpdate`, `channelCreate`. */
  name: string;
  /** The raw payload, narrowed by the predicate that was waiting for it. */
  data: Record<string, unknown>;
}

export interface HarnessTransport {
  /** Complete membership screening - the rules gate (TOG-3085). */
  acceptRules(): Promise<Acted<void>>;
  sendMessage(channelId: string, content: string): Promise<Acted<{ id: string }>>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<Acted<void>>;
  /** Press a message component. `customId` comes from src/discord/tickets.ts. */
  clickButton(channelId: string, messageId: string, customId: string): Promise<Acted<void>>;
  joinVoice(channelId: string): Promise<Acted<void>>;
  leaveVoice(): Promise<Acted<void>>;
  /**
   * Return the first gateway event satisfying `pred`, waiting up to
   * `timeoutMs` if it has not arrived yet.
   *
   * IMPLEMENTATIONS MUST BUFFER. An implementation that starts listening when
   * it is called - the literal reading of "block until" - is wrong here, and
   * wrong in a way that accuses a healthy bot. The guard sleeps >= 2s before
   * every action (`HarnessGuard.act`), and `guildMemberUpdate`, `channelCreate`
   * and `voiceStateUpdate` all land well inside that window: by the time the
   * flow asks, the event it is waiting for has usually already happened. So a
   * transport must keep a rolling buffer of received events from the moment the
   * session opens, scan it first, and only then wait. Proven, not theorised:
   * the same join-screen flow fails `no guildMemberUpdate matched` on an
   * unbuffered transport and passes on a buffered one. The offline tests cannot
   * catch this - their fake reads a pre-populated map - which is exactly why the
   * obligation is written here.
   *
   * A timeout is a FAILED ASSERTION, not an error: it means the bot did not do
   * the thing the flow exists to prove. Implementations report it as status
   * 504 so the guard lets the flow record it and stop, rather than halting the
   * whole session the way a 403 does.
   */
  awaitEvent(
    name: string,
    pred: (e: GatewayEvent) => boolean,
    timeoutMs: number,
  ): Promise<Acted<GatewayEvent | null>>;
}

/**
 * A transport that reaches nothing.
 *
 * This is not a test double - `scripts/e2e-harness.ts --dry-run` uses it, and
 * that is the only way to exercise the flow definitions and the guard before
 * the throwaway account exists. It answers 200 to everything, so a dry run
 * proves the step sequence, the pacing and the transcript shape, and proves
 * nothing at all about Discord. The transcript it produces says `dry_run: true`
 * for that reason; a reviewer must never be able to mistake one for evidence.
 */
export class DryRunTransport implements HarnessTransport {
  /** Every call, in order, as `verb:arg`. The dry run's whole output. */
  readonly calls: string[] = [];

  private ok<T>(call: string, value: T): Promise<Acted<T>> {
    this.calls.push(call);
    return Promise.resolve({ status: 200, value });
  }

  acceptRules(): Promise<Acted<void>> {
    return this.ok('acceptRules', undefined);
  }
  sendMessage(channelId: string): Promise<Acted<{ id: string }>> {
    return this.ok(`sendMessage:${channelId}`, { id: 'dry-run-message' });
  }
  addReaction(channelId: string, messageId: string, emoji: string): Promise<Acted<void>> {
    return this.ok(`addReaction:${channelId}:${messageId}:${emoji}`, undefined);
  }
  clickButton(channelId: string, messageId: string, customId: string): Promise<Acted<void>> {
    return this.ok(`clickButton:${channelId}:${messageId}:${customId}`, undefined);
  }
  joinVoice(channelId: string): Promise<Acted<void>> {
    return this.ok(`joinVoice:${channelId}`, undefined);
  }
  leaveVoice(): Promise<Acted<void>> {
    return this.ok('leaveVoice', undefined);
  }
  awaitEvent(name: string): Promise<Acted<GatewayEvent | null>> {
    // Returns the event it was asked for, which is exactly why a dry run
    // cannot prove a flow passed: every assertion succeeds by construction.
    return this.ok(`awaitEvent:${name}`, { name, data: { dryRun: true } });
  }
}
