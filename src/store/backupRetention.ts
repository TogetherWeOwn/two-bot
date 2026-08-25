/**
 * How many backups survive the nightly prune, and which ones.
 *
 * Extracted from `scripts/pg-backup.ts` for the same reason `uploadCmd.ts` was:
 * the failure mode is silent, total and destructive, so it needs a test that
 * runs in CI without a database.
 *
 * The bug this exists to prevent: `Number('')` is `0` and `Number('fourteen')`
 * is `NaN`, and `Array.prototype.slice()` treats *both* as `0`. So a typo in
 * `TWO_BACKUP_KEEP` in the unit file did not mean "keep the default" or even
 * "keep none" - it meant `slice(0)`, every file in the list, deleted, including
 * the backup written thirty seconds earlier. A backup system whose response to
 * a malformed setting is to delete all the backups is worse than not having
 * one, because the failure is invisible until the day you need a restore.
 */

/** Backups kept when TWO_BACKUP_KEEP is not set at all. Two weeks of nights. */
export const DEFAULT_KEEP = 14;

export class RetentionError extends Error {}

/**
 * Parse `TWO_BACKUP_KEEP`.
 *
 * Unset, or set to whitespace, means the default - systemd cannot always tell
 * "unset" from "empty", and defaulting there is safe because it errs towards
 * keeping files. Anything else must be a positive whole number, and if it is
 * not we throw rather than guess: there is no interpretation of `keep=0` or
 * `keep=NaN` that a person typing it into a unit file actually wanted, and
 * every interpretation the language offers deletes everything.
 */
export function parseKeep(raw: string | undefined): number {
  const s = raw?.trim();
  if (s === undefined || s === '') return DEFAULT_KEEP;
  if (!/^\d+$/.test(s) || Number(s) < 1) {
    throw new RetentionError(
      `TWO_BACKUP_KEEP=${JSON.stringify(raw)} is not a positive whole number`,
    );
  }
  return Number(s);
}

/**
 * Given backup filenames newest-first, return the ones to delete.
 *
 * Separate from the parse so the arithmetic is pinned independently: `keep`
 * arriving here as anything other than a positive integer is a programming
 * error, and is refused rather than silently selecting the whole list.
 */
export function toPrune<T>(newestFirst: readonly T[], keep: number): T[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RetentionError(`refusing to prune with keep=${String(keep)}`);
  }
  return newestFirst.slice(keep);
}
