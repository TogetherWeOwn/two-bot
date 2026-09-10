/**
 * Deciding what to do to the staging server, with no network in sight.
 *
 * `scripts/staging-provision.ts` is the I/O half; this is the thinking half.
 * Everything that could get the answer wrong lives here so it can be tested
 * without a token, without a guild, and without the ability to do damage.
 *
 * Two things in here are worth reading before you trust the script:
 *
 * 1. THIS BOT CANNOT CREATE A GUILD AT ALL. Discord documents `POST /guilds`
 *    as available to a bot in fewer than ten guilds, and this module was built
 *    on that. It is not true for us: measured 2026-09-05 against the real
 *    token, at zero guilds, the endpoint returns HTTP 400 `code 20001`,
 *    "Bots cannot use this endpoint" - on a bare payload and on v9 too. So
 *    `chooseGuild` never returns `create`; it adopts a guild a human made and
 *    otherwise stops with the invite instructions in
 *    `guildCreateIsUnavailable`. The ten-guild refusals below are kept because
 *    a bot at the limit has a different problem worth naming, and because
 *    nothing here should quietly assume the endpoint stays shut forever.
 *    It also never fails quietly: any guild the staging bot is in that we did
 *    not put it in comes back as a warning from `inspectGuildList`, because
 *    the only way that happens is somebody else inviting it - which the Public
 *    Bot setting allows.
 *
 * 2. OWNERSHIP CHANGES THE ROLE-HIERARCHY QUESTION. The usual staging failure
 *    is that the bot's role sits below a role it must grant, Discord answers
 *    403, and nothing logs - so the funnel quietly records a member who "chose
 *    not to pick a game". That is real, and it is why `staging-verify.ts`
 *    checks position first. But a guild OWNER bypasses permission and
 *    hierarchy checks entirely, and a bot that creates a guild is its owner.
 *    `evaluateHierarchy` is the one place that distinction is made.
 *
 *    Read (1) before relying on the owner branch: now that the bot cannot
 *    create a guild, every real staging server is human-created and the bot is
 *    an ordinary invited member of it. The `ownerBypass` path is therefore
 *    effectively dead in production, and the hierarchy check DOES fire. Anyone
 *    who was expecting role assignment to "just work because the bot owns the
 *    guild" should expect the opposite: the bot's role must be dragged above
 *    every role in STAGING_ROLES, or `evaluateHierarchy` will say so and
 *    `staging-verify.ts` will fail. The branch is kept because it is correct
 *    for any guild the bot does own, and because it costs nothing.
 */
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  STAGING_ROLES,
  STAGING_SERVER_NAME,
  STAGING_TEXT_CHANNELS,
  STAGING_VOICE_CHANNELS,
  stagingInviteUrl,
} from './spec.ts';

export const CHANNEL_TYPE_TEXT = 0;
export const CHANNEL_TYPE_VOICE = 2;

/** Discord's hard limit on guild creation by a bot. */
export const GUILD_CREATE_LIMIT = 10;
/** We stop well short of it, because hitting it is permanent. */
export const GUILD_CREATE_HEADROOM = 8;

export type PartialGuild = { id: string; name: string; owner?: boolean };
export type PartialRole = {
  id: string;
  name: string;
  position: number;
  managed?: boolean;
  permissions?: string;
  tags?: { bot_id?: string };
};
export type PartialChannel = { id: string; name: string; type: number };

/**
 * There is no `create` variant. There used to be, and dropping it is the point
 * rather than tidying: with only `reconcile` and `abort` left, the compiler
 * guarantees no caller can be written that assumes a guild will be created,
 * which is how `scripts/staging-provision.ts` was shown to still have a dead
 * create branch. See `guildCreateIsUnavailable`.
 */
export type GuildChoice = (
  | { action: 'reconcile'; guildId: string; reason: string }
  | { action: 'abort'; reason: string }
) & {
  /**
   * Things worth saying out loud whatever the decision was. Never empty when
   * the staging bot is in a guild we did not expect it to be in.
   */
  warnings: string[];
};

/**
 * What the bot's guild list says about the bot, independent of what we are
 * about to do to it.
 *
 * A staging bot should be in its own staging server and nothing else. Any
 * other guild means someone added it - which is possible today because
 * `test-two` is still a Public Bot, and anyone holding the (public)
 * application id can invite it to their own server. Each such guild also eats
 * one of the ten slots the bot needs to create its own.
 *
 * Zero guilds is the normal first run and says nothing, so it prints nothing.
 */
