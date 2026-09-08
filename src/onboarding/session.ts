/**
 * Session routing: the roleless onboarding accepted on TOG-1654 (2026-09-08).
 *
 * The legacy flow (catalog.ts + flow.ts) grants permanent game roles. The
 * owner rejected that launch model: the accepted clean-slate structure has no
 * game-interest roles at all, because a role whose only job is to exist has no
 * job. What replaces it here is *routing* - a new member is asked what they
 * want to do right now and handed a link to the room where that happens. No
 * role is created, granted, or removed by anything in this file.
 *
 * Same split as flow.ts: this file decides, the adapter in
 * src/discord/sessionWelcome.ts makes it happen. Everything here is pure, so
 * the TOG-1654 acceptance ("both options, zero role delta, idempotent
 * re-selection, invalid selection retried") is testable with no token.
 *
 * Channel ids come from src/redesign/clean-slate.ts via the catalog below, not
 * from this file, so provisioning and routing can never drift apart.
 */

import { nowIso, type FunnelEvent } from '../core/events.ts';
import type { EventStore } from '../store/eventStore.ts';
import { log } from '../core/log.ts';

/**
 * Where each picker option sends you. Ids are the TWO Staging clean-slate
 * channels (src/redesign/clean-slate.ts); `looking-to-play` and the Lobby are
 * the two active destinations the accepted brief names. The same constants are
 * reused by the main-guild rollout when it comes, so the demo and production
 * answer "where does this send me" identically.
 *
 * KEYS ARE STABLE: they go in the select-menu value and in event metadata, and
 * a panel posted in a channel outlives every bot restart.
 */
export interface SessionPick {
  key: 'find-players' | 'join-voice';
  label: string;
  description: string;
  emoji: string;
  /** Where this option lands you. Must be visible to a plain member. */
  channelId: string;
}

export const LOOKING_TO_PLAY_CHANNEL_ID = '1546211377847337020';
export const LOBBY_VOICE_CHANNEL_ID = '1546211378430345286';

export const SESSION_PICKS: SessionPick[] = [
  {
    key: 'find-players',
    label: 'Find people to play with',
    description: 'Post the game, your platform and a start time.',
    emoji: '🎲',
    channelId: LOOKING_TO_PLAY_CHANNEL_ID,
  },
  {
    key: 'join-voice',
    label: 'Join voice now',
    description: 'The Lobby is open - see who is around.',
    emoji: '🔊',
    channelId: LOBBY_VOICE_CHANNEL_ID,
  },
];

export function pickByKey(key: string): SessionPick | undefined {
  return SESSION_PICKS.find((p) => p.key === key);
}

/** The select-menu custom id. Static: the panel outlives every restart. */
export const SESSION_SELECT_ID = 'two:onboarding:session';

export function sessionWelcomeText(memberMention: string): string {
  return [
    `${memberMention} you're in - that was the whole application.`,
    '',
    'What do you want to do right now? Pick below and I will point you at the right room. You can change your mind any time - this picks a destination for tonight, not a label forever.',
  ].join('\n');
}

/**
 * Turn "member submitted these keys" into "acknowledge this, link that".
 *
 * Pure. `visible` is supplied by the adapter from Discord's own permission
 * check - we never hand someone a link to a room they cannot open.
 *
 * The invalid/stale contract from TOG-1654: any key we do not know is dropped
 * from the plan, reported in `unknownKeys`, and the caller must offer a retry.
 * An empty or fully-unknown submission is NOT routed anywhere - the ack says
 * so and points back at the picker.
 */
export interface SessionPlan {
  picks: SessionPick[];
  /** Destinations the member can actually open, deduped, in catalog order. */
  channelIds: string[];
  /** Destinations skipped because the member cannot view them right now. */
  unavailable: SessionPick[];
  unknownKeys: string[];
}

export function planSession(
  keys: string[],
  visible: (channelId: string) => boolean,
): SessionPlan {
  const picks: SessionPick[] = [];
  const unknownKeys: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const p = pickByKey(k);
    if (!p) {
      unknownKeys.push(k);
      continue;
    }
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    picks.push(p);
  }

  const channelIds: string[] = [];
  const unavailable: SessionPick[] = [];
  for (const p of picks) {
    if (visible(p.channelId)) {
      if (!channelIds.includes(p.channelId)) channelIds.push(p.channelId);
    } else {
      unavailable.push(p);
    }
  }
  return { picks, channelIds, unavailable, unknownKeys };
}

/**
 * The ephemeral acknowledgement. One per submission, visible only to the
 * person who clicked. Re-selecting the same option produces byte-identical
 * text - that is the idempotency the acceptance asks for, and it is why this
 * is a pure function rather than something built inline in the interaction
 * handler.
 */
export function sessionAckText(plan: SessionPlan): string {
  if (plan.unknownKeys.length && plan.picks.length === 0) {
    return [
      "That option is gone or stale - the panel was probably replaced by a newer one.",
      'Nothing was changed. Open the picker again and choose afresh.',
    ].join('\n');
  }
  const links = plan.channelIds.map((id) => `<#${id}>`).join(' and ');
  if (!links) {
    return [
      'Those rooms are not open to you right now.',
      'Nothing was changed - try again in a moment, or say hello in the welcome channel and someone will grab you.',
    ].join('\n');
  }
  return `On it - head to ${links}.`;
}

/**
 * The goodbye posted when a member leaves. Plain on purpose: no guilt, no
 * retention pitch. What MEE6 sells here is the *notice*, not the copy - the
 * interesting half (who left, when, how long they stayed) already lands in the
 * funnel as `member_leave`; this just makes it visible to humans.
 */
export function goodbyeText(username: string, daysInGuild: number | null): string {
  const stay =
    daysInGuild === null
      ? ''
      : daysInGuild <= 0
        ? ' (was here less than a day)'
        : ` (was here ${daysInGuild} day${daysInGuild === 1 ? '' : 's'})`;
  return `**${username}** left the server${stay}. Their messages and voice history stay on the books.`;
}

/** Days between join and leave, floored; null when the join is unknown. */
export function daysInGuild(joinedAt: string | null, leftAtIso: string): number | null {
  if (!joinedAt) return null;
  const ms = Date.parse(leftAtIso) - Date.parse(joinedAt);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

/**
 * Records session routing. Deliberately reuses the existing funnel events
 * rather than inventing parallel ones: `onboarding_prompted` (the welcome went
 * out), `channel_routed` (a selection produced destinations). The one legacy
 * event NOT emitted is `game_roles_selected` - there are no roles, so there is
 * no selection to record, and a row with an empty picks list would read as a
 * bug in the weekly numbers.
 */
export class SessionRecorder {
  private store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  async prompted(guildId: string, memberId: string, channelId: string): Promise<void> {
    await this.store.record({
      guildId,
      memberId,
      eventType: 'onboarding_prompted',
      occurredAt: nowIso(),
      source: `channel:${channelId}`,
    });
    log.info('session_prompted', { memberId, channelId });
  }

  async routed(
    guildId: string,
    memberId: string,
    plan: SessionPlan,
  ): Promise<void> {
    await this.store.record({
      guildId,
      memberId,
      eventType: 'channel_routed',
      occurredAt: nowIso(),
      source: 'session-picker',
      metadata: {
        picks: plan.picks.map((p) => p.key),
        channels: plan.channelIds,
        unavailable: plan.unavailable.map((p) => p.key),
      },
    });
    log.info('session_routed', {
      memberId,
      channels: plan.channelIds.length,
      unavailable: plan.unavailable.length,
    });
  }
}
