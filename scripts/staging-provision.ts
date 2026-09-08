/**
 * Build the TWO Staging server. Dry run by default.
 *
 *   node scripts/staging-provision.ts             # print the plan, change nothing
 *   node scripts/staging-provision.ts --apply     # actually do it
 *   node scripts/staging-provision.ts --apply --invite            # + an invite link for a human
 *   node scripts/staging-provision.ts --apply --grant-admin <id>  # + make that user an admin
 *
 * WHAT THIS DOES, AND WHAT IT NO LONGER DOES
 *
 * It fills in a staging server that a human has already created and invited
 * the bot to. It does NOT create the server.
 *
 * It used to. Discord documents POST /guilds as available to any bot in fewer
 * than ten guilds, and this script was built on that. Run for real on
 * 2026-09-05 with the staging bot in zero guilds, Discord answered HTTP 400
 * {"message":"Bots cannot use this endpoint","code":20001} - same on a bare
 * payload and on API v9, so it is the endpoint, not us. There is no setting,
 * intent or permission that reopens it.
 *
 * So the one-minute human step is unavoidable. Run this with no
 * DISCORD_STAGING_GUILD_ID set and it prints exactly what to do, including the
 * invite link. Then set the id and re-run, and everything below happens
 * automatically.
 *
 * WHAT IT CREATES INSIDE THAT SERVER
 *
 *   text   #welcome #general #events #bot-log
 *   voice  Voice 1
 *   roles  Moderator, Member, Game: Test
 *
 * exactly as named in src/staging/spec.ts, because the integration suite
 * asserts on those names.
 *
 * WHY IT IS STILL DRY RUN BY DEFAULT
 *
 * It writes channels and roles into a real server. That is far less dangerous
 * than creating one, but it is still someone else's Discord, and printing the
 * plan first costs nothing. Print, then --apply.
 *
 * HOW THE SERVER GETS MADE
 *
 * A human makes it and invites the bot - there is no longer any other way, see
 * above. Set DISCORD_STAGING_GUILD_ID to it and this script adopts that guild
 * and fills in the missing channels and roles. Run with the variable unset for
 * the full instructions and the invite link.
 *
 * ONE CONSEQUENCE WORTH KNOWING. On a human-made server the bot is an ordinary
 * invited member, not the owner, so it does NOT bypass role hierarchy. Its own
 * role must sit above Moderator, Member and Game: Test or role assignment
 * fails with a silent 403. This script pushes those roles down automatically
 * when it can, and tells you to drag the bot up when it cannot.
 *
 * WHAT IT NEVER DOES
 *
 * It never deletes or renames a channel or a role, never touches a guild it
 * was not pointed at, and refuses outright on the live TWO guild id. Extra
 * channels someone added by hand are reported and left alone.
 *
 * The token is read from the environment and never printed.
 */
import {
  CHANNEL_TYPE_TEXT,
  CHANNEL_TYPE_VOICE,
  channelCreateBody,
  ROLE_PERMISSIONS,
  chooseGuild,
  evaluateHierarchy,
  planChannels,
  planRoles,
  type PartialChannel,
  type PartialGuild,
  type PartialRole,
} from '../src/staging/provision.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  STAGING_SERVER_NAME,
  checkStagingToken,
} from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) {
  console.error(
    '\nMissing DISCORD_STAGING_BOT_TOKEN.\n' +
      `  This is the ${STAGING_BOT_APPLICATION_NAME} bot token (application ${STAGING_BOT_APPLICATION_ID}).\n` +
      '  Not the live one. See docs/SECRETS.md.\n' +
      '  Refusing to run: there is no safe default for which server to build.\n',
  );
  process.exit(2);
}

const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) {
  console.error(`\n${tokenCheck.message}\n`);
  process.exit(2);
}

const APPLY = process.argv.includes('--apply');
const WANT_INVITE = process.argv.includes('--invite');
const grantAdminIdx = process.argv.indexOf('--grant-admin');
const GRANT_ADMIN = grantAdminIdx >= 0 ? process.argv[grantAdminIdx + 1] : undefined;
if (grantAdminIdx >= 0 && !/^\d{15,25}$/.test(GRANT_ADMIN ?? '')) {
  console.error('\n--grant-admin needs a Discord user id (the long number).\n');
  process.exit(2);
}

const explicitGuildId = process.env.DISCORD_STAGING_GUILD_ID;
if (explicitGuildId === LIVE_GUILD_ID) {
  console.error(`\nDISCORD_STAGING_GUILD_ID is the LIVE TWO server (${LIVE_GUILD_ID}). Refusing.\n`);
  process.exit(2);
}

