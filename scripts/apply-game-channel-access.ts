/**
 * Light up the three game categories. NEEDS CEO SIGN-OFF BEFORE --apply.
 *
 *   node scripts/apply-game-channel-access.ts            # dry run, prints the diff
 *   node scripts/apply-game-channel-access.ts --apply    # only after sign-off
 *
 * WHAT IT CHANGES
 *
 * One permission overwrite granting VIEW_CHANNEL to the matching game role, on
 * each of the three categories AND on every channel inside them:
 *
 *   🎯【 Shooters 】🎯 + 💬〢shooters-general   + view for "Shooter Games"
 *   🎮【 Survival 】🎮 + 💬〢survival-general   + view for "Survival Games"
 *   👻【 Horror 】👻   + 💬〢horror-general     + view for "Horror Games"
 *
 * The children matter. Discord resolves permissions from a channel's own
 * overwrites - a category does not grant anything to the channels inside it at
 * runtime, it only acts as a template when you sync. Granting on the category
 * alone would look right in the UI and change nothing for members. The e2e
 * test caught exactly that.
 *
 * WHAT IT DOES NOT CHANGE
 *
 * It never touches the existing @everyone deny, so these categories stay
 * hidden from people who did not ask for them. It never removes an overwrite,
 * never touches a role, never touches a channel outside the three categories,
 * and never grants anything except VIEW_CHANNEL. Send/attach/etc. keep coming
 * from the member's normal permissions.
 *
 * WHY IT IS NEEDED
 *
 * Today all three categories deny view to @everyone and grant it back to
 * nobody, so the rooms are invisible to every non-admin - including the 27
 * members who already hold "Shooter Games". Assigning a game role currently
 * routes a member nowhere. See docs/ROUTING.md.
 *
 * REVERSING IT
 *
 * --revert removes only the overwrites this script added, putting the
 * categories back exactly as they were.
 *
 * Library + CLI (TOG-6495): the access plan below is exported and pinned by
 * test/unit.gamechannelaccess.test.ts on fixtures built from the real catalog.
 * Importing this file never reads env, never exits and never touches the
 * network; the live Discord read only runs under direct invocation (the
 * isMain block at the bottom).
 *
 * TEST SEAM. GAME_CHANNEL_ACCESS_API_BASE points the script at a stub in
 * test/unit.gamechannelaccess.test.ts. Same hook, and the same loopback-only
 * reason, as VERIFY_CATALOG_API_BASE: the dry-run path is the half under
 * test, and a test seam must never be able to aim a live bot token at an
 * arbitrary host.
 */
import { GATED_CATEGORIES } from '../src/onboarding/catalog.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEW_CHANNEL = 1n << 10n;

export type Overwrite = { id: string; type: number; allow: string; deny: string };
export type Channel = {
  id: string;
  name: string;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
};

export type PlanAction = 'grant' | 'skip-already' | 'remove' | 'skip-missing' | 'skip-no-category';

export interface PlanEntry {
  action: PlanAction;
  channelId: string;
  /** Rendered location: `Category Name` for the template, `  └ #name` for a child. */
  where: string;
  roleId: string;
  roleName: string;
}

function hasView(existing: Overwrite | undefined): boolean {
  return !!existing && (BigInt(existing.allow) & VIEW_CHANNEL) !== 0n;
}

/**
 * Pure access plan for one guild channel list. No env, no network, no logging.
 * Dry-run prints every entry; --apply executes `grant`, --revert executes
 * `remove`, and every `skip-*` entry is a line printed and nothing else.
 */
export function computeAccessPlan(
  allChannels: Channel[],
  opts: { revert?: boolean } = {},
): PlanEntry[] {
  const byId = new Map(allChannels.map((c) => [c.id, c]));
  const plan: PlanEntry[] = [];

  for (const cat of GATED_CATEGORIES) {
    const category = byId.get(cat.categoryId);
    if (!category) {
      plan.push({
        action: 'skip-no-category',
        channelId: cat.categoryId,
        where: cat.categoryName,
        roleId: cat.roleId,
        roleName: cat.roleName,
      });
      continue;
    }

    // The category is the template; the children are what members actually open.
    // Both need the overwrite.
    const targets = [category, ...allChannels.filter((c) => c.parent_id === cat.categoryId)];

    for (const ch of targets) {
      const where = ch.id === cat.categoryId ? `${ch.name}` : `  └ #${ch.name}`;
      const existing = (ch.permission_overwrites ?? []).find((o) => o.id === cat.roleId);

      if (opts.revert) {
        plan.push({
          action: existing ? 'remove' : 'skip-missing',
          channelId: ch.id,
          where,
          roleId: cat.roleId,
          roleName: cat.roleName,
        });
        continue;
      }

      plan.push({
        action: hasView(existing) ? 'skip-already' : 'grant',
        channelId: ch.id,
        where,
        roleId: cat.roleId,
        roleName: cat.roleName,
      });
    }
  }

  return plan;
}

