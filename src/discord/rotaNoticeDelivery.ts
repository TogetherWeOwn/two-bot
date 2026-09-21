import type { Client, TextChannel } from 'discord.js';
import type { OnboardingRota, RotaNoticeCandidate } from '../analytics/onboardingRota.ts';
import type { OperationalAuditStore } from '../audit/store.ts';
import { deliveryNonce } from '../audit/store.ts';
import { log } from '../core/log.ts';
import { formatRotaNotice, hasRotaNoticeIdentity, rotaNoticeEntryId } from './rotaNoticePayload.ts';
import { verifyRotaNoticeAccess } from './rotaNoticeAccess.ts';

export interface RotaNoticeDeliveryConfig {
  guildId: string;
  noticeChannelId: string;
  /** Explicit authorized readers, from TWO_ONBOARDING_ROTA_READER_IDS. */
  readerIds: readonly string[];
}

export interface RotaNoticeDeliveryDeps {
  rota: Pick<OnboardingRota, 'dueNotices' | 'confirmNoticeEligible'>;
  store: Pick<OperationalAuditStore,
    'record' | 'claim' | 'prepareDeliverySend' | 'extendDeliveryLease' |
    'markDelivered' | 'markAcknowledgementFailed' | 'markDeliveryFailed' |
    'quarantineDelivery' | 'isDeliveryHalted' | 'holdDeliveryForHalt' | 'get'>;
  verifyAccess?: typeof verifyRotaNoticeAccess;
}

export type RotaNoticeOutcome =
  | { status: 'sent'; entryId: string; messageId: string }
  | { status: 'recovered'; entryId: string; messageId: string }
  | { status: 'suppressed'; entryId: string; reason: string }
  | { status: 'held'; entryId: string }
  | { status: 'failed'; entryId: string; classification: string };

/**
 * Durable rota fallback-notice delivery over the existing operational-audit
 * claim machine. One deterministic entry id per subject/action; atomic claim
 * with lease/token ownership; lock-scoped eligibility recheck; fail-closed
 * ambiguous-send recovery through the durable content marker. No fallback
 * destination, no permission writes, no conversational reply.
 */
export class RotaNoticeDelivery {
  private client: Client;
  private config: RotaNoticeDeliveryConfig;
  private deps: RotaNoticeDeliveryDeps;

  constructor(client: Client, config: RotaNoticeDeliveryConfig, deps: RotaNoticeDeliveryDeps) {
    this.client = client;
    this.config = { ...config, readerIds: [...config.readerIds] };
    this.deps = deps;
  }

  /** One bounded sweep: due candidates are claimed, rechecked, verified, sent. */
  async runDue(now: string, limit = 25): Promise<RotaNoticeOutcome[]> {
    let candidates: RotaNoticeCandidate[];
    try {
      candidates = await this.deps.rota.dueNotices(this.config.guildId, now, limit);
    } catch {
      log.error('rota_notice_sweep_failed', { classification: 'rota_notice_sweep_failed' });
      return [];
    }
    const outcomes: RotaNoticeOutcome[] = [];
    for (const candidate of candidates) {
      // The candidate's channelId is the newcomer's source/action channel; the
      // notice always goes to the configured staff destination. The two are
      // different ids in any real deployment, so no comparison here: the
      // destination is fixed config, and deliverOne validates the candidate,
      // rechecks persisted eligibility, and verifies access before sending.
      outcomes.push(await this.deliverOne(candidate, now));
    }
    return outcomes;
  }

  private async suppress(candidate: RotaNoticeCandidate, reason: string): Promise<RotaNoticeOutcome> {
    return { status: 'suppressed', entryId: rotaNoticeEntryId(this.config.guildId, candidate.memberId, candidate.actionId), reason };
  }

