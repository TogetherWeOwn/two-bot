/**
 * TOG-9142: leveling importManifest thin coverage, by execution without a database.
 *
 * `src/leveling/importManifest.ts` (501 lines) had 2 refs and its only direct
 * coverage was the DB-backed CLI acceptance in
 * test/e2e.levelimportmanifest.test.ts (checksum moves, lowering skip,
 * --allow-lower, idempotency, dupes, inventory subcommand, --manifest file,
 * malformed CLI exit) plus one parse call in test/unit.levelrewardimport.test.ts.
 * Uncovered until now: every other parse/validate refusal, sha256/digest
 * helpers, the null-row inventory, the planMee6Import classify paths
 * (empty, triple-dupe, max-wins ordering, unchanged, ceiling edges), the
 * dry-run manifest shape, and the skippedByReason tally.
 *
 * Hermetic by construction: parse/sha tests are pure, and plan/run tests go
 * through an in-memory fake Db (canned aggregates, zero writes). Runs with a
 * bare `node --test`, no TWO_TEST_DATABASE_URL, no token, no network.
 *
 * Not a duplicate of TOG-8313: that card is an exploratory CLI sweep over
 * `scripts/levels-import-mee6.ts` with seeded data (report + one child card
 * per bug). This card pins the library's deterministic contract so the sweep
 * has something stable to explore against.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_VERSION,
  Mee6ExportError,
  SKIP_REASONS,
  digestBuffer,
  digestFile,
  inventory,
  parseMee6Export,
  planMee6Import,
  runMee6Import,
  sha256,
} from '../src/leveling/importManifest.ts';
import { MAX_STORED_XP } from '../src/leveling/service.ts';
import type { Db, Statement } from '../src/store/driver.ts';

before(() => {
  // Pin the hermetic guarantee: this suite must stay green with no database.
  delete process.env.TWO_TEST_DATABASE_URL;
});

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';
const D = '100000000000000004';

/** A row the export accepts: id, xp, and an optional curve-consistent level. */
function players(rows: unknown[]): string {
  return JSON.stringify(Array.isArray(rows) ? rows : { players: rows });
}

function throwsExport(text: string): Mee6ExportError {
  let error: unknown;
  try {
    parseMee6Export(text);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Mee6ExportError, `expected Mee6ExportError for ${text.slice(0, 80)}`);
  return error;
}

// --- accepted shapes ---------------------------------------------------------

test('a bare array and a players envelope both parse, in file order', () => {
  const rows = [
    { id: A, xp: 100 },
    { id: B, xp: 250 },
  ];
  for (const text of [JSON.stringify(rows), JSON.stringify({ players: rows })]) {
    const parsed = parseMee6Export(text);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.memberId, A);
    assert.equal(parsed[0]!.xp, 100);
    assert.equal(parsed[1]!.memberId, B);
    assert.equal(parsed[1]!.xp, 250);
  }
});

test('id wins over user_id; zero XP and 17/20-digit ids are accepted', () => {
  const parsed = parseMee6Export(
    players([
      { id: A, user_id: B, xp: 0 },
      { id: '1'.repeat(17), xp: 5 },
      { id: '2'.repeat(20), xp: 5 },
    ]),
  );
  assert.equal(parsed[0]!.memberId, A);
  assert.equal(parsed[0]!.xp, 0);
  assert.equal(parsed[1]!.memberId, '1'.repeat(17));
  assert.equal(parsed[2]!.memberId, '2'.repeat(20));
});

test('a row without a level keeps level undefined; a consistent level is kept', () => {
  // 100 XP is exactly the level-1 threshold.
  const parsed = parseMee6Export(players([{ id: A, xp: 5 }, { user_id: B, xp: 100, level: 1 }]));
  assert.equal(parsed[0]!.level, undefined);
  assert.equal(parsed[1]!.level, 1);
});

test('an empty export parses to zero rows, not an error', () => {
  assert.deepEqual(parseMee6Export('[]'), []);
  assert.deepEqual(parseMee6Export(JSON.stringify({ players: [] })), []);
});

