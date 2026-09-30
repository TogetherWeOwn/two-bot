/**
 * The backup covers every bot-owned table, by construction rather than by hope.
 *
 * TOG-9074: DUMP_TABLES claimed "everything the bot owns" but covered 22 of
 * 58 migration tables. Everything added after the TOG-37 baseline - leveling,
 * scorecard, guild settings, RSVP/LFG/feed, temp voice - was silently omitted,
 * and the restore TRUNCATE only touched dumped tables, so a restore mixed
 * source-time rows with target-time rows. This suite reads migrations/ and
 * refuses to pass when the two disagree, so the next table added without a
 * backup entry fails here instead of failing silently in production.
 *
 * No database needed: this parses SQL text, so it runs in CI without Postgres.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUMP_TABLES, SERIAL_TABLES } from '../src/store/dump.ts';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface TableDef {
  name: string;
  /** Tables this one REFERENCES (foreign keys). */
  references: string[];
  hasBigserial: boolean;
}

function parseMigrations(): TableDef[] {
  const out: TableDef[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // Split on each CREATE TABLE; a chunk runs to the next one or EOF.
    const chunks = sql.split(/(?=CREATE\s+TABLE\s+)/gi).slice(1);
    for (const chunk of chunks) {
      const head = chunk.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?/i);
      if (!head) continue;
      const name = head[1];
      const references = [...chunk.matchAll(/REFERENCES\s+"?([a-z_0-9]+)"?/gi)].map((m) => m[1]);
      out.push({ name, references, hasBigserial: /BIGSERIAL/i.test(chunk) });
    }
  }
  return out;
}

const migrated = parseMigrations();
const migratedNames = [...new Set(migrated.map((t) => t.name))];
const dumped = new Set<string>(DUMP_TABLES);

describe('dump coverage: every migrated table is dumped', () => {
  test('DUMP_TABLES holds exactly the migration tables, no more and no fewer', async () => {
    const missing = migratedNames.filter((n) => !dumped.has(n));
    const extra = [...dumped].filter((n) => !migratedNames.includes(n));
    assert.deepEqual(
      missing,
      [],
      `migrated tables missing from the backup (silently unwiped, unrestored): ${missing.join(', ')}`,
    );
    assert.deepEqual(
      extra,
      [],
      `dumped tables with no migration (restore would fail on a fresh target): ${extra.join(', ')}`,
    );
  });

  test('schema_migrations travels in the manifest, not in the dump', async () => {
    // A restore must never mark a half-migrated target as fully migrated.
    assert.ok(!dumped.has('schema_migrations'));
  });
});

describe('restore order: parents are inserted before children', () => {
  test('every referenced table appears earlier in DUMP_TABLES', async () => {
    const position = new Map<string, number>(DUMP_TABLES.map((n, i) => [n, i]));
    for (const table of migrated) {
      for (const parent of table.references) {
        assert.ok(
          position.has(parent),
          `${table.name} references ${parent}, which is not dumped - the restore INSERT would fail`,
        );
        assert.ok(
          position.get(parent)! < position.get(table.name)!,
          `${table.name} is dumped before its parent ${parent} - restore inserts in manifest order`,
        );
      }
    }
  });
});

describe('sequences: every BIGSERIAL table gets its setval', () => {
  test('SERIAL_TABLES matches the BIGSERIAL tables in migrations', async () => {
    const bigserial = migrated.filter((t) => t.hasBigserial).map((t) => t.name).sort();
    assert.deepEqual(
      [...SERIAL_TABLES].sort(),
      bigserial,
      'a BIGSERIAL table without setval collides on the first write after a restore',
    );
  });

  test('every sequence table is a dumped table', async () => {
    for (const name of SERIAL_TABLES) {
      assert.ok(dumped.has(name), `${name} has a sequence but is not dumped`);
    }
  });

  test('audit_kill_switch.id is app-assigned, not a sequence', async () => {
    const killSwitch = migrated.find((t) => t.name === 'audit_kill_switch');
    assert.ok(killSwitch && !killSwitch.hasBigserial);
    assert.ok(!(SERIAL_TABLES as readonly string[]).includes('audit_kill_switch'));
  });
});
