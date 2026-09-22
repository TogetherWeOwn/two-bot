import { createHash } from 'node:crypto';
import { Client, GatewayIntentBits, Events, Options, Partials, type Guild, type GuildMember } from 'discord.js';
import { nowIso } from '../core/events.ts';
import type { FunnelHandlers } from '../core/handlers.ts';
import type { InviteTracker, InviteState } from '../core/inviteTracker.ts';
import type { ExpectedJoins } from '../core/expectedJoins.ts';
import type { RaidWatch } from '../analytics/raidWatch.ts';
import type { RaidAnnouncer } from './raidAlert.ts';
import { log } from '../core/log.ts';
import { applyLevelRoles } from '../leveling/discord.ts';
import type { LevelingService } from '../leveling/service.ts';
import type { AutomodService } from '../automod/service.ts';
import { AutomodProcessingError } from '../automod/types.ts';
import type { JoinRiskScorer } from '../moderation/containment.ts';
import type { AuditSink } from '../audit/service.ts';
import { moderationAuditEvent, rawMessageAuditEvent } from '../audit/discordEvents.ts';
import type { DiscordOnboardingRota } from './onboardingRota.ts';

/**
 * Intents we ask Discord for, and why. Keep this list minimal - each one is a
 * permission we have to justify, and GuildMembers/MessageContent are privileged.
 *
 *   Guilds              - required for any guild event at all
 *   GuildMembers        - member_join / member_leave        (PRIVILEGED)
 *   GuildMessages       - first_message + tickets + automod events
 *   MessageContent      - ticket transcripts and enabled automod (PRIVILEGED)
 *   GuildMessageReactions - reaction-role add/remove        (metadata only)
 *   GuildVoiceStates    - first_voice_session + voice_session_start/end
 *   GuildInvites        - invite create/delete for attribution
 *   GuildModeration     - authoritative destructive-action audit entries
 *
 * MessageContent is required for MEE6-equivalent ticket export. Enabled automod
 * also inspects public messages in memory but never stores or logs their content.
 * Ticket retention and both erasure boundaries are documented in docs/PRIVACY.md.
 */
const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
];

export function intents(_automodEnabled = process.env.TWO_AUTOMOD === '1'): GatewayIntentBits[] {
  return [...BASE_INTENTS];
}

export const INTENTS = intents();
/** Required for reaction removals and old panel messages absent from cache. */
export const PARTIALS = [Partials.Message, Partials.Reaction, Partials.User];

/** Message content is already required by tickets/automod on current main. */
export function intentsFor(_env: NodeJS.ProcessEnv = process.env): GatewayIntentBits[] {
  return [...INTENTS];
}

export interface BotDeps {
  handlers: FunnelHandlers;
  invites: InviteTracker;
  community?: {
    humanChannelIds: ReadonlySet<string>;
    welcomeChannelIds: ReadonlySet<string>;
  };
  /**
   * Join-burst detection (TWO-56). Optional: leave it out and joins are
   * recorded exactly as before, which is what every existing test does.
   */
  raid?: { watch: RaidWatch; announce: RaidAnnouncer };
  /**
   * One-click join attribution (docs/INTERNAL_ACTIONS.md §7). The same
   * instance guild.add_member writes its "expect this member" note into.
   * Optional: leave it out and every join is attributed by invite diff alone,
   * which is what every existing test does.
   */
  expectedJoins?: ExpectedJoins;
  leveling?: LevelingService;
  /**
   * Whether an earned reward role is actually written to the member. Defaults
   * to true; session onboarding passes false so XP and `/rank` keep working
   * while `member.roles.add` is never reached. See
   * `levelRoleWritesForOnboardingMode`.
   */
  levelRoleWrites?: boolean;
  automod?: { service: AutomodService; guildId: string };
  /** Flag-only join risk scoring. It never changes or removes the member. */
  joinRisk?: JoinRiskScorer;
  /** Metadata-only staff audit. Optional so the funnel remains independently usable. */
  audit?: AuditSink;
  /** Audit gateway events are retained only for this configured guild. */
  auditGuildId?: string | null;
  /**
   * Secret keying the moderation-service correlation MAC (TOG-2223 #8). Null
   * means moderation markers are never trusted, even if one is present -
   * `parseModerationAuditReason` refuses to verify without it.
   */
  moderationAuditSecret?: string | null;
  onboardingRota?: DiscordOnboardingRota;
  /**
   * Fail-closed staging restart containment (TOG-3903). When set, drops the
   * real-member audit metadata writes (member_update, voice_*, message_*,
   * moderation_action) BEFORE the durable store insert, while leaving the
   * ephemeral `log.info('operational_audit', …)` line intact. Rota notices
   * are already refused at `record()`; the registry duty roster of
   * `member_update` rows is what would otherwise ingest every real member.
   * Production default is undefined (no filtering).
   */
  stagingAuditMemberFilter?: (event: {
    kind: string;
    actorId?: string | null;
    targetId?: string | null;
  }) => boolean;
}