// --- malformed-manifest refusals ----------------------------------------------

test('non-JSON text is refused naming the syntax failure', () => {
  const error = throwsExport('not json');
  assert.equal(error.problems.length, 1);
  assert.match(error.problems[0]!, /file is not valid JSON/);
  assert.match(error.message, /MEE6 export is not importable/);
  assert.equal(error.name, 'Mee6ExportError');
});

test('JSON scalars and wrong envelopes are refused as not-a-players-export', () => {
  for (const text of ['5', 'null', '"x"', '{}', '{"players":"x"}', '{"players":null}', '{"players":{}}']) {
    assert.match(throwsExport(text).problems[0]!, /array or an object with a players array/, text);
  }
});

test('non-object rows are refused with their 1-based row number', () => {
  const error = throwsExport(players([null, 5, 'x']));
  assert.equal(error.problems.length, 3);
  assert.match(error.problems[0]!, /row 1 is not an object/);
  assert.match(error.problems[1]!, /row 2 is not an object/);
  assert.match(error.problems[2]!, /row 3 is not an object/);
});

test('an array row falls through to the id check, not the object check', () => {
  // typeof [] is 'object', so the row passes the shape gate and fails on identity.
  assert.match(throwsExport(players([[[5]]])).problems[0]!, /row 1 has no id or user_id/);
});

test('missing, numeric and empty ids are refused without an id', () => {
  const error = throwsExport(players([{ xp: 1 }, { id: 123, xp: 1 }, { user_id: null, xp: 1 }]));
  assert.equal(error.problems.length, 3);
  for (const problem of error.problems) assert.match(problem, /row \d has no id or user_id/);
  assert.match(throwsExport(players([{ id: '', xp: 5 }])).problems[0]!, /invalid Discord member id: $/);
});

test('short, long and non-digit ids are refused quoting the bad value', () => {
  assert.match(
    throwsExport(players([{ id: '123', xp: 5 }])).problems[0]!,
    /invalid Discord member id: 123/,
  );
  assert.match(
    throwsExport(players([{ id: '1'.repeat(16), xp: 5 }])).problems[0]!,
    /invalid Discord member id/,
  );
  assert.match(
    throwsExport(players([{ id: '1'.repeat(21), xp: 5 }])).problems[0]!,
    /invalid Discord member id/,
  );
  assert.match(
    throwsExport(players([{ id: 'not-a-snowflake', xp: 5 }])).problems[0]!,
    /invalid Discord member id: not-a-snowflake/,
  );
});

test('non-integer, negative, string, missing and unsafe XP are refused', () => {
  const error = throwsExport(
    players([
      { id: A, xp: 1.5 },
      { id: A, xp: -1 },
      { id: A, xp: '5' },
      { id: A },
      { id: A, xp: Number.MAX_SAFE_INTEGER + 1 },
    ]),
  );
  assert.equal(error.problems.length, 5);
  for (const problem of error.problems) assert.match(problem, /row \d has invalid xp/);
});

test('a non-integer, negative or null level is refused', () => {
  for (const level of [1.5, -1, null]) {
    assert.match(
      throwsExport(players([{ id: A, xp: 100, level }])).problems[0]!,
      /row 1 has invalid level/,
    );
  }
});

test('a level that disagrees with the XP curve is refused with both numbers', () => {
  const error = throwsExport(players([{ id: A, xp: 100, level: 9 }]));
  assert.match(error.problems[0]!, /row 1 states level 9 but 100 XP is level 1/);
});

test('every bad row is reported at once, numbered from 1', () => {
  const error = throwsExport(
    JSON.stringify({
      players: [
        { id: A, xp: 100 },
        { id: 'not-a-snowflake', xp: 5 },
        { id: B, xp: -1 },
        { id: B, xp: 100, level: 9 },
      ],
    }),
  );
  // Fixing an export one error per run is how a 20k-row import takes a day.
  assert.equal(error.problems.length, 3);
  assert.match(error.problems[0]!, /row 2 has an invalid Discord member id/);
  assert.match(error.problems[1]!, /row 3 has invalid xp/);
  assert.match(error.problems[2]!, /row 4 states level 9 but 100 XP is level 1/);
});

