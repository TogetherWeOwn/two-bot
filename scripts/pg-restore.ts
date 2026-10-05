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
 * full check of the file. A missing target table (SQLSTATE 42P01 on the
 * probe COUNT, confirmed absent by the catalog visibility check) is
 * information; any other target-probe failure exits 1 with
 * `DRY RUN TARGET PROBE FAILED`, while still reporting
 * that the backup file was verified:
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
import { openDb, isPostgresSpec, type Db } from '../src/store/db.ts';
import { restore, inspect, DUMP_TABLES } from '../src/store/dump.ts';
import { migrate } from '../src/store/migrate.ts';

const usage = 'node scripts/pg-restore.ts <backup.ndjson.gz> (--force | --dry-run)';
function usageError(message: string): never {
  console.error(`restore: ${message}`);
  console.error(`restore: usage: ${usage}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = new Set<string>();
const files: string[] = [];
// Validate the whole command before inspecting a file or opening a target:
// a typo beside --force must never silently select a destructive restore.
for (const arg of argv) {
  if (arg.startsWith('-')) {
    if (!['--force', '--dry-run', '--help'].includes(arg)) {
      usageError(`unknown option: ${arg}`);
    }
    if (flags.has(arg)) usageError(`duplicate option: ${arg}`);
    flags.add(arg);
  } else {
    files.push(arg);
  }
}
if (flags.has('--help')) {
  if (argv.length !== 1) usageError('--help must be used alone.');
  console.log(`Usage: ${usage}`);
  process.exit(0);
}
if (files.length !== 1 || !files[0]) usageError('expected exactly one backup operand.');
if (flags.has('--force') && flags.has('--dry-run')) {
  usageError('cannot combine --force and --dry-run.');
}
const file = files[0];
const dryRun = flags.has('--dry-run');
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

// 42P01 can hide a schema-USAGE denial. Only diagnose absence if no
// same-named table-like relation exists anywhere in the database; otherwise
// fail conservatively (inaccessible or off-path), without promising a migration.
// Source: https://www.postgresql.org/docs/17/catalog-pg-class.html
async function classifyUndefinedTable(
  probe: Db,
  table: string,
  countErr: unknown,
): Promise<{ text: string; failed: boolean; detail: string }> {
  const countDetail = String(countErr);
  let relations: Array<{ schema: string }>;
  try {
    relations = await probe
      .prepare(
        `SELECT n.nspname AS schema
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = ? AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      )
      .all<{ schema: string }>(table);
  } catch (catalogErr) {
    return {
      text: '(target probe failed)',
      failed: true,
      detail: `${countDetail} (visibility check failed: ${String(catalogErr)})`,
    };
  }
  if (relations.length > 0) {
    const schemas = [...new Set(relations.map((row) => row.schema))].sort().join(', ');
    return {
      text: '(target probe failed)',
      failed: true,
      detail: `${countDetail} (same-named relation exists but is not visible through the target search_path: ${schemas})`,
    };
  }
  return { text: '(no such table - the restore would migrate first)', failed: false, detail: '' };
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
  //
  // Match --force's search_path, not a hardcoded public schema. Inaccessible
  // schemas can be skipped during resolution, so check the catalog before
  // treating 42P01 as absence. Other codes (including 42501) fail the probe.
  // https://www.postgresql.org/docs/17/ddl-schemas.html#DDL-SCHEMAS-PATH
  // https://www.postgresql.org/docs/17/errcodes-appendix.html
  const before: Record<string, string> = {};
  for (const t of DUMP_TABLES) before[t] = '(not checked)';
  let probeFailed = false;
  if (haveUrl) {
    console.log('restore: checking configured target');
    try {
      const probe = await openDb(url!, { skipMigrations: true, applicationName: 'two-bot-restore' });
      try {
        for (const t of DUMP_TABLES) {
          try {
            const r = await probe.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{ n: number }>();
            before[t] = String(Number(r?.n ?? 0));
          } catch (err) {
            if (typeof err === 'object' && err !== null && 'code' in err && err.code === '42P01') {
              const verdict = await classifyUndefinedTable(probe, t, err);
              before[t] = verdict.text;
              if (verdict.failed) {
                probeFailed = true;
                console.error(`restore: target probe failed for ${t}: ${verdict.detail}`);
              }
            } else {
              before[t] = '(target probe failed)';
              probeFailed = true;
              console.error(`restore: target probe failed for ${t}: ${String(err)}`);
            }
          }
        }
      } finally {
        await probe.close();
      }
    } catch (err) {
      probeFailed = true;
      console.error(`restore: target probe failed: ${String(err)}`);
    }
  } else {
    console.log('restore: no TWO_RESTORE_URL - checking the file only.');
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
  if (probeFailed) {
    console.error('DRY RUN TARGET PROBE FAILED - the backup file was verified; target counts could not be fully checked.');
    process.exit(1);
  }
  console.log('DRY RUN VERIFIED');
  process.exit(0);
}

// Validate the backup before opening or migrating the target (TOG-10566): a
// wrong-version or truncated archive must be refused before openDb/migrate
// can change target schema. restore() re-reads the file before its own
// destructive transaction; this check only orders the CLI's side effects.
try {
  await inspect(file);
} catch (err) {
  console.error(`restore: ${String(err)}`);
  console.error('RESTORE FAILED - the backup is invalid; the target was not opened or migrated.');
  process.exit(1);
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
