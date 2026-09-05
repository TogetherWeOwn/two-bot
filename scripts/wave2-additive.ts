/**
 * Wave 2 of the TOG-34 redesign: the additive-only wave. Dry run by default.
 *
 *   node scripts/wave2-additive.ts              # print the plan, change nothing
 *   node scripts/wave2-additive.ts --apply      # actually create them
 *
 * Creates the 4 categories, `#looking-to-play`, and the `Verified` role, per
 * `server-redesign` rev 6 §7 Wave 2. Nothing is hidden, nothing moves, nothing
 * is deleted. §9 rates the rollback at *"Delete 4 categories, 1 channel, 1
 * role. Seconds."*
 *
 * WHY THIS IS SAFE TO RUN AGAINST THE LIVE SERVER
 *
 * 1. ADDITIVE BY CONSTRUCTION. The only HTTP verb this file issues is POST,
 *    to two endpoints: `/guilds/{id}/channels` and `/guilds/{id}/roles`. There
 *    is no DELETE, PATCH or PUT anywhere in it, and `api()` refuses any method
 *    other than GET and POST at runtime rather than trusting the reader. A
 *    wave that cannot express a destructive operation cannot perform one by
 *    accident.
 *
 * 2. IDEMPOTENT. `planWave2` diffs the target against the live server and
 *    emits only what is missing, so a half-finished run is safe to repeat and a
 *    finished one creates nothing. Exit 0 with "nothing to do" is the expected
 *    result of the second run.
 *
 * 3. DRY RUN FIRST. Same idiom as `scripts/staging-provision.ts`: print the
 *    plan, then `--apply`. The dry run makes exactly two GETs.
 *
 * WHAT IT REFUSES
 *
 * Wave 2 runs against the live TWO guild by design - it is the first wave that
 * writes. So the guard here is the opposite of staging-provision's: it checks
 * the token's bot is `Owen` and that the guild is the one rev 6 describes, and
 * stops if the two do not line up. The failure it exists to prevent is a run
 * pointed at the wrong server by a stale environment variable.
 *
 * ONE THING IT ONLY WARNS ABOUT
 *
 * Section 3 reports the onboarding-catalog roles that Wave 6 will delete. That
 * is not Wave 2's job to fix and this script does not touch them. It is printed
 * here because Wave 2 is the last cheap moment to notice, and because the
 * failure mode after Wave 6 is silent - see `catalogRolesDestroyedByWave6`.
 *
 * Exit codes:
 *   0  the target state is reached (or, on a dry run, reachable)
 *   1  at least one write failed, or the plan is not complete after applying
 *   2  could not run: no token, wrong bot, wrong guild, API would not answer
 */
import { ALL_PICKS } from '../src/onboarding/catalog.ts';
import {
  CHANNEL_TYPE_CATEGORY,
  LIVE_GUILD_ID,
  categoryOverwrites,
  catalogRolesDestroyedByWave6,
  planIsComplete,
  planWave2,
  WAVE2_CATEGORIES,
  type PartialChannel,
  type PartialRole,
} from '../src/redesign/wave2.ts';

// WAVE2_API_BASE points the script at a stub in test/e2e.wave2.test.ts. Same
// hook, and the same reason, as WAVE0_API_BASE: the apply path is the half
// worth proving, and it cannot be proved by pointing it at the real server.
const API = process.env.WAVE2_API_BASE ?? 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;
const APPLY = process.argv.includes('--apply');

/** The bot rev 6 §4.5 keeps and the execution-gate §6 corrects the doc to keep. */
const EXPECTED_BOT_ID = '1539711683898118154';

