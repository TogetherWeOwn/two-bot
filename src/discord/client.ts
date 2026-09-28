import { createHash } from 'node:crypto';
import {
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
  PresenceUpdateStatus,
  type Guild,
  type GuildMember,
} from 'discord.js';
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
 *   MessageContent      - ticket transcripts and enabled automod (PRIVILEGED,
 *                         requested only when it can be used - see below)
 *   GuildMessageReactions - reaction-role add/remove        (metadata only)
 *   GuildVoiceStates    - first_voice_session + voice_session_start/end
 *   GuildInvites        - invite create/delete for attribution
 *   GuildModeration     - authoritative destructive-action audit entries
 *
 * MessageContent is requested ONLY when enabled automod inspects public
 * messages in memory (TWO_AUTOMOD === '1', exact match) or tickets are
 * configured (all three of DISCORD_TICKET_CATEGORY_ID,
 * DISCORD_TICKET_STAFF_ROLE_ID and DISCORD_TICKET_PANEL_CHANNEL_ID set,
 * non-empty - the same all-three-present check as the registration guard in
 * src/index.ts). Otherwise the gateway never receives privileged message
 * content, matching docs/SECRETS.md ("leave OFF - we count that a message
 * happened; we never read it") and docs/PRIVACY.md. Ticket retention and both
 * erasure boundaries are documented in docs/PRIVACY.md.
 *
 * Bitfields: full set 34503 (7-intent gated set 1735 + MessageContent 32768);
 * gated set 1735 = Guilds 1 + GuildMembers 2 + GuildModeration 4 +
 * GuildInvites 64 + GuildVoiceStates 128 + GuildMessages 512 +
 * GuildMessageReactions 1024. Reduced/contained set (TOG-4011) stays 643.
 */
const GATED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
];

const FULL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
];

/**
 * Registration guards are the source of truth for "tickets configured": the
 * same all-three-present check as src/index.ts (`cfg.ticketCategoryId &&
 * cfg.ticketStaffRoleId && cfg.ticketPanelChannelId`). Empty string counts as
 * absent, matching `str()` in src/core/config.ts (`src.get(name) || null`).
 */
export function ticketsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.DISCORD_TICKET_CATEGORY_ID &&
      env.DISCORD_TICKET_STAFF_ROLE_ID &&
      env.DISCORD_TICKET_PANEL_CHANNEL_ID,
  );
}

/** MessageContent is justified only by enabled automod or configured tickets. */
export function needsMessageContent(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWO_AUTOMOD === '1' || ticketsConfigured(env);
}

export function intents(
  automodEnabled = process.env.TWO_AUTOMOD === '1',
  env: NodeJS.ProcessEnv = process.env,
): GatewayIntentBits[] {
  const need = automodEnabled || ticketsConfigured(env);
  return need ? [...FULL_INTENTS] : [...GATED_INTENTS];
}

export const INTENTS = intents();
/** Required for reaction removals and old panel messages absent from cache. */
export const PARTIALS = [Partials.Message, Partials.Reaction, Partials.User];

/**
 * Exact opt-in value for a capability-scoped staging restart connection
 * (TOG-4011). Deliberately the same variable the restart containment preflight
 * reads, so one flag describes one run. Anything other than `'1'` - including
 * `'true'` - is inert, and production never sets it.
 */
export const STAGING_RESTART_CONTAINMENT_FLAG = 'TWO_STAGING_RESTART_CONTAINMENT';

/**
 * What a contained staging restart is allowed to ask Discord for.
 *
 * Containment at the library surface is not reachable: `@discordjs/ws` exposes
 * no socket factory, so shard-internal opcodes never pass through a strategy we
 * own. The boundary that *is* ours is the Identify frame - the capability the
 * connection requests in the first place.
 *
 *   Guilds           - without it no guild event arrives at all
 *   GuildMembers     - GUILD_MEMBER_ADD; the join is the rota's clock start
 *   GuildMessages    - the first human reply the rota measures
 *   GuildVoiceStates - voice session boundaries the funnel already records
 *
 * Dropped because a restart measurement never reads them: MessageContent (the
 * privileged one), GuildModeration, GuildInvites, GuildMessageReactions.
 */
