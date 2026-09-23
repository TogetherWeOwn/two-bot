/**
 * The way the end-to-end test account stops existing in the guild (TOG-3978).
 *
 * The owner's fifth condition is that this account is disposable. That is only
 * true if disposing of it is one command rather than a login, so this is that
 * command: remove the account from the staging guild, and record that the
 * credential must be rotated before anything uses it again.
 *
 * TWO HALVES, BOTH REQUIRED. Kicking without rotating leaves a working token
 * that can rejoin with an invite; rotating without kicking leaves the account
 * sitting in the member list with roles. Neither half on its own is a kill
 * switch, so `trip()` reports both and `KillSwitchResult.complete` is false
 * unless both landed.
 *
 * IT CANNOT TOUCH THE LIVE GUILD. The removal goes through the same
 * `MemberRemover` the raid-removal engine uses, which is bound to one guild at
 * construction - so the fence is on the guild id passed in here, checked
 * against `src/staging/spec.ts`, before any request is made. Live-guild use of
 * this harness needs a new owner decision (TOG-3978), and until there is one
 * this function refuses.
 *
 * ROTATION IS A FLAG, NOT AN ACTION. Nothing in this repository can rotate a
 * Discord credential - that is a human at a login screen, and the value lives
 * in the Paperclip vault. What this returns is the instruction plus the reason,
 * so the operator card says what happened rather than "something went wrong".
 */
import type { MemberRemover, KickOutcome } from '../discord/kick.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../staging/spec.ts';

export interface KillSwitchOptions {
  /** The guild to remove the account from. Must be the staging guild. */
  guildId: string;
  /** The test account's user id. Not a secret; it is visible to every member. */
  accountId: string;
  /** Why it is being tripped. Goes into the Discord audit-log reason and the result. */
  reason: string;
  /** Bound to `guildId` by its caller. The bot token does the removal, not the test account's. */
  remover: MemberRemover;
}

export interface KillSwitchResult {
  /** What Discord did with the removal. `already_gone` counts as success. */
  kick: KickOutcome;
  /** Always true when tripped: the credential is burned whether or not the kick landed. */
  rotationRequired: true;
  /** Both halves landed. False means an operator has to finish it by hand. */
  complete: boolean;
  reason: string;
  /** Non-secret, one line, safe to paste into a board comment. */
  summary: string;
}

/**
 * Remove the test account from staging and mark its credential for rotation.
 *
 * Throws - rather than returning an incomplete result - when asked to act on a
 * guild that is not staging. A refusal that looks like a result is a refusal
 * somebody will ignore.
 */
export async function tripKillSwitch(o: KillSwitchOptions): Promise<KillSwitchResult> {
  if (o.guildId === LIVE_GUILD_ID) {
    throw new Error(
      'e2e kill switch refused: that is the live guild. This harness is staging-only (TOG-3978).',
    );
  }
  if (o.guildId !== TWO_STAGING_GUILD_ID) {
    throw new Error(
      `e2e kill switch refused: guild ${o.guildId} is not the staging guild pinned in src/staging/spec.ts.`,
    );
  }

  const kicked = await o.remover.kick(o.accountId, `e2e harness kill switch: ${o.reason}`);
  // `already_gone` is the idempotent case - the account left, or a previous
  // trip finished. Treating it as failure would make a repeat trip look worse
  // than the first one, which is backwards.
  const removed = kicked.outcome === 'kicked' || kicked.outcome === 'already_gone';

  return {
    kick: kicked.outcome,
    rotationRequired: true,
    complete: removed,
    reason: o.reason,
    summary: removed
      ? `e2e account removed from staging (${kicked.outcome}); rotate the credential before the next run.`
      : `e2e account NOT removed (${kicked.outcome}: ${kicked.detail}); rotate the credential and remove the member by hand.`,
  };
}