type Res<T> = { status: number; body: T | null };

async function api<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      console.log(`  ... rate limited, waiting ${retry}s`);
      await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000));
      continue;
    }
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  }
  return { status: 429, body: null };
}

/** A write that only happens with --apply. Returns null on a dry run. */
async function write<T>(label: string, method: string, path: string, body?: unknown): Promise<T | null> {
  if (!APPLY) {
    console.log(`  WOULD  ${label}`);
    return null;
  }
  const res = await api<T>(method, path, body);
  if (res.status >= 300) {
    console.log(`  ERROR  ${label}  HTTP ${res.status} ${JSON.stringify(res.body)?.slice(0, 300) ?? ''}`);
    failures++;
    return null;
  }
  console.log(`  DID    ${label}`);
  return res.body;
}

let failures = 0;

console.log(`\nTWO staging provisioning  ${APPLY ? '[APPLY - this writes to Discord]' : '[dry run - nothing is changed]'}\n`);

// --- who are we -------------------------------------------------------------
const me = await api<{ id: string; username: string }>('GET', '/users/@me');
if (me.status !== 200 || !me.body) {
  console.error(`  staging token rejected by Discord (HTTP ${me.status}). Nothing done.\n`);
  process.exit(1);
}
const botId = me.body.id;
console.log(`  bot        "${me.body.username}" (${botId})`);

// --- create or adopt --------------------------------------------------------
const guildsRes = await api<PartialGuild[]>('GET', '/users/@me/guilds');
if (guildsRes.status !== 200 || !guildsRes.body) {
  console.error(`  cannot list the bot's guilds (HTTP ${guildsRes.status}). Nothing done.\n`);
  process.exit(1);
}
const guilds = guildsRes.body;
console.log(`  in guilds  ${guilds.length}${guilds.length ? `: ${guilds.map((g) => `${g.name} (${g.id})`).join(', ')}` : ''}`);

const choice = chooseGuild({ guilds, explicitGuildId, bot: { id: botId, username: me.body.username } });

// Warnings before the decision, because they are usually the explanation for
// it. A staging bot in a guild nobody meant to add it to is worth seeing even
// when the run then succeeds.
for (const w of choice.warnings) console.log(`\n  WARNING    ${w}`);

console.log(`\n  decision   ${choice.action.toUpperCase()}\n  because    ${choice.reason}\n`);

if (choice.action === 'abort') {
  console.error('Stopping. Nothing was changed.\n');
  process.exit(1);
}

// `chooseGuild` only ever returns `reconcile` or `abort` now, and `abort`
// exited above. There is no create branch because there is no create: the
// endpoint refuses bots outright (see `guildCreateIsUnavailable`). This script
// now only ever fills in a server a human already made.
const guildId: string = choice.guildId;

// --- what is in it now ------------------------------------------------------
const guild = await api<{ id: string; name: string; owner_id: string }>('GET', `/guilds/${guildId}`);
if (guild.status !== 200 || !guild.body) {
  console.error(`  cannot read guild ${guildId} (HTTP ${guild.status}).\n`);
  process.exit(1);
}
const ownerId = guild.body.owner_id ?? null;
const weOwnIt = ownerId === botId;
console.log(
  `  guild      "${guild.body.name}" (${guildId})  owner ${weOwnIt ? 'is this bot' : `is ${ownerId}`}`,
);
if (guild.body.name !== STAGING_SERVER_NAME) {
  console.log(`  note       name is not "${STAGING_SERVER_NAME}". Left alone - this script never renames.`);
}

const channelsRes = await api<PartialChannel[]>('GET', `/guilds/${guildId}/channels`);
const rolesRes = await api<PartialRole[]>('GET', `/guilds/${guildId}/roles`);
const channels = channelsRes.body ?? [];
const roles = rolesRes.body ?? [];

// --- channels ---------------------------------------------------------------
const cp = planChannels(channels, guildId, botId);
console.log('\nchannels');
if (cp.present.length) console.log(`  ok     already there: ${cp.present.join(', ')}`);
for (const d of cp.duplicates) console.log(`  WARN   more than one "${d}" - tests may pick the wrong one`);
if (cp.extra.length) console.log(`  note   not in the spec, left alone: ${cp.extra.join(', ')}`);
if (!cp.create.length && !cp.repair.length) console.log('  ok     nothing to create or repair');
for (const c of cp.create) {
  await write(
    `create ${c.type === CHANNEL_TYPE_VOICE ? 'voice' : 'text'} channel "${c.name}"`,
    'POST',
    `/guilds/${guildId}/channels`,
    channelCreateBody(c, guildId, botId),
  );
}
for (const c of cp.repair) {
  await write(
    `repair private overwrites on #${c.name}`,
    'PATCH',
    `/channels/${c.id}`,
    { permission_overwrites: c.permission_overwrites },
  );
}

