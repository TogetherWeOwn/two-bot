import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/migrate-sqlite-to-postgres.ts', import.meta.url), 'utf8');

test('SQLite-to-Postgres migration includes the durable self-role audit ledger', () => {
  assert.match(source, /OPTIONAL_TABLES[\s\S]*'self_role_audit'/);
  assert.match(source, /const TABLES = \[\.\.\.REQUIRED_TABLES, \.\.\.OPTIONAL_TABLES\]/);
});
