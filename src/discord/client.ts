import { Client, GatewayIntentBits, Events, type Guild } from 'discord.js';
import type { FunnelHandlers } from '../core/handlers.ts';
import type { InviteTracker, InviteState } from '../core/inviteTracker.ts';
import { log } from '../core/log.ts';

/**
 * Intents we ask Discord for, and why. Keep this list minimal - each one is a
 * permission we have to justify, and GuildMembers/MessageContent are privileged.
 *
 *   Guilds              - required for any guild event at all
 *   GuildMembers        - member_join / member_leave        (PRIVILEGED)
 *   GuildMessages       - first_message                     (metadata only)
 *   GuildVoiceStates    - first_voice_session
 *   GuildInvites        - invite create/delete for attribution
 *
 * We deliberately do NOT request MessageContent. We count that a message
 * happened; we never read what it said. See docs/PRIVACY.md.
 */
export const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
];

export interface BotDeps {
  handlers: FunnelHandlers;
  invites: InviteTracker;
}

export function createClient(): Client {
  return new Client({ intents: INTENTS });
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
  const { handlers, invites } = deps;

  client.once(Events.ClientReady, async (c) => {
    log.info('ready', { user: c.user.tag, guilds: c.guilds.cache.size });
    for (const guild of c.guilds.cache.values()) {
      await snapshotInvites(guild, invites);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const grew = await snapshotInvites(member.guild, invites);
    const source = invites.attribute(grew, !!member.guild.vanityURLCode);
    const inviterId = grew.length === 1 ? await invites.inviterFor(member.guild.id, grew[0]) : null;
    await handlers.onJoin({
      guildId: member.guild.id,
      memberId: member.id,
      isBot: !!member.user?.bot,
      source,
      inviterId,
      occurredAt: member.joinedAt?.toISOString(),
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
    });
  });

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    // Only a transition into a channel counts as a session start.
    if (oldState.channelId === newState.channelId) return;
    if (!newState.channelId || !newState.guild) return;
    await handlers.onVoiceJoin({
      guildId: newState.guild.id,
      memberId: newState.id,
      isBot: !!newState.member?.user?.bot,
      channelId: newState.channelId,
    });
  });

  client.on(Events.InviteCreate, async (invite) => {
    if (invite.guild) await snapshotInvites(invite.guild as Guild, invites);
  });

  client.on(Events.Error, (err) => log.error('client_error', { err: String(err) }));
}
