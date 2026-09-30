/**
 * Staging-only leveling reward-role apply (TOG-1641, TOG-4444).
 *
 *   node scripts/levels-reward-role-apply.ts --report <probe-output.json> --member <user-id>
 *     [--level <n>] [--apply]
 *
 * The probe answers "which rewards would land". This script exercises exactly
 * one of them against exactly one disposable staging member: grant, prove the
 * role is on the member, record the grant, revoke, prove the role is gone.
 *
 * Without --apply it prints the plan and changes nothing - the same dry-run
 * default `staging-provision.ts` uses, for the same reason: this writes to
 * someone else's Discord. With --apply it performs the full
 * grant/readback/revoke/readback in one operation; revocation is the second
 * half of the command, not a second command, so cleanup cannot be forgotten.
 *
 * Containment: the staging guild only, and only it. The live guild
 * (326474832151838730) is refused before any file, database or network is
 * opened, and there is no override flag - the probe's `--allow-live-guild`
 * exists for an owner-approved rollout, and this slice is not one.
 *
 * Disposable member: reuse the existing staging test account (the Owen QA
 * Test bot's application id is the staging bot, not a member). The operator
 * passes `--member` explicitly so the choice is on the record. The operation
 * never creates members - a missing member is an error, not an invitation.
 *
 * Exit codes: 0 the operation verified end to end, 1 a step failed (the
 * message says whether residue is possible), 2 usage or a refused guild.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { OperationalAuditStore } from '../src/audit/store.ts';
import { readSecret } from '../src/core/credentials.ts';
import { log } from '../src/core/log.ts';
import {
  RewardRoleApplyError,
  applyRewardRole,
  assertStagingGuild,
  effectivePermissions,
  precheckGrantEligibility,
  selectMappedReward,
  MANAGE_ROLES_BIT,
  type RewardRolePort,
} from '../src/leveling/rewardRoleApply.ts';
import type { PartialRole } from '../src/staging/provision.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  TWO_STAGING_GUILD_ID,
  checkStagingToken,
  stagingGuildId,
} from '../src/staging/spec.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/levels-reward-role-apply.ts --report <probe-output.json> --member <user-id> [--level <n>] [--apply]');
  process.exit(0);
}

const API = process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-reward-role-apply.ts --report <probe-output.json> --member <user-id>\n' +
      '           [--level <n>] [--apply]\n' +
      '\n' +
      'Exercises one mapped reward role from the probe report against one staging member:\n' +
      'grant, readback, audit record, revoke, readback. Default is a dry run.\n' +
      '\n' +
      '--report is the JSON the probe wrote with --report (its mapped array picks the role).\n' +
      '--member is the disposable staging test account to exercise (never created, only read).\n' +
      '--level picks which mapped reward; default is the lowest mapped level.\n' +
      '--apply performs the grant/revoke. Without it, only the plan is printed.\n',
  );
  process.exit(2);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

function fail(message: string, code: 1 | 2 = 1): never {
  console.error(message);
  process.exit(code);
}

// --- fences first: guild, token, and inputs, before any I/O -----------------
// Guild from the environment, like every other staging script: an explicit
// value that must equal the TWO Staging guild, so a shell carrying the live
// guild id fails here rather than at Discord.
// The live id is checked on the raw value first so the refusal names it in the
// probe's words; stagingGuildId() would also refuse, with a vaguer message.
if (process.env.DISCORD_STAGING_GUILD_ID?.trim() === LIVE_GUILD_ID) {
  fail(`\nRefusing live guild ${LIVE_GUILD_ID}. This operation is staging-only; there is no override.\n`, 2);
}
let guildId: string;
try {
  guildId = stagingGuildId();
} catch (err) {
  fail(`\n${(err as Error).message}\n`, 2);
}
// The fence in the operation module is the one that counts (it runs even when
// this script is not the caller); this one keeps the CLI failing before I/O.
try {
  assertStagingGuild(guildId);
} catch (err) {
  fail(`\n${(err as Error).message}\n`, 2);
}

const token = readSecret('discord_staging_token', ['DISCORD_STAGING_BOT_TOKEN']);
if (!token) fail('\nMissing DISCORD_STAGING_BOT_TOKEN.\n  This is the Owen QA Test bot token. See docs/SECRETS.md.\n');
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) fail(`\n${tokenCheck.message}\n`, 2);

const reportPath = arg('--report') ?? usage();
const memberId = arg('--member') ?? usage();
if (!/^\d{17,20}$/.test(memberId)) usage();
const levelRaw = arg('--level');
const level = levelRaw === null ? undefined : Number(levelRaw);
if (level !== undefined && (!Number.isInteger(level) || level <= 0)) usage();
const APPLY = process.argv.includes('--apply');

let report: unknown;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  fail(`--report ${reportPath} is not valid JSON: ${(error as Error).message}`, 2);
}
let target;
try {
  target = selectMappedReward(report, level);
} catch (err) {
  const apply = err as RewardRoleApplyError;
  fail(apply.message, apply.exitCode);
}

const runId = randomUUID();
const auditReason = `TOG-4444 staging reward-role exercise (level ${target.level})`;

type Json = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json | null }> {
  // Every Discord call is logged with its path, so "zero live-guild writes" is
  // a grep over this run's log rather than a claim; and a path naming the live
  // guild is refused here, below every other fence, in case one was bypassed.
  log.info('level_reward_role_discord_call', { runId, method, path });
  if (path.includes(LIVE_GUILD_ID)) {
    fail(`\nRefusing a Discord call naming the live guild ${LIVE_GUILD_ID}: ${method} ${path}\n`, 2);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Audit-Log-Reason': auditReason,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) {
      const retry = Math.min(Number(res.headers.get('retry-after') ?? '1'), 30);
      console.log(`  ... rate limited, waiting ${retry}s`);
      await new Promise((r) => setTimeout(r, retry * 1000));
      continue;
    }
    return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
  }
  return { status: 429, body: null };
}

function discordError(status: number, body: Json | null, what: string): RewardRoleApplyError {
  const detail =
    status === 403
      ? ' (Discord 403 on a role write is usually hierarchy - the bot grants only strictly ' +
        'below its own top role - or a missing Manage Roles permission, not a bad token)'
      : '';
  return new RewardRoleApplyError(
    `${what} failed: Discord answered HTTP ${status}${detail}` +
      (body ? ` ${JSON.stringify(body).slice(0, 200)}` : ''),
  );
}

// --- who are we, and what is really there ------------------------------------
const me = await api('GET', '/users/@me');
if (me.status !== 200 || me.body?.id !== STAGING_BOT_APPLICATION_ID) {
  fail(
    `Discord did not authenticate as ${STAGING_BOT_APPLICATION_NAME} (${STAGING_BOT_APPLICATION_ID}): ` +
      `HTTP ${me.status}. Refusing to run.`,
    2,
  );
}
const botId = String(me.body.id);

const guild = await api('GET', `/guilds/${guildId}`);
if (guild.status !== 200 || guild.body?.id !== TWO_STAGING_GUILD_ID) {
  fail(`Discord authenticated to unexpected guild ${JSON.stringify(guild.body)?.slice(0, 120)}; refusing to run.`, 2);
}
const ownerId = typeof guild.body.owner_id === 'string' ? (guild.body.owner_id as string) : null;

const rolesRes = await api('GET', `/guilds/${guildId}/roles`);
if (rolesRes.status !== 200 || !Array.isArray(rolesRes.body)) fail(`Cannot read roles (HTTP ${rolesRes.status}).`);
const roles = rolesRes.body as PartialRole[];

const botMember = await api('GET', `/guilds/${guildId}/members/${botId}`);
const botRoles = Array.isArray(botMember.body?.roles) ? (botMember.body!.roles as string[]) : [];
const everyone = roles.find((role) => role.position === 0) ?? null;
const held = effectivePermissions(roles, botRoles, everyone?.id ?? null);
if ((held & MANAGE_ROLES_BIT) === 0n && !(ownerId && ownerId === botId)) {
  fail(
    'The bot member lacks Manage Roles in this guild (effective permission mask ' +
      `from its roles does not carry bit 28). Grant it before exercising reward roles; ` +
      'refusing to attempt a write that Discord would reject.',
  );
}

try {
  precheckGrantEligibility({ roles, botId, ownerId, targetRoleId: target.roleId });
} catch (err) {
  fail((err as Error).message);
}

const member = await api('GET', `/guilds/${guildId}/members/${memberId}`);
if (member.status === 404) {
  fail(
    `Member ${memberId} is not in the staging guild. Add the disposable test account first; ` +
      'this operation never creates members.',
  );
}
if (member.status !== 200) fail(`Cannot read member ${memberId} (HTTP ${member.status}).`);
const beforeRoles = Array.isArray(member.body?.roles) ? (member.body!.roles as string[]) : [];
const alreadyHeld = beforeRoles.includes(target.roleId);

console.log(
  `\nTOG-4444 reward-role exercise  ${APPLY ? '[APPLY - this writes to Discord]' : '[dry run - nothing is changed]'}\n` +
    `  guild      TWO Staging (${guildId})\n` +
    `  bot        ${STAGING_BOT_APPLICATION_NAME} (${botId})\n` +
    `  member     ${memberId}\n` +
    `  reward     level ${target.level} -> "${target.roleName}" (${target.roleId})\n` +
    `  pre-check  role is below the bot, member is present` +
    (alreadyHeld ? ', role already held (grant will be skipped, revoke still runs)' : '') +
    '\n',
);

if (!APPLY) {
  console.log('  WOULD  grant -> readback(present) -> audit record -> revoke -> readback(absent)');
  console.log('\nRe-run with --apply to perform the exercise.\n');
  process.exit(0);
}

// The audit record is part of the operation, so the database it goes to is
// opened before the first write: a missing or unreachable database fails here
// with the member untouched, not after a grant it then cannot record.
const dbUrl = process.env.TWO_DATABASE_URL?.trim() || process.env.TWO_STAGING_DATABASE_URL?.trim();
if (!dbUrl) {
  fail(
    '\nTWO_DATABASE_URL (or TWO_STAGING_DATABASE_URL) is not set, so the grant could not be ' +
      'recorded. Nothing was written to Discord.\n',
    2,
  );
}
let db: Awaited<ReturnType<typeof openDb>>;
try {
  db = await openDb(dbUrl, { poolMax: 2, skipMigrations: true, applicationName: `two-bot-tog-4444-${runId}` });
} catch (err) {
  fail(`\nCannot open the audit database: ${(err as Error).message}. Nothing was written to Discord.\n`);
}

// The port is scoped to the one guild and asserts it again on the way in:
// a mistyped id anywhere above still cannot become a live write below.
const port: RewardRolePort = {
  guildId,
  async memberRoles(id) {
    const res = await api('GET', `/guilds/${guildId}/members/${id}`);
    if (res.status === 404) return null;
    if (res.status !== 200 || !Array.isArray(res.body?.roles)) {
      throw discordError(res.status, res.body, `Readback of member ${id}`);
    }
    return (res.body.roles as unknown[]).map(String);
  },
  async grantRole(id, roleId, reason) {
    void reason;
    const res = await api('PUT', `/guilds/${guildId}/members/${id}/roles/${roleId}`);
    if (res.status !== 204) throw discordError(res.status, res.body, `Grant of ${roleId} to ${id}`);
  },
  async revokeRole(id, roleId, reason) {
    void reason;
    const res = await api('DELETE', `/guilds/${guildId}/members/${id}/roles/${roleId}`);
    if (res.status !== 204) throw discordError(res.status, res.body, `Revoke of ${roleId} from ${id}`);
  },
};

let summary;
try {
  summary = await applyRewardRole(port, {
    memberId,
    target,
    roles,
    botId,
    ownerId,
    logger: (event, fields) => log.info(event, { runId, ...fields }),
  });
} catch (err) {
  await db.close();
  const apply = err as RewardRoleApplyError;
  fail(`\n${apply.message}\n`, apply.exitCode ?? 1);
}

// --- the grant record, via the repo's operational audit convention -----------
// The grant is recorded after both readbacks, so the row is evidence of what
// happened - including that the role is already gone - rather than intent.
try {
  const recorded = await new OperationalAuditStore(db).record({
    entryId: `tog-4444-reward-role:${runId}`,
    kind: 'member_update',
    channel: 'audit',
    guildId,
    occurredAt: new Date().toISOString(),
    actorId: botId,
    targetId: memberId,
    action: 'level_reward_role_exercised',
    metadata: {
      level: summary.level,
      roleId: summary.roleId,
      roleName: summary.roleName,
      alreadyHeld: summary.alreadyHeld,
      positiveReadback: summary.positiveReadback,
      negativeReadback: summary.negativeReadback,
      residueRestored: summary.residueRestored,
    },
  });
  console.log(`  audit    ${recorded ? 'recorded' : 'already recorded (same run id)'} as tog-4444-reward-role:${runId}`);
} finally {
  await db.close();
}

console.log(
  `\nDone. Positive readback: role "${summary.roleName}" present after grant. ` +
    `Negative readback: role absent after revoke. Residue restored: ${summary.residueRestored}.\n` +
    `Zero writes to the live guild: every Discord path in this run carried guild ${guildId}.\n`,
);
