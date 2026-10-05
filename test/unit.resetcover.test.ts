/**
 * Every mutable migration table must be emptied between fixtures.
 * Read the helper rather than importing it: its imports require a database URL,
 * while this ratchet needs only source text and must never open a connection.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const migrations = new URL('../migrations/', import.meta.url);
const migrationSql = readdirSync(migrations)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(new URL(file, migrations), 'utf8'))
  .join('\n');
const helperSource = readFileSync(new URL('./helpers/testDb.ts', import.meta.url), 'utf8');

// Migration seeds, not fixture data: rank_counts left-joins rank_ladder so all
// five ranks remain visible. These are the helper's only documented exclusions.
const SEED_TABLES = ['rank_ladder', 'web_contract_meta'];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:\/\/|--)[^\n]*/g, '');
}

function migrationTables(sql: string): string[] {
  const chunks = withoutComments(sql).split(/\bCREATE\s+TABLE\s+/gi).slice(1);
  return [...new Set(chunks.map((chunk) => {
    const head = chunk.match(/^(?:IF\s+NOT\s+EXISTS\s+)?(?:"([a-z_0-9]+)"|([a-z_0-9]+))\s*\(/i);
    assert.ok(head, `unsupported CREATE TABLE declaration: ${chunk.slice(0, 100)}`);
    return head[1] ?? head[2];
  }))];
}

function resetTables(source: string): string[] {
  const clean = withoutComments(source);
  const declarations = [...clean.matchAll(/\bconst\s+TABLES\s*=\s*\[([\s\S]*?)\]\s*;/g)];
  assert.equal(declarations.length, 1, 'expected one literal TABLES reset list in testDb.ts');
  const list = declarations[0][1];
  assert.match(list, /^\s*(?:'[a-z_0-9]+'\s*,\s*)+$/, 'reset list must contain only comma-terminated table literals');
  // Pin the actual reset wiring, not just a similarly named unused array. A
  // refactor must update this source reader explicitly rather than bypass parity.
  assert.match(
    clean,
    /async\s+reset\(\)\s*\{\s*await\s+db\.exec\(`TRUNCATE \$\{TABLES\.join\(', '\)\} RESTART IDENTITY CASCADE`\);\s*\}/,
    'reset() must truncate TABLES with the existing identity/cascade behavior',
  );
  return [...list.matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]);
}

function assertResetCoverage(migrated: string[], reset: string[]): void {
  const mutable = migrated.filter((name) => !SEED_TABLES.includes(name));
  const missing = mutable.filter((name) => !reset.includes(name));
  const extra = reset.filter((name) => !mutable.includes(name));
  assert.deepEqual(missing, [], `mutable migrated tables missing from reset: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `reset tables with no mutable migration: ${extra.join(', ')}`);
  assert.equal(new Set(reset).size, reset.length, 'duplicate reset table entries');
}

const migrated = migrationTables(migrationSql);
const reset = resetTables(helperSource);

describe('test reset coverage: every mutable migrated table is truncated', () => {
  test('the actual reset list matches migrations with only the two seed exclusions', () => {
    assert.ok(migrated.length > 0, 'migration parser must discover tables');
    for (const seed of SEED_TABLES) {
      assert.ok(migrated.includes(seed), `${seed} exclusion must name a migrated seed table`);
      assert.ok(!reset.includes(seed), `${seed} seed rows must survive reset`);
    }
    assertResetCoverage(migrated, reset);
  });

  test('a synthetic newly migrated mutable table fails with its name', () => {
    const changed = migrationTables(`${migrationSql}\nCREATE TABLE reset_ratchet_new (id BIGINT);`);
    assert.throws(() => assertResetCoverage(changed, reset), /missing from reset: reset_ratchet_new/);
  });

  test('omitting an existing helper entry fails with its name', () => {
    const changed = resetTables(helperSource.replace("  'events',\n", ''));
    assert.ok(!changed.includes('events'), 'mutation must remove the real reset entry');
    assert.throws(() => assertResetCoverage(migrated, changed), /missing from reset: events/);
  });

  test('a non-existent extra helper entry fails with its name', () => {
    const changed = resetTables(helperSource.replace("  'events',", "  'reset_ratchet_extra',\n  'events',"));
    assert.throws(() => assertResetCoverage(migrated, changed), /no mutable migration: reset_ratchet_extra/);
  });

  test('adding either excluded seed to reset is rejected', () => {
    for (const seed of SEED_TABLES) {
      assert.throws(() => assertResetCoverage(migrated, [...reset, seed]), new RegExp(`no mutable migration: ${seed}`));
    }
  });

  test('migration parsing handles quoted, conditional, multiline and repeated declarations', () => {
    assert.deepEqual(migrationTables(`
      -- CREATE TABLE ignored_line (id BIGINT);
      /* CREATE TABLE ignored_block (id BIGINT); */
      create\n table if not exists "fixture_table" (id BIGINT);
      CREATE TABLE fixture_table (id BIGINT);
      CREATE TABLE other_table (id BIGINT);
    `), ['fixture_table', 'other_table']);
    assert.throws(() => migrationTables('CREATE TABLE public.new_table (id BIGINT);'), /unsupported CREATE TABLE declaration/);
  });

  test('source-reader assumptions fail closed instead of silently ignoring reset changes', () => {
    assert.throws(() => resetTables(helperSource.replace("  'events',", "  ...OTHER_TABLES,")), /table literals/);
    assert.throws(() => resetTables(helperSource.replace("TABLES.join(', ')", "OTHER_TABLES.join(', ')")), /reset\(\) must truncate TABLES/);
    assert.throws(() => assertResetCoverage(migrated, [...reset, reset[0]]), /duplicate reset table entries/);
  });
});
