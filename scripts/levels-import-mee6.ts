import { readFileSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { LevelingService, type Mee6ImportRow } from '../src/leveling/service.ts';

interface Mee6Player {
  id?: string;
  user_id?: string;
  xp?: number;
  level?: number;
}

function usage(): never {
  console.error(
    'Usage: node scripts/levels-import-mee6.ts --guild <snowflake> --file <export.json>\n' +
      'Accepted JSON: an array of players, or {players:[...]}; each player needs id/user_id and xp.',
  );
  process.exit(2);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) usage();
  return value;
}

function parseRows(value: unknown): Mee6ImportRow[] {
  const players = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { players?: unknown }).players)
      ? (value as { players: unknown[] }).players
      : null;
  if (!players) throw new Error('MEE6 export must be an array or an object with a players array');
  return players.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`row ${index + 1} is not an object`);
    const player = raw as Mee6Player;
    const memberId = player.id ?? player.user_id;
    if (typeof memberId !== 'string') throw new Error(`row ${index + 1} has no id or user_id`);
    if (!Number.isSafeInteger(player.xp) || Number(player.xp) < 0) {
      throw new Error(`row ${index + 1} has invalid xp`);
    }
    if (player.level !== undefined && (!Number.isInteger(player.level) || player.level < 0)) {
      throw new Error(`row ${index + 1} has invalid level`);
    }
    return { memberId, xp: Number(player.xp), level: player.level };
  });
}

const guildId = arg('--guild');
if (!/^\d{17,20}$/.test(guildId)) throw new Error('--guild must be a Discord snowflake');
const file = arg('--file');
const rows = parseRows(JSON.parse(readFileSync(file, 'utf8')));
const dbSpec = process.env.TWO_DATABASE_URL?.trim() || process.env.TWO_DB_PATH || './data/two.db';
const db = await openDb(dbSpec, {
  poolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5),
});
try {
  const summary = await new LevelingService(db).importMee6(guildId, rows);
  console.log(JSON.stringify({ guildId, ...summary }, null, 2));
} finally {
  await db.close();
}
