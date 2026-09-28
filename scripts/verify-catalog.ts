/**
 * Check the onboarding catalog against the live server. READ-ONLY.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/verify-catalog.ts
 *
 * Answers, without a test account and without changing anything:
 *
 *   - does every role in the catalog still exist, under the name we expect?
 *   - can the bot actually assign it (is it below the bot's highest role)?
 *   - does every destination channel still exist?
 *   - can a plain Member open that channel, or is it dark?
 *
 * The last one is the point. A member picks "Shooters", we grant the role, and
 * the link we hand them 404s because nothing grants view on that category. This
 * script makes that failure visible in CI instead of in someone's first two
 * minutes on the server.
 *
 * FAIL = onboarding is broken or lying. DARK = the flow works but falls back to
 * the hub. Exit is non-zero only on FAIL, so DARK does not block a deploy.
 *
 * Every FAIL carries a named code in brackets (`FAIL  [role_missing] ...`) so
 * a corrupted catalog row fails closed with a greppable name, not just prose.
 * Codes: role_missing, role_managed, role_above_bot, destination_missing,
 * destination_invisible, hub_invisible, category_missing, category_empty.
 *
 * Library + CLI (TOG-6482): the snapshot verification below is exported and
 * pinned by test/unit.verifycatalog.test.ts on fixtures built from the real
 * catalog. Importing this file never reads env, never exits and never touches
 * the network; the live Discord read only runs under direct invocation (the
 * isMain block at the bottom).
 *
 * TEST SEAM. VERIFY_CATALOG_API_BASE points the script at a stub in
 * test/unit.verifycatalog.test.ts. Same hook, and the same loopback-only
 * reason, as RULES_GATE_TIMEOUT_API_BASE: the read path is the half under
 * test, and a test seam must never be able to aim a live bot token at an
 * arbitrary host.
 */
import { ALL_PICKS, GAME_PICKS, GATED_CATEGORIES } from '../src/onboarding/catalog.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEW_CHANNEL = 1n << 10n;

/** The Member role every routed member holds, alongside @everyone and the game role. */
export const VERIFY_CATALOG_MEMBER_ROLE_ID = '1078755185423286372';

export interface CatalogRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  permissions: string;
}
export interface CatalogOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}
export interface CatalogChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  permission_overwrites?: CatalogOverwrite[];
}
export interface CatalogBotMember {
  roles: string[];
}
/** Everything the check needs: the three guild reads plus the bot's own member row. */
export interface CatalogSnapshot {
  guildId: string;
  roles: CatalogRole[];
  channels: CatalogChannel[];
  meId: string;
  botMember: CatalogBotMember;
}

export type CatalogFailCode =
  | 'role_missing'
  | 'role_managed'
  | 'role_above_bot'
  | 'destination_missing'
  | 'destination_invisible'
  | 'hub_invisible'
  | 'category_missing'
  | 'category_empty';

export interface CatalogFinding {
  code: CatalogFailCode;
  /** The catalog pick key, when the failure is about a pick. */
  pick?: string;
  message: string;
}

export interface CatalogReport {
  passes: string[];
  notes: string[];
  darks: string[];
  fails: CatalogFinding[];
}

/**
 * Would a member holding exactly [@everyone, Member, ...heldRoleIds] be able to
 * see this channel?
 *
 * IMPORTANT: this deliberately looks at the channel's OWN overwrites and does
 * not walk up to the category. That is how Discord actually resolves
 * permissions - a category is a template you can sync down, not something that
 * grants anything at runtime. An earlier version of this function applied the
 * parent first, which would have reported PASS for a fix that granted view on
 * the categories only and left every member still locked out.
 */
export function canView(
  channel: CatalogChannel,
  everyoneRole: CatalogRole,
  heldRoleIds: string[],
  guildId: string,
): boolean {
  if (BigInt(everyoneRole.permissions) & (1n << 3n)) return true; // ADMINISTRATOR

  let allowed = (BigInt(everyoneRole.permissions) & VIEW_CHANNEL) !== 0n;
  const ows = channel.permission_overwrites ?? [];

  const everyoneOw = ows.find((o) => o.id === guildId);
  if (everyoneOw) {
    if (BigInt(everyoneOw.deny) & VIEW_CHANNEL) allowed = false;
    if (BigInt(everyoneOw.allow) & VIEW_CHANNEL) allowed = true;
  }

  // Role overwrites: every deny applies, then every allow, so a single grant
  // beats a deny from another role the member happens to hold.
  const roleOws = ows.filter((o) => o.type === 0 && heldRoleIds.includes(o.id) && o.id !== guildId);
  if (roleOws.some((o) => BigInt(o.deny) & VIEW_CHANNEL)) allowed = false;
  if (roleOws.some((o) => BigInt(o.allow) & VIEW_CHANNEL)) allowed = true;

  return allowed;
}

