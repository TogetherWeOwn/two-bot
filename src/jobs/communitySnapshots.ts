import type { Db } from '../store/db.ts';
import { DiscordRest, fetchAllMembersStrict, type RawMember } from '../discord/rest.ts';
import { ANOMALIES, windowBounds } from '../analytics/anomalies.ts';
import { nowIso } from '../core/events.ts';
import { log } from '../core/log.ts';

export const LIVE_COUNTER_INTERVAL_MS = 60 * 1000;
export const RANK_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

export const RANKS = [
  { key: 'prospect', label: 'Prospect', order: 1 },
  { key: 'member', label: 'Member', order: 2 },
  { key: 'soldier', label: 'Soldier', order: 3 },
  { key: 'veteran', label: 'Veteran', order: 4 },
  { key: 'legend', label: 'Legend', order: 5 },
] as const;

export type RankKey = (typeof RANKS)[number]['key'];

interface RankRole {
  key: RankKey;
  label: string;
  order: number;
  roleId: string;
}

export interface RaidWindow {
  id: string;
  excludedMemberIds: Set<string>;
}

export interface CommunitySnapshot {
  humanMemberCount: number;
  rankedMemberCount: number;
  rankRows: Array<{
    key: RankKey;
    label: string;
    order: number;
    roleId: string;
    memberCount: number;
    holdersCount: number;
  }>;
  memberRanks: Array<{ memberId: string; rankKey: RankKey | null }>;
  excludedMemberIds: string[];
  nested: boolean;
  raidAccountsExcluded: number;
}

export interface CommunitySnapshotDeps {
  db: Db;
  rest: DiscordRest;
  guildId: string;
  now?: () => string;
}

export interface CollectionResult {
  recorded: boolean;
  reason?: 'discord_read_failed' | 'raid_history_not_grounded' | 'rank_role_missing' | 'ranks_not_nested';
  observedAt: string;
  humanMemberCount: number | null;
  rankedMemberCount: number | null;
  raidAccountsExcluded: number | null;
}

function validMember(member: RawMember): member is RawMember & { user: { id: string; bot?: boolean } } {
  return typeof member.user?.id === 'string' && member.user.id.length > 0;
}

async function readRaidWindows(db: Db, guildId: string): Promise<RaidWindow[] | null> {
  const raids = ANOMALIES.filter((a) => a.kind === 'raid').sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  const windows: RaidWindow[] = [];

  for (const raid of raids) {
    const { from, to } = windowBounds(raid);
    const rows = await db
      .prepare(
        `SELECT member_id, first_message_at, first_voice_at, left_at
           FROM members
          WHERE guild_id = ? AND joined_at >= ? AND joined_at < ? AND is_bot = 0`,
      )
      .all<{ member_id: string; first_message_at: string | null; first_voice_at: string | null; left_at: string | null }>(guildId, from, to);
    if (rows.length === 0) return null;
    windows.push({
      id: raid.id,
      excludedMemberIds: new Set(
        rows
          .filter((r) => r.left_at === null && r.first_message_at === null && r.first_voice_at === null)
          .map((r) => r.member_id),
      ),
    });
  }

  return windows;
}

async function fetchRankRoles(rest: DiscordRest, guildId: string): Promise<RankRole[] | null> {
  const roles = await rest.get<Array<{ id?: string; name?: string }>>(`/guilds/${guildId}/roles`);
  if (!roles) return null;

  const found: RankRole[] = [];
  for (const rank of RANKS) {
    const matches = roles.filter(
      (role) => typeof role.id === 'string' && role.name?.trim().toLowerCase() === rank.label.toLowerCase(),
    );
    if (matches.length !== 1) return null;
    found.push({ ...rank, roleId: matches[0].id as string });
  }
  return found;
}

export function buildCommunitySnapshot(
  members: RawMember[],
  rankRoles: RankRole[],
  raidWindows: RaidWindow[],
): CommunitySnapshot | null {
  if (members.length === 0 || members.some((member) => !validMember(member))) return null;

  const raidAccounts = new Set(raidWindows.flatMap((window) => [...window.excludedMemberIds]));
  const included = members
    .filter(validMember)
    .filter((member) => member.user.bot !== true && !raidAccounts.has(member.user.id));
  const roleIds = rankRoles.map((rank) => rank.roleId);
  const holders = new Map<RankKey, number>(RANKS.map((rank) => [rank.key, 0]));
  const highest = new Map<RankKey, number>(RANKS.map((rank) => [rank.key, 0]));
  const memberRanks: CommunitySnapshot['memberRanks'] = [];
  let nested = true;

  for (const member of included) {
    const held = new Set(member.roles ?? []);
    const heldIndexes = roleIds.flatMap((roleId, index) => (held.has(roleId) ? [index] : []));
    for (const index of heldIndexes) {
      const rank = rankRoles[index];
      holders.set(rank.key, (holders.get(rank.key) ?? 0) + 1);
    }

    if (heldIndexes.length === 0) {
      memberRanks.push({ memberId: member.user.id, rankKey: null });
      continue;
    }

    const highestIndex = Math.max(...heldIndexes);
    for (let index = 0; index <= highestIndex; index++) {
      if (!held.has(roleIds[index])) nested = false;
    }
    const rank = rankRoles[highestIndex];
    highest.set(rank.key, (highest.get(rank.key) ?? 0) + 1);
    memberRanks.push({ memberId: member.user.id, rankKey: rank.key });
  }

  const rankRows = rankRoles.map((rank) => ({
    ...rank,
    memberCount: highest.get(rank.key) ?? 0,
    holdersCount: holders.get(rank.key) ?? 0,
  }));
  return {
    humanMemberCount: included.length,
    rankedMemberCount: rankRows.reduce((sum, rank) => sum + rank.memberCount, 0),
    rankRows,
    memberRanks,
    // Exact `scripts/raid-list.ts` removal set: current, never-active accounts
    // from the dynamically-derived raid windows. Active joiners and accounts
    // already gone stay out of this set.
    excludedMemberIds: [...raidAccounts],
    nested,
    raidAccountsExcluded: members.filter((member) => raidAccounts.has(member.user?.id ?? '')).length,
  };
}

