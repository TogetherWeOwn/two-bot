import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applicationIdFromToken, LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../src/staging/spec.ts';
import {
  ADMINISTRATOR,
  appendJournalWitness,
  assertLatestCheckpoint,
  type Channel,
  type CleanupManifest,
  driftComparableChannel,
  driftComparableChannels,
  driftComparableGuild,
  driftExcludedIds,
  driftSemanticHash,
  guildReferenceBlock,
  type JsonObject,
  inFlightDriftIsOurs,
  inFlightExceptionIsAvailable,
  journalSignature,
  journalWitnessPath,
  type LiveCleanupSnapshot,
  manifestInFlightId,
  normalizeOverwrites,
  normalizedChannel,
  normalizedMemberRoles,
  semanticSnapshot,
  sha256,
  stable,
  operationSemanticHash,
  planArchiveOperations,
  planSignature,
  reconcileJournalWitness,
  type Role,
  syncedChildIds,
  unreadableOverwrites,
} from '../src/redesign/live-cleanup.ts';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--confirm-main-guild');
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? LIVE_GUILD_ID;

type ApiResult<T> = { status: number; body: T | null };
type RawMember = { user?: { id: string; username?: string; bot?: boolean }; roles?: string[]; premium_since?: string | null; pending?: boolean };

function die(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}
function value(name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const found = argv[index + 1];
  if (!found || found.startsWith('--')) die(2, `--${name} needs a value.`);
  return found;
}
function apiBase(): string {
  const raw = process.env.MAIN_GUILD_API_BASE;
  if (!raw) return 'https://discord.com/api/v10';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { die(2, `MAIN_GUILD_API_BASE is not a URL: ${raw}`); }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) die(2, `MAIN_GUILD_API_BASE only accepts loopback test seams. Got ${parsed.hostname}.`);
  return raw.replace(/\/$/, '');
}
function atomicJson(path: string, valueToWrite: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(valueToWrite, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}
/**
 * The only sanctioned way to persist the manifest. Re-signs the mutable journal on
 * every write so a manifest edited between runs fails verification rather than being
 * trusted — journal state is what grants the in-flight exception below — and extends
 * the append-only witness log so a *superseded* checkpoint cannot be replayed back
 * over a run that has moved on.
 */
function checkpoint(path: string, valueToWrite: CleanupManifest): void {
  valueToWrite.journalSequence += 1;
  valueToWrite.journalSignature = journalSignature(token!, valueToWrite);
  const witness = journalWitnessPath(path);
  const inFlightId = manifestInFlightId(valueToWrite);
  appendJournalWitness(token!, witness, valueToWrite.journalSequence, 'intent', valueToWrite.journalSignature, inFlightId);
  atomicJson(path, valueToWrite);
  appendJournalWitness(token!, witness, valueToWrite.journalSequence, 'commit', valueToWrite.journalSignature, inFlightId);
}

if (!token) die(2, 'Missing DISCORD_BOT_TOKEN.');
if (applicationIdFromToken(token) !== LIVE_BOT_APPLICATION_ID) die(2, `This token is not live Owen (${LIVE_BOT_APPLICATION_ID}). Nothing was contacted.`);
if (guildId !== LIVE_GUILD_ID) die(2, `DISCORD_GUILD_ID is not the live guild ${LIVE_GUILD_ID}. Nothing was contacted.`);
if (!APPLY || !CONFIRMED) die(2, 'Rollback requires both --confirm-main-guild and --apply. Nothing was contacted.');
const manifestPath = resolve(value('manifest') ?? die(2, '--manifest is required.'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
if (manifest.version !== 1 || manifest.kind !== 'live-clean-slate-cleanup' || manifest.applicationId !== LIVE_BOT_APPLICATION_ID || manifest.guildId !== LIVE_GUILD_ID) die(2, 'Manifest identity is invalid.');
const snapshot = JSON.parse(readFileSync(resolve(manifest.snapshotPath), 'utf8')) as LiveCleanupSnapshot;
if (snapshot.generatedAt !== manifest.snapshotGeneratedAt) die(2, 'Pre-snapshot timestamp does not match the manifest.');
if (snapshot.semanticHash !== manifest.snapshotSemanticHash || snapshot.semanticHash !== sha256(semanticSnapshot(snapshot))) die(2, 'Pre-snapshot hash does not match the manifest.');
// Re-planned from the hash-bound pre-snapshot above, never from a fresh read. That is what
// keeps the planner's Server-Guide refusals — an unreadable `/onboarding`, a pinned channel
// synchronized with its category — from ever stranding a rollback: the references this
// re-plan reads were captured and hashed before the first write, so it cannot start
// refusing because the live guild changed underneath a run that needs undoing.
const deterministicOperations = planArchiveOperations(snapshot);
const deterministicHash = operationSemanticHash(deterministicOperations);

/**
 * Everything rollback needs to believe about a manifest before it will act on it, as a
 * function rather than a run of top-level checks, because reconciliation has to apply
 * the same bar. Closing an open checkpoint appends to the witness, and a `commit`
 * written for a manifest this would have rejected can never be aborted instead — the
 * run is then stranded with no way back (TOG-2975).
 */
function assertRollbackManifest(candidate: CleanupManifest): void {
  if (candidate.version !== 1 || candidate.kind !== 'live-clean-slate-cleanup' || candidate.applicationId !== LIVE_BOT_APPLICATION_ID || candidate.guildId !== LIVE_GUILD_ID) throw new Error('Manifest identity is invalid.');
  if (candidate.snapshotGeneratedAt !== snapshot.generatedAt) throw new Error('Pre-snapshot timestamp does not match the manifest.');
  if (candidate.snapshotSemanticHash !== snapshot.semanticHash) throw new Error('Pre-snapshot hash does not match the manifest.');
  if (candidate.planSignature !== planSignature(token!, snapshot.generatedAt, snapshot.semanticHash, deterministicHash)) throw new Error('Manifest plan signature is invalid for this token, snapshot, and operation hash.');
  // The plan signature covers only immutable plan content. Operation states select which
  // operations rollback touches and which one gets the in-flight exception, so they are
  // authenticated separately — otherwise relabelling an applied operation `requesting`
  // would be enough to make rollback overwrite unrelated live drift.
  if (candidate.journalSignature !== journalSignature(token!, candidate)) throw new Error('Manifest journal signature is invalid; operation states or timestamps were modified outside a run.');
  if (candidate.operationCount !== deterministicOperations.length || candidate.operationSemanticHash !== deterministicHash || candidate.operations.length !== deterministicOperations.length) throw new Error('Manifest operation count/hash differs from the deterministic plan.');
  if (stable(candidate.operations.map(({ state: _state, requestStartedAt: _requestStartedAt, appliedAt: _appliedAt, rolledBackAt: _rolledBackAt, ...operation }) => operation)) !== stable(deterministicOperations)) throw new Error('Manifest operation bodies differ from the deterministic plan.');
}
try {
  assertRollbackManifest(manifest);
} catch (error) {
  die(2, error instanceof Error ? error.message : String(error));
}
// Authentic is not current. Every checkpoint an apply wrote stays validly signed, so
// without this a saved `requesting` checkpoint could be dropped back over a finished
// run to buy the in-flight exception and have rollback overwrite later live state.
// An apply that died inside `checkpoint()` leaves the witness tip an uncommitted
// `intent`. Rollback is the recovery path for exactly that kind of interruption, so it
// closes the open checkpoint first — otherwise its own next checkpoint would append a
// second `intent` and leave the log unreadable (TOG-2960).
try {
  const reconciled = reconcileJournalWitness(token, manifestPath, assertRollbackManifest);
  if (reconciled.outcome === 'committed') console.log(`RECOVERED checkpoint ${reconciled.sequence}: its manifest write landed, only the commit record was lost.`);
  if (reconciled.outcome === 'aborted') console.log(`RECOVERED checkpoint ${reconciled.sequence}: its manifest write never landed, so the checkpoint is abandoned and the sequence retried.`);
  assertLatestCheckpoint(token, manifest, manifestPath);
} catch (error) {
  die(2, error instanceof Error ? error.message : String(error));
}
const API = apiBase();

async function api<T>(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = (await response.json().catch(() => null)) as T | null;
  return { status: response.status, body: responseBody };
}
async function mustGet<T>(path: string, label: string): Promise<T> {
  const result = await api<T>('GET', path);
  if (result.status === 429) die(1, `${label}: Discord returned 429. Stop; no retry was attempted.`);
  if (result.status !== 200 || result.body === null) die(1, `${label}: HTTP ${result.status}.`);
  return result.body;
}
async function members(): Promise<RawMember[]> {
  const out: RawMember[] = [];
  let after = '0';
  for (;;) {
    const page = await mustGet<RawMember[]>(`/guilds/${guildId}/members?limit=1000&after=${after}`, 'Read members');
    out.push(...page);
    if (page.length < 1000) return out;
    const last = page.at(-1)?.user?.id;
    if (!last) die(1, 'Member pagination returned an entry without an id.');
    after = last;
  }
}

function nonChannelSemantic(
  currentGuild: JsonObject,
  currentRoles: Role[],
  rawMembers: RawMember[],
  currentIntegrations: JsonObject[],
  currentWelcome: ApiResult<JsonObject>,
  currentOnboarding: ApiResult<JsonObject>,
  currentScreening: ApiResult<JsonObject>,
): JsonObject {
  // Built through `semanticSnapshot` rather than hand-mirrored, so both sides of the
  // comparison below get exactly the same canonicalization. A local copy is how the
  // sorted-`guild.features` fix first showed up here: the pre-snapshot side was
  // canonical, this side was raw, and every rollback read it as live guild drift.
  //
  // This is the ninth live-vs-live comparison and the second that does not run through
  // `driftSemanticHash`, so — like the untouched-channel walk below — it needs the volatile
  // projection applied by hand, here and on the pre-snapshot side at `snapshotNonChannel`.
  // It is the guild-side gate a lapsing boost would reach: rollback's preflight, which is the
  // recovery path for a torn apply and so the one run that has to work after something has
  // already gone wrong.
  const { channels: _channels, ...nonChannel } = semanticSnapshot({
    version: 1,
    generatedAt: '',
    applicationId: LIVE_BOT_APPLICATION_ID,
    guildId,
    guild: driftComparableGuild(currentGuild),
    roles: currentRoles,
    channels: [],
    members: rawMembers.map((member) => ({
      id: member.user?.id ?? '',
      bot: Boolean(member.user?.bot),
      username: member.user?.username ?? null,
      roles: normalizedMemberRoles(member.roles),
      premiumSince: member.premium_since ?? null,
      pending: Boolean(member.pending),
    })).filter((member) => member.id),
    integrations: currentIntegrations.map((integration) => {
      const linkedApplication = integration.application as JsonObject | undefined;
      return {
        id: typeof integration.id === 'string' ? integration.id : '',
        name: typeof integration.name === 'string' ? integration.name : null,
        applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
        roleId: typeof integration.role_id === 'string' ? integration.role_id : null,
      };
    }),
    references: {
      welcomeScreen: { status: currentWelcome.status, body: currentWelcome.body },
      onboarding: { status: currentOnboarding.status, body: currentOnboarding.body },
      membershipScreening: { status: currentScreening.status, body: currentScreening.body },
      guildReferences: guildReferenceBlock(currentGuild),
    },
  });
  return nonChannel;
}

// The pre-snapshot side of the comparison at `Rollback preflight found non-channel drift`.
// `driftComparableGuild` here is the other half of the one in `nonChannelSemantic`: one-sided
// it would refuse every rollback outright rather than only on a boost change. The stored-hash
// verification above is deliberately *not* built from this — it re-derives the raw
// `semanticSnapshot(snapshot)` itself, so what the plan signature covers is unaffected.
const snapshotSemantic = semanticSnapshot({ ...snapshot, guild: driftComparableGuild(snapshot.guild) });
const { channels: _snapshotChannels, ...snapshotNonChannel } = snapshotSemantic;

const [me, guilds, guild, roles, currentMembers, integrations, application, welcome, onboarding, screening] = await Promise.all([
  mustGet<{ id: string }>('/users/@me', 'Authenticate bot'),
  mustGet<Array<{ id: string }>>('/users/@me/guilds', 'Read bot guilds'),
  mustGet<JsonObject>(`/guilds/${guildId}`, 'Read guild'),
  mustGet<Role[]>(`/guilds/${guildId}/roles`, 'Read roles'),
  members(),
  mustGet<JsonObject[]>(`/guilds/${guildId}/integrations`, 'Read integrations'),
  mustGet<JsonObject>('/oauth2/applications/@me', 'Read application'),
  api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`),
  api<JsonObject>('GET', `/guilds/${guildId}/onboarding`),
  api<JsonObject>('GET', `/guilds/${guildId}/member-verification`),
]);
if (me.id !== LIVE_BOT_APPLICATION_ID || application.id !== LIVE_BOT_APPLICATION_ID || !guilds.some((item) => item.id === guildId) || guild.name !== LIVE_GUILD_NAME) die(1, 'Rollback identity preflight failed.');
if (stable(nonChannelSemantic(guild, roles, currentMembers, integrations, welcome, onboarding, screening)) !== stable(snapshotNonChannel)) die(1, `Rollback preflight found non-channel drift from the pre-snapshot. This gate fails closed by design: a refusal is the intended path, not evidence the guild is corrupt. Name the fields with: node scripts/live-cleanup-drift-diff.ts ${JSON.stringify(resolve(manifest.snapshotPath))} <a fresh capture>/snapshot/pre.json — it prints one "guild field drift:" line per field. A field that moved with nobody acting on the guild belongs in DRIFT_VOLATILE_GUILD_FIELDS (src/redesign/live-cleanup.ts); add it and re-run. Anything an administrator really changed must keep refusing.`);
const botMember = currentMembers.find((member) => member.user?.id === LIVE_BOT_APPLICATION_ID && member.user.bot);
if (!botMember || !roles.some((role) => botMember.roles?.includes(role.id) && (BigInt(role.permissions) & ADMINISTRATOR) !== 0n)) die(1, 'Rollback preflight: Owen does not have Administrator.');
const preRollbackChannels = await mustGet<Channel[]>(`/guilds/${guildId}/channels`, 'Read rollback channel preflight');
// Auto-voice ephemeral children are dropped from both sides of every inventory and hash
// comparison in this script, exactly as they are in apply — see `isDriftExcluded`. Rollback
// is the recovery path for a torn apply, so leaving it churn-sensitive meant the one run
// that has to work after something went wrong was the one a filling lobby could refuse
// (TOG-3141, M3) or strand half-done (M4). A reviewed ID can never be dropped, so nothing
// this script writes or restores leaves the comparison.
for (const id of driftExcludedIds(preRollbackChannels)) {
  console.log(`  TOLERATED ${id} ${preRollbackChannels.find((channel) => channel.id === id)?.name ?? '?'} — auto-voice ephemeral child, excluded from the rollback comparison`);
}
const comparablePreRollback = driftComparableChannels(preRollbackChannels);
const comparableSnapshotChannels = driftComparableChannels(snapshot.channels);
if (stable(comparablePreRollback.map((channel) => channel.id).sort()) !== stable(comparableSnapshotChannels.map((channel) => channel.id).sort())) die(1, 'Rollback preflight channel/category inventory drifted from the pre-snapshot.');
const preRollbackById = new Map(preRollbackChannels.map((channel) => [channel.id, channel]));
function operationState(operation: CleanupManifest['operations'][number], channels: Map<string, Channel>): 'applied' | 'inverse' | 'parent_inverse' | 'mixed' | 'drifted' {
  const expectedApplied = stable(normalizeOverwrites(operation.write.permission_overwrites));
  const expectedInverse = stable(normalizeOverwrites(operation.inverseWrite.permission_overwrites));
  if (operation.objectType === 'channel') {
    const current = channels.get(operation.objectId);
    if (!current) return 'drifted';
    // `?? []` here decided `applied` vs `inverse` vs `drifted` off an invented empty
    // list, which is the verdict that picks whether this object is PATCHed at all.
    const overwrites = stable(normalizeOverwrites(current.permission_overwrites, `Live read of channel ${operation.objectId}`));
    if (expectedApplied === expectedInverse && overwrites === expectedInverse) return 'inverse';
    if (overwrites === expectedApplied) return 'applied';
    if (overwrites === expectedInverse) return 'inverse';
    const original = snapshot.channels.find((channel) => channel.id === operation.objectId)!;
    const parentOperation = manifest.operations.find((item) => item.objectType === 'category' && item.objectId === original.parent_id);
    if (parentOperation && overwrites === stable(normalizeOverwrites(parentOperation.inverseWrite.permission_overwrites))) return 'parent_inverse';
    return 'drifted';
  }
  const affected = [operation.objectId, ...snapshot.channels
    .filter((channel) => channel.parent_id === operation.objectId && stable(normalizeOverwrites(channel.permission_overwrites, `Snapshot channel ${channel.id}`)) === expectedInverse)
    .map((channel) => channel.id)];
  const states = affected.map((id) => {
    const current = channels.get(id);
    if (!current) return 'drifted';
    const overwrites = stable(normalizeOverwrites(current.permission_overwrites, `Live read of channel ${id}`));
    if (overwrites === expectedApplied) return 'applied';
    if (overwrites === expectedInverse) return 'inverse';
    return 'drifted';
  });
  if (states.includes('drifted')) return 'drifted';
  if (expectedApplied === expectedInverse && states.every((state) => state === 'applied')) return 'inverse';
  if (states.every((state) => state === 'applied')) return 'applied';
  if (states.every((state) => state === 'inverse')) return 'inverse';
  return 'mixed';
}
// Apply journals `requesting` before it issues the PATCH and never leaves more than
// one, so at most one operation can be in flight. That operation's own object — and
// only that object — is allowed to hold an arbitrary live value: not knowing whether
// the write landed is exactly the case rollback exists to undo. `inverseWrite` is a
// complete replacement of the object's overwrites, so writing it restores the
// pre-snapshot state from any starting point, and the post-rollback semantic-hash
// equality check still has to pass before this run is called rolled back.
//
// The exception stops there. `inFlightDriftIsOurs` refuses it when a synchronized
// child sits at a value our PATCH could not have produced, because that is a third
// party's write and granting the exception would clobber it. The journal signature
// checked above is what makes `state === 'requesting'` trustworthy enough to key
// this on at all.
const inFlight = manifest.operations.filter((operation) => operation.state === 'requesting');
if (inFlight.length > 1) die(1, `Rollback manifest has ${inFlight.length} in-flight operations; at most one is recoverable.`);
const inFlightCandidate = inFlight[0] ?? null;
// The witness has the second say. An abandoned checkpoint above this manifest that held
// nothing in flight proves the crashed write was the one clearing this operation to
// `applied`, which apply only reaches after Discord has returned and been verified — so
// the object is at `write`, and a `requesting` label over live drift is a rewind rather
// than an interruption (TOG-2975). `manifestInFlightId` agrees with the filter above.
const witnessAgrees = inFlightCandidate !== null
  && manifestInFlightId(manifest) === inFlightCandidate.id
  && inFlightExceptionIsAvailable(token, manifest, manifestPath);
const inFlightId = witnessAgrees && inFlightDriftIsOurs(snapshot, inFlightCandidate!, new Map(preRollbackChannels.map((channel) => [channel.id, normalizeOverwrites(channel.permission_overwrites, `Live read of channel ${channel.id}`)])))
  ? inFlightCandidate!.id
  : null;
if (inFlightCandidate !== null && inFlightId === null) {
  console.log(`In-flight operation ${inFlightCandidate.id} is NOT eligible for the recovery exception: ${witnessAgrees ? 'a synchronized child holds a value this phase could not have written' : 'the checkpoint witness records no interrupted write for it'}. Treating it as ordinary drift.`);
}
for (const operation of manifest.operations) {
  const state = operationState(operation, preRollbackById);
  if ((operation.state === 'pending' || operation.state === 'rolled_back') && state !== 'inverse') {
    die(1, `Rollback preflight operation ${operation.id} must be coherently inverse while ${operation.state}.`);
  }
  if (operation.state !== 'pending' && operation.state !== 'rolled_back' && state === 'drifted' && operation.id !== inFlightId) {
    die(1, `Rollback preflight operation ${operation.id} drifted from both applied and inverse state.`);
  }
}
for (const current of comparablePreRollback) {
  const operation = manifest.operations.find((item) => item.objectId === current.id || item.objectId === current.parent_id);
  if (operation) continue;
  // Safe by the inventory equality above, which is now taken over the same filtered list
  // this loop walks — an unfiltered walk here would dereference `undefined` for a channel
  // the filter had let through on only one side.
  const original = snapshot.channels.find((channel) => channel.id === current.id)!;
  // The eighth live-vs-live comparison, and the only one that does not run through
  // `driftSemanticHash` — it compares whole channel bodies one at a time, so it needs the same
  // volatile-field exclusion applied to both sides. Without it a message landing in any
  // untouched channel between apply and rollback shuts the recovery path for a torn apply,
  // which is the one run that has to work after something has already gone wrong.
  const currentShape = driftComparableChannel({ ...current, permission_overwrites: normalizeOverwrites(current.permission_overwrites, `Live read of untouched channel ${current.id}`) });
  const originalShape = driftComparableChannel({ ...original, permission_overwrites: normalizeOverwrites(original.permission_overwrites, `Pre-snapshot channel ${original.id}`) });
  if (stable(currentShape) !== stable(originalShape)) die(1, `Rollback preflight untouched channel ${current.id} drifted from the pre-snapshot. As above, this fails closed on purpose. Run scripts/live-cleanup-drift-diff.ts against ${JSON.stringify(resolve(manifest.snapshotPath))} and a fresh capture: a "channel field drift:" line for a field nobody edited belongs in DRIFT_VOLATILE_CHANNEL_FIELDS, and a real edit must keep refusing.`);
}
manifest.status = 'rolling_back';
checkpoint(manifestPath, manifest);
const rollbackOrder: string[] = [];

for (const operation of [...manifest.operations].reverse()) {
  if (operation.state === 'rolled_back' || operation.state === 'pending') continue;
  const currentChannels = await mustGet<Channel[]>(`/guilds/${guildId}/channels`, `Read rollback operation ${operation.objectId}`);
  const currentState = operationState(operation, new Map(currentChannels.map((channel) => [channel.id, channel])));
  if (currentState === 'inverse') {
    operation.state = 'rolled_back';
    operation.rolledBackAt = new Date().toISOString();
    checkpoint(manifestPath, manifest);
    continue;
  }
  if (currentState === 'drifted' && operation.id !== inFlightId) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback target ${operation.objectId} drifted from both applied and inverse state.`);
  }
  if (currentState === 'drifted') console.log(`RECOVERING in-flight ${operation.id} from a partial write on ${operation.objectId}`);
  const result = await api<Channel>('PATCH', `/channels/${operation.objectId}`, operation.inverseWrite);
  if (result.status === 429 || result.status >= 300 || !result.body) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback failed for ${operation.id}: HTTP ${result.status}. No retry was attempted.`);
  }
  // Post-write, so an unreadable response is folded into the existing partial-restore
  // branch rather than thrown past it: the PATCH has already reached Discord and this
  // run owes the manifest a `rollback_failed` checkpoint before it stops.
  const unreadableRestore = unreadableOverwrites(result.body.permission_overwrites);
  if (unreadableRestore !== null || stable(normalizeOverwrites(result.body.permission_overwrites)) !== stable(operation.inverseWrite.permission_overwrites)) {
    manifest.status = 'rollback_failed';
    checkpoint(manifestPath, manifest);
    die(1, `Rollback returned a partial/unexpected state for ${operation.id}${unreadableRestore === null ? '' : `: the response carried ${unreadableRestore}, so what the restore left behind is unknown`}.`);
  }
  // Discord's sync only carries children that matched the category's *previous* value,
  // so a category left at a partial value re-syncs nothing and its children stay where
  // the interrupted write put them. Restore every synchronized child explicitly before
  // checkpointing, or the operation would be marked `rolled_back` while children remain
  // at the applied value — which is what made the post-rollback hash fail with the
  // operation already checkpointed, leaving nothing for a retry to re-enter.
  for (const childId of syncedChildIds(snapshot, operation)) {
    const child = (await mustGet<Channel>(`/channels/${childId}`, `Read rollback child ${childId}`));
    // `?? []` here answered "does this child still need restoring?" with an invented
    // empty list, and an empty list never equals `inverseWrite`, so an unreadable read
    // meant a PATCH the run could not justify. Both this read and the response below
    // are past the parent's write, so they checkpoint `rollback_failed` rather than throw.
    const unreadableChild = unreadableOverwrites(child.permission_overwrites);
    if (unreadableChild !== null) {
      manifest.status = 'rollback_failed';
      checkpoint(manifestPath, manifest);
      die(1, `Rollback could not read synchronized child ${childId} of ${operation.id}: the 200 carried ${unreadableChild}, so whether it still holds the applied value is unknown.`);
    }
    if (stable(normalizeOverwrites(child.permission_overwrites)) === stable(operation.inverseWrite.permission_overwrites)) continue;
    const childResult = await api<Channel>('PATCH', `/channels/${childId}`, operation.inverseWrite);
    const unreadableChildResult = childResult.body === null ? null : unreadableOverwrites(childResult.body.permission_overwrites);
    if (childResult.status === 429 || childResult.status >= 300 || !childResult.body || unreadableChildResult !== null || stable(normalizeOverwrites(childResult.body.permission_overwrites)) !== stable(operation.inverseWrite.permission_overwrites)) {
      manifest.status = 'rollback_failed';
      checkpoint(manifestPath, manifest);
      die(1, `Rollback could not restore synchronized child ${childId} of ${operation.id}: HTTP ${childResult.status}${unreadableChildResult === null ? '' : `, and the response carried ${unreadableChildResult}`}. No retry was attempted.`);
    }
    console.log(`RESYNCED ${childId} under ${operation.id}`);
  }
  operation.state = 'rolled_back';
  operation.rolledBackAt = new Date().toISOString();
  rollbackOrder.push(operation.id);
  checkpoint(manifestPath, manifest);
  console.log(`UNDID ${operation.id}`);
}

const [postGuild, postRoles, postMembers, postIntegrations, postWelcome, postOnboarding, postScreening, currentChannels] = await Promise.all([
  mustGet<JsonObject>(`/guilds/${guildId}`, 'Read post-rollback guild'),
  mustGet<Role[]>(`/guilds/${guildId}/roles`, 'Read post-rollback roles'),
  members(),
  mustGet<JsonObject[]>(`/guilds/${guildId}/integrations`, 'Read post-rollback integrations'),
  api<JsonObject>('GET', `/guilds/${guildId}/welcome-screen`),
  api<JsonObject>('GET', `/guilds/${guildId}/onboarding`),
  api<JsonObject>('GET', `/guilds/${guildId}/member-verification`),
  mustGet<Channel[]>(`/guilds/${guildId}/channels`, 'Read post-rollback channels'),
]);
const currentChannelIds = driftComparableChannels(currentChannels).map((channel) => channel.id).sort();
if (stable(currentChannelIds) !== stable(comparableSnapshotChannels.map((channel) => channel.id).sort())) die(1, 'Post-rollback channel/category inventory differs from the pre-snapshot.');
const restored = {
  version: 1 as const,
  generatedAt: snapshot.generatedAt,
  applicationId: LIVE_BOT_APPLICATION_ID,
  guildId,
  guild: postGuild,
  roles: postRoles as LiveCleanupSnapshot['roles'],
  // Same mapper capture uses, so an unreadable post-rollback channel stays distinguishable
  // from an empty one inside the hash instead of matching a pre-snapshot that was empty.
  channels: currentChannels.map(normalizedChannel),
  members: postMembers.map((member) => ({
    id: member.user?.id ?? '',
    bot: Boolean(member.user?.bot),
    username: member.user?.username ?? null,
    roles: normalizedMemberRoles(member.roles),
    premiumSince: member.premium_since ?? null,
    pending: Boolean(member.pending),
  })).filter((member) => member.id).sort((a, b) => a.id.localeCompare(b.id)),
  integrations: postIntegrations.map((integration) => {
    const linkedApplication = integration.application as JsonObject | undefined;
    return {
      id: typeof integration.id === 'string' ? integration.id : '',
      name: typeof integration.name === 'string' ? integration.name : null,
      applicationId: typeof linkedApplication?.id === 'string' ? linkedApplication.id : null,
      roleId: typeof integration.role_id === 'string' ? integration.role_id : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id)),
  references: {
    welcomeScreen: { status: postWelcome.status, body: postWelcome.body },
    onboarding: { status: postOnboarding.status, body: postOnboarding.body },
    membershipScreening: { status: postScreening.status, body: postScreening.body },
    guildReferences: guildReferenceBlock(postGuild),
  },
};
const restoredHash = driftSemanticHash(restored);
const expectedRestoredHash = driftSemanticHash(snapshot);
if (restoredHash !== expectedRestoredHash) die(1, `Post-rollback semantic hash mismatch: expected ${expectedRestoredHash}, got ${restoredHash}.`);
manifest.status = 'rolled_back';
checkpoint(manifestPath, manifest);
console.log(`Rollback complete: ${manifestPath}`);
console.log(`Reverse order: ${rollbackOrder.join(', ')}`);
console.log(`Restored snapshot semantic hash: ${restoredHash}`);
