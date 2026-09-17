import { createHash } from 'node:crypto';
import { ActionError } from '../internal/errors.ts';
import type { ModerationDiscordClient } from '../moderation/discord.ts';
import { isModerationPolicyRefusal } from '../moderation/policy.ts';
import type { ModerationExecution } from '../moderation/service.ts';
import type { ModerationService } from '../moderation/service.ts';
import type { ModerationClaim, ModerationStore } from '../moderation/store.ts';
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
    const idempotencyKey = `automod:${this.options.dryRun ? 'dry-run:' : ''}${message.messageId}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ filter, authorId: message.authorId, channelId: message.channelId }))
      .digest('hex');
    let claim: ModerationClaim;
    try {
      claim = await this.moderationStore.claim(message.guildId, idempotencyKey, `automod.${filter}`, requestHash);
    } catch (err) {
      throw new AutomodProcessingError(err, true);
    }
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
      throw new AutomodProcessingError(
        new ActionError('in_progress', 'An earlier attempt at this automod action has an uncertain outcome', {
          logReason: 'automod_idempotent_in_flight',
        }),
        true,
      );
    }
    if (claim.state === 'mismatch') {
      throw new AutomodProcessingError(
        new ActionError('malformed', 'This message id was used for a different automod result', {
          logReason: 'automod_idempotency_key_reused',
        }),
        true,
      );
    }

    let deleteAttempted = false;
    let deleteSucceeded = false;
    try {
      return await this.runClaimed(
        message,
        filter,
        idempotencyKey,
        () => { deleteAttempted = true; },
        () => { deleteSucceeded = true; },
      );
    } catch (err) {
      if (!deleteAttempted || (!deleteSucceeded && this.isDefiniteDeleteFailure(err))) {
        await this.moderationStore.release(message.guildId, idempotencyKey).catch((releaseErr: unknown) => {
          log.error('automod_idempotency_release_failed', {
            requestId: message.messageId,
            err: String(releaseErr),
          });
        });
      }
      // Retain the claim after a successful delete or an uncertain mutation. A
      // gateway retry must not repeat sanctions whose Discord outcome is unknown.
      throw new AutomodProcessingError(err, true);
    }
  }

  private async runClaimed(
    message: AutomodMessage,
    filter: NonNullable<AutomodResult['filter']>,
    idempotencyKey: string,
    markDeleteAttempted: () => void,
    markDeleteSucceeded: () => void,
  ): Promise<AutomodResult> {
    const reason = `Automod ${filter.replace(/_/g, ' ')}`;

    // TOG-3092: resolve the author and settle protection BEFORE touching
    // Discord. This used to sit below the delete, gated on the sanction being
    // something other than `delete`, which meant the owner's and protected
    // staff's messages were deleted outright on a first violation and only the
    // follow-on sanction was ever refused. A guard that runs after the mutation
    // is not a guard.
    //
    // Dry run resolves nothing: it makes no mutation to gate, and the resolver
    // is three REST calls we should not spend to reach an outcome of 'dry_run'.
    //
    // A resolver failure now fails closed. The message survives, no claim
    // damage is done (`markDeleteAttempted` has not fired, so `inspect` releases
    // the claim), and the gateway can retry. Deleting while unable to tell
    // whether the author is protected is the behaviour this card exists to end.
    const target = this.options.dryRun
      ? undefined
      : await this.resolver.target(message.guildId, message.authorId);
    let refusalReason: string | undefined = target && this.moderation.targetProtection(target);

    let deleted = false;
    if (!this.options.dryRun && !refusalReason) {
      if (!this.discord.deleteMessage) throw new Error('automod requires exact message deletion support');
      markDeleteAttempted();
      await this.discord.deleteMessage(message.channelId, message.messageId, reason);
      markDeleteSucceeded();
      deleted = true;
    }

    // Still recorded for a protected author: the ledger counts matches, and the
    // refused audit row is only informative if it can name the rung it refused.
    const count = this.options.dryRun
      ? 0
      : await this.automodStore.recordViolation(
          message.guildId,
          message.authorId,
          filter,
          message.messageId,
        );
    const sanction = sanctionFor(Math.max(1, count), this.options.policy.sanctions);
    if (!this.options.dryRun && !refusalReason && sanction.action !== 'delete') {
      try {
        await this.moderation.execute(this.moderationRequest(message, target!, sanction, count, reason));
      } catch (err) {
        if (!isModerationPolicyRefusal(err)) throw err;
        refusalReason = err.logReason;
      }
    }

    const outcome = refusalReason
      ? 'refused'
      : this.options.dryRun
        ? 'dry_run'
        : sanction.action === 'delete'
          ? 'deleted'
          : sanction.action;
    const result: AutomodResult = { matched: true, deleted, filter, sanction: sanction.action };
    await this.moderationStore.recordAudit({
      requestId: idempotencyKey,
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
        filter,
        violation_count: this.options.dryRun ? null : count,
        sanction: sanction.action,
        timeout_seconds: sanction.timeoutSeconds,
        dry_run: this.options.dryRun,
        refusal_reason: refusalReason,
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

  private isDefiniteDeleteFailure(err: unknown): boolean {
    return err instanceof ActionError
      && (err.code === 'discord_rejected' || err.code === 'action_not_allowed' || err.code === 'malformed');
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
