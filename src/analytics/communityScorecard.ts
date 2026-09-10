import { createHash } from 'node:crypto';
import type { Db } from '../store/db.ts';
import {
  COMMUNITY_CLASSIFICATIONS,
  type CommunityClassification,
} from './communityClassifier.ts';
import { COMMUNITY_FACT_TYPES, type CommunityFactType } from './communityFacts.ts';
import { weekStart } from './dashboard.ts';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const BOT_NOISE_THRESHOLD = 0.2;
const FIRST_REPLY_BREACH_MS = DAY_MS;

export const COMMUNITY_INTERVENTION_CODES = [
  'INGESTION_INCOMPLETE',
  'BOT_NOISE_HIGH',
  'FIRST_REPLY_BREACH',
  'EVENT_AT_RISK',
  'CORE_DECLINE',
  'HOLD',
  'none_insufficient_evidence',
] as const;

export type CommunityInterventionCode = (typeof COMMUNITY_INTERVENTION_CODES)[number];

interface CommunityFactRow {
  id: number;
  guild_id: string;
  event_type: string;
  source_event_id: string;
  actor_id: string | null;
  occurred_at: string;
  recorded_at: string;
  source: string;
  classifier_version: string;
  classification: string;
  matched_rule: string;
  metadata: string | null;
  idempotency_key: string;
}

interface ParsedFact extends Omit<CommunityFactRow, 'metadata'> {
  event_type: CommunityFactType;
  classification: CommunityClassification | 'invalid/unknown';
  metadata: Record<string, unknown>;
}

export interface CommunityScorecardConfig {
  guildId: string;
  classifierVersion: string;
  weekStart: string;
  weekEnd: string;
  watermark: number;
  generatedAt: string;
  recommendationsEnabled: boolean;
  correctionCycles: number;
}

export interface ReconciliationBucket {
  raw: number;
  eligible_human: number;
  bot: number;
  webhook: number;
  staff_automation: number;
  raid: number;
  staging: number;
  test: number;
  'invalid/unknown': number;
  reconciles: boolean;
}

export interface CommunityScorecard {
  guildId: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  classifierVersion: string;
  watermark: number;
  idempotencyKey: string;
  revision: number;
  coverageState: 'complete' | 'incomplete';
  evidenceState: 'sufficient' | 'insufficient';
  rawFactCount: number;
  weeklyActiveHumans: number | null;
  humanMessages: number | null;
  eligibleJoins: number | null;
  joinSources: { known: number; unknown: number } | null;
  eventAttendance: { participations: number; distinctHumans: number } | null;
  botNoise: { numerator: number; denominator: number; ratio: number | null; alert: boolean } | null;
  firstHumanReply: {
    medianSeconds: number | null;
    resolvedCount: number;
    eligibleJoinCount: number;
    noReplyWithin24hCount: number;
    pendingCount: number;
  } | null;
  exclusionCounts: Record<string, Record<string, number>>;
  reconciliation: Record<string, ReconciliationBucket>;
  ingestionErrors: string[];
  intervention: { code: CommunityInterventionCode; reason: string };
  recommendationsEnabled: boolean;
  killSwitchActive: boolean;
}

export interface CommunityScorecardResult {
  scorecard: CommunityScorecard;
  reused: boolean;
  alertEmitted: boolean;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isFactType(value: string): value is CommunityFactType {
  return (COMMUNITY_FACT_TYPES as readonly string[]).includes(value);
}

function isClassification(value: string): value is CommunityClassification {
  return (COMMUNITY_CLASSIFICATIONS as readonly string[]).includes(value);
}

function closedWeek(now: Date): { start: string; end: string } {
  const currentMonday = new Date(`${weekStart(now)}T00:00:00.000Z`);
  const end = currentMonday.toISOString();
  return { start: new Date(currentMonday.getTime() - WEEK_MS).toISOString(), end };
}

export function previousClosedCommunityWeek(now = new Date()): { start: string; end: string } {
  return closedWeek(now);
}

function clampInterval(start: number, end: number, weekStartMs: number, weekEndMs: number): [number, number] | null {
  const a = Math.max(start, weekStartMs);
  const b = Math.min(end, weekEndMs);
  return b > a ? [a, b] : null;
}

export function unionVoiceSeconds(
  facts: ParsedFact[],
  weekStartIso: string,
  weekEndIso: string,
): Map<string, number> {
  const weekStartMs = Date.parse(weekStartIso);
  const weekEndMs = Date.parse(weekEndIso);
  const byActor = new Map<string, Array<[number, number]>>();
  for (const fact of facts) {
    if (fact.event_type !== 'voice_session_ended' || fact.classification !== 'eligible_human' || !fact.actor_id) continue;
    const start = typeof fact.metadata.startedAt === 'string' ? Date.parse(fact.metadata.startedAt) : Number.NaN;
    const end = Date.parse(fact.occurred_at);
    const duration = Number(fact.metadata.durationSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration) || duration < 0) continue;
    const interval = clampInterval(start, end, weekStartMs, weekEndMs);
    if (!interval) continue;
    const list = byActor.get(fact.actor_id) ?? [];
    list.push(interval);
    byActor.set(fact.actor_id, list);
  }

