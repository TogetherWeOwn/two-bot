import { createHash } from 'node:crypto';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './spec.ts';

export const ANTI_NUKE_ACCEPTANCE_TARGET_SHA = 'f5fd3e1d6d08847589d3bf48ebc0b0e198196e90';
export const ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES = 2;
export const ROLE_DELETE_AUDIT_ACTION = 32;
export const MANAGE_ROLES_PERMISSION = 1n << 28n;

export type ExpectedIncidentState = 'dry_run' | 'contained';

export type DiscordAuditEntry = {
  id: string;
  action_type: number;
  user_id: string | null;
  target_id: string | null;
  reason?: string | null;
};

export type ContainmentEvidenceRow = {
  audit_entry_id: string;
  executor_id: string | null;
  action: string;
  target_id: string | null;
  weight: number;
  occurred_at: string;
  state: string;
  reason: string;
};

export type ContainmentIncidentEvidence = {
  trigger_audit_entry_id: string;
  executor_id: string;
  heat: number;
  state: string;
  result_json: string | null;
};

export type JoinEventEvidence = {
  member_id: string;
  occurred_at: string;
  source: string;
};

export type JoinRiskEvidence = {
  event_id: string;
  member_id: string;
  joined_at: string;
  source: string;
  score: number;
  reasons_json: string;
  bulk_join_window: boolean | number;
  flagged: boolean | number;
};

export type JoinMemberEvidence = {
  id: string;
  bot: boolean;
  joined_at: string;
  roles: string[];
};

export function validateAcceptanceRunId(value: string): string {
  const runId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,47}$/.test(runId)) {
    throw new Error('TWO_ACCEPTANCE_RUN_ID must be 6-48 safe identifier characters.');
  }
  return runId;
}

export function validateSnowflake(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^\d{17,20}$/.test(normalized)) throw new Error(`${name} must be a Discord snowflake.`);
  return normalized;
}

export function assertAcceptanceFences(input: {
  guildId: string;
  owenApplicationId: string;
  actorApplicationId: string;
  targetSha: string;
  deployedSha: string;
}): void {
  if (input.guildId === LIVE_GUILD_ID) throw new Error(`Refusing live guild ${LIVE_GUILD_ID}.`);
  if (input.guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(`Refusing guild ${input.guildId}; expected TWO Staging ${TWO_STAGING_GUILD_ID}.`);
  }
  if (input.owenApplicationId !== STAGING_BOT_APPLICATION_ID) {
    throw new Error(`Refusing Owen application ${input.owenApplicationId}; expected ${STAGING_BOT_APPLICATION_ID}.`);
  }
  if (input.actorApplicationId === STAGING_BOT_APPLICATION_ID) {
    throw new Error('The destructive actor must be a separate bot; Owen is protected and cannot certify containment.');
  }
  if (input.actorApplicationId === LIVE_BOT_APPLICATION_ID) {
    throw new Error(`Refusing the live Owen application ${LIVE_BOT_APPLICATION_ID} as the destructive actor.`);
  }
  if (input.targetSha !== ANTI_NUKE_ACCEPTANCE_TARGET_SHA) {
    throw new Error(`Target checkout is ${input.targetSha}; expected ${ANTI_NUKE_ACCEPTANCE_TARGET_SHA}.`);
  }
  if (input.deployedSha !== ANTI_NUKE_ACCEPTANCE_TARGET_SHA) {
    throw new Error(`Staging deployment is reported as ${input.deployedSha}; expected ${ANTI_NUKE_ACCEPTANCE_TARGET_SHA}.`);
  }
}

export function fixtureRoleNames(runId: string): {
  capability: string;
  targets: [string, string];
} {
  const prefix = `TOG-3787 ${validateAcceptanceRunId(runId)}`;
  return {
    capability: `${prefix} actor-capability`,
    targets: [`${prefix} delete-1`, `${prefix} delete-2`],
  };
}

