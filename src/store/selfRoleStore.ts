import { randomUUID } from 'node:crypto';
import type { Db } from './driver.ts';
import type { SelfRoleAuditRow } from '../selfRoles/types.ts';

export const SELF_ROLE_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface SelfRoleClaim {
  token: string;
  generation: number;
  recovered: boolean;
  desiredRoleIds: string[];
  preMutationRoleIds: string[];
}

export class SelfRoleStore {
  private db: Db;
  private now: () => Date;
  private leaseMs: number;

  constructor(db: Db, opts: { now?: () => Date; leaseMs?: number } = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.leaseMs = opts.leaseMs ?? SELF_ROLE_CLAIM_LEASE_MS;
  }

  /** Claim a dispatch; expired leases transfer to a new fenced generation. */
  async claimAudit(row: SelfRoleAuditRow): Promise<SelfRoleClaim | null> {
    const now = this.now();
    const claimedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const token = randomUUID();
    return this.db.transaction(async (tx) => {
      const inserted = await tx.prepare(
        `INSERT INTO self_role_audit
           (event_id, guild_id, panel_id, member_id, source_id, option_key, role_id,
            source, operation, outcome, code, reason, added_role_ids, removed_role_ids,
            attempted_added_role_ids, attempted_removed_role_ids,
            compensated_added_role_ids, compensated_removed_role_ids,
            unresolved_added_role_ids, unresolved_removed_role_ids,
            desired_role_ids, pre_mutation_role_ids, claim_token, claim_generation,
            processing_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      ).get<{ event_id: string }>(
        row.eventId, row.guildId, row.panelId, row.memberId, row.sourceId, row.optionKey, row.roleId,
        row.source, row.operation, 'processing', null, null, ...effectValues(row),
        JSON.stringify(row.desiredRoleIds ?? []), JSON.stringify(row.preMutationRoleIds ?? []), token,
        expiresAt, claimedAt,
      );
      if (inserted) return claim(token, 1, false, row);

      const prior = await tx.prepare(
        `SELECT claim_generation, desired_role_ids, pre_mutation_role_ids
           FROM self_role_audit
          WHERE event_id = ? AND outcome = 'processing' AND processing_expires_at <= ?`,
      ).get<{ claim_generation: number; desired_role_ids: string; pre_mutation_role_ids: string }>(row.eventId, claimedAt);
      if (!prior) return null;
      const generation = Number(prior.claim_generation) + 1;
      const recovered = await tx.prepare(
        `UPDATE self_role_audit SET claim_token = ?, claim_generation = ?, processing_expires_at = ?
          WHERE event_id = ? AND outcome = 'processing' AND claim_generation = ? AND processing_expires_at <= ?`,
      ).run(token, generation, expiresAt, row.eventId, prior.claim_generation, claimedAt);
      if (recovered.changes !== 1) return null;
      return {
        token,
        generation,
        recovered: true,
        desiredRoleIds: parseIds(prior.desired_role_ids),
        preMutationRoleIds: parseIds(prior.pre_mutation_role_ids),
      };
    });
  }

  async ownsClaim(eventId: string, claim: SelfRoleClaim): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT event_id FROM self_role_audit
        WHERE event_id = ? AND outcome = 'processing' AND claim_token = ? AND claim_generation = ?`,
    ).get(eventId, claim.token, claim.generation);
    return !!row;
  }

  async finishAudit(row: SelfRoleAuditRow, claim?: SelfRoleClaim): Promise<void> {
    if (!claim) {
      const current = await this.db.prepare(
        `SELECT claim_token, claim_generation, desired_role_ids, pre_mutation_role_ids
           FROM self_role_audit WHERE event_id = ? AND outcome = 'processing'`,
      ).get<{ claim_token: string; claim_generation: number; desired_role_ids: string; pre_mutation_role_ids: string }>(row.eventId);
      if (!current?.claim_token) throw new Error(`self-role audit ${row.eventId} was not claimed`);
      claim = {
        token: current.claim_token,
        generation: Number(current.claim_generation),
        recovered: false,
        desiredRoleIds: parseIds(current.desired_role_ids),
        preMutationRoleIds: parseIds(current.pre_mutation_role_ids),
      };
    }
    const result = await this.db.prepare(
      `UPDATE self_role_audit SET
         guild_id = ?, panel_id = ?, member_id = ?, source_id = ?, option_key = ?, role_id = ?,
         source = ?, operation = ?, outcome = ?, code = ?, reason = ?,
         added_role_ids = ?, removed_role_ids = ?,
         attempted_added_role_ids = ?, attempted_removed_role_ids = ?,
         compensated_added_role_ids = ?, compensated_removed_role_ids = ?,
         unresolved_added_role_ids = ?, unresolved_removed_role_ids = ?,
         processing_expires_at = NULL
       WHERE event_id = ? AND outcome = 'processing' AND claim_token = ? AND claim_generation = ?`,
    ).run(
      row.guildId, row.panelId, row.memberId, row.sourceId, row.optionKey, row.roleId,
      row.source, row.operation, row.outcome, row.code, row.reason, ...effectValues(row),
      row.eventId, claim.token, claim.generation,
    );
    if (result.changes !== 1) throw new Error(`self-role audit ${row.eventId} claim is stale`);
  }
}

function claim(token: string, generation: number, recovered: boolean, row: SelfRoleAuditRow): SelfRoleClaim {
  return {
    token,
    generation,
    recovered,
    desiredRoleIds: row.desiredRoleIds ?? [],
    preMutationRoleIds: row.preMutationRoleIds ?? [],
  };
}

function parseIds(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : [];
}

function effectValues(row: SelfRoleAuditRow): string[] {
  return [
    JSON.stringify(row.addedRoleIds), JSON.stringify(row.removedRoleIds),
    JSON.stringify(row.attemptedAddedRoleIds), JSON.stringify(row.attemptedRemovedRoleIds),
    JSON.stringify(row.compensatedAddedRoleIds), JSON.stringify(row.compensatedRemovedRoleIds),
    JSON.stringify(row.unresolvedAddedRoleIds), JSON.stringify(row.unresolvedRemovedRoleIds),
  ];
}
