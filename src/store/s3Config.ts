/**
 * Reads the off-box destination out of the environment.
 *
 * Every failure here is a refusal with the variable named, never a default.
 * A backup uploader that guesses a bucket writes the night's dump somewhere
 * nobody looks and reports success - the failure mode this card exists to
 * close. Missing configuration must be loud at 04:17, not discovered during a
 * restore.
 *
 * Credential values live only in /etc/two-bot/backup.env (root, 0600), loaded
 * by two-bot-backup.service. They are never logged, never defaulted, and never
 * written to the board. See docs/RUNBOOK.md, "Off-box destination".
 */
import type { S3Target } from './s3Sign.ts';

export class ConfigError extends Error {}

/** The variables, in one place, so the runbook and the code cannot drift. */
export const REQUIRED_VARS = [
  'TWO_BACKUP_S3_ENDPOINT',
  'TWO_BACKUP_S3_BUCKET',
  'TWO_BACKUP_S3_ACCESS_KEY_ID',
  'TWO_BACKUP_S3_SECRET_ACCESS_KEY',
] as const;

export type Env = Record<string, string | undefined>;

/**
 * Region defaults to `auto`, which is what R2 wants and what any S3 provider
 * accepts as a literal region name in the credential scope. That is the one
 * default here: it is not a destination, so getting it wrong cannot misplace a
 * backup - it can only fail the signature, loudly.
 */
export function loadS3Target(env: Env): S3Target {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      `off-box upload is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
        'See docs/RUNBOOK.md, "Off-box destination".',
    );
  }

  const endpoint = env.TWO_BACKUP_S3_ENDPOINT!.trim();
  if (!/^https?:\/\//.test(endpoint)) {
    throw new ConfigError(`TWO_BACKUP_S3_ENDPOINT must start with https:// or http:// (got "${endpoint}").`);
  }
  // http:// to anything but a local test server would ship the funnel log, and
  // the credential signing it, in clear text across the internet.
  if (endpoint.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(endpoint)) {
    throw new ConfigError(
      `TWO_BACKUP_S3_ENDPOINT must be https:// for a remote host (got "${endpoint}"). ` +
        'Plain http would send the dump and its credentials in clear text.',
    );
  }

  const bucket = env.TWO_BACKUP_S3_BUCKET!.trim();
  // Path-style addressing puts the bucket in the URL path, so a stray slash
  // would silently retarget the write into a different bucket.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ConfigError(`TWO_BACKUP_S3_BUCKET is not a valid bucket name (got "${bucket}").`);
  }

  return {
    endpoint,
    region: env.TWO_BACKUP_S3_REGION?.trim() || 'auto',
    bucket,
    accessKeyId: env.TWO_BACKUP_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.TWO_BACKUP_S3_SECRET_ACCESS_KEY!.trim(),
    prefix: env.TWO_BACKUP_S3_PREFIX?.trim() || undefined,
  };
}
