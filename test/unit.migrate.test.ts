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

test('the briefly shipped constrained 0010 checksum is normalized before 0011 applies', async () => {
  const checksums = new Map<string, string | null>([
    ['0010_leveling', '199003b7e199c4f4'],
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
      if (sql.includes('ADD CONSTRAINT')) applied.push('0011_leveling_xp_ceiling');
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async close(): Promise<void> {},
  };

  const migrated = await migrate(db);
  assert.equal(checksums.get('0010_leveling'), 'dce57869e8d97bad');
  assert.ok(migrated.includes('0011_leveling_xp_ceiling'));
  assert.deepEqual(applied, ['0011_leveling_xp_ceiling']);
});
