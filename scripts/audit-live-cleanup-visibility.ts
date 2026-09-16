/**
 * Independent post-plan visibility audit for the archive-legacy phase.
 *
 * Re-evaluates the Discord permission stack for every inventoried principal against
 * the state the plan would produce, using an evaluator written separately from the
 * planner's own assertion, and reports every principal that can still see any of the
 * 112 reviewed legacy channels. A clean run is: only the guild Owner, Owen, and
 * Administrator holders remain — and the Administrator set matches the manifest's
 * recorded visibilityExemptions exactly.
 *
 * Defaults to the production-shaped fixture. Point it at a real dry-run's
 * pre-snapshot to audit the plan the operator is about to apply:
 *
 *   node scripts/audit-live-cleanup-visibility.ts
 *   node scripts/audit-live-cleanup-visibility.ts --snapshot "$RUN_DIR/snapshot/pre.json"
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMINISTRATOR,
  applyOperationOverwrites,
  archiveOnboardingExclusions,
  archiveVisibilityExemptions,
  type Channel,
  type JsonObject,
  LEGACY_CHANNEL_IDS,
  type LiveCleanupSnapshot,
  type Member,
  normalizeOverwrites,
  type Overwrite,
  planArchiveOperations,
  type Role,
  VIEW_CHANNEL,
  withSemanticHash,
} from '../src/redesign/live-cleanup.ts';
import { LIVE_BOT_APPLICATION_ID } from '../src/staging/spec.ts';

type FixtureMember = { user: { id: string; username: string; bot: boolean }; roles: string[]; premium_since: string | null; pending: boolean };
type FixtureState = { guild: JsonObject; roles: Role[]; channels: Channel[]; members: FixtureMember[] };

const snapshotArgument = process.argv.indexOf('--snapshot');
if (snapshotArgument !== -1 && !process.argv[snapshotArgument + 1]) {
  console.error('--snapshot needs a path.');
  process.exit(2);
}
const snapshotPath = snapshotArgument === -1 ? null : process.argv[snapshotArgument + 1]!;

function fixtureSnapshot(): LiveCleanupSnapshot {
  const state = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/live-cleanup-production-state.json', import.meta.url)), 'utf8')) as FixtureState;
  return withSemanticHash({
    version: 1,
    generatedAt: '1970-01-01T00:00:00.000Z',
    applicationId: LIVE_BOT_APPLICATION_ID,
    guildId: String(state.guild.id),
    guild: state.guild,
    roles: state.roles,
    channels: state.channels.map((channel) => ({ ...channel, permission_overwrites: normalizeOverwrites(channel.permission_overwrites ?? []) })),
    members: state.members.map((member) => ({
      id: member.user.id,
      bot: Boolean(member.user.bot),
      username: member.user.username ?? null,
      roles: [...member.roles].sort(),
      premiumSince: member.premium_since ?? null,
      pending: Boolean(member.pending),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    integrations: [],
    references: {},
  });
}

const snapshot: LiveCleanupSnapshot = snapshotPath === null
  ? fixtureSnapshot()
  : JSON.parse(readFileSync(snapshotPath, 'utf8')) as LiveCleanupSnapshot;
console.log(`source: ${snapshotPath ?? 'test/fixtures/live-cleanup-production-state.json'}`);

// Deliberately a second implementation of the Discord permission stack, so this is
// not just the planner agreeing with itself.
function canSee(member: Member, roles: Map<string, Role>, everyoneId: string, overwrites: Overwrite[]): boolean {
  let permissions = BigInt(roles.get(everyoneId)?.permissions ?? '0');
  for (const roleId of member.roles) permissions |= BigInt(roles.get(roleId)?.permissions ?? '0');
  if ((permissions & ADMINISTRATOR) !== 0n) return true;
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === everyoneId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === everyoneId || !member.roles.includes(overwrite.id)) continue;
    allow |= BigInt(overwrite.allow);
    deny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~deny) | allow;
  const mine = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.id);
  if (mine) permissions = (permissions & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return (permissions & VIEW_CHANNEL) !== 0n;
}

const operations = planArchiveOperations(snapshot);
const after = structuredClone(snapshot);
for (const operation of operations) applyOperationOverwrites(after, operation, operation.write.permission_overwrites);

const roleById = new Map(snapshot.roles.map((role) => [role.id, role]));
const ownerId = String(snapshot.guild.owner_id);
// Channels Discord will not let this phase hide while the Server Guide points at
// them. They are excluded from the sweep rather than allowed to fail it — but they
// are printed, because an audit that quietly narrows its own scope is worse than a
// red one.
const onboardingExclusions = archiveOnboardingExclusions(snapshot);
const excludedIds = new Set(onboardingExclusions.map((exclusion) => exclusion.channelId));
const auditedIds = LEGACY_CHANNEL_IDS.filter((id) => !excludedIds.has(id));
const visible = new Map<string, string[]>();
for (const member of snapshot.members) {
  const seen = auditedIds.filter((id) => {
    const channel = after.channels.find((item) => item.id === id)!;
    return canSee(member, roleById, snapshot.guildId, normalizeOverwrites(channel.permission_overwrites ?? []));
  });
  if (seen.length > 0) visible.set(member.id, [...seen]);
}

const exemptions = new Map(archiveVisibilityExemptions(snapshot).map((item) => [item.memberId, item.reason]));
let unexplained = 0;
console.log(`operations: ${operations.length} · reviewed legacy channels: ${LEGACY_CHANNEL_IDS.length} · audited: ${auditedIds.length} · principals: ${snapshot.members.length}`);
for (const exclusion of onboardingExclusions) {
  const channel = snapshot.channels.find((item) => item.id === exclusion.channelId);
  console.log(`  NOT-AUDITED   ${exclusion.channelId} ${channel?.name ?? '?'} — Discord refuses to hide it while referenced by ${exclusion.referencedBy.join(', ')}`);
}
for (const [memberId, seen] of [...visible].sort((a, b) => a[0].localeCompare(b[0]))) {
  const member = snapshot.members.find((item) => item.id === memberId)!;
  const reason = memberId === ownerId ? 'owner' : memberId === LIVE_BOT_APPLICATION_ID ? 'owen' : exemptions.get(memberId) ?? 'UNEXPLAINED';
  if (reason === 'UNEXPLAINED') unexplained++;
  console.log(`  ${reason.padEnd(13)} ${member.bot ? 'bot   ' : 'human '} ${memberId} sees ${seen.length}`);
}
const recordedAdmins = [...exemptions].filter(([, reason]) => reason === 'administrator').map(([id]) => id).sort();
const observedNonOwnerVisible = [...visible.keys()].filter((id) => id !== ownerId && id !== LIVE_BOT_APPLICATION_ID).sort();
console.log(`manifest administrator exemptions: ${recordedAdmins.length}`);
console.log(`observed non-Owner/non-Owen principals retaining visibility: ${observedNonOwnerVisible.length}`);
console.log(`unexplained visibility: ${unexplained}`);
if (unexplained > 0 || JSON.stringify(recordedAdmins) !== JSON.stringify(observedNonOwnerVisible)) {
  console.error('AUDIT FAILED: visibility is not fully explained by the recorded exemptions.');
  process.exit(1);
}
console.log('AUDIT PASSED');
