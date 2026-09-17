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
import { isDeclaredEnvOnly } from '../src/core/settingsCatalog.ts';

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

test('isStorableKey is catalog membership, and the prefix is still not a blocklist', () => {
  assert.equal(isStorableKey('TWO_INTERNAL_KEYS'), false);
  assert.equal(isStorableKey('TWO_INTERNAL_'), false);
  // A gate nobody has written yet is covered by the prefix.
  assert.equal(isStorableKey('TWO_INTERNAL_ALLOW_ANYTHING'), false);

  // This used to assert TWO_INTERNALISED_GREETING was storable, which is how
  // you catch a guard that has decayed into a substring match on "INTERNAL".
  // Since TOG-3100 the rule is fail-closed on catalog membership, so the
  // lookalike is refused too - and that assertion alone can no longer tell a
  // correct implementation from a blocklist, because both now say false. The
  // distinction survives in isDeclaredEnvOnly(), so that is where it is tested.
  assert.equal(isStorableKey('TWO_INTERNALISED_GREETING'), false);
  assert.equal(isDeclaredEnvOnly('TWO_INTERNALISED_GREETING'), false);
  assert.equal(isDeclaredEnvOnly('TWO_INTERNAL_ALLOW_ANYTHING'), true);

  // Real catalogued settings are not collateral damage. Without these the whole
  // test would pass against a store that refused every key on earth.
  assert.equal(isStorableKey('TWO_ONBOARDING_DRY_RUN'), true);
  assert.equal(isStorableKey('TWO_RAID_JOIN_THRESHOLD'), true);
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
  //
  // Raw INSERT, like the constraint test above and for the same reason: since
  // TOG-3100 the store refuses any key the catalog does not list, and a probe
  // whose whole job is to be uncatalogued can no longer reach Postgres through
  // set(). Going through the store would test the catalog and report the result
  // as the escape - which is the failure mode this file exists to avoid.
  await testDb.db
    .prepare(
      `INSERT INTO guild_settings (guild_id, key, value, version, updated_by)
       VALUES (?, ?, '"fine"'::jsonb, nextval('guild_settings_version_seq'), ?)`,
    )
    .run(GUILD, 'TWOXINTERNALXKEYS', ADMIN);

  const row = await testDb.db
    .prepare(`SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?`)
    .get<{ value: unknown }>(GUILD, 'TWOXINTERNALXKEYS');
  assert.equal(row?.value, 'fine', 'the escaped underscore must not over-match');
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
  await assert.rejects(() => store().set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ''));
});

test('setting null deletes the row, hands the key back to env, and still audits', async () => {
  const s = store();
  await s.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ADMIN);
  await s.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', null, ADMIN);

  const row = await testDb.db
    .prepare(`SELECT key FROM guild_settings WHERE guild_id = ? AND key = ?`)
    .get(GUILD, 'TWO_ONBOARDING_DRY_RUN');
  assert.equal(row, undefined);

  const last = await testDb.db
    .prepare(
      `SELECT old_value, new_value FROM guild_settings_audit
        WHERE guild_id = ? AND key = ? ORDER BY id DESC LIMIT 1`,
    )
    .get<{ old_value: unknown; new_value: unknown }>(GUILD, 'TWO_ONBOARDING_DRY_RUN');
  assert.deepEqual(last, { old_value: true, new_value: null });
});

test('the audit trail cannot be edited or erased by the process that writes it', async () => {
  const s = store();
  await s.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ADMIN);

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

test('a delete is visible to the poll even when it is not the newest row', async () => {
  // This test used to store one key, delete it, and assert the poll noticed.
  // It passed, and it was not testing what it said: with one row, deleting it
  // takes max(version) from 1 to 0, so the version alone was enough and the
  // delete-shaped hole was invisible.
  //
  // The hole, found on staging under TOG-3100: the deleted row carries its own
  // version away with it, so if any *newer* row remains, max(version) does not
  // move and every other process keeps serving a value that is no longer in the
  // table. Ordering here is the whole test - the survivor is written second, on
  // purpose, so it holds the maximum.
  const writer = store();
  await writer.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ADMIN);
  await writer.set(GUILD, 'TWO_RAID_JOIN_THRESHOLD', 9, ADMIN);

  const reader = store();
  await reader.load();
  assert.equal(reader.get(GUILD, 'TWO_ONBOARDING_DRY_RUN'), true);
  const versionBefore = reader.currentVersion();

  await writer.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', null, ADMIN);

  assert.equal(await reader.refreshIfChanged(), true, 'the delete must be visible to the poll');
  assert.equal(reader.get(GUILD, 'TWO_ONBOARDING_DRY_RUN'), undefined);
  assert.equal(
    reader.get(GUILD, 'TWO_RAID_JOIN_THRESHOLD'),
    9,
    'and the surviving key is untouched',
  );
  // The assertion that pins *why* this is not the old test: the version really
  // did stay put, so nothing about this reload can be credited to it.
  assert.equal(
    reader.currentVersion(),
    versionBefore,
    'max(version) is unchanged - the row count is what caught this',
  );
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
  await writer.set(GUILD, 'TWO_ONBOARDING_DRY_RUN', true, ADMIN);
  await writer.set(OTHER_GUILD, 'TWO_ONBOARDING_DRY_RUN', false, ADMIN);

  const reader = store();
  await reader.load();
  assert.deepEqual([...reader.envSnapshot(GUILD)], [['TWO_ONBOARDING_DRY_RUN', '1']]);
  assert.deepEqual([...reader.envSnapshot(OTHER_GUILD)], [['TWO_ONBOARDING_DRY_RUN', '0']]);
  // A bot with no DISCORD_GUILD_ID reads nothing from the store rather than
  // picking an arbitrary guild's settings.
  assert.deepEqual([...reader.envSnapshot(null)], []);
});
