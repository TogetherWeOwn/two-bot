/**
 * Staging doctor/verify acceptance matrix (TOG-5699).
 *
 * One fixture-driven file that proves the two scripts answer correctly with no
 * staging environment: the doctor detects known-bad states, and the verify
 * slices pass a known-good one. Pure — no token, no network, no database.
 *
 * Each case maps to a documented staging failure mode (file/line or dated
 * measurement in the comment above it). The per-module unit files
 * (unit.readiness, unit.provision, unit.tempvoicecheck, unit.auditacceptance,
 * unit.staging) cover the same functions in isolation; this file is the
 * acceptance matrix that says "the scripts would have caught the failures we
 * actually hit".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT_CODE,
  databaseStateChecks,
  stagingEnvChecks,
  verdict,
  type Env,
} from '../src/staging/readiness.ts';
import { EXPECTED_FUNNEL } from '../src/staging/fixtures.ts';
import {
  LIVE_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_INVITE_PERMISSIONS,
  STAGING_ROLES,
} from '../src/staging/spec.ts';
import { evaluateHierarchy, type PartialRole } from '../src/staging/provision.ts';
import {
  CHANNEL_TYPE_CATEGORY,
  CHANNEL_TYPE_VOICE,
  evaluateTempVoiceStructure,
} from '../src/staging/tempVoiceCheck.ts';
import {
  AUDIT_ACCEPTANCE_KINDS,
  evaluateAuditChannels,
  evaluateAuditEvidence,
  evaluateAuditMarkers,
} from '../src/staging/auditAcceptance.ts';
import { describePermissions } from '../src/staging/spec.ts';

/** A token is base64(application_id).timestamp.hmac - the rest is not read. */
const tokenFor = (appId: string) => `${Buffer.from(appId).toString('base64')}.Gxxxxx.notarealsecret`;

const STAGING_TOKEN = tokenFor(STAGING_BOT_APPLICATION_ID);
const LIVE_TOKEN = tokenFor(LIVE_BOT_APPLICATION_ID);

const GOOD_ENV: Env = {
  DISCORD_STAGING_BOT_TOKEN: STAGING_TOKEN,
  DISCORD_STAGING_GUILD_ID: '999000111222333444',
  TWO_STAGING_DATABASE_URL: 'postgres://qa:pw@db.example.com:5432/two_staging',
};

/** The known-good database state: seeded fixtures, current schema. */
const GOOD_COUNTS: Record<string, number> = { ...EXPECTED_FUNNEL };

const BOT_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';
const OWNER_ID = '999999999999999999';

function goodRoles(): PartialRole[] {
  return [
    ...STAGING_ROLES.map((name, i) => ({ id: `r${i}`, name, position: i + 1 })),
    { id: 'bot-role', name: 'Owen QA Test', position: 10, tags: { bot_id: BOT_ID } },
  ];
}

const VIEW_DENY = String(1n << 10n);

function goodAuditChannels() {
  return (['audit-log', 'voice-log', 'moderation-log'] as const).map((name) => ({
    id: `id-${name}`,
    name,
    type: 0,
    permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: VIEW_DENY }],
  }));
}

function goodEvidenceRows() {
  return AUDIT_ACCEPTANCE_KINDS.map((event_kind) => ({
    event_kind,
    rows: 1,
    distinct_entries: 1,
    incomplete_deliveries: 0,
    sink_tamper_rows: event_kind === 'message_delete' ? 1 : 0,
    successful_moderation_rows: event_kind === 'moderation_action' ? 1 : 0,
  }));
}

// --- the known-good staging slice -------------------------------------------

test('known-good: doctor reads ready and every verify slice passes', () => {
  const envChecks = stagingEnvChecks(GOOD_ENV);
  assert.deepEqual(envChecks.map((c) => c.status), ['ok', 'ok', 'ok']);

  const dbChecks = databaseStateChecks({
    pendingMigrations: 0,
    appliedMigrations: 4,
    counts: GOOD_COUNTS,
  });
  assert.ok(dbChecks.every((c) => c.status === 'ok'));
  assert.equal(verdict([...envChecks, ...dbChecks]), 'ready');
  assert.equal(EXIT_CODE.ready, 0);

  const hierarchy = evaluateHierarchy({ roles: goodRoles(), botId: BOT_ID, ownerId: OWNER_ID });
  assert.equal(hierarchy.ownerBypass, false);
  assert.deepEqual(hierarchy.blocked, []);
  assert.deepEqual(hierarchy.missing, []);
  assert.deepEqual([...hierarchy.assignable].sort(), [...STAGING_ROLES].sort());

  const channels = evaluateAuditChannels(goodAuditChannels(), GUILD_ID);
  assert.deepEqual(channels.missing, []);
  assert.deepEqual(channels.memberReadable, []);
  assert.deepEqual(channels.duplicates, []);

  assert.deepEqual(describePermissions(STAGING_INVITE_PERMISSIONS).missing, []);

  const tempVoice = evaluateTempVoiceStructure(
    [
      { id: 'cat-1', name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY },
      { id: 'gen-1', name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: 'cat-1' },
    ],
    { categoryId: 'cat-1', generatorChannelId: 'gen-1' },
  );
  assert.equal(tempVoice.ok, true);

  assert.deepEqual(evaluateAuditEvidence(goodEvidenceRows()), {
    missing: [],
    duplicates: [],
    pendingDeliveries: [],
    missingSinkTamper: false,
    missingModerationSuccess: false,
  });

  assert.deepEqual(
    evaluateAuditMarkers([
      {
        entryId: 'e1',
        eventKind: 'message_edit',
        mirrorMessageId: 'm1',
        channelId: 'id-audit-log',
        expectedChannelId: 'id-audit-log',
        messageIds: ['m1'],
      },
    ]),
    { missing: [], duplicates: [], messageIdMismatches: [], channelMismatches: [] },
  );
});

