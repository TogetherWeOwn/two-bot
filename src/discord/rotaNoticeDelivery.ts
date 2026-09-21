import type { Client, Message, TextChannel } from 'discord.js';
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
  rota: Pick<OnboardingRota, 'dueNotices' | 'confirmNoticeEligible' | 'withNoticeEligibility'>;
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

const HISTORY_PAGE_LIMIT = 5;
class UncertainHistory extends Error {}

/** Durable, fail-closed delivery over the existing operational-audit claim machine. */
export class RotaNoticeDelivery {
  private client: Client;
  private config: RotaNoticeDeliveryConfig;
  private deps: RotaNoticeDeliveryDeps;
  private stopped = false;

  constructor(client: Client, config: RotaNoticeDeliveryConfig, deps: RotaNoticeDeliveryDeps) {
    this.client = client;
    this.config = { ...config, readerIds: [...config.readerIds] };
    this.deps = deps;
  }

  /** Prevent new POSTs, including work already waiting on access/history I/O. */
  stop(): void { this.stopped = true; }

  async runDue(now: string, limit = 25): Promise<RotaNoticeOutcome[]> {
    if (this.stopped) return [];
    let candidates: RotaNoticeCandidate[];
    try {
      candidates = await this.deps.rota.dueNotices(this.config.guildId, now, limit);
    } catch {
      log.error('rota_notice_sweep_failed', { classification: 'rota_notice_sweep_failed' });
      return [];
    }
    const outcomes: RotaNoticeOutcome[] = [];
    for (const candidate of candidates) {
      if (this.stopped) break;
      // Source/action channel and staff destination are deliberately distinct.
      outcomes.push(await this.deliverOne(candidate, now));
    }
    return outcomes;
  }

  private async deliverOne(candidate: RotaNoticeCandidate, now: string): Promise<RotaNoticeOutcome> {
    let payload;
    try {
      payload = formatRotaNotice(candidate, {
        guildId: this.config.guildId, destinationChannelId: this.config.noticeChannelId,
      });
    } catch {
      log.error('rota_notice_candidate_invalid', { classification: 'rota_notice_candidate_invalid' });
      return { status: 'suppressed', entryId: rotaNoticeEntryId(this.config.guildId, candidate.memberId, candidate.actionId),
        reason: 'candidate_invalid' };
    }
    const { entryId } = payload;
    const confirmed = await this.deps.rota.confirmNoticeEligible(
      this.config.guildId, candidate.memberId, candidate.actionId, candidate.channelId, now,
    ).catch(() => null);
    if (!confirmed) return { status: 'suppressed', entryId, reason: 'no_longer_eligible' };

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
      const existing = await this.deps.store.get(entryId).catch(() => null);
      if (existing?.deliveryState === 'delivered' && existing.mirrorMessageId) {
        return { status: 'recovered', entryId, messageId: existing.mirrorMessageId };
      }
      return { status: 'suppressed', entryId, reason: 'claim_lost' };
    }
    const claimToken = claimed.deliveryClaimToken;
    const recovering = claimed.deliverySearchBefore !== null;
    // A restart with changed config must not redirect an existing notice or
    // search a different channel and mistake absence there for non-delivery.
    if (claimed.event.kind !== 'rota_notice' || claimed.event.guildId !== this.config.guildId ||
        claimed.mirrorChannelId !== this.config.noticeChannelId ||
        claimed.event.destinationChannelId !== this.config.noticeChannelId ||
        claimed.event.sourceChannelId !== candidate.channelId || claimed.event.messageId !== candidate.actionId ||
        claimed.event.targetId !== candidate.memberId) {
      await this.quarantine(entryId, claimToken, 'delivery_binding_changed');
      return { status: 'failed', entryId, classification: 'delivery_binding_changed' };
    }
    if (this.stopped || await this.halted(entryId)) {
      return this.hold(entryId, claimToken, recovering);
    }

    const channel = await this.channel();
    if (!channel) {
      await this.fail(entryId, claimToken, 'access_refused', false);
      return { status: 'failed', entryId, classification: 'access_refused' };
    }