  private async deliverOne(candidate: RotaNoticeCandidate, now: string): Promise<RotaNoticeOutcome> {
    let payload;
    try {
      payload = formatRotaNotice(candidate, {
        guildId: this.config.guildId, destinationChannelId: this.config.noticeChannelId,
      });
    } catch {
      log.error('rota_notice_candidate_invalid', { classification: 'rota_notice_candidate_invalid' });
      return this.suppress(candidate, 'candidate_invalid');
    }
    const { entryId } = payload;

    // Lock-scoped recheck under the subject lock: a reply or acknowledgement
    // persisted after the read-only snapshot must still suppress the send.
    const confirmed = await this.deps.rota.confirmNoticeEligible(
      this.config.guildId, candidate.memberId, candidate.actionId, candidate.channelId, now,
    ).catch(() => null);
    if (!confirmed) return { status: 'suppressed', entryId, reason: 'no_longer_eligible' };

    // Durable once-per-subject/action row. record() is idempotent by entry id:
    // the first sweep creates the pending row, later sweeps reuse it, and the
    // fixed dueAt comes from the original first-action fact, never the clock.
    try {
      await this.deps.store.record({
        entryId, kind: 'rota_notice', channel: 'audit', guildId: this.config.guildId,
        occurredAt: confirmed.dueAt, actorId: null, targetId: candidate.memberId,
        sourceChannelId: candidate.channelId, destinationChannelId: this.config.noticeChannelId,
        messageId: candidate.actionId, action: 'rota_fallback_notice',
        metadata: { coverageBlock: candidate.coverageBlock, dueAt: confirmed.dueAt },
      }, this.config.noticeChannelId);
    } catch {
      log.error('rota_notice_claim_failed', { entryId, classification: 'rota_notice_claim_failed' });
      return { status: 'failed', entryId, classification: 'claim_write_failed' };
    }
    const claimed = await this.deps.store.claim(entryId).catch(() => null);
    if (!claimed?.deliveryClaimToken) {
      // Another worker owns the claim (or the row is delivered/quarantined):
      // exactly-once means this worker stops, it does not resend.
      const existing = await this.deps.store.get(entryId).catch(() => null);
      if (existing?.deliveryState === 'delivered' && existing.mirrorMessageId) {
        return { status: 'recovered', entryId, messageId: existing.mirrorMessageId };
      }
      return { status: 'suppressed', entryId, reason: 'claim_lost' };
    }
    const claimToken = claimed.deliveryClaimToken;

    // Kill switch outranks everything downstream of the durable write.
    let halted = false;
    try {
      halted = await this.deps.store.isDeliveryHalted();
    } catch {
      log.error('rota_notice_kill_switch_read_failed', { entryId, classification: 'rota_notice_kill_switch_read_failed' });
    }
    if (halted) {
      try {
        await this.deps.store.holdDeliveryForHalt(entryId, claimToken);
      } catch {
        // Lease expiry is the backstop for a claim this process could not release.
      }
      return { status: 'held', entryId };
    }

    // Fresh effective-reader snapshot immediately before send. Non-atomic by
    // construction; a refusal fails closed with no fallback destination.
    const verify = this.deps.verifyAccess ?? verifyRotaNoticeAccess;
    const channel = await verify(this.client, {
      guildId: this.config.guildId, channelId: this.config.noticeChannelId,
      allowedReaderIds: this.config.readerIds,
    }).catch(() => null);
    if (!channel) {
      await this.fail(entryId, claimToken, 'access_refused', false);
      return { status: 'failed', entryId, classification: 'access_refused' };
    }

    let messageId: string | null = null;
    let sendStarted = false;
    let recovered = false;
    try {
      const existing = await findNotice(channel, entryId, claimed.deliverySearchBefore, () =>
        this.deps.store.extendDeliveryLease(entryId, claimToken).catch(() => undefined));
      if (existing) {
        // The durable marker proves an earlier POST landed: reconcile it,
        // never resend. This covers both the ambiguous-POST retry and the
        // crash-after-POST-before-ack recovery.
        messageId = existing;
        recovered = true;
      } else if (claimed.deliverySearchBefore) {
        // Recovery boundary is durable: the post may have succeeded. Missing
        // marker is ambiguous forever; resending could duplicate. Fail closed.
        await this.quarantine(entryId, claimToken, 'discord_marker_missing');
        return { status: 'failed', entryId, classification: 'discord_marker_missing' };
      } else {
        const searchBefore = await newestMessageCursor(channel);
        await this.deps.store.prepareDeliverySend(entryId, claimToken, searchBefore);
        if (await this.halted(entryId)) {
          try {
            await this.deps.store.holdDeliveryForHalt(entryId, claimToken);
          } catch {
            // Lease expiry is the backstop.
          }
          return { status: 'held', entryId };
        }
        sendStarted = true;
        const message = await channel.send({
          content: payload.content,
          allowedMentions: { parse: [] },
          nonce: claimed.deliveryNonce ?? deliveryNonce(entryId),
          enforceNonce: true,
        });
        messageId = message.id;
      }
    } catch (err) {
      if (sendStarted && isDefiniteRejection(err)) {
        await this.fail(entryId, claimToken, `discord_send_rejected_${errorStatus(err)}`, true);
        return { status: 'failed', entryId, classification: 'discord_send_rejected' };
      } else if (sendStarted) {
        try {
          await this.deps.store.markAcknowledgementFailed(entryId, claimToken);
        } catch {
          // Preserve the lease after an accepted send if the store is unavailable.
        }
        log.error('rota_notice_post_ambiguous', { entryId, classification: 'discord_post_ambiguous' });
        return { status: 'failed', entryId, classification: 'discord_post_ambiguous' };
      } else if (isDefiniteRejection(err)) {
        await this.quarantine(entryId, claimToken, `discord_fetch_rejected_${errorStatus(err)}`);
        return { status: 'failed', entryId, classification: 'discord_fetch_rejected' };
      }
      await this.fail(entryId, claimToken, 'discord_send_failed', !claimed.deliverySearchBefore);
      return { status: 'failed', entryId, classification: 'discord_send_failed' };
    }

    try {
      await this.deps.store.markDelivered(entryId, claimToken, messageId!);
      if (recovered) {
        log.info('rota_notice_recovered', { entryId, channelId: this.config.noticeChannelId, messageId });
        return { status: 'recovered', entryId, messageId: messageId! };
      }
      log.info('rota_notice_posted', { entryId, channelId: this.config.noticeChannelId, messageId });
      return { status: 'sent', entryId, messageId: messageId! };
    } catch {
      try {
        await this.deps.store.markAcknowledgementFailed(entryId, claimToken);
      } catch {
        // Keep the lease for marker reconciliation on retry.
      }
      log.error('rota_notice_ack_failed', { entryId, messageId, classification: 'delivery_ack_failed' });
      return { status: 'failed', entryId, classification: 'delivery_ack_failed' };
    }
  }

