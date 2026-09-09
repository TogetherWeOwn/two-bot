import { Client, GatewayIntentBits, Events, Options, Partials, type Guild } from 'discord.js';
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

/**
 * Intents we ask Discord for, and why. Keep this list minimal - each one is a
 * permission we have to justify, and GuildMembers/MessageContent are privileged.
 *
 *   Guilds              - required for any guild event at all
 *   GuildMembers        - member_join / member_leave        (PRIVILEGED)
 *   GuildMessages       - first_message + tickets + automod events
 *   MessageContent      - ticket transcripts and enabled automod (PRIVILEGED)
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
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildModeration,
];

export function intents(_automodEnabled = process.env.TWO_AUTOMOD === '1'): GatewayIntentBits[] {
  return [...BASE_INTENTS];
}

export const INTENTS = intents();

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
  automod?: { service: AutomodService; guildId: string };
  /** Flag-only join risk scoring. It never changes or removes the member. */
  joinRisk?: JoinRiskScorer;
}

export function createClient(automodEnabled = process.env.TWO_AUTOMOD === '1'): Client {
  return new Client({
    intents: intents(automodEnabled),
    ...(automodEnabled
      ? {
          partials: [Partials.Message, Partials.Channel],
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
  const { handlers, invites, raid, expectedJoins, leveling, automod, joinRisk } = deps;

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
    if (!oldMember.pending || newMember.pending) return;
    await handlers.onGateCleared({
      guildId: newMember.guild.id,
      memberId: newMember.id,
      isBot: !!newMember.user?.bot,
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
  }, observedTimestamp: number): Promise<boolean> => {
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
      return err instanceof AutomodProcessingError && err.matched;
    }
  };

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guildId) return; // ignore DMs
    if (await inspectAutomod(msg, msg.createdTimestamp)) return;
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

  client.on(Events.MessageUpdate, async (_old, partial) => {
    if (!partial.guildId) return;
    try {
      const msg = partial.partial ? await partial.fetch() : partial;
      if (!msg.author) return;
      await inspectAutomod(msg, Date.now());
    } catch (err) {
      log.error('automod_edit_fetch_failed', {
        guildId: partial.guildId,
        channelId: partial.channelId,
        messageId: partial.id,
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

  client.on(Events.Error, (err) => log.error('client_error', { err: String(err) }));
}
