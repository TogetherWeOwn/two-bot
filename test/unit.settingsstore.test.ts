/**
 * `SettingsStore` and migration 0026 - the two layers under the settings
 * actions (TOG-3101, TOG-3093 slice 2).
 *
 * test/unit.internalsettings.test.ts proves the *handler* refuses
 * `TWO_INTERNAL_*` against a store that enforces nothing. This file proves the
 * other two layers independently: the store refuses it in TypeScript, and the
 * schema refuses it in Postgres even when the TypeScript is bypassed entirely.
 * Three refusals for one rule is deliberate - see the `settings.get` /
 * `settings.set` section of docs/INTERNAL_ACTIONS.md §3.
 *
 * The schema assertion below issues raw SQL rather than going through the
 * store, because a CHECK constraint that is only ever exercised behind a guard
 * that already refuses the same thing is untestable by construction, and an
 * untestable constraint is one nobody can tell has been dropped.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import {
  SettingsStore,
  EnvOnlyKeyError,
  isStorableKey,
  toEnvString,
} from '../src/core/settings.ts';

const GUILD = '326474832151838730';
const OTHER_GUILD = '999999999999999999';
const ADMIN = '111111111111111111';

let testDb: TestDb;

before(async () => {
  testDb = await openTestDb(import.meta.filename);
});
after(async () => {
  await testDb.cleanup();
});
beforeEach(async () => {
  // DELETE, not TRUNCATE: the audit table's append-only trigger is BEFORE
  // DELETE FOR EACH ROW, so a plain DELETE would fire it. Dropping the trigger
  // for the duration is the honest way to empty it, and it also means the
  // trigger is re-created (and therefore still present) for every test.
  await testDb.db.exec(`ALTER TABLE guild_settings_audit DISABLE TRIGGER trg_guild_settings_audit_append_only`);
  await testDb.db.exec(`DELETE FROM guild_settings_audit`);
  await testDb.db.exec(`ALTER TABLE guild_settings_audit ENABLE TRIGGER trg_guild_settings_audit_append_only`);
  await testDb.db.exec(`DELETE FROM guild_settings`);
});

function store(): SettingsStore {
  return new SettingsStore(testDb.db);
}

// --- the security property, at the store layer -------------------------------

test('the store refuses TWO_INTERNAL_* before it issues any SQL', async () => {
  const s = store();
  await assert.rejects(
    () => s.set(GUILD, 'TWO_INTERNAL_ALLOW_SETTINGS', '1', ADMIN),
    EnvOnlyKeyError,
  );

  // Nothing was written, and - the part that matters - no audit row either. A
  // refusal that still wrote an audit row would mean the transaction had been
  // opened, i.e. the check had run too late to be a guard.
  const rows = await testDb.db
    .prepare(`SELECT count(*)::int AS n FROM guild_settings_audit`)
    .get<{ n: number }>();
  assert.equal(rows?.n, 0);
});

test('isStorableKey is a namespace rule, not a keyword blocklist', () => {
  assert.equal(isStorableKey('TWO_INTERNAL_KEYS'), false);
  assert.equal(isStorableKey('TWO_INTERNAL_'), false);
  // A gate nobody has written yet is covered by the prefix.
  assert.equal(isStorableKey('TWO_INTERNAL_ALLOW_ANYTHING'), false);
  // ...but a real setting that merely contains the word is not collateral.
  assert.equal(isStorableKey('TWO_INTERNALISED_GREETING'), true);
  assert.equal(isStorableKey('TWO_AUTOMOD_ENABLED'), true);
});

test('the schema refuses TWO_INTERNAL_* too, with the TypeScript guard bypassed', async () => {
  // Straight INSERT. This is what a psql session, a future writer, or a bug in
  // the store would do, and it is the only path that tests the constraint.
  await assert.rejects(
    () =>
      testDb.db
        .prepare(
          `INSERT INTO guild_settings (guild_id, key, value, version, updated_by)
           VALUES (?, ?, '"1"'::jsonb, nextval('guild_settings_version_seq'), ?)`,
        )
        .run(GUILD, 'TWO_INTERNAL_ALLOW_SETTINGS', ADMIN),
    /guild_settings_no_internal_keys/,
    'the CHECK constraint must be the one that rejects it',
  );
});

test('the underscore in the constraint is an escape, so ordinary keys are unaffected', async () => {
  // `LIKE 'TWO\_INTERNAL\_%'` - if those escapes were dropped, `_` would be a
  // single-character wildcard and TWO?INTERNAL? patterns would over-match. The
  // shape that proves the escape works is a key that differs only there.
  const s = store();
  await s.set(GUILD, 'TWOXINTERNALXKEYS', 'fine', ADMIN);
  assert.equal(s.get(GUILD, 'TWOXINTERNALXKEYS'), undefined, 'cache is not written by set()');
  await s.load();
  assert.equal(s.get(GUILD, 'TWOXINTERNALXKEYS'), 'fine');
});

// --- writes, audit, attribution ----------------------------------------------

test('a write records the actor and an audit row with the previous value', async () => {
  const s = store();
  await s.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 5, ADMIN);
  await s.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 9, '222222222222222222');

  const row = await testDb.db
    .prepare(`SELECT value, updated_by FROM guild_settings WHERE guild_id = ? AND key = ?`)
    .get<{ value: unknown; updated_by: string }>(GUILD, 'TWO_RAID_JOIN_THRESHOLD');
  assert.equal(row?.value, 9);
  assert.equal(row?.updated_by, '222222222222222222', 'the actor is the caller-supplied admin id');

  const audit = await testDb.db
    .prepare(
      `SELECT old_value, new_value, actor FROM guild_settings_audit
        WHERE guild_id = ? AND key = ? ORDER BY id`,
    )
    .all<{ old_value: unknown; new_value: unknown; actor: string }>(GUILD, 'TWO_RAID_JOIN_THRESHOLD');
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[0], { old_value: null, new_value: 5, actor: ADMIN });
  assert.deepEqual(audit[1], { old_value: 5, new_value: 9, actor: '222222222222222222' });
});

test('an unattributed write is refused - that is the row this table exists to prevent', async () => {
  await assert.rejects(() => store().set(GUILD, 'TWO_AUTOMOD_ENABLED', true, ''));
});

test('setting null deletes the row, hands the key back to env, and still audits', async () => {
  const s = store();
  await s.set(GUILD, 'TWO_AUTOMOD_ENABLED', true, ADMIN);
  await s.set(GUILD, 'TWO_AUTOMOD_ENABLED', null, ADMIN);

  const row = await testDb.db
    .prepare(`SELECT key FROM guild_settings WHERE guild_id = ? AND key = ?`)
    .get(GUILD, 'TWO_AUTOMOD_ENABLED');
  assert.equal(row, undefined);

  const last = await testDb.db
    .prepare(
      `SELECT old_value, new_value FROM guild_settings_audit
        WHERE guild_id = ? AND key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get<{ old_value: unknown; new_value: unknown }>(GUILD, 'TWO_AUTOMOD_ENABLED');
  assert.deepEqual(last, { old_value: true, new_value: null });
});

test('the audit trail cannot be edited or erased by the process that writes it', async () => {
  const s = store();
  await s.set(GUILD, 'TWO_AUTOMOD_ENABLED', true, ADMIN);

  await assert.rejects(
    () => testDb.db.prepare(`UPDATE guild_settings_audit SET actor = 'somebody-else'`).run(),
    /append-only/,
  );
  await assert.rejects(
    () => testDb.db.prepare(`DELETE FROM guild_settings_audit`).run(),
    /append-only/,
  );
});

// --- the version poll ---------------------------------------------------------

test('a delete moves the version, or other processes keep serving a deleted value', async () => {
  // The bug this guards: DELETE writes no row, so without an explicit nextval
  // the global max(version) is unchanged and every other process's poll sees
  // nothing to do. The value would stay live everywhere but here.
  const writer = store();
  await writer.set(GUILD, 'TWO_AUTOMOD_ENABLED', true, ADMIN);

  const reader = store();
  await reader.load();
  assert.equal(reader.get(GUILD, 'TWO_AUTOMOD_ENABLED'), true);

  await writer.set(GUILD, 'TWO_AUTOMOD_ENABLED', null, ADMIN);

  assert.equal(await reader.refreshIfChanged(), true, 'the delete must be visible to the poll');
  assert.equal(reader.get(GUILD, 'TWO_AUTOMOD_ENABLED'), undefined);
});

test('the poll is cheap when nothing changed and reloads when something did', async () => {
  const writer = store();
  const reader = store();
  await reader.load();

  assert.equal(await reader.refreshIfChanged(), false, 'an empty table is not a change');

  await writer.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 9, ADMIN);
  assert.equal(await reader.refreshIfChanged(), true);
  assert.equal(reader.get(GUILD, 'TWO_RAID_JOIN_THRESHOLD'), 9);
  assert.equal(await reader.refreshIfChanged(), false, 'a second poll with no write is a no-op');
});

test('a change fires the listeners once per refresh that moved', async () => {
  const writer = store();
  const reader = store();
  await reader.load();
  let fired = 0;
  reader.onChange(() => {
    fired++;
  });

  await reader.refreshIfChanged();
  assert.equal(fired, 0);

  await writer.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 9, ADMIN);
  await reader.refreshIfChanged();
  assert.equal(fired, 1);
});

// --- env rendering and guild scoping -----------------------------------------

test('values render the way the environment carried them, booleans included', () => {
  // Every boolean env var in src/ is tested with === '1' or !== '0'. 'true'
  // would store cleanly, read back cleanly, and silently mean off.
  assert.equal(toEnvString(true), '1');
  assert.equal(toEnvString(false), '0');
  assert.equal(toEnvString(5), '5');
  assert.equal(toEnvString('delete'), 'delete');
  assert.equal(toEnvString(['1', '2']), '1,2');
  assert.equal(toEnvString(null), undefined);
  assert.equal(toEnvString(Number.NaN), undefined, 'a non-finite number must fall through to env');
});

test('the env snapshot is per guild, so one guild cannot read another config', async () => {
  const writer = store();
  await writer.set(GUILD, 'TWO_AUTOMOD_ENABLED', true, ADMIN);
  await writer.set(OTHER_GUILD, 'TWO_AUTOMOD_ENABLED', false, ADMIN);

  const reader = store();
  await reader.load();
  assert.deepEqual([...reader.envSnapshot(GUILD)], [['TWO_AUTOMOD_ENABLED', '1']]);
  assert.deepEqual([...reader.envSnapshot(OTHER_GUILD)], [['TWO_AUTOMOD_ENABLED', '0']]);
  // A bot with no DISCORD_GUILD_ID reads nothing from the store rather than
  // picking an arbitrary guild's settings.
  assert.deepEqual([...reader.envSnapshot(null)], []);
});