export function inspectGuildList(opts: {
  guilds: PartialGuild[];
  expectedGuildId?: string;
  /**
   * Who we actually authenticated as, when we know. These warnings used to
   * name the application TWO-21 promised us regardless of which bot answered
   * GET /users/@me, so a token from a different application produced advice
   * pointing at a developer-portal page that had nothing to do with the bot in
   * front of us. Describe the bot we are holding, not the one we expected.
   */
  bot?: { id: string; username: string };
}): string[] {
  const { guilds, expectedGuildId, bot } = opts;
  if (guilds.length === 0) return [];

  const botName = bot?.username ?? STAGING_BOT_APPLICATION_NAME;
  const botId = bot?.id ?? STAGING_BOT_APPLICATION_ID;

  const describe = (g: PartialGuild) => `"${g.name}" (${g.id})`;
  const isOurs = (g: PartialGuild) =>
    g.id === expectedGuildId || (!expectedGuildId && g.name === STAGING_SERVER_NAME);
  const unexpected = guilds.filter((g) => !isOurs(g));

  const warnings = [
    `The ${botName} bot is in ${guilds.length} guild(s): ` +
      `${guilds.map(describe).join(', ')}. It only needs "${STAGING_SERVER_NAME}".`,
  ];

  if (unexpected.length) {
    // No point reprinting the whole list when every guild is a stray - the
    // line above already named them.
    const which =
      unexpected.length === guilds.length ? 'all of them' : unexpected.map(describe).join(', ');
    warnings.push(
      `${unexpected.length} of those ${unexpected.length === 1 ? 'is' : 'are'} not ours: ${which}. ` +
        `Someone added the staging bot to a server we did not ask for. ${botName}'s ` +
        `Public Bot setting lets anyone holding application ${botId} do that - ` +
        'check it is off, and remove the bot from those guilds. Each one costs a guild-creation slot.',
    );
  }
  if (guilds.length >= GUILD_CREATE_HEADROOM) {
    warnings.push(
      `${guilds.length} of ${GUILD_CREATE_LIMIT} guild-creation slots are used. At ` +
        `${GUILD_CREATE_LIMIT} this bot can never create a guild again, and a bot cannot hand ` +
        'ownership of one to a person, so there is no way back.',
    );
  }
  return warnings;
}

/**
 * Why this code no longer creates a guild, and what to do instead.
 *
 * On 2026-09-05, with the staging bot in zero guilds and every guard passing,
 * `POST /guilds` was run for real against `Owen QA Test`
 * (1469137636663758888). Discord answered:
 *
 *     HTTP 400  {"message":"Bots cannot use this endpoint","code":20001}
 *
 * Retried with a bare `{"name":"TWO Staging"}` body and on API v9: same error
 * both times. So it is the endpoint refusing bots, not our payload and not our
 * API version. Discord's documented "bots in fewer than ten guilds may create
 * one" no longer holds for this application, and no permission, intent or
 * portal setting changes it - a bot token simply cannot reach that endpoint.
 *
 * This is deliberately a function returning the message rather than a comment,
 * so the explanation reaches the person running the script instead of only the
 * person reading the source. It names the measurement, because the next person
 * to hit this will otherwise assume the token is wrong and go hunting for a
 * credential that is already correct.
 */
export function guildCreateIsUnavailable(guildCount: number): string {
  return (
    `No "${STAGING_SERVER_NAME}" found and the bot is in ${guildCount} guild(s), but this bot ` +
    'cannot create one: Discord answers POST /guilds with HTTP 400 ' +
    '{"message":"Bots cannot use this endpoint","code":20001}, measured 2026-09-05 with a bare ' +
    'payload and on API v9 as well. It is the endpoint, not the payload, and not a permission ' +
    'you can grant.\n' +
    '  A human must make the server instead - about a minute of clicking:\n' +
    `    1. In Discord, Add a Server > Create My Own, and name it "${STAGING_SERVER_NAME}".\n` +
    `    2. Open this link and pick that server:\n       ${stagingInviteUrl()}\n` +
    '    3. Right-click the server > Copy Server ID (needs Developer Mode on), and set\n' +
    '       DISCORD_STAGING_GUILD_ID to it. The id is not a secret.\n' +
    '    4. Re-run this script. It will adopt that server and fill in every channel and role.\n' +
    '  WHO can do step 2: this application has Public Bot OFF, so the invite link works only\n' +
    "  for the application's own owner in the developer portal. Anyone else opening it gets a\n" +
    '  Discord error, not a server picker. Either the portal owner does steps 1-2, or they turn\n' +
    '  Public Bot on first.\n' +
    '  Nothing was changed.'
  );
}

