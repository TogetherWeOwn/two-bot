/**
 * Dry-run probe for the reward-role half of a MEE6 import (TOG-1641, TOG-3481).
 *
 * `levels-import-mee6.ts` imports XP. This answers the other question an
 * operator has before a migration - "which of my MEE6 level roles will Owen
 * actually be able to hand out?" - and answers it without writing anything.
 *
 * There is no `--apply`. Not a flag that defaults to off: no apply path exists
 * in this script or in the module behind it, which is what makes "zero writes"
 * a property rather than a promise. The only database statement it issues is
 * the SELECT behind `roleRewards`, so the report can show the delta against
 * what is already stored, and it opens the connection with migrations off so
 * it cannot write schema either. Pass --no-db to skip even that.
 *
 * Roles come from a snapshot file rather than the network - a Discord roles
 * array (`audit-collect.ts` used to write one to the now-untracked
 * `audit/raw/roles.json`; any fresh snapshot has the same shape) - so the
 * probe is deterministic, runs offline, and cannot contact the guild it is
 * reporting on.
 *
 * Exit codes: 0 fine, 1 the export is not importable or the report does not
 * balance, 2 usage or a refused guild.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { LIVE_GUILD_ID } from '../src/staging/spec.ts';
import { LevelingService, type LevelRoleReward } from '../src/leveling/service.ts';
import type { PartialRole } from '../src/staging/provision.ts';
import {
  Mee6RewardExportError,
  parseMee6RoleRewards,
  planRewardRoleImport,
} from '../src/leveling/rewardImport.ts';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-import-rewards-probe.ts --guild <snowflake> --file <export.json>\n' +
      '           --roles <roles.json> --bot-id <snowflake> [--owner-id <snowflake>]\n' +
      '           [--report <path>] [--require-all-mapped] [--no-db] [--allow-live-guild]\n' +
      '\n' +
      'Reads the role_rewards section of a MEE6 export and reports which rewards map onto\n' +
      'roles the bot can actually grant in the target guild. Writes nothing, ever.\n' +
      '\n' +
      '--roles is a Discord roles snapshot: an array of {id,name,position,managed,tags}.\n' +
      '--require-all-mapped exits 1 when any reward is unmapped, for use as a CI gate.\n' +
      '--no-db skips the read of the stored rewards, so the probe needs no database.\n' +
      '--allow-live-guild is only for an owner-approved rollout.',
  );
  process.exit(2);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith('--')) usage();
  return value;
}

function optional(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

const guildId = arg('--guild');
if (!/^\d{17,20}$/.test(guildId)) usage();

// The fence runs before any file or database is opened, so a mistyped guild
// fails on the guild rather than on a connection string. It covers this script
// even though it cannot write: the contract the suite pins is "default-deny the
// live guild" everywhere in scripts/, and an operator who learns that the
// leveling tools sometimes accept 326474832151838730 without comment is being
// taught the wrong reflex about the ones that DO write.
if (guildId === LIVE_GUILD_ID && !process.argv.includes('--allow-live-guild')) {
  console.error(
    `Refusing live guild ${LIVE_GUILD_ID}. ` +
      'Use --allow-live-guild only for an owner-approved rollout.',
  );
  process.exit(2);
}

const botId = arg('--bot-id');
if (!/^\d{17,20}$/.test(botId)) usage();
const ownerId = optional('--owner-id');
if (ownerId !== null && !/^\d{17,20}$/.test(ownerId)) usage();

const filePath = arg('--file');
const rolesPath = arg('--roles');
const reportPath = optional('--report');
const requireAllMapped = process.argv.includes('--require-all-mapped');
const useDb = !process.argv.includes('--no-db');

function readRoles(path: string): PartialRole[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`--roles ${path} is not valid JSON: ${(error as Error).message}`);
    process.exit(1);
  }
  // Accept the bare array a roles snapshot is, and the {roles:[...]}
  // envelope a guild fetch tends to be wrapped in.
  const roles = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { roles?: unknown }).roles)
      ? (parsed as { roles: unknown[] }).roles
      : null;
  if (!roles) {
    console.error(`--roles ${path} must be an array of roles or an object with a roles array`);
    process.exit(1);
  }
  const problems: string[] = [];
  const out: PartialRole[] = [];
  roles.forEach((raw, index) => {
    const role = raw as PartialRole;
    if (!role || typeof role !== 'object') {
      problems.push(`roles[${index}] is not an object`);
      return;
    }
    if (typeof role.id !== 'string' || typeof role.name !== 'string') {
      problems.push(`roles[${index}] needs a string id and name`);
      return;
    }
    if (!Number.isInteger(role.position)) {
      problems.push(`roles[${index}] ("${role.name}") needs an integer position`);
      return;
    }
    out.push(role);
  });
  if (problems.length > 0) {
    console.error(`--roles ${path} is malformed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return out;
}

let rewards;
try {
  rewards = parseMee6RoleRewards(readFileSync(filePath, 'utf8'));
} catch (error) {
  if (!(error instanceof Mee6RewardExportError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const roles = readRoles(rolesPath);

let storedRewards: LevelRoleReward[] | null = null;
if (useDb) {
  const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required. Pass --no-db to skip the delta.');
  // skipMigrations is the point rather than an optimisation. openDb migrates
  // by default, so a "read-only" probe would
  // otherwise be able to create tables and rewrite schema on a database an
  // operator pointed it at by accident - and "it wrote nothing" would be a
  // claim about one table instead of about the connection. A probe that finds
  // the schema missing should say so, not build it.
  const db = await openDb(databaseUrl, {
    poolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5),
    skipMigrations: true,
  });
  try {
    storedRewards = await new LevelingService(db).roleRewards(guildId);
  } finally {
    await db.close();
  }
}

const report = planRewardRoleImport(guildId, rewards, { roles, botId, ownerId, storedRewards });
const rendered = JSON.stringify(report, null, 2);
if (reportPath) writeFileSync(reportPath, `${rendered}\n`);
console.log(rendered);

if (!report.counts.balances) {
  console.error(
    `Report does not balance: ${report.counts.rewardsIn} rewards in, ` +
      `${report.counts.mapped} mapped + ${report.counts.unmapped} unmapped.`,
  );
  process.exitCode = 1;
} else if (requireAllMapped && report.counts.unmapped > 0) {
  console.error(
    `${report.counts.unmapped} of ${report.counts.rewardsIn} reward roles are unmapped:\n  ` +
      report.unmapped.map((row) => `level ${row.level} (${row.reason}): ${row.detail}`).join('\n  '),
  );
  process.exitCode = 1;
}
