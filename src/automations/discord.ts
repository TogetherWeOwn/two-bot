/**
 * The automations Discord surface (TOG-1648): a small REST client for posting
 * and deleting, plus the slash-command set admins drive everything through.
 *
 * The REST shape is lifted from src/internal/discordActions.ts rather than
 * reusing that class: internal actions validate allowlisted channel keys
 * before posting, while automations post to admin-named channels directly.
 * Two different authorisation models should not share a door.
 */
import { randomUUID } from 'node:crypto';
import {
  ChannelType,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import type { AutomationService } from './service.ts';
import { renderTemplate } from './template.ts';
import { log } from '../core/log.ts';
import { BUILTIN_COMMAND_NAMES } from '../discord/commandNames.ts';

const API = 'https://discord.com/api/v10';

export interface AutomationDiscordOptions {
  token: string;
  /** Override the API host. Used by tests and the local mock. */
  base?: string;
  fetchImpl?: typeof fetch;
}

/** Discord's own ceilings, asserted before we send. */
const MAX_MESSAGE_CHARS = 2000;
export const DISCORD_REQUEST_TIMEOUT_MS = 15_000;

interface RestResponse extends Response {
  status: number;
}

export class DiscordPostError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'DiscordPostError';
    this.status = options.status ?? null;
    this.retryable = this.status === null || this.status === 429 || this.status >= 500;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

async function readJson(res: RestResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Posts with `allowed_mentions: {parse: []}` on every message, the same rule
 * as announcement.post: an admin-authored template is not a licence to ping
 * @everyone, whatever the template says.
 */
export class AutomationDiscord {
  private token: string;
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(o: AutomationDiscordOptions) {
    this.token = o.token;
    this.base = o.base ?? API;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ res: Response; json: unknown }> {
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
      });
      return { res, json: await readJson(res) };
    } catch {
      throw new DiscordPostError('Discord request failed before receiving a response.');
    }
  }

  async postMessage(channelId: string, content: string, nonce?: string): Promise<string> {
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Message is ${content.length} characters; Discord's ceiling is ${MAX_MESSAGE_CHARS}.`);
    }
    const { res, json } = await this.call('POST', `/channels/${channelId}/messages`, {
      content,
      allowed_mentions: { parse: [] },
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
    });
    if (!res.ok) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      const jsonRetryAfterValue = (json as { retry_after?: unknown } | null)?.retry_after;
      const jsonRetryAfter = jsonRetryAfterValue === undefined ? NaN : Number(jsonRetryAfterValue);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.ceil(retryAfterSeconds * 1000)
        : Number.isFinite(jsonRetryAfter)
          ? Math.ceil(jsonRetryAfter * 1000)
          : undefined;
      throw new DiscordPostError(`Discord rejected the post: HTTP ${res.status}`, {
        status: res.status,
        retryAfterMs,
      });
    }
    const id = (json as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : '';
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const { res, json } = await this.call('DELETE', `/channels/${channelId}/messages/${messageId}`);
    // 404: already gone. Un-deleting is impossible, so it is success here.
    if (!res.ok && res.status !== 404) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      const jsonRetryAfterValue = (json as { retry_after?: unknown } | null)?.retry_after;
      const jsonRetryAfter = jsonRetryAfterValue === undefined ? NaN : Number(jsonRetryAfterValue);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? Math.ceil(retryAfterSeconds * 1000)
        : Number.isFinite(jsonRetryAfter)
          ? Math.ceil(jsonRetryAfter * 1000)
          : undefined;
      throw new DiscordPostError(`Discord rejected the delete: HTTP ${res.status}`, {
        status: res.status,
        retryAfterMs,
      });
    }
  }
}

// --- slash commands -----------------------------------------------------------

/**
 * Every automation admin command, as data. All are ManageGuild-gated at the
 * Discord layer (`setDefaultMemberPermissions`), and guild-only.
 */
