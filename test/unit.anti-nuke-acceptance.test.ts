import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
  assertAcceptanceFences,
  discordSnowflakeTimestamp,
  evaluateGatewayEvidence,
  evaluateJoinGatewayEvidence,
  fixtureRoleNames,
  selectFixtureAuditEntries,
} from '../src/staging/antiNukeAcceptance.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import {
  SnapshotIntegrityError,
  sealSnapshot,
  type GuildConfigSnapshot,
} from '../src/redesign/guildConfig.ts';
import { acceptedSnapshot, validateStagingDatabaseIdentity } from '../scripts/staging-anti-nuke-acceptance.ts';

const ACTOR = '111111111111111111';
const CAPABILITY = '222222222222222222';
const TARGETS = ['333333333333333333', '444444444444444444'] as const;
const STARTED = '2026-09-22T04:00:00.000Z';

function snowflakeAt(iso: string, increment = 0n): string {
  return (((BigInt(Date.parse(iso)) - 1_420_070_400_000n) << 22n) + increment).toString();
}

test('hard fences pin the staging guild, Owen app, and exact acceptance SHA', () => {
  assert.doesNotThrow(() => assertAcceptanceFences({
    guildId: TWO_STAGING_GUILD_ID,
    owenApplicationId: STAGING_BOT_APPLICATION_ID,
    actorApplicationId: ACTOR,
    targetSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
    deployedSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
  }));
  assert.throws(() => assertAcceptanceFences({
    guildId: '326474832151838730',
    owenApplicationId: STAGING_BOT_APPLICATION_ID,
    actorApplicationId: ACTOR,
    targetSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
    deployedSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
  }), /Refusing/);
  assert.throws(() => assertAcceptanceFences({
    guildId: TWO_STAGING_GUILD_ID,
    owenApplicationId: STAGING_BOT_APPLICATION_ID,
    actorApplicationId: STAGING_BOT_APPLICATION_ID,
    targetSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
    deployedSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
  }), /separate bot/);
  assert.throws(() => assertAcceptanceFences({
    guildId: TWO_STAGING_GUILD_ID,
    owenApplicationId: STAGING_BOT_APPLICATION_ID,
    actorApplicationId: ACTOR,
    targetSha: ANTI_NUKE_ACCEPTANCE_TARGET_SHA,
    deployedSha: '0000000000000000000000000000000000000000',
  }), /Staging deployment/);
});

test('database fence requires the exact staging host and database name', () => {
  const fingerprint = validateStagingDatabaseIdentity(
    'postgresql://user:password@staging-db.internal:5432/two_staging',
    'staging-db.internal',
    'two_staging',
  );
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => validateStagingDatabaseIdentity(
    'postgresql://user:password@production-db.internal:5432/two_staging',
    'staging-db.internal',
    'two_staging',
  ), /exact TWO_STAGING_DATABASE_HOST/);
  assert.throws(() => validateStagingDatabaseIdentity(
    'postgresql://user:password@staging-db.internal:5432/production_test_copy',
    'staging-db.internal',
    'two_staging',
  ), /exact TWO_STAGING_DATABASE_HOST/);
});

test('fixture names are attributable and bounded to two delete targets', () => {
  const names = fixtureRoleNames('qa-20260922-a');
  assert.equal(names.capability, 'TOG-3787 qa-20260922-a actor-capability');
  assert.deepEqual(names.targets, [
    'TOG-3787 qa-20260922-a delete-1',
    'TOG-3787 qa-20260922-a delete-2',
  ]);
  assert.throws(() => fixtureRoleNames('../unsafe'), /safe identifier/);
});

test('audit selection requires actor, run marker, fixtures, action, and lower bound', () => {
  const validA = snowflakeAt('2026-09-22T04:00:01.000Z', 1n);
  const validB = snowflakeAt('2026-09-22T04:00:02.000Z', 2n);
  const selected = selectFixtureAuditEntries({
    actorApplicationId: ACTOR,
    targetRoleIds: TARGETS,
    runId: 'qa-20260922-a',
    startedAt: STARTED,
    entries: [
      { id: validB, action_type: 32, user_id: ACTOR, target_id: TARGETS[1], reason: 'TOG-3787 qa-20260922-a fixture 2/2' },
      { id: validA, action_type: 32, user_id: ACTOR, target_id: TARGETS[0], reason: 'TOG-3787 qa-20260922-a fixture 1/2' },
      { id: snowflakeAt('2026-09-22T03:59:00.000Z'), action_type: 32, user_id: ACTOR, target_id: TARGETS[0], reason: 'TOG-3787 qa-20260922-a old' },
      { id: snowflakeAt('2026-09-22T04:00:03.000Z'), action_type: 32, user_id: '555555555555555555', target_id: TARGETS[0], reason: 'TOG-3787 qa-20260922-a wrong actor' },
      { id: snowflakeAt('2026-09-22T04:00:04.000Z'), action_type: 31, user_id: ACTOR, target_id: TARGETS[0], reason: 'TOG-3787 qa-20260922-a wrong action' },
    ],
  });
  assert.deepEqual(selected.map((entry) => entry.id), [validA, validB]);
  assert.equal(discordSnowflakeTimestamp(validA), Date.parse('2026-09-22T04:00:01.000Z'));
});