/**
 * Adopt an existing staging guild, or stop and tell a human exactly what to do.
 *
 * `explicitGuildId` is DISCORD_STAGING_GUILD_ID. When it is set a human has
 * already made the server by hand and invited the bot, and we only fill in the
 * inside. Since 2026-09-05 that is the ONLY route to a staging server: this
 * function never returns `create` any more, because the endpoint it depended
 * on refuses bots outright. See `guildCreateIsUnavailable`.
 */
export function chooseGuild(opts: {
  guilds: PartialGuild[];
  explicitGuildId?: string;
  bot?: { id: string; username: string };
}): GuildChoice {
  const { guilds, explicitGuildId, bot } = opts;
  const warnings = inspectGuildList({ guilds, expectedGuildId: explicitGuildId, bot });

  // The staging bot must not be a member of the live TWO server, whatever we
  // were about to do next. This used to be checked only against the guild we
  // were pointed at, which missed the case that actually happened: the bot was
  // in the live guild while we were creating a brand new staging one, so every
  // check passed and the decision line read "Safe to create one".
  //
  // It is not safe. A bot in a guild receives that guild's gateway events and
  // can act in it with whatever permissions the invite carried. Pointing the
  // staging suite - including staging-reset, which deletes - at a process that
  // is also sitting in production is the one outcome TWO-25 exists to prevent.
  // Membership is the fact that matters, so membership is what we refuse on.
  const liveMembership = guilds.find((g) => g.id === LIVE_GUILD_ID);
  if (liveMembership) {
    return {
      action: 'abort',
      warnings,
      reason:
        `The staging bot is a member of the LIVE TWO server ("${liveMembership.name}", ${LIVE_GUILD_ID}). ` +
        'Refusing to provision anything while that is true - a staging bot in production can read live ' +
        'member events and write to live channels.\n' +
        '  Remove the bot from that server in Discord first, then re-run. Nothing was changed.',
    };
  }

  if (explicitGuildId) {
    if (explicitGuildId === LIVE_GUILD_ID) {
      return {
        action: 'abort',
        warnings,
        reason:
          `DISCORD_STAGING_GUILD_ID is the LIVE TWO server (${LIVE_GUILD_ID}). ` +
          'Refusing to provision anything into it.',
      };
    }
    const found = guilds.find((g) => g.id === explicitGuildId);
    if (!found) {
      return {
        action: 'abort',
        warnings,
        reason:
          `DISCORD_STAGING_GUILD_ID is ${explicitGuildId} but the staging bot is not in that guild. ` +
          'If the founder created the server by hand, invite the bot to it first, then re-run.',
      };
    }
    return {
      action: 'reconcile',
      guildId: found.id,
      warnings,
      reason: `DISCORD_STAGING_GUILD_ID is set, so adopting "${found.name}" as-is and only filling in its contents.`,
    };
  }

  const matches = guilds.filter((g) => g.name === STAGING_SERVER_NAME);
  if (matches.length === 1) {
    return {
      action: 'reconcile',
      guildId: matches[0].id,
      warnings,
      reason: `Found exactly one "${STAGING_SERVER_NAME}" (${matches[0].id}). Reconciling it instead of creating a second.`,
    };
  }
  if (matches.length > 1) {
    return {
      action: 'abort',
      warnings,
      reason:
        `The staging bot is in ${matches.length} guilds called "${STAGING_SERVER_NAME}" ` +
        `(${matches.map((g) => g.id).join(', ')}). A previous run went wrong. ` +
        'Pick the one to keep, set DISCORD_STAGING_GUILD_ID to it, and delete the others by hand.',
    };
  }

  // From here the old code returned `create` and the script called POST
  // /guilds. That call does not work for this bot - see
  // `guildCreateIsUnavailable` - so the only honest answer is to stop and hand
  // a human the invite link. The two guild-count refusals below are kept
  // because they are still true and still more specific than the generic one:
  // a bot at the limit has a different problem to fix (strays eating slots)
  // than a bot at zero, and telling someone "invite me" when their real
  // problem is nine stray guilds would waste the round trip.
  if (guilds.length >= GUILD_CREATE_LIMIT) {
    return {
      action: 'abort',
      warnings,
      reason:
        `The ${STAGING_BOT_APPLICATION_NAME} bot is in ${guilds.length} guilds, at or past Discord's ` +
        `${GUILD_CREATE_LIMIT}-guild limit for POST /guilds. Discord will refuse to create another, so ` +
        'nothing was attempted.\n' +
        `  Guilds: ${guilds.map((g) => `"${g.name}" (${g.id})`).join(', ')}.\n` +
        `  Likely cause: ${STAGING_BOT_APPLICATION_NAME} is a Public Bot, so anyone holding application ` +
        `${STAGING_BOT_APPLICATION_ID} can add it to their own server and spend a slot. Turn Public Bot ` +
        'off in the developer portal, remove the bot from guilds it does not need, then re-run.',
    };
  }
  if (guilds.length >= GUILD_CREATE_HEADROOM) {
    return {
      action: 'abort',
      warnings,
      reason:
        `The ${STAGING_BOT_APPLICATION_NAME} bot is already in ${guilds.length} guilds and Discord blocks bot ` +
        `guild creation at ${GUILD_CREATE_LIMIT}. Refusing to create another with only ` +
        `${GUILD_CREATE_LIMIT - guilds.length} slot(s) left - the last one is unrecoverable.\n` +
        `  Guilds: ${guilds.map((g) => `"${g.name}" (${g.id})`).join(', ')}.\n` +
        `  Check ${STAGING_BOT_APPLICATION_NAME}'s Public Bot setting is off, remove the bot from guilds it ` +
        'does not need, or create the server by hand and set DISCORD_STAGING_GUILD_ID.',
    };
  }
  return {
    action: 'abort',
    warnings,
    reason: guildCreateIsUnavailable(guilds.length),
  };
}

