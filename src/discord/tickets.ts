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
  type GuildMember,
  type Message,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';
import { log } from '../core/log.ts';

export const TICKET_OPEN_ID = 'two:tickets:open';
export const TICKET_CLAIM_ID = 'two:tickets:claim';
export const TICKET_CLOSE_ID = 'two:tickets:close';
const MAX_TRANSCRIPT_CHARS = 200_000;
const TRANSCRIPT_RETENTION_DAYS = 90;
const TICKET_TOPIC_PREFIX = 'two-ticket:';

export type TicketStatus = 'creating' | 'open' | 'closing' | 'cleanup_pending' | 'closed';

export interface TicketRecord {
  id: string;
  guildId: string;
  channelId: string | null;
  openerId: string;
  claimedBy: string | null;
  status: TicketStatus;
  createdAt: string;
  closingStartedAt: string | null;
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
  purgeAfter: string;
}

/** Durable ticket state and transcripts. Message bodies only enter the transcript table. */
export class TicketStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async activeFor(guildId: string, openerId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at
           FROM tickets
          WHERE guild_id = ? AND opener_id = ?
            AND status IN ('creating', 'open', 'closing', 'cleanup_pending')
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

  /** Reserve before channel creation. Returns null when another active ticket won. */
  async reserve(guildId: string, openerId: string, createdAt: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO tickets (id, guild_id, channel_id, opener_id, status, created_at)
         VALUES (?, ?, NULL, ?, 'creating', ?)
         ON CONFLICT DO NOTHING
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at`,
      )
      .get<TicketRow>(randomUUID(), guildId, openerId, createdAt);
    return row ? toTicket(row) : null;
  }

  async recordCreatedChannel(ticketId: string, channelId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE tickets SET channel_id = ?
          WHERE id = ? AND status = 'creating' AND channel_id IS NULL
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at`,
      )
      .get<TicketRow>(channelId, ticketId);
    return row ? toTicket(row) : null;
  }

  async activate(ticketId: string, channelId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE tickets SET channel_id = ?, status = 'open'
          WHERE id = ? AND status = 'creating' AND (channel_id IS NULL OR channel_id = ?)
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at`,
      )
      .get<TicketRow>(channelId, ticketId, channelId);
    return row ? toTicket(row) : null;
  }

  async abandon(ticketId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM tickets WHERE id = ? AND status IN ('creating', 'open')`).run(ticketId);
  }

  async staleClosing(cutoff: string, guildId?: string | null): Promise<TicketRecord[]> {
    const rows = guildId
      ? await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'closing' AND closing_started_at <= ? AND guild_id = ? ORDER BY closing_started_at`)
          .all<TicketRow>(cutoff, guildId)
      : await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'closing' AND closing_started_at <= ? ORDER BY closing_started_at`)
          .all<TicketRow>(cutoff);
    return rows.map(toTicket);
  }

  async transcriptExists(ticketId: string): Promise<boolean> {
    return !!(await this.db.prepare(`SELECT ticket_id FROM ticket_transcripts WHERE ticket_id = ?`).get(ticketId));
  }

  async recoverClosingToCleanup(ticketId: string, closingStartedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tickets SET status = 'cleanup_pending' WHERE id = ? AND status = 'closing' AND closing_started_at = ?`)
      .run(ticketId, closingStartedAt);
    return result.changes === 1;
  }

  async reopenInterruptedClose(ticketId: string, closingStartedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tickets SET status = 'open', closing_started_at = NULL
           WHERE id = ? AND status = 'closing' AND closing_started_at = ?
             AND NOT EXISTS (SELECT 1 FROM ticket_transcripts WHERE ticket_id = tickets.id)`,
      )
      .run(ticketId, closingStartedAt);
    return result.changes === 1;
  }

  async staleCreating(cutoff: string, guildId?: string | null): Promise<TicketRecord[]> {
    const rows = guildId
      ? await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'creating' AND created_at <= ? AND guild_id = ? ORDER BY created_at`)
          .all<TicketRow>(cutoff, guildId)
      : await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'creating' AND created_at <= ? ORDER BY created_at`)
          .all<TicketRow>(cutoff);
    return rows.map(toTicket);
  }

  async byChannel(channelId: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at
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
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at`,
      )
      .get<TicketRow>(staffId, channelId);
    return row ? toTicket(row) : null;
  }

  /** Only one closer may move an open ticket into the close workflow. */
  async beginClose(channelId: string, startedAt: string): Promise<TicketRecord | null> {
    const row = await this.db
      .prepare(
        `UPDATE tickets SET status = 'closing', closing_started_at = ?
           WHERE channel_id = ? AND status = 'open'
         RETURNING id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at`,
      )
      .get<TicketRow>(startedAt, channelId);
    return row ? toTicket(row) : null;
  }

  async reopenAfterCloseFailure(ticketId: string): Promise<void> {
    await this.db.prepare(`UPDATE tickets SET status = 'open', closing_started_at = NULL WHERE id = ? AND status = 'closing'`).run(ticketId);
  }

  async saveTranscript(t: TicketTranscript, closingStartedAt?: string | null): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO ticket_transcripts
           (ticket_id, guild_id, channel_id, opener_id, claimed_by, content, message_count, created_at, purge_after)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM tickets
             WHERE id = ? AND status = 'closing'
               AND (CAST(? AS TEXT) IS NULL OR closing_started_at = ?)
          )
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
        t.purgeAfter,
        t.ticketId,
        closingStartedAt ?? null,
        closingStartedAt ?? null,
      );
    return result.changes === 1;
  }

  async markCleanupPending(ticketId: string, closedAt: string, channelId?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tickets
            SET status = 'cleanup_pending', closed_at = ?, channel_id = COALESCE(channel_id, ?)
          WHERE id = ? AND status IN ('creating', 'open', 'closing')`,
      )
      .run(closedAt, channelId ?? null, ticketId);
  }

  async markClosed(ticketId: string, closedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status IN ('closing', 'cleanup_pending')`)
      .run(closedAt, ticketId);
  }

  async cleanupPending(guildId?: string | null): Promise<TicketRecord[]> {
    const rows = guildId
      ? await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'cleanup_pending' AND guild_id = ? ORDER BY created_at`)
          .all<TicketRow>(guildId)
      : await this.db
          .prepare(`SELECT id, guild_id, channel_id, opener_id, claimed_by, status, created_at, closing_started_at, closed_at FROM tickets WHERE status = 'cleanup_pending' ORDER BY created_at`)
          .all<TicketRow>();
    return rows.map(toTicket);
  }

  async purgeExpired(now: string): Promise<number> {
    return (await this.db.prepare(`DELETE FROM ticket_transcripts WHERE purge_after <= ?`).run(now)).changes;
  }

  async eraseMember(memberId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.prepare(`DELETE FROM ticket_transcripts WHERE opener_id = ? OR claimed_by = ?`).run(memberId, memberId);
      await tx.prepare(`DELETE FROM tickets WHERE opener_id = ? OR claimed_by = ?`).run(memberId, memberId);
    });
  }
}

