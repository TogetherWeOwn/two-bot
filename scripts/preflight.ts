/**
 * Pre-deploy credential and permission check. Run it before starting the bot
 * on a new box, and any time joins start recording as 'unknown':
 *
 *   DISCORD_TOKEN=... node scripts/preflight.ts
 *
 * It answers the question "will the funnel actually collect data?" without
 * connecting to the gateway or writing to the database. Every check below
 * corresponds to a real failure we would otherwise only find hours later, as
 * a gap in the numbers that cannot be backfilled.
 *
 * FAIL = the funnel is broken or silently lying. WARN = it works, but we hold
 * more access than the feature needs. Exit code is non-zero only on FAIL, so
 * this is safe to wire into a deploy step.
 *
 * The token is read from the environment and never printed. See docs/SECRETS.md.
 */
const API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing required env var DISCORD_TOKEN. See docs/SECRETS.md.');
  process.exit(2);
}
const guildFilter = process.env.DISCORD_GUILD_ID || null;

let fails = 0;
let warns = 0;
const pass = (m: string, d = '') => console.log(`  PASS  ${m}${d && `  ${d}`}`);
const warn = (m: string, d = '') => (warns++, console.log(`  WARN  ${m}${d && `  ${d}`}`));
const fail = (m: string, d = '') => (fails++, console.log(`  FAIL  ${m}${d && `  ${d}`}`));

async function api(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log('\nTWO bot preflight\n');

// 1. Is the token live at all?
const me = await api('/users/@me');
if (me.status !== 200) {
  fail('token rejected by Discord', `HTTP ${me.status} - rotate or re-issue it`);
  console.log('\nStopping: nothing else can be checked without a valid token.\n');
  process.exit(1);
}
const bot = me.body as { id: string; username: string };
pass('token valid', `bot "${bot.username}" (${bot.id})`);

// 2. Privileged intents. These are portal toggles, not permissions - the bot
//    can be in the server with correct roles and still collect nothing.
const app = await api('/applications/@me');
const flags = (app.body as { flags?: number })?.flags ?? 0;
const MEMBERS = (flags >> 14) & 1 || (flags >> 15) & 1; // approved or limited-toggle
const CONTENT = (flags >> 18) & 1 || (flags >> 19) & 1;

if (MEMBERS) pass('Server Members Intent ON', 'joins and leaves will be received');
else fail('Server Members Intent OFF', 'no join tracking at all - portal > Bot > Privileged Gateway Intents');

// We never request this intent in code, so it cannot leak into the database.
// Having it enabled anyway widens what the application is capable of reading,
// which is a claim we make to members in docs/PRIVACY.md.
if (CONTENT) warn('Message Content Intent ON', 'we never request it in code; turn it OFF to match our privacy stance');
else pass('Message Content Intent OFF', 'matches docs/PRIVACY.md');

// 3. Which servers, and with what permissions?
const guilds = await api('/users/@me/guilds');
const list = (Array.isArray(guilds.body) ? guilds.body : []) as {
  id: string;
  name: string;
  permissions: string;
}[];
const targets = guildFilter ? list.filter((g) => g.id === guildFilter) : list;

if (targets.length === 0) {
  fail(
    guildFilter ? `bot is not in guild ${guildFilter}` : 'bot is not in any server',
    'invite it with the OAuth2 URL in docs/SECRETS.md',
  );
} else if (!guildFilter && list.length > 1) {
  warn(`bot is in ${list.length} servers`, 'set DISCORD_GUILD_ID to pin it to TWO');
}

for (const g of targets) {
  console.log(`\n  ${g.name} (${g.id})`);
  const p = BigInt(g.permissions);
  const has = (bit: bigint) => (p >> bit) & 1n;

  if (has(3n)) {
    // Administrator implies every other permission, so the checks below would
    // all pass regardless. Working, but far more access than we asked for.
    warn('bot has Administrator', 'we only need View Channels + Manage Server - see docs/SECRETS.md');
  }
  if (has(5n)) pass('Manage Server', 'invite attribution possible');
  else fail('missing Manage Server', 'every join will be attributed "unknown"');
  if (has(10n)) pass('View Channels');
  else fail('missing View Channels');

  for (const [bit, name] of [[1n, 'Kick Members'], [2n, 'Ban Members'], [28n, 'Manage Roles'], [4n, 'Manage Channels']] as const) {
    if (has(bit) && !has(3n)) warn(`bot has ${name}`, 'not needed by this bot');
  }

  // 4. The permission that matters most, tested for real rather than inferred.
  //    A role can carry Manage Server and still be denied here by other config.
  const inv = await api(`/guilds/${g.id}/invites`);
  if (inv.status === 200 && Array.isArray(inv.body)) {
    const used = inv.body.filter((i: { uses?: number }) => (i.uses ?? 0) > 0).length;
    pass(`invite list readable`, `${inv.body.length} invites, ${used} with uses on the clock`);
  } else {
    fail('cannot read invite list', `HTTP ${inv.status} - joins will all be "unknown"`);
  }
}

console.log(
  `\n${fails === 0 ? 'Ready to deploy.' : 'NOT ready.'}  ${fails} fail, ${warns} warn\n`,
);
process.exit(fails === 0 ? 0 : 1);
