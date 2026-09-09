import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Db, RunResult, Statement } from '../src/store/driver.ts';
import { loadMigrations, migrate } from '../src/store/migrate.ts';

test('the applied leveling migration stays immutable and the XP ceiling is additive', () => {
  const migrations = loadMigrations();
  const leveling = migrations.find((migration) => migration.id === '0010_leveling');
  const ceiling = migrations.find((migration) => migration.id === '0011_leveling_xp_ceiling');

  assert.equal(leveling?.checksum, 'dce57869e8d97bad');
  assert.ok(ceiling, 'the safe-integer ceiling belongs in a new migration');
  assert.ok(migrations.indexOf(ceiling) > migrations.indexOf(leveling!));
});

test('self-role audit migration is immutable and recovery stays additive', () => {
  const migrations = loadMigrations();
  const audit = migrations.find((migration) => migration.id === '0015_self_role_audit');
  const recovery = migrations.find((migration) => migration.id === '0016_self_role_recovery');
  assert.equal(audit?.checksum, 'bc32090819445847');
  assert.ok(recovery, 'recovery columns and claims belong in the next-free migration');
  assert.ok(migrations.indexOf(recovery) > migrations.indexOf(audit!));
  assert.match(recovery.sql, /ALTER TABLE self_role_audit ADD COLUMN IF NOT EXISTS desired_role_ids/);
  assert.match(recovery.sql, /CREATE TABLE IF NOT EXISTS self_role_panel_claims/);
  assert.equal(migrations.filter((migration) => migration.id === '0015_self_role_audit').length, 1);
  assert.equal(migrations.some((migration) => migration.id === '0013_self_role_audit'), false);
  assert.equal(migrations.some((migration) => migration.id === '0010_self_role_audit'), false);
});

test('briefly shipped migration rewrites normalize before additive migrations apply', async () => {
  const checksums = new Map<string, string | null>([
    ['0010_leveling', '199003b7e199c4f4'],
    ['0015_self_role_audit', 'cb0a092fa96c904d'],
  ]);
  const applied: string[] = [];
  const db: Db = {
    kind: 'postgres',
    prepare(sql: string): Statement {
      return {
        async get<T>(): Promise<T | undefined> {
          return undefined;
        },
        async all<T>(): Promise<T[]> {
          if (sql.includes('SELECT id, checksum FROM schema_migrations')) {
            return [...checksums].map(([id, checksum]) => ({ id, checksum })) as T[];
          }
          return [];
        },
        async run(...params: unknown[]): Promise<RunResult> {
          if (sql.includes('UPDATE schema_migrations SET checksum')) {
            checksums.set(String(params[1]), String(params[0]));
          }
          if (sql.includes('INSERT INTO schema_migrations')) {
            checksums.set(String(params[0]), String(params[2]));
          }
          return { changes: 1 };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      if (sql.includes('ADD CONSTRAINT member_levels_xp_js_safe')) {
        applied.push('0011_leveling_xp_ceiling');
      }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async close(): Promise<void> {},
  };

  const migrated = await migrate(db);
  assert.equal(checksums.get('0010_leveling'), 'dce57869e8d97bad');
  assert.equal(checksums.get('0015_self_role_audit'), 'bc32090819445847');
  assert.ok(migrated.includes('0011_leveling_xp_ceiling'));
  assert.ok(migrated.includes('0016_self_role_recovery'));
  assert.deepEqual(applied, ['0011_leveling_xp_ceiling']);
});
