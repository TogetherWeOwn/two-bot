import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';
import { log } from '../core/log.ts';

export const TICKET_OPEN_ID = 'two:tickets:open';
export const TICKET_CLAIM_ID = 'two:tickets:claim';
export const TICKET_CLOSE_ID = 'two:tickets:close';
const MAX_TRANSCRIPT_CHARS = 200_000;

export interface TicketRecord {
  id: string;
  guildId: string;
  channelId: string;
  openerId: string;
  claimedBy: string | null;
  status: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
}

export interface TicketTranscript {
  ticketId: string;
  guildId: string;
  channelId: string;
  openerId: string;
  claimedBy: string | null;
  content: string;
  messageCount: number;
  createdAt: string;
}

/** Durable ticket state and transcripts. Message bodies only enter the transcript table. */
export class TicketStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async openFor(guildId: string, openerId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at
           FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open'
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get<TicketRow>(guildId, openerId);
    return row ? toTicket(row) : null;
  }

  async lastCreatedAt(guildId: string, openerId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT created_at FROM tickets WHERE guild_id = ? AND opener_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get<{ created_at: string }>(guildId, openerId);
    return row?.created_at ?? null;
  }

  /** Returns null when the active-ticket uniqueness guard rejected a duplicate. */
  async create(input: Omit<TicketRecord, 'status' | 'claimedBy' | 'closedAt'>): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO tickets
           (id, guild_id, channel_id, opener_id, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)
         ON CONFLICT DO NOTHING
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at`,
      )
      .get<TicketRow>(input.id, input.guildId, input.channelId, input.openerId, input.createdAt);
    return row ? toTicket(row) : null;
  }

  async byChannel(channelId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at
           FROM tickets WHERE channel_id = ?`,
      )
      .get<TicketRow>(channelId);
    return row ? toTicket(row) : null;
  }

  async claim(channelId: string, staffId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE tickets SET claimed_by = ?
           WHERE channel_id = ? AND status = 'open' AND claimed_by IS NULL
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at`,
      )
      .get<TicketRow>(staffId, channelId);
    return row ? toTicket(row) : null;
  }

  async close(channelId: string, closedAt: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE tickets SET status = 'closed', closed_at = ?
           WHERE channel_id = ? AND status = 'open'
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closed_at`,
      )
      .get<TicketRow>(closedAt, channelId);
    return row ? toTicket(row) : null;
  }

  async saveTranscript(t: TicketTranscript): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ticket_transcripts
           (ticket_id, guild_id, channel_id, opener_id, claimed_by, content, message_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticket_id) DO NOTHING`,
      )
      .run(
        t.ticketId,
        t.guildId,
        t.channelId,
        t.openerId,
        t.claimedBy,
        t.content,
        t.messageCount,
        t.createdAt,
      );
  }
}

interface TicketRow {
  id: string;
  guild_id: string;
  channel_id: string;
  opener_id: string;
  claimed_by: string | null;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
}

function toTicket(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    openerId: row.opener_id,
    claimedBy: row.claimed_by,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export interface TicketDeps {
  db: Db;
  /** Only this guild is handled; omitting it handles every guild the bot joins. */
  guildId?: string | null;
  categoryId: string;
  staffRoleId: string;
  panelChannelId: string;
  cooldownSeconds?: number;
}

export function buildTicketPanel(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_OPEN_ID)
      .setLabel('Open a ticket')
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildTicketControls(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(TICKET_CLAIM_ID).setLabel('Claim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(TICKET_CLOSE_ID).setLabel('Close').setStyle(ButtonStyle.Danger),
  );
}

export function ticketChannelName(member: Pick<GuildMember, 'user'>): string {
  const safe = member.user.username.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `ticket-${safe || 'member'}`;
}

function isStaff(interaction: ButtonInteraction, roleId: string): boolean {
  const member = interaction.member;
  if (!member || !('roles' in member)) return false;
  const guildMember = member as GuildMember;
  return guildMember.roles.cache.has(roleId) || guildMember.permissions.has(PermissionFlagsBits.ManageChannels);
}

function withinCooldown(lastCreatedAt: string | null, nowMs: number, seconds: number): boolean {
  return !!lastCreatedAt && nowMs - Date.parse(lastCreatedAt) < seconds * 1000;
}

async function ensurePanel(client: Client, channelId: string): Promise<void> {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !('messages' in channel)) {
    log.error('tickets_panel_undeliverable', { channelId });
    return;
  }
  const text = channel as TextChannel;
  const messages = await text.messages.fetch({ limit: 50 });
  if (
    messages.some((m) =>
      m.author.id === client.user?.id &&
      m.components.some((r) =>
        'components' in r &&
        r.components.some((c) => 'customId' in c && c.customId === TICKET_OPEN_ID),
      ),
    )
  ) return;
  await text.send({
    content: '**Support tickets**\nOpen a private ticket and a staff member will help you.',
    components: [buildTicketPanel()],
    allowedMentions: { parse: [] },
  });
  log.info('tickets_panel_posted', { channelId });
}

async function transcript(channel: TextChannel): Promise<{ content: string; messageCount: number }> {
  const messages = await channel.messages.fetch({ limit: 100 });
  const lines = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => {
      const attachments = [...m.attachments.values()].map((a) => a.url).join(' ');
      return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}${attachments ? ` ${attachments}` : ''}`.trim();
    });
  let content = lines.join('\n');
  if (content.length > MAX_TRANSCRIPT_CHARS) content = `${content.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript truncated]`;
  return { content, messageCount: lines.length };
}