  const totals = new Map<string, number>();
  for (const [actor, intervals] of byActor) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let seconds = 0;
    let [openStart, openEnd] = intervals[0];
    for (const [start, end] of intervals.slice(1)) {
      if (start <= openEnd) openEnd = Math.max(openEnd, end);
      else {
        seconds += (openEnd - openStart) / 1000;
        openStart = start;
        openEnd = end;
      }
    }
    seconds += (openEnd - openStart) / 1000;
    totals.set(actor, seconds);
  }
  return totals;
}

function emptyReconciliation(): ReconciliationBucket {
  return {
    raw: 0,
    eligible_human: 0,
    bot: 0,
    webhook: 0,
    staff_automation: 0,
    raid: 0,
    staging: 0,
    test: 0,
    'invalid/unknown': 0,
    reconciles: true,
  };
}

function reconcile(facts: ParsedFact[]): Record<string, ReconciliationBucket> {
  const rows: Record<string, ReconciliationBucket> = {};
  const add = (key: string, fact: ParsedFact) => {
    const row = rows[key] ?? emptyReconciliation();
    row.raw++;
    row[fact.classification]++;
    rows[key] = row;
  };
  for (const fact of facts) {
    add(fact.event_type, fact);
    add('total', fact);
  }
  for (const row of Object.values(rows)) {
    row.reconciles =
      row.raw ===
      row.eligible_human + row.bot + row.webhook + row.staff_automation + row.raid + row.staging + row.test + row['invalid/unknown'];
  }
  return rows;
}

