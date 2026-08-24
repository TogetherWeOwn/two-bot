/**
 * Apply pending migrations.
 *
 *   node scripts/migrate.ts --status    # what is applied, what is pending
 *   node scripts/migrate.ts             # apply everything pending
 *
 * Reads TWO_DATABASE_URL. Postgres only - the SQLite path bootstraps from
 * src/store/schema.sql and is on its way out (TOG-37).
 *
 * The bot also migrates at startup, so on a normal deploy this script is
 * belt-and-braces. It exists for the case that matters: applying a migration
 * *before* the new code rolls, and being able to look at the state of the
 * database without starting the bot.
 *
 * Safe to run while the bot is up. The runner takes an advisory lock, so if
 * the bot or the website starts mid-run the loser waits and then finds nothing
 * to do. See src/store/migrate.ts.
 */
import { openDb, isPostgresSpec } from '../src/store/db.ts';
import { loadMigrations, migrate } from '../src/store/migrate.ts';

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');

const url = process.env.TWO_DATABASE_URL?.trim();
if (!url) {
  console.error('migrate: TWO_DATABASE_URL is not set.');
  console.error('migrate: this script is Postgres-only. See docs/RUNBOOK.md.');
  process.exit(1);
}
if (!isPostgresSpec(url)) {
  console.error(`migrate: TWO_DATABASE_URL is not a Postgres URL (${url.split(':')[0]}:...).`);
  process.exit(1);
}

// skipMigrations, or opening the database would silently do the very thing we
// are here to report on.
const db = await openDb(url, { skipMigrations: true, applicationName: 'two-bot-migrate' });

try {
  const onDisk = loadMigrations();

  if (statusOnly) {
    // The table is absent on a database nothing has ever migrated. That is a
    // legitimate state to report, not an error.
    const applied = new Map<string, string | null>();
    const exists = await db
      .prepare(`SELECT to_regclass('schema_migrations') AS t`)
      .get<{ t: string | null }>();
    if (exists?.t) {
      for (const r of await db
        .prepare(`SELECT id, checksum FROM schema_migrations`)
        .all<{ id: string; checksum: string | null }>()) {
        applied.set(r.id, r.checksum);
      }
    }

    let pending = 0;
    let drifted = 0;
    for (const m of onDisk) {
      const seen = applied.get(m.id);
      if (seen === undefined) {
        console.log(`pending  ${m.id}`);
        pending++;
      } else if (seen !== null && seen !== m.checksum) {
        // Loud, because this is the one that quietly desynchronises two boxes.
        console.log(`CHANGED  ${m.id}  (recorded ${seen}, file ${m.checksum})`);
        drifted++;
      } else {
        console.log(`applied  ${m.id}`);
      }
    }

    // Recorded but not on disk: someone applied a migration from a branch, or
    // deleted a file that had already run. Either way it needs a human.
    for (const id of applied.keys()) {
      if (!onDisk.some((m) => m.id === id)) {
        console.log(`ORPHAN   ${id}  (in schema_migrations, not in migrations/)`);
        drifted++;
      }
    }

    console.log(`\n${onDisk.length} on disk, ${applied.size} applied, ${pending} pending.`);
    process.exitCode = drifted > 0 ? 1 : 0;
  } else {
    const applied = await migrate(db);
    if (applied.length === 0) {
      console.log('migrate: nothing to do, database is up to date.');
    } else {
      for (const id of applied) console.log(`applied  ${id}`);
      console.log(`\nmigrate: applied ${applied.length}.`);
    }
  }
} finally {
  await db.close();
}
