import { createHmac } from 'node:crypto';
import type { Db } from '../store/db.ts';
import { CommunityFactStore } from './communityFacts.ts';
import { CommunityClassifier, type CommunityClassifierInput } from './communityClassifier.ts';
import type { OnboardingFactType } from './onboardingEvents.ts';

const DAY_MS = 86_400_000;

export interface RotaActor extends CommunityClassifierInput {
  /** Subject exclusions, separate from staff automation (a human may reply). */
  isStaff?: boolean;
  /** Must be explicitly false; missing member/screening data fails closed. */
  pending: boolean | null;
}

interface RotaSignal extends RotaActor {
  occurredAt: string;
}

export interface RotaMessage extends RotaSignal {
  messageId: string;
  channelId: string;
  /** Only accepted screened-human destinations, resolved by the adapter. */
  eligibleChannel: boolean;
  /** Automod rejection, deleted/test fixture, or another rejected action. */
  rejected?: boolean;
}

export interface OnboardingRotaConfig {
  enabled: boolean;
  /** A dedicated stable secret, never the bot token and never persisted here. */
  pseudonymKey: string;
}

interface Milestone {
  occurred_at: string;
  metadata: string;
}

interface Enrollment {
  sourceCohort: string;
  rulesAcceptedAt: string;
}

function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid rota event timestamp');
  return date.toISOString();
}

/**
 * Measurement only: no Discord client, prompt generation, timers, or sends.
 * The existing handlers supply observations; CommunityFactStore owns all writes.
 * Once-per-member milestones follow the accepted funnel's rejoin semantics.
 */
export class OnboardingRota {
  private db: Db;
  private classifier: CommunityClassifier;
  private config: OnboardingRotaConfig;

  constructor(db: Db, classifier: CommunityClassifier, config: OnboardingRotaConfig) {
    if (config.enabled && Buffer.byteLength(config.pseudonymKey) < 32) {
      throw new Error('Enabled rota requires a dedicated pseudonym key of at least 32 bytes');
    }
    this.db = db;
    this.classifier = classifier;
    this.config = { ...config };
  }

  memberId(guildId: string, actorId: string): string {
    return createHmac('sha256', this.config.pseudonymKey)
      .update(JSON.stringify(['onboarding-rota-v1', guildId, actorId]))
      .digest('hex');
  }

  private eligible(input: RotaActor, subject = true): boolean {
    return this.config.enabled && input.pending === false &&
      (!subject || !input.isStaff) &&
      this.classifier.classify(input).classification === 'eligible_human';
  }

  private milestone(db: Db, guildId: string, memberId: string, type: OnboardingFactType) {
    return db.prepare(
      `SELECT occurred_at, metadata FROM community_facts
        WHERE idempotency_key = ?`,
    ).get<Milestone>(`rota:${guildId}:${memberId}:${type}`);
  }

  private async enrollment(db: Db, guildId: string, memberId: string): Promise<Enrollment | null> {
    const gate = await this.milestone(db, guildId, memberId, 'onboarding_rules_accepted');
    if (!gate) return null;
    return { sourceCohort: JSON.parse(gate.metadata).sourceCohort, rulesAcceptedAt: gate.occurred_at };
  }