export function automationCommandData() {
  const manageGuild = PermissionFlagsBits.ManageGuild;
  return [
    new SlashCommandBuilder()
      .setName('command')
      .setDescription('Define or replace a custom command')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) =>
        o.setName('name').setDescription('Command name, a-z 0-9 _ -').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('template').setDescription('What the bot replies; {user} {username} {server} {channel}').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('description').setDescription('Shown in the command picker').setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('text-trigger').setDescription('Optional !trigger form, e.g. !faq').setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName('command-remove')
      .setDescription('Delete a custom command')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) =>
        o.setName('name').setDescription('Command to delete').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('command-list')
      .setDescription('List this server\'s custom commands')
      .setDefaultMemberPermissions(manageGuild),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('Schedule a message, once or recurring')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) =>
        o.setName('body').setDescription('Message text').setRequired(true),
      )
      .addIntegerOption((o) =>
        o.setName('in-minutes')
          .setDescription('Fire this many minutes from now')
          .setMinValue(1)
          .setMaxValue(525600),
      )
      .addIntegerOption((o) =>
        o.setName('every-minutes')
          .setDescription('Recur at this interval (60 min minimum)')
          .setMinValue(60)
          .setMaxValue(525600),
      ),
    new SlashCommandBuilder()
      .setName('schedule-remove')
      .setDescription('Cancel a scheduled message')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) =>
        o.setName('id').setDescription('Scheduled message id').setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('schedule-list')
      .setDescription('List scheduled messages for this server')
      .setDefaultMemberPermissions(manageGuild),
    new SlashCommandBuilder()
      .setName('sticky')
      .setDescription('Set this channel\'s sticky message')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) =>
        o.setName('body').setDescription('Sticky text').setRequired(true),
      )
      .addIntegerOption((o) =>
        o.setName('debounce')
          .setDescription('Quiet seconds before re-posting (default 5, max 300)')
          .setMinValue(1)
          .setMaxValue(300),
      ),
    new SlashCommandBuilder()
      .setName('sticky-remove')
      .setDescription('Remove this channel\'s sticky message')
      .setDefaultMemberPermissions(manageGuild),
  ].map((c) => c.setDMPermission(false).toJSON());
}

export interface AutomationCommandHandlerOptions {
  guildId: string;
  service: AutomationService;
  /** Store access for listing, dynamic invocation, and id-prefix resolution. */
  store: import('./store.ts').AutomationStore;
  /** Re-register the authoritative merged command set after definition changes. */
  syncCommands?: () => Promise<number>;
  /** Random id source, injectable for tests. */
  newId?: () => string;
}

function ephemeralReply(interaction: Interaction, content: string): Promise<unknown> {
  const i = interaction as ChatInputCommandInteraction;
  return i.reply({ content: content.slice(0, 2000), ephemeral: true });
}

/**
 * Wire the InteractionCreate handler for the automation command set. Default
 * member permissions keep the commands out of non-admin pickers, while this
 * handler independently enforces ManageGuild before any admin operation. The
 * guild-id check is the separate data-isolation boundary.
 */
