import { Client, GatewayIntentBits, Events, Partials, type Guild } from 'discord.js';
import { nowIso } from '../core/events.ts';
import type { FunnelHandlers } from '../core/handlers.ts';
import type { InviteTracker, InviteState } from '../core/inviteTracker.ts';
import type { ExpectedJoins } from '../core/expectedJoins.ts';
import type { RaidWatch } from '../analytics/raidWatch.ts';
import type { RaidAnnouncer } from './raidAlert.ts';
import { log } from '../core/log.ts';
import { applyLevelRoles } from '../leveling/discord.ts';
import type { LevelingService } from '../leveling/service.ts';
import type { AuditSink } from '../audit/service.ts';
import { moderationAuditEvent } from '../audit/discordEvents.ts';

/**
 * Intents we ask Discord for, and why. Keep this list minimal - each one is a
 * permission we have to justify, and GuildMembers/MessageContent are privileged.
 *
 *   Guilds              - required for any guild event at all
 *   GuildModeration     - GuildAuditLogEntryCreate for moderation mirrors
 *   GuildMembers        - member_join / member_leave        (PRIVILEGED)
 *   GuildMessages       - first_message                     (metadata only)
 *   GuildVoiceStates    - first_voice_session + voice_session_start/end
 *   GuildInvites        - invite create/delete for attribution
 *
 * We deliberately do NOT request MessageContent. We count that a message
 * happened; we never read what it said. See docs/PRIVACY.md.
 */
export const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
];

export interface BotDeps {
  handlers: FunnelHandlers;
  invites: InviteTracker;
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
  /** Metadata-only staff audit. Optional so the funnel remains independently usable. */
  audit?: AuditSink;
}

export function createClient(): Client {
  return new Client({ intents: INTENTS, partials: [Partials.Message] });
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
  const { handlers, invites, raid, expectedJoins, leveling, audit } = deps;

  const auditSafely = (event: Parameters<NonNullable<BotDeps['audit']>['record']>[0]) => {
    if (!audit) return;
    void audit.record(event).catch((err: unknown) => {
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
    // Snapshot regardless of how this member arrived, so the counters stay
    // current for the next organic join. A one-click join consumes no invite,
    // so for it the diff legitimately shows nothing grew.
    const grew = await snapshotInvites(member.guild, invites);

    // A join guild.add_member announced seconds ago (§7). The note beats the
    // invite diff: this member provably came through the web path, and any
    // code that grew in the same window belongs to some other join's event.
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
    });

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
    const stableChange = JSON.stringify({ nicknameChanged, addedRoleIds, removedRoleIds });
    auditSafely({
      // Discord supplies no id for this gateway event. The occurrence timestamp
      // preserves a later identical transition instead of collapsing it forever.
      entryId: `member-update:${newMember.guild.id}:${newMember.id}:${occurredAt}:${stableChange}`,
      kind: 'member_update',
      channel: 'audit',
      guildId: newMember.guild.id,
      occurredAt,
      targetId: newMember.id,
      metadata: {
        nicknameChanged,
        addedRoleIds,
        removedRoleIds,
      },
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await handlers.onLeave(member.guild.id, member.id);
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guildId) return; // ignore DMs
    await handlers.onMessage({
      guildId: msg.guildId,
      memberId: msg.author.id,
      isBot: msg.author.bot,
      channelId: msg.channelId,
      occurredAt: new Date(msg.createdTimestamp).toISOString(),
      onLevelUp:
        leveling && msg.member
          ? (level) => applyLevelRoles(msg.member!, leveling, level)
          : undefined,
    });
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    if (!newMessage.guildId) return;
    // Without MessageContent this is deliberately metadata-only. Discord can
    // send duplicate updates; the message id + edited timestamp is the key.
    const occurredAt = newMessage.editedAt?.toISOString() ?? nowIso();
    auditSafely({
      entryId: `message-edit:${newMessage.guildId}:${newMessage.id}:${newMessage.editedTimestamp ?? occurredAt}`,
      kind: 'message_edit',
      channel: 'audit',
      guildId: newMessage.guildId,
      occurredAt,
      actorId: newMessage.author?.id ?? oldMessage.author?.id ?? null,
      targetId: newMessage.author?.id ?? oldMessage.author?.id ?? null,
      sourceChannelId: newMessage.channelId,
      messageId: newMessage.id,
      metadata: { cachedBefore: !oldMessage.partial },
    });
  });

  client.on(Events.MessageDelete, (message) => {
    if (!message.guildId) return;
    auditSafely({
      entryId: `message-delete:${message.guildId}:${message.id}`,
      kind: 'message_delete',
      channel: 'audit',
      guildId: message.guildId,
      occurredAt: nowIso(),
      actorId: null,
      targetId: message.author?.id ?? null,
      sourceChannelId: message.channelId,
      messageId: message.id,
      metadata: { cached: !message.partial },
    });
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
      // Discord supplies no voice-event id. The occurrence timestamp preserves
      // a later identical transition instead of collapsing it forever.
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
        onLevelUp:
          leveling && member
            ? (level) => applyLevelRoles(member, leveling, level)
            : undefined,
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
    const event = moderationAuditEvent(entry, guild.id);
    if (event) auditSafely(event);
  });

  client.on(Events.Error, (err) => log.error('client_error', { err: String(err) }));
}

function roleIds(member: { guild: { id: string }; roles?: { cache?: { keys(): IterableIterator<string> } } }): Set<string> {
  const keys = member.roles?.cache?.keys();
  return new Set(keys ? [...keys].filter((id) => id !== member.guild.id) : []);
}