  private async halted(entryId: string): Promise<boolean> {
    try {
      return await this.deps.store.isDeliveryHalted();
    } catch {
      log.error('rota_notice_kill_switch_read_failed', { entryId, classification: 'rota_notice_kill_switch_read_failed' });
      return false;
    }
  }

  private async fail(entryId: string, claimToken: string, classification: string, clearSearchBefore: boolean): Promise<void> {
    try {
      await this.deps.store.markDeliveryFailed(entryId, claimToken, classification, clearSearchBefore);
    } catch {
      // Another worker may own the row now; the stale worker must not mutate it.
    }
    log.error('rota_notice_undeliverable', { entryId, classification });
  }

  private async quarantine(entryId: string, claimToken: string, classification: string): Promise<void> {
    try {
      await this.deps.store.quarantineDelivery(entryId, claimToken, classification);
    } catch {
      // Another worker may own the row now; the stale worker must not mutate it.
    }
    log.error('rota_notice_quarantined', { entryId, classification });
  }
}

async function newestMessageCursor(channel: TextChannel): Promise<string> {
  const messages = await channel.messages.fetch({ limit: 1, cache: false });
  const newestId = messages.first()?.id;
  return newestId ? (BigInt(newestId) + 1n).toString() : '0';
}

async function findNotice(
  channel: TextChannel,
  entryId: string,
  searchBefore: string | null,
  renewLease?: () => Promise<unknown>,
): Promise<string | null> {
  let before: string | undefined;
  let page = 0;
  while (searchBefore || page < 5) {
    await renewLease?.();
    const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
    const match = messages.find(
      (message) =>
        (!searchBefore || BigInt(message.id) >= BigInt(searchBefore)) &&
        message.author.id === channel.client.user?.id &&
        hasRotaNoticeIdentity(message.content, entryId),
    );
    if (match) return match.id;
    const oldestId = messages.last()?.id;
    if (!oldestId) return null;
    if (searchBefore && BigInt(oldestId) < BigInt(searchBefore)) return null;
    if (messages.size < 100) return null;
    before = oldestId;
    page++;
  }
  return null;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : null;
}

function isDefiniteRejection(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== null && Number.isInteger(status) && status >= 400 && status < 500;
}