function exclusionCounts(facts: ParsedFact[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const type of COMMUNITY_FACT_TYPES) {
    out[type] = {};
    for (const classification of COMMUNITY_CLASSIFICATIONS) {
      out[type][classification] = 0;
    }
    out[type]['invalid/unknown'] = 0;
  }
  for (const fact of facts) out[fact.event_type][fact.classification]++;
  return out;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

function firstHumanReply(facts: ParsedFact[], weekEndIso: string) {
  const joins = facts.filter(
    (fact) => fact.event_type === 'member_joined' && fact.classification === 'eligible_human' && fact.actor_id,
  );
  const accepted = new Map<string, string>();
  for (const fact of facts) {
    if (fact.event_type === 'rules_accepted' && fact.classification === 'eligible_human' && fact.actor_id) {
      const current = accepted.get(fact.actor_id);
      if (!current || fact.occurred_at < current) accepted.set(fact.actor_id, fact.occurred_at);
    }
  }
  const messages = facts
    .filter(
      (fact) =>
        fact.event_type === 'message_created' &&
        fact.classification === 'eligible_human' &&
        fact.actor_id &&
        ['welcome', 'human'].includes(String(fact.metadata.channelClass ?? '')),
    )
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const durations: number[] = [];
  let noReplyWithin24hCount = 0;
  let pendingCount = 0;
  for (const join of joins) {
    const actor = join.actor_id!;
    const clockStart = accepted.get(actor) ?? join.occurred_at;
    const firstOwnMessage = messages.find((message) => message.actor_id === actor && message.occurred_at >= clockStart);
    if (!firstOwnMessage) {
      if (Date.parse(weekEndIso) - Date.parse(clockStart) > FIRST_REPLY_BREACH_MS) noReplyWithin24hCount++;
      else pendingCount++;
      continue;
    }
    const reply = messages.find(
      (message) => message.actor_id !== actor && message.occurred_at > firstOwnMessage.occurred_at,
    );
    if (reply) {
      durations.push((Date.parse(reply.occurred_at) - Date.parse(clockStart)) / 1000);
    } else if (Date.parse(weekEndIso) - Date.parse(clockStart) > FIRST_REPLY_BREACH_MS) {
      noReplyWithin24hCount++;
    } else {
      pendingCount++;
    }
  }
  return {
    medianSeconds: median(durations),
    resolvedCount: durations.length,
    eligibleJoinCount: joins.length,
    noReplyWithin24hCount,
    pendingCount,
  };
}

function attendance(facts: ParsedFact[]) {
  const participations = new Set<string>();
  const humans = new Set<string>();
  for (const fact of facts) {
    if (fact.event_type !== 'event_attended' || fact.classification !== 'eligible_human' || !fact.actor_id) continue;
    const proof = String(fact.metadata.proof ?? '');
    if (!['host_checkin', 'durable_checkin', 'voice_600s'].includes(proof)) continue;
    const occurrence = String(fact.metadata.eventOccurrenceId ?? fact.source_event_id);
    participations.add(`${occurrence}:${fact.actor_id}`);
    humans.add(fact.actor_id);
  }
  return { participations: participations.size, distinctHumans: humans.size };
}

function evidenceHumans(facts: ParsedFact[], reply: ReturnType<typeof firstHumanReply>): Set<string> {
  const humans = new Set<string>();
  for (const fact of facts) {
    if (
      fact.classification === 'eligible_human' &&
      fact.actor_id &&
      ['message_created', 'member_joined', 'event_attended'].includes(fact.event_type)
    ) humans.add(fact.actor_id);
  }
  if (reply.resolvedCount === 0) return humans;
  return humans;
}

function selectIntervention(
  coverageState: 'complete' | 'incomplete',
  evidenceState: 'sufficient' | 'insufficient',
  botNoiseAlert: boolean,
  reply: ReturnType<typeof firstHumanReply>,
): CommunityScorecard['intervention'] {
  if (coverageState === 'incomplete') {
    return { code: 'INGESTION_INCOMPLETE', reason: 'repair ingestion/reconciliation before changing community programming' };
  }
  if (botNoiseAlert) {
    return { code: 'BOT_NOISE_HIGH', reason: 'pause or reduce one discretionary automated post source in human spaces' };
  }
  if (evidenceState === 'insufficient') {
    return { code: 'none_insufficient_evidence', reason: 'fewer than five eligible humans; no growth intervention' };
  }
  if (reply.noReplyWithin24hCount > 0) {
    return { code: 'FIRST_REPLY_BREACH', reason: 'tighten the human welcome rota for the next week' };
  }
  return { code: 'HOLD', reason: 'no threshold crossed; continue the current one intervention' };
}

function hashInputs(facts: ParsedFact[]): string {
  return createHash('sha256')
    .update(facts.map((fact) => `${fact.id}:${fact.idempotency_key}`).join('\n'))
    .digest('hex');
}

async function validateCoverage(
  db: Db,
  config: CommunityScorecardConfig,
  facts: ParsedFact[],
  reconciliation: Record<string, ReconciliationBucket>,
): Promise<string[]> {
  const errors: string[] = [];
  const heartbeats = await db
    .prepare(`SELECT stream, covered_through FROM community_stream_heartbeats WHERE guild_id = ?`)
    .all<{ stream: string; covered_through: string }>(config.guildId);
  const covered = new Map(heartbeats.map((row) => [row.stream, row.covered_through]));
  for (const stream of COMMUNITY_FACT_TYPES) {
    const hasFact = facts.some((fact) => fact.event_type === stream);
    if (!hasFact && (covered.get(stream) ?? '') < config.weekEnd) errors.push(`missing_stream_coverage:${stream}`);
  }
  const duplicateSourceIds = await db
    .prepare(
      `SELECT source_event_id, event_type, COUNT(*) AS n
         FROM community_facts
        WHERE guild_id = ? AND id <= ?
        GROUP BY source_event_id, event_type
       HAVING COUNT(*) > 1`,
    )
    .all<{ source_event_id: string; event_type: string; n: number }>(config.guildId, config.watermark);
  if (duplicateSourceIds.length) errors.push('duplicate_source_ids');
  if (facts.some((fact) => fact.classification === 'invalid/unknown')) errors.push('invalid_classification');
  if (facts.some((fact) => fact.classifier_version !== config.classifierVersion)) errors.push('classifier_version_mismatch');
  for (const fact of facts) {
    if (fact.guild_id !== config.guildId || fact.occurred_at < config.weekStart || fact.occurred_at >= config.weekEnd) {
      errors.push('guild_or_week_scope_mismatch');
      break;
    }
    if (fact.event_type === 'voice_session_ended') {
      const duration = fact.metadata.durationSeconds;
      if (duration !== null && duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) < 0)) {
        errors.push('invalid_voice_duration');
        break;
      }
    }
  }
  if (Object.values(reconciliation).some((row) => !row.reconciles)) errors.push('reconciliation_failed');
  return [...new Set(errors)];
}

