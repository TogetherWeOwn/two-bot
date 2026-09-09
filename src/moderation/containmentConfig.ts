export interface ContainmentConfig {
  enabled: boolean;
  dryRun: boolean;
  guildId: string | null;
  botUserId: string;
  protectedUserIds: Set<string>;
  trustedUserIds: Set<string>;
  alertChannelId: string | null;
  snapshotPath: string | null;
  windowSeconds: number;
  heatThreshold: number;
  eventMaxAgeSeconds: number;
  joinRiskWindowSeconds: number;
  joinRiskThreshold: number;
  bulkJoinWindowUntil: string | null;
}

function ids(value: string | undefined, name: string): Set<string> {
  const parsed = new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const id of parsed) {
    if (!/^\d{17,20}$/.test(id)) throw new Error(`${name} must contain Discord user ids.`);
  }
  return parsed;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function optionalTimestamp(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return new Date(parsed).toISOString();
}

export function loadContainmentConfig(env: NodeJS.ProcessEnv = process.env): ContainmentConfig {
  const enabled = env.TWO_ANTI_NUKE === '1';
  const guildId = env.DISCORD_GUILD_ID || null;
  const botUserId = env.TWO_OWEN_USER_ID ?? '';
  const protectedUserIds = ids(env.TWO_ANTI_NUKE_PROTECTED_USER_IDS, 'TWO_ANTI_NUKE_PROTECTED_USER_IDS');
  const trustedUserIds = ids(env.TWO_ANTI_NUKE_TRUSTED_USER_IDS, 'TWO_ANTI_NUKE_TRUSTED_USER_IDS');
  const bulkJoinWindowUntil = optionalTimestamp(env.TWO_BULK_JOIN_WINDOW_UNTIL, 'TWO_BULK_JOIN_WINDOW_UNTIL');
  if (enabled && !guildId) throw new Error('TWO_ANTI_NUKE=1 requires DISCORD_GUILD_ID.');
  if (enabled && !/^\d{17,20}$/.test(botUserId)) throw new Error('TWO_ANTI_NUKE=1 requires TWO_OWEN_USER_ID.');
  if (botUserId) protectedUserIds.add(botUserId);
  return {
    enabled,
    dryRun: env.TWO_ANTI_NUKE_DRY_RUN !== '0',
    guildId,
    botUserId,
    protectedUserIds,
    trustedUserIds,
    alertChannelId: env.DISCORD_STAFF_ALERT_CHANNEL_ID || null,
    snapshotPath: env.TWO_ANTI_NUKE_SNAPSHOT_PATH || null,
    windowSeconds: positiveNumber(env.TWO_ANTI_NUKE_WINDOW_SECONDS, 60, 'TWO_ANTI_NUKE_WINDOW_SECONDS'),
    heatThreshold: positiveNumber(env.TWO_ANTI_NUKE_HEAT_THRESHOLD, 5, 'TWO_ANTI_NUKE_HEAT_THRESHOLD'),
    eventMaxAgeSeconds: positiveNumber(env.TWO_ANTI_NUKE_EVENT_MAX_AGE_SECONDS, 120, 'TWO_ANTI_NUKE_EVENT_MAX_AGE_SECONDS'),
    joinRiskWindowSeconds: positiveNumber(env.TWO_JOIN_RISK_WINDOW_SECONDS, 60, 'TWO_JOIN_RISK_WINDOW_SECONDS'),
    joinRiskThreshold: positiveNumber(env.TWO_JOIN_RISK_THRESHOLD, 5, 'TWO_JOIN_RISK_THRESHOLD'),
    bulkJoinWindowUntil,
  };
}
