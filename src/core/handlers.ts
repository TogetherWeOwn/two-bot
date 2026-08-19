import { nowIso, type FunnelEvent } from './events.ts';
import type { EventStore } from '../store/eventStore.ts';
import { log } from './log.ts';

/**
 * Framework-free funnel logic.
 *
 * Nothing in this file imports discord.js. The adapter in src/discord/ turns
 * gateway events into these plain calls, which means the funnel rules can be
 * tested without a network, a token, or a server.
 */

export interface JoinInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  /** Attribution from the invite tracker, e.g. 'invite:aB3xY9'. */
  source: string;
  occurredAt?: string;
  inviterId?: string | null;
}

export interface MessageInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  channelId: string;
  occurredAt?: string;
}

export interface VoiceInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  channelId: string;
  occurredAt?: string;
}

export class FunnelHandlers {
  private store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  onJoin(i: JoinInput): FunnelEvent | null {
    if (i.isBot) return null;
    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'member_join',
      occurredAt: i.occurredAt ?? nowIso(),
      source: i.source,
      metadata: i.inviterId ? { inviterId: i.inviterId } : undefined,
    };
    const r = this.store.record(e);
    log.info('member_join', { memberId: i.memberId, source: i.source, inserted: r.inserted });
    return e;
  }

  onMessage(i: MessageInput): FunnelEvent | null {
    if (i.isBot) return null;
    const at = i.occurredAt ?? nowIso();
    // Every message updates recency; only the first one is a funnel milestone.
    this.store.touchActivity(i.guildId, i.memberId, at);
    if (this.store.hasEvent(i.guildId, i.memberId, 'first_message')) return null;

    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'first_message',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    };
    this.store.record(e);
    log.info('first_message', { memberId: i.memberId, channelId: i.channelId });
    return e;
  }

  onVoiceJoin(i: VoiceInput): FunnelEvent | null {
    if (i.isBot) return null;
    const at = i.occurredAt ?? nowIso();
    this.store.touchActivity(i.guildId, i.memberId, at);
    if (this.store.hasEvent(i.guildId, i.memberId, 'first_voice_session')) return null;

    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'first_voice_session',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    };
    this.store.record(e);
    log.info('first_voice_session', { memberId: i.memberId, channelId: i.channelId });
    return e;
  }

  onLeave(guildId: string, memberId: string, occurredAt?: string): FunnelEvent {
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'member_leave',
      occurredAt: occurredAt ?? nowIso(),
      source: 'gateway',
    };
    this.store.record(e);
    return e;
  }

  /**
   * Invite click. Discord cannot report these directly - a click only becomes
   * visible to us as a use-count delta at join time. This entry point exists so
   * a tracking redirect (a short link we control) can post clicks in, which is
   * the only honest way to measure the top of the funnel.
   */
  onInviteClick(guildId: string, code: string, occurredAt?: string): FunnelEvent {
    const e: FunnelEvent = {
      guildId,
      memberId: null,
      eventType: 'invite_click',
      occurredAt: occurredAt ?? nowIso(),
      source: `invite:${code}`,
    };
    this.store.record(e);
    return e;
  }
}