    let messageId: string | null = null;
    let sendStarted = false;
    try {
      if (recovering) {
        messageId = await findNotice(channel, entryId, claimed.deliverySearchBefore!, () =>
          this.deps.store.extendDeliveryLease(entryId, claimToken));
        if (!messageId) {
          await this.quarantine(entryId, claimToken, 'discord_marker_missing');
          return { status: 'failed', entryId, classification: 'discord_marker_missing' };
        }
        if (this.stopped || await this.halted(entryId)) return this.hold(entryId, claimToken, true);
        await this.deps.store.extendDeliveryLease(entryId, claimToken);
      } else {
        // No prior boundary means no earlier POST could have begun. Only
        // recovery walks history; a fresh claim needs one durable cursor.
        const searchBefore = await newestMessageCursor(channel);
        const finalChannel = await this.channel();
        if (!finalChannel) {
          await this.fail(entryId, claimToken, 'access_refused', true);
          return { status: 'failed', entryId, classification: 'access_refused' };
        }
        let held = false;
        messageId = await this.deps.rota.withNoticeEligibility(
          this.config.guildId, candidate.memberId, candidate.actionId, candidate.channelId, now,
          async () => {
            // The subject lock serializes this authorization/POST with human
            // stop writes. No Discord inspection is done while holding it.
            if (this.stopped) { held = true; return null; }
            // Token-fenced lease renewal and recovery cursor persist before POST.
            await this.deps.store.prepareDeliverySend(entryId, claimToken, searchBefore);
            if (this.stopped || await this.halted(entryId)) { held = true; return null; }
            await this.deps.store.extendDeliveryLease(entryId, claimToken);
            if (this.stopped) { held = true; return null; }
            sendStarted = true;
            const message = await finalChannel.send({
              content: payload.content, allowedMentions: { parse: [] },
              nonce: claimed.deliveryNonce ?? deliveryNonce(entryId), enforceNonce: true,
            });
            if (!validSnowflake(message.id)) throw new Error('invalid_send_response');
            return message.id;
          },
        );
        if (!messageId) {
          if (held) return this.hold(entryId, claimToken, false);
          await this.fail(entryId, claimToken, 'no_longer_eligible', true);
          return { status: 'suppressed', entryId, reason: 'no_longer_eligible' };
        }
      }
    } catch (err) {
      if (sendStarted && isDefiniteRejection(err)) {
        await this.fail(entryId, claimToken, `discord_send_rejected_${errorStatus(err)}`, true);
        return { status: 'failed', entryId, classification: 'discord_send_rejected' };
      } else if (sendStarted) {
        try { await this.deps.store.markAcknowledgementFailed(entryId, claimToken); } catch { /* Preserve lease. */ }
        log.error('rota_notice_post_ambiguous', { entryId, classification: 'discord_post_ambiguous' });
        return { status: 'failed', entryId, classification: 'discord_post_ambiguous' };
      } else if (err instanceof UncertainHistory) {
        await this.quarantine(entryId, claimToken, 'discord_history_uncertain');
        return { status: 'failed', entryId, classification: 'discord_history_uncertain' };
      } else if (isDefiniteRejection(err)) {
        await this.quarantine(entryId, claimToken, `discord_fetch_rejected_${errorStatus(err)}`);
        return { status: 'failed', entryId, classification: 'discord_fetch_rejected' };
      }
      await this.fail(entryId, claimToken, 'discord_send_failed', !recovering);
      return { status: 'failed', entryId, classification: 'discord_send_failed' };
    }

