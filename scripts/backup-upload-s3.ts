/**
 * Copies one nightly dump off the box to S3-compatible object storage.
 *
 *   node scripts/backup-upload-s3.ts /var/backups/two-bot/two-funnel-<stamp>.ndjson.gz
 *
 * This is what TWO_BACKUP_UPLOAD_CMD points at, via the deploy/two-backup-upload
 * wrapper. It takes the dump path as its single argument - which is exactly the
 * argv shape src/store/uploadCmd.ts produces for a bare wrapper word - and
 * PUTs it to <bucket>/<prefix><filename>.
 *
 * Why not rclone or `aws s3 cp`: neither is installed on the host and
 * scripts/bootstrap-host.sh does not install them. See src/store/s3Sign.ts for
 * the full reasoning; the short version is that this repo already refused
 * `pg_dump` on exactly that ground.
 *
 * Exits non-zero on any failure, because scripts/pg-backup.ts treats a non-zero
 * upload as a failed backup and lets systemd surface it. A silent success here
 * is the one outcome worse than a red timer.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { loadS3Target, ConfigError } from '../src/store/s3Config.ts';
import { objectKey, signPut } from '../src/store/s3Sign.ts';

const HTTP_TIMEOUT_MS = Number(process.env.TWO_BACKUP_S3_TIMEOUT_MS || 300_000);

function fail(message: string): never {
  console.error(`backup-upload-s3: ${message}`);
  process.exit(1);
}

if (process.argv.includes('--help')) {
  console.log('usage: node scripts/backup-upload-s3.ts <dump-path>');
  console.log('');
  console.log('Copy one nightly dump off the box to S3-compatible object storage.');
  console.log('Needs TWO_BACKUP_S3_ENDPOINT, TWO_BACKUP_S3_BUCKET, TWO_BACKUP_S3_ACCESS_KEY_ID,');
  console.log('TWO_BACKUP_S3_SECRET_ACCESS_KEY (see docs/RUNBOOK.md, "Off-box destination").');
  console.log('--help reads and uploads nothing.');
  process.exit(0);
}

const [, , dumpPath, ...rest] = process.argv;

if (!dumpPath || rest.length > 0) {
  fail(`expected exactly one argument (the dump path), got ${dumpPath ? rest.length + 1 : 0}`);
}

let size: number;
try {
  const st = statSync(dumpPath);
  if (!st.isFile()) fail(`not a regular file: ${dumpPath}`);
  size = st.size;
} catch (err) {
  fail(`cannot read ${dumpPath}: ${err instanceof Error ? err.message : String(err)}`);
}

// An empty dump would upload happily and restore to nothing. pg-backup.ts
// already refuses an empty event log; this is the same guard at the boundary.
if (size === 0) fail(`refusing to upload an empty file: ${dumpPath}`);

let target;
try {
  target = loadS3Target(process.env);
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  throw err;
}

const key = objectKey(target.prefix, basename(dumpPath));
const body = readFileSync(dumpPath);
const { url, headers } = signPut(target, key, body, new Date());

// Log the destination but never the credential: this goes to the journal.
console.log(`backup-upload-s3: PUT ${target.bucket}/${key} (${size} bytes)`);

const res = await fetch(url, {
  method: 'PUT',
  headers,
  body: new Uint8Array(body),
  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
}).catch((err: unknown) => {
  fail(`PUT failed: ${err instanceof Error ? err.message : String(err)}`);
});

if (!res.ok) {
  // S3 reports permission and bucket errors in an XML body. Include it - the
  // status alone does not distinguish a wrong key from a wrong bucket.
  const detail = await res.text().catch(() => '');
  fail(`PUT ${res.status} ${res.statusText}${detail ? `: ${detail.trim().slice(0, 500)}` : ''}`);
}

const etag = res.headers.get('etag') ?? '(none)';
console.log(`backup-upload-s3: stored ${target.bucket}/${key} etag=${etag}`);
