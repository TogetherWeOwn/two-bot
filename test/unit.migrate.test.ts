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
  const audit = migrations.find((migration) => migration.id === '0018_self_role_audit');
  const recovery = migrations.find((migration) => migration.id === '0019_self_role_recovery');
  const ordering = migrations.find((migration) => migration.id === '0020_self_role_ordering');
  const eventOrder = migrations.find((migration) => migration.id === '0021_self_role_event_order');
  const committedTarget = migrations.find((migration) => migration.id === '0022_self_role_committed_target');
  const committedTargetRepair = migrations.find((migration) => migration.id === '0023_self_role_committed_target_repair');
  assert.equal(audit?.checksum, 'bc32090819445847');
  assert.equal(committedTarget?.checksum, '847ce5a9328b8914');
  assert.ok(recovery, 'recovery columns and claims belong in the next-free migration');
  assert.ok(ordering, 'exclusive-panel ordering metadata belongs in a new additive migration');
  assert.ok(eventOrder, 'explicit event chronology belongs in a later additive migration');
  assert.ok(committedTarget, 'committed target state belongs in a later additive migration');
  assert.ok(committedTargetRepair, 'committed target correction belongs in a new repair migration');
  assert.ok(migrations.indexOf(recovery) > migrations.indexOf(audit!));
  assert.ok(migrations.indexOf(ordering) > migrations.indexOf(recovery));
  assert.ok(migrations.indexOf(eventOrder) > migrations.indexOf(ordering));
  assert.ok(migrations.indexOf(committedTarget) > migrations.indexOf(eventOrder));
  assert.ok(migrations.indexOf(committedTargetRepair) > migrations.indexOf(committedTarget));
  assert.match(recovery.sql, /ALTER TABLE self_role_audit ADD COLUMN IF NOT EXISTS desired_role_ids/);
  assert.match(recovery.sql, /CREATE TABLE IF NOT EXISTS self_role_panel_claims/);
  assert.match(ordering.sql, /ADD COLUMN IF NOT EXISTS latest_event_id/);
  assert.match(eventOrder.sql, /ADD COLUMN IF NOT EXISTS event_order/);
  assert.match(committedTarget.sql, /audit\.event_id = claims\.latest_event_id/);
  assert.match(committedTarget.sql, /audit\.option_key IS NOT DISTINCT FROM claims\.latest_option_key/);
  assert.match(committedTargetRepair.sql, /SET target_committed = EXISTS/);
  assert.match(committedTargetRepair.sql, /jsonb_array_length\(audit\.desired_role_ids::jsonb\) = 0 THEN NULL/);
  assert.match(committedTargetRepair.sql, /END IS NOT DISTINCT FROM claims\.latest_option_key/);
  assert.equal(migrations.filter((migration) => migration.id === '0018_self_role_audit').length, 1);
  assert.equal(migrations.some((migration) => migration.id === '0013_self_role_audit'), false);
  assert.equal(migrations.some((migration) => migration.id === '0010_self_role_audit'), false);
});

test('briefly shipped migration rewrites remain rollback-compatible while additive migrations apply', async () => {
  const checksums = new Map<string, string | null>([
    ['0010_leveling', '199003b7e199c4f4'],
    ['0018_self_role_audit', 'cb0a092fa96c904d'],
  ]);
  const applied: string[] = [];
  const db: Db = {
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
  assert.equal(
    checksums.get('0018_self_role_audit'),
    'cb0a092fa96c904d',
    'leaving the old checksum intact keeps the prior build rollback-capable',
  );
  assert.ok(migrated.includes('0011_leveling_xp_ceiling'));
  assert.ok(migrated.includes('0019_self_role_recovery'));
  assert.ok(migrated.includes('0020_self_role_ordering'));
  assert.ok(migrated.includes('0021_self_role_event_order'));
  assert.deepEqual(applied, ['0011_leveling_xp_ceiling']);
});

test('automation lease columns are repaired by an immutable migration after 0015', () => {
  const migrations = loadMigrations();
  const automations = migrations.find((migration) => migration.id === '0015_automations');
  const claims = migrations.find((migration) => migration.id === '0016_automation_claims');

  assert.ok(automations);
  assert.ok(claims, 'an already-applied 0015 must be repaired by a new migration');
  assert.ok(migrations.indexOf(claims) > migrations.indexOf(automations));
  assert.match(claims.sql, /ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS claim_token TEXT/);
  assert.match(claims.sql, /ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS claimed_at TEXT/);
  assert.match(claims.sql, /ALTER TABLE sticky_messages ADD COLUMN IF NOT EXISTS claim_token TEXT/);
  assert.match(claims.sql, /ALTER TABLE sticky_messages ADD COLUMN IF NOT EXISTS claimed_at TEXT/);
});

test('distinct-members index arrives as a new additive migration after 0037', () => {
  const migrations = loadMigrations();
  const latest = migrations.find((migration) => migration.id === '0037_temp_voice_owner_transition');
  const index = migrations.find((migration) => migration.id === '0038_events_type_member');

  assert.ok(latest);
  assert.ok(index, 'the missing covering index belongs in a new migration, not an edit');
  assert.ok(migrations.indexOf(index) > migrations.indexOf(latest));
  assert.match(index.sql, /CREATE INDEX IF NOT EXISTS idx_events_type_member ON events \(event_type, member_id\)/);
});