// --- doctor known-bad 1: live token ------------------------------------------
//
// Failure mode: on 2026-08-19 the secrets store bound the LIVE bot's token
// while the staging variable was absent; the same mix-up with the variable
// present would point staging tooling at the production bot. Documented in
// docs/STAGING.md ("Which bot is which") and src/staging/spec.ts
// checkStagingToken.

test('doctor blocks the live bot token in the staging variable', () => {
  const c = stagingEnvChecks({ ...GOOD_ENV, DISCORD_STAGING_BOT_TOKEN: LIVE_TOKEN }).find(
    (x) => x.id === 'token',
  )!;
  assert.equal(c.status, 'blocked');
  assert.match(c.detail, new RegExp(LIVE_BOT_APPLICATION_ID));
  assert.match(c.owner ?? '', /founder/i);
  assert.match(c.action ?? '', /rebind/i);
});

// --- doctor known-bad 2: staging URL is the live database ----------------------
//
// Failure mode: same target under different credentials is still the live
// funnel, and a reset against it has no undo. Documented in
// src/staging/readiness.ts databaseCheck and docs/STAGING.md rule 2 ("Never
// run any of this with the live values loaded").

test('doctor refuses a staging URL pointing at the live database', () => {
  const c = stagingEnvChecks({
    ...GOOD_ENV,
    TWO_STAGING_DATABASE_URL: 'postgres://qa:qapw@db.example.com:5432/two_staging',
    TWO_DATABASE_URL: 'postgres://bot:botpw@db.example.com:5432/two_staging',
  }).find((x) => x.id === 'database')!;
  assert.equal(c.status, 'fix');
  assert.match(c.action ?? '', /no undo/i);
});

// --- doctor known-bad 3: pending migrations ------------------------------------
//
// Failure mode: schema drift — the database exists but migrations were never
// applied (or a new migration landed). The doctor must name the
// TWO_DATABASE_URL mapping trap. Documented in src/staging/readiness.ts
// databaseStateChecks.

test('doctor reports pending migrations with the live-variable mapping', () => {
  const checks = databaseStateChecks({ pendingMigrations: 2, appliedMigrations: 0 });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'fix');
  assert.match(checks[0].action ?? '', /TWO_DATABASE_URL="\$TWO_STAGING_DATABASE_URL"/);
  assert.equal(verdict(checks), 'fix');
  assert.equal(EXIT_CODE.fix, 1);
});

// --- doctor known-bad 4: empty / drifted fixtures -------------------------------
//
// Failure mode: an unseeded database, or state left behind by a previous suite
// run. Documented in src/staging/fixtures.ts (EXPECTED_FUNNEL) and
// docs/STAGING.md ("The full reset loop was proven end to end ... deleting
// three members and every first_message event made staging-reset.ts --check
// exit 1").

test('doctor tells an empty database to seed, not that its counts are wrong', () => {
  const empty = Object.fromEntries(Object.keys(EXPECTED_FUNNEL).map((t) => [t, 0]));
  const fixtures = databaseStateChecks({
    pendingMigrations: 0,
    appliedMigrations: 4,
    counts: empty,
  }).find((c) => c.title === 'fixtures')!;
  assert.equal(fixtures.status, 'fix');
  assert.match(fixtures.detail, /never been seeded/);
  assert.match(fixtures.action ?? '', /staging-reset/);
});

test('doctor reports per-type funnel drift from a previous suite run', () => {
  const counts = { ...GOOD_COUNTS, first_message: 99 };
  const fixtures = databaseStateChecks({
    pendingMigrations: 0,
    appliedMigrations: 4,
    counts,
  }).find((c) => c.title === 'fixtures')!;
  assert.equal(fixtures.status, 'fix');
  assert.match(fixtures.detail, /first_message 99\/7/);
  assert.match(fixtures.action ?? '', /staging-reset/);
});

