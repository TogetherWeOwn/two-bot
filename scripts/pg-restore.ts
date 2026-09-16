/**
 * Restore a backup into the database named by TWO_RESTORE_URL.
 *
 *   TWO_RESTORE_URL=postgres://.../two_scratch \
 *     node scripts/pg-restore.ts /var/backups/two-bot/two-funnel-<stamp>.ndjson.gz --force
 *
 * Flags:
 *   --force     required; this wipes the target
 *   --dry-run   read and validate the file, report what it holds, write nothing
 *
 * `RESTORE VERIFIED` on the last line, and exit 0, is the only success. It
 * means every table's row count matched the manifest the dump wrote. Anything
 * else: treat that backup as lost and try the previous one.
 *
 * --dry-run is the same check minus the write: it reads the whole file through
 * the same reader the real restore uses and prints `DRY RUN VERIFIED`. It does
 * not run migrations and does not open a transaction, so it is safe to point at
 * a database you care about. TWO_RESTORE_URL is optional for a dry run - with
 * it you also get the target's current row counts, without it you still get a
 * full check of the file:
 *
 *   node scripts/pg-restore.ts /var/backups/two-bot/two-funnel-<stamp>.ndjson.gz --dry-run
 *
 * That is how you answer "is last night's off-box backup good" from wherever
 * the copy landed, without standing up a scratch database first.
 *
 * ## Why TWO_RESTORE_URL and not TWO_DATABASE_URL
 *
 * Restoring truncates the target. The one mistake that must not be possible by
 * accident is aiming it at production because the variable happened to be in
 * the shell already. So the target is a different variable name, and you also
 * have to pass --force. Restoring to production is legitimate - you just have
 * to say so twice, on purpose. See docs/RUNBOOK.md.
 */
import { existsSync } from 'node:fs';
import { openDb, isPostgresSpec } from '../src/store/db.ts';
import { restore, inspect, DUMP_TABLES } from '../src/store/dump.ts';
import { migrate } from '../src/store/migrate.ts';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const file = argv.find((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');

if (!file) {
  console.error('restore: usage: node scripts/pg-restore.ts <backup.ndjson.gz> --force');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`restore: no such file: ${file}`);
  process.exit(1);
}
if (!dryRun && !flags.has('--force')) {
  console.error('restore: this wipes the target. Pass --force if that is what you mean.');
  process.exit(1);
}

const url = process.env.TWO_RESTORE_URL?.trim();

// A real restore must have a target, and it must be named in the variable that
// is not already in anyone's shell. A dry run has no target - it writes
// nothing - so it will report on one if you give it a good URL, and validate
// the file regardless if you do not. That is what lets you check an off-box
// backup from a laptop, which is where you will be standing when it matters.
const haveUrl = Boolean(url && isPostgresSpec(url));
if (!haveUrl && !dryRun) {
  console.error('restore: TWO_RESTORE_URL must be set to a Postgres URL.');
  console.error('restore: deliberately not TWO_DATABASE_URL. See docs/RUNBOOK.md.');
  process.exit(1);
}

if (dryRun) {
  // Nothing in this branch writes: no migrate(), no transaction, and the
  // database is opened read-only-in-practice and only if we were given one.
  // A dry run must not be able to become the outage it rehearses for.

  // This is the actual validation - it reads the whole file, and throws on a
  // bad version, a foreign table name, a missing end marker, or a row count
  // that disagrees with the manifest.
  let contents;
  try {
    contents = await inspect(file);
  } catch (err) {
    console.error(`restore: ${String(err)}`);
    console.error('DRY RUN FAILED');
    process.exit(1);
  }

  console.log(`restore: --dry-run of ${file}`);
  console.log(`restore: dump taken ${contents.manifest.createdAt}`);
  console.log(
    `restore: migrations in dump: ${contents.manifest.schemaMigrations.join(', ') || '(none)'}`,
  );

  // Read the target's current rows where we can, but do not create them. A
  // table that is not there yet is information, not an error: it tells the
  // operator the real restore will have migrations to apply first.
  const before: Record<string, string> = {};
  if (haveUrl) {
    console.log('restore: checking configured target');
    const probe = await openDb(url!, { skipMigrations: true, applicationName: 'two-bot-restore' });
    try {
      for (const t of DUMP_TABLES) {
        before[t] = await probe
          .prepare(`SELECT COUNT(*) AS n FROM ${t}`)
          .get<{ n: number }>()
          .then((r) => String(Number(r?.n ?? 0)))
          .catch(() => '(no such table - the restore would migrate first)');
      }
    } finally {
      await probe.close();
    }
  } else {
    console.log('restore: no TWO_RESTORE_URL - checking the file only.');
    for (const t of DUMP_TABLES) before[t] = '(not checked)';
  }

  let short = false;
  for (const t of contents.manifest.tables) {
    const held = contents.buffers.get(t.name)?.length ?? 0;
    if (held !== t.count) short = true;
    console.log(
      `  ${t.name.padEnd(17)} manifest ${String(t.count).padStart(7)}  in file ${String(held).padStart(7)}  ${
        held === t.count ? 'ok' : 'MISMATCH'
      }   target now ${before[t.name]}`,
    );
  }

  if (short) {
    console.error('\nDRY RUN FAILED - the file does not hold what its manifest claims.');
    process.exit(1);
  }
  console.log(`\nrestore: ${contents.rows} rows read and verified. Nothing was written.`);
  console.log('DRY RUN VERIFIED');
  process.exit(0);
}

const db = await openDb(url!, { skipMigrations: true, applicationName: 'two-bot-restore' });

try {

  // The scratch database may be empty, or a schema behind. Make it match the
  // code before pouring rows into it.
  await migrate(db);

  const report = await restore(db, file);

  console.log(`restore: dump taken ${report.manifest.createdAt}`);
  console.log(`restore: migrations in dump: ${report.manifest.schemaMigrations.join(', ') || '(none)'}`);
  for (const t of report.manifest.tables) {
    const got = report.restored[t.name];
    console.log(
      `  ${t.name.padEnd(17)} manifest ${String(t.count).padStart(7)}  restored ${String(got).padStart(7)}  ${
        got === t.count ? 'ok' : 'MISMATCH'
      }`,
    );
  }
  for (const [table, cols] of Object.entries(report.droppedColumns)) {
    console.warn(`restore: ${table}: columns in the dump the target does not have: ${cols.join(', ')}`);
  }

  if (!report.ok) {
    console.error('\nRESTORE FAILED - counts do not match. Treat this backup as lost.');
    process.exit(1);
  }
} catch (err) {
  console.error(`\nrestore: ${String(err)}`);
  console.error('RESTORE FAILED');
  process.exit(1);
} finally {
  await db.close();
}

console.log('\nRESTORE VERIFIED');
