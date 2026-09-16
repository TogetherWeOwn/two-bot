import { openDb } from '../src/store/db.ts';
import { LevelingService, type LevelRoleReward } from '../src/leveling/service.ts';
import { LIVE_GUILD_ID } from '../src/staging/spec.ts';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-role-rewards.ts --guild <snowflake> [--set <level:roleId,...>] [--allow-live-guild]\n' +
      'Without --set, prints the current rewards. --set replaces the full configuration.\n' +
      '--allow-live-guild is only for an owner-approved rollout.',
  );
  process.exit(2);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? usage()) : null;
}

function parseRewards(spec: string): LevelRoleReward[] {
  if (!spec.trim()) return [];
  return spec.split(',').map((entry) => {
    const [levelRaw, roleId] = entry.trim().split(':');
    const level = Number(levelRaw);
    if (!Number.isInteger(level) || level <= 0 || !/^\d{17,20}$/.test(roleId ?? '')) usage();
    return { level, roleId };
  });
}

const guildId = arg('--guild') ?? usage();
if (!/^\d{17,20}$/.test(guildId)) usage();
if (guildId === LIVE_GUILD_ID && !process.argv.includes('--allow-live-guild')) {
  console.error(
    `Refusing live guild ${LIVE_GUILD_ID}. ` +
      'Use --allow-live-guild only for an owner-approved rollout.',
  );
  process.exit(2);
}
const set = arg('--set');
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');
const db = await openDb(databaseUrl, { poolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5) });
try {
  const service = new LevelingService(db);
  if (set !== null) await service.replaceRoleRewards(guildId, parseRewards(set));
  console.log(JSON.stringify({ guildId, rewards: await service.roleRewards(guildId) }, null, 2));
} finally {
  await db.close();
}
