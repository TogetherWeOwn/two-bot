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

interface MirrorChannelAccess {
  channel: GuildTextBasedChannel | null;
  /**
   * True only when the channel/guild/member resolved fine and a specific
   * permission bit was observed missing - a fact we can act on. False for
   * every other reason a channel comes back unusable (not found, fetch threw,
   * wrong guild, no member record): those are indistinguishable from a
   * transient hiccup and must not be treated as a standing denial.
   */
  deniedPermanently: boolean;
}

async function readableMirrorChannel(
  client: Client,
  channelId: string,
  guildId: string,
): Promise<MirrorChannelAccess> {
  const cached = client.channels.cache.get(channelId);
  const channel = cached ?? (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return { channel: null, deniedPermanently: false };
  if (channel.guild.id !== guildId) return { channel: null, deniedPermanently: false };
  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return { channel: null, deniedPermanently: false };
  const perms = channel.permissionsFor(me);
  // ReadMessageHistory is not optional here: every reconciliation and every
  // pre-send dedup scan calls messages.fetch, and ViewChannel alone does not
  // grant that. Missing it is the exact gap that let a revoked read grant
  // masquerade as a healthy mirror (TOG-2240).
  const readable = Boolean(
    perms?.has(PermissionsBitField.Flags.ViewChannel) && perms.has(PermissionsBitField.Flags.ReadMessageHistory),
  );
  return readable ? { channel, deniedPermanently: false } : { channel: null, deniedPermanently: true };
}

async function botCanPost(
  client: Client,
  channelId: string,
  guildId: string,
): Promise<MirrorChannelAccess> {
  const access = await readableMirrorChannel(client, channelId, guildId);
  if (!access.channel) return access;
  const me = access.channel.guild.members.me ?? (await access.channel.guild.members.fetchMe().catch(() => null));
  if (!me) return { channel: null, deniedPermanently: false };
  const canSend = access.channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
  return canSend ? { channel: access.channel, deniedPermanently: false } : { channel: null, deniedPermanently: true };
}

export function makeOperationalAudit(client: Client, options: OperationalAuditOptions): AuditSink {
  const configured = new Set(Object.values(options.channels).filter((id): id is string => Boolean(id)));

  const reconcileDelivered = async (stored: StoredOperationalAudit): Promise<void> => {
    const channelId = stored.mirrorChannelId;
    const messageId = stored.mirrorMessageId;
    if (!options.store || !channelId || !messageId) return;
    const checkedAt = new Date().toISOString();
    const checkpoint = () => options.store!.checkpointMirrorCheck(
      stored.event.entryId,
      messageId,
      stored.mirrorCheckedAt,
      checkedAt,
    );
    const access = await readableMirrorChannel(client, channelId, stored.event.guildId);
    if (!access.channel) {
      if (access.deniedPermanently) {
        await options.store.quarantineDeliveredMirrorUnreadable(
          stored.event.entryId,
          messageId,
          stored.mirrorCheckedAt,
          checkedAt,
          'mirror_channel_permission_revoked',
        );
        log.error('operational_audit_mirror_check_failed', {
          entryId: stored.event.entryId, channelId, classification: 'mirror_channel_permission_revoked',
        });
        return;
      }
      await checkpoint();
      log.error('operational_audit_mirror_check_failed', {
        entryId: stored.event.entryId, channelId, classification: 'mirror_channel_unavailable',
      });
      return;
    }
    const channel = access.channel;

    let message: Message<true>;
    try {
      message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    } catch (err) {
      if (errorStatus(err) === 404) {
        await options.store.quarantineDeliveredMirrorWithEvidence(
          stored.event.entryId,
          messageId,
          stored.mirrorCheckedAt,
          checkedAt,
          'mirror_deleted',
          {
            entryId: `message-delete:${stored.event.guildId}:${messageId}`,
            kind: 'message_delete', channel: 'audit', guildId: stored.event.guildId,
            occurredAt: checkedAt, actorId: null, targetId: null,
            sourceChannelId: channelId, messageId,
            metadata: { auditMirrorEntryId: stored.event.entryId },
          },
        );
        return;
      }
      // A definite 4xx here (403, 401, ...) means the fetch was authoritatively
      // refused, not merely delayed - treating it as transient is exactly what
      // let a revoked read grant checkpoint forever with no alarm (TOG-2240).
      if (isDefiniteSendRejection(err)) {
        await options.store.quarantineDeliveredMirrorUnreadable(
          stored.event.entryId,
          messageId,
          stored.mirrorCheckedAt,
          checkedAt,
          `mirror_fetch_rejected_${errorStatus(err)}`,
        );
        log.error('operational_audit_mirror_check_failed', {
          entryId: stored.event.entryId, channelId, classification: 'mirror_fetch_rejected',
        });
        return;
      }
      await checkpoint();
      log.error('operational_audit_mirror_check_failed', {
        entryId: stored.event.entryId, channelId, classification: 'mirror_fetch_transient',
      });
      return;
    }

    const intact = message.author.id === channel.client.user?.id
      && hasAuditEventIdentity(message.content, stored.event.entryId)
      && message.editedTimestamp === null;
    if (intact) {
      await checkpoint();
      return;
    }
    const editedAt = message.editedTimestamp === null
      ? checkedAt
      : new Date(message.editedTimestamp).toISOString();
    await options.store.quarantineDeliveredMirrorWithEvidence(
      stored.event.entryId,
      messageId,
      stored.mirrorCheckedAt,
      checkedAt,
      'mirror_edited',
      {
        entryId: `message-edit:${stored.event.guildId}:${messageId}:${editedAt}`,
        kind: 'message_edit', channel: 'audit', guildId: stored.event.guildId,
        occurredAt: editedAt, actorId: null, targetId: null,
        sourceChannelId: channelId, messageId,
        metadata: { auditMirrorEntryId: stored.event.entryId },
      },
    );
  };

  const deliver = async (stored: StoredOperationalAudit): Promise<void> => {
    const channelId = stored.mirrorChannelId;
    if (!channelId) return;
    const claimToken = stored.deliveryClaimToken;
    if (options.store && !claimToken) {
      log.error('operational_audit_claim_missing', {
        entryId: stored.event.entryId,
        channelId,
        classification: 'audit_delivery_claim_missing',
      });
      return;
    }
    if (options.dryRun) {
      await options.store?.markDeliveryFailed(stored.event.entryId, claimToken!, 'dry_run');
      log.info('operational_audit_dry_run', { entryId: stored.event.entryId, channelId });
      return;
    }

    const access = await botCanPost(client, channelId, stored.event.guildId);
    if (!access.channel) {
      if (access.deniedPermanently) {
        // A resolved channel/guild/member with a specific bit observed missing
        // is authoritative, not a hiccup - retrying it forever is exactly the
        // gap that let a revoked grant post nothing while never raising an
        // alarm (TOG-2240, widened by TOG-2239 review to the pre-send path).
        await options.store?.quarantineDelivery(
          stored.event.entryId,
          claimToken!,
          'mirror_channel_permission_revoked',
        );
        log.error('operational_audit_undeliverable', {
          entryId: stored.event.entryId,
          channelId,
          reason: 'bot permanently lacks View/ReadHistory/Send on the mirror channel',
          classification: 'mirror_channel_permission_revoked',
        });
        return;
      }
      await options.store?.markDeliveryFailed(stored.event.entryId, claimToken!, 'channel_unavailable');
      log.error('operational_audit_undeliverable', {
        entryId: stored.event.entryId,
        channelId,
        reason: 'channel missing, wrong guild, not text, or bot lacks View/Send',
      });
      return;
    }
    const channel = access.channel;

    let messageId: string | null = null;
    let sendStarted = false;
    try {
      const existing = await findMirror(
        channel,
        stored.event.entryId,
        stored.deliverySearchBefore,
        stored.deliverySearchBefore && options.store
          ? () => options.store!.extendDeliveryLease(stored.event.entryId, claimToken!)
          : undefined,
      );
      if (existing) {
        messageId = existing.id;
      } else if (stored.deliverySearchBefore) {
        // Once the recovery boundary is durable, the Discord post may have
        // succeeded. A missing or edited marker is ambiguous forever: resending
        // could duplicate an accepted message, so every retry must fail closed.
        await options.store?.quarantineDelivery(stored.event.entryId, claimToken!, 'discord_marker_missing');
        log.error('operational_audit_marker_missing', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_marker_missing',
        });
        return;
      } else {
        const searchBefore = await newestMessageCursor(channel);
        await options.store?.prepareDeliverySend(stored.event.entryId, claimToken!, searchBefore);
        sendStarted = true;
        const message = await channel.send({
          content: formatAuditEvent(stored.event),
          allowedMentions: { parse: [] },
          nonce: stored.deliveryNonce ?? deliveryNonce(stored.event.entryId),
          enforceNonce: true,
        });
        messageId = message.id;
      }
    } catch (err) {
      if (sendStarted && isDefiniteSendRejection(err)) {
        try {
          await options.store?.markDeliveryFailed(
            stored.event.entryId,
            claimToken!,
            `discord_send_rejected_${errorStatus(err)}`,
            true,
          );
        } catch {
          // Another worker may own the row after the definite rejection.
        }
        log.error('operational_audit_post_failed', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_send_rejected',
        });
      } else if (sendStarted) {
        try {
          await options.store?.markAcknowledgementFailed(stored.event.entryId, claimToken!);
        } catch {
          // Preserve the lease after an accepted send if the store is unavailable.
        }
        log.error('operational_audit_post_ambiguous', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_post_ambiguous',
        });
      } else if (isDefiniteSendRejection(err)) {
        // findMirror/newestMessageCursor throwing a definite 4xx before any
        // send means Discord authoritatively refused the read - identical in
        // kind to the reconciliation-side permission revocation above, and
        // markDeliveryFailed would requeue it as 'pending' to retry forever.
        try {
          await options.store?.quarantineDelivery(
            stored.event.entryId,
            claimToken!,
            `discord_fetch_rejected_${errorStatus(err)}`,
          );
        } catch {
          // Another worker may have replaced this claim before send authorization.
          // Its token owns the row now; the stale worker must not mutate it.
        }
        log.error('operational_audit_post_failed', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_fetch_rejected',
        });
      } else {
        try {
          await options.store?.markDeliveryFailed(
            stored.event.entryId,
            claimToken!,
            'discord_send_failed',
            !stored.deliverySearchBefore,
          );
        } catch {
          // Another worker may have replaced this claim before send authorization.
          // Its token owns the row now; the stale worker must not mutate it.
        }
        log.error('operational_audit_post_failed', {
          entryId: stored.event.entryId,
          channelId,
          classification: 'discord_send_failed',
        });
      }
      return;
    }

    try {
      await options.store?.markDelivered(stored.event.entryId, claimToken!, messageId);
      log.info('operational_audit_posted', { entryId: stored.event.entryId, channelId, messageId });
    } catch {
      // The durable marker remains visible in Discord even after the nonce
      // uniqueness window expires. A later retry scans for it before sending.
      try {
        await options.store?.markAcknowledgementFailed(stored.event.entryId, claimToken!);
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
          deliveryClaimToken: null,
          deliveryNonce: deliveryNonce(event.entryId),
          deliverySearchBefore: null,
          mirrorMessageId: null,
          mirrorCheckedAt: null,
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
      const delivered = await options.store.selectDeliveredForReconciliation();
      for (const item of delivered) {
        try {
          await reconcileDelivered(item);
        } catch {
          log.error('operational_audit_mirror_check_failed', {
            entryId: item.event.entryId,
            channelId: item.mirrorChannelId,
            classification: 'mirror_reconciliation_failed',
          });
        }
      }
      return pending.length;
    },
  };
}

async function newestMessageCursor(channel: GuildTextBasedChannel): Promise<string> {
  const messages = await channel.messages.fetch({ limit: 1, cache: false });
  const newestId = messages.first()?.id;
  return newestId ? nextSnowflake(newestId) : '0';
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

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : null;
}

function isDefiniteSendRejection(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== null && Number.isInteger(status) && status >= 400 && status < 500;
}

function channelFor(channels: AuditChannelIds, type: AuditChannel): string | null {
  if (type === 'voice') return channels.voice ?? channels.audit;
  if (type === 'moderation') return channels.moderation ?? channels.audit;
  return channels.audit;
}