// --- verify known-bad: role hierarchy -------------------------------------------
//
// Failure mode: the single most common staging failure — the bot's role sits
// below a role it must grant, Discord answers 403, nothing logs, and the
// funnel records a member who "chose not to pick a game". Documented in
// src/staging/spec.ts STAGING_ROLES and scripts/staging-verify.ts section 3.

test('verify fails a spec role above a non-owner bot (silent 403)', () => {
  const roles: PartialRole[] = [
    ...STAGING_ROLES.map((name, i) => ({ id: `r${i}`, name, position: [1, 2, 9, 1, 2, 3][i] })),
    { id: 'bot', name: 'Owen Staging', position: 5, tags: { bot_id: BOT_ID } },
  ];
  const h = evaluateHierarchy({ roles, botId: BOT_ID, ownerId: OWNER_ID });
  assert.ok(h.blocked.length > 0);
  assert.equal(h.ownerBypass, false);
});

// --- verify known-bad: member-readable staff log ----------------------------------
//
// Failure mode: a staff log any member can read leaks moderation evidence.
// Documented in src/staging/auditAcceptance.ts evaluateAuditChannels and
// scripts/staging-verify.ts section 4.

test('verify fails a member-readable audit log channel', () => {
  const result = evaluateAuditChannels(
    [
      ...goodAuditChannels().slice(0, 2),
      {
        id: 'id-moderation-log',
        name: 'moderation-log',
        type: 0,
        permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: '0' }],
      },
    ],
    GUILD_ID,
  );
  assert.deepEqual(result.memberReadable, ['moderation-log']);
});

// --- verify known-bad: short invite mask -------------------------------------------
//
// Failure mode: measured on the real guild 2026-09-05 — role.assign and
// event.upsert returned 422 wrapping Discord's 403 with effective mask
// 2112134023859777. The endpoint was right; the invite was short. Documented
// in src/staging/spec.ts STAGING_INVITE_PERMISSIONS and
// docs/STAGING.md run-real-acceptance notes.

test('verify diagnoses the real 2026-09-05 short-permission mask', () => {
  const MEASURED = 2112134023859777n;
  const { missing } = describePermissions(MEASURED);
  assert.ok(missing.includes('Manage Roles'), 'role.assign returned 403 that day');
  assert.ok(missing.includes('Manage Events'), 'event.upsert returned 403 that day');
});

// --- verify known-bad: temp-voice miswire --------------------------------------------
//
// Failure mode: create-on-join can never fire without both ids pointing at a
// voice generator under its category. Documented in
// src/staging/tempVoiceCheck.ts and scripts/staging-verify.ts
// --case=temp-voice (TOG-3471/TOG-3052).

test('verify fails a temp-voice generator outside its category', () => {
  const result = evaluateTempVoiceStructure(
    [
      { id: 'cat-1', name: 'Voice Rooms', type: CHANNEL_TYPE_CATEGORY },
      { id: 'gen-1', name: 'Join to Create', type: CHANNEL_TYPE_VOICE, parent_id: 'other' },
    ],
    { categoryId: 'cat-1', generatorChannelId: 'gen-1' },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('not parented')));
});

// --- the scripts actually consume these decisions --------------------------------------
//
// Guards the wiring: the acceptance above is only meaningful if
// scripts/staging-doctor.ts and scripts/staging-verify.ts call the evaluated
// functions rather than re-implementing the checks inline.

test('staging-doctor.ts consumes the env, state and verdict decisions', () => {
  const doctor = readFileSync(join(import.meta.dirname, '..', 'scripts', 'staging-doctor.ts'), 'utf8');
  assert.match(doctor, /stagingEnvChecks\(process\.env\)/);
  assert.match(doctor, /databaseStateChecks\(/);
  assert.match(doctor, /verdict\(/);
  assert.match(doctor, /EXIT_CODE\[/);
});

test('staging-verify.ts consumes the hierarchy, channel, permission and evidence decisions', () => {
  const verifier = readFileSync(
    join(import.meta.dirname, '..', 'scripts', 'staging-verify.ts'),
    'utf8',
  );
  assert.match(verifier, /evaluateHierarchy\(/);
  assert.match(verifier, /evaluateAuditChannels\(/);
  assert.match(verifier, /describePermissions\(/);
  assert.match(verifier, /evaluateTempVoiceStructure\(/);
  assert.match(verifier, /evaluateAuditEvidence\(/);
  assert.match(verifier, /evaluateAuditMarkers\(/);
  // The live-guild refusal lives in stagingGuildId() (spec.ts), which the
  // verifier calls before any network: a staging run pointed at the live
  // guild throws rather than seeding test members into the real funnel.
  assert.match(verifier, /stagingGuildId\(\)/);
  assert.match(verifier, /checkStagingToken\(token\)/);
});
