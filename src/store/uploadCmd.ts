/**
 * How TWO_BACKUP_UPLOAD_CMD becomes an argv.
 *
 * Extracted from scripts/pg-backup.ts so the contract is testable without a
 * database, because getting it wrong is silent: the upload command runs, exits
 * non-zero for a reason nobody reads, and the off-box copy that recovery
 * depends on is simply not there.
 *
 * The contract, deliberately narrow:
 *
 *   - split on whitespace, so no argument may contain a space
 *   - the dump path is appended LAST
 *
 * That suits `cp -t DIR FILE`. It is backwards for `rclone copy SRC DST`,
 * `aws s3 cp SRC DST` and `scp SRC DST`, which would read the dump as the
 * destination. Point the variable at a one-line wrapper instead - see
 * deploy/two-backup-upload and docs/RUNBOOK.md, "Off-box destination".
 */

export type UploadInvocation = { cmd: string; args: string[] };

/**
 * Returns null when `raw` is unset or blank - the caller treats that as "no
 * off-box copy configured" and warns, rather than as an error.
 */
export function buildUploadArgv(raw: string | undefined, file: string): UploadInvocation | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const [cmd, ...args] = parts;
  if (!cmd) return null;

  return { cmd, args: [...args, file] };
}
