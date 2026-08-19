/**
 * Build the TWO Staging server. Dry run by default.
 *
 *   node scripts/staging-provision.ts             # print the plan, change nothing
 *   node scripts/staging-provision.ts --apply     # actually do it
 *   node scripts/staging-provision.ts --apply --invite            # + an invite link for a human
 *   node scripts/staging-provision.ts --apply --grant-admin <id>  # + make that user an admin
 *
 * WHY THIS EXISTS
 *
 * Discord lets any bot in fewer than ten guilds create one with POST /guilds,
 * and a brand-new staging bot is in zero. So the staging server does not need
 * a human to sit and click: the bot makes it, owns it, and fills it in. The
 * founder's remaining job is one token.
 *
 * WHAT IT CREATES
 *
 *   text   #welcome #general #events #bot-log
 *   voice  Voice 1
 *   roles  Moderator, Member, Game: Test
 *
 * exactly as named in src/staging/spec.ts, because the integration suite
 * asserts on those names.
 *
 * WHY IT IS DRY RUN BY DEFAULT
 *
 * Creating a guild is close to irreversible in the ways that matter. The bot
 * becomes owner, and Discord does not allow a bot to transfer ownership to a
 * person - so a `TWO Staging` created by mistake can be deleted but never
 * handed over. Worse, a bot may only create guilds while it is in fewer than
 * ten; a loop that made ten of them would permanently remove the ability to
 * make an eleventh. Print first, then --apply.
 *
 * IF THE FOUNDER ALREADY MADE THE SERVER BY HAND
 *
 * Set DISCORD_STAGING_GUILD_ID and the script never creates anything - it
 * adopts that guild and only fills in the missing channels and roles. Invite
 * the bot to it first.
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
  ROLE_PERMISSIONS,
  chooseGuild,
  evaluateHierarchy,
  guildCreatePayload,
  planChannels,
  planRoles,
  type PartialChannel,
  type PartialGuild,
  type PartialRole,
} from '../src/staging/provision.ts';
import { LIVE_GUILD_ID, STAGING_SERVER_NAME } from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) {
  console.error(
    '\nMissing DISCORD_STAGING_BOT_TOKEN.\n' +
      '  This is the "Owen Staging" bot token, not the live one. See docs/SECRETS.md.\n' +
      '  Refusing to run: there is no safe default for which server to build.\n',
  );
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

const choice = chooseGuild({ guilds, explicitGuildId });
console.log(`\n  decision   ${choice.action.toUpperCase()}\n  because    ${choice.reason}\n`);

if (choice.action === 'abort') {
  console.error('Stopping. Nothing was changed.\n');
  process.exit(1);
}

let guildId: string;
if (choice.action === 'create') {
  const payload = guildCreatePayload();
  console.log('creating the guild');
  const created = await write<{ id: string; name: string }>(
    `POST /guilds  name="${payload.name}" with ${payload.channels.length} channels`,
    'POST',
    '/guilds',
    payload,
  );
  if (!created) {
    if (!APPLY) {
      console.log(
        '\n  Dry run stops here: everything after this point depends on the new guild id.\n' +
          '  Re-run with --apply to create it, and the same command will go on to fill it in.\n',
      );
      process.exit(0);
    }
    console.error('\nGuild creation failed. Nothing else attempted.\n');
    process.exit(1);
  }
  guildId = created.id;
  console.log(`\n  >>> STAGING GUILD ID: ${guildId}    <<<`);
  console.log('  Put this in DISCORD_STAGING_GUILD_ID and post it on TWO-25.\n');
} else {
  guildId = choice.guildId;
}

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
const cp = planChannels(channels);
console.log('\nchannels');
if (cp.present.length) console.log(`  ok     already there: ${cp.present.join(', ')}`);
for (const d of cp.duplicates) console.log(`  WARN   more than one "${d}" - tests may pick the wrong one`);
if (cp.extra.length) console.log(`  note   not in the spec, left alone: ${cp.extra.join(', ')}`);
if (!cp.create.length) console.log('  ok     nothing to create');
for (const c of cp.create) {
  await write(
    `create ${c.type === CHANNEL_TYPE_VOICE ? 'voice' : 'text'} channel "${c.name}"`,
    'POST',
    `/guilds/${guildId}/channels`,
    { name: c.name, type: c.type },
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
