import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

/**
 * Open (and if needed create) the datastore. Safe to call repeatedly.
 * `path` of ':memory:' gives an ephemeral db, used by the tests.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(sql);
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
  ).run('0001_initial', new Date().toISOString());
  return db;
}
