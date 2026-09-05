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
 */
import { DiscordRest } from '../src/discord/rest.ts';
import { GUILD_ID } from '../src/onboarding/catalog.ts';

const TOKEN = process.env.DISCORD_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID ?? GUILD_ID;
if (!TOKEN) {
  console.error('need DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See scripts/preflight.ts.');
  process.exit(2);
}

/** Discord role. `managed` means an integration owns it; nobody can delete it. */
interface RawRole {
  id: string;
  name: string;
  position: number;
  managed?: boolean;
  tags?: { bot_id?: string };
}

const rest = new DiscordRest({ token: TOKEN });

const roles = await rest.get<RawRole[]>(`/guilds/${GUILD}/roles`);
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

const byId = new Map(roles.map((r) => [r.id, r]));
const mine = member.roles.map((id) => byId.get(id)).filter((r): r is RawRole => !!r);
// Highest position wins; Discord breaks a position tie by the lower snowflake.
const top = mine.sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))[0];
if (!top) {
  console.error('bot holds no roles at all -- it cannot write anything.');
  process.exit(2);
}

const targets = roles.filter((r) => r.id !== GUILD && !r.managed);
const reachable = targets.filter((r) => r.position < top.position);
const blocked = targets.filter((r) => r.position >= top.position);
const highest = targets.reduce((a, b) => (b.position > a.position ? b : a), targets[0]);

console.log(`# Wave 6 hierarchy pre-flight -- guild ${GUILD}`);
console.log(`bot: ${me.username} (${me.id})`);
console.log(`top role: "${top.name}" position ${top.position}\n`);

console.log('## 1. Role inventory');
console.log(`  ${roles.length} roles = @everyone + ${roles.filter((r) => r.managed).length} managed + ${targets.length} deletable-in-principle`);
console.log(`  Wave 6 targets (non-managed): ${targets.length}`);
console.log(`  highest target: "${highest.name.trim() || '(blank)'}" @${highest.position}\n`);

console.log('## 2. Reach');
console.log(`  reachable (position < ${top.position}): ${reachable.length}`);
console.log(`  REFUSED by hierarchy (>= ${top.position}): ${blocked.length}`);
if (blocked.length) {
  console.log(`\n  Wave 6 would delete ${reachable.length} roles, then take 403 Missing Permissions`);
  console.log('  on every remaining one, leaving the server half-rebuilt. Sample:');
  for (const r of [...blocked].sort((a, b) => a.position - b.position).slice(0, 10)) {
    console.log(`    ${r.name.trim() || '(blank)'} @${r.position}`);
  }
  // Raise the bot's OWN managed role, not whichever role happens to be highest
  // right now: a managed role is not a Wave 6 target, so it survives the wave.
  // Raising a non-managed role instead would mean raising a role the wave then
  // deletes, which drops us back below the remaining targets mid-run.
  const ownRole = mine.find((r) => r.managed && r.tags?.bot_id === me.id);
  console.log(`\n  FIX (guild owner only -- a bot cannot move a role to or above its own top`);
  console.log('  role, so we cannot do this ourselves):');
  if (ownRole) {
    console.log(`  drag the integration role "${ownRole.name}" (currently @${ownRole.position}) above`);
    console.log(`  "${highest.name.trim() || '(blank)'}" (@${highest.position}), i.e. to position > ${highest.position}.`);
    console.log(`  Use "${ownRole.name}" and NOT "${top.name}": "${ownRole.name}" is managed, so Wave 6`);
    console.log('  does not delete it. A non-managed role would be deleted by the wave itself.');
  } else {
    console.log(`  raise this bot's integration role above "${highest.name.trim() || '(blank)'}" (@${highest.position}).`);
  }
}

console.log('\n## 3. Wick / anti-nuke -- NOT VERIFIABLE HERE');
const wick = roles.find((r) => r.name === 'Wick' && r.managed);
if (wick) {
  console.log(`  Wick role @${wick.position}; our top role @${top.position}.`);
  console.log(
    wick.position > top.position
      ? '  Wick outranks us: if anti-nuke arms and we are not whitelisted, Wick CAN ban our bot mid-wave.'
      : '  We outrank the Wick role, but Wick may still act via Administrator.',
  );
} else {
  console.log('  no managed role named "Wick" found.');
}
console.log('  The whitelist itself is UNVERIFIED: it lives in Wick, and Discord exposes');
console.log('  no endpoint for another application\'s config. A human must confirm it in');
console.log('  the Wick dashboard (TOG-1166). This script never reports it as passing.');

console.log(`\n## Verdict: ${blocked.length === 0 ? 'PASS -- every target is reachable' : `FAIL -- ${blocked.length} of ${targets.length} targets unreachable`}`);
process.exit(blocked.length === 0 ? 0 : 1);
