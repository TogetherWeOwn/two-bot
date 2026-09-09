import { PermissionsBitField, type Client, type GuildTextBasedChannel } from 'discord.js';
import { log } from '../core/log.ts';
import { auditEventFields, formatAuditEvent, type AuditChannel, type OperationalAuditEvent } from './events.ts';
import type { OperationalAuditStore, StoredOperationalAudit } from './store.ts';

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
  retryPending(): Promise<number>;
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

  const deliver = async (stored: StoredOperationalAudit): Promise<void> => {
    const channelId = stored.mirrorChannelId;
    if (!channelId) return;
    if (options.dryRun) {
      await options.store?.markDeliveryFailed(stored.event.entryId, 'dry_run');
      log.info('operational_audit_dry_run', { entryId: stored.event.entryId, channelId });
      return;
    }

    const channel = await botCanPost(client, channelId, stored.event.guildId);
    if (!channel) {
      await options.store?.markDeliveryFailed(stored.event.entryId, 'channel_unavailable');
      log.error('operational_audit_undeliverable', {
        entryId: stored.event.entryId,
        channelId,
        reason: 'channel missing, wrong guild, not text, or bot lacks View/Send',
      });
      return;
    }

    try {
      await channel.send({
        content: formatAuditEvent(stored.event),
        allowedMentions: { parse: [] },
      });
      await options.store?.markDelivered(stored.event.entryId);
      log.info('operational_audit_posted', { entryId: stored.event.entryId, channelId });
    } catch (err) {
      await options.store?.markDeliveryFailed(stored.event.entryId, 'discord_send_failed');
      log.error('operational_audit_post_failed', { entryId: stored.event.entryId, channelId, err: String(err) });
    }
  };

  return {
    async record(event) {
      const sourceIsAuditSink = Boolean(event.sourceChannelId && configured.has(event.sourceChannelId));
      const requestedChannelId = sourceIsAuditSink ? null : channelFor(options.channels, event.channel);
      const mirrorChannelId =
        requestedChannelId && options.guildId && event.guildId === options.guildId
          ? requestedChannelId
          : null;

      log.info('operational_audit', auditEventFields(event));

      let inserted = true;
      if (options.store) {
        try {
          inserted = await options.store.record(event, mirrorChannelId);
        } catch (err) {
          log.error('operational_audit_write_failed', { entryId: event.entryId, err: String(err) });
          return false;
        }
      }

      if (sourceIsAuditSink) {
        log.info('operational_audit_tamper_recorded', {
          entryId: event.entryId,
          sourceChannelId: event.sourceChannelId,
        });
        return inserted;
      }
      if (requestedChannelId && !mirrorChannelId) {
        log.error('operational_audit_undeliverable', {
          entryId: event.entryId,
          channelId: requestedChannelId,
          reason: 'event guild is not the configured mirror guild',
        });
        return inserted;
      }
      if (!mirrorChannelId) return inserted;

      if (!options.store) {
        const ephemeral: StoredOperationalAudit = {
          event,
          mirrorChannelId,
          deliveryState: 'delivering',
          deliveryAttempts: 0,
        };
        await deliver(ephemeral);
        return inserted;
      }

      const claimed = await options.store.claim(event.entryId);
      if (claimed) await deliver(claimed);
      return inserted;
    },

    async retryPending() {
      if (!options.store) return 0;
      const pending = await options.store.claimPending();
      for (const item of pending) await deliver(item);
      return pending.length;
    },
  };
}

function channelFor(channels: AuditChannelIds, type: AuditChannel): string | null {
  if (type === 'voice') return channels.voice ?? channels.audit;
  if (type === 'moderation') return channels.moderation ?? channels.audit;
  return channels.audit;
}
