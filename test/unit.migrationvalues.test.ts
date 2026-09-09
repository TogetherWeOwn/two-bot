import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationValuesMatch } from '../scripts/migration-values.ts';

test('SQLite members.is_bot accepts only canonical integer booleans', () => {
  assert.equal(migrationValuesMatch('members', 'is_bot', 0, false), true);
  assert.equal(migrationValuesMatch('members', 'is_bot', 1, true), true);
  assert.equal(migrationValuesMatch('members', 'is_bot', 0, true), false);
  assert.equal(migrationValuesMatch('members', 'is_bot', 1, false), false);

  for (const invalid of ['true', 'false', '1', '0', 2, -1, null]) {
    assert.equal(
      migrationValuesMatch('members', 'is_bot', invalid, Boolean(invalid)),
      false,
      `accepted non-canonical SQLite value ${String(invalid)}`,
    );
  }
});

test('other migrated values still require strict equality', () => {
  assert.equal(migrationValuesMatch('tickets', 'message_count', 1, 1), true);
  assert.equal(migrationValuesMatch('tickets', 'message_count', '1', 1), false);
});
