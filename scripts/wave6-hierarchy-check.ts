/**
 * Wave 6 hierarchy pre-flight. READ-ONLY.
 *
 *   DISCORD_TOKEN=... node scripts/wave6-hierarchy-check.ts
 *
 * Wave 6 deletes every non-managed role. Discord refuses a role write unless
 * the actor's HIGHEST role sits strictly above the target, so the wave can only
 * ever remove the roles below our own top role. Nothing in the config says
 * this; it is a property of the live guild that changes whenever somebody drags
 * a role in the UI. That makes it worth measuring rather than assuming.
 *
 * Exit codes, so CI and a human read the same result:
 *   0  every non-managed role is below our top role -- Wave 6 can complete
 *   1  at least one target is out of reach -- Wave 6 would stop half-done
 *   2  could not run (no token, or the API would not answer)
 *
 * READ-ONLY by construction, the same guarantee as wave0-export.ts and
 * audit-collect.ts: it reaches Discord only through `DiscordRest.get`, which
 * hardcodes GET and has no post/patch/delete sibling to reach for.
 *
 * This does NOT check Wick's anti-nuke whitelist. That config lives inside
 * Wick, not in Discord, and the API does not expose another application's
 * private settings (TOG-1166). Section 3 prints what the API *can* show about
 * Wick and then says plainly that the whitelist is unverified.
 *
 * Correction, measured 2026-09-05 (TOG-1166): this file used to tell the reader
 * that raising our own role was "guild owner only -- a bot cannot move a role to
 * or above its own top role". That is FALSE. Discord constrains the role being
 * WRITTEN against the actor's highest role; a bot's own managed integration role
 * is not above it, so an Administrator bot may raise it. One real PATCH returned
 * 200 and moved Owen @1 -> @188, taking this check from exit 1 (71/159
 * reachable) to exit 0 (159/159). The fix is ours to run, not a human's.
 *
 * Library + CLI (TOG-6486): the hierarchy verdict below is exported and pinned
 * by test/unit.wave6hierarchy.test.ts on fixtures. Importing this file never
 * reads env, never exits and never touches the network; the live Discord read
 * only runs under direct invocation (the isMain block at the bottom).
 *
 * Every hierarchy failure carries the named code `hierarchy_blocked` in
 * brackets (`FAIL  [hierarchy_blocked] ...`), so a role dragged above the bot
 * fails with a greppable name, not just prose. The reviewer acceptance is
 * literal: raise one fixture role to the bot's top position and the run names
 * the failure.
 *
 * TEST SEAM. WAVE6_HIERARCHY_API_BASE points the script at a stub in
 * test/unit.wave6hierarchy.test.ts. Same hook, and the same loopback-only
 * reason, as VERIFY_CATALOG_API_BASE: the read path is the half under test,
 * and a test seam must never be able to aim a live bot token at an
 * arbitrary host.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordRest } from '../src/discord/rest.ts';
import { GUILD_ID } from '../src/onboarding/catalog.ts';

/** Discord role. `managed` means an integration owns it; nobody can delete it. */
export interface HierarchyRole {
  id: string;
  name: string;
  position: number;
  managed?: boolean;
  tags?: { bot_id?: string };
}

/** The named failure code every unreachable target carries in CLI output. */
export const HIERARCHY_BLOCKED = 'hierarchy_blocked' as const;

export interface HierarchyVerdict {
  /** The bot's highest role: every target must sit strictly below this. */
  botTop: HierarchyRole;
  /** Every non-managed, non-@everyone role: the Wave 6 target set. */
  targets: HierarchyRole[];
  /** Targets strictly below the bot top: Wave 6 can delete these. */
  reachable: HierarchyRole[];
  /** Targets at or above the bot top: Wave 6 would 403 on each of these. */
  blocked: HierarchyRole[];
  /** The highest target: the role the fix must raise the bot above. Null when there is nothing to delete. */
  highest: HierarchyRole | null;
  /** The bot's own managed integration role id, or null: the safe role to raise, since Wave 6 never deletes a managed role. */
  ownRoleId: string | null;
}

/**
 * Pure hierarchy verdict over one role snapshot. Fails closed: a target at or
 * above the bot's top role is blocked (Discord gates the write on strict
 * position order, ties included), and a bot holding no roles proves nothing.
 */