export function createClient(automodEnabled = process.env.TWO_AUTOMOD === '1'): Client {
  return new Client({
    intents: intentsFor(),
    partials: automodEnabled
      ? [...new Set([...PARTIALS, Partials.Channel])]
      : PARTIALS,
    ...(automodEnabled
      ? {
          // Message content must not survive the event handler in discord.js's
          // default 200-message-per-channel cache.
          makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
        }
      : {}),
  });
}

async function snapshotInvites(guild: Guild, invites: InviteTracker): Promise<string[]> {
  try {
    const fetched = await guild.invites.fetch();
    const states: InviteState[] = fetched.map((i) => ({
      code: i.code,
      uses: i.uses ?? 0,
      inviterId: i.inviter?.id ?? null,
      channelId: i.channel?.id ?? null,
    }));
    // `return await`, not a bare `return`: the store became async with the
    // Postgres migration, and a returned-but-not-awaited promise rejects
    // outside this try/catch. That turns a recoverable "could not read
    // invites" into an unhandled rejection, which index.ts answers by exiting
    // the process - on every join.
    return await invites.diffAndStore(guild.id, states);
  } catch (err) {
    // Missing ManageGuild permission is the usual cause. Joins still get
    // recorded, just with source 'unknown'.
    log.error('invite_snapshot_failed', { guildId: guild.id, err: String(err) });
    return [];
  }
}