const REDUCED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
];

/** True only for the exact opt-in value. Default-off keeps production intact. */
export function capabilityScoped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STAGING_RESTART_CONTAINMENT_FLAG] === '1';
}

/**
 * The Identify-frame capability for this run. Containment wins first; otherwise
 * the passed `env` threads through the MessageContent gating decision, so a
 * caller-supplied env never reads a stale module-load cache. `INTENTS` above
 * remains the process-env evaluation at import for production.
 */
export function intentsFor(env: NodeJS.ProcessEnv = process.env): GatewayIntentBits[] {
  if (capabilityScoped(env)) return [...REDUCED_INTENTS];
  return intents(env.TWO_AUTOMOD === '1', env);
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
  /** Acceptance-only pre-dispatch boundary; never infer an actor from cached data. */
  stagingRestart?: { guildId: string; syntheticActorIds: ReadonlySet<string> };
}

export function createClient(
  automodEnabled = process.env.TWO_AUTOMOD === '1',
  env: NodeJS.ProcessEnv = process.env,
): Client {
  // Containment wins first (see intentsFor). Otherwise the explicit automod
  // flag and the passed env both thread through gating: an explicit `true`
  // (tests, callers) justifies MessageContent even when `env` is an empty
  // object, and ticket vars in `env` justify it even when the flag is false.
  const mainIntents = capabilityScoped(env)
    ? intentsFor(env)
    : intents(automodEnabled || env.TWO_AUTOMOD === '1', env);
  return new Client({
    intents: mainIntents,
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
    ...(capabilityScoped(env)
      ? {
          // Announcing "online" to a live member list is itself an effect. This
          // is the only presence we ever set: `PresenceUpdateStatus.Invisible`
          // reaches `d.presence` on the Identify frame, so the contained run is
          // never visible in the sidebar. Omitted when the flag is off, which
          // leaves discord.js's `presence: {}` default - i.e. online - exactly
          // as production has it.
          presence: { status: PresenceUpdateStatus.Invisible },
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
  const contained = deps.stagingRestart;
  const accepts = (guildId: string | null | undefined, actorId: string | null | undefined) =>
    !contained || (guildId === contained.guildId && typeof actorId === 'string' &&
      contained.syntheticActorIds.has(actorId));
  const levelRoleWrites = !contained && (deps.levelRoleWrites ?? true);

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
    if (contained || !audit || (auditGuildId && event.guildId !== auditGuildId)) return;
    void audit.record(event).catch(() => {
      log.error('operational_audit_failed', {
        entryId: event.entryId,
        classification: 'audit_record_failed',
      });
    });
  };

  /**
   * One chain per guild for invite snapshots, not one concurrent handler per
   * join (TOG-8306). discord.js dispatches every gateway event to an async
   * listener without awaiting the previous one, and `diffAndStore` is a
   * read-modify-write across several statements with awaits between them. Two
   * joins through different codes on the same tick interleaved like this:
   *
   *   join A fetches (A +1) -> join B fetches (A +1, B +1) ->
   *   A reads the stored baseline -> B reads the SAME stored baseline ->
   *   A stores its snapshot -> B diffs against the stale baseline and sees
   *   both codes grow, attributing an exactly-attributable join
   *   `ambiguous:A+B` (and A's stored write can clobber B's counter back
   *   down, poisoning the next join too).
   *
   * Chaining the whole fetch-plus-diff per guild closes it: the second
   * snapshot's baseline read cannot run until the first snapshot's write has
   * committed, and invite counters only move up, so each join sees exactly
   * its own delta. The InviteCreate refresh takes the same chain so a new
   * code cannot shift the baseline mid-join either. Same per-subject
   * precedent as the voice frames below (TOG-5981): a stuck fetch for guild
   * A never stalls guild B. Scoped to this call so each test bus gets a
   * fresh map; single-process scope is enough because one bot owns the
   * gateway for a guild.
   */
  const inviteChains = new Map<string, Promise<unknown>>();
  const chainedSnapshotInvites = (guild: Guild): Promise<string[]> => {
    // Reserve synchronously at dispatch: both same-tick joins for one guild
    // are ordered in the chain before either awaits anything.
    const prev = inviteChains.get(guild.id) ?? Promise.resolve();
    const next = prev.then(() => snapshotInvites(guild, invites));
    // snapshotInvites never rejects (it catches into []), but the stored
    // guard must never reject either or the chain breaks for every later
    // join; the waiter still gets the real outcome via `next`.
    const guard: Promise<unknown> = next.catch(() => {});
    inviteChains.set(guild.id, guard);
    void guard.finally(() => {
      if (inviteChains.get(guild.id) === guard) inviteChains.delete(guild.id);
    });
    return next;
  };

  client.once(Events.ClientReady, async (c) => {
    log.info('ready', { user: c.user.tag, guilds: c.guilds.cache.size });
    if (!contained) {
      for (const guild of c.guilds.cache.values()) {
        await chainedSnapshotInvites(guild);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (!accepts(member.guild.id, member.id)) return;
    const observedAt = nowIso();
    const joining = (async () => {
      // Snapshot regardless of how this member arrived, so the counters stay
      // current for the next organic join. A one-click join consumes no invite,
      // so for it the diff legitimately shows nothing grew.
      const grew = contained ? [] : await chainedSnapshotInvites(member.guild);

      // The web path's expected join beats the invite diff: a code that grew in
      // the same window belongs to some other join's event. Contained runs have
      // no invitation evidence: do not read real inviter rows or invent a cohort.
      const expected = contained ? null : expectedJoins?.consume(member.guild.id, member.id) ?? null;
      const source = contained ? 'unknown' : expected ?? invites.attribute(grew, !!member.guild.vanityURLCode);
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
    if (!contained && raid && !member.user?.bot) {
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
    if (!contained && joinRisk && !member.user?.bot) {
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
    if (!accepts(newMember.guild.id, newMember.id)) return;
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
    if (!accepts(member.guild.id, member.id)) return;
    // A server-leave is also a voice-leave: Discord drops them from voice with
    // no VoiceStateUpdate, so onLeave closes any open session (TOG-6122).
    await handlers.onLeave(member.guild.id, member.id, undefined, { isBot: !!member.user?.bot });
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
    if (contained || !automod || !msg.guildId || msg.guildId !== automod.guildId || !msg.author) return false;
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
    if (!msg.guildId || !accepts(msg.guildId, msg.author?.id)) return; // ignore DMs and unbound actors
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
    if (!contained) client.emit('automationMessageAccepted' as never, msg as never);
  });

  client.on(Events.Raw, (packet, shardId) => {
    if (contained) return;
    const event = rawMessageAuditEvent(packet as never, shardId);
    if (event) auditSafely(event);
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    if (contained || !newMessage.guildId) return;
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

  /**
   * One chain per member for voice frames, not one concurrent handler per
   * frame (TOG-5981). discord.js dispatches every gateway event to an async
   * listener without awaiting the previous one, so two frames for one member
   * on the same tick interleaved: the move's `onVoiceLeave` chain-read the
   * tracker BEFORE the join's `onVoiceJoin` chain-wrote it, and the end
   * landed startKnown:false with a null duration even though the bot saw the
   * start. Same per-subject chaining precedent as TOG-3695: a stuck write for
   * member A never stalls member B, and unrelated members stay concurrent.
   * Scoped to this registerHandlers call so tests get a fresh map per bus.
   */
  const voiceChains = new Map<string, Promise<void>>();
  const chainVoice = (guildId: string, memberId: string, work: () => Promise<void>): void => {
    // Reserve synchronously at dispatch: both same-tick frames for one member
    // are ordered in the chain before either awaits anything.
    const subject = `${guildId}:${memberId}`;
    const tail = (voiceChains.get(subject) ?? Promise.resolve()).then(work).catch(() => {
      // Error strings can contain SQL binds or Discord payloads. Never log them.
      log.error('voice_state_update_failed', { guildId, memberId, classification: 'measurement_gap' });
    });
    voiceChains.set(subject, tail);
    void tail.finally(() => {
      if (voiceChains.get(subject) === tail) voiceChains.delete(subject);
    });
  };

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // Discord fires this for mute, deafen, camera and go-live too. Only a
    // change of channel is a session boundary.
    if (oldState.channelId === newState.channelId) return;
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;
    const memberId = newState.id ?? oldState.id;
    if (!accepts(guild.id, memberId)) return;
    const isBot = !!(newState.member ?? oldState.member)?.user?.bot;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;
    const member = oldState.member ?? newState.member;
    const guildId = guild.id;

    chainVoice(guildId, memberId, async () => {
      // One timestamp for both halves. On a move from A to B the end and the
      // start are the same instant, and taking nowIso() twice would make the
      // pair look like a gap. Taken inside the chain so a queued frame stamps
      // after the frame ahead of it finished, never before its start.
      const at = nowIso();
      const voiceKind = oldChannelId
        ? newChannelId
          ? 'voice_move'
          : 'voice_leave'
        : 'voice_join';
      auditSafely({
        entryId: `${voiceKind}:${guildId}:${memberId}:${oldChannelId ?? 'none'}:${newChannelId ?? 'none'}:${at}`,
        kind: voiceKind,
        channel: 'voice',
        guildId,
        occurredAt: at,
        targetId: memberId,
        sourceChannelId: oldChannelId,
        destinationChannelId: newChannelId,
        metadata: { isBot },
      });

      // End first, so a move reads as end(A) then start(B) in occurred order.
      if (oldChannelId) {
        await handlers.onVoiceLeave({
          guildId,
          memberId,
          isBot,
          channelId: oldChannelId,
          occurredAt: at,
          onLevelUp: levelUpRoleHook(member),
        });
      }
      if (newChannelId) {
        await handlers.onVoiceJoin({
          guildId,
          memberId,
          isBot,
          channelId: newChannelId,
          occurredAt: at,
        });
      }
    });
  });

  // A reconnect means we may have missed leaves while we were away, so every
  // session we think is open is now unproven. Dropping them costs the duration
  // on those sessions (they end with startKnown: false) and is the only
  // alternative to reporting a duration that silently includes the outage.
  // This covers BOTH gateway recovery paths (TOG-6123): ShardResume after a
  // successful resume, and ShardReady after a fresh session - a full
  // re-identify following an unresumable disconnect (InvalidSession with no
  // stored session, Reconnect opcode, unrecoverable close). ShardReady only
  // follows a READY dispatch, never a RESUMED one, so the two handlers never
  // double-drop; on first-ever connect the tracker is empty and this is a
  // no-op.
  const dropSessionsOnReconnect = (event: string) => {
    const dropped = handlers.voiceSessions.openCount;
    handlers.voiceSessions.clear();
    if (dropped) log.info(event, { dropped });
  };
  client.on(Events.ShardResume, () => dropSessionsOnReconnect('voice_sessions_dropped_on_resume'));
  client.on(Events.ShardReady, () => dropSessionsOnReconnect('voice_sessions_dropped_on_fresh_session'));

  client.on(Events.InviteCreate, async (invite) => {
    if (!contained && invite.guild) await chainedSnapshotInvites(invite.guild as Guild);
  });

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (contained) return;
    const event = moderationAuditEvent(entry, guild.id, client.user?.id, moderationAuditSecret);
    if (event) auditSafely(event);
  });

  client.on(Events.Error, (err) => log.error('client_error', { err: String(err) }));
}

function roleIds(member: { guild: { id: string }; roles?: { cache?: { keys(): IterableIterator<string> } } }): Set<string> {
  const keys = member.roles?.cache?.keys();
  return new Set(keys ? [...keys].filter((id) => id !== member.guild.id) : []);
}