export function checkHierarchySnapshot(
  roles: HierarchyRole[],
  botUserId: string,
  botRoleIds: string[],
  guildId: string,
): HierarchyVerdict | { error: string } {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const mine = botRoleIds.map((id) => byId.get(id)).filter((r): r is HierarchyRole => !!r);
  // Highest position wins; Discord breaks a position tie by the lower snowflake.
  const botTop = mine.sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))[0];
  if (!botTop) {
    return { error: 'bot holds no roles at all -- it cannot write anything.' };
  }

  const targets = roles.filter((r) => r.id !== guildId && !r.managed);
  const reachable = targets.filter((r) => r.position < botTop.position);
  const blocked = targets.filter((r) => r.position >= botTop.position);
  const highest = targets.reduce<HierarchyRole | null>(
    (a, b) => (b.position > (a?.position ?? -1) ? b : a),
    null,
  );
  // Raise the bot's OWN managed role, not whichever role happens to be highest
  // right now: a managed role is not a Wave 6 target, so it survives the wave.
  // Raising a non-managed role instead would mean raising a role the wave then
  // deletes, which drops us back below the remaining targets mid-run.
  const ownRoleId = mine.find((r) => r.managed && r.tags?.bot_id === botUserId)?.id ?? null;

  return { botTop, targets, reachable, blocked, highest, ownRoleId };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const API_BASE = process.env.WAVE6_HIERARCHY_API_BASE ?? 'https://discord.com/api/v10';
  if (
    API_BASE !== 'https://discord.com/api/v10' &&
    !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(?:\/|$)/.test(API_BASE)
  ) {
    console.error('WAVE6_HIERARCHY_API_BASE may only override Discord with a loopback test server');
    process.exit(2);
  }

  const TOKEN = process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  const GUILD = process.env.DISCORD_GUILD_ID ?? GUILD_ID;
  if (!TOKEN) {
    console.error('need DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See scripts/preflight.ts.');
    process.exit(2);
  }

  const rest = new DiscordRest(
    API_BASE === 'https://discord.com/api/v10'
      ? { token: TOKEN }
      : { token: TOKEN, base: API_BASE, minIntervalMs: 0 },
  );

  const roles = await rest.get<HierarchyRole[]>(`/guilds/${GUILD}/roles`);
  if (!roles) {
    console.error(`could not read roles for guild ${GUILD} (403/404). Is the bot still a member?`);
    process.exit(2);
  }

  // Identify ourselves from the token rather than a hardcoded id, so this keeps
  // working if the application is ever re-created.
  const me = await rest.get<{ id: string; username: string }>('/users/@me');
  if (!me) {
    console.error('could not read /users/@me -- token rejected.');
    process.exit(2);
  }
  const member = await rest.get<{ roles: string[] }>(`/guilds/${GUILD}/members/${me.id}`);
  if (!member) {
    console.error(`bot ${me.id} is not a member of guild ${GUILD}.`);
    process.exit(2);
  }

  const verdict = checkHierarchySnapshot(roles, me.id, member.roles, GUILD);
  if ('error' in verdict) {
    console.error(verdict.error);
    process.exit(2);
  }
  const { botTop: top, targets, reachable, blocked, highest, ownRoleId } = verdict;

  console.log(`# Wave 6 hierarchy pre-flight -- guild ${GUILD}`);
  console.log(`bot: ${me.username} (${me.id})`);
  console.log(`top role: "${top.name}" position ${top.position}\n`);

  console.log('## 1. Role inventory');
  console.log(`  ${roles.length} roles = @everyone + ${roles.filter((r) => r.managed).length} managed + ${targets.length} deletable-in-principle`);
  console.log(`  Wave 6 targets (non-managed): ${targets.length}`);
  console.log(`  highest target: ${highest ? `"${highest.name.trim() || '(blank)'}" @${highest.position}` : '(none -- nothing to delete)'}\n`);

  console.log('## 2. Reach');
  console.log(`  reachable (position < ${top.position}): ${reachable.length}`);
  console.log(`  REFUSED by hierarchy (>= ${top.position}): ${blocked.length}`);
  if (blocked.length) {
    console.log(`\n  Wave 6 would delete ${reachable.length} roles, then take 403 Missing Permissions`);
    console.log('  on every remaining one, leaving the server half-rebuilt. Sample:');
    for (const r of [...blocked].sort((a, b) => a.position - b.position).slice(0, 10)) {
      console.log(`    FAIL  [${HIERARCHY_BLOCKED}] "${r.name.trim() || '(blank)'}" @${r.position} (bot top @${top.position})`);
    }
    // Measured 2026-09-05 (TOG-1166): an Administrator bot CAN raise its OWN
    // managed role. Discord constrains the role being written against the actor's
    // highest role; the bot's own integration role is not above it, so the write
    // is allowed. A real PATCH returned 200 and moved Owen @1 -> @188. This block
    // used to say "guild owner only", which sent a human to do a job we can do
    // ourselves -- the card sat blocked on it.
    console.log(`\n  FIX (we can do this ourselves -- an Administrator bot may raise its`);
    console.log('  own managed role; no guild-owner action required):');
    const ownRole = ownRoleId ? roles.find((r) => r.id === ownRoleId) : undefined;
    if (ownRole && highest) {
      console.log(`  PATCH /guilds/{id}/roles [{"id":"${ownRole.id}","position":${highest.position + 1}}]`);
      console.log(`  moves the integration role "${ownRole.name}" (currently @${ownRole.position}) above`);
      console.log(`  "${highest.name.trim() || '(blank)'}" (@${highest.position}), i.e. to position > ${highest.position}.`);
      console.log(`  Use "${ownRole.name}" and NOT "${top.name}": "${ownRole.name}" is managed, so Wave 6`);
      console.log('  does not delete it. A non-managed role would be deleted by the wave itself.');
    } else if (highest) {
      console.log(`  raise this bot's integration role above "${highest.name.trim() || '(blank)'}" (@${highest.position}).`);
    }
  }

  console.log('\n## 3. Wick / anti-nuke -- NOT VERIFIABLE HERE');
  const wick = roles.find((r) => r.name === 'Wick' && r.managed);
  // Wick's own member record, so we compare against its highest role rather than
  // only its integration role.
  const wickMember = wick?.tags?.bot_id
    ? await rest.get<{ roles: string[] }>(`/guilds/${GUILD}/members/${wick.tags.bot_id}`)
    : null;
  const wickRoleObjs = roles.filter((r) => wickMember?.roles?.includes(r.id));
  if (wick) {
    // Compare against Wick's HIGHEST role, not its integration role: Wick also
    // holds non-managed roles, and ban/kick is gated on the actor's highest.
    // Administrator grants permissions but never bypasses hierarchy -- only the
    // guild OWNER bypasses both -- so outranking Wick genuinely defuses this.
    const wickTop = Math.max(...wickRoleObjs.map((r) => r.position), wick.position);
    console.log(`  Wick integration role @${wick.position}; Wick's highest role @${wickTop}; our top role @${top.position}.`);
    if (wickTop > top.position) {
      console.log('  Wick outranks us: if anti-nuke arms and we are not whitelisted, Wick CAN ban our bot mid-wave.');
      console.log('  The whitelist is UNVERIFIED: it lives in Wick, and Discord exposes no');
      console.log("  endpoint for another application's config. A human must confirm it in");
      console.log('  the Wick dashboard (TOG-1166). This script never reports it as passing.');
    } else {
      console.log('  We outrank every Wick role. Discord gates ban/kick on the actor\'s highest');
      console.log('  role, and Administrator does NOT bypass hierarchy (only the guild owner does),');
      console.log('  so Wick cannot ban or kick our bot -- whitelisted or not. The whitelist is');
      console.log('  still unreadable via API, but it is no longer load-bearing for Wave 6.');
    }
  } else {
    console.log('  no managed role named "Wick" found.');
  }

  console.log(`\n## Verdict: ${blocked.length === 0 ? 'PASS -- every target is reachable' : `FAIL  [${HIERARCHY_BLOCKED}] -- ${blocked.length} of ${targets.length} targets unreachable`}`);
  process.exit(blocked.length === 0 ? 0 : 1);
}