/**
 * The POST /guilds body.
 *
 * NOTHING CALLS THIS ANY MORE. `POST /guilds` returns `code 20001`, "Bots
 * cannot use this endpoint", for our bot - see `guildCreateIsUnavailable`. It
 * is kept, and kept tested, for one reason: if Discord ever reopens the
 * endpoint, or a future staging bot is a user-authorised app that can reach
 * it, this is the payload we had already worked out. Deleting it would throw
 * that away to save nine lines.
 *
 * Channels are declared here so Discord does not invent its own `general` /
 * `General` pair alongside ours. Roles are deliberately NOT declared: the
 * create payload requires the first entry to be a hand-written `@everyone`
 * with a permission integer we would be guessing at, and creating the three
 * roles afterwards runs the exact same code path as reconciling a
 * human-made server. One path, tested once.
 */
export function guildCreatePayload(): {
  name: string;
  channels: Array<{ name: string; type: number }>;
} {
  return {
    name: STAGING_SERVER_NAME,
    channels: [
      ...STAGING_TEXT_CHANNELS.map((name) => ({ name, type: CHANNEL_TYPE_TEXT })),
      ...STAGING_VOICE_CHANNELS.map((name) => ({ name, type: CHANNEL_TYPE_VOICE })),
    ],
  };
}

export type ChannelPlan = {
  create: Array<{ name: string; type: number }>;
  present: string[];
  duplicates: string[];
  /** Channels in the guild that the spec does not mention. Never deleted. */
  extra: string[];
};

export function planChannels(existing: PartialChannel[]): ChannelPlan {
  const want = [
    ...STAGING_TEXT_CHANNELS.map((name) => ({ name: name as string, type: CHANNEL_TYPE_TEXT })),
    ...STAGING_VOICE_CHANNELS.map((name) => ({ name: name as string, type: CHANNEL_TYPE_VOICE })),
  ];
  const create: ChannelPlan['create'] = [];
  const present: string[] = [];
  const duplicates: string[] = [];

  for (const w of want) {
    const hits = existing.filter((c) => c.name === w.name && c.type === w.type);
    if (hits.length === 0) create.push(w);
    else {
      present.push(w.name);
      if (hits.length > 1) duplicates.push(w.name);
    }
  }

  const wanted = new Set(want.map((w) => `${w.type}:${w.name}`));
  const extra = existing
    .filter((c) => (c.type === CHANNEL_TYPE_TEXT || c.type === CHANNEL_TYPE_VOICE))
    .filter((c) => !wanted.has(`${c.type}:${c.name}`))
    .map((c) => c.name);

  return { create, present, duplicates, extra };
}

