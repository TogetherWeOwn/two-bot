/**
 * Nightly backup of the funnel log.
 *
 *   node scripts/pg-backup.ts
 *
 * Reads TWO_DATABASE_URL, writes `two-funnel-<stamp>.ndjson.gz` into
 * TWO_BACKUP_DIR (default ./backups), keeps the newest TWO_BACKUP_KEEP files
 * (default 14; must be a positive whole number, and the run aborts rather than
 * guessing if it is set to anything else), then
 * runs TWO_BACKUP_UPLOAD_CMD with the file path appended as the last argument.
 * That argv shape is src/store/uploadCmd.ts - read it before writing the
 * variable, because tools whose last positional is the DESTINATION (rclone,
 * aws s3 cp, scp) need a wrapper. deploy/two-backup-upload is that wrapper.
 *
 * Run by two-bot-backup.timer at 04:17 UTC. Safe while the bot is up: the dump
 * is one REPEATABLE READ snapshot. See src/store/dump.ts and docs/RUNBOOK.md.
 *
 * Removes an empty-event dump and exits non-zero before retention or upload.
 * A backup that quietly reports zero events every night for six months is
 * worse than no backup at all, because you believe you have one - so make
 * systemd show it as failed.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, isPostgresSpec } from '../src/store/db.ts';
import { dump } from '../src/store/dump.ts';
import { buildUploadArgv } from '../src/store/uploadCmd.ts';
import { parseKeep, toPrune } from '../src/store/backupRetention.ts';

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url || !isPostgresSpec(url)) {
  console.error('backup: TWO_DATABASE_URL must be set to a Postgres URL.');
  process.exit(1);
}

const dest = process.env.TWO_BACKUP_DIR || './backups';
const uploadCmd = process.env.TWO_BACKUP_UPLOAD_CMD?.trim();

// Checked before the dump, not before the prune: a setting that would delete
// every backup should stop the run while it is still a no-op, rather than
// after we have written a file for it to eat. See src/store/backupRetention.ts.
let keep: number;
try {
  keep = parseKeep(process.env.TWO_BACKUP_KEEP);
} catch (err) {
  console.error(`backup: ${err instanceof Error ? err.message : String(err)}.`);
  console.error('        Refusing to run: every reading of that value prunes all backups.');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const out = join(dest, `two-funnel-${stamp}.ndjson.gz`);

const db = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-backup' });

let empty = false;
try {
  const manifest = await dump(db, out);

  for (const t of manifest.tables) console.log(`  ${t.name.padEnd(17)} ${t.count}`);
  const size = statSync(out).size;
  console.log(`backup: wrote ${out} (${(size / 1024).toFixed(1)} KiB)`);

  const events = manifest.tables.find((t) => t.name === 'events')?.count ?? 0;
  if (events === 0) {
    console.error('backup: the event log is empty. Refusing to call this a good backup.');
    // Rejected dumps must not displace recovery history or look like a valid
    // newest backup. If removal fails, abort here rather than prune or upload.
    unlinkSync(out);
    empty = true;
  }
} finally {
  await db.close();
}
if (empty) process.exit(1);

// Retention: newest `keep` files survive. Done before the upload so a failing
// upload does not also stop the disk being tidied.
const mine = readdirSync(dest)
  .filter((f) => /^two-funnel-.*\.ndjson\.gz$/.test(f))
  .map((f) => ({ f, t: statSync(join(dest, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const old of toPrune(mine, keep)) {
  console.log(`backup: pruning ${old.f}`);
  unlinkSync(join(dest, old.f));
}

const upload = buildUploadArgv(uploadCmd, out);
if (upload) {
  const { cmd, args: uploadArgs } = upload;
  try {
    execFileSync(cmd, uploadArgs, { stdio: 'inherit' });
    console.log(`backup: uploaded via ${cmd}`);
  } catch (err) {
    // The local copy exists; the off-box copy does not. That is a real
    // failure - say so and exit non-zero.
    console.error(`backup: upload failed: ${String(err)}`);
    process.exit(1);
  }
} else {
  console.warn(
    'backup: TWO_BACKUP_UPLOAD_CMD is not set - this backup is on the same disk\n' +
      '        as the database. That survives corruption and mistakes, not the\n' +
      '        loss of the machine. See docs/RUNBOOK.md.',
  );
}

console.log('backup: done');
