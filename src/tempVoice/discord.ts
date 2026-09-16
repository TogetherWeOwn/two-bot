/**
 * discord.js adapter for temporary voice channels (TOG-3052).
 *
 * All of the rules live in `service.ts`; this file only translates. It holds
 * the gateway port implementation, the `voiceStateUpdate` handler, the button
 * panel, and the `/voice` subcommands - which expose exactly the same twelve
 * controls as the panel, because half the server never clicks a button and the
 * other half never types a slash command.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MentionableSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ApplicationCommandDataResolvable,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type RepliableInteraction,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { log } from '../core/log.ts';
import { TEMP_VOICE_CONTROLS, type TempVoiceConfig, type TempVoiceControl } from './config.ts';
import {
  TempVoiceGatewayError,
  UNKNOWN_CHANNEL_CODE,
  type ControlContext,
  type ControlOutcome,
  type OverwriteFlag,
  type OverwriteSpec,
  type TempVoiceGateway,
  type TempVoiceService,
} from './service.ts';

const BUTTON_PREFIX = 'tempvoice:btn:';
const MODAL_PREFIX = 'tempvoice:modal:';
const SELECT_PREFIX = 'tempvoice:select:';

const FLAGS: Record<OverwriteFlag, bigint> = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  Connect: PermissionFlagsBits.Connect,
  Speak: PermissionFlagsBits.Speak,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  MoveMembers: PermissionFlagsBits.MoveMembers,
};

function discordCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

function wrap(err: unknown, what: string): TempVoiceGatewayError {
  return new TempVoiceGatewayError(`${what}: ${String(err)}`, discordCode(err));
}

export class DiscordTempVoiceGateway implements TempVoiceGateway {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  botUserId(): string {
    const id = this.client.user?.id;
    if (!id) throw new Error('temp voice: the client has no user id yet');
    return id;
  }

  /** null means Discord has no such channel - which callers treat as success. */
  private async voiceChannel(channelId: string): Promise<VoiceBasedChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isVoiceBased()) return null;
      return channel;
    } catch (err) {
      if (discordCode(err) === UNKNOWN_CHANNEL_CODE) return null;
      throw wrap(err, `fetching channel ${channelId}`);
    }
  }

  private async requireVoiceChannel(channelId: string): Promise<VoiceBasedChannel> {
    const channel = await this.voiceChannel(channelId);
    if (!channel) throw new TempVoiceGatewayError(`channel ${channelId} is gone`, UNKNOWN_CHANNEL_CODE);
    return channel;
  }

  async createVoiceChannel(input: {
    guildId: string;
    name: string;
    categoryId: string;
    position?: number;
    overwrites: OverwriteSpec[];
  }): Promise<{ id: string }> {
    try {
      const guild = await this.client.guilds.fetch(input.guildId);
      const channel = await guild.channels.create({
        name: input.name,
        type: ChannelType.GuildVoice,
        parent: input.categoryId,
        ...(input.position === undefined ? {} : { position: input.position }),
        permissionOverwrites: input.overwrites.map((spec) => ({
          id: spec.id,
          type: spec.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
          allow: (spec.allow ?? []).map((flag) => FLAGS[flag]),
          deny: (spec.deny ?? []).map((flag) => FLAGS[flag]),
        })),
        reason: 'temp-voice: join-to-create',
      });
      return { id: channel.id };
    } catch (err) {
      // Preserves code 50035 (category full) so the service can refuse cleanly.
      throw wrap(err, 'creating a temp voice channel');
    }
  }

  async deleteChannel(channelId: string, reason: string): Promise<'deleted' | 'missing'> {
    const channel = await this.voiceChannel(channelId);
    if (!channel) return 'missing';
    try {
      await channel.delete(reason);
      return 'deleted';
    } catch (err) {
      // Somebody deleted it between the fetch and the delete. That is the
      // outcome we wanted, so it is success, not an error.
      if (discordCode(err) === UNKNOWN_CHANNEL_CODE) return 'missing';
      throw wrap(err, `deleting channel ${channelId}`);
    }
  }

  async moveMember(guildId: string, userId: string, channelId: string | null): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      await member.voice.setChannel(channelId, 'temp-voice');
    } catch (err) {
      throw wrap(err, `moving ${userId}`);
    }
  }

  async renameChannel(channelId: string, name: string): Promise<void> {
    const channel = await this.requireVoiceChannel(channelId);
    try {
      await channel.setName(name, 'temp-voice: owner rename');
    } catch (err) {
      throw wrap(err, `renaming channel ${channelId}`);
    }
  }

  async setUserLimit(channelId: string, limit: number): Promise<void> {
    const channel = await this.requireVoiceChannel(channelId);
    if (channel.type !== ChannelType.GuildVoice) return;
    try {
      await channel.setUserLimit(limit, 'temp-voice: owner control');
    } catch (err) {
      throw wrap(err, `setting the user limit on ${channelId}`);
    }
  }

  async setBitrate(channelId: string, bitrate: number): Promise<void> {
    const channel = await this.requireVoiceChannel(channelId);
    if (channel.type !== ChannelType.GuildVoice) return;
    try {
      await channel.setBitrate(bitrate, 'temp-voice: owner control');
    } catch (err) {
      throw wrap(err, `setting the bitrate on ${channelId}`);
    }
  }

  async applyOverwrite(channelId: string, overwrite: OverwriteSpec): Promise<void> {
    const channel = await this.requireVoiceChannel(channelId);
    // Partial by design: only the named flags move, so `lock` and `hide` can
    // share the @everyone overwrite without clobbering each other.
    const options: Record<string, boolean> = {};
    for (const flag of overwrite.allow ?? []) options[flag] = true;
    for (const flag of overwrite.deny ?? []) options[flag] = false;
    try {
      await channel.permissionOverwrites.edit(overwrite.id, options, {
        type: overwrite.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
        reason: 'temp-voice: owner control',
      });
    } catch (err) {
      throw wrap(err, `editing overwrites on ${channelId}`);
    }
  }

  async clearOverwrite(channelId: string, targetId: string): Promise<void> {
    const channel = await this.requireVoiceChannel(channelId);
    try {
      await channel.permissionOverwrites.delete(targetId, 'temp-voice: ownership moved');
    } catch (err) {
      if (discordCode(err) === UNKNOWN_CHANNEL_CODE) return;
      throw wrap(err, `clearing an overwrite on ${channelId}`);
    }
  }

  async occupantsOf(channelId: string): Promise<string[] | null> {
    const channel = await this.voiceChannel(channelId);
    if (!channel) return null;
    return [...channel.members.keys()];
  }

  async positionBelow(channelId: string): Promise<number | undefined> {
    const channel = await this.voiceChannel(channelId);
    return channel ? channel.rawPosition + 1 : undefined;
  }

  async canMove(guildId: string, userId: string): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      if (guild.ownerId === userId) return false;
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const target = await guild.members.fetch(userId);
      return me.roles.highest.comparePositionTo(target.roles.highest) > 0;
    } catch (err) {
      log.error('temp_voice_can_move_check_failed', { guildId, userId, err: String(err) });
      return false;
    }
  }

  async maxBitrate(guildId: string): Promise<number> {
    const guild = await this.client.guilds.fetch(guildId);
    return guild.maximumBitrate;
  }

  /**
   * Effective permissions in the category, which is what Discord actually
   * checks - a guild-wide role grant and a category overwrite both satisfy it,
   * and the narrower one is the one to ask an operator for.
   */
  async missingPermissions(
    guildId: string,
    categoryId: string,
    flags: readonly OverwriteFlag[],
  ): Promise<OverwriteFlag[]> {
    const guild = await this.client.guilds.fetch(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const category = await this.client.channels.fetch(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new TempVoiceGatewayError(`category ${categoryId} is not a category channel`, null);
    }
    const held = category.permissionsFor(me);
    return flags.filter((flag) => !held?.has(FLAGS[flag]));
  }
}

