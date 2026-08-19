/**
 * The TWO Staging server, written down as code.
 *
 * The server itself does not exist yet - the founder creates it under TWO-21 -
 * but its shape was fixed by the CEO on 2026-08-19, so everything here is
 * known ahead of the credential landing. That is the point of this file: the
 * fixtures, the reset script and the verifier were all built against these
 * names, not against a server someone had to log in and read.
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
export const STAGING_BOT_APPLICATION_NAME = 'Owen Staging';

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
      'Missing DISCORD_STAGING_GUILD_ID. The founder posts the staging guild id in ' +
        'the TWO-21 thread - it is not a secret. See docs/STAGING.md.',
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
