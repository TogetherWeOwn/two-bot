import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/migrate-sqlite-to-postgres.ts', import.meta.url), 'utf8');

test('SQLite-to-Postgres migration includes durable self-role audit and target state', () => {
  assert.match(source, /OPTIONAL_TABLES[\s\S]*'self_role_audit'[\s\S]*'self_role_panel_claims'/);
  assert.match(source, /self_role_panel_claims:\s*\['guild_id', 'member_id', 'panel_id'\]/);
  assert.match(source, /const TABLES = \[\.\.\.REQUIRED_TABLES, \.\.\.OPTIONAL_TABLES\]/);
});