// --- hashes and constants -------------------------------------------------------

test('sha256 matches the known vector; digestBuffer hashes the bytes given', () => {
  assert.equal(sha256('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.deepEqual(digestBuffer('p', Buffer.from('abc')), {
    path: 'p',
    bytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  });
});

test('digestFile hashes the file bytes and reports their length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-importmanifest-'));
  try {
    const path = join(dir, 'e.json');
    writeFileSync(path, JSON.stringify({ players: [{ id: A, xp: 100 }] }));
    const bytes = readFileSync(path);
    assert.deepEqual(await digestFile(path), {
      path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SKIP_REASONS names the three skip reasons; the manifest version is pinned', () => {
  assert.deepEqual([...SKIP_REASONS], ['duplicate_row', 'would_lower_imported_xp', 'exceeds_xp_ceiling']);
  assert.equal(MANIFEST_VERSION, 1);
});

// --- the fake Db -----------------------------------------------------------------

interface LiveRow {
  xp: number;
  msg: number;
  voice: number;
  imp: number;
}

interface CannedInventory {
  rows: number;
  xp: number;
  org: number;
  imp: number;
}

/** In-memory stand-in for Postgres: canned aggregates/members plus a write ledger. */
function fakeDb(
  live: Map<string, LiveRow>,
  inv: CannedInventory,
  ledger: { prepares: number; writes: string[] },
): Db {
  return {
    prepare(sql: string): Statement {
      ledger.prepares++;
      if (sql.includes('COUNT(*)')) {
        return {
          get: async <T>(): Promise<T | undefined> =>
            ({ member_rows: inv.rows, total_xp: inv.xp, total_organic_xp: inv.org, total_imported_xp: inv.imp }) as unknown as T,
          all: async <T>(): Promise<T[]> => [],
          run: async () => ({ changes: 0 }),
        };
      }
      if (sql.includes('SELECT member_id, xp')) {
        return {
          get: async <T>(): Promise<T | undefined> => undefined,
          all: async <T>(...params: unknown[]): Promise<T[]> =>
            (params.slice(1) as string[])
              .filter((id) => live.has(id))
              .map((id) => {
                const row = live.get(id)!;
                return {
                  member_id: id,
                  xp: row.xp,
                  message_xp: row.msg,
                  voice_xp: row.voice,
                  imported_xp: row.imp,
                };
              }) as unknown as T[],
          run: async () => ({ changes: 0 }),
        };
      }
      throw new Error(`TOG-9142: unexpected SQL: ${sql.slice(0, 60)}`);
    },
    exec: async (sql: string) => {
      ledger.writes.push(sql);
    },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(fakeDb(live, inv, ledger)),
    close: async () => {},
  };
}

const EMPTY_INV: CannedInventory = { rows: 0, xp: 0, org: 0, imp: 0 };

function ledger() {
  return { prepares: 0, writes: [] as string[] };
}

// --- inventory ----------------------------------------------------------------------

test('inventory maps the aggregate row; a missing row is a zero inventory', async () => {
  const found = await inventory(
    fakeDb(new Map(), { rows: 2, xp: 955, org: 55, imp: 900 }, ledger()),
    'g',
  );
  assert.deepEqual(found, { guildId: 'g', memberRows: 2, totalXp: 955, totalOrganicXp: 55, totalImportedXp: 900 });

  const missing = await inventory(
    {
      prepare: () => ({
        get: async <T>(): Promise<T | undefined> => undefined,
        all: async <T>(): Promise<T[]> => [],
        run: async () => ({ changes: 0 }),
      }),
      exec: async () => {},
      transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn({} as Db),
      close: async () => {},
    },
    'g',
  );
  assert.deepEqual(missing, { guildId: 'g', memberRows: 0, totalXp: 0, totalOrganicXp: 0, totalImportedXp: 0 });
});

// --- planMee6Import --------------------------------------------------------------------

test('an empty export plans nothing and balances against the inventory', async () => {
  const db = fakeDb(new Map(), { rows: 1, xp: 915, org: 15, imp: 900 }, ledger());
  const plan = await planMee6Import(db, 'g', []);
  assert.deepEqual(plan.accounting, {
    rowsIn: 0,
    duplicateRows: 0,
    uniqueMembersIn: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skippedMembers: 0,
    balances: true,
  });
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.totalXpIn, 0);
  assert.equal(plan.uniqueXpIn, 0);
  assert.equal(plan.importedXpWritten, 0);
  assert.equal(plan.totalXpAfterProjected, 915);
});