  private async locked<T>(guildId: string, memberId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Serializes the two-row milestones across gateway workers, not just this process.
      await tx.prepare('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))')
        .get(`onboarding-rota:${guildId}`, memberId);
      return fn(tx);
    });
  }

  private write(
    db: Db, input: RotaSignal, memberId: string, type: OnboardingFactType,
    enrollment: Enrollment, metadata: Record<string, unknown> = {},
  ): Promise<boolean> {
    const key = `rota:${input.guildId}:${memberId}:${type}`;
    return new CommunityFactStore(db, this.classifier).record({
      guildId: input.guildId,
      eventType: type,
      actorId: memberId,
      sourceEventId: key,
      occurredAt: iso(input.occurredAt),
      source: enrollment.sourceCohort,
      idempotencyKey: key,
      classification: this.classifier.classify(input),
      metadata: { ...metadata, ...enrollment },
    });
  }

  async rulesAccepted(input: RotaSignal & { sourceCohort: string }): Promise<void> {
    if (!this.eligible(input)) return;
    const memberId = this.memberId(input.guildId, input.actorId);
    const at = iso(input.occurredAt);
    await this.locked(input.guildId, memberId, (tx) => this.write(
      tx, input, memberId, 'onboarding_rules_accepted',
      { sourceCohort: input.sourceCohort.trim() || 'unknown', rulesAcceptedAt: at },
    ));
  }

  /** Call only after the existing welcome delivery succeeds, never on configuration. */
  async promptShown(input: RotaSignal & { promptVariant: string; messageId: string; channelId: string }): Promise<void> {
    if (!this.eligible(input)) return;
    const memberId = this.memberId(input.guildId, input.actorId);
    await this.locked(input.guildId, memberId, async (tx) => {
      const enrollment = await this.enrollment(tx, input.guildId, memberId);
      if (!enrollment || iso(input.occurredAt) < enrollment.rulesAcceptedAt) return;
      await this.write(tx, input, memberId, 'onboarding_prompt_shown', enrollment, {
        promptVariant: input.promptVariant, messageId: input.messageId, channelId: input.channelId,
      });
    });
  }

  async message(input: RotaMessage): Promise<void> {
    if (!this.eligible(input) || !input.eligibleChannel || input.rejected) return;
    const memberId = this.memberId(input.guildId, input.actorId);
    const at = iso(input.occurredAt);
    await this.locked(input.guildId, memberId, async (tx) => {
      const enrollment = await this.enrollment(tx, input.guildId, memberId);
      if (!enrollment || at < enrollment.rulesAcceptedAt) return;
      const action = { actionType: 'message', actionId: input.messageId, channelId: input.channelId };
      await this.write(tx, input, memberId, 'onboarding_first_eligible_message', enrollment, action);
      const shown = await this.milestone(tx, input.guildId, memberId, 'onboarding_prompt_shown');
      if (shown && at >= shown.occurred_at) {
        const prompt = JSON.parse(shown.metadata);
        // A message elsewhere is not evidence that this particular prompt was acted on.
        if (prompt.channelId === input.channelId) {
          await this.write(tx, input, memberId, 'onboarding_prompt_acted', enrollment, {
            ...action, promptVariant: prompt.promptVariant,
          });
        }
      }
      const elapsed = Date.parse(at) - Date.parse(enrollment.rulesAcceptedAt);
      if (elapsed >= 7 * DAY_MS && elapsed < 8 * DAY_MS) {
        await this.write(tx, input, memberId, 'onboarding_seven_day_return', enrollment, action);
      }
    });
  }

  /** Explicit Discord reply reference only; unrelated channel chatter cannot stop the clock. */
  async reply(input: RotaMessage & { subject: RotaActor; replyToMessageId: string }): Promise<void> {
    if (!this.eligible(input, false) || !this.eligible(input.subject) ||
        !input.eligibleChannel || input.rejected || input.guildId !== input.subject.guildId ||
        input.actorId === input.subject.actorId) return;
    const memberId = this.memberId(input.guildId, input.subject.actorId);
    const at = iso(input.occurredAt);
    await this.locked(input.guildId, memberId, async (tx) => {
      const enrollment = await this.enrollment(tx, input.guildId, memberId);
      const acted = await this.milestone(tx, input.guildId, memberId, 'onboarding_prompt_acted');
      if (!enrollment || !acted || at <= acted.occurred_at) return;
      const action = JSON.parse(acted.metadata);
      if (action.actionId !== input.replyToMessageId || action.channelId !== input.channelId) return;
      const metadata = {
        actionId: action.actionId, channelId: input.channelId, replyMessageId: input.messageId,
        responderId: this.memberId(input.guildId, input.actorId), promptVariant: action.promptVariant,
        qualifyingActionAt: acted.occurred_at, replyAt: at,
        latencySeconds: (Date.parse(at) - Date.parse(acted.occurred_at)) / 1000,
      };
      // Atomic pair: a duration must never exist without its actual human reply.
      await this.write(tx, input, memberId, 'onboarding_first_human_reply', enrollment, metadata);
      await this.write(tx, input, memberId, 'onboarding_reply_latency', enrollment, metadata);
    });
  }
}
