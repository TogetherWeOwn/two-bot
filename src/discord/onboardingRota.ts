import { MessageType, PermissionFlagsBits, type GuildMember, type Message } from 'discord.js';
import type { Db } from '../store/db.ts';
import type { OnboardingRota, RotaActor } from '../analytics/onboardingRota.ts';
import { log } from '../core/log.ts';

export interface RotaPrompt {
  member: GuildMember;
  message: Message;
  variant: 'session' | 'anchor' | 'legacy';
  /** Message-first destination named by the delivered welcome, not its send channel. */
  actionChannelId: string;
}

export interface RotaObserverConfig {
  guildId: string;
  staffRoleIds: ReadonlySet<string>;
  staffActorIds: ReadonlySet<string>;
  humanChannelIds: ReadonlySet<string>;
}

const STAFF_PERMISSIONS = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ModerateMembers;

/** Observations only: no sends, role writes, timers, or alternate onboarding flow. */
export class DiscordOnboardingRota {
  private db: Db;
  private rota: Pick<OnboardingRota, 'rulesAccepted' | 'promptShown' | 'message' | 'reply'>;
  private config: RotaObserverConfig;
  private pending: Promise<void> = Promise.resolve();

  constructor(db: Db, rota: DiscordOnboardingRota['rota'], config: RotaObserverConfig) {
    this.db = db;
    this.rota = rota;
    this.config = config;
  }

  private actor(member: GuildMember | null): RotaActor | null {
    // Partial/missing screening, roles or permission data cannot certify a human.
    if (!member || member.partial || member.guild.id !== this.config.guildId ||
        typeof member.user?.bot !== 'boolean' || member.pending !== false ||
        !member.roles?.cache || !member.permissions || !member.guild.ownerId ||
        member.isCommunicationDisabled()) return null;
    return {
      guildId: member.guild.id, actorId: member.id, isBot: member.user.bot, pending: false,
      isStaff: member.id === member.guild.ownerId || this.config.staffActorIds.has(member.id) ||
        member.roles.cache.some((role) => this.config.staffRoleIds.has(role.id)) ||
        member.permissions.any(STAFF_PERMISSIONS),
    };
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    // Discord listeners are concurrent. Reserve the position synchronously so a
    // successful welcome cannot overtake its observed gate while invite I/O runs.
    this.pending = this.pending.then(work).catch(() => {
      // Error strings can contain SQL binds or Discord payloads. Never log them.
      log.error('onboarding_rota_observation_failed', { classification: 'measurement_gap' });
    });
    return this.pending;
  }

  /** Called immediately on join, before awaiting attribution or the funnel write. */
  join(member: GuildMember, source: Promise<string>, occurredAt: string): Promise<void> {
    if (member.guild.id !== this.config.guildId) return Promise.resolve();
    const actor = this.actor(member);
    const screened = member.guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED');
    return this.enqueue(async () => {
      const cohort = await source;
      // pending=false at join is evidence only on a guild with screening enabled.
      if (actor && screened) await this.rota.rulesAccepted({ ...actor, occurredAt, sourceCohort: cohort });
    });
  }

  /** Only the gateway's explicit true -> false screening transition calls this. */
  gateCleared(member: GuildMember, occurredAt: string): Promise<void> {
    const actor = this.actor(member);
    if (!actor) return Promise.resolve();
    return this.enqueue(async () => {
      const joined = await this.db.prepare(
        'SELECT join_source FROM members WHERE guild_id = ? AND member_id = ?',
      ).get<{ join_source: string | null }>(actor.guildId, actor.actorId);
      await this.rota.rulesAccepted({ ...actor, occurredAt, sourceCohort: joined?.join_source ?? 'unknown' });
    });
  }

  promptShown(input: RotaPrompt): Promise<void> {
    const actor = this.actor(input.member);
    if (!actor || input.message.guildId !== actor.guildId || !input.message.id ||
        !this.config.humanChannelIds.has(input.actionChannelId)) return Promise.resolve();
    const occurredAt = new Date(input.message.createdTimestamp).toISOString();
    return this.enqueue(() => this.rota.promptShown({
      ...actor, occurredAt, promptVariant: input.variant,
      messageId: input.message.id, channelId: input.actionChannelId,
    }));
  }

  /** Reserve on receipt; await automod's acceptance inside the ordered queue. */
  message(message: Message, inspection: Promise<boolean | null> = Promise.resolve(false)): Promise<void> {
    const actor = this.actor(message.member);
    if (!actor || message.guildId !== actor.guildId || message.author.id !== actor.actorId ||
        message.author.bot || message.webhookId || message.system ||
        message.channel.isDMBased() || message.channel.isThread() ||
        !this.config.humanChannelIds.has(message.channelId)) return Promise.resolve();
    const permissions = message.channel.permissionsFor(message.member!);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages)) {
      return Promise.resolve();
    }
    const input = {
      ...actor, messageId: message.id, channelId: message.channelId, eligibleChannel: true,
      occurredAt: new Date(message.createdTimestamp).toISOString(),
    };
    const reference = message.reference;
    return this.enqueue(async () => {
      // true is rejected; null means inspection failed, not acceptance.
      if (await inspection !== false) return;
      await this.rota.message(input);
      if (message.type !== MessageType.Reply || !reference?.messageId || reference.channelId !== message.channelId ||
          reference.guildId !== actor.guildId) return;
      const repliedTo = await message.fetchReference();
      if (repliedTo.guildId !== actor.guildId || repliedTo.channelId !== message.channelId ||
          repliedTo.id !== reference.messageId || repliedTo.webhookId || repliedTo.author.bot ||
          repliedTo.system) return;
      // Fetch current member state: an old message's cached screening/roles are
      // not evidence that its subject is still eligible at reply time.
      const member = await message.guild!.members.fetch({ user: repliedTo.author.id, force: true });
      const subject = this.actor(member);
      if (!subject) return;
      await this.rota.reply({ ...input, subject, replyToMessageId: repliedTo.id });
    });
  }
}
