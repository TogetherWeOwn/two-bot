import { nowIso, type FunnelEvent } from './events.ts';
import type { EventStore } from '../store/eventStore.ts';
import { VoiceSessionTracker } from './voiceSessions.ts';
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
  /**
   * Open voice sessions, so an end can carry a duration. Public because the
   * gateway adapter clears it on reconnect and the tests read it; there is no
   * state in here worth hiding.
   */
  readonly voiceSessions: VoiceSessionTracker;

  constructor(store: EventStore) {
    this.store = store;
    this.voiceSessions = new VoiceSessionTracker();
  }

  async onJoin(i: JoinInput): Promise<FunnelEvent | null> {
    if (i.isBot) return null;
    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'member_join',
      occurredAt: i.occurredAt ?? nowIso(),
      source: i.source,
      metadata: i.inviterId ? { inviterId: i.inviterId } : undefined,
    };
    const r = await this.store.record(e);
    log.info('member_join', { memberId: i.memberId, source: i.source, inserted: r.inserted });
    return e;
  }

  async onMessage(i: MessageInput): Promise<FunnelEvent | null> {
    if (i.isBot) return null;
    const at = i.occurredAt ?? nowIso();
    // Every message updates recency; only the first one is a funnel milestone.
    await this.store.touchActivity(i.guildId, i.memberId, at);
    if (await this.store.hasEvent(i.guildId, i.memberId, 'first_message')) return null;

    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'first_message',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    };
    await this.store.record(e);
    log.info('first_message', { memberId: i.memberId, channelId: i.channelId });
    return e;
  }

  /**
   * A member entered a voice channel.
   *
   * Two writes, deliberately separate:
   *   - `voice_session_start`, every single time (TOG-99). This is the row that
   *     makes "how often" and "what time of day" answerable at all.
   *   - `first_voice_session`, once per member, unchanged.
   *
   * The return value is still the first_voice_session event or null, so that
   * every existing caller and test means what it meant before.
   */
  async onVoiceJoin(i: VoiceInput): Promise<FunnelEvent | null> {
    if (i.isBot) return null;
    const at = i.occurredAt ?? nowIso();
    await this.store.touchActivity(i.guildId, i.memberId, at);

    await this.store.record({
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'voice_session_start',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    });
    this.voiceSessions.start(i.guildId, i.memberId, i.channelId, at);
    log.info('voice_session_start', { memberId: i.memberId, channelId: i.channelId });

    if (await this.store.hasEvent(i.guildId, i.memberId, 'first_voice_session')) return null;

    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'first_voice_session',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    };
    await this.store.record(e);
    log.info('first_voice_session', { memberId: i.memberId, channelId: i.channelId });
    return e;
  }

  /**
   * A member left a voice channel (TOG-99).
   *
   * The end is credited to the channel the session was OPENED in, not the one
   * the gateway happens to name on the way out - on a move from A to B the
   * adapter calls this with A, but if we never saw the start we fall back to
   * whatever the caller gives us rather than inventing a channel.
   */
  async onVoiceLeave(i: VoiceInput): Promise<FunnelEvent | null> {
    if (i.isBot) return null;
    const at = i.occurredAt ?? nowIso();
    const open = this.voiceSessions.end(i.guildId, i.memberId);

    // Clamp at zero. The start timestamp and this one can come from different
    // clocks, and a negative duration in a column people will average is worse
    // than a zero.
    const durationSeconds = open
      ? Math.max(0, Math.round((Date.parse(at) - Date.parse(open.startedAt)) / 1000))
      : null;

    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'voice_session_end',
      occurredAt: at,
      source: `channel:${open?.channelId ?? i.channelId}`,
      metadata: {
        // False means the bot came up mid-session. Filter on it before
        // averaging durations - see src/core/voiceSessions.ts.
        startKnown: open !== null,
        startedAt: open?.startedAt ?? null,
        durationSeconds,
      },
    };
    await this.store.record(e);
    // Leaving at T proves they were still there at T, so recency moves too.
    await this.store.touchActivity(i.guildId, i.memberId, at);
    log.info('voice_session_end', {
      memberId: i.memberId,
      channelId: e.source,
      durationSeconds,
      startKnown: open !== null,
    });
    return e;
  }

  async onLeave(guildId: string, memberId: string, occurredAt?: string): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'member_leave',
      occurredAt: occurredAt ?? nowIso(),
      source: 'gateway',
    };
    await this.store.record(e);
    return e;
  }

  /**
   * Invite click. Discord cannot report these directly - a click only becomes
   * visible to us as a use-count delta at join time. This entry point exists so
   * a tracking redirect (a short link we control) can post clicks in, which is
   * the only honest way to measure the top of the funnel.
   */
  async onInviteClick(guildId: string, code: string, occurredAt?: string): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId: null,
      eventType: 'invite_click',
      occurredAt: occurredAt ?? nowIso(),
      source: `invite:${code}`,
    };
    await this.store.record(e);
    return e;
  }
}