// ------------------------------------------------------------------ commands

/**
 * `/voice`, one subcommand per control. Deliberately the same twelve names as
 * `TEMP_VOICE_CONTROLS`, so a control cannot exist on the panel and be missing
 * here.
 */
export function tempVoiceCommandData(): ApplicationCommandDataResolvable[] {
  const command = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Control your temporary voice channel')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('name').setDescription('Rename your channel')
      .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true)))
    .addSubcommand((s) => s.setName('limit').setDescription('Set the user limit (0 for unlimited)')
      .addIntegerOption((o) => o.setName('limit').setDescription('0-99').setRequired(true).setMinValue(0).setMaxValue(99)))
    .addSubcommand((s) => s.setName('lock').setDescription('Stop anyone else from joining'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Let anyone join again'))
    .addSubcommand((s) => s.setName('permit').setDescription('Let a member or role in')
      .addMentionableOption((o) => o.setName('target').setDescription('Member or role').setRequired(true)))
    .addSubcommand((s) => s.setName('reject').setDescription('Keep a member or role out')
      .addMentionableOption((o) => o.setName('target').setDescription('Member or role').setRequired(true)))
    .addSubcommand((s) => s.setName('hide').setDescription('Hide the channel from the channel list'))
    .addSubcommand((s) => s.setName('reveal').setDescription('Show the channel again'))
    .addSubcommand((s) => s.setName('kick').setDescription('Remove somebody from your channel')
      .addUserOption((o) => o.setName('member').setDescription('Member to remove').setRequired(true)))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim a channel whose owner has left'))
    .addSubcommand((s) => s.setName('transfer').setDescription('Hand the channel to somebody in it')
      .addUserOption((o) => o.setName('member').setDescription('New owner').setRequired(true)))
    .addSubcommand((s) => s.setName('bitrate').setDescription('Set the audio bitrate')
      .addIntegerOption((o) => o.setName('bitrate').setDescription('Bits per second').setRequired(true).setMinValue(8000)));
  return [command.toJSON()];
}

// --------------------------------------------------------------------- panel

const PANEL_LAYOUT: TempVoiceControl[][] = [
  ['lock', 'unlock', 'hide', 'reveal', 'claim'],
  ['name', 'limit', 'bitrate', 'permit', 'reject'],
  ['kick', 'transfer'],
];

const PANEL_LABELS: Record<TempVoiceControl, string> = {
  name: 'Rename',
  limit: 'User limit',
  lock: 'Lock',
  unlock: 'Unlock',
  permit: 'Permit',
  reject: 'Reject',
  hide: 'Hide',
  reveal: 'Reveal',
  kick: 'Kick',
  claim: 'Claim',
  transfer: 'Transfer',
  bitrate: 'Bitrate',
};

export const TEMP_VOICE_PANEL_TEXT = [
  '**Your temporary voice channel**',
  'Join the generator channel and Owen makes you a channel of your own.',
  'These buttons act on the temp channel you are currently sitting in, and only its owner can use them.',
].join('\n');

export function buildTempVoicePanel(config: TempVoiceConfig): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const group of PANEL_LAYOUT) {
    const enabled = group.filter((control) => !config.disabledControls.has(control));
    if (!enabled.length) continue;
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      enabled.map((control) => new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}${control}`)
        .setLabel(PANEL_LABELS[control])
        .setStyle(control === 'lock' || control === 'hide' ? ButtonStyle.Danger : ButtonStyle.Secondary)),
    ));
  }
  return rows;
}

/**
 * Post the panel, or update the one already there. The existing panel is found
 * by its button custom ids rather than a stored message id, so a redeploy that
 * lost its bookkeeping edits the panel instead of posting a second one.
 */
export async function ensureTempVoicePanel(client: Client, config: TempVoiceConfig): Promise<string | null> {
  if (!config.enabled || !config.panelChannelId) return null;
  const components = buildTempVoicePanel(config);
  if (!components.length) return null;
  try {
    const channel = await client.channels.fetch(config.panelChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      log.error('temp_voice_panel_channel_unusable', { channelId: config.panelChannelId });
      return null;
    }
    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find((message) =>
      message.author.id === client.user?.id &&
      message.components.some((row) =>
        'components' in row &&
        row.components.some((component) => 'customId' in component && component.customId?.startsWith(BUTTON_PREFIX))));
    if (existing) {
      await existing.edit({ content: TEMP_VOICE_PANEL_TEXT, components });
      return existing.id;
    }
    const posted = await channel.send({ content: TEMP_VOICE_PANEL_TEXT, components });
    return posted.id;
  } catch (err) {
    log.error('temp_voice_panel_failed', { channelId: config.panelChannelId, err: String(err) });
    return null;
  }
}

// ------------------------------------------------------------------ handlers

/** Controls whose argument is picked from a menu rather than typed. */
const SELECT_CONTROLS = new Set<TempVoiceControl>(['permit', 'reject', 'kick', 'transfer']);
/** Controls whose argument is typed into a modal. */
const MODAL_CONTROLS = new Set<TempVoiceControl>(['name', 'limit', 'bitrate']);

function isControl(value: string): value is TempVoiceControl {
  return (TEMP_VOICE_CONTROLS as readonly string[]).includes(value);
}

async function respond(interaction: RepliableInteraction, outcome: ControlOutcome): Promise<void> {
  const content = outcome.message.slice(0, 2000);
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export interface TempVoiceRegistration {
  guildId: string;
  service: TempVoiceService;
  config: TempVoiceConfig;
}

export function registerTempVoice(client: Client, options: TempVoiceRegistration): void {
  const { guildId, service, config } = options;

  /** The channel the actor is connected to right now, from the voice-state cache. */
  const connectedChannel = (interaction: Interaction): string | null => {
    const state = interaction.guild?.voiceStates.cache.get(interaction.user.id);
    return state?.channelId ?? null;
  };
  const contextFor = (interaction: Interaction): ControlContext => ({
    guildId,
    actorId: interaction.user.id,
    actorChannelId: connectedChannel(interaction),
  });

  client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
    void (async () => {
      const stateGuildId = newState.guild?.id ?? oldState.guild?.id;
      if (stateGuildId !== guildId || !config.enabled) return;
      const userId = newState.id ?? oldState.id;
      try {
        if (newState.channelId && newState.channelId === config.generatorChannelId) {
          const username = newState.member?.displayName ?? newState.member?.user.username ?? 'member';
          const outcome = await service.onGeneratorJoin({ guildId, userId, username });
          if (outcome.status === 'refused') {
            // There is no interaction to reply to here, so a DM is the only
            // private channel available. A closed DM is not worth failing over.
            await newState.member?.send(outcome.reason).catch(() => undefined);
          }
        }
        await service.onVoiceStateChange({
          guildId,
          userId,
          fromChannelId: oldState.channelId ?? null,
          toChannelId: newState.channelId ?? null,
        });
      } catch (err) {
        log.error('temp_voice_state_failed', { guildId, userId, err: String(err) });
      }
    })();
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void (async () => {
      if (!interaction.inGuild() || interaction.guildId !== guildId) return;
      try {
        if (interaction.isChatInputCommand() && interaction.commandName === 'voice') {
          await handleSlash(interaction, service, contextFor(interaction));
          return;
        }
        if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX)) {
          await handleButton(interaction, service, config, contextFor(interaction));
          return;
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
          const control = interaction.customId.slice(MODAL_PREFIX.length);
          if (!isControl(control)) return;
          const value = interaction.fields.getTextInputValue('value');
          // Deferred BEFORE any rename: a throttled rename returns instantly,
          // but an un-throttled one is a real API call discord.js may sit on,
          // and an undeferred interaction dies after three seconds.
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await respond(interaction, await applyTyped(service, contextFor(interaction), control, value));
          return;
        }
        if (interaction.isAnySelectMenu() && interaction.customId.startsWith(SELECT_PREFIX)) {
          const control = interaction.customId.slice(SELECT_PREFIX.length);
          if (!isControl(control)) return;
          const targetId = interaction.values[0];
          if (!targetId) return;
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const isRole = interaction.isMentionableSelectMenu() && interaction.roles.has(targetId);
          await respond(
            interaction,
            await applyTarget(service, contextFor(interaction), control, {
              id: targetId,
              type: isRole ? 'role' : 'member',
            }),
          );
          return;
        }
      } catch (err) {
        log.error('temp_voice_interaction_failed', {
          guildId,
          userId: interaction.user.id,
          err: String(err),
        });
        if (interaction.isRepliable()) {
          await respond(interaction, { status: 'refused', message: 'That voice control failed. Please try again.' })
            .catch(() => undefined);
        }
      }
    })();
  });
}

async function handleButton(
  interaction: ButtonInteraction,
  service: TempVoiceService,
  config: TempVoiceConfig,
  ctx: ControlContext,
): Promise<void> {
  const control = interaction.customId.slice(BUTTON_PREFIX.length);
  if (!isControl(control)) return;

  if (MODAL_CONTROLS.has(control)) {
    // The disabled check is repeated in the service; showing a modal for a
    // control that will be refused anyway is just a worse error message.
    if (config.disabledControls.has(control)) {
      await respond(interaction, { status: 'refused', message: `The \`${control}\` control is disabled on this server.` });
      return;
    }
    await interaction.showModal(modalFor(control));
    return;
  }

  if (SELECT_CONTROLS.has(control)) {
    if (config.disabledControls.has(control)) {
      await respond(interaction, { status: 'refused', message: `The \`${control}\` control is disabled on this server.` });
      return;
    }
    await interaction.reply({
      content: `Choose who to ${control}:`,
      components: [selectRowFor(control)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await respond(interaction, await applyToggle(service, ctx, control));
}

function modalFor(control: TempVoiceControl): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (control === 'name') input.setLabel('New channel name').setMaxLength(100);
  else if (control === 'limit') input.setLabel('User limit (0-99)').setMaxLength(2);
  else input.setLabel('Bitrate in bits per second').setMaxLength(6);
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${control}`)
    .setTitle(PANEL_LABELS[control])
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function selectRowFor(control: TempVoiceControl): ActionRowBuilder<UserSelectMenuBuilder | MentionableSelectMenuBuilder> {
  const customId = `${SELECT_PREFIX}${control}`;
  // permit/reject accept a role as well as a member; kick/transfer cannot.
  const menu = control === 'permit' || control === 'reject'
    ? new MentionableSelectMenuBuilder().setCustomId(customId).setPlaceholder('Member or role').setMaxValues(1)
    : new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder('Member').setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder | MentionableSelectMenuBuilder>().addComponents(menu);
}

function applyToggle(service: TempVoiceService, ctx: ControlContext, control: TempVoiceControl): Promise<ControlOutcome> {
  switch (control) {
    case 'lock': return service.lock(ctx, true);
    case 'unlock': return service.lock(ctx, false);
    case 'hide': return service.hide(ctx, true);
    case 'reveal': return service.hide(ctx, false);
    case 'claim': return service.claim(ctx);
    default: return Promise.resolve({ status: 'noop', message: 'Unknown control.' });
  }
}

function applyTyped(
  service: TempVoiceService,
  ctx: ControlContext,
  control: TempVoiceControl,
  raw: string,
): Promise<ControlOutcome> {
  if (control === 'name') return service.rename(ctx, raw);
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    return Promise.resolve({ status: 'refused', message: `\`${raw.slice(0, 40)}\` is not a whole number.` });
  }
  return control === 'limit' ? service.setLimit(ctx, value) : service.setBitrate(ctx, value);
}

