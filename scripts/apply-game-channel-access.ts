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
 */
import { GATED_CATEGORIES } from '../src/onboarding/catalog.ts';

const API = 'https://discord.com/api/v10';
// --help boots with no token, no guild, no network.
if (process.argv.includes('--help')) {
  console.log('usage: node scripts/apply-game-channel-access.ts [--apply | --revert]');
  console.log('');
  console.log('Grant the three game roles VIEW_CHANNEL on their categories and children (dry run by default).');
  console.log('Needs CEO sign-off before --apply; --help contacts nothing and needs no token.');
  process.exit(0);
}
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !GUILD) {
  console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID');
  process.exit(2);
}

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const VIEW_CHANNEL = 1n << 10n;

type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = {
  id: string;
  name: string;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
};

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
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

let changes = 0;

const allChannels = (await req('GET', `/guilds/${GUILD}/channels`)) as Channel[];
const byId = new Map(allChannels.map((c) => [c.id, c]));

for (const cat of GATED_CATEGORIES) {
  const category = byId.get(cat.categoryId);
  if (!category) {
    console.log(`  SKIP  ${cat.categoryName}: category no longer exists`);
    continue;
  }

  // The category is the template; the children are what members actually open.
  // Both need the overwrite.
  const targets = [category, ...allChannels.filter((c) => c.parent_id === cat.categoryId)];

  for (const ch of targets) {
    const where = ch.id === cat.categoryId ? `${ch.name}` : `  └ #${ch.name}`;
    const existing = (ch.permission_overwrites ?? []).find((o) => o.id === cat.roleId);

    if (REVERT) {
      if (!existing) {
        console.log(`  SKIP    ${where}: no overwrite for "${cat.roleName}" to remove`);
        continue;
      }
      changes++;
      console.log(`  REMOVE  ${where}: overwrite for "${cat.roleName}"`);
      await req('DELETE', `/channels/${ch.id}/permissions/${cat.roleId}`);
      continue;
    }

    if (existing && (BigInt(existing.allow) & VIEW_CHANNEL) !== 0n) {
      console.log(`  SKIP    ${where}: "${cat.roleName}" already has view`);
      continue;
    }

    changes++;
    console.log(
      `  ${APPLY ? 'GRANT ' : 'would '} ${where}: +VIEW_CHANNEL for "${cat.roleName}"`,
    );

    if (!APPLY) continue;

    // PUT replaces this one overwrite only. Preserve any deny already on it so
    // we are strictly adding view and taking nothing away. The @everyone deny
    // on this channel is a different overwrite and is untouched.
    const keepDeny = existing ? BigInt(existing.deny) & ~VIEW_CHANNEL : 0n;
    const newAllow = (existing ? BigInt(existing.allow) : 0n) | VIEW_CHANNEL;
    await req('PUT', `/channels/${ch.id}/permissions/${cat.roleId}`, {
      type: 0, // role
      allow: newAllow.toString(),
      deny: keepDeny.toString(),
    });
  }
}

console.log();
if (!APPLY && !REVERT) {
  console.log(`${changes} change(s) proposed. Nothing was modified.`);
  console.log('Re-run with --apply only after the CEO has signed off (TWO-7).\n');
} else {
  console.log(`${changes} change(s) written. Re-run scripts/verify-catalog.ts to confirm.\n`);
}