export function registerAutomationCommands(
  client: Client,
  options: AutomationCommandHandlerOptions,
): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    if (!interaction.inGuild() || interaction.guildId !== options.guildId) return;
    const automationNames = new Set([
      'command', 'command-remove', 'command-list',
      'schedule', 'schedule-remove', 'schedule-list',
      'sticky', 'sticky-remove',
    ]);
    if (!automationNames.has(name)) {
      if (BUILTIN_COMMAND_NAMES.has(name)) return;
      try {
        const custom = await options.store.getCommand(options.guildId, name);
        if (!custom?.enabled) return;
        await options.service.runCommand(
          options.guildId,
          custom.name,
          interaction.user.id,
          () => executeCustomCommand(interaction, custom),
        );
      } catch (err) {
        log.error('automation_command_failed', { command: name, err: String(err) });
        if (!interaction.replied && !interaction.deferred) {
          await ephemeralReply(interaction, 'The custom command failed.').catch(() => {});
        }
      }
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await ephemeralReply(interaction, 'Manage Server permission is required.');
      return;
    }

    try {
      switch (name) {
        case 'command': {
          const cmdName = interaction.options.getString('name', true).toLowerCase();
          const template = interaction.options.getString('template', true);
          const description =
            interaction.options.getString('description') ?? `Custom command ${cmdName}`;
          const textTrigger = interaction.options.getString('text-trigger')?.trim().toLowerCase() || null;
          const r = await options.service.putCommand({
            guildId: options.guildId,
            name: cmdName,
            description,
            template,
            textTrigger,
            actorId: interaction.user.id,
          });
          await options.syncCommands?.();
          await ephemeralReply(
            interaction,
            r.created ? `Command \`/${cmdName}\` created.` : `Command \`/${cmdName}\` updated.`,
          );
          break;
        }
        case 'command-remove': {
          const cmdName = interaction.options.getString('name', true).toLowerCase();
          const gone = await options.service.deleteCommand(
            options.guildId,
            cmdName,
            interaction.user.id,
          );
          if (gone) await options.syncCommands?.();
          await ephemeralReply(
            interaction,
            gone ? `Command \`/${cmdName}\` deleted.` : `No command named \`${cmdName}\`.`,
          );
          break;
        }
        case 'command-list': {
          const rows = await options.store.listCommands(options.guildId);
          if (rows.length === 0) {
            await ephemeralReply(interaction, 'No custom commands defined.');
          } else {
            const lines = rows.map(
              (r) =>
                `/${r.name}${r.textTrigger ? ` (or ${r.textTrigger})` : ''} — ${r.enabled ? 'on' : 'off'}`,
            );
            await ephemeralReply(interaction, lines.join('\n').slice(0, 2000));
          }
          break;
        }
        case 'schedule': {
          const body = interaction.options.getString('body', true);
          const inMinutes = interaction.options.getInteger('in-minutes');
          const everyMinutes = interaction.options.getInteger('every-minutes');
          if (!inMinutes && !everyMinutes) {
            await ephemeralReply(
              interaction,
              'Give either in-minutes (one-shot) or every-minutes (recurring).',
            );
            return;
          }
          const channelId = interaction.channelId;
          if (!channelId) {
            await ephemeralReply(interaction, 'Run this in a channel, not a thread-less context.');
            return;
          }
          const id = (options.newId ?? randomUUID)();
          const nextRunAt = new Date(
            Date.now() + (inMinutes ?? everyMinutes ?? 60) * 60_000,
          ).toISOString();
          const r = await options.service.putScheduled({
            guildId: options.guildId,
            id,
            channelId,
            body,
            nextRunAt,
            intervalSeconds: everyMinutes ? everyMinutes * 60 : null,
            actorId: interaction.user.id,
          });
          await ephemeralReply(
            interaction,
            `${r.created ? 'Scheduled' : 'Replaced'} message \`${id}\` ${
              everyMinutes ? `every ${everyMinutes}m` : `at ${nextRunAt}`
            }.`,
          );
          break;
        }
        case 'schedule-remove': {
          const idOrPrefix = interaction.options.getString('id', true);
          const id = await options.store.resolveScheduledId(options.guildId, idOrPrefix);
          if (!id) {
            await ephemeralReply(
              interaction,
              `No unique scheduled message matches \`${idOrPrefix}\`. Use the full id from /schedule-list.`,
            );
            break;
          }
          const gone = await options.service.deleteScheduled(
            options.guildId,
            id,
            interaction.user.id,
          );
          await ephemeralReply(interaction, gone ? 'Cancelled.' : `No scheduled message \`${id}\`.`);
          break;
        }
        case 'schedule-list': {
          const rows = await options.store.listScheduled(options.guildId);
          if (rows.length === 0) {
            await ephemeralReply(interaction, 'Nothing scheduled.');
          } else {
            const lines = rows.map(
              (r) =>
                `\`${r.id}\` <#${r.channelId}> ${r.nextRunAt}${
                  r.intervalSeconds ? ` every ${Math.round(r.intervalSeconds / 60)}m` : ''
                } ${r.enabled ? '' : '(disabled)'}`,
            );
            await ephemeralReply(interaction, lines.join('\n').slice(0, 2000));
          }
          break;
        }
        case 'sticky': {
          const body = interaction.options.getString('body', true);
          const debounce = interaction.options.getInteger('debounce') ?? undefined;
          const channelId = interaction.channelId;
          if (!channelId) {
            await ephemeralReply(interaction, 'Run this inside the channel.');
            return;
          }
          await options.service.putSticky({
            guildId: options.guildId,
            channelId,
            body,
            debounceSeconds: debounce,
            actorId: interaction.user.id,
          });
          await ephemeralReply(
            interaction,
            `Sticky set for <#${channelId}>${debounce ? `, ${debounce}s debounce` : ''}.`,
          );
          break;
        }
        case 'sticky-remove': {
          const channelId = interaction.channelId;
          if (!channelId) {
            await ephemeralReply(interaction, 'Run this inside the channel.');
            return;
          }
          const gone = await options.service.deleteSticky(
            options.guildId,
            channelId,
            interaction.user.id,
          );
          await ephemeralReply(interaction, gone ? 'Sticky removed.' : 'No sticky in this channel.');
          break;
        }
      }
    } catch (err) {
      // Validation errors carry admin-facing messages; anything else is ours.
      const message = err instanceof Error ? err.message : 'The automation command failed.';
      log.error('automation_command_failed', { command: name, err: String(err) });
      await ephemeralReply(interaction, message).catch(() => {});
    }
  });
}

/**
 * Execute a custom command on behalf of an interaction (slash form). Exposed
 * separately from the admin set because it is the member-facing half: the
 * command definitions are admin-authored, the invocation is anyone's.
 */
export async function executeCustomCommand(
  interaction: ChatInputCommandInteraction,
  row: import('./store.ts').AutomationCommandRow,
): Promise<void> {
  const rendered = renderTemplate(row.template, {
    user: `<@${interaction.user.id}>`,
    username: interaction.user.username,
    server: interaction.guild?.name ?? '',
    channel:
      interaction.channel?.type === ChannelType.GuildText
        ? `#${(interaction.channel as { name?: string }).name ?? ''}`
        : '',
  });
  await interaction.reply({ content: rendered, allowedMentions: { parse: [] } });
}
