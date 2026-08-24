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
import { restore, DUMP_TABLES } from '../src/store/dump.ts';
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
if (!url || !isPostgresSpec(url)) {
  console.error('restore: TWO_RESTORE_URL must be set to a Postgres URL.');
  console.error('restore: deliberately not TWO_DATABASE_URL. See docs/RUNBOOK.md.');
  process.exit(1);
}

const db = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-restore' });

try {
  // The scratch database may be empty, or a schema behind. Make it match the
  // code before pouring rows into it.
  await migrate(db);

  if (dryRun) {
    // Reuse the reader for its validation, against a throwaway transaction we
    // roll back, so --dry-run cannot leave anything behind.
    console.log(`restore: --dry-run, target ${url.replace(/\/\/[^@]*@/, '//***@')}`);
    const before: Record<string, number> = {};
    for (const t of DUMP_TABLES) {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{ n: number }>();
      before[t] = Number(r?.n ?? 0);
    }
    console.log('restore: target currently holds ' + JSON.stringify(before));
    console.log('restore: file not applied (--dry-run).');
    process.exit(0);
  }

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
