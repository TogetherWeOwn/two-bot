import {
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import type { FeedItem, FeedReader, AnnouncementDiscord } from './service.ts';
import { parseRoleSpec, AnnouncementsService } from './service.ts';
import type { FeedRelayRow, RsvpStatus } from './store.ts';
import { log } from '../core/log.ts';

const API = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 15_000;
const LFG_PREFIX = 'two:lfg:';

export interface AnnouncementsDiscordOptions {
  token: string;
  base?: string;
  fetchImpl?: typeof fetch;
}

export class DiscordAnnouncements implements AnnouncementDiscord {
  private options: AnnouncementsDiscordOptions;
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(options: AnnouncementsDiscordOptions) {
    this.options = options;
    this.base = options.base ?? API;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bot ${this.options.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Discord request failed: HTTP ${res.status}`);
    return json;
  }

  async postMessage(
    channelId: string,
    content: string,
    options: { nonce?: string; components?: unknown[] } = {},
  ): Promise<string> {
    const json = await this.call('POST', `/channels/${channelId}/messages`, {
      content,
      components: options.components ?? [],
      allowed_mentions: { parse: [] },
      ...(options.nonce ? { nonce: options.nonce, enforce_nonce: true } : {}),
    }) as { id?: unknown } | null;
    return typeof json?.id === 'string' ? json.id : '';
  }

  async editMessage(channelId: string, messageId: string, content: string, components: unknown[] = []): Promise<void> {
    await this.call('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      content,
      components,
      allowed_mentions: { parse: [] },
    });
  }
}

export class XmlFeedReader implements FeedReader {
  private fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async read(feed: FeedRelayRow): Promise<FeedItem[]> {
    const res = await this.fetchImpl(feed.source, {
      headers: { 'User-Agent': 'Owen/1.0 (+https://two.gg)' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
    const type = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (!type.includes('xml') && !type.includes('rss') && !type.includes('atom') && type !== '') {
      throw new Error(`Feed returned unsupported content type ${type}.`);
    }
    const body = await res.text();
    if (body.length > 2_000_000) throw new Error('Feed is larger than 2 MB.');
    return parseXmlFeed(body);
  }
}

export function parseXmlFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].map((m) => m[1] ?? '');
  return blocks.map((block) => {
    const title = decodeXml(extractTag(block, 'title') ?? 'Untitled');
    const link = extractLink(block);
    const key = decodeXml(extractTag(block, 'guid') ?? extractTag(block, 'id') ?? link);
    const publishedAt = decodeXml(extractTag(block, 'pubDate') ?? extractTag(block, 'published') ?? extractTag(block, 'updated') ?? '');
    return { key, title, url: decodeXml(link), ...(publishedAt ? { publishedAt } : {}) };
  }).filter((item) => item.key && /^https?:\/\//i.test(item.url));
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripCdata(match[1] ?? '').trim() : null;
}

function extractLink(block: string): string {
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1];
  return atom ?? extractTag(block, 'link') ?? '';
}

function stripCdata(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1');
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

export function announcementCommandData() {
  const manageEvents = PermissionFlagsBits.ManageEvents;
  const manageGuild = PermissionFlagsBits.ManageGuild;
  return [
    new SlashCommandBuilder()
      .setName('rsvp')
      .setDescription('RSVP to a Discord scheduled event')
      .addStringOption((o) => o.setName('event-id').setDescription('Discord scheduled event id').setRequired(true))
      .addStringOption((o) => o.setName('status').setDescription('Your response').setRequired(true)
        .addChoices(
          { name: 'Going', value: 'going' },
          { name: 'Interested', value: 'interested' },
          { name: 'Declined', value: 'declined' },
        )),
    new SlashCommandBuilder()
      .setName('attendance')
      .setDescription('Show Owen RSVP totals for a scheduled event')
      .addStringOption((o) => o.setName('event-id').setDescription('Discord scheduled event id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('lfg')
      .setDescription('Post a raid/LFG signup with role slots')
      .setDefaultMemberPermissions(manageEvents)
      .addStringOption((o) => o.setName('title').setDescription('Event or group title').setRequired(true))
      .addStringOption((o) => o.setName('starts-at').setDescription('ISO-8601 start time').setRequired(true))
      .addStringOption((o) => o.setName('roles').setDescription('tank:Tank:2,healer:Healer:2,dps:DPS:6').setRequired(true)),
    new SlashCommandBuilder()
      .setName('lfg-close')
      .setDescription('Close a raid/LFG signup')
      .setDefaultMemberPermissions(manageEvents)
      .addStringOption((o) => o.setName('id').setDescription('LFG id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('feed-add')
      .setDescription('Relay an RSS, YouTube, or Twitch feed into this channel')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) => o.setName('kind').setDescription('Feed kind').setRequired(true)
        .addChoices({ name: 'RSS', value: 'rss' }, { name: 'YouTube', value: 'youtube' }, { name: 'Twitch', value: 'twitch' }))
      .addStringOption((o) => o.setName('source').setDescription('HTTPS URL or YouTube channel id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('feed-remove')
      .setDescription('Remove a feed relay')
      .setDefaultMemberPermissions(manageGuild)
      .addStringOption((o) => o.setName('id').setDescription('Feed id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('feed-list')
      .setDescription('List this server\'s feed relays')
      .setDefaultMemberPermissions(manageGuild),
  ].map((command) => command.setDMPermission(false).toJSON());
}

export function registerAnnouncementCommands(client: Client, options: {
  guildId: string;
  service: AnnouncementsService;
  store: import('./store.ts').AnnouncementsStore;
}): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.inGuild() || interaction.guildId !== options.guildId) return;
    try {
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith(LFG_PREFIX)) {
        const id = interaction.customId.slice(LFG_PREFIX.length);
        const role = interaction.values[0];
        const outcome = role === '__leave__'
          ? (await options.service.leaveLfg(options.guildId, id, interaction.user.id) ? 'left' : 'were not signed up')
          : await options.service.signupLfg({ guildId: options.guildId, id, roleKey: role ?? '', userId: interaction.user.id });
        await interaction.reply({ content: `LFG ${outcome}.`, ephemeral: true });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await handleCommand(interaction, options);
    } catch (error) {
      log.error('announcement_interaction_failed', { err: String(error) });
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: error instanceof Error ? error.message.slice(0, 2000) : 'The announcement command failed.',
          ephemeral: true,
        }).catch(() => {});
      }
    }
  });
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  options: { guildId: string; service: AnnouncementsService; store: import('./store.ts').AnnouncementsStore },
): Promise<void> {
  switch (interaction.commandName) {
    case 'rsvp': {
      const status = interaction.options.getString('status', true) as RsvpStatus;
      await options.service.rsvp({
        guildId: options.guildId,
        eventId: interaction.options.getString('event-id', true),
        userId: interaction.user.id,
        status,
      });
      await interaction.reply({ content: `RSVP saved: ${status}.`, ephemeral: true });
      break;
    }
    case 'attendance': {
      const attendance = await options.service.attendance(options.guildId, interaction.options.getString('event-id', true));
      await interaction.reply({
        content: `Going: ${attendance.going.length}\nInterested: ${attendance.interested.length}\nDeclined: ${attendance.declined.length}`,
        ephemeral: true,
      });
      break;
    }
    case 'lfg': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) throw new Error('Manage Events permission is required.');
      const post = await options.service.createLfg({
        guildId: options.guildId,
        channelId: interaction.channelId,
        title: interaction.options.getString('title', true),
        startsAt: interaction.options.getString('starts-at', true),
        roles: parseRoleSpec(interaction.options.getString('roles', true)),
        actorId: interaction.user.id,
      });
      await interaction.reply({ content: `LFG posted: \`${post.id}\`.`, ephemeral: true });
      break;
    }
    case 'lfg-close': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) throw new Error('Manage Events permission is required.');
      const id = interaction.options.getString('id', true);
      const closed = await options.service.closeLfg(options.guildId, id, interaction.user.id);
      await interaction.reply({ content: closed ? 'LFG closed.' : 'LFG was already closed or missing.', ephemeral: true });
      break;
    }
    case 'feed-add': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required.');
      const feed = await options.service.addFeed({
        guildId: options.guildId,
        channelId: interaction.channelId,
        kind: interaction.options.getString('kind', true) as FeedRelayRow['kind'],
        source: interaction.options.getString('source', true),
        actorId: interaction.user.id,
      });
      await interaction.reply({ content: `Feed relay created: \`${feed.id}\`.`, ephemeral: true });
      break;
    }
    case 'feed-remove': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required.');
      const removed = await options.service.removeFeed(options.guildId, interaction.options.getString('id', true), interaction.user.id);
      await interaction.reply({ content: removed ? 'Feed relay removed.' : 'No feed relay with that id.', ephemeral: true });
      break;
    }
    case 'feed-list': {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required.');
      const feeds = await options.store.listFeeds(options.guildId);
      const content = feeds.length
        ? feeds.map((feed) => `\`${feed.id}\` ${feed.kind} → <#${feed.channelId}> ${feed.source}`).join('\n').slice(0, 2000)
        : 'No feed relays configured.';
      await interaction.reply({ content, ephemeral: true });
      break;
    }
  }
}

export function startFeedPoller(service: AnnouncementsService, guildId: string, seconds: number): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await service.pollFeeds(guildId);
    } catch (error) {
      log.error('feed_poll_failed', { guildId, err: String(error) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}
