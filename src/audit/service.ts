import { PermissionsBitField, type Client, type GuildTextBasedChannel, type Message } from 'discord.js';
import { log } from '../core/log.ts';
import {
  auditEventFields,
  formatAuditEvent,
  hasAuditEventIdentity,
  type AuditChannel,
  type OperationalAuditEvent,
} from './events.ts';
import { deliveryNonce, type OperationalAuditStore, type StoredOperationalAudit } from './store.ts';

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

    let messageId: string | null = null;
    let sendStarted = false;
    try {
      const existing = await findMirror(
        channel,
        stored.event.entryId,
        stored.deliverySearchBefore,
        stored.deliverySearchBefore && options.store
          ? () => options.store!.extendDeliveryLease(stored.event.entryId)
          : undefined,
      );
      if (existing) {
        messageId = existing.id;
      } else if (stored.deliverySearchBefore) {
        // Once the recovery boundary is durable, the Discord post may have
        // succeeded. A missing or edited marker is ambiguous forever: resending
        // could duplicate an accepted message, so every retry must fail closed.
        await options.store?.markDeliveryFailed(stored.event.entryId, 'discord_marker_missing');
        log.error('operational_audit_marker_missing', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_marker_missing',
        });
        return;
      } else {
        const searchBefore = await newestMessageCursor(channel);
        await options.store?.saveDeliverySearchBefore(stored.event.entryId, searchBefore);
        sendStarted = true;
        const message = await channel.send({
          content: formatAuditEvent(stored.event),
          allowedMentions: { parse: [] },
          nonce: stored.deliveryNonce ?? deliveryNonce(stored.event.entryId),
          enforceNonce: true,
        });
        messageId = message.id;
      }
    } catch {
      if (sendStarted) {
        try {
          await options.store?.markAcknowledgementFailed(stored.event.entryId);
        } catch {
          // Preserve the lease after an accepted send if the store is unavailable.
        }
        log.error('operational_audit_post_ambiguous', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_post_ambiguous',
        });
      } else {
        await options.store?.markDeliveryFailed(stored.event.entryId, 'discord_send_failed');
        log.error('operational_audit_post_failed', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_send_failed',
        });
      }
      return;
    }

    try {
      await options.store?.markDelivered(stored.event.entryId, messageId);
      log.info('operational_audit_posted', { entryId: stored.event.entryId, channelId, messageId });
    } catch {
      // The durable marker remains visible in Discord even after the nonce
      // uniqueness window expires. A later retry scans for it before sending.
      try {
        await options.store?.markAcknowledgementFailed(stored.event.entryId);
      } catch {
        // The original acknowledgement write already proved the store may be
        // unavailable. Keep the lease for marker reconciliation on retry.
      }
      log.error('operational_audit_ack_failed', {
        entryId: stored.event.entryId,
        channelId,
        messageId,
        classification: 'delivery_ack_failed',
      });
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
          log.error('operational_audit_write_failed', {
            entryId: event.entryId,
            classification: 'audit_store_write_failed',
          });
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
          deliveryNonce: deliveryNonce(event.entryId),
          deliverySearchBefore: null,
          mirrorMessageId: null,
          deliveryLastError: null,
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

async function newestMessageCursor(channel: GuildTextBasedChannel): Promise<string> {
  const messages = await channel.messages.fetch({ limit: 1, cache: false });
  const newestId = messages.first()?.id;
  return newestId ? nextSnowflake(newestId) : currentDiscordSnowflake();
}

async function findMirror(
  channel: GuildTextBasedChannel,
  entryId: string,
  searchBefore: string | null,
  renewLease?: () => Promise<void>,
): Promise<Message<true> | null> {
  let before: string | undefined;
  let page = 0;
  while (searchBefore || page < 5) {
    await renewLease?.();
    const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
    const match = messages.find(
      (message) =>
        (!searchBefore || BigInt(message.id) >= BigInt(searchBefore)) &&
        message.author.id === channel.client.user?.id &&
        hasAuditEventIdentity(message.content, entryId),
    );
    if (match) return match;

    const oldestId = messages.last()?.id;
    if (!oldestId) return null;
    if (searchBefore && BigInt(oldestId) < BigInt(searchBefore)) return null;
    if (messages.size < 100) return null;
    before = oldestId;
    page++;
  }
  return null;
}

function nextSnowflake(messageId: string): string {
  return (BigInt(messageId) + 1n).toString();
}

function currentDiscordSnowflake(): string {
  const discordEpoch = 1_420_070_400_000n;
  return ((BigInt(Date.now()) - discordEpoch) << 22n).toString();
}

function channelFor(channels: AuditChannelIds, type: AuditChannel): string | null {
  if (type === 'voice') return channels.voice ?? channels.audit;
  if (type === 'moderation') return channels.moderation ?? channels.audit;
  return channels.audit;
}