test('fresh members insert; totals count duplicates in and winners out', async () => {
  const db = fakeDb(new Map(), EMPTY_INV, ledger());
  const plan = await planMee6Import(db, 'g', [
    { memberId: A, xp: 100 },
    { memberId: A, xp: 900 },
    { memberId: B, xp: 40 },
  ]);
  assert.equal(plan.accounting.rowsIn, 3);
  assert.equal(plan.accounting.duplicateRows, 1);
  assert.equal(plan.accounting.uniqueMembersIn, 2);
  assert.equal(plan.accounting.inserted, 2);
  assert.equal(plan.accounting.balances, true);
  assert.equal(plan.totalXpIn, 1040);
  assert.equal(plan.uniqueXpIn, 940);
  assert.equal(plan.importedXpWritten, 940);
  assert.equal(plan.totalXpAfterProjected, 940);
});

test('three listings of one member name both losers with the kept maximum', async () => {
  const db = fakeDb(new Map(), EMPTY_INV, ledger());
  const plan = await planMee6Import(db, 'g', [
    { memberId: A, xp: 100 },
    { memberId: A, xp: 900 },
    { memberId: A, xp: 50 },
  ]);
  assert.equal(plan.accounting.duplicateRows, 2);
  assert.equal(plan.accounting.uniqueMembersIn, 1);
  assert.equal(plan.accounting.balances, true);
  assert.deepEqual(
    plan.skipped.map((s) => [s.xp, s.reason]),
    [
      [100, 'duplicate_row'],
      [50, 'duplicate_row'],
    ],
  );
  assert.match(plan.skipped[0]!.detail, /kept the highest XP 900, dropped 100/);
});

test('the duplicate collapse is max-wins before the lowering check, either file order', async () => {
  // Live imported XP is 500. The winner (900) is an update; judging the 100
  // first would decline the member instead.
  for (const rows of [
    [
      { memberId: A, xp: 900 },
      { memberId: A, xp: 100 },
    ],
    [
      { memberId: A, xp: 100 },
      { memberId: A, xp: 900 },
    ],
  ]) {
    const db = fakeDb(new Map([[A, { xp: 515, msg: 10, voice: 5, imp: 500 }]]), EMPTY_INV, ledger());
    const plan = await planMee6Import(db, 'g', rows);
    assert.equal(plan.accounting.updated, 1, JSON.stringify(rows));
    assert.equal(plan.accounting.skippedMembers, 0, JSON.stringify(rows));
    assert.equal(plan.skipped.length, 1, JSON.stringify(rows));
    assert.equal(plan.skipped[0]!.reason, 'duplicate_row', JSON.stringify(rows));
  }
});

test('equal live XP is unchanged, never an update', async () => {
  const db = fakeDb(new Map([[A, { xp: 515, msg: 10, voice: 5, imp: 500 }]]), EMPTY_INV, ledger());
  const plan = await planMee6Import(db, 'g', [{ memberId: A, xp: 500 }]);
  assert.equal(plan.accounting.unchanged, 1);
  assert.equal(plan.accounting.updated, 0);
  assert.equal(plan.accounting.balances, true);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.importedXpWritten, 0);
});

