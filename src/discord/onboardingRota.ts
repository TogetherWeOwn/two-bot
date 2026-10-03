import { ChannelType, MessageType, PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember, type Message } from 'discord.js';
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
  primaryActorId?: string;
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
  private rota: Pick<OnboardingRota, 'rulesAccepted' | 'promptShown' | 'message' | 'reply' | 'acknowledgePrimary'>;
  private config: RotaObserverConfig;
  /**
   * One chain per observed member, not one process-global chain: an unresolved
   * join attribution, automod inspection, reply fetch or member fetch for
   * member A must never stall observations for unrelated member B.
   * Same-subject gate -> prompt -> action -> reply order is preserved because
   * every observation for one subject shares that subject's chain.
   */
  private chains = new Map<string, Promise<void>>();

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
      isStaff: member.id === member.guild.ownerId || member.id === this.config.primaryActorId || this.config.staffActorIds.has(member.id) ||
        member.roles.cache.some((role) => this.config.staffRoleIds.has(role.id)) ||
        member.permissions.any(STAFF_PERMISSIONS),
    };
  }

  private enqueue(subjectId: string, work: () => Promise<void>): Promise<void> {
    // Discord listeners are concurrent. Reserve the position synchronously so a
    // successful welcome cannot overtake its observed gate while invite I/O runs.
    // Chains are per subject, so a stuck attribution or fetch for one member
    // never stalls unrelated members. Prune the map when a chain settles so it
    // tracks in-flight subjects only, not every member ever observed.
    const tail = (this.chains.get(subjectId) ?? Promise.resolve()).then(work).catch(() => {
      // Error strings can contain SQL binds or Discord payloads. Never log them.
      log.error('onboarding_rota_observation_failed', { classification: 'measurement_gap' });
    });
    this.chains.set(subjectId, tail);
    void tail.finally(() => {
      if (this.chains.get(subjectId) === tail) this.chains.delete(subjectId);
    });
    return tail;
  }

  /** Called immediately on join, before awaiting attribution or the funnel write. */
  join(member: GuildMember, source: Promise<string>, occurredAt: string): Promise<void> {
    if (member.guild.id !== this.config.guildId) return Promise.resolve();
    const actor = this.actor(member);
    const screened = member.guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED');
    // Reserve even for pending/ineligible members that write nothing: a later
    // gateCleared for the same member must land behind attribution resolution,
    // and the funnel's join_source write it reads. Key by member id, which is
    // what actorId carries once the member becomes eligible.
    return this.enqueue(member.id, async () => {
      const cohort = await source;
      // pending=false at join is evidence only on a guild with screening enabled.
      if (actor && screened) await this.rota.rulesAccepted({ ...actor, occurredAt, sourceCohort: cohort });
    });
  }

  /** Only the gateway's explicit true -> false screening transition calls this. */
  gateCleared(member: GuildMember, occurredAt: string): Promise<void> {
    const actor = this.actor(member);
    if (!actor) return Promise.resolve();
    return this.enqueue(actor.actorId, async () => {
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
    return this.enqueue(actor.actorId, () => this.rota.promptShown({
      ...actor, occurredAt, promptVariant: input.variant,
      messageId: input.message.id, channelId: input.actionChannelId,
    }));
  }

  /** Authenticated gateway interaction only; no caller-supplied actor or subject ids. */
  async acknowledgePrimary(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!this.config.primaryActorId || !interaction.inGuild() ||
        interaction.guildId !== this.config.guildId || !interaction.guild ||
        interaction.guild.id !== this.config.guildId || interaction.user.bot ||
        interaction.user.id !== this.config.primaryActorId) return false;
    const link = interaction.options.getString('message-link', true);
    const match = /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/.exec(link);
    if (!match || match[1] !== this.config.guildId || !this.config.humanChannelIds.has(match[2])) return false;
    const [, guildId, channelId, actionId] = match;
    const occurredAt = new Date().toISOString();
    // Resolve the authenticated subject before joining its chain. Serializing
    // REST work on the primary would stall every acknowledgement they make;
    // a global chain would also stall unrelated observations.
    try {
      const guild = interaction.guild;
      const primaryMember = await guild.members.fetch({ user: interaction.user.id, force: true });
      const primary = this.actor(primaryMember);
      if (!primary || primary.isBot || primary.actorId !== this.config.primaryActorId) return false;
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel || channel.guild.id !== guildId || channel.id !== channelId ||
          channel.type !== ChannelType.GuildText) return false;
      const canAct = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
      if (!channel.permissionsFor(primaryMember)?.has(canAct | PermissionFlagsBits.ReadMessageHistory)) return false;
      const message = await channel.messages.fetch({ message: actionId, force: true });
      if (message.partial || message.id !== actionId || message.guildId !== guildId || message.channelId !== channelId ||
          message.author.bot !== false || message.webhookId || message.system) return false;
      const subjectMember = await guild.members.fetch({ user: message.author.id, force: true });
      const subject = this.actor(subjectMember);
      if (!subject || subject.actorId !== message.author.id || !channel.permissionsFor(subjectMember)?.has(canAct)) return false;
      let recorded = false;
      // An observed action reserves this subject's chain at gateway receipt,
      // before any inspection I/O. Wait behind it, not behind other members.
      await this.enqueue(subject.actorId, async () => {
        recorded = await this.rota.acknowledgePrimary({
          ...primary, subject, actionId, channelId, occurredAt,
        });
      });
      return recorded;
    } catch {
      log.error('onboarding_rota_observation_failed', { classification: 'measurement_gap' });
      return false;
    }
  }

  /** Reserve on receipt; await automod's acceptance inside the ordered queue. */
  message(message: Message, inspection: Promise<boolean | null> = Promise.resolve(false)): Promise<void> {
    const actor = this.actor(message.member);
    if (!actor || message.guildId !== actor.guildId || message.author.id !== actor.actorId ||
        message.author.bot || message.webhookId || message.system ||
        message.channel.type !== ChannelType.GuildText ||
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
    return this.enqueue(actor.actorId, async () => {
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
      // The core drops self replies, so skip the handoff: the subject's chain
      // is this running work, which must not await itself.
      if (!subject || subject.actorId === actor.actorId) return;
      // The reply write concerns the subject, not the replier: hand it to the
      // subject's chain so it lands behind the subject's action write even when
      // the reply comes from someone else, while a stuck observation for an
      // unrelated member never stalls either side. The handoff is
      // fire-and-forget on purpose: awaiting it here would deadlock mutual
      // replies, with each subject's chain waiting on the other's tail. The
      // subject's chain still orders the write behind the action because the
      // action was enqueued at receipt, before this handoff.
      void this.enqueue(subject.actorId, () => this.rota.reply({ ...input, subject, replyToMessageId: repliedTo.id }));
    });
  }
}
