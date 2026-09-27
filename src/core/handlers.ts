import { MESSAGE_RUNGS, nowIso, type FunnelEvent } from './events.ts';
import type { EventStore } from '../store/eventStore.ts';
import { VoiceSessionTracker } from './voiceSessions.ts';
import { log } from './log.ts';
import type { LevelingService } from '../leveling/service.ts';
import type { CommunityFactStore, CommunityChannelClass } from '../analytics/communityFacts.ts';

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
  sourceEventId?: string;
}

export interface GateClearedInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  /**
   * When they cleared it. The gateway gives us no timestamp for the transition,
   * so the live path leaves this unset and it becomes "now" - which is accurate
   * to the second because we are watching it happen. A backfill MUST NOT do the
   * same: see docs/EVENTS.md, known limit 6.
   */
  occurredAt?: string;
  /** Defaults to `gateway`. The backfill passes `backfill:member_list`. */
  source?: string;
}

export interface MessageInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  messageId?: string;
  webhookId?: string | null;
  isStaffAutomation?: boolean;
  channelId: string;
  channelClass?: CommunityChannelClass;
  captureOnly?: boolean;
  occurredAt?: string;
  onLevelUp?: (level: number) => Promise<void>;
}

export interface VoiceInput {
  guildId: string;
  memberId: string;
  isBot: boolean;
  channelId: string;
  occurredAt?: string;
  onLevelUp?: (level: number) => Promise<void>;
}

export class FunnelHandlers {
  private store: EventStore;
  private leveling: LevelingService | null;
  private communityFacts: CommunityFactStore | null;
  /**
   * Open voice sessions, so an end can carry a duration. Public because the
   * gateway adapter clears it on reconnect and the tests read it; there is no
   * state in here worth hiding.
   */
  readonly voiceSessions: VoiceSessionTracker;

  constructor(
    store: EventStore,
    leveling: LevelingService | null = null,
    communityFacts: CommunityFactStore | null = null,
  ) {
    this.store = store;
    this.leveling = leveling;
    this.communityFacts = communityFacts;
    this.voiceSessions = new VoiceSessionTracker();
  }