/** Entries that change something when executed: `grant` under --apply, `remove` under --revert. */
export function planChanges(plan: PlanEntry[]): PlanEntry[] {
  return plan.filter((e) => e.action === 'grant' || e.action === 'remove');
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // --help boots with no token, no guild, no network.
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/apply-game-channel-access.ts [--apply | --revert]');
    console.log('');
    console.log('Grant the three game roles VIEW_CHANNEL on their categories and children (dry run by default).');
    console.log('Needs CEO sign-off before --apply; --help contacts nothing and needs no token.');
    process.exit(0);
  }

  const API_BASE = process.env.GAME_CHANNEL_ACCESS_API_BASE ?? 'https://discord.com/api/v10';
  if (
    API_BASE !== 'https://discord.com/api/v10' &&
    !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(?:\/|$)/.test(API_BASE)
  ) {
    console.error('GAME_CHANNEL_ACCESS_API_BASE may only override Discord with a loopback test server');
    process.exit(2);
  }

  const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  const GUILD = process.env.DISCORD_GUILD_ID;

  if (!TOKEN || !GUILD) {
    console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID');
    process.exit(2);
  }

  const APPLY = process.argv.includes('--apply');
  const REVERT = process.argv.includes('--revert');

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Audit-Log-Reason': 'TWO-7 onboarding: grant game roles access to their own category',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : await res.json().catch(() => null);
  }

  const mode = REVERT ? 'REVERT' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\nTWO-7 game channel access - ${mode}\n`);

  if (APPLY && REVERT) {
    console.error('pick one of --apply or --revert');
    process.exit(2);
  }

  const allChannels = (await req('GET', `/guilds/${GUILD}/channels`)) as Channel[];
  const byId = new Map(allChannels.map((c) => [c.id, c]));
  const plan = computeAccessPlan(allChannels, { revert: REVERT });

  let changes = 0;

  for (const entry of plan) {
    const ch = byId.get(entry.channelId);
    const existing = (ch?.permission_overwrites ?? []).find((o) => o.id === entry.roleId);

    if (entry.action === 'skip-no-category') {
      console.log(`  SKIP  ${entry.where}: category no longer exists`);
      continue;
    }

    if (REVERT) {
      if (entry.action === 'skip-missing') {
        console.log(`  SKIP    ${entry.where}: no overwrite for "${entry.roleName}" to remove`);
        continue;
      }
      changes++;
      console.log(`  REMOVE  ${entry.where}: overwrite for "${entry.roleName}"`);
      await req('DELETE', `/channels/${entry.channelId}/permissions/${entry.roleId}`);
      continue;
    }

    if (entry.action === 'skip-already') {
      console.log(`  SKIP    ${entry.where}: "${entry.roleName}" already has view`);
      continue;
    }

    changes++;
    console.log(
      `  ${APPLY ? 'GRANT ' : 'would '} ${entry.where}: +VIEW_CHANNEL for "${entry.roleName}"`,
    );

    if (!APPLY) continue;

    // PUT replaces this one overwrite only. Preserve any deny already on it so
    // we are strictly adding view and taking nothing away. The @everyone deny
    // on this channel is a different overwrite and is untouched.
    const keepDeny = existing ? BigInt(existing.deny) & ~VIEW_CHANNEL : 0n;
    const newAllow = (existing ? BigInt(existing.allow) : 0n) | VIEW_CHANNEL;
    await req('PUT', `/channels/${entry.channelId}/permissions/${entry.roleId}`, {
      type: 0, // role
      allow: newAllow.toString(),
      deny: keepDeny.toString(),
    });
  }

  console.log();
  if (!APPLY && !REVERT) {
    console.log(`${changes} change(s) proposed. Nothing was modified.`);
    console.log('Re-run with --apply only after the CEO has signed off (TWO-7).\n');
  } else {
    console.log(`${changes} change(s) written. Re-run scripts/verify-catalog.ts to confirm.\n`);
  }
}