test('gateway evidence requires Discord ids to match durable rows and one dry-run incident', () => {
  const entries = TARGETS.map((target, index) => ({
    id: snowflakeAt(`2026-09-22T04:00:0${index + 1}.000Z`, BigInt(index)),
    action_type: 32,
    user_id: ACTOR,
    target_id: target,
    reason: `TOG-3787 qa-20260922-a fixture ${index + 1}/2`,
  }));
  const rows = entries.map((entry, index) => ({
    audit_entry_id: entry.id,
    executor_id: ACTOR,
    action: 'role.delete',
    target_id: entry.target_id,
    weight: 3,
    occurred_at: `2026-09-22T04:00:0${index + 1}.000Z`,
    state: index === 1 ? 'contain' : 'observe',
    reason: 'counted toward destructive-action heat',
  }));
  const verdict = evaluateGatewayEvidence({
    actorApplicationId: ACTOR,
    targetRoleIds: TARGETS,
    auditEntries: entries,
    containmentRows: rows,
    incidents: [{
      trigger_audit_entry_id: entries[1].id,
      executor_id: ACTOR,
      heat: 6,
      state: 'dry_run',
      result_json: '{}',
    }],
    expectedIncidentState: 'dry_run',
    capabilityRoleId: CAPABILITY,
  });
  assert.equal(verdict.ok, true, verdict.errors.join('\n'));
});

test('contained evidence must name the fixture capability role removed by Owen', () => {
  const entries = TARGETS.map((target, index) => ({
    id: snowflakeAt(`2026-09-22T04:00:0${index + 1}.000Z`, BigInt(index)),
    action_type: 32,
    user_id: ACTOR,
    target_id: target,
  }));
  const rows = entries.map((entry) => ({
    audit_entry_id: entry.id,
    executor_id: ACTOR,
    action: 'role.delete',
    target_id: entry.target_id,
    weight: 3,
    occurred_at: STARTED,
    state: 'contain',
    reason: 'counted toward destructive-action heat',
  }));
  const bad = evaluateGatewayEvidence({
    actorApplicationId: ACTOR,
    targetRoleIds: TARGETS,
    auditEntries: entries,
    containmentRows: rows,
    incidents: [{
      trigger_audit_entry_id: entries[1].id,
      executor_id: ACTOR,
      heat: 6,
      state: 'contained',
      result_json: JSON.stringify({ removedRoleIds: [] }),
    }],
    expectedIncidentState: 'contained',
    capabilityRoleId: CAPABILITY,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /did not record removal/);
});

test('join evidence correlates Discord membership, member_join, and join-risk identity', () => {
  const memberId = '666666666666666666';
  const joinedAt = '2026-09-22T04:00:05.000Z';
  const verdict = evaluateJoinGatewayEvidence({
    guildId: TWO_STAGING_GUILD_ID,
    memberId,
    since: STARTED,
    discordMember: { id: memberId, bot: false, joined_at: joinedAt, roles: [] },
    eventRows: [{ member_id: memberId, occurred_at: joinedAt, source: 'invite:bounded' }],
    riskRows: [{
      event_id: `${TWO_STAGING_GUILD_ID}:${memberId}:${joinedAt}`,
      member_id: memberId,
      joined_at: joinedAt,
      source: 'invite:bounded',
      score: 3,
      reasons_json: '["account younger than 24 hours"]',
      bulk_join_window: false,
      flagged: true,
    }],
    expectedBulkWindow: false,
    expectedFlagged: true,
  });
  assert.equal(verdict.ok, true, verdict.errors.join('\n'));
});

test('bot joins cannot be mislabeled as real join-risk gateway evidence', () => {
  const memberId = '666666666666666666';
  const joinedAt = '2026-09-22T04:00:05.000Z';
  const verdict = evaluateJoinGatewayEvidence({
    guildId: TWO_STAGING_GUILD_ID,
    memberId,
    since: STARTED,
    discordMember: { id: memberId, bot: true, joined_at: joinedAt, roles: [] },
    eventRows: [],
    riskRows: [],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join('\n'), /intentionally ignores bot joins/);
});

function stagingSnapshotFixture(): GuildConfigSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-27T00:00:00.000Z',
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: TWO_STAGING_GUILD_ID,
    guild: { description: 'TWO Staging' },
    roles: [],
    channels: [],
    emojis: [],
  };
}

test('accepted snapshot verifies the tamper seal: tampered sealed refuses, legacy warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tog-7678-'));
  try {
    // Sealed snapshot matching guild state passes.
    const sealed = sealSnapshot(stagingSnapshotFixture());
    const sealedPath = join(dir, 'sealed.json');
    writeFileSync(sealedPath, JSON.stringify(sealed));
    assert.equal(acceptedSnapshot(sealedPath, structuredClone(sealed)).hash.length, 64);

    // Tampered sealed snapshot whose content matches guild state still refuses.
    const tampered = structuredClone(sealed);
    tampered.guild = { ...tampered.guild, description: 'evil' };
    const tamperedPath = join(dir, 'tampered.json');
    writeFileSync(tamperedPath, JSON.stringify(tampered));
    assert.throws(() => acceptedSnapshot(tamperedPath, structuredClone(tampered)), SnapshotIntegrityError);

    // Legacy pre-seal snapshot warns and proceeds, matching restore semantics.
    const legacy = stagingSnapshotFixture();
    const legacyPath = join(dir, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify(legacy));
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      assert.equal(acceptedSnapshot(legacyPath, structuredClone(legacy)).hash.length, 64);
    } finally {
      console.error = originalError;
    }
    assert.match(warnings.join('\n'), /no integrity seal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