async function writeCounterTables(
  db: Db,
  guildId: string,
  observedAt: string,
  humanMemberCount: number,
): Promise<void> {
  for (const table of ['counter_snapshots', 'guild_counters']) {
    await db
      .prepare(
        `INSERT INTO ${table} (guild_id, human_member_count, human_member_count_at)
         VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET
           human_member_count = excluded.human_member_count,
           human_member_count_at = excluded.human_member_count_at`,
      )
      .run(guildId, humanMemberCount, observedAt);
  }
  // Pin the contract to the guild whose aggregates this transaction just wrote.
  await db.prepare(`UPDATE web_contract_meta SET guild_id = ? WHERE singleton = TRUE`).run(guildId);
}

async function writeCommunitySnapshot(
  db: Db,
  guildId: string,
  observedAt: string,
  snapshot: CommunitySnapshot,
): Promise<void> {
  await db.transaction((tx) =>
    writeCounterTables(tx, guildId, observedAt, snapshot.humanMemberCount),
  );
}

async function writeRankTables(
  db: Db,
  guildId: string,
  observedAt: string,
  snapshot: CommunitySnapshot,
): Promise<void> {
  for (const rank of snapshot.rankRows) {
    await db
      .prepare(
        `UPDATE rank_ladder
            SET rank_label = ?, role_id = ?
          WHERE rank_key = ?`,
      )
      .run(rank.label, rank.roleId, rank.key);
    await db
      .prepare(
        `INSERT INTO rank_snapshots (guild_id, rank_key, member_count, holders_count, snapshot_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, rank_key) DO UPDATE SET
           member_count = excluded.member_count,
           holders_count = excluded.holders_count,
           snapshot_at = excluded.snapshot_at`,
      )
      .run(guildId, rank.key, rank.memberCount, rank.holdersCount, observedAt);
  }

  await db.prepare(`DELETE FROM member_ranks WHERE guild_id = ?`).run(guildId);
  for (const member of snapshot.memberRanks) {
    await db
      .prepare(
        `INSERT INTO member_ranks (guild_id, member_id, rank_key, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(guildId, member.memberId, member.rankKey, observedAt);
  }

  await db.prepare(`DELETE FROM member_exclusions WHERE guild_id = ?`).run(guildId);
  for (const memberId of snapshot.excludedMemberIds) {
    await db
      .prepare(
        `INSERT INTO member_exclusions (guild_id, member_id, reason, updated_at)
         VALUES (?, ?, 'raid', ?)`,
      )
      .run(guildId, memberId, observedAt);
  }
}

async function readGroundedRoster(deps: CommunitySnapshotDeps): Promise<{
  observedAt: string;
  members: RawMember[] | null;
  raidWindows: RaidWindow[] | null;
  reason?: CollectionResult['reason'];
}> {
  const observedAt = (deps.now ?? nowIso)();
  const raidWindows = await readRaidWindows(deps.db, deps.guildId);
  if (!raidWindows) {
    return { observedAt, members: null, raidWindows: null, reason: 'raid_history_not_grounded' };
  }
  const members = await fetchAllMembersStrict(deps.rest, deps.guildId);
  if (!members) return { observedAt, members: null, raidWindows, reason: 'discord_read_failed' };
  return { observedAt, members, raidWindows };
}

async function collect(deps: CommunitySnapshotDeps): Promise<{
  observedAt: string;
  snapshot: CommunitySnapshot | null;
  reason?: CollectionResult['reason'];
}> {
  const roster = await readGroundedRoster(deps);
  if (!roster.members || !roster.raidWindows || roster.reason) {
    return { observedAt: roster.observedAt, snapshot: null, reason: roster.reason };
  }

  const rankRoles = await fetchRankRoles(deps.rest, deps.guildId);
  if (!rankRoles) return { observedAt: roster.observedAt, snapshot: null, reason: 'rank_role_missing' };

  const snapshot = buildCommunitySnapshot(roster.members, rankRoles, roster.raidWindows);
  if (!snapshot) return { observedAt: roster.observedAt, snapshot: null, reason: 'discord_read_failed' };
  if (!snapshot.nested) return { observedAt: roster.observedAt, snapshot: null, reason: 'ranks_not_nested' };
  return { observedAt: roster.observedAt, snapshot };
}

function liveSnapshot(members: RawMember[], raidWindows: RaidWindow[]): CommunitySnapshot | null {
  return buildCommunitySnapshot(
    members,
    RANKS.map((rank) => ({ ...rank, roleId: `unused:${rank.key}` })),
    raidWindows,
  );
}

function result(
  observedAt: string,
  snapshot: CommunitySnapshot | null,
  reason?: CollectionResult['reason'],
): CollectionResult {
  return {
    recorded: snapshot !== null && reason === undefined,
    reason,
    observedAt,
    humanMemberCount: snapshot?.humanMemberCount ?? null,
    rankedMemberCount: snapshot?.rankedMemberCount ?? null,
    raidAccountsExcluded: snapshot?.raidAccountsExcluded ?? null,
  };
}

export async function runLiveCounterCycle(deps: CommunitySnapshotDeps): Promise<CollectionResult> {
  const roster = await readGroundedRoster(deps);
  const snapshot =
    roster.members && roster.raidWindows ? liveSnapshot(roster.members, roster.raidWindows) : null;
  if (!snapshot || roster.reason) {
    log.error('community_counter_skipped', { guildId: deps.guildId, reason: roster.reason });
    return result(roster.observedAt, snapshot, roster.reason ?? 'discord_read_failed');
  }

  await writeCommunitySnapshot(deps.db, deps.guildId, roster.observedAt, snapshot);
  log.info('community_counter_recorded', {
    guildId: deps.guildId,
    humanMemberCount: snapshot.humanMemberCount,
    raidAccountsExcluded: snapshot.raidAccountsExcluded,
  });
  return result(roster.observedAt, snapshot);
}

export async function runRankSnapshotCycle(deps: CommunitySnapshotDeps): Promise<CollectionResult> {
  const collected = await collect(deps);
  if (!collected.snapshot || collected.reason) {
    log.error('rank_snapshot_skipped', { guildId: deps.guildId, reason: collected.reason });
    return result(collected.observedAt, collected.snapshot, collected.reason);
  }

  const ranked = collected.snapshot.rankedMemberCount;
  if (ranked > collected.snapshot.humanMemberCount) {
    log.error('rank_snapshot_invariant_failed', {
      guildId: deps.guildId,
      rankedMemberCount: ranked,
      humanMemberCount: collected.snapshot.humanMemberCount,
    });
    return result(collected.observedAt, null, 'ranks_not_nested');
  }

  const snapshot = collected.snapshot;
  await deps.db.transaction(async (tx) => {
    // Keep the count, five rank aggregates and per-member highest-rank cache on
    // one commit. Publishing a new denominator with yesterday's ladder would
    // make the cross-view invariant unprovable at the exact moment it matters.
    await writeCounterTables(tx, deps.guildId, collected.observedAt, snapshot.humanMemberCount);
    await writeRankTables(tx, deps.guildId, collected.observedAt, snapshot);
  });
  log.info('rank_snapshot_recorded', {
    guildId: deps.guildId,
    humanMemberCount: collected.snapshot.humanMemberCount,
    rankedMemberCount: ranked,
    raidAccountsExcluded: collected.snapshot.raidAccountsExcluded,
    holders: Object.fromEntries(collected.snapshot.rankRows.map((rank) => [rank.key, rank.holdersCount])),
  });
  return result(collected.observedAt, collected.snapshot);
}

export interface CommunitySnapshotHandle {
  stop(): void;
}

export function startCommunitySnapshots(
  deps: CommunitySnapshotDeps & { counterIntervalMs?: number; rankIntervalMs?: number },
): CommunitySnapshotHandle {
  const counterIntervalMs = deps.counterIntervalMs ?? LIVE_COUNTER_INTERVAL_MS;
  const rankIntervalMs = deps.rankIntervalMs ?? RANK_SNAPSHOT_INTERVAL_MS;
  // At each 10-minute boundary both timers are due. Queue them so an older,
  // slower read can never finish after a newer one and overwrite its timestamp.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (name: 'community_counter' | 'rank_snapshot', cycle: () => Promise<unknown>) => {
    queue = queue.then(cycle).catch((err: unknown) => {
      log.error(`${name}_failed`, { err: String(err) });
    });
  };
  const counterTick = () => enqueue('community_counter', () => runLiveCounterCycle(deps));
  const rankTick = () => enqueue('rank_snapshot', () => runRankSnapshotCycle(deps));

  const counterTimer = setInterval(counterTick, counterIntervalMs);
  const rankTimer = setInterval(rankTick, rankIntervalMs);
  counterTimer.unref();
  rankTimer.unref();
  rankTick();

  log.info('community_snapshots_enabled', {
    guildId: deps.guildId,
    counterIntervalMs,
    rankIntervalMs,
  });

  return {
    stop() {
      clearInterval(counterTimer);
      clearInterval(rankTimer);
    },
  };
}