test('a stale export is declined naming both numbers; declined members leave apply', async () => {
  const db = fakeDb(
    new Map([[A, { xp: 915, msg: 15, voice: 0, imp: 900 }]]),
    { rows: 1, xp: 915, org: 15, imp: 900 },
    ledger(),
  );
  const plan = await planMee6Import(db, 'g', [
    { memberId: A, xp: 100 },
    { memberId: B, xp: 40 },
  ]);
  assert.equal(plan.accounting.skippedMembers, 1);
  assert.equal(plan.accounting.inserted, 1);
  assert.equal(plan.accounting.balances, true);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.memberId, A);
  assert.equal(plan.skipped[0]!.reason, 'would_lower_imported_xp');
  assert.match(
    plan.skipped[0]!.detail,
    /export XP 100 is below the 900 already imported.*drop the stored total from 915 to 115/s,
  );
  // The declined member is filtered out of the rows handed to the service.
  assert.deepEqual(plan.apply, [{ memberId: B, xp: 40 }]);
  assert.equal(plan.totalXpAfterProjected, 955);
});

test('allowLower applies the stale row and the projection drops', async () => {
  const db = fakeDb(
    new Map([[A, { xp: 915, msg: 15, voice: 0, imp: 900 }]]),
    { rows: 1, xp: 915, org: 15, imp: 900 },
    ledger(),
  );
  const plan = await planMee6Import(db, 'g', [{ memberId: A, xp: 100 }], { allowLower: true });
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.accounting.updated, 1);
  assert.equal(plan.apply.length, 1);
  assert.equal(plan.totalXpAfterProjected, 115);
});

test('the ceiling refuses before any write even with allowLower; landing on it is allowed', async () => {
  const near = (): Map<string, LiveRow> =>
    new Map([[A, { xp: MAX_STORED_XP - 10, msg: MAX_STORED_XP - 15, voice: 5, imp: 0 }]]);
  for (const options of [{}, { allowLower: true }]) {
    const db = fakeDb(near(), EMPTY_INV, ledger());
    const plan = await planMee6Import(db, 'g', [{ memberId: A, xp: 20 }], options);
    assert.equal(plan.accounting.skippedMembers, 1, JSON.stringify(options));
    assert.equal(plan.skipped[0]!.reason, 'exceeds_xp_ceiling', JSON.stringify(options));
    assert.match(
      plan.skipped[0]!.detail,
      new RegExp(`organic XP ${MAX_STORED_XP - 10} plus imported 20 exceeds the ${MAX_STORED_XP} ceiling`),
    );
    assert.deepEqual(plan.apply, [], JSON.stringify(options));
  }

  const exact = fakeDb(
    new Map([[A, { xp: MAX_STORED_XP - 20, msg: MAX_STORED_XP - 20, voice: 0, imp: 0 }]]),
    EMPTY_INV,
    ledger(),
  );
  const allowed = await planMee6Import(exact, 'g', [{ memberId: A, xp: 20 }]);
  assert.equal(allowed.accounting.updated, 1);
  assert.equal(allowed.accounting.skippedMembers, 0);
});

test('a same-XP duplicate names the loser even when the winner is then declined', async () => {
  const db = fakeDb(new Map([[A, { xp: 515, msg: 10, voice: 5, imp: 500 }]]), EMPTY_INV, ledger());
  const plan = await planMee6Import(db, 'g', [
    { memberId: A, xp: 100 },
    { memberId: A, xp: 100 },
  ]);
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ['duplicate_row', 'would_lower_imported_xp'],
  );
  assert.equal(plan.accounting.uniqueMembersIn, 1);
  assert.equal(plan.accounting.balances, true);
});

// --- runMee6Import dry run ------------------------------------------------------------------

