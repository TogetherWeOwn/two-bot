/**
 * Unit coverage for `src/live/` + `src/redesign/` (TOG-5696).
 *
 * `activation.ts`, `guildConfig.ts`, `guildConfigRestore.ts`, `wave2.ts` and
 * `clean-slate.ts` already have dedicated unit suites (`unit.live-activation`,
 * `unit.guildconfig`, `unit.wave2`); this file covers the one module with no
 * unit tests at all — `redesign/live-cleanup.ts` — plus the few exported
 * functions in the sibling modules those suites never call (`botTokenFrom`,
 * `isLiveCapability`, `snapshotCounts`, `acceptedSpec`, and the `clean-slate`
 * copy constants).
 *
 * Everything here is repo-local: the full-snapshot tests map the checked-in
 * production-state fixture into a `LiveCleanupSnapshot` the same way
 * `scripts/live-clean-slate-cleanup.ts:captureSnapshot` does, and the journal
 * tests write to a fresh `mkdtemp` dir. No token, no network, no Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_CATEGORY_IDS,
  ACTIVE_CHANNEL_IDS,
  ADMINISTRATOR,
  ARCHIVE_PHASE,
  AUTO_VOICE_CATEGORY_ID,
  LEGACY_CATEGORY_IDS,
  LEGACY_CHANNEL_IDS,
  OVERWRITE_CEILING_PER_CHANNEL,
  PINNED_GUILD_REFERENCES,
  SNAPSHOT_MAX_AGE_MS,
  VIEW_CHANNEL,
  appendJournalWitness,
  applyOperationOverwrites,
  archiveEveryoneOverwrite,
  archiveExemption,
  archiveOnboardingExclusions,
  archiveVisibilityExemptions,
  assertHierarchy,
  assertLatestCheckpoint,
  assertReviewedShape,
  basePermissions,
  buildManifest,
  driftComparableChannel,
  driftComparableChannels,
  driftComparableGuild,
  driftExcludedIds,
  driftSemanticHash,
  guildReferenceBlock,
  inFlightDriftIsOurs,
  inFlightExceptionIsAvailable,
  isAutoVoiceEphemeralChild,
  isDriftExcluded,
  journalSignature,
  journalWitnessPath,
  manifestInFlightId,
  normalizeOverwrites,
  normalizedChannel,
  normalizedMemberRoles,
  onboardingReferencedChannels,
  operationSemanticHash,
  planArchiveOperations,
  planSignature,
  readJournalWitness,
  reconcileJournalWitness,
  semanticSnapshot,
  sha256,
  stable,
  syncedChildIds,
  unreadableGuildReferences,
  unreadableMemberRoles,
  unreadableOverwrites,
  unreadableRole,
  withSemanticHash,
} from '../src/redesign/live-cleanup.ts';
import type {
  Channel,
  CleanupManifest,
  CleanupOperation,
  JsonObject,
  LiveCleanupSnapshot,
  Member,
  Overwrite,
  Role,
} from '../src/redesign/live-cleanup.ts';
import { botTokenFrom, isLiveCapability } from '../src/live/activation.ts';
import { acceptedSpec, snapshotCounts } from '../src/redesign/guildConfig.ts';
import type { GuildConfigSnapshot } from '../src/redesign/guildConfig.ts';
import {
  CATEGORIES,
  RULES,
  SCREENING_DESCRIPTION,
  STARTER_MESSAGE,
  WELCOME_DESCRIPTION,
} from '../src/redesign/clean-slate.ts';

const LIVE_GUILD = '326474832151838730';
const LIVE_APP = '1539711683898118154';
const LIVE_NAME = 'TogetherWeOwn';
const TOKEN = `${Buffer.from(LIVE_APP).toString('base64url')}.mock.signature`;

// --- fixture mapping (mirrors scripts/live-clean-slate-cleanup.ts:captureSnapshot) ---

type RawMember = {
  user?: { id?: string; username?: string; bot?: boolean };
  roles?: unknown;
  premium_since?: string | null;
  pending?: boolean;
};
type RawState = {
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  members: RawMember[];
  integrations: Array<{ id: unknown; name: unknown; application?: { id?: unknown } | null; role_id?: unknown }>;
};

function loadState(): RawState {
  return JSON.parse(
    readFileSync(new URL('./fixtures/live-cleanup-production-state.json', import.meta.url), 'utf8'),
  ) as RawState;
}

function toSnapshot(
  state: RawState,
  overrides: Partial<LiveCleanupSnapshot & { onboardingBody: JsonObject; guildName: string }> = {},
): LiveCleanupSnapshot {
  const members: Member[] = state.members
    .map((member) => ({
      id: member.user?.id ?? '',
      bot: Boolean(member.user?.bot),
      username: member.user?.username ?? null,
      roles: normalizedMemberRoles(member.roles),
      premiumSince: member.premium_since ?? null,
      pending: Boolean(member.pending),
    }))
    .filter((member) => member.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const integrations = state.integrations
    .map((integration) => ({
      id: typeof integration.id === 'string' ? integration.id : '',
      name: typeof integration.name === 'string' ? integration.name : null,
      applicationId:
        integration.application && typeof integration.application.id === 'string' ? integration.application.id : null,
      roleId: typeof integration.role_id === 'string' ? integration.role_id : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const guild = { ...(state.guild as JsonObject), name: overrides.guildName ?? state.guild['name'] };
  return withSemanticHash({
    version: 1,
    generatedAt: '2026-09-16T12:20:52.000Z',
    applicationId: overrides.applicationId ?? LIVE_APP,
    guildId: overrides.guildId ?? LIVE_GUILD,
    guild,
    roles: overrides.roles ?? state.roles,
    channels: overrides.channels ?? state.channels.map(normalizedChannel),
    members: overrides.members ?? members,
    integrations,
    references: {
      welcomeScreen: { status: 200, body: {} },
      onboarding: { status: 200, body: overrides.onboardingBody ?? { enabled: false, default_channel_ids: [], prompts: [] } },
      membershipScreening: { status: 200, body: {} },
      guildReferences: guildReferenceBlock(guild),
    },
  });
}

function expectedOperations(): Array<{ sequence: number; id: string; objectType: string; objectId: string }> {
  const expected = JSON.parse(
    readFileSync(new URL('./fixtures/live-cleanup-expected-operations.json', import.meta.url), 'utf8'),
  ) as { operations: Array<{ sequence: number; id: string; objectType: string; objectId: string }> };
  return expected.operations;
}

// --- full-snapshot planning (happy path + error paths) ---

test('production-state fixture plans exactly the 65 reviewed operations, deterministically', () => {
  const snapshot = toSnapshot(loadState());
  assertReviewedShape(snapshot);
  assertHierarchy(snapshot);
  const first = planArchiveOperations(snapshot);
  const second = planArchiveOperations(toSnapshot(loadState()));
  assert.equal(first.length, 65);
  assert.deepEqual(
    first.map((op) => ({ sequence: op.sequence, id: op.id, objectType: op.objectType, objectId: op.objectId })),
    expectedOperations(),
  );
  assert.equal(operationSemanticHash(first), operationSemanticHash(second));
});

test('assertReviewedShape refuses a wrong guild name, a wrong identity, and a missing reviewed object', () => {
  const state = loadState();
  assert.throws(() => assertReviewedShape(toSnapshot(state, { guildName: 'Someone Else' })), /Expected guild name/);
  assert.throws(
    () => assertReviewedShape(toSnapshot(state, { guildId: '1555555555555555555' })),
    /does not match the live Owen application and guild/,
  );
  const dropped = { ...state, channels: state.channels.filter((channel) => channel.id !== LEGACY_CHANNEL_IDS[0]) };
  assert.throws(() => assertReviewedShape(toSnapshot(dropped)), new RegExp(`Reviewed object ${LEGACY_CHANNEL_IDS[0]} is missing`));
});

test('assertReviewedShape refuses an unreadable overwrite list instead of planning on an empty one', () => {
  const state = loadState();
  const channels = state.channels.map((channel) =>
    channel.id === LEGACY_CHANNEL_IDS[0] ? { ...channel, permission_overwrites: undefined as unknown as Overwrite[] } : channel,
  );
  assert.throws(
    () => assertReviewedShape(toSnapshot({ ...state, channels })),
    /no `permission_overwrites` key at all/,
  );
});

test('assertReviewedShape refuses a legacy channel moved out of the reviewed legacy tree', () => {
  const state = loadState();
  const channels = state.channels.map((channel) =>
    channel.id === LEGACY_CHANNEL_IDS[0] ? { ...channel, parent_id: ACTIVE_CATEGORY_IDS[0] } : channel,
  );
  assert.throws(
    () => assertReviewedShape(toSnapshot({ ...state, channels })),
    /is not under a reviewed legacy category/,
  );
});

test('planArchiveOperations refuses a synchronized channel pinned publicly readable (400/350003)', () => {
  // 1118994739799281664 is synchronized with its category in the fixture: the
  // category deny would hide it by inheritance, so planning refuses rather
  // than silently breaking the reference.
  const snapshot = toSnapshot(loadState(), {
    onboardingBody: { enabled: true, default_channel_ids: ['1118994739799281664'], prompts: [] },
  });
  assert.throws(() => planArchiveOperations(snapshot), /400 code 350003/);
  assert.throws(() => planArchiveOperations(snapshot), /permission-synchronized/);
});

test('planArchiveOperations excludes (not refuses) an unsynchronized pinned channel', () => {
  // 1146611215511081012 is unsynchronized in the fixture, so pinning it just
  // drops its channel PATCH; the other 64 operations still plan.
  const snapshot = toSnapshot(loadState(), {
    onboardingBody: { enabled: true, default_channel_ids: ['1146611215511081012'], prompts: [] },
  });
  const ops = planArchiveOperations(snapshot);
  assert.equal(ops.length, 64);
  assert.ok(!ops.some((op) => op.objectId === '1146611215511081012'));
});

test('planArchiveOperations skips synchronized children and plans every legacy category', () => {
  const ops = planArchiveOperations(toSnapshot(loadState()));
  const ids = new Set(ops.map((op) => op.objectId));
  // 1118994739799281664 is synchronized with its category: no channel PATCH.
  assert.ok(!ids.has('1118994739799281664'));
  // 1146611215511081012 is unsynchronized: it gets its own PATCH.
  assert.ok(ids.has('1146611215511081012'));
  assert.equal(ops.filter((op) => op.objectType === 'category').length, LEGACY_CATEGORY_IDS.length);
  assert.equal(ops.filter((op) => op.objectType === 'channel').length, 65 - LEGACY_CATEGORY_IDS.length);
  for (const op of ops) {
    assert.ok(
      (op.objectType === 'category' && (LEGACY_CATEGORY_IDS as readonly string[]).includes(op.objectId)) ||
        (op.objectType === 'channel' && (LEGACY_CHANNEL_IDS as readonly string[]).includes(op.objectId)),
      `operation names a reviewed legacy object: ${op.objectId}`,
    );
  }
});

test('assertHierarchy refuses a missing Owen, a non-admin Owen, and an Owen that is outranked', () => {
  const state = loadState();
  const noOwen = { ...state, members: state.members.filter((member) => member.user?.id !== LIVE_APP) };
  assert.throws(() => assertHierarchy(toSnapshot(noOwen)), /Owen is missing from the member inventory/);
  const deAdmined = {
    ...state,
    roles: state.roles.map((role) => ({ ...role, permissions: '0' })),
  };
  assert.throws(() => assertHierarchy(toSnapshot(deAdmined)), /Owen does not have Administrator/);
  const outranked = {
    ...state,
    roles: state.roles.map((role) =>
      role.managed && role.id !== LIVE_GUILD ? { ...role, position: 500 } : role,
    ),
  };
  assert.throws(() => assertHierarchy(toSnapshot(outranked)), /Owen is not above every managed target role/);
});

test('assertHierarchy refuses unreadable role fields and unreadable member role lists', () => {
  const state = loadState();
  const badRole = {
    ...state,
    roles: state.roles.map((role, index) => (index === 0 ? { ...role, position: undefined as unknown as number } : role)),
  };
  assert.throws(() => assertHierarchy(toSnapshot(badRole)), /cannot show Owen outranks/);
  const badMember = {
    ...state,
    members: state.members.map((member, index) => (index === 0 ? { ...member, roles: undefined } : member)),
  };
  assert.throws(() => assertHierarchy(toSnapshot(badMember as RawState)), /cannot show which roles/);
});

// --- overwrite readability + normalization ---

test('unreadableOverwrites distinguishes absence from emptiness and names the bad field', () => {
  assert.equal(unreadableOverwrites([]), null);
  assert.equal(unreadableOverwrites([{ id: 'a', type: 0, allow: '0', deny: '0' }]), null);
  assert.equal(unreadableOverwrites(undefined), 'no `permission_overwrites` key at all');
  assert.match(unreadableOverwrites(null)!, /not an array/);
  assert.match(unreadableOverwrites({})!, /not an array/);
  assert.match(unreadableOverwrites(['x'])!, /not an object/);
  assert.match(unreadableOverwrites([{ id: 'a', type: 0, allow: '0' }])!, /`deny`/);
});

test('normalizeOverwrites sorts canonically and refuses an unanswered list', () => {
  const normalized = normalizeOverwrites([
    { id: 'b', type: 1, allow: '0', deny: '0' },
    { id: 'a', type: 0, allow: '0', deny: '0' },
  ]);
  assert.deepEqual(normalized.map((entry) => entry.id), ['a', 'b']);
  assert.throws(() => normalizeOverwrites(undefined as unknown as Overwrite[]), /Refusing rather than read an unanswered/);
});

test('normalizedChannel normalizes readable lists but carries absence through verbatim', () => {
  const readable: Channel = {
    id: 'y', name: 'y', type: 0, parent_id: null,
    permission_overwrites: [
      { id: 'b', type: 1, allow: '0', deny: '0' },
      { id: 'a', type: 0, allow: '0', deny: '0' },
    ],
  };
  assert.deepEqual(normalizedChannel(readable).permission_overwrites.map((entry) => entry.id), ['a', 'b']);
  const absent = { id: 'x', name: 'x', type: 0, parent_id: null } as unknown as Channel;
  assert.equal(normalizedChannel(absent), absent);
});

test('archiveEveryoneOverwrite appends a View deny, or folds it into the existing @everyone entry', () => {
  const appended = archiveEveryoneOverwrite(LIVE_GUILD, [{ id: 'other', type: 0, allow: '0', deny: '0' }]);
  assert.deepEqual(appended.find((entry) => entry.id === LIVE_GUILD), {
    id: LIVE_GUILD, type: 0, allow: '0', deny: String(1n << 10n),
  });
  const folded = archiveEveryoneOverwrite(LIVE_GUILD, [{ id: LIVE_GUILD, type: 0, allow: '1024', deny: '0' }]);
  assert.deepEqual(folded, [{ id: LIVE_GUILD, type: 0, allow: '0', deny: '1024' }]);
  assert.throws(() => archiveEveryoneOverwrite(LIVE_GUILD, undefined as unknown as Overwrite[]), /Refusing/);
});

// --- permissions, exemptions, visibility ---

function memberFixture(): { snapshot: { guildId: string; guild: JsonObject; roles: Role[]; members: Member[] } } {
  const everyone = { id: LIVE_GUILD, name: '@everyone', managed: false, permissions: '1049600', position: 0 };
  const admin = { id: 'role-admin', name: 'Admin', managed: false, permissions: String(1n << 3n), position: 5 };
  const plain = { id: 'role-plain', name: 'Plain', managed: false, permissions: '0', position: 1 };
  const owenRole = { id: 'role-owen', name: 'Owen', managed: true, permissions: String(1n << 3n), position: 6 };
  const roles = [everyone, plain, admin, owenRole];
  const members: Member[] = [
    { id: 'owner-1', bot: false, username: 'owner', roles: ['role-plain'], premiumSince: null, pending: false },
    { id: LIVE_APP, bot: true, username: 'owen', roles: ['role-owen'], premiumSince: null, pending: false },
    { id: 'admin-1', bot: false, username: 'admin', roles: ['role-admin'], premiumSince: null, pending: false },
    { id: 'pleb-1', bot: false, username: 'pleb', roles: ['role-plain'], premiumSince: null, pending: false },
  ];
  return { snapshot: { guildId: LIVE_GUILD, guild: { owner_id: 'owner-1' }, roles, members } };
}

test('basePermissions unions @everyone with the member roles, and archiveExemption names owner/owen/admin', () => {
  const { snapshot } = memberFixture();
  assert.equal(basePermissions(snapshot.members[3]!, snapshot as never), 1049600n);
  assert.equal(archiveExemption(snapshot.members[0]!, snapshot as never), 'owner');
  assert.equal(archiveExemption(snapshot.members[1]!, snapshot as never), 'owen');
  assert.equal(archiveExemption(snapshot.members[2]!, snapshot as never), 'administrator');
  assert.equal(archiveExemption(snapshot.members[3]!, snapshot as never), null);
});

test('archiveVisibilityExemptions pins exactly the owner, owen and administrators, sorted', () => {
  const live = loadState();
  const snapshot = toSnapshot(live);
  const exemptions = archiveVisibilityExemptions(snapshot);
  assert.equal(exemptions.length, 5);
  assert.deepEqual(exemptions.map((entry) => entry.memberId), [...exemptions.map((entry) => entry.memberId)].sort());
  const byId = new Map(exemptions.map((entry) => [entry.memberId, entry.reason]));
  assert.equal(byId.get(live.guild['owner_id'] as string), 'owner');
  assert.equal(byId.get(LIVE_APP), 'owen');
});

test('planArchiveOperations hides a directly-visible member with a member deny, and refuses past the ceiling', () => {
  const ops = planArchiveOperations(toSnapshot(loadState()));
  const withMemberDeny = ops.filter((op) =>
    op.write.permission_overwrites.some((overwrite) => overwrite.type === 1),
  );
  assert.ok(withMemberDeny.length > 0, 'at least one write carries a member-level deny');
  for (const op of ops) {
    assert.ok(
      op.write.permission_overwrites.length <= OVERWRITE_CEILING_PER_CHANNEL,
      `${op.objectId} stays under the ceiling`,
    );
  }
});

test('unreadableRole, unreadableMemberRoles and unreadableGuildReferences name the unreadable field', () => {
  assert.equal(unreadableRole({ id: 'r', name: 'r', managed: false, permissions: '0', position: 1 }), null);
  assert.match(unreadableRole({ id: 'r', name: 'r', managed: false, permissions: '0', position: NaN })!, /finite/);
  assert.match(unreadableRole({ id: 'r', name: 'r', managed: 'yes' as unknown as boolean, permissions: '0', position: 1 })!, /`managed`/);
  assert.equal(unreadableMemberRoles(['a', 'b']), null);
  assert.match(unreadableMemberRoles(undefined)!, /no `roles` key/);
  assert.match(unreadableMemberRoles(['a', 1])!, /not a role id string/);
  assert.deepEqual(normalizedMemberRoles(['b', 'a']), ['a', 'b']);
  assert.equal(normalizedMemberRoles(undefined), undefined);
  const readable = {
    guildReferences: { rulesChannelId: null, publicUpdatesChannelId: '1', safetyAlertsChannelId: null },
  };
  assert.equal(unreadableGuildReferences(readable), null);
  assert.match(unreadableGuildReferences({})!, /no `guildReferences` block/);
  assert.match(unreadableGuildReferences({ guildReferences: {} })!, /`rules_channel_id`/);
});

test('guildReferenceBlock preserves absence but copies null, and PINNED_GUILD_REFERENCES covers three fields', () => {
  assert.equal(PINNED_GUILD_REFERENCES.length, 3);
  const block = guildReferenceBlock({
    application_id: 'app', system_channel_id: null, rules_channel_id: null, public_updates_channel_id: '9',
  });
  assert.deepEqual(block, {
    applicationId: 'app', systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: '9',
  });
  assert.ok(!('safetyAlertsChannelId' in block), 'absent keys stay absent, not collapsed to null');
});

// --- onboarding references (the 350003 derivation) ---

function referencesSnapshot(onboarding: JsonObject, guildReferences?: JsonObject): Pick<LiveCleanupSnapshot, 'references'> {
  const guild = loadState().guild as JsonObject;
  return {
    references: {
      welcomeScreen: { status: 200, body: {} },
      onboarding: { status: 200, body: onboarding },
      membershipScreening: { status: 200, body: {} },
      guildReferences: guildReferences ?? guildReferenceBlock(guild),
    },
  } as Pick<LiveCleanupSnapshot, 'references'>;
}

const READABLE_GUILD_REFS = { status: 200, body: { enabled: false, default_channel_ids: [], prompts: [] } };

test('onboardingReferencedChannels reads guild pins and Server Guide channels; disabled guides pin nothing', () => {
  const refs = referencesSnapshot(
    { enabled: true, default_channel_ids: ['111'], prompts: [{ id: 'p1', options: [{ channel_ids: ['222', null] }] }] },
    { rulesChannelId: '333', publicUpdatesChannelId: null, safetyAlertsChannelId: '444' },
  );
  assert.deepEqual(onboardingReferencedChannels(refs), [
    { channelId: '111', referencedBy: ['onboarding.default_channel_ids'] },
    { channelId: '222', referencedBy: ['onboarding.prompt:p1'] },
    { channelId: '333', referencedBy: ['guild.rules_channel_id'] },
    { channelId: '444', referencedBy: ['guild.safety_alerts_channel_id'] },
  ]);
  const disabled = referencesSnapshot({ enabled: false, default_channel_ids: ['111'], prompts: [] });
  assert.deepEqual(onboardingReferencedChannels(disabled), []);
});

test('onboardingReferencedChannels refuses unreadable guild refs, non-Guide bodies, and non-200 reads', () => {
  assert.throws(
    () => onboardingReferencedChannels(referencesSnapshot(READABLE_GUILD_REFS.body as JsonObject, {})),
    /no readable `rules_channel_id`/,
  );
  assert.throws(
    () => onboardingReferencedChannels(referencesSnapshot({ message: 'edge interstitial', code: 0 })),
    /not a Server Guide payload/,
  );
  const rateLimited = {
    references: {
      ...referencesSnapshot(READABLE_GUILD_REFS.body as JsonObject).references,
      onboarding: { status: 429, body: {} },
    },
  };
  assert.throws(() => onboardingReferencedChannels(rateLimited), /HTTP 429/);
});

test('archiveOnboardingExclusions keeps only reviewed legacy channels', () => {
  const state = loadState();
  const snapshot = toSnapshot(state, {
    onboardingBody: { enabled: true, default_channel_ids: [LEGACY_CHANNEL_IDS[0], '999000000000000001'], prompts: [] },
  });
  assert.deepEqual(archiveOnboardingExclusions(snapshot).map((entry) => entry.channelId), [LEGACY_CHANNEL_IDS[0]]);
  assert.deepEqual(archiveOnboardingExclusions(toSnapshot(state)), []);
});

// --- signatures, semantic hash, drift comparability ---

test('planSignature and journalSignature are keyed HMACs over the mutable half', () => {
  assert.equal(planSignature('tok', 't', 'h', 'oph').length, 64);
  assert.notEqual(planSignature('tok', 't', 'h', 'oph'), planSignature('other', 't', 'h', 'oph'));
  assert.notEqual(planSignature('tok', 't', 'h', 'oph'), planSignature('tok', 't', 'h', 'oph2'));
  const snapshot = toSnapshot(loadState());
  const manifest = buildManifest(snapshot, '/run/pre.json', [], TOKEN);
  assert.equal(manifest.planSignature.length, 64);
  assert.equal(manifest.journalSignature, journalSignature(TOKEN, manifest));
  assert.notEqual(manifest.journalSignature, journalSignature('other-token', manifest));
});

test('semanticSnapshot sorts volatile orderings away; drift comparability drops traffic fields', () => {
  const snapshot = toSnapshot(loadState());
  const semantic = semanticSnapshot(snapshot);
  assert.equal(sha256(semantic), snapshot.semanticHash);
  const rotated = structuredClone(snapshot);
  rotated.guild = { ...(rotated.guild as JsonObject), features: [...(rotated.guild['features'] as string[])].reverse() };
  assert.equal(sha256(semanticSnapshot(rotated)), snapshot.semanticHash);
  const messaged = structuredClone(snapshot);
  const first = messaged.channels[0]!;
  (first as unknown as JsonObject)['last_message_id'] = '1550000000000000001';
  (first as unknown as JsonObject)['last_pin_timestamp'] = '2026-09-16T13:00:00.000Z';
  assert.equal(driftSemanticHash(messaged), driftSemanticHash(snapshot));
  assert.notEqual(sha256(semanticSnapshot(messaged)), snapshot.semanticHash);
  const boosted = structuredClone(snapshot);
  boosted.guild = { ...(boosted.guild as JsonObject), premium_subscription_count: 6 };
  assert.equal(driftSemanticHash(boosted), driftSemanticHash(snapshot));
  assert.deepEqual(driftComparableChannels([]), []);
});

test('drift projection deletes exactly the volatile fields and nothing else', () => {
  const channel = driftComparableChannel({ id: '1', last_message_id: '5', last_pin_timestamp: 't', name: 'n' });
  assert.deepEqual(channel, { id: '1', name: 'n' });
  const guild = driftComparableGuild({ id: 'g', premium_subscription_count: 5, name: 'n' });
  assert.deepEqual(guild, { id: 'g', name: 'n' });
});

// --- auto-voice classification and drift exclusion ---

test('isAutoVoiceEphemeralChild matches only unreviewed voice children of the auto-voice category', () => {
  assert.equal(isAutoVoiceEphemeralChild({ id: 'new', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }), true);
  assert.equal(isAutoVoiceEphemeralChild({ id: 'reviewed', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }), true);
  assert.equal(isAutoVoiceEphemeralChild({ id: 'new', type: 0, parent_id: AUTO_VOICE_CATEGORY_ID }), false);
  assert.equal(isAutoVoiceEphemeralChild({ id: 'new', type: 2, parent_id: 'other' }), false);
  assert.equal(isAutoVoiceEphemeralChild({ id: 'new', type: 2, parent_id: null }), false);
  // Shape is attacker-controlled: a reviewed legacy id moved under the
  // auto-voice category and flipped to voice wears exactly the ephemeral
  // shape, which is why isDriftExcluded pins reviewed ids by id.
  assert.equal(
    isAutoVoiceEphemeralChild({ id: LEGACY_CHANNEL_IDS[0]!, type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }),
    true,
  );
});

test('isDriftExcluded never drops a reviewed id, and drift helpers name what they drop', () => {
  for (const id of [...ACTIVE_CHANNEL_IDS, ...LEGACY_CHANNEL_IDS, ...ACTIVE_CATEGORY_IDS, ...LEGACY_CATEGORY_IDS]) {
    assert.equal(isDriftExcluded({ id, type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }), false);
  }
  assert.equal(isDriftExcluded({ id: 'ephemeral-1', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID }), true);
  const channels = [
    { id: 'ephemeral-1', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID },
    { id: LEGACY_CHANNEL_IDS[0]!, type: 0, parent_id: LEGACY_CATEGORY_IDS[0] },
  ];
  assert.deepEqual(driftComparableChannels(channels).map((channel) => channel.id), [LEGACY_CHANNEL_IDS[0]]);
  assert.deepEqual(driftExcludedIds(channels), ['ephemeral-1']);
  assert.deepEqual(driftExcludedIds([]), []);
});

test('assertReviewedShape tolerates (and partitions) unreviewed ids outside the legacy tree', () => {
  const state = loadState();
  const extra: Channel[] = [
    { id: 'ephemeral-9', name: 'Hangout #1', type: 2, parent_id: AUTO_VOICE_CATEGORY_ID, position: 0, permission_overwrites: [] },
    { id: 'voice-bot-source', name: 'voice-bot-source', type: 0, parent_id: ACTIVE_CATEGORY_IDS[0], position: 99, permission_overwrites: [] },
  ];
  const snapshot = toSnapshot({ ...state, channels: [...state.channels, ...extra] });
  const result = assertReviewedShape(snapshot);
  assert.equal(result.toleratedUnreviewed.length, 2);
  assert.deepEqual(result.autoVoiceEphemeral.map((channel) => channel.id), ['ephemeral-9']);
  assert.deepEqual(result.otherUnreviewed.map((channel) => channel.id), ['voice-bot-source']);
});

// --- manifest, op hashing, sync reasoning, apply simulation ---

test('buildManifest pins the operation hash, the reviewed id lists, and starts every op pending', () => {
  const snapshot = toSnapshot(loadState());
  const ops = planArchiveOperations(snapshot);
  const expected = JSON.parse(
    readFileSync(new URL('./fixtures/live-cleanup-expected-operations.json', import.meta.url), 'utf8'),
  ) as { operationSemanticHash: string };
  assert.equal(operationSemanticHash(ops), expected.operationSemanticHash);
  const manifest = buildManifest(snapshot, '/run/pre.json', ops, TOKEN);
  assert.equal(manifest.status, 'planned');
  assert.equal(manifest.operationCount, 65);
  assert.equal(manifest.snapshotSemanticHash, snapshot.semanticHash);
  assert.deepEqual(manifest.reviewedLegacyChannelIds, [...LEGACY_CHANNEL_IDS]);
  assert.deepEqual(manifest.reviewedLegacyCategoryIds, [...LEGACY_CATEGORY_IDS]);
  assert.deepEqual(manifest.activeChannelIds, [...ACTIVE_CHANNEL_IDS]);
  assert.deepEqual(manifest.activeCategoryIds, [...ACTIVE_CATEGORY_IDS]);
  assert.ok(manifest.operations.every((op) => op.state === 'pending'));
  assert.equal(manifest.visibilityExemptions.length, 5);
  assert.deepEqual(manifest.onboardingExclusions, []);
  assert.equal(manifest.journalSequence, 0);
});

test('syncedChildIds covers exactly the value-synchronized children of a category op', () => {
  const overwrites = (deny: string): Overwrite[] => [{ id: LIVE_GUILD, type: 0, allow: '0', deny }];
  const snapshot = {
    channels: [
      { id: 'cat-1', name: 'cat', type: 4, parent_id: null, permission_overwrites: overwrites('1024') },
      { id: 'ch-sync', name: 's', type: 0, parent_id: 'cat-1', permission_overwrites: overwrites('1024') },
      { id: 'ch-desync', name: 'd', type: 0, parent_id: 'cat-1', permission_overwrites: overwrites('2048') },
    ] as Channel[],
  };
  const op = {
    objectId: 'cat-1', objectType: 'category',
    inverseWrite: { permission_overwrites: overwrites('1024') },
    write: { permission_overwrites: overwrites('2048') },
    expectedBefore: { permission_overwrites: overwrites('1024') },
  } as CleanupOperation;
  assert.deepEqual(syncedChildIds(snapshot, op), ['ch-sync']);
  assert.deepEqual(syncedChildIds(snapshot, { ...op, objectType: 'channel' }), []);
});

test('inFlightDriftIsOurs allows before/write/live values on children, never a third-party move', () => {
  const overwrites = (deny: string): Overwrite[] => [{ id: LIVE_GUILD, type: 0, allow: '0', deny }];
  const snapshot = {
    channels: [{ id: 'cat-1', name: 'cat', type: 4, parent_id: null, permission_overwrites: overwrites('1024') }],
  } as Pick<LiveCleanupSnapshot, 'channels'>;
  const op = {
    objectId: 'cat-1', objectType: 'category',
    inverseWrite: { permission_overwrites: overwrites('1024') },
    write: { permission_overwrites: overwrites('2048') },
    expectedBefore: { permission_overwrites: overwrites('1024') },
  } as CleanupOperation;
  assert.equal(inFlightDriftIsOurs(snapshot, op, new Map()), false);
  assert.equal(inFlightDriftIsOurs(snapshot, op, new Map([['cat-1', overwrites('1024')]])), true);
});

test('applyOperationOverwrites carries a category PATCH to synchronized children only, and names missing targets', () => {
  const overwrites = (deny: string): Overwrite[] => [{ id: LIVE_GUILD, type: 0, allow: '0', deny }];
  const snapshot = {
    channels: [
      { id: 'cat-1', name: 'cat', type: 4, parent_id: null, permission_overwrites: overwrites('1024') },
      { id: 'ch-sync', name: 's', type: 0, parent_id: 'cat-1', permission_overwrites: overwrites('1024') },
      { id: 'ch-desync', name: 'd', type: 0, parent_id: 'cat-1', permission_overwrites: overwrites('2048') },
    ] as Channel[],
  } as Pick<LiveCleanupSnapshot, 'channels'>;
  applyOperationOverwrites(snapshot, { objectId: 'cat-1', objectType: 'category' }, overwrites('2048'));
  const byId = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  assert.deepEqual(byId.get('cat-1')!.permission_overwrites, overwrites('2048'));
  assert.deepEqual(byId.get('ch-sync')!.permission_overwrites, overwrites('2048'));
  assert.deepEqual(byId.get('ch-desync')!.permission_overwrites, overwrites('2048'));
});

test('applyOperationOverwrites leaves an unsynchronized child where it is, and refuses unknown targets', () => {
  const overwrites = (deny: string): Overwrite[] => [{ id: LIVE_GUILD, type: 0, allow: '0', deny }];
  const snapshot = {
    channels: [
      { id: 'cat-1', name: 'cat', type: 4, parent_id: null, permission_overwrites: overwrites('1024') },
      { id: 'ch-desync', name: 'd', type: 0, parent_id: 'cat-1', permission_overwrites: overwrites('2048') },
    ] as Channel[],
  } as Pick<LiveCleanupSnapshot, 'channels'>;
  applyOperationOverwrites(snapshot, { objectId: 'cat-1', objectType: 'category' }, overwrites('3072'));
  const byId = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  assert.deepEqual(byId.get('cat-1')!.permission_overwrites, overwrites('3072'));
  assert.deepEqual(byId.get('ch-desync')!.permission_overwrites, overwrites('2048'));
  applyOperationOverwrites(snapshot, { objectId: 'ch-desync', objectType: 'channel' }, overwrites('3072'));
  assert.deepEqual(byId.get('ch-desync')!.permission_overwrites, overwrites('3072'));
  assert.deepEqual(byId.get('cat-1')!.permission_overwrites, overwrites('3072'));
  assert.throws(
    () => applyOperationOverwrites(snapshot, { objectId: 'nope', objectType: 'channel' }, []),
    /Channel nope is missing from snapshot/,
  );
  assert.throws(
    () => applyOperationOverwrites(snapshot, { objectId: 'nope', objectType: 'category' }, []),
    /Category nope is missing from snapshot/,
  );
});

// --- journal witness: append, read, authenticate, sequence ---

function witnessDir() {
  const dir = mkdtempSync(join(tmpdir(), 'livecleanup-unit-'));
  return { dir, manifestPath: join(dir, 'rollback.json') };
}

function plannedManifest(sequence: number, operations: CleanupManifest['operations'] = []): CleanupManifest {
  const manifest: CleanupManifest = {
    version: 1,
    kind: 'live-clean-slate-cleanup',
    phase: ARCHIVE_PHASE,
    status: 'planned',
    generatedAt: '2026-09-16T12:20:52.000Z',
    applicationId: LIVE_APP,
    guildId: LIVE_GUILD,
    snapshotPath: '/run/pre.json',
    snapshotGeneratedAt: '2026-09-16T12:20:52.000Z',
    snapshotSemanticHash: 'hash',
    planSignature: 'plan',
    journalSignature: '',
    journalSequence: sequence,
    operationSemanticHash: 'ophash',
    operationCount: operations.length,
    reviewedLegacyChannelIds: [...LEGACY_CHANNEL_IDS],
    reviewedLegacyCategoryIds: [...LEGACY_CATEGORY_IDS],
    activeChannelIds: [...ACTIVE_CHANNEL_IDS],
    activeCategoryIds: [...ACTIVE_CATEGORY_IDS],
    visibilityExemptions: [],
    onboardingExclusions: [],
    operations,
  };
  manifest.journalSignature = journalSignature(TOKEN, manifest);
  return manifest;
}

const requestingOp = (id: string): CleanupManifest['operations'][number] => ({
  version: 1,
  sequence: 1,
  id,
  phase: ARCHIVE_PHASE,
  kind: 'patch-channel-overwrites',
  objectType: 'channel',
  objectId: 'chan-1',
  expectedBefore: { permission_overwrites: [] },
  write: { permission_overwrites: [] },
  inverseWrite: { permission_overwrites: [] },
  state: 'requesting',
});

test('journalWitnessPath appends .witness, and the witness authenticates every record', () => {
  const { manifestPath } = witnessDir();
  assert.equal(journalWitnessPath(manifestPath), `${manifestPath}.witness`);
  const witness = journalWitnessPath(manifestPath);
  appendJournalWitness(TOKEN, witness, 1, 'intent', 'sig-1', 'op-a');
  const [record] = readJournalWitness(TOKEN, witness);
  assert.equal(record!.sequence, 1);
  assert.equal(record!.phase, 'intent');
  assert.equal(record!.journalSignature, 'sig-1');
  assert.equal(record!.inFlightId, 'op-a');
  appendJournalWitness(TOKEN, witness, 1, 'commit', 'sig-1', 'op-a');
  assert.deepEqual(
    readJournalWitness(TOKEN, witness).map((entry) => `${entry.sequence}/${entry.phase}`),
    ['1/intent', '1/commit'],
  );
  assert.throws(() => readJournalWitness('wrong-token', witness), /not authentic/);
});

test('appendJournalWitness refuses a record that would make the log unreadable', () => {
  const { manifestPath } = witnessDir();
  const witness = journalWitnessPath(manifestPath);
  appendJournalWitness(TOKEN, witness, 1, 'intent', 'sig-1', null);
  assert.throws(
    () => appendJournalWitness(TOKEN, witness, 1, 'intent', 'sig-1', null),
    /would become unreadable/,
  );
  assert.throws(
    () => appendJournalWitness(TOKEN, witness, 2, 'intent', 'sig-2', null),
    /would become unreadable/,
  );
});

test('an unreadable witness line reads as spliced, and a torn tail is dropped', () => {
  const { manifestPath } = witnessDir();
  const witness = journalWitnessPath(manifestPath);
  appendJournalWitness(TOKEN, witness, 1, 'intent', 'sig-1', null);
  appendFileSync(witness, 'not-json\n');
  assert.throws(() => readJournalWitness(TOKEN, witness), /not readable/);
  const { manifestPath: tornPath } = witnessDir();
  const torn = journalWitnessPath(tornPath);
  appendJournalWitness(TOKEN, torn, 1, 'intent', 'sig-1', null);
  appendFileSync(torn, '{"torn": true');
  assert.deepEqual(
    readJournalWitness(TOKEN, torn).map((entry) => `${entry.sequence}/${entry.phase}`),
    ['1/intent'],
  );
});

test('reconcileJournalWitness closes an interrupted checkpoint as commit or abort', () => {
  // The manifest write landed: intent closes as commit.
  const landed = witnessDir();
  const landedWitness = journalWitnessPath(landed.manifestPath);
  const landedManifest = plannedManifest(1);
  appendJournalWitness(TOKEN, landedWitness, 1, 'intent', landedManifest.journalSignature, null);
  writeFileSync(landed.manifestPath, JSON.stringify(landedManifest));
  assert.deepEqual(reconcileJournalWitness(TOKEN, landed.manifestPath), { outcome: 'committed', sequence: 1 });

  // The manifest write did not land: intent closes as abort, sequence retried.
  const lost = witnessDir();
  const lostWitness = journalWitnessPath(lost.manifestPath);
  const durable = plannedManifest(1);
  appendJournalWitness(TOKEN, lostWitness, 1, 'intent', durable.journalSignature, null);
  appendJournalWitness(TOKEN, lostWitness, 1, 'commit', durable.journalSignature, null);
  appendJournalWitness(TOKEN, lostWitness, 2, 'intent', 'sig-2', null);
  writeFileSync(lost.manifestPath, JSON.stringify(durable));
  assert.deepEqual(reconcileJournalWitness(TOKEN, lost.manifestPath), { outcome: 'aborted', sequence: 2 });
});

test('reconcileJournalWitness reports absent/clean and refuses a corrupt manifest or a non-crash state', () => {
  const missing = witnessDir();
  assert.deepEqual(reconcileJournalWitness(TOKEN, missing.manifestPath), { outcome: 'absent' });
  const clean = witnessDir();
  const cleanWitness = journalWitnessPath(clean.manifestPath);
  appendJournalWitness(TOKEN, cleanWitness, 1, 'intent', 'sig-1', null);
  appendJournalWitness(TOKEN, cleanWitness, 1, 'commit', 'sig-1', null);
  assert.deepEqual(reconcileJournalWitness(TOKEN, clean.manifestPath), { outcome: 'clean' });

  const corrupt = witnessDir();
  const corruptWitness = journalWitnessPath(corrupt.manifestPath);
  appendJournalWitness(TOKEN, corruptWitness, 1, 'intent', 'sig-1', null);
  writeFileSync(corrupt.manifestPath, '{"not": "a manifest"}');
  assert.throws(() => reconcileJournalWitness(TOKEN, corrupt.manifestPath), /not valid/);

  const neither = witnessDir();
  const neitherWitness = journalWitnessPath(neither.manifestPath);
  appendJournalWitness(TOKEN, neitherWitness, 1, 'intent', 'sig-a', null);
  appendJournalWitness(TOKEN, neitherWitness, 1, 'commit', 'sig-a', null);
  appendJournalWitness(TOKEN, neitherWitness, 2, 'intent', 'sig-b', null);
  writeFileSync(neither.manifestPath, JSON.stringify(plannedManifest(99)));
  assert.throws(() => reconcileJournalWitness(TOKEN, neither.manifestPath), /not an interrupted checkpoint/);
});

// --- checkpoint binding and the in-flight exception ---

test('manifestInFlightId reports the single requesting op, or null otherwise', () => {
  assert.equal(manifestInFlightId({ operations: [] }), null);
  assert.equal(manifestInFlightId({ operations: [{ ...requestingOp('a'), state: 'applied' as const }] }), null);
  assert.equal(manifestInFlightId({ operations: [requestingOp('a')] }), 'a');
  assert.equal(manifestInFlightId({ operations: [requestingOp('a'), requestingOp('b')] }), null);
});

test('assertLatestCheckpoint accepts the latest durable checkpoint and refuses replays', () => {
  const { manifestPath } = witnessDir();
  const witness = journalWitnessPath(manifestPath);
  assert.throws(() => assertLatestCheckpoint(TOKEN, plannedManifest(0), manifestPath), /witness .* is missing/);
  writeFileSync(witness, '');
  assert.throws(() => assertLatestCheckpoint(TOKEN, plannedManifest(0), manifestPath), /records no checkpoint/);
});

test('assertLatestCheckpoint accepts a committed checkpoint and a landed-but-uncommitted tip', () => {
  const { manifestPath } = witnessDir();
  const witness = journalWitnessPath(manifestPath);
  const first = plannedManifest(1);
  appendJournalWitness(TOKEN, witness, 1, 'intent', first.journalSignature, 'op-a');
  // The write landed but its commit record was lost: still the latest.
  assert.doesNotThrow(() => assertLatestCheckpoint(TOKEN, first, manifestPath));
  appendJournalWitness(TOKEN, witness, 1, 'commit', first.journalSignature, 'op-a');
  assert.doesNotThrow(() => assertLatestCheckpoint(TOKEN, first, manifestPath));
  const superseded = { ...first, journalSequence: 0, journalSignature: journalSignature(TOKEN, { ...first, journalSequence: 0 }) };
  assert.throws(() => assertLatestCheckpoint(TOKEN, superseded, manifestPath), /superseded checkpoint/);
});

test('inFlightExceptionIsAvailable needs one in-flight op and a witness that never contradicts it', () => {
  const none = witnessDir();
  assert.equal(
    inFlightExceptionIsAvailable(TOKEN, plannedManifest(0, [requestingOp('a')]), none.manifestPath),
    false,
  );
  const run = witnessDir();
  const witness = journalWitnessPath(run.manifestPath);
  const manifest = plannedManifest(1, [requestingOp('a')]);
  writeFileSync(run.manifestPath, JSON.stringify(manifest));
  appendJournalWitness(TOKEN, witness, 1, 'intent', manifest.journalSignature, 'a');
  appendJournalWitness(TOKEN, witness, 1, 'commit', manifest.journalSignature, 'a');
  assert.equal(inFlightExceptionIsAvailable(TOKEN, manifest, run.manifestPath), true);
  appendJournalWitness(TOKEN, witness, 2, 'intent', 'sig-2', 'b');
  appendJournalWitness(TOKEN, witness, 2, 'commit', 'sig-2', 'b');
  assert.equal(inFlightExceptionIsAvailable(TOKEN, manifest, run.manifestPath), false);
  assert.equal(inFlightExceptionIsAvailable(TOKEN, plannedManifest(1, []), run.manifestPath), false);
});

// --- primitives and constants ---

test('stable is order-insensitive for objects and sha256 is a 64-hex keyed digest', () => {
  assert.equal(stable({ b: 1, a: [3, 2] }), stable({ a: [3, 2], b: 1 }));
  assert.notEqual(stable({ a: 1 }), stable({ a: 2 }));
  assert.strictEqual(stable(undefined), undefined);
  assert.match(sha256({}), /^[0-9a-f]{64}$/);
  assert.equal(sha256('x'), sha256('x'));
  assert.notEqual(sha256('x'), sha256('y'));
});

test('phase and id-list constants pin the reviewed live-cleanup scope', () => {
  assert.equal(ARCHIVE_PHASE, 'archive-legacy');
  assert.equal(OVERWRITE_CEILING_PER_CHANNEL, 500);
  assert.equal(SNAPSHOT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  assert.equal(VIEW_CHANNEL, 1n << 10n);
  assert.equal(ADMINISTRATOR, 1n << 3n);
  assert.equal(LEGACY_CHANNEL_IDS.length, 105);
  assert.equal(LEGACY_CATEGORY_IDS.length, 18);
  assert.equal(ACTIVE_CHANNEL_IDS.length, 17);
  assert.equal(ACTIVE_CATEGORY_IDS.length, 4);
  assert.equal(AUTO_VOICE_CATEGORY_ID, ACTIVE_CATEGORY_IDS[2]);
});

// --- sibling-module gaps: activation, guildConfig, clean-slate ---

test('isLiveCapability guards the capability list, and botTokenFrom reads env then falls through to null', () => {
  assert.equal(isLiveCapability('moderation'), true);
  assert.equal(isLiveCapability('tickets'), false);
  assert.equal(isLiveCapability(''), false);
  assert.equal(botTokenFrom({ DISCORD_BOT_TOKEN: 'tok-1' }), 'tok-1');
  assert.equal(botTokenFrom({ DISCORD_TOKEN: 'tok-2' }), 'tok-2');
  assert.equal(botTokenFrom({}), null);
  // Only credential files are trimmed; a whitespace env value passes through as-is.
  assert.equal(botTokenFrom({ DISCORD_BOT_TOKEN: '  ' }), '  ');
});

test('snapshotCounts tallies roles, channels, overwrites and emojis with zero drift', () => {
  const snapshot: GuildConfigSnapshot = {
    version: 1,
    generatedAt: '2026-09-08T00:00:00.000Z',
    applicationId: 'app',
    guildId: 'guild',
    guild: {},
    roles: [
      { id: 'r1', name: 'a', managed: false, color: 0, hoist: false, permissions: '0', mentionable: false, position: 0 },
    ],
    channels: [
      { id: 'c1', name: 'general', type: 0, parent_id: null, position: 0, permission_overwrites: [{ id: 'g', type: 0, allow: '0', deny: '0' }] },
      { id: 'c2', name: 'Lobby', type: 2, parent_id: null, position: 1, permission_overwrites: [] },
    ],
    emojis: [
      { id: 'e1', name: 'two', roles: [], require_colons: true, managed: false, animated: false, available: true },
    ],
  };
  assert.deepEqual(snapshotCounts(snapshot), { roles: 1, channels: 2, overwrites: 1, emojis: 1, drift: 0 });
});

test('acceptedSpec builds the owner-accepted tree from the clean-slate constants', () => {
  const spec = acceptedSpec('guild-1') as {
    guild: { description: string };
    roles: Array<{ name: string }>;
    categories: Array<{ name: string; channels: Array<{ name: string; everyoneOverwrite: { id: string } }> }>;
  };
  assert.equal(spec.guild.description.length > 0, true);
  assert.deepEqual(spec.roles.map((role) => role.name), ['Owner', 'Moderator']);
  assert.deepEqual(spec.categories.map((category) => category.name), CATEGORIES.map((category) => category.name));
  for (const category of spec.categories) {
    for (const channel of category.channels) {
      assert.equal(channel.everyoneOverwrite.id, 'guild-1');
    }
  }
});

test('clean-slate copy constants pin the accepted onboarding words', () => {
  assert.match(WELCOME_DESCRIPTION, /small on purpose/);
  assert.match(STARTER_MESSAGE, /whole application/);
  assert.match(SCREENING_DESCRIPTION, /only membership gate/);
  assert.equal(RULES.length, 4);
});