/**
 * Pure verification of one guild snapshot against the catalog. Fails closed:
 * anything the snapshot does not prove reachable is a named finding, never an
 * assumed pass. Unknown extra roles or channels in the snapshot are ignored -
 * the catalog is what we verify, not the whole server.
 */
export function verifyCatalogSnapshot(snap: CatalogSnapshot): CatalogReport {
  const passes: string[] = [];
  const notes: string[] = [];
  const darks: string[] = [];
  const fails: CatalogFinding[] = [];

  const roleById = new Map(snap.roles.map((r) => [r.id, r]));
  const chById = new Map(snap.channels.map((c) => [c.id, c]));
  const everyoneRole = roleById.get(snap.guildId)!;

  const botTop = Math.max(
    0,
    ...snap.botMember.roles.map((id) => roleById.get(id)?.position ?? 0),
  );

  for (const p of ALL_PICKS) {
    const r = roleById.get(p.roleId);
    if (!r) {
      fails.push({
        code: 'role_missing',
        pick: p.key,
        message: `${p.key}: role ${p.roleId} (${p.roleName}) no longer exists`,
      });
      continue;
    }
    if (r.name !== p.roleName) {
      // Not fatal - ids are what we assign - but the catalog comment is now a lie.
      notes.push(`${p.key}: role renamed ${p.roleName} -> ${r.name}`);
    }
    if (r.managed) {
      fails.push({
        code: 'role_managed',
        pick: p.key,
        message: `${p.key}: "${r.name}" is integration-managed and cannot be assigned by a bot`,
      });
      continue;
    }
    if (r.position >= botTop) {
      fails.push({
        code: 'role_above_bot',
        pick: p.key,
        message: `${p.key}: "${r.name}" is at position ${r.position}, at or above the bot's ${botTop}`,
      });
      continue;
    }
    passes.push(`${p.key} -> "${r.name}" assignable`);
  }

  // What a routed member actually holds: @everyone + Member + the game role.
  for (const p of GAME_PICKS) {
    const targetId = p.primaryChannelId ?? p.fallbackChannelId;
    const ch = chById.get(targetId);
    if (!ch) {
      fails.push({
        code: 'destination_missing',
        pick: p.key,
        message: `${p.key}: destination channel ${targetId} no longer exists`,
      });
      continue;
    }
    const held = [snap.guildId, VERIFY_CATALOG_MEMBER_ROLE_ID, p.roleId];
    const visible = canView(ch, everyoneRole, held, snap.guildId);

    if (visible) {
      passes.push(`${p.key} -> #${ch.name} visible with "${p.roleName}"`);
    } else if (p.primaryChannelId) {
      const fb = chById.get(p.fallbackChannelId);
      const fbVisible = fb && canView(fb, everyoneRole, held, snap.guildId);
      if (!fbVisible) {
        fails.push({
          code: 'destination_invisible',
          pick: p.key,
          message: `${p.key}: both #${ch.name} and its fallback are invisible - this pick routes nowhere`,
        });
      } else {
        darks.push(
          `${p.key}: #${ch.name} is invisible even with "${p.roleName}" - falls back to #${fb!.name}`,
        );
      }
    } else {
      fails.push({
        code: 'hub_invisible',
        pick: p.key,
        message: `${p.key}: hub channel #${ch.name} is not visible to a plain Member`,
      });
    }
  }

  for (const cat of GATED_CATEGORIES) {
    const ch = chById.get(cat.categoryId);
    if (!ch) {
      fails.push({ code: 'category_missing', message: `${cat.categoryName} no longer exists` });
      continue;
    }
    const grants = (c: CatalogChannel) =>
      (c.permission_overwrites ?? []).some(
        (o) => o.id === cat.roleId && BigInt(o.allow) & VIEW_CHANNEL,
      );

    if (grants(ch)) passes.push(`${cat.categoryName} grants view to "${cat.roleName}"`);
    else darks.push(`${cat.categoryName} does not grant view to "${cat.roleName}" - category is dark`);

    // The category grant is cosmetic on its own. These are the channels a member
    // actually clicks into, and each one needs the overwrite in its own right.
    const children = snap.channels.filter((c) => c.parent_id === cat.categoryId);
    if (!children.length) fails.push({ code: 'category_empty', message: `${cat.categoryName} has no channels in it` });
    for (const child of children) {
      if (grants(child)) passes.push(`  └ #${child.name} grants view to "${cat.roleName}"`);
      else darks.push(`  └ #${child.name} does not grant view to "${cat.roleName}" - members cannot open it`);
    }
  }

  return { passes, notes, darks, fails };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const API_BASE = process.env.VERIFY_CATALOG_API_BASE ?? 'https://discord.com/api/v10';
  if (
    API_BASE !== 'https://discord.com/api/v10' &&
    !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(?:\/|$)/.test(API_BASE)
  ) {
    console.error('VERIFY_CATALOG_API_BASE may only override Discord with a loopback test server');
    process.exit(2);
  }

  const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  const GUILD = process.env.DISCORD_GUILD_ID;

  if (!TOKEN || !GUILD) {
    console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID');
    process.exit(2);
  }

  const get = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bot ${TOKEN}` } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  };

  console.log('\nTWO onboarding catalog check (read-only)\n');

  const [roles, channels, me] = await Promise.all([
    get<CatalogRole[]>(`/guilds/${GUILD}/roles`),
    get<CatalogChannel[]>(`/guilds/${GUILD}/channels`),
    get<{ id: string }>('/users/@me'),
  ]);

  if (!roles || !channels || !me) {
    console.error('could not read the guild - check the token and that the bot is in the server');
    process.exit(2);
  }

  const botMember = await get<CatalogBotMember>(`/guilds/${GUILD}/members/${me.id}`);
  if (!botMember) {
    console.error('the bot is not a member of this guild');
    process.exit(2);
  }

  const snap: CatalogSnapshot = { guildId: GUILD, roles, channels, meId: me.id, botMember };
  const report = verifyCatalogSnapshot(snap);
  const botTop = Math.max(0, ...botMember.roles.map((id) => snap.roles.find((r) => r.id === id)?.position ?? 0));
  console.log(`bot highest role position: ${botTop}\n`);

  console.log('roles');
  // Re-walk the sections in CLI order so the output reads exactly as before.
  const roleMsgs = new Map<string, string>();
  for (const f of report.fails) {
    if (f.pick && ['role_missing', 'role_managed', 'role_above_bot'].includes(f.code)) {
      roleMsgs.set(f.pick, `  FAIL  [${f.code}] ${f.message}`);
    }
  }
  for (const p of ALL_PICKS) {
    const note = report.notes.find((n) => n.startsWith(`${p.key}: role renamed`));
    if (note) console.log(`  NOTE  ${note}`);
    const failLine = roleMsgs.get(p.key);
    if (failLine) {
      console.log(failLine);
      continue;
    }
    console.log(`  PASS  ${report.passes.find((m) => m.startsWith(`${p.key} -> `))!}`);
  }

  console.log('\ndestinations');
  const DEST_CODES = ['destination_missing', 'destination_invisible', 'hub_invisible'];
  for (const p of GAME_PICKS) {
    const fail = report.fails.find((f) => f.pick === p.key && DEST_CODES.includes(f.code));
    if (fail) {
      console.log(`  FAIL  [${fail.code}] ${fail.message}`);
      continue;
    }
    const dark = report.darks.find((d) => d.startsWith(`${p.key}:`));
    if (dark) console.log(`  DARK  ${dark}`);
    else console.log(`  PASS  ${report.passes.find((m) => m.startsWith(`${p.key} -> `))!}`);
  }

  console.log('\ngated categories (the permission fix in TWO-7)');
  for (const cat of GATED_CATEGORIES) {
    const missing = report.fails.find((f) => f.code === 'category_missing' && f.message.startsWith(cat.categoryName));
    if (missing) {
      console.log(`  FAIL  [${missing.code}] ${missing.message}`);
      continue;
    }
    const passLine = report.passes.find((m) => m.startsWith(cat.categoryName));
    const darkLine = report.darks.find((d) => d.startsWith(cat.categoryName));
    console.log(passLine ? `  PASS  ${passLine}` : `  DARK  ${darkLine}`);
    const children = channels.filter((c) => c.parent_id === cat.categoryId);
    const empty = report.fails.find((f) => f.code === 'category_empty' && f.message.startsWith(cat.categoryName));
    if (empty) console.log(`  FAIL  [${empty.code}] ${empty.message}`);
    for (const child of children) {
      const cp = report.passes.find((m) => m === `  └ #${child.name} grants view to "${cat.roleName}"`);
      const cd = report.darks.find((d) => d === `  └ #${child.name} does not grant view to "${cat.roleName}" - members cannot open it`);
      console.log(cp ? `  PASS  ${cp}` : `  DARK  ${cd}`);
    }
  }

  console.log(`\n${report.fails.length} fail, ${report.darks.length} dark\n`);
  if (report.darks.length && !report.fails.length) {
    console.log('Onboarding works, but members are being routed to the hub instead of the');
    console.log('purpose-built rooms. Fix: scripts/apply-game-channel-access.ts (needs CEO sign-off).\n');
  }
  process.exit(report.fails.length ? 1 : 0);
}
