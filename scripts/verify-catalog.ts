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
 */
import {
  ALL_PICKS,
  GAME_PICKS,
  GATED_CATEGORIES,
  LANDING_CHANNEL_ID,
} from '../src/onboarding/catalog.ts';

const API = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !GUILD) {
  console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN) and DISCORD_GUILD_ID');
  process.exit(2);
}

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ADMINISTRATOR = 1n << 3n;

let fails = 0;
let darks = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const dark = (m: string) => (darks++, console.log(`  DARK  ${m}`));
const fail = (m: string) => (fails++, console.log(`  FAIL  ${m}`));

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${TOKEN}` } });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

type Role = { id: string; name: string; position: number; managed: boolean; permissions: string };
type Overwrite = { id: string; type: number; allow: string; deny: string };
type Channel = {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
};

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
function canView(channel: Channel, everyoneRole: Role, heldRoleIds: string[]): boolean {
  if (BigInt(everyoneRole.permissions) & (1n << 3n)) return true; // ADMINISTRATOR

  let allowed = (BigInt(everyoneRole.permissions) & VIEW_CHANNEL) !== 0n;
  const ows = channel.permission_overwrites ?? [];

  const everyoneOw = ows.find((o) => o.id === GUILD);
  if (everyoneOw) {
    if (BigInt(everyoneOw.deny) & VIEW_CHANNEL) allowed = false;
    if (BigInt(everyoneOw.allow) & VIEW_CHANNEL) allowed = true;
  }

  // Role overwrites: every deny applies, then every allow, so a single grant
  // beats a deny from another role the member happens to hold.
  const roleOws = ows.filter((o) => o.type === 0 && heldRoleIds.includes(o.id) && o.id !== GUILD);
  if (roleOws.some((o) => BigInt(o.deny) & VIEW_CHANNEL)) allowed = false;
  if (roleOws.some((o) => BigInt(o.allow) & VIEW_CHANNEL)) allowed = true;

  return allowed;
}

console.log('\nTWO onboarding catalog check (read-only)\n');

const [roles, channels, me] = await Promise.all([
  get<Role[]>(`/guilds/${GUILD}/roles`),
  get<Channel[]>(`/guilds/${GUILD}/channels`),
  get<{ id: string }>('/users/@me'),
]);

if (!roles || !channels || !me) {
  console.error('could not read the guild - check the token and that the bot is in the server');
  process.exit(2);
}

const roleById = new Map(roles.map((r) => [r.id, r]));
const chById = new Map(channels.map((c) => [c.id, c]));
const everyoneRole = roleById.get(GUILD)!;

const botMember = await get<{ roles: string[] }>(`/guilds/${GUILD}/members/${me.id}`);
if (!botMember) {
  console.error('the bot is not a member of this guild');
  process.exit(2);
}
const botTop = Math.max(
  0,
  ...botMember.roles.map((id) => roleById.get(id)?.position ?? 0),
);
console.log(`bot highest role position: ${botTop}\n`);

console.log('roles');
for (const p of ALL_PICKS) {
  const r = roleById.get(p.roleId);
  if (!r) {
    fail(`${p.key}: role ${p.roleId} (${p.roleName}) no longer exists`);
    continue;
  }
  if (r.name !== p.roleName) {
    // Not fatal - ids are what we assign - but the catalog comment is now a lie.
    console.log(`  NOTE  ${p.key}: role renamed ${p.roleName} -> ${r.name}`);
  }
  if (r.managed) {
    fail(`${p.key}: "${r.name}" is integration-managed and cannot be assigned by a bot`);
    continue;
  }
  if (r.position >= botTop) {
    fail(`${p.key}: "${r.name}" is at position ${r.position}, at or above the bot's ${botTop}`);
    continue;
  }
  pass(`${p.key} -> "${r.name}" assignable`);
}

/**
 * Same resolution rules as `canView`, for an arbitrary permission bit and for a
 * holder whose base permissions come from every role they hold rather than from
 * `@everyone` alone. The bot needs that second part: its Administrator bit
 * arrives on its own role, not on `@everyone`.
 *
 * Like `canView`, this reads the channel's OWN overwrites and never walks up to
 * the parent category - see the note there for why that distinction is the
 * whole reason this script exists.
 */
