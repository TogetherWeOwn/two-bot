/**
 * Take a consistent snapshot of the live database, then prove it is readable.
 *
 *   node scripts/snapshot.ts <source.db> <dest.db>
 *
 * VACUUM INTO is the supported way to copy a WAL database that is being
 * written to. `cp` would give a torn file, and we would not find out until we
 * needed it.
 */
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: node scripts/snapshot.ts <source.db> <dest.db>');
  process.exit(2);
}

rmSync(dest, { force: true }); // VACUUM INTO refuses to overwrite

const db = new DatabaseSync(src, { readOnly: true });
try {
  db.prepare('VACUUM INTO ?').run(dest);
} finally {
  db.close();
}

// Verify: a backup nobody has opened is a guess, not a backup.
const check = new DatabaseSync(dest, { readOnly: true });
try {
  const events = (check.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const members = (check.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n;
  const integrity = check.prepare('PRAGMA integrity_check').get() as Record<string, string>;
  const verdict = Object.values(integrity)[0];
  if (verdict !== 'ok') throw new Error(`integrity_check failed: ${verdict}`);
  console.log(`snapshot: ok - ${events} events, ${members} members -> ${dest}`);
} finally {
  check.close();
}