if (!TOKEN) {
  console.error('need DISCORD_BOT_TOKEN (or DISCORD_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}

let failures = 0;

/**
 * The whole network surface. GET and POST only - `method` is checked rather
 * than documented, so the additive guarantee survives a later edit.
 */
async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T | null }> {
  if (method !== 'GET' && method !== 'POST') {
    throw new Error(`wave2 is additive-only; refusing ${method}`);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // Shows up in the guild audit log next to every object this wave makes.
        'X-Audit-Log-Reason': 'TOG-306 Wave 2 (additive) - server-redesign rev 6',
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

/** A create that only happens with --apply. Returns null on a dry run. */
async function create<T>(label: string, path: string, body: unknown): Promise<T | null> {
  if (!APPLY) {
    console.log(`  WOULD   ${label}`);
    return null;
  }
  const res = await api<T>('POST', path, body);
  if (res.status >= 300) {
    console.log(`  ERROR   ${label}  HTTP ${res.status} ${JSON.stringify(res.body)?.slice(0, 300) ?? ''}`);
    failures++;
    return null;
  }
  console.log(`  CREATED ${label}`);
  return res.body;
}

console.log(
  `\nTOG-306 Wave 2 - additive only  ${APPLY ? '[APPLY - this writes to Discord]' : '[dry run - nothing is changed]'}\n`,
);

// --- who and where ----------------------------------------------------------
const me = await api<{ id: string; username: string }>('GET', '/users/@me');
if (me.status !== 200 || !me.body) {
  console.error(`  token rejected by Discord (HTTP ${me.status}). Nothing done.\n`);
  process.exit(2);
}
console.log(`  bot        "${me.body.username}" (${me.body.id})`);
if (me.body.id !== EXPECTED_BOT_ID) {
  console.error(
    `\n  This token is bot ${me.body.id}, not Owen (${EXPECTED_BOT_ID}).\n` +
      '  Wave 2 writes to the live TWO server and will not run as an unexpected identity.\n',
  );
  process.exit(2);
}
if (GUILD !== LIVE_GUILD_ID) {
  console.error(
    `\n  DISCORD_GUILD_ID is ${GUILD}, not the TWO server (${LIVE_GUILD_ID}).\n` +
      '  Wave 2 is written against that server\'s state. Refusing.\n',
  );
  process.exit(2);
}

const guild = await api<{ id: string; name: string }>('GET', `/guilds/${GUILD}`);
if (guild.status !== 200 || !guild.body) {
  console.error(`  cannot read guild ${GUILD} (HTTP ${guild.status}). Nothing done.\n`);
  process.exit(2);
}
console.log(`  guild      "${guild.body.name}" (${guild.body.id})`);

const channelsRes = await api<PartialChannel[]>('GET', `/guilds/${GUILD}/channels`);
const rolesRes = await api<PartialRole[]>('GET', `/guilds/${GUILD}/roles`);
if (!channelsRes.body || !rolesRes.body) {
  console.error('  cannot read channels or roles. Nothing done.\n');
  process.exit(2);
}
const channels = channelsRes.body;
const roles = rolesRes.body;
console.log(`  today      ${channels.length} channels+categories, ${roles.length} roles\n`);

// --- the plan ---------------------------------------------------------------
const plan = planWave2({ channels, roles });

if (plan.present.length) console.log(`  already present: ${plan.present.join(', ')}`);
for (const d of plan.duplicates) {
  console.log(`  WARNING  "${d}" exists more than once. Wave 2 never creates a duplicate.`);
}
if (plan.present.length || plan.duplicates.length) console.log('');

// --- 1. categories ----------------------------------------------------------
console.log('1. Categories');
if (!plan.createCategories.length) console.log('   nothing to do');
/** Name -> id, for parenting #looking-to-play. Filled by creates and by lookup. */
const categoryIds = new Map<string, string>();
for (const c of channels) {
  if (c.type === CHANNEL_TYPE_CATEGORY && c.name) categoryIds.set(c.name, c.id);
}
for (const cat of plan.createCategories) {
  const spec = WAVE2_CATEGORIES.find((w) => w.name === cat.name)!;
  const made = await create<{ id: string }>(
    `category "${cat.name}"${cat.hidden ? '  (@everyone View denied)' : ''}`,
    `/guilds/${GUILD}/channels`,
    {
      name: cat.name,
      type: CHANNEL_TYPE_CATEGORY,
      permission_overwrites: categoryOverwrites(spec, GUILD),
    },
  );
  if (made?.id) categoryIds.set(cat.name, made.id);
}

// --- 2. #looking-to-play ----------------------------------------------------
console.log('\n2. Channel');
if (!plan.createChannels.length) console.log('   nothing to do');
for (const ch of plan.createChannels) {
  const parentId = categoryIds.get(ch.parentCategory);
  if (!parentId && APPLY) {
    console.log(`  ERROR   #${ch.name}: parent category "${ch.parentCategory}" was not created`);
    failures++;
    continue;
  }
  await create<{ id: string }>(`#${ch.name} in "${ch.parentCategory}"`, `/guilds/${GUILD}/channels`, {
    name: ch.name,
    type: ch.type,
    topic: ch.topic,
    ...(parentId ? { parent_id: parentId } : {}),
  });
}

// --- 3. the Verified role ---------------------------------------------------
console.log('\n3. Role');
if (!plan.createRoles.length) console.log('   nothing to do');
for (const role of plan.createRoles) {
  await create<{ id: string }>(
    `role "${role.name}" (hoisted, no permissions)`,
    `/guilds/${GUILD}/roles`,
    { name: role.name, permissions: role.permissions, hoist: role.hoist, color: role.color, mentionable: role.mentionable },
  );
}

// --- 4. the warning Wave 2 is the last cheap moment to print -----------------
const doomed = catalogRolesDestroyedByWave6({
  catalogRoleIds: ALL_PICKS.map((p) => p.roleId),
  roles,
});
console.log('\n4. Carried forward — not this wave\'s job, printed because it is nearly too late');
if (!doomed.length) {
  console.log('   onboarding catalog: no role is destroyed by Wave 6.');
} else {
  console.log(
    `   WARNING  ${doomed.length} of the roles src/onboarding/catalog.ts grants are deleted by Wave 6:`,
  );
  console.log(`            ${doomed.map((d) => d.name).join(', ')}`);
  console.log(
    '            After Wave 6 the bot grants role ids that no longer exist, the grant fails,\n' +
      '            and the funnel records "chose not to pick a game". Silent, same shape as TOG-78.\n' +
      '            Rev 6 §4.6 handles this for Discord\'s NATIVE onboarding prompts; no wave handles ours.',
  );
}

// --- verdict ----------------------------------------------------------------
console.log('');
if (!APPLY) {
  const todo =
    plan.createCategories.length + plan.createChannels.length + plan.createRoles.length;
  console.log(
    todo === 0
      ? 'Dry run: target state already reached. --apply would create nothing.\n'
      : `Dry run: ${todo} object(s) to create. Re-run with --apply.\n`,
  );
  process.exit(0);
}

if (failures) {
  console.error(`Wave 2 finished with ${failures} failed write(s). Re-run to retry - it is idempotent.\n`);
  process.exit(1);
}

// Re-read rather than trusting our own creates. Rev 6 §7's stop rule: "Re-read
// the server state after every wave."
const afterChannels = await api<PartialChannel[]>('GET', `/guilds/${GUILD}/channels`);
const afterRoles = await api<PartialRole[]>('GET', `/guilds/${GUILD}/roles`);
if (!afterChannels.body || !afterRoles.body) {
  console.error('Applied, but could not re-read the server to confirm. Check by hand.\n');
  process.exit(1);
}
const after = planWave2({ channels: afterChannels.body, roles: afterRoles.body });
if (!planIsComplete(after)) {
  console.error('Applied, but the re-read still shows missing objects. Stopping per the §7 stop rule.\n');
  process.exit(1);
}
console.log(
  `Wave 2 complete and verified by re-read: ${afterChannels.body.length} channels+categories, ${afterRoles.body.length} roles.\n`,
);
