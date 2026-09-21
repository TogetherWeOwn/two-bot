import type { Db } from '../store/db.ts';
import type { OnboardingFactType } from './onboardingEvents.ts';
import type {
  CommunityClassificationResult,
  CommunityClassifier,
  CommunityClassifierInput,
} from './communityClassifier.ts';

export const COMMUNITY_FACT_TYPES = [
  'message_created',
  'voice_session_started',
  'voice_session_ended',
  'member_joined',
  'event_attended',
  'rules_accepted',
] as const;

export type CommunityFactType = (typeof COMMUNITY_FACT_TYPES)[number];
export type CommunityChannelClass = 'human' | 'other' | 'welcome';
export type AttendanceProof = 'host_checkin' | 'durable_checkin' | 'voice_600s' | 'rsvp';

export interface CommunityFactInput {
  guildId: string;
  eventType: CommunityFactType | OnboardingFactType;
  sourceEventId: string;
  actorId: string | null;
  occurredAt: string;
  source: string;
  idempotencyKey: string;
  classification: CommunityClassificationResult;
  metadata?: Record<string, unknown>;
}

export interface MessageFactInput extends CommunityClassifierInput {
  messageId: string;
  channelId: string;
  channelClass: CommunityChannelClass;
  occurredAt: string;
}

export interface MemberFactInput extends CommunityClassifierInput {
  occurredAt: string;
  sourceEventId: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceFactInput extends CommunityClassifierInput {
  sessionKey: string;
  channelId: string;
  occurredAt: string;
  startedAt?: string | null;
  durationSeconds?: number | null;
}

export interface VoiceStartFactInput extends CommunityClassifierInput {
  sessionKey?: string;
  channelId: string;
  occurredAt: string;
}

export interface AttendanceFactInput extends CommunityClassifierInput {
  eventOccurrenceId: string;
  occurredAt: string;
  proof: AttendanceProof;
}

export class CommunityFactStore {
  private db: Db;
  private classifier: CommunityClassifier;

  constructor(db: Db, classifier: CommunityClassifier) {
    this.db = db;
    this.classifier = classifier;
  }

  async record(input: CommunityFactInput): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO community_facts
           (guild_id, event_type, source_event_id, actor_id, occurred_at, source,
            classifier_version, classification, matched_rule, metadata, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
      )
      .get<{ id: number }>(
        input.guildId,
        input.eventType,
        input.sourceEventId,
        input.actorId,
        input.occurredAt,
        input.source,
        input.classification.classifierVersion,
        input.classification.classification,
        input.classification.matchedRule,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.idempotencyKey,
      );
    return !!inserted;
  }

  async recordMessage(input: MessageFactInput): Promise<boolean> {
    return this.record({
      guildId: input.guildId,
      eventType: 'message_created',
      sourceEventId: input.messageId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: `channel:${input.channelId}`,
      idempotencyKey: `discord-message:${input.messageId}`,
      classification: this.classifier.classify(input),
      metadata: {
        channelId: input.channelId,
        channelClass: input.channelClass,
        webhookId: input.webhookId ?? null,
        discordBot: !!input.isBot,
      },
    });
  }

  async recordMemberJoin(input: MemberFactInput): Promise<boolean> {
    return this.record({
      guildId: input.guildId,
      eventType: 'member_joined',
      sourceEventId: input.sourceEventId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: input.source ?? 'unknown',
      idempotencyKey: `member-join:${input.guildId}:${input.actorId}:${input.occurredAt}`,
      classification: this.classifier.classify(input),
      metadata: input.metadata,
    });
  }

  async recordRulesAccepted(input: MemberFactInput): Promise<boolean> {
    return this.record({
      guildId: input.guildId,
      eventType: 'rules_accepted',
      sourceEventId: input.sourceEventId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: input.source ?? 'gateway',
      idempotencyKey: `rules-accepted:${input.guildId}:${input.actorId}`,
      classification: this.classifier.classify(input),
      metadata: input.metadata,
    });
  }

  async recordVoiceStarted(input: VoiceStartFactInput): Promise<string> {
    const sessionKey = input.sessionKey ?? `${input.guildId}:${input.actorId}:${input.occurredAt}:${input.channelId}`;
    await this.record({
      guildId: input.guildId,
      eventType: 'voice_session_started',
      sourceEventId: sessionKey,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: `channel:${input.channelId}`,
      idempotencyKey: `voice-start:${sessionKey}`,
      classification: this.classifier.classify(input),
      metadata: { sessionKey, channelId: input.channelId },
    });
    return sessionKey;
  }

  async recordVoiceEnded(input: VoiceFactInput): Promise<boolean> {
    return this.record({
      guildId: input.guildId,
      eventType: 'voice_session_ended',
      sourceEventId: input.sessionKey,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: `channel:${input.channelId}`,
      idempotencyKey: `voice-end:${input.sessionKey}`,
      classification: this.classifier.classify(input),
      metadata: {
        sessionKey: input.sessionKey,
        channelId: input.channelId,
        startedAt: input.startedAt ?? null,
        durationSeconds: input.durationSeconds ?? null,
        startKnown: !!input.startedAt && input.durationSeconds !== null && input.durationSeconds !== undefined,
      },
    });
  }

  async recordAttendance(input: AttendanceFactInput): Promise<boolean> {
    if (input.proof === 'rsvp') return false;
    return this.record({
      guildId: input.guildId,
      eventType: 'event_attended',
      sourceEventId: `${input.eventOccurrenceId}:${input.actorId}`,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      source: `event:${input.eventOccurrenceId}`,
      idempotencyKey: `event-attended:${input.eventOccurrenceId}:${input.actorId}`,
      classification: this.classifier.classify(input),
      metadata: { eventOccurrenceId: input.eventOccurrenceId, proof: input.proof },
    });
  }

  async markStreamCoverage(
    guildId: string,
    stream: CommunityFactType,
    coveredFrom: string,
    coveredThrough: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO community_stream_heartbeats
           (guild_id, stream, covered_from, covered_through, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, stream) DO UPDATE
           SET covered_from = excluded.covered_from,
               covered_through = excluded.covered_through,
               updated_at = excluded.updated_at`,
      )
      .run(guildId, stream, coveredFrom, coveredThrough, at);
  }

}