  async onJoin(i: JoinInput): Promise<FunnelEvent | null> {
    const occurredAt = i.occurredAt ?? nowIso();
    if (this.communityFacts) {
      await this.communityFacts.recordMemberJoin({
        guildId: i.guildId,
        actorId: i.memberId,
        isBot: i.isBot,
        occurredAt,
        sourceEventId: i.sourceEventId ?? `${i.guildId}:${i.memberId}:${occurredAt}`,
        source: i.source,
        metadata: i.inviterId ? { inviterId: i.inviterId } : undefined,
      });
    }
    if (i.isBot) return null;
    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'member_join',
      occurredAt,
      source: i.source,
      metadata: i.inviterId ? { inviterId: i.inviterId } : undefined,
    };
    const r = await this.store.record(e);
    log.info('member_join', { memberId: i.memberId, source: i.source, inserted: r.inserted });
    return e;
  }

  /**
   * A member cleared the rules gate (TOG-76).
   *
   * This lives here, next to `onJoin`, rather than in the onboarding recorder,
   * for one blunt reason: `registerOnboarding` is skipped entirely when no
   * landing channel is configured (see src/index.ts), and gate conversion is a
   * membership number, not an onboarding one. It has to be recorded on every
   * deployment, including one that posts no welcome at all.
   *
   * Once per member by idempotency key, so a `GuildMemberUpdate` burst - which
   * Discord sends for a nickname change, a role change, a timeout, anything -
   * cannot inflate it.
   */
  async onGateCleared(i: GateClearedInput): Promise<FunnelEvent | null> {
    const occurredAt = i.occurredAt ?? nowIso();
    if (this.communityFacts) {
      await this.communityFacts.recordRulesAccepted({
        guildId: i.guildId,
        actorId: i.memberId,
        isBot: i.isBot,
        occurredAt,
        sourceEventId: `${i.guildId}:${i.memberId}:rules`,
        source: i.source ?? 'gateway',
      });
    }
    if (i.isBot) return null;
    const e: FunnelEvent = {
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'gate_cleared',
      occurredAt,
      source: i.source ?? 'gateway',
    };
    const r = await this.store.record(e);
    if (r.inserted) log.info('gate_cleared', { memberId: i.memberId, source: e.source });
    return e;
  }

  /**
   * Every message updates recency. Only the first THREE are funnel milestones,
   * because AM7's text half is "3 or more messages within 7 days" and the third
   * one is where that bar is cleared (TWO-95). After the third rung is filled
   * this is a recency update and nothing else - we stop counting at the bar,
   * so a busy member costs one indexed read per message and no writes.
   */
  async onMessage(i: MessageInput): Promise<FunnelEvent | null> {
    const at = i.occurredAt ?? nowIso();
    if (this.communityFacts && i.messageId) {
      await this.communityFacts.recordMessage({
        guildId: i.guildId,
        actorId: i.memberId,
        isBot: i.isBot,
        webhookId: i.webhookId,
        isStaffAutomation: i.isStaffAutomation,
        messageId: i.messageId,
        channelId: i.channelId,
        channelClass: i.channelClass ?? 'other',
        occurredAt: at,
      });
    }
    if (i.isBot || i.webhookId || i.isStaffAutomation || i.captureOnly) return null;
    await this.store.touchActivity(i.guildId, i.memberId, at);
    if (this.leveling) {
      const award = await this.leveling.awardMessage(i.guildId, i.memberId, at, i.channelId);
      if (award.leveledUp) await i.onLevelUp?.(award.level);
    }

    // One message fills at most one rung: the lowest empty one. The loop is for
    // the two-process race - the bot and the website can both read the same
    // empty rung, and the idempotency key lets exactly one of them have it.
    // Without the retry the loser drops a message that should have advanced the
    // ladder, which under-counts AM7. It cannot spin: every iteration either
    // fills a rung or finds the ladder full.
    for (let attempt = 0; attempt < MESSAGE_RUNGS.length; attempt++) {
      const rung = await this.store.nextMessageRung(i.guildId, i.memberId, at);
      if (!rung) return null;

      const e: FunnelEvent = {
        guildId: i.guildId,
        memberId: i.memberId,
        eventType: rung,
        occurredAt: at,
        source: `channel:${i.channelId}`,
      };
      const r = await this.store.record(e);
      if (r.inserted) {
        log.info(rung, { memberId: i.memberId, channelId: i.channelId });
        return e;
      }
    }
    return null;
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
    const at = i.occurredAt ?? nowIso();
    let communitySessionKey: string | undefined;
    if (this.communityFacts) {
      communitySessionKey = await this.communityFacts.recordVoiceStarted({
        guildId: i.guildId,
        actorId: i.memberId,
        isBot: i.isBot,
        channelId: i.channelId,
        occurredAt: at,
      });
    }
    if (i.isBot) return null;
    await this.store.touchActivity(i.guildId, i.memberId, at);

    await this.store.record({
      guildId: i.guildId,
      memberId: i.memberId,
      eventType: 'voice_session_start',
      occurredAt: at,
      source: `channel:${i.channelId}`,
    });
    this.voiceSessions.start(i.guildId, i.memberId, i.channelId, at, communitySessionKey);
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
    const at = i.occurredAt ?? nowIso();
    const open = this.voiceSessions.end(i.guildId, i.memberId);

    // Clamp at zero. The start timestamp and this one can come from different
    // clocks, and a negative duration in a column people will average is worse
    // than a zero.
    const durationSeconds = open
      ? Math.max(0, Math.round((Date.parse(at) - Date.parse(open.startedAt)) / 1000))
      : null;

    if (this.communityFacts) {
      const sessionKey = open?.sessionKey ?? `${i.guildId}:${i.memberId}:unknown-start:${at}:${i.channelId}`;
      await this.communityFacts.recordVoiceEnded({
        guildId: i.guildId,
        actorId: i.memberId,
        isBot: i.isBot,
        sessionKey,
        channelId: open?.channelId ?? i.channelId,
        occurredAt: at,
        startedAt: open?.startedAt ?? null,
        durationSeconds,
      });
    }
    if (i.isBot) return null;

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
    if (this.leveling && durationSeconds !== null) {
      const award = await this.leveling.awardVoice(
        i.guildId,
        i.memberId,
        durationSeconds,
        at,
        open?.channelId ?? i.channelId,
      );
      if (award.leveledUp) await i.onLevelUp?.(award.level);
    }
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

  /**
   * A member left the server (TOG-6122).
   *
   * A server-leave is also a voice-leave: Discord drops them from voice at
   * the same instant, but no VoiceStateUpdate follows, so without this the
   * tracker entry stays open (leaking until the next ShardResume clear) and
   * the member gets NO voice_session_end row at all. Worse, a later voice
   * leave for a rejoined session reuses the stale start and invents a
   * duration spanning the member's absence.
   *
   * The end is credited to the open channel with the duration measured to
   * leave time. `isBot` is unknown on this path - the gateway hands
   * GuildMemberRemove no reliable bot flag at this layer - so the voice half
   * is read from the tracker, not from a parameter: the only session we can
   * close is one we saw start, and starts are only recorded for non-bots.
   */
  async onLeave(
    guildId: string,
    memberId: string,
    occurredAt?: string,
    opts: { isBot?: boolean } = {},
  ): Promise<FunnelEvent | null> {
    const at = occurredAt ?? nowIso();
    // Close any open voice session first, while the member row still reads
    // pre-leave: the end proves presence up to the leave instant, and the
    // member_leave row below is what marks them gone. No open session means
    // no write - this is a no-op for the overwhelmingly common case, and a
    // repeated GuildMemberRemove is idempotent: the second call peeks null.
    const open = this.voiceSessions.peek(guildId, memberId);
    if (open) {
      await this.onVoiceLeave({
        guildId,
        memberId,
        isBot: opts.isBot ?? false,
        channelId: open.channelId,
        occurredAt: at,
      });
    }
    const e: FunnelEvent = {
      guildId,
      memberId,
      eventType: 'member_leave',
      occurredAt: at,
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
   *
   * Called by the go.two.gg redirect service (src/redirect/, TOG-116). The
   * source is `invite:<code>` - the same string joins are attributed to - so
   * clicks and joins for one code line up with no special case downstream.
   *
   * `campaign` records WHERE the link was posted, which is the question this
   * exists to answer: two campaigns can point at one invite code, and only the
   * campaign tells reddit apart from the Twitch panel. It is a slug we chose,
   * never anything about the person clicking. See docs/PRIVACY.md.
   */
  async onInviteClick(
    guildId: string,
    code: string,
    opts: { occurredAt?: string; campaign?: string; dedupeToken?: string } = {},
  ): Promise<FunnelEvent> {
    const e: FunnelEvent = {
      guildId,
      memberId: null,
      eventType: 'invite_click',
      occurredAt: opts.occurredAt ?? nowIso(),
      source: `invite:${code}`,
      metadata: opts.campaign ? { campaign: opts.campaign } : undefined,
      dedupeToken: opts.dedupeToken,
    };
    await this.store.record(e);
    log.info('invite_click', { code, campaign: opts.campaign ?? null });
    return e;
  }
}