function applyTarget(
  service: TempVoiceService,
  ctx: ControlContext,
  control: TempVoiceControl,
  target: { id: string; type: 'member' | 'role' },
): Promise<ControlOutcome> {
  switch (control) {
    case 'permit': return service.permit(ctx, target);
    case 'reject': return service.reject(ctx, target);
    case 'kick': return service.kick(ctx, target.id);
    case 'transfer': return service.transfer(ctx, target.id);
    default: return Promise.resolve({ status: 'noop', message: 'Unknown control.' });
  }
}

async function handleSlash(
  interaction: ChatInputCommandInteraction,
  service: TempVoiceService,
  ctx: ControlContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  if (!isControl(sub)) return;
  // Every branch defers first so the rename path can never race the three
  // second interaction deadline, and the others stay consistent with it.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (MODAL_CONTROLS.has(sub)) {
    const raw = sub === 'name'
      ? interaction.options.getString('name', true)
      : String(interaction.options.getInteger(sub, true));
    await respond(interaction, await applyTyped(service, ctx, sub, raw));
    return;
  }
  if (SELECT_CONTROLS.has(sub)) {
    if (sub === 'permit' || sub === 'reject') {
      const target = interaction.options.getMentionable('target', true);
      const id = 'id' in target ? target.id : '';
      const type = interaction.options.getRole('target') ? 'role' : 'member';
      await respond(interaction, await applyTarget(service, ctx, sub, { id, type }));
      return;
    }
    const member = interaction.options.getUser('member', true);
    await respond(interaction, await applyTarget(service, ctx, sub, { id: member.id, type: 'member' }));
    return;
  }
  await respond(interaction, await applyToggle(service, ctx, sub));
}

// ------------------------------------------------------------- reconcile/sweep

/**
 * Periodic sweep. Also the place empty channels are actually deleted, so a
 * missed gateway event costs one sweep interval rather than a ghost channel
 * that lives until somebody notices.
 */
export function startTempVoiceSweeper(
  service: TempVoiceService,
  guildId: string,
  seconds: number,
): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await service.sweep(guildId);
    } catch (err) {
      log.error('temp_voice_sweep_failed', { guildId, err: String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
