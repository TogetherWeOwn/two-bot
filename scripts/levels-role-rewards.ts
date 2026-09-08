import { openDb } from '../src/store/db.ts';
import { LevelingService, type LevelRoleReward } from '../src/leveling/service.ts';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-role-rewards.ts --guild <snowflake> [--set <level:roleId,...>]\n' +
      'Without --set, prints the current rewards. --set replaces the full configuration.',
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
const set = arg('--set');
const dbSpec = process.env.TWO_DATABASE_URL?.trim() || process.env.TWO_DB_PATH || './data/two.db';
const db = await openDb(dbSpec, { poolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5) });
try {
  const service = new LevelingService(db);
  if (set !== null) await service.replaceRoleRewards(guildId, parseRewards(set));
  console.log(JSON.stringify({ guildId, rewards: await service.roleRewards(guildId) }, null, 2));
} finally {
  await db.close();
}
