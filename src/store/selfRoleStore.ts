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
  renewAfterMs?: number;
}

export interface SelfRolePanelClaim {
  guildId: string;
  memberId: string;
  panelId: string;
  token: string;
  generation: number;
  latestEventId: string | null;
  latestEventOrder: string | null;
  latestOptionKey: string | null;
  targetCommitted: boolean;
  superseded?: boolean;
  renewAfterMs?: number;
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
    const expiresAt = this.expiresAt(now);
    const token = randomUUID();
    return this.db.transaction(async (tx) => {
      const inserted = await tx.prepare(
        `INSERT INTO self_role_audit
           (event_id, event_order, guild_id, panel_id, member_id, source_id, option_key, role_id,
            source, operation, outcome, code, reason, added_role_ids, removed_role_ids,
            attempted_added_role_ids, attempted_removed_role_ids,
            compensated_added_role_ids, compensated_removed_role_ids,
            unresolved_added_role_ids, unresolved_removed_role_ids,
            desired_role_ids, pre_mutation_role_ids, claim_token, claim_generation,
            processing_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      ).get<{ event_id: string }>(
        row.eventId, row.eventOrder ?? null, row.guildId, row.panelId, row.memberId, row.sourceId, row.optionKey, row.roleId,
        row.source, row.operation, 'processing', null, null, ...effectValues(row),
        JSON.stringify(row.desiredRoleIds ?? []), JSON.stringify(row.preMutationRoleIds ?? []), token,
        expiresAt, claimedAt,
      );
      if (inserted) return claim(token, 1, false, row, this.renewAfterMs());

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
        renewAfterMs: this.renewAfterMs(),
      };
    });
  }

  async ownsClaim(eventId: string, claim: SelfRoleClaim): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT event_id FROM self_role_audit
        WHERE event_id = ? AND outcome = 'processing' AND claim_token = ? AND claim_generation = ?
          AND processing_expires_at > ?`,
    ).get(eventId, claim.token, claim.generation, this.now().toISOString());
    return !!row;
  }

  async renewClaim(eventId: string, claim: SelfRoleClaim): Promise<boolean> {
    const now = this.now();
    const result = await this.db.prepare(
      `UPDATE self_role_audit SET processing_expires_at = ?
        WHERE event_id = ? AND outcome = 'processing' AND claim_token = ? AND claim_generation = ?
          AND processing_expires_at > ?`,
    ).run(this.expiresAt(now), eventId, claim.token, claim.generation, now.toISOString());
    return result.changes === 1;
  }

  /** Try once to claim an exclusive guild/member/panel lane. */
  async claimPanel(
    guildId: string,
    memberId: string,
    panelId: string,
    supersedingEventId?: string,
    supersedingEventOrder?: string,
  ): Promise<SelfRolePanelClaim | null> {
    const now = this.now();
    const claimedAt = now.toISOString();
    const expiresAt = this.expiresAt(now);
    const token = randomUUID();
    return this.db.transaction(async (tx) => {
      const eventOrder = supersedingEventOrder ?? null;
      const supersedeOlderEvents = async (): Promise<void> => {
        if (!supersedingEventId || !eventOrder) return;
        // Only the event that actually won the exclusive panel lane may retire
        // unfinished intents that are chronologically older than itself.
        await tx.prepare(
          `UPDATE self_role_audit
              SET outcome = 'rejected', code = 'superseded_by_later_event',
                  reason = 'a later exclusive-panel event was accepted', processing_expires_at = NULL
            WHERE guild_id = ? AND member_id = ? AND panel_id = ?
              AND event_id <> ? AND event_order < ? AND outcome = 'processing'`,
        ).run(guildId, memberId, panelId, supersedingEventId, eventOrder);
      };

      const inserted = await tx.prepare(
        `INSERT INTO self_role_panel_claims
           (guild_id, member_id, panel_id, claim_token, claim_generation, processing_expires_at,
            latest_event_id, latest_option_key, target_committed, latest_event_order)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, FALSE, ?)
         ON CONFLICT (guild_id, member_id, panel_id) DO NOTHING
         RETURNING guild_id`,
      ).get(
        guildId, memberId, panelId, token, expiresAt,
        supersedingEventId ?? null, null, eventOrder,
      );
      if (inserted) {
        await supersedeOlderEvents();
        return {
          guildId, memberId, panelId, token, generation: 1,
          latestEventId: supersedingEventId ?? null,
          latestEventOrder: eventOrder,
          latestOptionKey: null,
          targetCommitted: false,
          renewAfterMs: this.renewAfterMs(),
        };
      }

      const prior = await tx.prepare(
        `SELECT claim_generation, processing_expires_at, latest_event_id, latest_option_key, target_committed, latest_event_order
           FROM self_role_panel_claims
          WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
      ).get<{
        claim_generation: number;
        processing_expires_at: string;
        latest_event_id: string | null;
        latest_option_key: string | null;
        target_committed: boolean | number;
        latest_event_order: string | null;
      }>(guildId, memberId, panelId);
      if (!prior) return null;
      const priorEventOrder = prior.latest_event_order ?? eventOrderFromSnowflake(prior.latest_event_id);
      if (!prior.latest_event_order && priorEventOrder) {
        await tx.prepare(
          `UPDATE self_role_panel_claims SET latest_event_order = ?
            WHERE guild_id = ? AND member_id = ? AND panel_id = ? AND latest_event_order IS NULL`,
        ).run(priorEventOrder, guildId, memberId, panelId);
      }
      if (eventOrder && priorEventOrder && eventOrder < priorEventOrder) {
        return {
          guildId, memberId, panelId, token, generation: Number(prior.claim_generation),
          latestEventId: prior.latest_event_id,
          latestEventOrder: priorEventOrder,
          latestOptionKey: prior.latest_option_key,
          targetCommitted: !!prior.target_committed,
          superseded: true,
        };
      }
      if (prior.processing_expires_at > claimedAt) return null;
      const generation = Number(prior.claim_generation) + 1;
      const latestEventId = supersedingEventId ?? prior.latest_event_id;
      const latestEventOrder = eventOrder ?? priorEventOrder;
      const latestOptionKey = prior.latest_option_key;
      const recovered = await tx.prepare(
        `UPDATE self_role_panel_claims
            SET claim_token = ?, claim_generation = ?, processing_expires_at = ?,
                latest_event_id = ?, latest_option_key = ?, latest_event_order = ?
          WHERE guild_id = ? AND member_id = ? AND panel_id = ?
            AND claim_generation = ? AND processing_expires_at <= ?`,
      ).run(
        token, generation, expiresAt, latestEventId, latestOptionKey, latestEventOrder,
        guildId, memberId, panelId, prior.claim_generation, claimedAt,
      );
      if (recovered.changes !== 1) return null;
      await supersedeOlderEvents();
      return {
        guildId, memberId, panelId, token, generation,
        latestEventId,
        latestEventOrder,
        latestOptionKey,
        targetCommitted: !!prior.target_committed,
        renewAfterMs: this.renewAfterMs(),
      };
    });
  }

  async ownsPanelClaim(claim: SelfRolePanelClaim): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT guild_id FROM self_role_panel_claims
        WHERE guild_id = ? AND member_id = ? AND panel_id = ?
          AND claim_token = ? AND claim_generation = ? AND processing_expires_at > ?`,
    ).get(
      claim.guildId, claim.memberId, claim.panelId, claim.token, claim.generation,
      this.now().toISOString(),
    );
    return !!row;
  }

  async renewPanelClaim(claim: SelfRolePanelClaim): Promise<boolean> {
    const now = this.now();
    const result = await this.db.prepare(
      `UPDATE self_role_panel_claims SET processing_expires_at = ?
        WHERE guild_id = ? AND member_id = ? AND panel_id = ?
          AND claim_token = ? AND claim_generation = ? AND processing_expires_at > ?`,
    ).run(
      this.expiresAt(now), claim.guildId, claim.memberId, claim.panelId,
      claim.token, claim.generation, now.toISOString(),
    );
    return result.changes === 1;
  }

  async setPanelClaimOption(claim: SelfRolePanelClaim, optionKey: string | null): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE self_role_panel_claims SET latest_option_key = ?, target_committed = TRUE
        WHERE guild_id = ? AND member_id = ? AND panel_id = ?
          AND claim_token = ? AND claim_generation = ? AND processing_expires_at > ?`,
    ).run(
      optionKey, claim.guildId, claim.memberId, claim.panelId,
      claim.token, claim.generation, this.now().toISOString(),
    );
    if (result.changes === 1) {
      claim.latestOptionKey = optionKey;
      claim.targetCommitted = true;
    }
    return result.changes === 1;
  }

  async finishAuditAndSetPanelOption(
    row: SelfRoleAuditRow,
    claim: SelfRoleClaim,
    panelClaim: SelfRolePanelClaim,
    optionKey: string | null,
  ): Promise<boolean> {
    const now = this.now().toISOString();
    const committed = await this.db.transaction(async (tx) => {
      const panel = await tx.prepare(
        `UPDATE self_role_panel_claims SET latest_option_key = ?, target_committed = TRUE
          WHERE guild_id = ? AND member_id = ? AND panel_id = ?
            AND claim_token = ? AND claim_generation = ? AND processing_expires_at > ?`,
      ).run(
        optionKey, panelClaim.guildId, panelClaim.memberId, panelClaim.panelId,
        panelClaim.token, panelClaim.generation, now,
      );
      if (panel.changes !== 1) return false;
      const audit = await tx.prepare(
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
      if (audit.changes !== 1) throw new Error(`self-role audit ${row.eventId} claim is stale`);
      return true;
    });
    if (committed) {
      panelClaim.latestOptionKey = optionKey;
      panelClaim.targetCommitted = true;
    }
    return committed;
  }

  async updateAuditEffects(row: SelfRoleAuditRow, claim: SelfRoleClaim): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE self_role_audit SET
         added_role_ids = ?, removed_role_ids = ?,
         attempted_added_role_ids = ?, attempted_removed_role_ids = ?,
         compensated_added_role_ids = ?, compensated_removed_role_ids = ?,
         unresolved_added_role_ids = ?, unresolved_removed_role_ids = ?
       WHERE event_id = ? AND outcome = 'processing' AND claim_token = ? AND claim_generation = ?`,
    ).run(...effectValues(row), row.eventId, claim.token, claim.generation);
    return result.changes === 1;
  }

  async releasePanelClaim(claim: SelfRolePanelClaim): Promise<void> {
    await this.db.prepare(
      `UPDATE self_role_panel_claims
          SET processing_expires_at = ?
        WHERE guild_id = ? AND member_id = ? AND panel_id = ?
          AND claim_token = ? AND claim_generation = ?`,
    ).run(this.now().toISOString(), claim.guildId, claim.memberId, claim.panelId, claim.token, claim.generation);
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
        renewAfterMs: this.renewAfterMs(),
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

  private expiresAt(now: Date): string {
    return new Date(now.getTime() + this.leaseMs).toISOString();
  }

  private renewAfterMs(): number {
    return Math.max(1, Math.floor(this.leaseMs / 3));
  }
}

function claim(
  token: string,
  generation: number,
  recovered: boolean,
  row: SelfRoleAuditRow,
  renewAfterMs: number,
): SelfRoleClaim {
  return {
    token,
    generation,
    recovered,
    desiredRoleIds: row.desiredRoleIds ?? [],
    preMutationRoleIds: row.preMutationRoleIds ?? [],
    renewAfterMs,
  };
}

function parseIds(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : [];
}

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

function eventOrderFromSnowflake(eventId: string | null): string | null {
  if (!eventId || !/^\d{17,20}$/.test(eventId)) return null;
  const timestamp = (BigInt(eventId) >> 22n) + DISCORD_EPOCH_MS;
  return `${timestamp.toString().padStart(13, '0')}:${eventId.padStart(20, '0')}`;
}

function effectValues(row: SelfRoleAuditRow): string[] {
  return [
    JSON.stringify(row.addedRoleIds), JSON.stringify(row.removedRoleIds),
    JSON.stringify(row.attemptedAddedRoleIds), JSON.stringify(row.attemptedRemovedRoleIds),
    JSON.stringify(row.compensatedAddedRoleIds), JSON.stringify(row.compensatedRemovedRoleIds),
    JSON.stringify(row.unresolvedAddedRoleIds), JSON.stringify(row.unresolvedRemovedRoleIds),
  ];
}
