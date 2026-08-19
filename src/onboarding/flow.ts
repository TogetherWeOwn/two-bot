/**
 * Onboarding decisions, with no discord.js in sight.
 *
 * Same split as core/handlers.ts: this file decides *what should happen*, the
 * adapter in src/discord/onboarding.ts makes it happen. That means the 60-second
 * promise in TWO-7 can be tested without a token, a network, or a test account.
 */

import { nowIso, type FunnelEvent } from '../core/events.ts';
import type { EventStore } from '../store/eventStore.ts';
import { log } from '../core/log.ts';
import { GAME_PICKS, pickByKey, type GamePick } from './catalog.ts';

/**
 * A member becomes promptable the moment they can actually see and click
 * things - not the moment they appear in the member list.
 *
 * TWO has Discord's rules gate on (MEMBER_VERIFICATION_GATE_ENABLED). A member
 * behind that gate arrives with `pending: true` and Discord blocks them from
 * interacting with anything. 11 of the last 12 joins were still `pending`, so
 * prompting on raw GuildMemberAdd would have talked to an empty room almost
 * every time. We wait for pending to clear.
 */
export interface PromptDecision {
  shouldPrompt: boolean;
  reason: 'ok' | 'bot' | 'still_pending' | 'already_prompted';
}

export interface PromptInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  /** Discord's rules-screening flag. true = cannot interact yet. */
  pending: boolean;
}

export async function decidePrompt(store: EventStore, i: PromptInput): Promise<PromptDecision> {
  if (i.isBot) return { shouldPrompt: false, reason: 'bot' };
  if (i.pending) return { shouldPrompt: false, reason: 'still_pending' };
  if (await store.hasEvent(i.guildId, i.memberId, 'onboarding_prompted')) {
    return { shouldPrompt: false, reason: 'already_prompted' };
  }
  return { shouldPrompt: true, reason: 'ok' };
}

/**
 * Where a pick actually sends someone.
 *
 * `visible` answers "can this member open this channel right now?". The adapter
 * supplies it from Discord's own permission check, so we never hand out a link
 * to a channel that will 404 for the person clicking it. Today the three
 * dedicated game channels fail this check for everyone - see docs/ROUTING.md.
 */
export interface Destination {
  pick: GamePick;
  channelId: string;
  /** true when we had to fall back because the purpose-built room is dark. */
  degraded: boolean;
}

export function resolveDestination(
  pick: GamePick,
  visible: (channelId: string) => boolean,
): Destination {
  if (pick.primaryChannelId && visible(pick.primaryChannelId)) {
    return { pick, channelId: pick.primaryChannelId, degraded: false };
  }
  return { pick, channelId: pick.fallbackChannelId, degraded: !!pick.primaryChannelId };
}

export interface SelectionResult {
  /** Roles to add. Already filtered to things we know and can assign. */
  roleIds: string[];
  destinations: Destination[];
  /** Distinct channels to link, in catalog order, deduped. */
  channelIds: string[];
  unknownKeys: string[];
  degradedCount: number;
}

/**
 * Turn "user ticked these boxes" into "grant these roles, link these channels".
 * Pure - it touches neither Discord nor the database.
 */
export function planSelection(
  keys: string[],
  visible: (channelId: string) => boolean,
): SelectionResult {
  const picks: GamePick[] = [];
  const unknownKeys: string[] = [];
  for (const k of keys) {
    const p = pickByKey(k);
    if (p) picks.push(p);
    else unknownKeys.push(k);
  }

  const destinations = picks.map((p) => resolveDestination(p, visible));

  const channelIds: string[] = [];
  for (const d of destinations) {
    if (!channelIds.includes(d.channelId)) channelIds.push(d.channelId);
  }

  return {
    roleIds: picks.map((p) => p.roleId),
    destinations,
    channelIds,
    unknownKeys,
    degradedCount: destinations.filter((d) => d.degraded).length,
  };
}

/**
 * Which game roles a member already holds. Used so the picker opens with their
 * current answers ticked instead of blank - changing one game should not mean
 * re-declaring all of them.
 */
export function currentGameKeys(memberRoleIds: readonly string[]): string[] {
  return GAME_PICKS.filter((p) => memberRoleIds.includes(p.roleId)).map((p) => p.key);
}

/** Funnel writes for onboarding. Kept next to the decisions that cause them. */
export class OnboardingRecorder {
  private store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  /** Wraps decidePrompt so callers do not need a handle on the store. */
  shouldPrompt(i: PromptInput): Promise<PromptDecision> {
    return decidePrompt(this.store, i);
  }

  async prompted(guildId: string, memberId: string, channelId: string): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'onboarding_prompted',
      occurredAt: nowIso(),
      source: `channel:${channelId}`,
    };
    await this.store.record(e);
    log.info('onboarding_prompted', { memberId, channelId });
    return e;
  }

  async selected(guildId: string, memberId: string, result: SelectionResult): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'game_roles_selected',
      occurredAt: nowIso(),
      source: 'picker',
      // Game keys only. No usernames, no message text. See docs/PRIVACY.md.
      metadata: { picks: result.destinations.map((d) => d.pick.key) },
    };
    await this.store.record(e);
    log.info('game_roles_selected', { memberId, picks: result.destinations.length });
    return e;
  }

  async routed(guildId: string, memberId: string, result: SelectionResult): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'channel_routed',
      occurredAt: nowIso(),
      source: 'picker',
      metadata: {
        channels: result.channelIds,
        // Surfaced in the weekly numbers. A non-zero total here means members
        // are being sent to the hub because the real room is still dark.
        degraded: result.degradedCount,
      },
    };
    await this.store.record(e);
    log.info('channel_routed', {
      memberId,
      channels: result.channelIds.length,
      degraded: result.degradedCount,
    });
    return e;
  }

  /**
   * Seconds from join to routed, per member. This is the number TWO-7 is
   * judged on, so it is a query and not a stopwatch in a log line.
   */
  timeToRouteSeconds(guildId: string, memberId: string): Promise<number | null> {
    return this.store.secondsBetween(guildId, memberId, 'member_join', 'channel_routed');
  }
}
