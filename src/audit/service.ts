import { PermissionsBitField, type Client, type GuildTextBasedChannel } from 'discord.js';
import { log } from '../core/log.ts';
import { auditEventFields, formatAuditEvent, type AuditChannel, type OperationalAuditEvent } from './events.ts';
import type { OperationalAuditStore } from './store.ts';

export interface AuditChannelIds {
  audit: string | null;
  voice: string | null;
  moderation: string | null;
}

export interface OperationalAuditOptions {
  /** Mirrors are disabled unless events are constrained to one configured guild. */
  guildId: string | null;
  channels: AuditChannelIds;
  store?: OperationalAuditStore | null;
  dryRun?: boolean;
}

export interface AuditSink {
  record(event: OperationalAuditEvent): Promise<boolean>;
}

async function botCanPost(
  client: Client,
  channelId: string,
  guildId: string,
): Promise<GuildTextBasedChannel | null> {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  if (channel.guild.id !== guildId) return null;
  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return null;
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) return null;
  if (!permissions.has(PermissionsBitField.Flags.SendMessages)) return null;
  return channel;
}

export function makeOperationalAudit(client: Client, options: OperationalAuditOptions): AuditSink {
  const configured = new Set(Object.values(options.channels).filter((id): id is string => Boolean(id)));

  return {
    async record(event) {
      // The Discord mirror is itself a message. Never let it recursively audit
      // its own posts, even if the bot's user id is unavailable on a partial.
      if (event.sourceChannelId && configured.has(event.sourceChannelId)) return false;

      log.info('operational_audit', auditEventFields(event));

      let inserted = true;
      if (options.store) {
        try {
          inserted = await options.store.record(event);
        } catch (err) {
          log.error('operational_audit_write_failed', { entryId: event.entryId, err: String(err) });
          inserted = false;
        }
      }
      if (!inserted) return false;

      const channelId = channelFor(options.channels, event.channel);
      if (!channelId) return true;
      if (!options.guildId || event.guildId !== options.guildId) {
        log.error('operational_audit_undeliverable', {
          entryId: event.entryId,
          channelId,
          reason: 'event guild is not the configured mirror guild',
        });
        return true;
      }
      if (options.dryRun) {
        log.info('operational_audit_dry_run', { entryId: event.entryId, channelId });
        return true;
      }

      const channel = await botCanPost(client, channelId, event.guildId);
      if (!channel) {
        log.error('operational_audit_undeliverable', {
          entryId: event.entryId,
          channelId,
          reason: 'channel missing, wrong guild, not text, or bot lacks View/Send',
        });
        return true;
      }

      try {
        await channel.send({
          content: formatAuditEvent(event),
          allowedMentions: { parse: [] },
        });
        log.info('operational_audit_posted', { entryId: event.entryId, channelId });
      } catch (err) {
        log.error('operational_audit_post_failed', { entryId: event.entryId, channelId, err: String(err) });
      }
      return true;
    },
  };
}

function channelFor(channels: AuditChannelIds, type: AuditChannel): string | null {
  if (type === 'voice') return channels.voice ?? channels.audit;
  if (type === 'moderation') return channels.moderation ?? channels.audit;
  return channels.audit;
}