interface TicketRow {
  id: string;
  guild_id: string;
  channel_id: string | null;
  opener_id: string;
  claimed_by: string | null;
  status: TicketStatus;
  created_at: string;
  closing_started_at: string | null;
  closed_at: string | null;
}

function toTicket(row: TicketRow): TicketRecord {
  return { id: row.id, guildId: row.guild_id, channelId: row.channel_id, openerId: row.opener_id, claimedBy: row.claimed_by, status: row.status, createdAt: row.created_at, closingStartedAt: row.closing_started_at, closedAt: row.closed_at };
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
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(TICKET_OPEN_ID).setLabel('Open a ticket').setStyle(ButtonStyle.Primary));
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

function purgeAfter(createdAt: string): string {
  return new Date(Date.parse(createdAt) + TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function ensurePanel(client: Client, channelId: string): Promise<void> {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !('messages' in channel)) throw new Error(`ticket panel channel ${channelId} is not a cached guild text channel`);
  const text = channel as TextChannel;
  const messages = await text.messages.fetch({ limit: 50 });
  if (messages.some((m) => m.author.id === client.user?.id && m.components.some((r) => 'components' in r && r.components.some((c) => 'customId' in c && c.customId === TICKET_OPEN_ID)))) return;
  await text.send({ content: '**Support tickets**\nOpen a private ticket and a staff member will help you.', components: [buildTicketPanel()], allowedMentions: { parse: [] } });
  log.info('tickets_panel_posted', { channelId });
}

export async function fetchTranscript(channel: TextChannel): Promise<{ content: string; messageCount: number }> {
  const messages: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await channel.messages.fetch({ limit: 100, before });
    if (page.size === 0) break;
    messages.push(...page.values());
    if (page.size < 100) break;
    before = page.lastKey();
    if (!before) break;
  }
  const lines = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map((m) => {
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const existing = await store.activeFor(guild.id, member.id);
  if (existing) {
    await interaction.editReply({ content: existing.channelId ? `You already have an active ticket: <#${existing.channelId}>` : 'Your ticket is being created.' });
    return;
  }
  const cooldown = deps.cooldownSeconds ?? 300;
  if (withinCooldown(await store.lastCreatedAt(guild.id, member.id), Date.now(), cooldown)) {
    await interaction.editReply({ content: `Please wait ${cooldown} seconds between tickets.` });
    return;
  }
  const reservation = await store.reserve(guild.id, member.id, new Date().toISOString());
  if (!reservation) {
    const duplicate = await store.activeFor(guild.id, member.id);
    await interaction.editReply({ content: duplicate?.channelId ? `You already have an active ticket: <#${duplicate.channelId}>` : 'A ticket is already being opened.' });
    return;
  }
  let channel: TextChannel | null = null;
  try {
    const bot = guild.members.me;
    if (!bot) throw new Error(`bot guild member is unavailable in guild ${guild.id}`);
    channel = await guild.channels.create({
      name: ticketChannelName(member), type: ChannelType.GuildText, parent: deps.categoryId,
      topic: `${TICKET_TOPIC_PREFIX}${reservation.id}`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: bot.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: deps.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
    const recorded = await store.recordCreatedChannel(reservation.id, channel.id);
    if (!recorded) throw new Error(`ticket reservation ${reservation.id} disappeared before channel recording`);
    const ticket = await store.activate(reservation.id, channel.id);
    if (!ticket) throw new Error(`ticket reservation ${reservation.id} disappeared before activation`);
    await channel.send({ content: `<@${member.id}> Thanks — staff will be with you shortly. Ticket messages are retained in a staff-only audit transcript for ${TRANSCRIPT_RETENTION_DAYS} days after close.`, components: [buildTicketControls()], allowedMentions: { users: [member.id] } });
  } catch (err) {
    let deleted = !channel;
    if (channel) {
      try {
        await channel.delete('ticket open failed');
        deleted = true;
      } catch (deleteErr) {
        await channel.permissionOverwrites.edit(member.id, { ViewChannel: false, SendMessages: false }).catch(() => undefined);
        await store.markCleanupPending(reservation.id, new Date().toISOString(), channel.id);
        log.error('ticket_open_rollback_failed', { ticketId: reservation.id, channelId: channel.id, err: String(deleteErr) });
      }
    }
    if (deleted) await store.abandon(reservation.id);
    throw err;
  }
  log.info('ticket_opened', { ticketId: reservation.id, guildId: guild.id, openerId: member.id, channelId: channel.id });
  // The ticket is ready; a failed interaction acknowledgement must not roll it back.
  await interaction.editReply({ content: `Your private ticket is ready: <#${channel.id}>` });
}

async function claimTicket(interaction: ButtonInteraction, deps: TicketDeps, store: TicketStore): Promise<void> {
  if (!interaction.guild || !isStaff(interaction, deps.staffRoleId)) {
    await interaction.reply({ content: 'Only staff can claim tickets.', flags: MessageFlags.Ephemeral });
    return;
  }
  const claimed = await store.claim(interaction.channelId, interaction.user.id);
  await interaction.reply({ content: claimed ? `Claimed by <@${interaction.user.id}>.` : 'This ticket is already claimed or not open.', flags: MessageFlags.Ephemeral });
}

async function closeTicket(interaction: ButtonInteraction, deps: TicketDeps, store: TicketStore): Promise<void> {
  if (!interaction.guild || !isStaff(interaction, deps.staffRoleId)) {
    await interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ticket = await store.beginClose(interaction.channelId, new Date().toISOString());
  if (!ticket) {
    const existing = await store.byChannel(interaction.channelId);
    await interaction.editReply({ content: existing?.status === 'cleanup_pending' ? 'Ticket is closed; channel cleanup is pending.' : 'This ticket is already closed or being closed.' });
    return;
  }
  const channel = interaction.channel;
  if (!ticket.channelId || !channel || !channel.isTextBased() || channel.isDMBased() || !('messages' in channel)) {
    await store.reopenAfterCloseFailure(ticket.id);
    throw new Error(`ticket ${ticket.id} channel is unavailable for transcript export`);
  }
  try {
    const createdAt = new Date().toISOString();
    await (channel as TextChannel).permissionOverwrites.edit(ticket.openerId, { SendMessages: false });
    const data = await fetchTranscript(channel as TextChannel);
    const saved = await store.saveTranscript(
      { ...data, ticketId: ticket.id, guildId: ticket.guildId, channelId: ticket.channelId, openerId: ticket.openerId, claimedBy: ticket.claimedBy, createdAt, purgeAfter: purgeAfter(createdAt) },
      ticket.closingStartedAt,
    );
    if (!saved) {
      await interaction.editReply({ content: 'This ticket close was already recovered or completed.' });
      return;
    }
    await store.markCleanupPending(ticket.id, createdAt);
    await interaction.editReply({ content: 'Ticket transcript saved. Cleaning up the private channel.' });
    try {
      await channel.delete('ticket closed');
      await store.markClosed(ticket.id, createdAt);
      log.info('ticket_closed', { ticketId: ticket.id, guildId: ticket.guildId, messageCount: data.messageCount });
    } catch (err) {
      if (isUnknownChannel(err)) {
        await store.markClosed(ticket.id, createdAt);
        log.info('ticket_cleanup_already_absent', { ticketId: ticket.id, channelId: ticket.channelId });
      } else {
        log.error('ticket_cleanup_failed', { ticketId: ticket.id, channelId: ticket.channelId, err: String(err) });
      }
    }
  } catch (err) {
    await (channel as TextChannel).permissionOverwrites.edit(ticket.openerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch((permissionErr) => log.error('ticket_reopen_permission_failed', {
      ticketId: ticket.id,
      channelId: ticket.channelId,
      err: String(permissionErr),
    }));
    await store.reopenAfterCloseFailure(ticket.id);
    throw err;
  }
}

function isUnknownChannel(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 10003;
}

async function recoverCreating(client: Client, store: TicketStore, cutoff: string, guildId?: string | null): Promise<number> {
  let recovered = 0;
  for (const ticket of await store.staleCreating(cutoff, guildId)) {
    let channelId = ticket.channelId;
    if (!channelId) {
      const guild = client.guilds.cache.get(ticket.guildId);
      if (!guild) {
        log.error('ticket_creation_recovery_failed', { ticketId: ticket.id, err: `guild ${ticket.guildId} is not cached` });
        continue;
      }
      try {
        const channels = await guild.channels.fetch();
        const orphan = channels.find((channel) => channel?.isTextBased() && 'topic' in channel && channel.topic === `${TICKET_TOPIC_PREFIX}${ticket.id}`);
        channelId = orphan?.id ?? null;
        if (channelId) await store.recordCreatedChannel(ticket.id, channelId);
      } catch (err) {
        log.error('ticket_creation_recovery_failed', { ticketId: ticket.id, err: String(err) });
        continue;
      }
    }
    if (!channelId) {
      await store.abandon(ticket.id);
      recovered++;
      continue;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel) await channel.delete('recover interrupted ticket creation');
      await store.abandon(ticket.id);
      recovered++;
      log.info('ticket_creation_recovered', { ticketId: ticket.id, channelId });
    } catch (err) {
      if (isUnknownChannel(err)) {
        await store.abandon(ticket.id);
        recovered++;
        log.info('ticket_creation_already_absent', { ticketId: ticket.id, channelId });
      } else {
        await store.markCleanupPending(ticket.id, new Date().toISOString(), channelId);
        log.error('ticket_creation_recovery_failed', { ticketId: ticket.id, channelId, err: String(err) });
      }
    }
  }
  return recovered;
}

async function recoverClosing(client: Client, store: TicketStore, cutoff: string, guildId?: string | null): Promise<number> {
  let recovered = 0;
  for (const ticket of await store.staleClosing(cutoff, guildId)) {
    if (!ticket.closingStartedAt) continue;
    if (await store.transcriptExists(ticket.id)) {
      if (await store.recoverClosingToCleanup(ticket.id, ticket.closingStartedAt)) recovered++;
      continue;
    }
    if (!ticket.channelId) {
      log.error('ticket_close_recovery_failed', { ticketId: ticket.id, err: 'ticket has no channel id' });
      continue;
    }
    try {
      const channel = await client.channels.fetch(ticket.channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !('permissionOverwrites' in channel)) {
        log.error('ticket_close_recovery_failed', { ticketId: ticket.id, channelId: ticket.channelId, err: 'channel is unavailable' });
        continue;
      }
      await (channel as TextChannel).permissionOverwrites.edit(ticket.openerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      if (await store.reopenInterruptedClose(ticket.id, ticket.closingStartedAt)) recovered++;
    } catch (err) {
      if (isUnknownChannel(err)) {
        await store.recoverClosingToCleanup(ticket.id, ticket.closingStartedAt);
        recovered++;
      } else {
        log.error('ticket_close_recovery_failed', { ticketId: ticket.id, channelId: ticket.channelId, err: String(err) });
      }
    }
  }
  return recovered;
}

async function retryCleanup(client: Client, store: TicketStore, guildId?: string | null): Promise<void> {
  for (const ticket of await store.cleanupPending(guildId)) {
    if (!ticket.channelId) continue;
    try {
      const channel = await client.channels.fetch(ticket.channelId);
      if (channel) await channel.delete('retry ticket cleanup');
      await store.markClosed(ticket.id, ticket.closedAt ?? new Date().toISOString());
      log.info('ticket_cleanup_recovered', { ticketId: ticket.id, channelId: ticket.channelId });
    } catch (err) {
      if (isUnknownChannel(err)) {
        await store.markClosed(ticket.id, ticket.closedAt ?? new Date().toISOString());
        log.info('ticket_cleanup_already_absent', { ticketId: ticket.id, channelId: ticket.channelId });
      } else {
        log.error('ticket_cleanup_retry_failed', { ticketId: ticket.id, channelId: ticket.channelId, err: String(err) });
      }
    }
  }
}

export function registerTickets(client: Client, deps: TicketDeps): void {
  const store = new TicketStore(deps.db);
  const purge = async (): Promise<void> => {
    const purged = await store.purgeExpired(new Date().toISOString());
    if (purged > 0) log.info('ticket_transcripts_purged', { count: purged });
  };
  const recover = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const closingRecovered = await recoverClosing(client, store, cutoff, deps.guildId);
    const creatingRecovered = await recoverCreating(client, store, cutoff, deps.guildId);
    if (closingRecovered + creatingRecovered > 0) log.info('ticket_interrupted_recovered', { count: closingRecovered + creatingRecovered });
    await retryCleanup(client, store, deps.guildId);
  };
  client.once(Events.ClientReady, async () => {
    if (deps.guildId && !client.guilds.cache.has(deps.guildId)) return;
    try {
      await recover();
      await ensurePanel(client, deps.panelChannelId);
      await purge();
    } catch (err) {
      log.error('tickets_ready_failed', { err: String(err) });
    }
  });
  const recoveryTimer = setInterval(() => {
    void recover().catch((err) => log.error('ticket_recovery_failed', { err: String(err) }));
  }, 5 * 60 * 1000);
  recoveryTimer.unref();
  const purgeTimer = setInterval(() => {
    void purge().catch((err) => log.error('ticket_transcript_purge_failed', { err: String(err) }));
  }, 60 * 60 * 1000);
  purgeTimer.unref();
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
      const content = 'The ticket action failed. Please try again.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => undefined);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });
}

export const ticketTestHelpers = { withinCooldown, purgeAfter, isUnknownChannel, openTicket };
