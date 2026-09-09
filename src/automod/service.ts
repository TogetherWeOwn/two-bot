import { createHash } from 'node:crypto';
import { ActionError } from '../internal/errors.ts';
import type { ModerationDiscordClient } from '../moderation/discord.ts';
import type { ModerationExecution } from '../moderation/service.ts';
import type { ModerationService } from '../moderation/service.ts';
import type { ModerationStore } from '../moderation/store.ts';
import type { ModerationTarget } from '../moderation/types.ts';
import { log } from '../core/log.ts';
import { matchAutomod, MemoryRepeatTracker, type RepeatTracker } from './matcher.ts';
import type { AutomodStore } from './store.ts';
import { AutomodProcessingError, type AutomodMessage, type AutomodPolicy, type AutomodResult, type AutomodSanction } from './types.ts';

export interface AutomodTargetResolver {
  target(guildId: string, userId: string): Promise<ModerationTarget>;
}

export interface AutomodServiceOptions {
  dryRun: boolean;
  owenUserId: string;
  botHighestRolePosition: number;
  policy: AutomodPolicy;
}

export class AutomodService {
  private discord: ModerationDiscordClient;
  private moderation: ModerationService;
  private moderationStore: ModerationStore;
  private automodStore: AutomodStore;
  private resolver: AutomodTargetResolver;
  private options: AutomodServiceOptions;
  private repeats: RepeatTracker;

  constructor(
    discord: ModerationDiscordClient,
    moderation: ModerationService,
    moderationStore: ModerationStore,
    automodStore: AutomodStore,
    resolver: AutomodTargetResolver,
    options: AutomodServiceOptions,
    repeats: RepeatTracker = new MemoryRepeatTracker(),
  ) {
    this.discord = discord;
    this.moderation = moderation;
    this.moderationStore = moderationStore;
    this.automodStore = automodStore;
    this.resolver = resolver;
    this.options = options;
    this.repeats = repeats;
  }

  async inspect(message: AutomodMessage): Promise<AutomodResult> {
    if (message.authorIsBot) return { matched: false, deleted: false };
    if (this.options.policy.exemptChannelIds.has(message.channelId)) return { matched: false, deleted: false };
    if (message.roleIds.some((roleId) => this.options.policy.bypassRoleIds.has(roleId))) {
      return { matched: false, deleted: false };
    }

    const filter = matchAutomod(message, this.options.policy, this.repeats);
    if (!filter) return { matched: false, deleted: false };
    const idempotencyKey = `automod:${message.messageId}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ filter, authorId: message.authorId, channelId: message.channelId }))
      .digest('hex');
    const claim = await this.moderationStore.claim(message.guildId, idempotencyKey, `automod.${filter}`, requestHash);
    if (claim.state === 'replayed') {
      return {
        matched: true,
        deleted: claim.stored.result.deleted === true,
        filter,
        sanction: sanctionName(claim.stored.result.sanction),
        replayed: true,
      };
    }
    if (claim.state === 'in_flight') {
      throw new ActionError('in_progress', 'An earlier attempt at this automod action has an uncertain outcome', {
        logReason: 'automod_idempotent_in_flight',
      });
    }
    if (claim.state === 'mismatch') {
      throw new ActionError('malformed', 'This message id was used for a different automod result', {
        logReason: 'automod_idempotency_key_reused',
      });
    }

    try {
      return await this.runClaimed(message, filter, idempotencyKey);
    } catch (err) {
      // Keep the outer claim after work begins. A warn/timeout may have succeeded
      // even when the response or the later completion write failed; releasing
      // here would let a gateway retry repeat the sanction.
      throw new AutomodProcessingError(err, true);
    }
  }

  private async runClaimed(
    message: AutomodMessage,
    filter: NonNullable<AutomodResult['filter']>,
    idempotencyKey: string,
  ): Promise<AutomodResult> {
    const reason = `Automod ${filter.replace(/_/g, ' ')}`;
    let deleted = false;
    if (!this.options.dryRun) {
      if (!this.discord.deleteMessage) throw new Error('automod requires exact message deletion support');
      await this.discord.deleteMessage(message.channelId, message.messageId, reason);
      deleted = true;
    }

    const count = this.options.dryRun
      ? 0
      : await this.automodStore.recordViolation(
          message.guildId,
          message.authorId,
          filter,
          message.messageId,
        );
    const sanction = sanctionFor(Math.max(1, count), this.options.policy.sanctions);
    if (!this.options.dryRun && sanction.action !== 'delete') {
      const target = await this.resolver.target(message.guildId, message.authorId);
      await this.moderation.execute(this.moderationRequest(message, target, sanction, count, reason));
    }

    const outcome = this.options.dryRun ? 'dry_run' : sanction.action === 'delete' ? 'deleted' : sanction.action;
    const result: AutomodResult = { matched: true, deleted, filter, sanction: sanction.action };
    await this.moderationStore.recordAudit({
      requestId: `automod:${message.messageId}`,
      guildId: message.guildId,
      actorId: this.options.owenUserId,
      action: `automod.${filter}`,
      targetId: message.authorId,
      channelId: message.channelId,
      reason,
      outcome,
      idempotencyKey,
      metadata: {
        message_id: message.messageId,
        violation_count: this.options.dryRun ? null : count,
        sanction: sanction.action,
        timeout_seconds: sanction.timeoutSeconds,
        dry_run: this.options.dryRun,
      },
    }).catch((err: unknown) => {
      log.error('automod_audit_failed', { requestId: message.messageId, err: String(err) });
    });
    await this.moderationStore.complete(message.guildId, idempotencyKey, {
      outcome,
      result: { deleted, sanction: sanction.action },
    });
    return result;
  }

  private moderationRequest(
    message: AutomodMessage,
    target: ModerationTarget,
    sanction: AutomodSanction,
    count: number,
    reason: string,
  ): ModerationExecution {
    const base = {
      guildId: message.guildId,
      actor: {
        userId: this.options.owenUserId,
        roleIds: [],
        highestRolePosition: this.options.botHighestRolePosition,
        permissions: ~0n,
      },
      target,
      reason: `${reason}; violation ${count}`,
      requestId: `automod:${message.messageId}:${sanction.action}`,
      idempotencyKey: `automod:${message.messageId}:${sanction.action}`,
    };
    if (sanction.action === 'warn') {
      return { ...base, action: 'moderation.warn' };
    }
    return {
      ...base,
      action: 'moderation.timeout',
      durationSeconds: sanction.timeoutSeconds ?? 600,
    };
  }
}

function sanctionFor(count: number, sanctions: AutomodSanction[]): AutomodSanction {
  let selected = sanctions[0] ?? { violations: 1, action: 'delete' as const };
  for (const sanction of sanctions) {
    if (sanction.violations <= count) selected = sanction;
  }
  return selected;
}

function sanctionName(value: unknown): AutomodSanction['action'] | undefined {
  return value === 'delete' || value === 'warn' || value === 'timeout' ? value : undefined;
}