export async function buildCommunityScorecard(
  db: Db,
  config: CommunityScorecardConfig,
): Promise<CommunityScorecardResult> {
  const raw = await db
    .prepare(
      `SELECT * FROM community_facts
        WHERE guild_id = ? AND occurred_at >= ? AND occurred_at < ? AND id <= ?
        ORDER BY id`,
    )
    .all<CommunityFactRow>(config.guildId, config.weekStart, config.weekEnd, config.watermark);
  const facts: ParsedFact[] = raw.flatMap((fact) => {
    if (!isFactType(fact.event_type)) return [];
    return [{
      ...fact,
      event_type: fact.event_type,
      classification: isClassification(fact.classification) ? fact.classification : 'invalid/unknown',
      metadata: parseMetadata(fact.metadata),
    }];
  });
  const inputHash = hashInputs(facts);
  const idempotencyKey = `community-health:${config.guildId}:${config.weekStart.slice(0, 10)}:${config.classifierVersion}:${config.watermark}`;
  const existing = await db
    .prepare(`SELECT scorecard_json FROM community_scorecard_runs WHERE idempotency_key = ?`)
    .get<{ scorecard_json: string }>(idempotencyKey);
  if (existing) return { scorecard: JSON.parse(existing.scorecard_json), reused: true, alertEmitted: false };

  const reconciliation = reconcile(facts);
  const ingestionErrors = await validateCoverage(db, config, facts, reconciliation);
  const coverageState = ingestionErrors.length ? 'incomplete' : 'complete';
  const exclusions = exclusionCounts(facts);
  const eligible = facts.filter((fact) => fact.classification === 'eligible_human');
  const voiceSeconds = unionVoiceSeconds(facts, config.weekStart, config.weekEnd);
  const active = new Set<string>();
  for (const fact of eligible) {
    if (fact.event_type === 'message_created' && fact.actor_id) active.add(fact.actor_id);
  }
  for (const [actor, seconds] of voiceSeconds) if (seconds >= 600) active.add(actor);
  const humanMessages = eligible.filter((fact) => fact.event_type === 'message_created').length;
  const joins = eligible.filter((fact) => fact.event_type === 'member_joined');
  const attendanceResult = attendance(facts);
  const automatedMessages = facts.filter(
    (fact) =>
      fact.event_type === 'message_created' &&
      ['bot', 'webhook', 'staff_automation'].includes(fact.classification) &&
      fact.metadata.channelClass === 'human',
  ).length;
  const eligibleHumanSpaceMessages = eligible.filter(
    (fact) => fact.event_type === 'message_created' && fact.metadata.channelClass === 'human',
  ).length;
  const botDenominator = automatedMessages + eligibleHumanSpaceMessages;
  const botRatio = botDenominator === 0 ? null : automatedMessages / botDenominator;
  const botAlert = botRatio !== null && botRatio >= BOT_NOISE_THRESHOLD;
  const reply = firstHumanReply(facts, config.weekEnd);
  const humans = evidenceHumans(facts, reply);
  const evidenceState = humans.size < 5 ? 'insufficient' : 'sufficient';
  const selected = selectIntervention(coverageState, evidenceState, botAlert, reply);
  const invalidRecommendation =
    selected.code !== 'INGESTION_INCOMPLETE' &&
    selected.code !== 'none_insufficient_evidence' &&
    (coverageState === 'incomplete' || evidenceState === 'insufficient');
  const killSwitchActive = config.correctionCycles >= 2 &&
    (coverageState === 'incomplete' || Object.values(reconciliation).some((row) => !row.reconciles) || invalidRecommendation);
  const recommendationsEnabled = config.recommendationsEnabled && !killSwitchActive;
  const intervention = recommendationsEnabled
    ? selected
    : coverageState === 'incomplete'
      ? { code: 'INGESTION_INCOMPLETE' as const, reason: 'recommendations and threshold notifications disabled; repair ingestion/reconciliation' }
      : evidenceState === 'insufficient'
        ? { code: 'none_insufficient_evidence' as const, reason: 'recommendations and threshold notifications disabled; fewer than five eligible humans' }
        : { code: 'HOLD' as const, reason: 'recommendations and threshold notifications disabled by kill switch' };

  const previous = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM community_scorecard_runs
        WHERE guild_id = ? AND week_start = ? AND classifier_version = ?`,
    )
    .get<{ n: number }>(config.guildId, config.weekStart, config.classifierVersion);
  const scorecard: CommunityScorecard = {
    guildId: config.guildId,
    weekStart: config.weekStart,
    weekEnd: config.weekEnd,
    generatedAt: config.generatedAt,
    classifierVersion: config.classifierVersion,
    watermark: config.watermark,
    idempotencyKey,
    revision: Number(previous?.n ?? 0) + 1,
    coverageState,
    evidenceState,
    rawFactCount: facts.length,
    weeklyActiveHumans: coverageState === 'complete' ? active.size : null,
    humanMessages: coverageState === 'complete' ? humanMessages : null,
    eligibleJoins: coverageState === 'complete' ? joins.length : null,
    joinSources: coverageState === 'complete'
      ? {
          known: joins.filter((fact) => !['unknown', ''].includes(fact.source)).length,
          unknown: joins.filter((fact) => ['unknown', ''].includes(fact.source)).length,
        }
      : null,
    eventAttendance: coverageState === 'complete' ? attendanceResult : null,
    botNoise: coverageState === 'complete'
      ? { numerator: automatedMessages, denominator: botDenominator, ratio: botRatio, alert: botAlert }
      : null,
    firstHumanReply: coverageState === 'complete' ? reply : null,
    exclusionCounts: exclusions,
    reconciliation,
    ingestionErrors,
    intervention,
    recommendationsEnabled,
    killSwitchActive,
  };

  let alertEmitted = false;
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO community_scorecard_runs
           (guild_id, week_start, week_end, classifier_version, watermark, input_count, input_hash,
            idempotency_key, revision, run_status, coverage_state, evidence_state, scorecard_json,
            intervention_code, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.guildId,
        config.weekStart,
        config.weekEnd,
        config.classifierVersion,
        config.watermark,
        facts.length,
        inputHash,
        idempotencyKey,
        scorecard.revision,
        coverageState === 'complete' ? 'completed' : 'incomplete',
        coverageState,
        evidenceState,
        JSON.stringify(scorecard),
        scorecard.intervention.code,
        config.generatedAt,
      );
    if (recommendationsEnabled && selected.code !== 'HOLD' && selected.code !== 'none_insufficient_evidence') {
      const threshold = selected.code === 'BOT_NOISE_HIGH' ? '0.20' : 'contract';
      const alertKey = `${selected.code}:${config.weekStart.slice(0, 10)}:${threshold}`;
      const inserted = await tx
        .prepare(
          `INSERT INTO community_scorecard_alerts (guild_id, week_start, alert_key, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, alert_key) DO NOTHING
           RETURNING alert_key`,
        )
        .get<{ alert_key: string }>(config.guildId, config.weekStart, alertKey, config.generatedAt);
      alertEmitted = !!inserted;
    }
  });

  return { scorecard, reused: false, alertEmitted };
}

export async function runPreviousClosedCommunityWeek(
  db: Db,
  guildId: string,
  classifierVersion: string,
  opts: { now?: Date; recommendationsEnabled?: boolean; correctionCycles?: number } = {},
): Promise<CommunityScorecardResult> {
  const now = opts.now ?? new Date();
  const { start, end } = previousClosedCommunityWeek(now);
  const watermarkRow = await db
    .prepare(`SELECT MAX(id) AS watermark FROM community_facts WHERE guild_id = ?`)
    .get<{ watermark: number | null }>(guildId);
  return buildCommunityScorecard(db, {
    guildId,
    classifierVersion,
    weekStart: start,
    weekEnd: end,
    watermark: Number(watermarkRow?.watermark ?? 0),
    generatedAt: now.toISOString(),
    recommendationsEnabled: opts.recommendationsEnabled ?? true,
    correctionCycles: opts.correctionCycles ?? 0,
  });
}
