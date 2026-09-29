import { randomUUID } from 'node:crypto';
import type { Db } from '../store/driver.ts';

export type RsvpStatus = 'going' | 'interested' | 'declined';
export type FeedKind = 'rss' | 'youtube' | 'twitch';
export type FeedDeliveryState = 'pending' | 'delivered';

export interface EventRsvpRow {
  guildId: string;
  eventId: string;
  userId: string;
  status: RsvpStatus;
  respondedAt: string;
}

export interface LfgPostRow {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  startsAt: string;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
}

export interface LfgRoleRow {
  lfgId: string;
  roleKey: string;
  label: string;
  slots: number;
  position: number;
}

export interface LfgSignupRow {
  lfgId: string;
  userId: string;
  roleKey: string;
  joinedAt: string;
}

export interface FeedRelayRow {
  id: string;
  guildId: string;
  channelId: string;
  kind: FeedKind;
  source: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedDeliveryRow {
  feedId: string;
  itemKey: string;
  nonce: string;
  state: FeedDeliveryState;
  messageId: string | null;
  firstSeenAt: string;
  deliveredAt: string | null;
  claimToken: string | null;
  claimedAt: string | null;
}

export interface AnnouncementsAuditInput {
  guildId: string;
  actorId: string | null;
  action: string;
  targetKey: string | null;
  outcome: string;
  reason?: string;
}

function mapRsvp(row: Record<string, unknown>): EventRsvpRow {
  return {
    guildId: String(row.guild_id),
    eventId: String(row.event_id),
    userId: String(row.user_id),
    status: String(row.status) as RsvpStatus,
    respondedAt: String(row.responded_at),
  };
}

function mapLfg(row: Record<string, unknown>): LfgPostRow {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    title: String(row.title),
    startsAt: String(row.starts_at),
    status: String(row.status) as LfgPostRow['status'],
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : String(row.closed_at),
  };
}

function mapRole(row: Record<string, unknown>): LfgRoleRow {
  return {
    lfgId: String(row.lfg_id),
    roleKey: String(row.role_key),
    label: String(row.label),
    slots: Number(row.slots),
    position: Number(row.position),
  };
}

function mapSignup(row: Record<string, unknown>): LfgSignupRow {
  return {
    lfgId: String(row.lfg_id),
    userId: String(row.user_id),
    roleKey: String(row.role_key),
    joinedAt: String(row.joined_at),
  };
}