function resolveFor(channel: Channel, heldRoleIds: string[], bit: bigint): boolean {
  let base = 0n;
  for (const id of heldRoleIds) base |= BigInt(roleById.get(id)?.permissions ?? '0');
  if (base & ADMINISTRATOR) return true;

  let allowed = (base & bit) !== 0n;
  const ows = channel.permission_overwrites ?? [];

  const everyoneOw = ows.find((o) => o.id === GUILD);
  if (everyoneOw) {
    if (BigInt(everyoneOw.deny) & bit) allowed = false;
    if (BigInt(everyoneOw.allow) & bit) allowed = true;
  }

  const roleOws = ows.filter((o) => o.type === 0 && heldRoleIds.includes(o.id) && o.id !== GUILD);
  if (roleOws.some((o) => BigInt(o.deny) & bit)) allowed = false;
  if (roleOws.some((o) => BigInt(o.allow) & bit)) allowed = true;

  return allowed;
}

console.log('\nlanding channel (where the welcome is posted)');
{
  const ch = chById.get(LANDING_CHANNEL_ID);
  if (!ch) {
    fail(`landing channel ${LANDING_CHANNEL_ID} no longer exists`);
  } else {
    // A brand-new member holds nothing but @everyone at the moment we welcome
    // them: they have just cleared the rules gate, not earned Member.
    const newcomer = [GUILD];

    if (resolveFor(ch, newcomer, VIEW_CHANNEL)) {
      pass(`#${ch.name} is visible to a brand-new member`);
    } else {
      fail(
        `#${ch.name} is invisible to a brand-new member - the welcome would be posted where its own recipient cannot read it`,
      );
    }

    if (resolveFor(ch, newcomer, SEND_MESSAGES)) {
      pass(`#${ch.name} lets a brand-new member post`);
    } else {
      dark(`#${ch.name} does not let a brand-new member post - they can read the welcome but not reply`);
    }

    // Exactly the condition `botCanPost` applies at runtime. A FAIL here means
    // onboarding logs `onboarding_no_landing_channel` and every new member
    // silently gets nothing at all.
    const botHeld = [GUILD, ...botMember.roles];
    if (resolveFor(ch, botHeld, VIEW_CHANNEL) && resolveFor(ch, botHeld, SEND_MESSAGES)) {
      pass(`the bot can post in #${ch.name}`);
    } else {
      fail(`the bot cannot post in #${ch.name} - onboarding would stay silent for every new member`);
    }
  }
}

console.log('\ndestinations');
// What a routed member actually holds: @everyone + Member + the game role.
const MEMBER_ROLE_ID = '1078755185423286372';
for (const p of GAME_PICKS) {
  const targetId = p.primaryChannelId ?? p.fallbackChannelId;
  const ch = chById.get(targetId);
  if (!ch) {
    fail(`${p.key}: destination channel ${targetId} no longer exists`);
    continue;
  }
  const held = [GUILD, MEMBER_ROLE_ID, p.roleId];
  const visible = canView(ch, everyoneRole, held);

  if (visible) {
    pass(`${p.key} -> #${ch.name} visible with "${p.roleName}"`);
  } else if (p.primaryChannelId) {
    const fb = chById.get(p.fallbackChannelId);
    const fbVisible = fb && canView(fb, everyoneRole, held);
    if (!fbVisible) {
      fail(`${p.key}: both #${ch.name} and its fallback are invisible - this pick routes nowhere`);
    } else {
      dark(`${p.key}: #${ch.name} is invisible even with "${p.roleName}" - falls back to #${fb!.name}`);
    }
  } else {
    fail(`${p.key}: hub channel #${ch.name} is not visible to a plain Member`);
  }
}

console.log('\ngated categories (the permission fix in TWO-7)');
for (const cat of GATED_CATEGORIES) {
  const ch = chById.get(cat.categoryId);
  if (!ch) {
    fail(`${cat.categoryName} no longer exists`);
    continue;
  }
  const grants = (c: Channel) =>
    (c.permission_overwrites ?? []).some(
      (o) => o.id === cat.roleId && BigInt(o.allow) & VIEW_CHANNEL,
    );

  if (grants(ch)) pass(`${cat.categoryName} grants view to "${cat.roleName}"`);
  else dark(`${cat.categoryName} does not grant view to "${cat.roleName}" - category is dark`);

  // The category grant is cosmetic on its own. These are the channels a member
  // actually clicks into, and each one needs the overwrite in its own right.
  const children = channels.filter((c) => c.parent_id === cat.categoryId);
  if (!children.length) fail(`${cat.categoryName} has no channels in it`);
  for (const child of children) {
    if (grants(child)) pass(`  └ #${child.name} grants view to "${cat.roleName}"`);
    else dark(`  └ #${child.name} does not grant view to "${cat.roleName}" - members cannot open it`);
  }
}

console.log(`\n${fails} fail, ${darks} dark\n`);
if (darks && !fails) {
  console.log('Onboarding works, but members are being routed to the hub instead of the');
  console.log('purpose-built rooms. Fix: scripts/apply-game-channel-access.ts (needs CEO sign-off).\n');
}
process.exit(fails ? 1 : 0);
