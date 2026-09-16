import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationValue, migrationValuesMatch } from '../scripts/migration-values.ts';

test('SQLite boolean columns accept only canonical integer booleans', () => {
  const columns = [
    ['members', 'is_bot'],
    ['moderation_lockdowns', 'prior_exists'],
  ] as const;

  for (const [table, column] of columns) {
    assert.equal(migrationValuesMatch(table, column, 0, false), true);
    assert.equal(migrationValuesMatch(table, column, 1, true), true);
    assert.equal(migrationValuesMatch(table, column, 0, true), false);
    assert.equal(migrationValuesMatch(table, column, 1, false), false);

    for (const invalid of ['true', 'false', '1', '0', 2, -1, null]) {
      assert.equal(
        migrationValuesMatch(table, column, invalid, Boolean(invalid)),
        false,
        `accepted non-canonical SQLite value ${String(invalid)} for ${table}.${column}`,
      );
    }
  }
});

test('SQLite automation booleans are converted before binding to Postgres', () => {
  const columns = [
    ['automation_commands', 'enabled'],
    ['scheduled_messages', 'enabled'],
    ['sticky_messages', 'enabled'],
  ] as const;

  for (const [table, column] of columns) {
    assert.equal(migrationValue(table, column, 0), false);
    assert.equal(migrationValue(table, column, 1), true);
    assert.equal(migrationValue(table, column, null), null);
  }
});

test('other migrated values still require strict equality', () => {
  assert.equal(migrationValuesMatch('tickets', 'message_count', 1, 1), true);
  assert.equal(migrationValuesMatch('tickets', 'message_count', '1', 1), false);
});
