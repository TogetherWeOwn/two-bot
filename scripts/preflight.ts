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
 * Exit-code contract (CONTRIBUTING.md §CLI exit-code contract): 0 ready,
 * 1 a check failed, 2 the token is missing so nothing ran.
 *
 * The token is never printed. See docs/SECRETS.md.
 */
import { readSecret } from '../src/core/credentials.ts';
import {
  resolveChannelAccess,
  type ChannelAccess,
  type Overwrite,
} from '../src/discord/channelAccess.ts';

const API = 'https://discord.com/api/v10';

// Same lookup order as src/core/config.ts: the systemd credential first, then
// the environment. On the shared box the token is a credential file, not an
// environment variable, so a preflight that only read the environment would
// report "missing token" on the one machine that matters. From a laptop or the
// agent runtime nothing changes - there is no credential directory, so it falls
// straight through to DISCORD_BOT_TOKEN / DISCORD_TOKEN as before.
const token = readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN']);
if (!token) {
  console.error('Missing bot token. Set DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}
const guildFilter = process.env.DISCORD_GUILD_ID || null;
const alertChannelId = process.env.DISCORD_STAFF_ALERT_CHANNEL_ID || null;

interface ChannelShape {
  name: string;
  type: number;
  guild_id: string;
  permission_overwrites?: Overwrite[];
}

async function effectivePerms(
  guildId: string,
  botId: string,
  ch: ChannelShape,
): Promise<ChannelAccess | null> {
  const [member, roles] = await Promise.all([
    api(`/guilds/${guildId}/members/${botId}`),
    api(`/guilds/${guildId}/roles`),
  ]);
  if (member.status !== 200 || roles.status !== 200) return null;

  return resolveChannelAccess({
    guildId,
    botId,
    botRoleIds: (member.body as { roles: string[] }).roles,
    guildRoles: roles.body as { id: string; permissions: string }[],
    overwrites: ch.permission_overwrites ?? [],
  });
}

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

// Automod alone requests this intent. Its message cache is disabled and content
// is never written, but the portal toggle must match the configured runtime.
const automodEnabled = process.env.TWO_AUTOMOD === '1';
if (automodEnabled && CONTENT) pass('Message Content Intent ON', 'required by TWO_AUTOMOD=1');
else if (automodEnabled) fail('Message Content Intent OFF', 'automod cannot inspect messages - enable the portal toggle');
else if (CONTENT) warn('Message Content Intent ON', 'TWO_AUTOMOD is off; turn the unused capability OFF');
else pass('Message Content Intent OFF', 'automod is off; matches docs/PRIVACY.md');

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
    warn('bot has Administrator', 'target is the six-bit grant in docs/SECRETS.md, not Administrator');
  }
  if (has(5n)) pass('Manage Server', 'invite attribution possible');
  else fail('missing Manage Server', 'every join will be attributed "unknown"');
  if (has(10n)) pass('View Channels');
  else fail('missing View Channels');

  // These four are required by the internal-actions endpoint (TOG-44) even
  // though Manage Server does not imply any of them - see
  // docs/INTERNAL_ACTIONS.md §8. Assert them explicitly so a future trim
  // (TOG-42/TOG-64) cannot silently drop one again the way the original
  // "View Channels + Manage Server" target did.
  for (const [bit, name, action] of [
    [0n, 'Create Instant Invite', 'guild.add_member (one-click join, TWO-57)'],
    [28n, 'Manage Roles', 'role.assign (routed welcome, TWO-69)'],
    [33n, 'Manage Events', 'event.upsert'],
    [11n, 'Send Messages', 'announcement.post'],
  ] as const) {
    if (has(bit)) pass(name, `${action} works`);
    else fail(`missing ${name}`, `${action} will 403`);
  }

  for (const [bit, name] of [[1n, 'Kick Members'], [2n, 'Ban Members'], [4n, 'Manage Channels']] as const) {
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

  // 5. Can the alert actually be delivered? makeRaidAnnouncer degrades to
  //    log-only when the bot cannot post (raidAlert.ts, 'raid_alert_undeliverable'),
  //    so a misconfigured channel is not a crash - it is a raid nobody hears
  //    about. Resolve the effective overwrites the way Discord does rather than
  //    trusting the guild-level bits above: the six-bit grant is guild-wide and
  //    says nothing about one channel's @everyone deny.
  if (alertChannelId) {
    const ch = await api(`/channels/${alertChannelId}`);
    const c = ch.body as ChannelShape;
    if (ch.status !== 200) {
      fail('staff alert channel unreadable', `HTTP ${ch.status} - raid alerts will only reach the log`);
    } else if (c.guild_id !== g.id) {
      fail('staff alert channel is in another guild', `channel guild ${c.guild_id} != ${g.id}`);
    } else if (c.type !== 0 && c.type !== 5) {
      fail('staff alert channel is not a text channel', `type ${c.type} - botCanPost() rejects it`);
    } else {
      const eff = await effectivePerms(g.id, bot.id, c);
      if (eff === null) {
        warn('could not resolve alert channel permissions', 'check it by hand before relying on alerts');
      } else if (eff.admin) {
        // True today and the reason this currently works. TOG-64 removes it.
        warn(
          `alert channel #${c.name} posts only via Administrator`,
          'the @everyone deny below applies the moment Administrator is trimmed (TOG-64) - give the bot a Staff-side allow first',
        );
      } else if (!eff.view || !eff.send) {
        fail(
          `cannot post in alert channel #${c.name}`,
          `${!eff.view ? 'View denied' : 'Send denied'} - raid alerts silently degrade to log-only`,
        );
      } else {
        pass(`alert channel #${c.name} writable`, 'raid alerts will be delivered');
      }
    }
  } else {
    warn('DISCORD_STAFF_ALERT_CHANNEL_ID unset', 'raid alerts reach the process log only');
  }
}

console.log(
  `\n${fails === 0 ? 'Ready to deploy.' : 'NOT ready.'}  ${fails} fail, ${warns} warn\n`,
);
process.exit(fails === 0 ? 0 : 1);