// --- roles ------------------------------------------------------------------
const rp = planRoles(roles);
console.log('\nroles');
if (rp.present.length) console.log(`  ok     already there: ${rp.present.join(', ')}`);
for (const d of rp.duplicates) console.log(`  WARN   more than one role named "${d}"`);
if (!rp.create.length) console.log('  ok     nothing to create');
for (const name of rp.create) {
  await write(`create role "${name}"`, 'POST', `/guilds/${guildId}/roles`, {
    name,
    permissions: ROLE_PERMISSIONS[name] ?? '0',
    mentionable: false,
  });
}

// --- hierarchy --------------------------------------------------------------
// Re-read: roles we just made land at position 1 and shuffle everything above.
const rolesAfter = APPLY ? ((await api<PartialRole[]>('GET', `/guilds/${guildId}/roles`)).body ?? roles) : roles;
const h = evaluateHierarchy({ roles: rolesAfter, botId, ownerId });

console.log('\nrole hierarchy');
if (h.ownerBypass) {
  console.log('  ok     the bot OWNS this guild, so it can grant any role regardless of position.');
  console.log('         The usual silent 403-on-role-assign failure cannot happen here.');
} else if (h.humanFix) {
  console.log(`  FAIL   ${h.humanFix}`);
  failures++;
} else if (h.repositions.length) {
  console.log(`  fixing ${h.repositions.length} role position(s) so the bot outranks them`);
  await write(
    `move ${h.repositions.map((r) => `"${r.name}"->${r.position}`).join(', ')}`,
    'PATCH',
    `/guilds/${guildId}/roles`,
    h.repositions.map((r) => ({ id: r.id, position: r.position })),
  );
} else {
  console.log(`  ok     bot role "${h.botRoleName}" at ${h.botPosition}, above ${h.assignable.join(', ') || 'nothing yet'}`);
}
if (h.missing.length && APPLY) console.log(`  note   still missing: ${h.missing.join(', ')} (creation above may have failed)`);

// --- letting a human in -----------------------------------------------------
// A bot-created guild has no people in it at all, not even the founder.
if (GRANT_ADMIN) {
  console.log('\nadmin access');
  const existing = rolesAfter.find((r) => r.name === 'Staging Admin');
  const adminRole =
    existing ??
    (await write<PartialRole>('create role "Staging Admin" (Administrator)', 'POST', `/guilds/${guildId}/roles`, {
      name: 'Staging Admin',
      permissions: String(1n << 3n),
    }));
  if (adminRole) {
    await write(
      `grant "Staging Admin" to user ${GRANT_ADMIN}`,
      'PUT',
      `/guilds/${guildId}/members/${GRANT_ADMIN}/roles/${adminRole.id}`,
    );
    console.log('  note   the user must already be in the server. Use --invite first if they are not.');
  }
}

if (WANT_INVITE) {
  console.log('\ninvite');
  const welcome = (channelsRes.body ?? []).find((c) => c.name === 'welcome' && c.type === CHANNEL_TYPE_TEXT);
  const target =
    welcome ??
    (APPLY ? ((await api<PartialChannel[]>('GET', `/guilds/${guildId}/channels`)).body ?? []).find(
      (c) => c.type === CHANNEL_TYPE_TEXT,
    ) : undefined);
  if (!target) {
    console.log('  WARN   no text channel to invite into yet. Re-run after the channels exist.');
  } else {
    const inv = await write<{ code: string }>(
      `create a 7-day, 5-use invite to #${target.name}`,
      'POST',
      `/channels/${target.id}/invites`,
      { max_age: 604800, max_uses: 5, unique: true },
    );
    if (inv) {
      console.log(`\n  https://discord.gg/${inv.code}\n`);
      console.log('  Expires in 7 days, 5 uses. Share it directly with the founder, not in a public channel.');
    }
  }
}

// --- what to do next --------------------------------------------------------
console.log('');
if (!APPLY) {
  console.log('Dry run. Nothing above happened. Re-run with --apply.\n');
  process.exit(0);
}
console.log(`Done, ${failures} error(s).`);
console.log(`\n  export DISCORD_STAGING_GUILD_ID=${guildId}`);
console.log('  node scripts/staging-verify.ts     # confirm it against the spec');
console.log('  node scripts/staging-reset.ts      # seed the fixtures\n');
process.exit(failures ? 1 : 0);