export type RolePlan = { create: string[]; present: string[]; duplicates: string[] };

export function planRoles(existing: PartialRole[]): RolePlan {
  const create: string[] = [];
  const present: string[] = [];
  const duplicates: string[] = [];
  for (const name of STAGING_ROLES) {
    const hits = existing.filter((r) => r.name === name);
    if (hits.length === 0) create.push(name);
    else {
      present.push(name);
      if (hits.length > 1) duplicates.push(name);
    }
  }
  return { create, present, duplicates };
}

export type Hierarchy = {
  /** True when the bot owns the guild, which makes every check below moot. */
  ownerBypass: boolean;
  botRoleName: string | null;
  botPosition: number | null;
  /** Spec roles the bot could not grant. Empty under ownerBypass. */
  blocked: Array<{ name: string; position: number }>;
  assignable: string[];
  missing: string[];
  /**
   * Positions to PATCH so the spec roles sit below the bot. Empty when there
   * is nothing to fix, and empty when we cannot fix it from code.
   */
  repositions: Array<{ id: string; name: string; position: number }>;
  /** Set when the hierarchy is wrong AND code cannot fix it. */
  humanFix: string | null;
};

/**
 * Can the bot actually hand out the three spec roles?
 *
 * Owner first, because it short-circuits everything: Discord skips permission
 * and hierarchy evaluation entirely for the guild owner, so a bot that created
 * its own staging guild can grant any role in it regardless of positions. If
 * we did not check ownership first we would report three loud FAILs on a
 * server that works perfectly.
 */
export function evaluateHierarchy(opts: {
  roles: PartialRole[];
  botId: string;
  ownerId: string | null;
}): Hierarchy {
  const { roles, botId, ownerId } = opts;
  const byName = new Map<string, PartialRole>();
  for (const r of roles) if (!byName.has(r.name)) byName.set(r.name, r);

  const missing = STAGING_ROLES.filter((n) => !byName.has(n)) as string[];
  const found = STAGING_ROLES.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
  const botRole = roles.find((r) => r.tags?.bot_id === botId) ?? null;

  if (ownerId && ownerId === botId) {
    return {
      ownerBypass: true,
      botRoleName: botRole?.name ?? null,
      botPosition: botRole?.position ?? null,
      blocked: [],
      assignable: found.map((r) => r.name),
      missing,
      repositions: [],
      humanFix: null,
    };
  }

  if (!botRole) {
    return {
      ownerBypass: false,
      botRoleName: null,
      botPosition: null,
      blocked: found.map((r) => ({ name: r.name, position: r.position })),
      assignable: [],
      missing,
      repositions: [],
      humanFix:
        'The bot has no managed role in this guild and does not own it, so it can grant nothing. ' +
        'Re-invite the bot with the scoped permission link.',
    };
  }

  const botPos = botRole.position;
  const blocked = found.filter((r) => r.position >= botPos).map((r) => ({ name: r.name, position: r.position }));
  const assignable = found.filter((r) => r.position < botPos).map((r) => r.name);

  // A bot may never move a role to or above its own position, so the only fix
  // available to code is pushing the offending roles DOWN. That needs at least
  // one free slot per role beneath the bot; otherwise a human drags the bot up.
  let repositions: Hierarchy['repositions'] = [];
  let humanFix: string | null = null;
  if (blocked.length) {
    if (botPos > blocked.length) {
      repositions = blocked.map((b, i) => ({
        id: byName.get(b.name)!.id,
        name: b.name,
        position: botPos - 1 - i,
      }));
    } else {
      humanFix =
        `The bot's role "${botRole.name}" is at position ${botPos}, too low to fit ` +
        `${blocked.length} role(s) beneath it. Drag "${botRole.name}" above ` +
        `${blocked.map((b) => `"${b.name}"`).join(', ')} in Server Settings > Roles.`;
    }
  }

  return {
    ownerBypass: false,
    botRoleName: botRole.name,
    botPosition: botPos,
    blocked,
    assignable,
    missing,
    repositions,
    humanFix,
  };
}

/** Permissions given to each created role. Members and game roles get none. */
export const ROLE_PERMISSIONS: Record<string, string> = {
  Moderator: String((1n << 13n) | (1n << 16n)), // Manage Messages, Read Message History
  Member: '0',
  'Game: Test': '0',
  'Game: Test 2': '0',
  'Color: Red': '0',
  'Color: Blue': '0',
};
