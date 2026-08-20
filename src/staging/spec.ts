/**
 * The TWO Staging server, written down as code.
 *
 * The server itself does not exist yet, but its shape was fixed by the CEO on
 * 2026-08-19, so everything here is known ahead of the credential landing.
 * That is the point of this file: the fixtures, the reset script, the verifier
 * and the provisioning script were all built against these names, not against
 * a server someone had to log in and read.
 *
 * `scripts/staging-provision.ts` now BUILDS the server from this file - the
 * bot creates its own guild - so these names are an instruction, not just an
 * expectation. If the founder made the server by hand instead, the same script
 * reconciles theirs against this spec.
 *
 * When the server does exist, `scripts/staging-verify.ts` checks reality
 * against this file and fails loudly on any difference. Do not "fix" a
 * mismatch by editing this file - the spec is the agreement. Change the
 * server, or get the spec changed first.
 *
 * NOTHING SECRET LIVES HERE. The token is an env var (see docs/SECRETS.md);
 * the guild id is not a secret but it is environment-specific, so it comes
 * from the environment too.
 */

/** The live TWO server. Named here only so we can refuse to touch it. */
export const LIVE_GUILD_ID = '326474832151838730';

export const STAGING_SERVER_NAME = 'TWO Staging';

/**
 * The staging application's real name. The 2026-08-19 spec called it
 * `Owen Staging` and had the founder creating it; TWO-21 established that it
 * already existed as `test-two`, made on 14 Aug, five days before the live
 * `Owen`. Nothing is being renamed - the id below is the identity, the name is
 * only what a human reads in the developer portal.
 */
export const STAGING_BOT_APPLICATION_NAME = 'test-two';

/**
 * Discord application ids. These are public identifiers, not secrets - they
 * appear in every invite URL. They are written down because "which bot is this
 * token for" is otherwise unanswerable without pasting the token somewhere.
 */
export const LIVE_BOT_APPLICATION_ID = '1539711683898118154';
export const STAGING_BOT_APPLICATION_ID = '1537629682449649724';

/**
 * A bot token's first dot-separated segment is the base64 of the application
 * id. Discord documents this; it is not a trick. Returns null for anything
 * that is not shaped like a bot token, because a caller must be able to tell
 * "wrong bot" apart from "unparseable".
 */
export function applicationIdFromToken(token: string): string | null {
  const seg = token.trim().split('.')[0];
  if (!seg) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(seg, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return /^\d{15,25}$/.test(decoded) ? decoded : null;
}

/**
 * Refuse a token that belongs to the LIVE bot.
 *
 * This is not hypothetical. On 2026-08-19 the secrets store bound this agent
 * the live bot's token under a generic name while the staging token was
 * absent. Had a staging script been handed that value, it would have created a
 * guild owned by the production bot - and `POST /guilds` is refused once a bot
 * is in ten, so the live bot's guild slots are not something to spend by
 * accident.
 *
 * Unrecognised ids only warn. A token reset changes the secret but never the
 * application id, so the ids above stay true across resets; but a third
 * staging app someone creates later should not hard-fail a correct setup.
 */
export function checkStagingToken(token: string): { ok: boolean; message: string } {
  const appId = applicationIdFromToken(token);
  if (appId === LIVE_BOT_APPLICATION_ID) {
    return {
      ok: false,
      message:
        `This token belongs to the LIVE bot (application ${LIVE_BOT_APPLICATION_ID}), not ` +
        `${STAGING_BOT_APPLICATION_NAME} (${STAGING_BOT_APPLICATION_ID}).\n` +
        '  Refusing to run. Nothing was contacted.\n' +
        '  DISCORD_STAGING_BOT_TOKEN has been filled from the wrong application - ' +
        'raise it on TWO-21 rather than editing it locally.',
    };
  }
  if (appId === STAGING_BOT_APPLICATION_ID) {
    return { ok: true, message: `token is ${STAGING_BOT_APPLICATION_NAME} (${appId})` };
  }
  if (appId === null) {
    return { ok: true, message: 'token shape not recognised - continuing, Discord will judge it' };
  }
  return { ok: true, message: `token is application ${appId}, which is neither the live nor the expected staging bot` };
}

/** Text channels the fixtures and the integration suite expect to find. */
export const STAGING_TEXT_CHANNELS = ['welcome', 'general', 'events', 'bot-log'] as const;

/**
 * A real voice channel is in the spec deliberately: `first_voice_session` can
 * only be asserted end to end against one. A mock cannot produce a genuine
 * voice state update.
 */
export const STAGING_VOICE_CHANNELS = ['Voice 1'] as const;

/**
 * The bot must sit ABOVE all three of these in the role list, or role
 * assignment fails silently - Discord returns 403 and discord.js swallows it
 * into a rejected promise nobody awaited. This is the single most common
 * staging failure and it produces no error in the log. `staging-verify.ts`
 * checks it first for that reason.
 *
 * Unless the bot OWNS the guild, which it does when it created it: an owner
 * bypasses hierarchy entirely. See `evaluateHierarchy` in ./provision.ts,
 * which is the only place that distinction is made.
 */
export const STAGING_ROLES = ['Moderator', 'Member', 'Game: Test'] as const;

/**
 * The scoped permission integer the bot is invited with. Not Administrator -
 * staging is where we prove the live bot needs no more than this.
 */
export const STAGING_PERMISSIONS = 268520512;

/** Decoded, so a mismatch reads as English instead of arithmetic. */
export const PERMISSION_BITS: ReadonlyArray<{ name: string; bit: bigint }> = [
  { name: 'Add Reactions', bit: 1n << 6n },
  { name: 'View Channels', bit: 1n << 10n },
  { name: 'Send Messages', bit: 1n << 11n },
  { name: 'Embed Links', bit: 1n << 14n },
  { name: 'Read Message History', bit: 1n << 16n },
  { name: 'Manage Roles', bit: 1n << 28n },
];

export function describePermissions(mask: bigint): { held: string[]; missing: string[] } {
  const held: string[] = [];
  const missing: string[] = [];
  for (const p of PERMISSION_BITS) (mask & p.bit ? held : missing).push(p.name);
  return { held, missing };
}

/**
 * Read the staging guild id. Deliberately a different variable name from the
 * live `DISCORD_GUILD_ID`: a staging run that picks up the live value by
 * accident would seed test members into the real funnel, and there is no undo
 * for that.
 */
export function stagingGuildId(): string {
  const id = process.env.DISCORD_STAGING_GUILD_ID;
  if (!id) {
    throw new Error(
      'Missing DISCORD_STAGING_GUILD_ID. No founder posts this any more: run ' +
        '`npm run staging:provision -- --apply` and the bot creates the server and ' +
        'prints its id. It is not a secret. See docs/STAGING.md.',
    );
  }
  if (id === LIVE_GUILD_ID) {
    throw new Error(
      `DISCORD_STAGING_GUILD_ID is set to the LIVE TWO server (${LIVE_GUILD_ID}). ` +
        'Refusing to continue.',
    );
  }
  return id;
}
