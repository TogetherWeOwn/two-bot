import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMigrations } from '../src/store/migrate.ts';

test('the applied leveling migration stays immutable and the XP ceiling is additive', () => {
  const migrations = loadMigrations();
  const leveling = migrations.find((migration) => migration.id === '0010_leveling');
  const ceiling = migrations.find((migration) => migration.id === '0011_leveling_xp_ceiling');

  assert.equal(leveling?.checksum, 'dce57869e8d97bad');
  assert.ok(ceiling, 'the safe-integer ceiling belongs in a new migration');
  assert.ok(migrations.indexOf(ceiling) > migrations.indexOf(leveling!));
});