/** Wire gateway events to the framework-free handlers. */
export function registerHandlers(client: Client, deps: BotDeps): void {
  const {
    handlers, invites, community, raid, expectedJoins, leveling, automod, joinRisk, audit, auditGuildId,
    moderationAuditSecret,
  } = deps;
  const levelRoleWrites = deps.levelRoleWrites ?? true;

  /**
   * The only place a level-up turns into a role write. Both the message and the
   * voice path go through here, so session mode is suppressed in exactly one
   * spot rather than at each call site.
   */
  const levelUpRoleHook = (member: GuildMember | null | undefined) =>
    leveling && member && levelRoleWrites
      ? (level: number) => applyLevelRoles(member, leveling, level)
      : undefined;

  const auditSafely = (event: Parameters<NonNullable<BotDeps['audit']>['record']>[0]) => {
    if (!audit || (auditGuildId && event.guildId !== auditGuildId)) return;
    if (deps.stagingAuditMemberFilter && !deps.stagingAuditMemberFilter(event)) return;
    void audit.record(event).catch(() => {
      log.error('operational_audit_failed', {
        entryId: event.entryId,
        classification: 'audit_record_failed',
      });
    });
  };

  client.once(Events.ClientReady, async (c) => {
    log.info('ready', { user: c.user.tag, guilds: c.guilds.cache.size });
    for (const guild of c.guilds.cache.values()) {
      await snapshotInvites(guild, invites);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const observedAt = nowIso();
    const joining = (async () => {
      // Snapshot regardless of how this member arrived, so the counters stay
      // current for the next organic join. A one-click join consumes no invite,
      // so for it the diff legitimately shows nothing grew.
      const grew = await snapshotInvites(member.guild, invites);

      // The web path's expected join beats the invite diff: a code that grew in
      // the same window belongs to some other join's event.
      const expected = expectedJoins?.consume(member.guild.id, member.id) ?? null;
      const source = expected ?? invites.attribute(grew, !!member.guild.vanityURLCode);
      const inviterId =
        !expected && grew.length === 1 ? await invites.inviterFor(member.guild.id, grew[0]) : null;
      await handlers.onJoin({
        guildId: member.guild.id,
        memberId: member.id,
        isBot: !!member.user?.bot,
        source,
        inviterId,
        occurredAt: member.joinedAt?.toISOString(),
        sourceEventId: `${member.guild.id}:${member.id}:${member.joinedAt?.toISOString() ?? 'observed'}`,
      });
      return source;
    })();
    // Reserve before the first await; the welcome listener runs concurrently.
    void deps.onboardingRota?.join(member, joining, observedAt);
    const source = await joining;

    // Someone who arrives with the gate already cleared - they accepted the
    // rules on the invite screen before the join landed - converted instantly.
    // Recording it here as well as on the update keeps the denominator honest:
    // otherwise the fastest members are the ones missing from the numerator.
    if (!member.pending) {
      await handlers.onGateCleared({
        guildId: member.guild.id,
        memberId: member.id,
        isBot: !!member.user?.bot,
        occurredAt: member.joinedAt?.toISOString(),
      });
    }

    // Burst check last, and never at the expense of the join record: an alert
    // that throws must not lose the event it was alerting about.
    if (raid && !member.user?.bot) {
      try {
        const alert = raid.watch.observe(
          member.guild.id,
          member.id,
          member.joinedAt?.getTime() ?? Date.now(),
        );
        if (alert) await raid.announce(alert);
      } catch (err) {
        log.error('raid_watch_failed', { guildId: member.guild.id, err: String(err) });
      }
    }
    if (joinRisk && !member.user?.bot) {
      try {
        await joinRisk.observe(member, source);
      } catch (err) {
        log.error('join_risk_failed', { guildId: member.guild.id, memberId: member.id, err: String(err) });
      }
    }
  });

  // The rules gate (TOG-76). `pending` flips true -> false the moment a member
  // accepts the screening rules, and that transition is the only signal Discord
  // ever gives that somebody actually got into the server.
  //
  // Deliberately here and not in src/discord/onboarding.ts, which already
  // watches the same transition to post its welcome: that file is not
  // registered at all when no landing channel is configured, and the funnel
  // number must not depend on whether we happen to be greeting people.
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (oldMember.pending === true && newMember.pending === false) {
      void deps.onboardingRota?.gateCleared(newMember, nowIso());
    }
    if (oldMember.pending && !newMember.pending) {
      await handlers.onGateCleared({
        guildId: newMember.guild.id,
        memberId: newMember.id,
        isBot: !!newMember.user?.bot,
      });
    }

    // A partial old member has no trustworthy role/nickname baseline. Skipping
    // is safer than reporting every current role as newly granted.
    if (oldMember.partial) return;
    const oldRoles = roleIds(oldMember);
    const newRoles = roleIds(newMember);
    const addedRoleIds = [...newRoles].filter((id) => !oldRoles.has(id)).sort();
    const removedRoleIds = [...oldRoles].filter((id) => !newRoles.has(id)).sort();
    const nicknameChanged = oldMember.nickname !== newMember.nickname;
    if (!nicknameChanged && addedRoleIds.length === 0 && removedRoleIds.length === 0) return;

    const occurredAt = nowIso();
    const changeDigest = createHash('sha256')
      .update(JSON.stringify({ nicknameChanged, addedRoleIds, removedRoleIds }))
      .digest('base64url')
      .slice(0, 16);
    auditSafely({
      // Discord supplies no id for this gateway event. The occurrence timestamp
      // preserves a later identical transition; the bounded digest distinguishes
      // simultaneous deltas without embedding an unbounded role list in the key.
      entryId: `member-update:${newMember.guild.id}:${newMember.id}:${occurredAt}:${changeDigest}`,
      kind: 'member_update',
      channel: 'audit',
      guildId: newMember.guild.id,
      occurredAt,
      targetId: newMember.id,
      metadata: { nicknameChanged, addedRoleIds, removedRoleIds },
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await handlers.onLeave(member.guild.id, member.id);
  });

  const inspectAutomod = async (msg: {
    guildId: string | null;
    channelId: string;
    id: string;
    author: { id: string; bot: boolean } | null;
    member: { roles: { cache: Map<string, unknown> } } | null;
    content: string;
    mentions: { users: { keys(): IterableIterator<string> } };
    attachments: { values(): IterableIterator<{ name: string | null }> };
  }, observedTimestamp: number): Promise<boolean | null> => {
    if (!automod || !msg.guildId || msg.guildId !== automod.guildId || !msg.author) return false;
    try {
      const result = await automod.service.inspect({
        guildId: msg.guildId,
        channelId: msg.channelId,
        messageId: msg.id,
        authorId: msg.author.id,
        authorIsBot: msg.author.bot,
        roleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
        content: msg.content,
        mentionedUserIds: [...msg.content.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]),
        attachmentNames: [...msg.attachments.values()].flatMap((item) => item.name ? [item.name] : []),
        observedTimestamp,
      });
      return result.matched;
    } catch (err) {
      log.error('automod_inspection_failed', {
        guildId: msg.guildId,
        channelId: msg.channelId,
        messageId: msg.id,
        err: String(err),
      });
      return err instanceof AutomodProcessingError && err.matched ? true : null;
    }
  };

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guildId) return; // ignore DMs
    const occurredAt = new Date(msg.createdTimestamp).toISOString();
    const channelClass = community?.welcomeChannelIds.has(msg.channelId)
      ? 'welcome'
      : community?.humanChannelIds.has(msg.channelId)
        ? 'human'
        : 'other';
    const inspection = inspectAutomod(msg, msg.createdTimestamp);
    // Reserve this subject's place before automod/funnel I/O can let a reply
    // overtake its action. The observer writes only after a definite accepted
    // result, and its chain never gates the automation event below: a stuck
    // observation for one member must not stop unrelated automations.
    void deps.onboardingRota?.message(msg, inspection);
    const automodRejected = await inspection;
    if (automodRejected) {
      // Automod-rejected messages still belong in raw ingestion and exact
      // reconciliation, but they must not award XP or advance funnel activity.
      // Keep this call behind the scorecard feature seam: existing handler
      // doubles do not implement raw capture, and production has no fact store
      // to receive it while community capture is disabled.
      if (community) {
        await handlers.onMessage({
          guildId: msg.guildId,
          memberId: msg.author.id,
          isBot: msg.author.bot,
          messageId: msg.id,
          webhookId: msg.webhookId,
          channelId: msg.channelId,
          channelClass,
          captureOnly: true,
          occurredAt,
        });
      }
      return;
    }
    await handlers.onMessage({
      guildId: msg.guildId,
      memberId: msg.author.id,
      isBot: msg.author.bot,
      messageId: msg.id,
      webhookId: msg.webhookId,
      channelId: msg.channelId,
      channelClass,
      occurredAt,
      onLevelUp: levelUpRoleHook(msg.member),
    });
    // Downstream message automations run once automod accepts the event and
    // the ordinary funnel/leveling path has completed. The measurement observer
    // is deliberately not awaited: it orders same-subject writes on its own
    // per-subject chain and must never stall the automation event. A private
    // event keeps those listeners from racing the primary MessageCreate handler.
    client.emit('automationMessageAccepted' as never, msg as never);
  });

  client.on(Events.Raw, (packet, shardId) => {
    const event = rawMessageAuditEvent(packet as never, shardId);
    if (event) auditSafely(event);
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    if (!newMessage.guildId) return;
    try {
      const msg = newMessage.partial ? await newMessage.fetch() : newMessage;
      if (!msg.author) return;
      await inspectAutomod(msg, Date.now());
    } catch (err) {
      log.error('automod_edit_fetch_failed', {
        guildId: newMessage.guildId,
        channelId: newMessage.channelId,
        messageId: newMessage.id,
        err: String(err),
      });
    }
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    // Discord fires this for mute, deafen, camera and go-live too. Only a
    // change of channel is a session boundary.
    if (oldState.channelId === newState.channelId) return;
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;
    const memberId = newState.id ?? oldState.id;
    const isBot = !!(newState.member ?? oldState.member)?.user?.bot;

    // One timestamp for both halves. On a move from A to B the end and the
    // start are the same instant, and taking nowIso() twice would make the
    // pair look like a gap.
    const at = nowIso();
    const voiceKind = oldState.channelId
      ? newState.channelId
        ? 'voice_move'
        : 'voice_leave'
      : 'voice_join';
    auditSafely({
      entryId: `${voiceKind}:${guild.id}:${memberId}:${oldState.channelId ?? 'none'}:${newState.channelId ?? 'none'}:${at}`,
      kind: voiceKind,
      channel: 'voice',
      guildId: guild.id,
      occurredAt: at,
      targetId: memberId,
      sourceChannelId: oldState.channelId,
      destinationChannelId: newState.channelId,
      metadata: { isBot },
    });

    // End first, so a move reads as end(A) then start(B) in occurred order.
    if (oldState.channelId) {
      const member = oldState.member ?? newState.member;
      await handlers.onVoiceLeave({
        guildId: guild.id,
        memberId,
        isBot,
        channelId: oldState.channelId,
        occurredAt: at,
        onLevelUp: levelUpRoleHook(member),
      });
    }
    if (newState.channelId) {
      await handlers.onVoiceJoin({
        guildId: guild.id,
        memberId,
        isBot,
        channelId: newState.channelId,
        occurredAt: at,
      });
    }
  });

  // A reconnect means we may have missed leaves while we were away, so every
  // session we think is open is now unproven. Dropping them costs the duration
  // on those sessions (they end with startKnown: false) and is the only
  // alternative to reporting a duration that silently includes the outage.
  client.on(Events.ShardResume, () => {
    const dropped = handlers.voiceSessions.openCount;
    handlers.voiceSessions.clear();
    if (dropped) log.info('voice_sessions_dropped_on_resume', { dropped });
  });

  client.on(Events.InviteCreate, async (invite) => {
    if (invite.guild) await snapshotInvites(invite.guild as Guild, invites);
  });

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    const event = moderationAuditEvent(entry, guild.id, client.user?.id, moderationAuditSecret);
    if (event) auditSafely(event);
  });

  client.on(Events.Error, (err) => log.error('client_error', { err: String(err) }));
}

function roleIds(member: { guild: { id: string }; roles?: { cache?: { keys(): IterableIterator<string> } } }): Set<string> {
  const keys = member.roles?.cache?.keys();
  return new Set(keys ? [...keys].filter((id) => id !== member.guild.id) : []);
}
