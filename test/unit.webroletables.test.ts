import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_TABLES } from '../src/store/webRoleCheck.ts';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

function migrationTables(): string[] {
  const tables = new Set<string>();
  for (const name of readdirSync(MIGRATIONS).filter((entry) => entry.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
    for (const match of sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
      tables.add(match[1]);
    }
  }
  // The migration runner owns this bookkeeping table rather than a numbered
  // SQL file, but the website role must still receive a named denial check.
  tables.add('schema_migrations');
  return [...tables].sort();
}

test('website-role named denial inventory matches every migration-created table', () => {
  assert.deepEqual([...BOT_TABLES].sort(), migrationTables());
});