function mapFeed(row: Record<string, unknown>): FeedRelayRow {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    kind: String(row.kind) as FeedKind,
    source: String(row.source),
    enabled: !!row.enabled,
    lastCheckedAt:
      row.last_checked_at === null || row.last_checked_at === undefined ? null : String(row.last_checked_at),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDelivery(row: Record<string, unknown>): FeedDeliveryRow {
  return {
    feedId: String(row.feed_id),
    itemKey: String(row.item_key),
    nonce: String(row.nonce),
    state: String(row.state) as FeedDeliveryState,
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    firstSeenAt: String(row.first_seen_at),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
    claimToken: row.claim_token === null || row.claim_token === undefined ? null : String(row.claim_token),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : String(row.claimed_at),
  };
}

export class AnnouncementsStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async putRsvp(row: EventRsvpRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO event_rsvps (guild_id, event_id, user_id, status, responded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, event_id, user_id) DO UPDATE SET
         status = excluded.status, responded_at = excluded.responded_at`,
    ).run(row.guildId, row.eventId, row.userId, row.status, row.respondedAt);
  }

  async getRsvp(guildId: string, eventId: string, userId: string): Promise<EventRsvpRow | null> {
    const row = await this.db.prepare(
      `SELECT * FROM event_rsvps WHERE guild_id = ? AND event_id = ? AND user_id = ?`,
    ).get(guildId, eventId, userId);
    return row ? mapRsvp(row) : null;
  }

  listRsvps(guildId: string, eventId: string): Promise<EventRsvpRow[]> {
    return this.db.prepare(
      `SELECT * FROM event_rsvps WHERE guild_id = ? AND event_id = ? ORDER BY responded_at, user_id`,
    ).all(guildId, eventId).then((rows) => rows.map(mapRsvp));
  }

  async putLfg(row: LfgPostRow, roles: LfgRoleRow[], replaceRoles = true): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.prepare(
        `INSERT INTO lfg_posts
           (id, guild_id, channel_id, message_id, title, starts_at, status, created_by, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           channel_id = excluded.channel_id, message_id = excluded.message_id,
           title = excluded.title, starts_at = excluded.starts_at, status = excluded.status,
           closed_at = excluded.closed_at
         WHERE lfg_posts.guild_id = excluded.guild_id`,
      ).run(
        row.id, row.guildId, row.channelId, row.messageId, row.title, row.startsAt,
        row.status, row.createdBy, row.createdAt, row.closedAt,
      );
      if (!replaceRoles) return;
      await tx.prepare(`DELETE FROM lfg_roles WHERE lfg_id = ?`).run(row.id);
      for (const role of roles) {
        await tx.prepare(
          `INSERT INTO lfg_roles (lfg_id, role_key, label, slots, position) VALUES (?, ?, ?, ?, ?)`,
        ).run(role.lfgId, role.roleKey, role.label, role.slots, role.position);
      }
    });
  }

  async getLfg(guildId: string, id: string): Promise<LfgPostRow | null> {
    const row = await this.db.prepare(`SELECT * FROM lfg_posts WHERE guild_id = ? AND id = ?`).get(guildId, id);
    return row ? mapLfg(row) : null;
  }

  async deleteLfg(guildId: string, id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM lfg_posts WHERE guild_id = ? AND id = ?`).run(guildId, id);
    return result.changes > 0;
  }

  listLfgRoles(id: string): Promise<LfgRoleRow[]> {
    return this.db.prepare(`SELECT * FROM lfg_roles WHERE lfg_id = ? ORDER BY position`).all(id).then((r) => r.map(mapRole));
  }

  listLfgSignups(id: string): Promise<LfgSignupRow[]> {
    return this.db.prepare(`SELECT * FROM lfg_signups WHERE lfg_id = ? ORDER BY joined_at, user_id`).all(id).then((r) => r.map(mapSignup));
  }

  async signupLfg(guildId: string, id: string, roleKey: string, userId: string, joinedAt: string): Promise<'joined' | 'moved' | 'full' | 'closed' | 'missing'> {
    return this.db.transaction(async (tx) => {
      await tx.prepare(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`).get(`lfg:${guildId}:${id}`);
      const post = await tx.prepare(`SELECT status FROM lfg_posts WHERE guild_id = ? AND id = ?`).get<{ status: string }>(guildId, id);
      if (!post) return 'missing';
      if (post.status !== 'open') return 'closed';
      const role = await tx.prepare(`SELECT slots FROM lfg_roles WHERE lfg_id = ? AND role_key = ?`).get<{ slots: number }>(id, roleKey);
      if (!role) return 'missing';
      const existing = await tx.prepare(`SELECT role_key FROM lfg_signups WHERE lfg_id = ? AND user_id = ?`).get<{ role_key: string }>(id, userId);
      if (existing?.role_key === roleKey) return 'joined';
      const used = await tx.prepare(
        `SELECT COUNT(*) AS total FROM lfg_signups WHERE lfg_id = ? AND role_key = ? AND user_id <> ?`,
      ).get<{ total: number }>(id, roleKey, userId);
      if (Number(used?.total ?? 0) >= Number(role.slots)) return 'full';
      await tx.prepare(
        `INSERT INTO lfg_signups (lfg_id, user_id, role_key, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (lfg_id, user_id) DO UPDATE SET role_key = excluded.role_key, joined_at = excluded.joined_at`,
      ).run(id, userId, roleKey, joinedAt);
      return existing ? 'moved' : 'joined';
    });
  }

  async leaveLfg(guildId: string, id: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM lfg_signups WHERE lfg_id = ? AND user_id = ?
       AND EXISTS (SELECT 1 FROM lfg_posts WHERE lfg_posts.id = lfg_signups.lfg_id AND lfg_posts.guild_id = ?)`,
    ).run(id, userId, guildId);
    return result.changes > 0;
  }

  async closeLfg(guildId: string, id: string, closedAt: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE lfg_posts SET status = 'closed', closed_at = ? WHERE guild_id = ? AND id = ? AND status = 'open'`,
    ).run(closedAt, guildId, id);
    return result.changes > 0;
  }

  async putFeed(row: FeedRelayRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO feed_relays
         (id, guild_id, channel_id, kind, source, enabled, last_checked_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         channel_id = excluded.channel_id, kind = excluded.kind, source = excluded.source,
         enabled = excluded.enabled, updated_at = excluded.updated_at
       WHERE feed_relays.guild_id = excluded.guild_id`,
    ).run(
      row.id, row.guildId, row.channelId, row.kind, row.source, row.enabled ? 1 : 0,
      row.lastCheckedAt, row.createdBy, row.createdAt, row.updatedAt,
    );
  }

  listFeeds(guildId: string): Promise<FeedRelayRow[]> {
    return this.db.prepare(`SELECT * FROM feed_relays WHERE guild_id = ? ORDER BY created_at, id`).all(guildId).then((r) => r.map(mapFeed));
  }

  listEnabledFeeds(guildId: string): Promise<FeedRelayRow[]> {
    return this.db.prepare(`SELECT * FROM feed_relays WHERE guild_id = ? AND enabled = TRUE ORDER BY id`).all(guildId).then((r) => r.map(mapFeed));
  }

  async deleteFeed(guildId: string, id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM feed_relays WHERE guild_id = ? AND id = ?`).run(guildId, id);
    return result.changes > 0;
  }

  /**
   * Claim one delivery of a feed item. The INSERT is the fast path; when the
   * row already exists the claim is refused unless the previous owner's lease
   * expired — a worker that crashes between the claim insert and
   * markDelivered/releaseDelivery must not wedge the item forever. Only
   * `pending` rows are ever taken over: `delivered` rows also carry NULL
   * `claimed_at`, so the state guard is what keeps them final.
   */
  async claimDelivery(row: FeedDeliveryRow, expiredClaimCutoffIso?: string): Promise<FeedDeliveryRow | null> {
    const inserted = await this.db.prepare(
      `INSERT INTO feed_deliveries
         (feed_id, item_key, nonce, state, message_id, first_seen_at, delivered_at, claim_token, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id, item_key) DO NOTHING`,
    ).run(
      row.feedId, row.itemKey, row.nonce, row.state, row.messageId, row.firstSeenAt,
      row.deliveredAt, row.claimToken, row.claimedAt,
    );
    if (inserted.changes === 0) {
      if (!expiredClaimCutoffIso) return null;
      const reclaimed = await this.db.prepare(
        `UPDATE feed_deliveries
           SET claim_token = ?, claimed_at = ?
         WHERE feed_id = ? AND item_key = ? AND state = 'pending'
           AND (claimed_at IS NULL OR claimed_at <= ?)
         RETURNING *`,
      ).get(row.claimToken, row.claimedAt, row.feedId, row.itemKey, expiredClaimCutoffIso);
      return reclaimed ? mapDelivery(reclaimed) : null;
    }
    const stored = await this.db.prepare(
      `SELECT * FROM feed_deliveries WHERE feed_id = ? AND item_key = ? AND claim_token = ?`,
    ).get(row.feedId, row.itemKey, row.claimToken);
    if (!stored) throw new Error('Feed delivery claim disappeared.');
    return mapDelivery(stored);
  }

  async releaseDelivery(feedId: string, itemKey: string, claimToken: string): Promise<void> {
    await this.db.prepare(
      `DELETE FROM feed_deliveries
       WHERE feed_id = ? AND item_key = ? AND state = 'pending' AND claim_token = ?`,
    ).run(feedId, itemKey, claimToken);
  }

  async markDelivered(feedId: string, itemKey: string, claimToken: string, messageId: string, deliveredAt: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE feed_deliveries
       SET state = 'delivered', message_id = ?, delivered_at = ?, claim_token = NULL, claimed_at = NULL
       WHERE feed_id = ? AND item_key = ? AND state = 'pending' AND claim_token = ?`,
    ).run(messageId, deliveredAt, feedId, itemKey, claimToken);
    return result.changes > 0;
  }

  async markFeedChecked(feedId: string, checkedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE feed_relays SET last_checked_at = ? WHERE id = ?`).run(checkedAt, feedId);
  }

  async audit(row: AnnouncementsAuditInput, atIso: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO announcements_audit_log
         (id, guild_id, actor_id, action, target_key, outcome, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), row.guildId, row.actorId, row.action, row.targetKey, row.outcome, row.reason ?? null, atIso);
  }
}