async function openTicket(interaction: ButtonInteraction, deps: TicketDeps, store: TicketStore): Promise<void> {
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member) return;
  const existing = await store.openFor(guild.id, member.id);
  if (existing) {
    await interaction.reply({ content: `You already have an open ticket: <#${existing.channelId}>`, flags: MessageFlags.Ephemeral });
    return;
  }
  const cooldown = deps.cooldownSeconds ?? 300;
  if (withinCooldown(await store.lastCreatedAt(guild.id, member.id), Date.now(), cooldown)) {
    await interaction.reply({ content: `Please wait ${cooldown} seconds between tickets.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const channel = await guild.channels.create({
    name: ticketChannelName(member),
    type: ChannelType.GuildText,
    parent: deps.categoryId,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: deps.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });
  const createdAt = new Date().toISOString();
  const ticket = await store.create({ id: randomUUID(), guildId: guild.id, channelId: channel.id, openerId: member.id, createdAt });
  if (!ticket) {
    await channel.delete('duplicate ticket request').catch(() => undefined);
    const duplicate = await store.openFor(guild.id, member.id);
    await interaction.reply({ content: duplicate ? `You already have an open ticket: <#${duplicate.channelId}>` : 'A ticket is already being opened. Please try again.', flags: MessageFlags.Ephemeral });
    return;
  }
  await channel.send({ content: `<@${member.id}> Thanks — staff will be with you shortly.`, components: [buildTicketControls()], allowedMentions: { users: [member.id] } });
  await interaction.reply({ content: `Your private ticket is ready: <#${channel.id}>`, flags: MessageFlags.Ephemeral });
  log.info('ticket_opened', { ticketId: ticket.id, guildId: guild.id, openerId: member.id, channelId: channel.id });
}

async function claimTicket(interaction: ButtonInteraction, deps: TicketDeps, store: TicketStore): Promise<void> {
  if (!interaction.guild || !isStaff(interaction, deps.staffRoleId)) {
    await interaction.reply({ content: 'Only staff can claim tickets.', flags: MessageFlags.Ephemeral });
    return;
  }
  const claimed = await store.claim(interaction.channelId, interaction.user.id);
  await interaction.reply({ content: claimed ? `Claimed by <@${interaction.user.id}>.` : 'This ticket is already claimed or closed.', flags: MessageFlags.Ephemeral });
}

async function closeTicket(interaction: ButtonInteraction, deps: TicketDeps, store: TicketStore): Promise<void> {
  if (!interaction.guild || !isStaff(interaction, deps.staffRoleId)) {
    await interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
    return;
  }
  const ticket = await store.byChannel(interaction.channelId);
  if (!ticket || ticket.status === 'closed') {
    await interaction.reply({ content: 'This ticket is already closed.', flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !('messages' in channel)) return;
  const data = await transcript(channel as TextChannel);
  await store.saveTranscript({ ...data, ticketId: ticket.id, guildId: ticket.guildId, channelId: ticket.channelId, openerId: ticket.openerId, claimedBy: ticket.claimedBy, createdAt: new Date().toISOString() });
  await store.close(ticket.channelId, new Date().toISOString());
  await interaction.reply({ content: 'Ticket closed and transcript saved.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  await channel.delete('ticket closed').catch((err) => log.error('ticket_cleanup_failed', { ticketId: ticket.id, err: String(err) }));
  log.info('ticket_closed', { ticketId: ticket.id, guildId: ticket.guildId, messageCount: data.messageCount });
}

export function registerTickets(client: Client, deps: TicketDeps): void {
  const store = new TicketStore(deps.db);
  client.once(Events.ClientReady, async () => {
    if (deps.guildId && !client.guilds.cache.has(deps.guildId)) return;
    try {
      await ensurePanel(client, deps.panelChannelId);
    } catch (err) {
      log.error('tickets_panel_failed', { channelId: deps.panelChannelId, err: String(err) });
    }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (![TICKET_OPEN_ID, TICKET_CLAIM_ID, TICKET_CLOSE_ID].includes(interaction.customId)) return;
    if (deps.guildId && interaction.guildId !== deps.guildId) return;
    try {
      if (interaction.customId === TICKET_OPEN_ID) await openTicket(interaction, deps, store);
      else if (interaction.customId === TICKET_CLAIM_ID) await claimTicket(interaction, deps, store);
      else await closeTicket(interaction, deps, store);
    } catch (err) {
      log.error('ticket_interaction_failed', { customId: interaction.customId, err: String(err) });
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'The ticket action failed. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });
}

export const ticketTestHelpers = { withinCooldown };