test('a dry run returns the full manifest and never writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-importmanifest-'));
  try {
    const file = join(dir, 'e.json');
    writeFileSync(file, JSON.stringify({ players: [{ id: A, xp: 100 }] }));
    const bytes = readFileSync(file);
    const led = ledger();
    const db = fakeDb(new Map(), { rows: 1, xp: 915, org: 15, imp: 900 }, led);

    const manifest = await runMee6Import(db, 'g', file, {});

    assert.equal(manifest.manifestVersion, MANIFEST_VERSION);
    assert.equal(manifest.guildId, 'g');
    assert.equal(manifest.mode, 'dry-run');
    assert.deepEqual(manifest.file, { path: file, bytes: bytes.byteLength, sha256: sha256(bytes) });
    assert.equal(manifest.totalXpIn, 100);
    assert.equal(manifest.uniqueXpIn, 100);
    assert.equal(manifest.accounting.balances, true);
    assert.equal(manifest.rowsWritten, 1);
    assert.equal(manifest.importedXpWritten, 100);
    assert.deepEqual(manifest.skipped, []);
    assert.deepEqual(manifest.skippedByReason, {
      duplicate_row: 0,
      would_lower_imported_xp: 0,
      exceeds_xp_ceiling: 0,
    });
    assert.equal(manifest.totalXpAfterProjected, 1015);
    assert.equal(manifest.totalXpAfterMeasured, null);
    assert.equal(manifest.inventoryAfter, null);
    assert.equal(manifest.importSummary, null);
    assert.equal(manifest.reconciled, true);
    assert.deepEqual(manifest.reconciliationErrors, []);
    // Dry run by construction: the only statements are the inventory read and
    // the member lookup; exec/transaction never fire.
    assert.deepEqual(led.writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skippedByReason tallies one of every kind in a single dry run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-importmanifest-'));
  try {
    const file = join(dir, 'mixed.json');
    writeFileSync(
      file,
      JSON.stringify({
        players: [
          { id: A, xp: 100 },
          { id: C, xp: 50 },
          { id: C, xp: 60 },
          { id: D, xp: 20 },
        ],
      }),
    );
    const db = fakeDb(
      new Map([
        [A, { xp: 915, msg: 15, voice: 0, imp: 900 }],
        [D, { xp: MAX_STORED_XP - 10, msg: MAX_STORED_XP - 15, voice: 5, imp: 0 }],
      ]),
      EMPTY_INV,
      ledger(),
    );
    const manifest = await runMee6Import(db, 'g', file, {});
    assert.deepEqual(manifest.skippedByReason, {
      duplicate_row: 1,
      would_lower_imported_xp: 1,
      exceeds_xp_ceiling: 1,
    });
    assert.equal(manifest.accounting.rowsIn, 4);
    assert.equal(manifest.accounting.duplicateRows, 1);
    assert.equal(manifest.accounting.uniqueMembersIn, 3);
    assert.equal(manifest.accounting.inserted, 1);
    assert.equal(manifest.accounting.skippedMembers, 2);
    assert.equal(manifest.accounting.balances, true);
    assert.equal(manifest.totalXpIn, 230);
    assert.equal(manifest.uniqueXpIn, 180);
    assert.equal(manifest.reconciled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or malformed file fails before the database is touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-bot-importmanifest-'));
  try {
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{nope');
    const badRows = join(dir, 'bad-rows.json');
    writeFileSync(badRows, JSON.stringify({ players: [{ id: 'x', xp: 1 }] }));

    for (const file of [badJson, badRows]) {
      const led = ledger();
      const db = fakeDb(new Map(), EMPTY_INV, led);
      let error: unknown;
      try {
        await runMee6Import(db, 'g', file, {});
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof Mee6ExportError, file);
      assert.equal(led.prepares, 0, `${file} must fail before any statement`);
      assert.deepEqual(led.writes, []);
    }

    const led = ledger();
    await assert.rejects(runMee6Import(fakeDb(new Map(), EMPTY_INV, led), 'g', join(dir, 'missing.json'), {}));
    assert.equal(led.prepares, 0, 'a missing file must fail before any statement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
