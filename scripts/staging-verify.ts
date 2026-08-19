/**
 * Check the staging Discord server against the spec in src/staging/spec.ts.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... DISCORD_STAGING_GUILD_ID=... \
 *     node scripts/staging-verify.ts
 *
 * Run this the moment the staging server exists, before QA writes a single
 * integration test. It answers "is this server the one we agreed on, and can
 * the bot actually do anything in it?" - both of which fail quietly otherwise.
 *
 * The role-position check is first and is the important one. When the bot's
 * own role sits below a role it is asked to grant, Discord returns 403 and
 * nothing in the bot logs an error: the member simply never gets the role and
 * the funnel records a member who "chose not to pick a game". That is a wrong
 * number, not a crash, so it can survive a long time. The fix is one drag in
 * Server Settings > Roles.
 *
 * FAIL = staging cannot support the integration suite. WARN = it works but
 * differs from the spec. Exit code is non-zero only on FAIL.
 *
 * The token is read from the environment and never printed.
 */
import {
  STAGING_PERMISSIONS,
  STAGING_ROLES,
  STAGING_SERVER_NAME,
  STAGING_TEXT_CHANNELS,
  STAGING_VOICE_CHANNELS,
  describePermissions,
  stagingGuildId,
} from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) {
  console.error(
    '\nMissing DISCORD_STAGING_BOT_TOKEN.\n' +
      '  This is the "Owen Staging" bot token, not the live one. See docs/SECRETS.md.\n',
  );
  process.exit(2);
}

let guildId: string;
try {
  guildId = stagingGuildId();
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(2);
}

let fails = 0;
let warns = 0;
const pass = (m: string, d = '') => console.log(`  PASS  ${m}${d && `  ${d}`}`);
const warn = (m: string, d = '') => (warns++, console.log(`  WARN  ${m}${d && `  ${d}`}`));
const fail = (m: string, d = '') => (fails++, console.log(`  FAIL  ${m}${d && `  ${d}`}`));

async function api<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
}

console.log('\nTWO staging server check\n');

// 1. token
const me = await api<{ id: string; username: string }>('/users/@me');
if (me.status !== 200 || !me.body) {
  fail('staging token rejected by Discord', `HTTP ${me.status}`);
  console.log('\nStopping: nothing else can be checked without a valid token.\n');
  process.exit(1);
}
const botId = me.body.id;
pass('staging token valid', `bot "${me.body.username}" (${botId})`);

// 2. the right server
const guild = await api<{ id: string; name: string }>(`/guilds/${guildId}`);
if (guild.status !== 200 || !guild.body) {
  fail('bot is not in the staging guild', `HTTP ${guild.status} for guild ${guildId}`);
  console.log('\nStopping: re-invite the bot with the scoped permission link.\n');
  process.exit(1);
}
if (guild.body.name !== STAGING_SERVER_NAME) {
  warn('server name differs from the spec', `"${guild.body.name}" vs "${STAGING_SERVER_NAME}"`);
} else {
  pass('server', `"${guild.body.name}" (${guild.body.id})`);
}

// 3. roles exist, and the bot outranks the ones it must grant
const roles = await api<Array<{ id: string; name: string; position: number; managed: boolean; tags?: { bot_id?: string } }>>(
  `/guilds/${guildId}/roles`,
);
if (roles.status !== 200 || !roles.body) {
  fail('cannot read roles', `HTTP ${roles.status}`);
} else {
  const byName = new Map(roles.body.map((r) => [r.name, r]));
  const botRole = roles.body.find((r) => r.tags?.bot_id === botId);
  const botPos = botRole?.position ?? -1;
  if (!botRole) {
    fail('cannot find the bot\'s own managed role', 're-invite the bot');
  } else {
    pass('bot role', `"${botRole.name}" at position ${botPos}`);
  }

  for (const name of STAGING_ROLES) {
    const r = byName.get(name);
    if (!r) {
      fail(`role "${name}" is missing`, 'create it - see docs/STAGING.md');
      continue;
    }
    if (botPos >= 0 && r.position >= botPos) {
      fail(
        `bot cannot assign "${name}"`,
        `role is at position ${r.position}, bot at ${botPos}. ` +
          'Drag the bot role ABOVE it in Server Settings > Roles. This fails SILENTLY.',
      );
    } else {
      pass(`role "${name}" assignable`, `position ${r.position} < bot ${botPos}`);
    }
  }
}

// 4. channels
const channels = await api<Array<{ id: string; name: string; type: number }>>(
  `/guilds/${guildId}/channels`,
);
if (channels.status !== 200 || !channels.body) {
  fail('cannot read channels', `HTTP ${channels.status}`);
} else {
  const text = new Set(channels.body.filter((c) => c.type === 0).map((c) => c.name));
  const voice = new Set(channels.body.filter((c) => c.type === 2).map((c) => c.name));
  for (const name of STAGING_TEXT_CHANNELS) {
    if (text.has(name)) pass(`#${name} exists`);
    else fail(`#${name} is missing`, 'the integration suite expects it');
  }
  for (const name of STAGING_VOICE_CHANNELS) {
    if (voice.has(name)) pass(`voice "${name}" exists`);
    else
      fail(
        `voice channel "${name}" is missing`,
        'first_voice_session cannot be asserted without a real voice channel',
      );
  }
}

// 5. permissions actually held
const self = await api<{ roles: string[] }>(`/guilds/${guildId}/members/${botId}`);
const allRoles = roles.body ?? [];
if (self.status === 200 && self.body && allRoles.length) {
  let mask = 0n;
  const held = new Set(self.body.roles);
  for (const r of allRoles) {
    if (held.has(r.id) || r.id === guildId) {
      mask |= BigInt((r as unknown as { permissions: string }).permissions ?? '0');
    }
  }
  const ADMIN = 1n << 3n;
  if (mask & ADMIN) {
    warn(
      'staging bot holds Administrator',
      'the spec is the scoped set - staging is where we prove the live bot needs no more',
    );
  }
  const { held: have, missing } = describePermissions(mask);
  if (missing.length) {
    fail(`missing permissions: ${missing.join(', ')}`, `expected the scoped set ${STAGING_PERMISSIONS}`);
  } else {
    pass('scoped permissions held', have.join(', '));
  }
} else {
  warn('could not resolve the bot\'s effective permissions', `HTTP ${self.status}`);
}

// 6. Server Members Intent - the fixture suite is meaningless without it
const app = await api<{ flags?: number }>('/applications/@me');
if (app.status === 200 && app.body) {
  const GUILD_MEMBERS_LIMITED = 1 << 14;
  const GUILD_MEMBERS = 1 << 15;
  const flags = app.body.flags ?? 0;
  if (flags & (GUILD_MEMBERS_LIMITED | GUILD_MEMBERS)) {
    pass('Server Members Intent is on');
  } else {
    fail(
      'Server Members Intent is OFF',
      'no member_join events will fire. Developer Portal > Bot > Privileged Gateway Intents',
    );
  }
} else {
  warn('could not read the application flags', `HTTP ${app.status}`);
}

console.log(`\n${fails} fail, ${warns} warn\n`);
process.exit(fails ? 1 : 0);
