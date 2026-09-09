/**
 * Migration runner.
 *
 * Deliberately boring: read `migrations/*.sql`, apply the ones not yet in
 * `schema_migrations`, one transaction each, in filename order.
 *
 * Two things that matter now that two processes share the database:
 *
 *  * A session-level advisory lock, so the bot and the website starting at the
 *    same moment cannot both try to apply 0001. The loser waits, then finds
 *    nothing to do.
 *  * A checksum per applied file. Editing an already-applied migration is the
 *    classic way to get two environments quietly out of sync; this turns that
 *    into a startup error instead.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './driver.ts';
import { log } from '../core/log.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/** Arbitrary but fixed. Anything else migrating this database must use it too. */
const ADVISORY_LOCK_KEY = 7620181;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

/**
 * Main briefly shipped a constrained rewrite of 0010 before its immutability
 * violation was caught. Accept only that exact known checksum, then normalize
 * it to the restored migration so 0011 can make the constraint additive.
 */
const COMPATIBLE_CHECKSUMS = new Map([
  ['0010_leveling:199003b7e199c4f4', 'dce57869e8d97bad'],
]);

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return {
        id: f.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });
}

/**
 * Apply every pending migration. Returns the ids actually applied, so a caller
 * (or a test) can assert that a second run is a no-op.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  if (db.kind !== 'postgres') {
    throw new Error('migrate() is Postgres-only; the SQLite path bootstraps from schema.sql');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum   TEXT
    )
  `);
  // The SQLite schema had no checksum column, so a database carried over from
  // the old bootstrap needs it added.
  await db.exec(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);

  const applied: string[] = [];

  await db.transaction(async (tx) => {
    // Held until this transaction ends. A concurrent migrator blocks here.
    await tx.prepare(`SELECT pg_advisory_xact_lock(?)`).run(ADVISORY_LOCK_KEY);

    const done = new Map<string, string | null>();
    for (const r of await tx
      .prepare(`SELECT id, checksum FROM schema_migrations`)
      .all<{ id: string; checksum: string | null }>()) {
      done.set(r.id, r.checksum);
    }

    for (const m of loadMigrations(dir)) {
      const seen = done.get(m.id);
      if (seen !== undefined) {
        // null = applied before checksums existed; adopt it rather than fail.
        if (seen === null) {
          await tx
            .prepare(`UPDATE schema_migrations SET checksum = ? WHERE id = ?`)
            .run(m.checksum, m.id);
        } else if (seen !== m.checksum) {
          const compatible = COMPATIBLE_CHECKSUMS.get(`${m.id}:${seen}`);
          if (compatible === m.checksum) {
            await tx
              .prepare(`UPDATE schema_migrations SET checksum = ? WHERE id = ?`)
              .run(m.checksum, m.id);
          } else {
            throw new Error(
              `Migration ${m.id} has changed since it was applied ` +
                `(recorded ${seen}, file ${m.checksum}). Migrations are immutable - ` +
                `add a new one instead. See migrations/README.md.`,
            );
          }
        }
        continue;
      }

      await tx.exec(m.sql);
      await tx
        .prepare(`INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)`)
        .run(m.id, new Date().toISOString(), m.checksum);
      applied.push(m.id);
      log.info('migration_applied', { id: m.id });
    }
  });

  return applied;
}