export function acceptanceLockKey(): [number, number] {
  const digest = createHash('sha256').update(`TOG-3787:${TWO_STAGING_GUILD_ID}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export function discordSnowflakeTimestamp(id: string): number {
  const snowflake = BigInt(validateSnowflake(id, 'audit entry id'));
  return Number((snowflake >> 22n) + 1_420_070_400_000n);
}

export function selectFixtureAuditEntries(input: {
  entries: DiscordAuditEntry[];
  actorApplicationId: string;
  targetRoleIds: readonly string[];
  runId: string;
  startedAt: string;
}): DiscordAuditEntry[] {
  const targets = new Set(input.targetRoleIds);
  const startedAt = Date.parse(input.startedAt);
  return input.entries
    .filter((entry) =>
      entry.action_type === ROLE_DELETE_AUDIT_ACTION
      && entry.user_id === input.actorApplicationId
      && entry.target_id !== null
      && targets.has(entry.target_id)
      && (entry.reason ?? '').includes(input.runId)
      && discordSnowflakeTimestamp(entry.id) >= startedAt - 5_000)
    .sort((left, right) => discordSnowflakeTimestamp(left.id) - discordSnowflakeTimestamp(right.id));
}

export function evaluateGatewayEvidence(input: {
  actorApplicationId: string;
  targetRoleIds: readonly string[];
  auditEntries: readonly DiscordAuditEntry[];
  containmentRows: readonly ContainmentEvidenceRow[];
  incidents: readonly ContainmentIncidentEvidence[];
  expectedIncidentState: ExpectedIncidentState;
  capabilityRoleId: string;
}): { ok: boolean; errors: string[]; auditEntryIds: string[] } {
  const errors: string[] = [];
  const targetIds = new Set(input.targetRoleIds);
  const auditById = new Map(input.auditEntries.map((entry) => [entry.id, entry]));
  const rowsById = new Map(input.containmentRows.map((row) => [row.audit_entry_id, row]));

  if (input.targetRoleIds.length !== ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES) {
    errors.push(`expected exactly ${ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES} target roles`);
  }
  if (auditById.size !== ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES) {
    errors.push(`expected exactly ${ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES} matching Discord audit entries, found ${auditById.size}`);
  }
  if (rowsById.size !== ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES) {
    errors.push(`expected exactly ${ANTI_NUKE_ACCEPTANCE_MAX_ROLE_DELETES} durable containment rows, found ${rowsById.size}`);
  }

  for (const [entryId, entry] of auditById) {
    const row = rowsById.get(entryId);
    if (!row) {
      errors.push(`Discord audit entry ${entryId} has no durable containment row`);
      continue;
    }
    if (entry.user_id !== input.actorApplicationId || row.executor_id !== input.actorApplicationId) {
      errors.push(`audit entry ${entryId} is not attributed to actor ${input.actorApplicationId}`);
    }
    if (!entry.target_id || !targetIds.has(entry.target_id) || row.target_id !== entry.target_id) {
      errors.push(`audit entry ${entryId} target does not match a run fixture`);
    }
    if (row.action !== 'role.delete' || Number(row.weight) !== 3) {
      errors.push(`audit entry ${entryId} was stored as ${row.action}/${row.weight}, expected role.delete/3`);
    }
  }

  const matchingIncidents = input.incidents.filter((incident) =>
    auditById.has(incident.trigger_audit_entry_id)
    && incident.executor_id === input.actorApplicationId);
  if (matchingIncidents.length !== 1) {
    errors.push(`expected one run incident, found ${matchingIncidents.length}`);
  } else {
    const incident = matchingIncidents[0];
    if (incident.state !== input.expectedIncidentState) {
      errors.push(`incident state is ${incident.state}, expected ${input.expectedIncidentState}`);
    }
    if (Number(incident.heat) < 5) errors.push(`incident heat is ${incident.heat}, expected at least 5`);
    if (input.expectedIncidentState === 'contained') {
      let result: { removedRoleIds?: unknown } = {};
      try {
        result = JSON.parse(incident.result_json ?? '{}') as { removedRoleIds?: unknown };
      } catch {
        errors.push('contained incident result_json is invalid JSON');
      }
      if (!Array.isArray(result.removedRoleIds) || !result.removedRoleIds.includes(input.capabilityRoleId)) {
        errors.push(`contained incident did not record removal of fixture capability role ${input.capabilityRoleId}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, auditEntryIds: [...auditById.keys()].sort() };
}

export function evaluateJoinGatewayEvidence(input: {
  guildId: string;
  memberId: string;
  since: string;
  discordMember: JoinMemberEvidence;
  eventRows: readonly JoinEventEvidence[];
  riskRows: readonly JoinRiskEvidence[];
  expectedBulkWindow?: boolean;
  expectedFlagged?: boolean;
}): { ok: boolean; errors: string[]; eventId: string | null } {
  const errors: string[] = [];
  const sinceMs = Date.parse(input.since);
  if (!Number.isFinite(sinceMs)) errors.push('join lower bound is not a valid ISO timestamp');
  if (input.discordMember.id !== input.memberId) errors.push('Discord member id does not match requested member');
  if (input.discordMember.bot) errors.push('join actor is a bot; JoinRiskScorer intentionally ignores bot joins');
  const joinedMs = Date.parse(input.discordMember.joined_at);
  if (!Number.isFinite(joinedMs) || joinedMs < sinceMs) errors.push('Discord joined_at is before the run lower bound');

  const eventRows = input.eventRows.filter((row) =>
    row.member_id === input.memberId
    && Date.parse(row.occurred_at) >= sinceMs);
  const riskRows = input.riskRows.filter((row) =>
    row.member_id === input.memberId
    && Date.parse(row.joined_at) >= sinceMs);
  if (eventRows.length !== 1) errors.push(`expected one member_join row after the lower bound, found ${eventRows.length}`);
  if (riskRows.length !== 1) errors.push(`expected one join_risk_flags row after the lower bound, found ${riskRows.length}`);

  const event = eventRows[0];
  const risk = riskRows[0];
  if (event && Date.parse(event.occurred_at) !== joinedMs) {
    errors.push('member_join occurred_at does not match Discord joined_at');
  }
  if (risk && Date.parse(risk.joined_at) !== joinedMs) {
    errors.push('join_risk_flags joined_at does not match Discord joined_at');
  }
  const expectedEventId = risk ? `${input.guildId}:${input.memberId}:${risk.joined_at}` : null;
  if (risk && risk.event_id !== expectedEventId) errors.push('join risk event id is not the gateway member/joined_at identity');
  if (event && risk && event.source !== risk.source) errors.push('member_join and join-risk source attribution differ');
  if (risk && input.expectedBulkWindow !== undefined && Boolean(risk.bulk_join_window) !== input.expectedBulkWindow) {
    errors.push(`bulk_join_window is ${Boolean(risk.bulk_join_window)}, expected ${input.expectedBulkWindow}`);
  }
  if (risk && input.expectedFlagged !== undefined && Boolean(risk.flagged) !== input.expectedFlagged) {
    errors.push(`flagged is ${Boolean(risk.flagged)}, expected ${input.expectedFlagged}`);
  }

  return { ok: errors.length === 0, errors, eventId: expectedEventId };
}