    try {
      await this.deps.store.markDelivered(entryId, claimToken, messageId);
      log.info(recovering ? 'rota_notice_recovered' : 'rota_notice_posted', {
        entryId, channelId: this.config.noticeChannelId, messageId,
      });
      return { status: recovering ? 'recovered' : 'sent', entryId, messageId };
    } catch {
      try { await this.deps.store.markAcknowledgementFailed(entryId, claimToken); } catch { /* Preserve lease. */ }
      log.error('rota_notice_ack_failed', { entryId, classification: 'delivery_ack_failed' });
      return { status: 'failed', entryId, classification: 'delivery_ack_failed' };
    }
  }

  private async channel(): Promise<TextChannel | null> {
    const verify = this.deps.verifyAccess ?? verifyRotaNoticeAccess;
    const channel = await verify(this.client, {
      guildId: this.config.guildId, channelId: this.config.noticeChannelId, allowedReaderIds: this.config.readerIds,
    }).catch(() => null);
    return channel?.id === this.config.noticeChannelId && channel.guild.id === this.config.guildId ? channel : null;
  }

  private async halted(entryId: string): Promise<boolean> {
    try {
      return await this.deps.store.isDeliveryHalted();
    } catch {
      log.error('rota_notice_kill_switch_read_failed', { entryId, classification: 'rota_notice_kill_switch_read_failed' });
      return true;
    }
  }

  private async hold(entryId: string, claimToken: string, recovering: boolean): Promise<RotaNoticeOutcome> {
    if (recovering) {
      // holdDeliveryForHalt clears the boundary. That is safe only when this
      // claim knows no POST began, never for an ambiguous previous attempt.
      await this.fail(entryId, claimToken, 'audit_kill_switch_held', false);
    } else {
      try { await this.deps.store.holdDeliveryForHalt(entryId, claimToken); } catch { /* Lease expiry is the backstop. */ }
    }
    return { status: 'held', entryId };
  }

  private async fail(entryId: string, claimToken: string, classification: string, clearSearchBefore: boolean): Promise<void> {
    try { await this.deps.store.markDeliveryFailed(entryId, claimToken, classification, clearSearchBefore); } catch {
      // A stale worker must not mutate a replacement claimant's state.
    }
    log.error('rota_notice_undeliverable', { entryId, classification });
  }

  private async quarantine(entryId: string, claimToken: string, classification: string): Promise<void> {
    try { await this.deps.store.quarantineDelivery(entryId, claimToken, classification); } catch {
      // A stale worker must not mutate a replacement claimant's state.
    }
    log.error('rota_notice_quarantined', { entryId, classification });
  }
}

function validSnowflake(id: unknown): id is string {
  return typeof id === 'string' && /^\d{17,20}$/.test(id) && BigInt(id) <= 18_446_744_073_709_551_615n;
}

function validatePage(channel: TextChannel, rows: readonly Message[], limit: number, before?: string): void {
  if (rows.length > limit) throw new UncertainHistory();
  let previous = before;
  for (const message of rows) {
    if (!validSnowflake(message.id) || message.partial !== false || message.guildId !== channel.guild.id ||
        message.channelId !== channel.id || !validSnowflake(message.author?.id) ||
        typeof message.author.bot !== 'boolean' || typeof message.content !== 'string' ||
        (previous !== undefined && BigInt(message.id) >= BigInt(previous))) throw new UncertainHistory();
    previous = message.id;
  }
}

async function newestMessageCursor(channel: TextChannel): Promise<string> {
  const messages = await channel.messages.fetch({ limit: 1, cache: false });
  const rows = [...messages.values()];
  validatePage(channel, rows, 1);
  return rows.length ? (BigInt(rows[0].id) + 1n).toString() : '0';
}

async function findNotice(
  channel: TextChannel, entryId: string, searchBefore: string, renewLease: () => Promise<unknown>,
): Promise<string | null> {
  if (searchBefore !== '0' && !validSnowflake(searchBefore)) throw new UncertainHistory();
  let before: string | undefined;
  let found: string | null = null;
  for (let page = 0; page < HISTORY_PAGE_LIMIT; page++) {
    await renewLease();
    const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
    const rows = [...messages.values()];
    validatePage(channel, rows, 100, before);
    for (const message of rows) {
      if (BigInt(message.id) < BigInt(searchBefore)) return found;
      if (message.author.id === channel.client.user?.id && message.author.bot && message.webhookId === null &&
          message.system === false && hasRotaNoticeIdentity(message.content, entryId)) {
        if (found) throw new UncertainHistory();
        found = message.id;
      }
    }
    if (rows.length < 100) return found;
    before = rows[rows.length - 1].id;
  }
  // Even one marker is insufficient if the remaining window was not checked.
  throw new UncertainHistory();
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
