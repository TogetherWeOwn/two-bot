import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { LIVE_BOT_APPLICATION_ID, LIVE_GUILD_ID, LIVE_GUILD_NAME } from '../staging/spec.ts';

export const ARCHIVE_PHASE = 'archive-legacy';
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VIEW_CHANNEL = 1n << 10n;
export const ADMINISTRATOR = 1n << 3n;

export const ACTIVE_CATEGORY_IDS = [
  '1546777858200965120',
  '1546777859031433236',
  '1545924266590081115',
  '1546777860046454784',
] as const;

export const ACTIVE_CHANNEL_IDS = [
  '1546777861199896589',
  '1546777862952976455',
  '1546777864211529748',
  '1546777865348063255',
  '1546777866648289300',
  '1546777867978018887',
  '1546777869320192072',
  '1546777870511116368',
  '1546777871811346432',
  '1546777873313046598',
] as const;

export const LEGACY_CATEGORY_IDS = [
  '1087198131512430642', '1055494206556225719', '1432057164242878637',
  '1087199234706640940', '1178936839151816715', '1178933610586308739',
  '1179216170591715348', '1045946491463807066', '1078761198708858891',
  '1113455405343977472', '1087201563405193247', '1112762115992854600',
  '1112762118266159154', '1063309416365039649', '1090639835896746027',
  '1112742773829926983', '1139711707443368079', '1140914034686836766',
] as const;

export const LEGACY_CHANNEL_IDS = [
  '1146611215511081012', '1087198966346690570', '1132448261253369939',
  '327082608611557377', '1118994739799281664', '1087199860802986095',
  '1078104807132373032', '1112873080293970002', '1087200619418357810',
  '1092823790695751810', '1087200082505510972', '1092929576491036672',
  '1132475979282006137', '1176294550294233169', '1431746979540631622',
  '1431742191620853791', '1055500237831151716', '1055494371019071570',
  '1056439011088007261', '1175150463298060370', '1063256513172484149',
  '1119296196373139587', '1175150257278025771', '1047562772407398500',
  '1086368551729905694', '1266840224835833920', '1266840693637255363',
  '1175127344072118405', '1269750661722148954', '1269753028404056076',
  '1269753534346432644', '1269753860193521816', '1269754268265480242',
  '1269754877303721985', '1045950023663370260', '1465060666972049439',
  '1045943373007171674', '1087199619546632232', '1056447465286541333',
  '1092312335529541632', '1087199559719067748', '1087199767718809650',
  '1154904611799437404', '1078083546054397982', '1057456170320801802',
  '1113979181391429672', '1117480270044594186', '1175151272438026280',
  '1176386295384260648', '1276964524150358138', '1178937094035492884',
  '1118994447036850369', '1179217198930202735', '1134893653832245428',
  '1087199956600897557', '1087910390802960414', '1138590687311446049',
  '1138590808715571300', '1138591034163593336', '1225192754020225176',
  '1138591122927648908', '1138593758443737140', '1104836077761593354',
  '1058572809607073832', '1139710398585651220', '1079390933159788714',
  '1059534713695502337', '1058572808826933319', '1113457081329139763',
  '1113457217706922035', '1128819815298125854', '1087201627980714044',
  '1119073453291610123', '1114833990315159622', '1127785339486994473',
  '1178791853861113887', '1499430425045766326', '1045892418362417192',
  '1063303397639454781', '1063269593914818600', '1078864674046627960',
  '1080624480382107728', '1090639980705099776', '1090640059524468797',
  '1090640094194565180', '1090640131200913589', '1090640168412786688',
  '1090640199475802202', '1090640261375340554', '1090640290882261092',
  '1090640324600266902', '1090640356627976263', '1090640385027616861',
  '1090640414568091700', '1090640441948512326', '1090640472449486908',
  '1090640510227582986', '1090642310846480445', '1090642341041291364',
  '1090642374226612404', '1090642415339192351', '1090642448579043388',
  '1090642477624590376', '1105881919062806588', '1112742775578964099',
  '1112743065665413120', '1139711709980925962', '1139711711851593848',
  '1139711713525108896', '1139711716129783950', '1139711719065784414',
  '1140914163934302289',
] as const;

export type JsonObject = Record<string, unknown>;
export type Overwrite = { id: string; type: number; allow: string; deny: string };
export type Role = { id: string; name: string; managed: boolean; permissions: string; position?: number; tags?: JsonObject };
export type Channel = { id: string; name: string; type: number; parent_id: string | null; position?: number; topic?: string | null; permission_overwrites: Overwrite[] };
export type Member = { id: string; bot: boolean; username: string | null; roles: string[]; premiumSince: string | null; pending: boolean };
export type LiveCleanupSnapshot = {
  version: 1;
  generatedAt: string;
  applicationId: string;
  guildId: string;
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  members: Member[];
  integrations: Array<{ id: string; name: string | null; applicationId: string | null; roleId: string | null }>;
  references: JsonObject;
  semanticHash: string;
};
export type CleanupOperation = {
  version: 1;
  sequence: number;
  id: string;
  phase: typeof ARCHIVE_PHASE;
  kind: 'patch-category-overwrites' | 'patch-channel-overwrites';
  objectType: 'category' | 'channel';
  objectId: string;
  expectedBefore: { permission_overwrites: Overwrite[] };
  write: { permission_overwrites: Overwrite[] };
  inverseWrite: { permission_overwrites: Overwrite[] };
};
export type OperationState = 'pending' | 'requesting' | 'applied' | 'rolled_back';
export type RollbackEntry = CleanupOperation & { state: OperationState; requestStartedAt?: string; appliedAt?: string; rolledBackAt?: string };
export type ArchiveExemptionReason = 'owner' | 'owen' | 'administrator';
export type ArchiveVisibilityExemption = { memberId: string; bot: boolean; reason: ArchiveExemptionReason };
/** A reviewed legacy channel Discord refuses to hide, and every guild reference that pins it. */
export type ArchiveOnboardingExclusion = { channelId: string; referencedBy: string[] };
export type CleanupManifest = {
  version: 1;
  kind: 'live-clean-slate-cleanup';
  phase: typeof ARCHIVE_PHASE;
  status: 'planned' | 'applying' | 'apply_failed' | 'applied' | 'rolling_back' | 'rollback_failed' | 'rolled_back';
  generatedAt: string;
  applicationId: string;
  guildId: string;
  snapshotPath: string;
  snapshotGeneratedAt: string;
  snapshotSemanticHash: string;
  planSignature: string;
  journalSignature: string;
  journalSequence: number;
  operationSemanticHash: string;
  operationCount: number;
  reviewedLegacyChannelIds: string[];
  reviewedLegacyCategoryIds: string[];
  activeChannelIds: string[];
  activeCategoryIds: string[];
  visibilityExemptions: ArchiveVisibilityExemption[];
  onboardingExclusions: ArchiveOnboardingExclusion[];
  operations: RollbackEntry[];
};

// A project ceiling, deliberately below Discord's own documented limit (error 30060
// permits 1,000 overwrites per channel). Additive member denies must never push a
// reviewed object anywhere near that, or the PATCH is rejected mid-phase. The plan's
// observed maximum is 19, so tripping this means the drift shape changed radically
// and the phase should be re-reviewed rather than pushed through.
export const OVERWRITE_CEILING_PER_CHANNEL = 500;

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

export function planSignature(token: string, snapshotGeneratedAt: string, snapshotSemanticHash: string, operationHash: string): string {
  return createHmac('sha256', token).update(stable({ snapshotGeneratedAt, snapshotSemanticHash, operationHash })).digest('hex');
}

/**
 * Authenticates the *mutable* half of the manifest, which `planSignature` does not
 * cover: the phase status and every operation's journal state and timestamps.
 *
 * This matters because recovery decisions are driven by journal state — rollback
 * grants its in-flight exception to whichever operation reads `requesting`. Without
 * this HMAC, anyone who can write the manifest file could relabel a long-applied
 * operation `requesting` and have rollback overwrite unrelated live drift for them.
 * The plan signature is folded into the input so a journal signature cannot be
 * lifted from a different plan, and the token keys it so a manifest edited outside
 * a run with the bot token cannot be re-signed.
 *
 * Every checkpoint must re-sign before it writes; see `checkpoint()` in the apply
 * and rollback scripts, which is the only sanctioned way to persist a manifest.
 *
 * Authenticity is not freshness: every checkpoint a run ever wrote carries a valid
 * signature forever, so `journalSequence` is signed here and corroborated against the
 * append-only witness log by `assertLatestCheckpoint`.
 */
export function journalSignature(token: string, manifest: CleanupManifest): string {
  return createHmac('sha256', token).update(stable({
    planSignature: manifest.planSignature,
    status: manifest.status,
    journalSequence: manifest.journalSequence,
    operations: manifest.operations.map((operation) => ({
      id: operation.id,
      state: operation.state,
      requestStartedAt: operation.requestStartedAt ?? null,
      appliedAt: operation.appliedAt ?? null,
      rolledBackAt: operation.rolledBackAt ?? null,
    })),
  })).digest('hex');
}

export type JournalWitnessPhase = 'intent' | 'commit' | 'abort';
export type JournalWitnessRecord = { sequence: number; phase: JournalWitnessPhase; journalSignature: string; inFlightId: string | null; chain: string };

export function journalWitnessPath(manifestPath: string): string {
  return `${manifestPath}.witness`;
}

/**
 * The one operation a manifest declares in flight, which is the only operation allowed
 * to hold an arbitrary live value during recovery. Apply never journals more than one;
 * callers that find more treat the manifest as unrecoverable rather than pick.
 */
export function manifestInFlightId(manifest: Pick<CleanupManifest, 'operations'>): string | null {
  const requesting = manifest.operations.filter((operation) => operation.state === 'requesting');
  return requesting.length === 1 ? requesting[0]!.id : null;
}

function witnessChain(token: string, previous: string, record: Omit<JournalWitnessRecord, 'chain'>): string {
  return createHmac('sha256', token).update(stable({ previous, ...record })).digest('hex');
}

/**
 * The records that may legally follow `last`, which is what makes the log a protocol
 * rather than a list.
 *
 * An `intent` is closed either way: `commit` once the manifest write landed, or
 * `abort` when it did not (TOG-2960 — a crash inside `checkpoint()` leaves a dangling
 * intent, and without a way to close it the next checkpoint appends a second intent
 * and the log becomes permanently unreadable). An aborted sequence number is retried,
 * so `abort` is followed by an `intent` at the *same* sequence; only a `commit`
 * advances it.
 */
function expectedWitnessRecords(last: JournalWitnessRecord | undefined): Array<{ sequence: number; phase: JournalWitnessPhase }> {
  if (last === undefined) return [{ sequence: 1, phase: 'intent' }];
  if (last.phase === 'intent') return [{ sequence: last.sequence, phase: 'commit' }, { sequence: last.sequence, phase: 'abort' }];
  if (last.phase === 'abort') return [{ sequence: last.sequence, phase: 'intent' }];
  return [{ sequence: last.sequence + 1, phase: 'intent' }];
}

/**
 * Reads the run's append-only checkpoint witness and proves it was not edited.
 *
 * Each record is HMACed over its predecessor's chain value, so a line cannot be
 * altered, reordered, or spliced in without the bot token. The strict phase
 * alternation is checked too, so a record cannot be dropped from the middle of the
 * log; only trailing truncation survives, and that is what an interrupted checkpoint
 * looks like anyway.
 *
 * A witness holding no records reads as an empty list rather than an error. TOG-2975:
 * `appendJournalWitness` creates the file and then writes it, so a process killed in
 * that window leaves a zero-byte witness — which carries exactly as much history as no
 * witness at all. Callers decide what that means; `reconcileJournalWitness` treats it
 * as absent and `assertLatestCheckpoint` refuses it, because a manifest cannot be shown
 * to be the latest checkpoint by a log that records none.
 */
export function readJournalWitness(token: string, path: string): JournalWitnessRecord[] {
  const records: JournalWitnessRecord[] = [];
  let previousChain = '';
  for (const [index, line] of readFileSync(path, 'utf8').split('\n').filter((item) => item.length > 0).entries()) {
    let record: JournalWitnessRecord;
    try {
      record = JSON.parse(line) as JournalWitnessRecord;
    } catch {
      throw new Error(`Journal witness line ${index + 1} is not readable.`);
    }
    const { chain, ...body } = record;
    if (witnessChain(token, previousChain, body) !== chain) throw new Error(`Journal witness line ${index + 1} is not authentic; the checkpoint log was edited outside a run.`);
    const expected = expectedWitnessRecords(records.at(-1));
    if (!expected.some((item) => item.sequence === body.sequence && item.phase === body.phase)) throw new Error(`Journal witness line ${index + 1} breaks the checkpoint sequence; the log was reordered or spliced.`);
    records.push(record);
    previousChain = chain;
  }
  return records;
}

export function appendJournalWitness(token: string, path: string, sequence: number, phase: JournalWitnessPhase, signature: string, inFlightId: string | null): void {
  let previousChain = '';
  let last: JournalWitnessRecord | undefined;
  if (existsSync(path)) {
    const line = readFileSync(path, 'utf8').split('\n').filter((item) => item.length > 0).at(-1);
    if (line !== undefined) {
      last = JSON.parse(line) as JournalWitnessRecord;
      previousChain = last.chain;
    }
  }
  // Refuse to write a record the reader would later reject. A caller that skipped
  // reconciliation and is about to append a second `intent` fails loudly here rather
  // than leaving behind a log nothing can read again.
  const expected = expectedWitnessRecords(last);
  if (!expected.some((item) => item.sequence === sequence && item.phase === phase)) {
    throw new Error(`Refusing to append checkpoint ${sequence}/${phase} after ${last === undefined ? 'an empty log' : `${last.sequence}/${last.phase}`}; the witness would become unreadable. Reconcile the log first.`);
  }
  const body = { sequence, phase, journalSignature: signature, inFlightId };
  const record: JournalWitnessRecord = { ...body, chain: witnessChain(token, previousChain, body) };
  const fd = openSync(path, 'a', 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type JournalWitnessReconciliation =
  | { outcome: 'absent' }
  | { outcome: 'clean' }
  | { outcome: 'committed'; sequence: number }
  | { outcome: 'aborted'; sequence: number };

/**
 * Closes a checkpoint that a crash left open, and must run before anything else reads
 * or extends the witness.
 *
 * `checkpoint()` appends `intent`, writes the manifest, then appends `commit`. A
 * process that dies inside that window leaves the tip an uncommitted `intent`, and
 * TOG-2960 showed that state was terminal: the next checkpoint appended a second
 * `intent` and every later read failed the sequence check, bricking a run that had
 * only been interrupted. The crash is also invisible from the log alone — whether the
 * manifest write landed is a property of the *manifest*, so reconciliation decides by
 * comparing the two:
 *
 * - the manifest is the tip's checkpoint -> the write landed; append the `commit`.
 * - the manifest is the last committed checkpoint (or there is none and no manifest
 *   was ever written) -> the write did not land; append `abort`, and the sequence
 *   number is retried.
 * - anything else -> not a crash window. Refuse, rather than invent a history.
 *
 * This adds no replay surface. An `abort` never advances the latest durable
 * checkpoint, and the records it must be reconciled against are themselves chained
 * under the bot token, so reaching any of these states still requires writing the
 * witness — the manifest+witness rollback boundary documented on
 * `assertLatestCheckpoint`, not a manifest-only replay.
 *
 * Closing an intent is itself an append, so it must not be done on the strength of a
 * manifest the run is about to reject. TOG-2975: `journalSequence` and
 * `journalSignature` are plaintext in the tip record, so copying that pair into an
 * otherwise corrupt manifest was enough to buy a `commit` — and once the log commits a
 * checkpoint whose manifest fails validation, the intent can never be aborted instead
 * and the run is stranded with no way back. `validateManifest` is therefore run first
 * and a failure raises before any record is written, leaving the intent open and the
 * run recoverable once a valid manifest is restored.
 */
export function reconcileJournalWitness(
  token: string,
  manifestPath: string,
  validateManifest?: (manifest: CleanupManifest) => void,
): JournalWitnessReconciliation {
  const path = journalWitnessPath(manifestPath);
  if (!existsSync(path)) return { outcome: 'absent' };
  const records = readJournalWitness(token, path);
  // A zero-byte witness is a torn file creation, not a checkpoint: it records no more
  // history than a missing one, so there is nothing to reconcile.
  if (records.length === 0) return { outcome: 'absent' };
  const tip = records.at(-1)!;
  if (tip.phase !== 'intent') return { outcome: 'clean' };
  let manifest: CleanupManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
      if (!Array.isArray(manifest?.operations)) throw new Error('manifest has no operations array');
      if (manifest.journalSignature !== journalSignature(token, manifest)) throw new Error('its journal signature does not cover this file');
      validateManifest?.(manifest);
    } catch (error) {
      throw new Error(`Journal witness tip is an uncommitted checkpoint ${tip.sequence}, but the manifest beside it is not valid (${error instanceof Error ? error.message : String(error)}). Refusing to close the open checkpoint over it; restore a valid manifest and reconcile again.`);
    }
  }
  if (manifest !== null && manifest.journalSequence === tip.sequence && manifest.journalSignature === tip.journalSignature) {
    appendJournalWitness(token, path, tip.sequence, 'commit', tip.journalSignature, tip.inFlightId);
    return { outcome: 'committed', sequence: tip.sequence };
  }
  const durable = records.filter((record) => record.phase === 'commit').at(-1);
  const manifestIsLastDurable = durable === undefined
    ? manifest === null
    : manifest !== null && manifest.journalSequence === durable.sequence && manifest.journalSignature === durable.journalSignature;
  if (manifestIsLastDurable) {
    appendJournalWitness(token, path, tip.sequence, 'abort', tip.journalSignature, tip.inFlightId);
    return { outcome: 'aborted', sequence: tip.sequence };
  }
  throw new Error(`Journal witness tip is an uncommitted checkpoint ${tip.sequence}, but the manifest is neither that checkpoint nor the last committed one. This is not an interrupted checkpoint; refusing to reconcile it.`);
}

/**
 * Whether this manifest is the run's *latest* checkpoint, not merely an authentic one.
 *
 * TOG-2947: the journal HMAC closes forgery but not replay. Every checkpoint a run
 * writes stays validly signed forever, so keeping a copy of the manifest from the
 * moment an operation was `requesting` and dropping it back afterwards used to hand
 * rollback a genuine in-flight exception over long-settled state — and rollback would
 * then write `inverseWrite` across whatever a third party had done since. No forged
 * signature and no token were needed; the later legitimate invocation supplied both.
 *
 * The witness log is appended outside the manifest, so restoring the manifest alone no
 * longer rewinds the run. Each checkpoint appends `intent`, writes the manifest, then
 * appends `commit`, so the run's latest *durable* checkpoint is its last committed
 * record — an `intent` that `reconcileJournalWitness` closed as `abort` never landed
 * and never advances it. The one uncommitted tip accepted here is an `intent` whose
 * signature the manifest already carries: that write did land, and only its `commit`
 * record was lost.
 *
 * This binds the manifest to the log, not to wall-clock time: an attacker who can
 * roll back the whole run directory — witness included — is outside what a file in
 * that directory can prove, and would need external state to detect.
 */
export function assertLatestCheckpoint(token: string, manifest: CleanupManifest, manifestPath: string): void {
  const path = journalWitnessPath(manifestPath);
  if (!existsSync(path)) throw new Error(`Journal witness ${path} is missing; this manifest cannot be shown to be the run's latest checkpoint.`);
  const records = readJournalWitness(token, path);
  if (records.length === 0) throw new Error(`Journal witness ${path} records no checkpoint; this manifest cannot be shown to be the run's latest checkpoint.`);
  const tip = records.at(-1)!;
  if (tip.phase === 'intent' && tip.sequence === manifest.journalSequence && tip.journalSignature === manifest.journalSignature) return;
  const durable = records.filter((record) => record.phase === 'commit').at(-1);
  if (durable !== undefined && durable.sequence === manifest.journalSequence && durable.journalSignature === manifest.journalSignature) return;
  throw new Error(`Manifest is checkpoint ${manifest.journalSequence} but this run's witness log has reached ${tip.sequence}; refusing to act on a superseded checkpoint.`);
}

/**
 * Whether a manifest's `requesting` operation may still be treated as genuinely in
 * flight — the exception that lets rollback write `inverseWrite` over an object holding
 * *any* live value, and so the one place a stale journal state can clobber a third
 * party's write.
 *
 * `assertLatestCheckpoint` proves the manifest is the run's latest durable checkpoint,
 * but TOG-2975 showed that is not sufficient. A checkpoint abandoned above it — an
 * `intent` that reconciliation closed as `abort` — is still evidence about what the
 * crashed write was going to record, and it is chained under the bot token, so unlike
 * the manifest it cannot be substituted. Two crashes leave a `requesting` operation
 * under an abandoned checkpoint, and they are not equally recoverable:
 *
 * - the abandoned checkpoint *also* held it in flight (apply journalling
 *   `apply_failed` after a write that failed or tore) -> the live object may hold
 *   anything, which is exactly what the exception is for.
 * - the abandoned checkpoint held *nothing* in flight, or a different operation -> the
 *   crashed write was the one clearing this operation to `applied`, and apply only
 *   reaches that after Discord has returned and been verified equal to `write`. The
 *   live object is therefore at `write`, not at an arbitrary value, and a manifest
 *   claiming otherwise is a rewind rather than an interruption.
 *
 * Denying the exception in the second case does not brick the resume: apply's own
 * `requesting` branch still recognises a live object sitting at `write` and marks it
 * applied. It removes only the right to overwrite live drift on the strength of a
 * `requesting` label the witness contradicts.
 */
export function inFlightExceptionIsAvailable(token: string, manifest: CleanupManifest, manifestPath: string): boolean {
  const inFlightId = manifestInFlightId(manifest);
  if (inFlightId === null) return false;
  const path = journalWitnessPath(manifestPath);
  if (!existsSync(path)) return false;
  return readJournalWitness(token, path)
    .filter((record) => record.phase === 'intent' && record.sequence > manifest.journalSequence)
    .every((record) => record.inFlightId === inFlightId);
}

/**
 * The children Discord's server-side sync would have carried along with a category
 * PATCH: exactly those whose pre-snapshot overwrites match the category's, which is
 * what "synchronized" means. A channel operation carries nothing but itself.
 *
 * Recovery reasoning has to be confined to this set. Every other child of the
 * category is unsynchronized and our PATCH could not have touched it, so if one of
 * those moved, a third party moved it.
 */
export function syncedChildIds(snapshot: Pick<LiveCleanupSnapshot, 'channels'>, operation: CleanupOperation): string[] {
  if (operation.objectType !== 'category') return [];
  const parentBefore = stable(normalizeOverwrites(operation.inverseWrite.permission_overwrites));
  return snapshot.channels
    .filter((channel) => channel.parent_id === operation.objectId && stable(normalizeOverwrites(channel.permission_overwrites ?? [])) === parentBefore)
    .map((channel) => channel.id)
    .sort();
}

/**
 * Whether an interrupted operation's live state is one our own PATCH could have
 * produced, and is therefore covered by the in-flight exception.
 *
 * The operation's own object may hold any value — not knowing whether the write
 * landed is precisely what "in flight" means. Its synchronized children are a
 * different matter. Our PATCH could only ever have left such a child in one of three
 * places: still at the pre-write value (the write never reached it), at the
 * post-write value (it did), or carried to whatever the category itself now holds
 * (the sync followed a torn write down). A child sitting anywhere else was moved by
 * a third party, and the exception must not be stretched to cover that — rollback
 * would otherwise silently clobber someone else's write.
 */
export function inFlightDriftIsOurs(
  snapshot: Pick<LiveCleanupSnapshot, 'channels'>,
  operation: CleanupOperation,
  liveOverwritesById: Map<string, Overwrite[]>,
): boolean {
  const liveTarget = liveOverwritesById.get(operation.objectId);
  if (!liveTarget) return false;
  const explicable = new Set([
    stable(normalizeOverwrites(operation.expectedBefore.permission_overwrites)),
    stable(normalizeOverwrites(operation.write.permission_overwrites)),
    stable(normalizeOverwrites(liveTarget)),
  ]);
  return syncedChildIds(snapshot, operation).every((id) => {
    const live = liveOverwritesById.get(id);
    return live !== undefined && explicable.has(stable(normalizeOverwrites(live)));
  });
}

export function normalizeOverwrites(overwrites: Overwrite[]): Overwrite[] {
  return overwrites.map((overwrite) => ({ ...overwrite, allow: String(overwrite.allow), deny: String(overwrite.deny) }))
    .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}

export function archiveEveryoneOverwrite(guildId: string, overwrites: Overwrite[]): Overwrite[] {
  const normalized = normalizeOverwrites(overwrites);
  const index = normalized.findIndex((overwrite) => overwrite.id === guildId && overwrite.type === 0);
  if (index === -1) return normalizeOverwrites([...normalized, { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }]);
  const current = normalized[index]!;
  const updated = {
    ...current,
    allow: String(BigInt(current.allow) & ~VIEW_CHANNEL),
    deny: String(BigInt(current.deny) | VIEW_CHANNEL),
  };
  return normalized.map((overwrite, itemIndex) => itemIndex === index ? updated : overwrite);
}

export function basePermissions(member: Member, snapshot: LiveCleanupSnapshot): bigint {
  return snapshot.roles
    .filter((role) => role.id === snapshot.guildId || member.roles.includes(role.id))
    .reduce((value, role) => value | BigInt(role.permissions), 0n);
}

/**
 * The only principals this phase may leave able to see an archived object.
 *
 * `owner` and `owen` are deliberate — the guild Owner and Owen itself must keep
 * archive access to operate and to roll back. `administrator` is not a choice:
 * Discord ignores every channel overwrite for a principal holding Administrator,
 * so no PATCH this phase can emit would hide the object from them. Bots are NOT
 * exempt: a non-Owen bot without Administrator is denied and asserted like any
 * human member.
 *
 * Administrator holders are returned rather than silently skipped so
 * `buildManifest` can pin them onto the manifest for operator review.
 */
export function archiveExemption(member: Member, snapshot: LiveCleanupSnapshot): ArchiveExemptionReason | null {
  const ownerId = typeof snapshot.guild.owner_id === 'string' ? snapshot.guild.owner_id : null;
  if (ownerId !== null && member.id === ownerId) return 'owner';
  if (member.id === LIVE_BOT_APPLICATION_ID) return 'owen';
  if ((basePermissions(member, snapshot) & ADMINISTRATOR) !== 0n) return 'administrator';
  return null;
}

export function archiveVisibilityExemptions(snapshot: LiveCleanupSnapshot): ArchiveVisibilityExemption[] {
  return snapshot.members
    .flatMap((member) => {
      const reason = archiveExemption(member, snapshot);
      return reason === null ? [] : [{ memberId: member.id, bot: member.bot, reason }];
    })
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

function memberCanView(member: Member, snapshot: LiveCleanupSnapshot, overwrites: Overwrite[]): boolean {
  let permissions = basePermissions(member, snapshot);
  if ((permissions & ADMINISTRATOR) !== 0n) return true;
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === snapshot.guildId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || overwrite.id === snapshot.guildId || !member.roles.includes(overwrite.id)) continue;
    roleAllow |= BigInt(overwrite.allow);
    roleDeny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;
  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.id);
  if (memberOverwrite) permissions = (permissions & ~BigInt(memberOverwrite.deny)) | BigInt(memberOverwrite.allow);
  return (permissions & VIEW_CHANNEL) !== 0n;
}

function assertArchiveVisibility(snapshot: LiveCleanupSnapshot, target: Channel, overwrites: Overwrite[]): void {
  for (const member of snapshot.members) {
    if (archiveExemption(member, snapshot) !== null) continue;
    if (memberCanView(member, snapshot, overwrites)) {
      throw new Error(`Legacy object ${target.id} remains visible to ${member.bot ? 'bot' : 'member'} ${member.id} after the planned archive deny.`);
    }
  }
}

function archiveVisibilityOverwrites(snapshot: LiveCleanupSnapshot, target: Channel, overwrites: Overwrite[]): Overwrite[] {
  let write = archiveEveryoneOverwrite(snapshot.guildId, overwrites);
  for (const member of snapshot.members) {
    if (archiveExemption(member, snapshot) !== null) continue;
    if (!memberCanView(member, snapshot, write)) continue;
    const index = write.findIndex((overwrite) => overwrite.id === member.id && overwrite.type === 1);
    if (index === -1) {
      write = normalizeOverwrites([...write, { id: member.id, type: 1, allow: '0', deny: String(VIEW_CHANNEL) }]);
      continue;
    }
    const current = write[index]!;
    const memberDeny = {
      ...current,
      allow: String(BigInt(current.allow) & ~VIEW_CHANNEL),
      deny: String(BigInt(current.deny) | VIEW_CHANNEL),
    };
    write = write.map((overwrite, itemIndex) => itemIndex === index ? memberDeny : overwrite);
  }
  if (write.length > OVERWRITE_CEILING_PER_CHANNEL) {
    throw new Error(`Planned overwrites for ${target.id} (${write.length}) exceed this phase's per-channel ceiling of ${OVERWRITE_CEILING_PER_CHANNEL}.`);
  }
  assertArchiveVisibility(snapshot, target, write);
  return write;
}

export function applyOperationOverwrites(
  snapshot: Pick<LiveCleanupSnapshot, 'channels'>,
  operation: Pick<CleanupOperation, 'objectId' | 'objectType'>,
  overwrites: Overwrite[],
): void {
  const target = snapshot.channels.find((channel) => channel.id === operation.objectId);
  if (!target) throw new Error(`${operation.objectType === 'category' ? 'Category' : 'Channel'} ${operation.objectId} is missing from snapshot.`);
  const before = normalizeOverwrites(target.permission_overwrites ?? []);
  const normalized = normalizeOverwrites(overwrites);
  target.permission_overwrites = normalized;
  if (operation.objectType !== 'category') return;
  for (const channel of snapshot.channels) {
    if (channel.parent_id === operation.objectId && stable(normalizeOverwrites(channel.permission_overwrites ?? [])) === stable(before)) {
      channel.permission_overwrites = structuredClone(normalized);
    }
  }
}

/**
 * `GET /guilds/{id}` returns `features` in a different order on essentially every
 * request. Two live reads three minutes apart were set-equal and hash-different,
 * so `--apply`'s "live state drifted" check could never be satisfied on this guild
 * — it refused 15 consecutive attempts before the operator patched it out by hand
 * (TOG-2806, operator run 2026-09-16T16:35Z).
 *
 * Feature order carries no meaning in Discord's model, so canonicalize it here
 * rather than weakening the drift check, which is the only thing standing between
 * a stale plan and the live guild. Nothing else in the guild payload has been
 * observed to reorder; add a field to this function only with a live measurement
 * behind it, because every field normalized away is drift the check stops seeing.
 */
function normalizeGuild(guild: JsonObject): JsonObject {
  if (!Array.isArray(guild.features)) return guild;
  return { ...guild, features: [...guild.features].map(String).sort() };
}

export function semanticSnapshot(input: Omit<LiveCleanupSnapshot, 'semanticHash'>): JsonObject {
  return {
    version: input.version,
    applicationId: input.applicationId,
    guildId: input.guildId,
    guild: normalizeGuild(input.guild),
    roles: [...input.roles].sort((a, b) => a.id.localeCompare(b.id)),
    channels: [...input.channels].map((channel) => ({ ...channel, permission_overwrites: normalizeOverwrites(channel.permission_overwrites ?? []) })).sort((a, b) => a.id.localeCompare(b.id)),
    members: [...input.members].map((member) => ({ ...member, roles: [...member.roles].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    integrations: [...input.integrations].sort((a, b) => a.id.localeCompare(b.id)),
    references: input.references,
  };
}

export function withSemanticHash(input: Omit<LiveCleanupSnapshot, 'semanticHash'>): LiveCleanupSnapshot {
  return { ...input, semanticHash: sha256(semanticSnapshot(input)) };
}

export function assertReviewedShape(snapshot: LiveCleanupSnapshot): void {
  if (snapshot.guildId !== LIVE_GUILD_ID || snapshot.applicationId !== LIVE_BOT_APPLICATION_ID) throw new Error('Snapshot identity does not match the live Owen application and guild.');
  if (snapshot.guild.name !== LIVE_GUILD_NAME) throw new Error(`Expected guild name ${LIVE_GUILD_NAME}.`);
  const channelIds = new Set(snapshot.channels.map((channel) => channel.id));
  for (const id of [...ACTIVE_CATEGORY_IDS, ...ACTIVE_CHANNEL_IDS, ...LEGACY_CATEGORY_IDS, ...LEGACY_CHANNEL_IDS]) {
    if (!channelIds.has(id)) throw new Error(`Reviewed object ${id} is missing from the fresh snapshot.`);
  }
  for (const id of LEGACY_CATEGORY_IDS) {
    const category = snapshot.channels.find((channel) => channel.id === id);
    if (category?.type !== 4) throw new Error(`Reviewed legacy category ${id} is not a category.`);
  }
  for (const id of LEGACY_CHANNEL_IDS) {
    const channel = snapshot.channels.find((item) => item.id === id);
    if (!channel || channel.type === 4) throw new Error(`Reviewed legacy channel ${id} is missing or is a category.`);
    if (!channel.parent_id || !LEGACY_CATEGORY_IDS.includes(channel.parent_id as never)) throw new Error(`Reviewed legacy channel ${id} is not under a reviewed legacy category.`);
  }
  const reviewedUntouchedShapes = new Map([
    ['1545924265868525588', { type: 4, parentId: null }],
    ['1545924268489973841', { type: 0, parentId: '1545924265868525588' }],
    ['1545924265247903884', { type: 4, parentId: null }],
    ['1545924267453976696', { type: 4, parentId: null }],
  ]);
  for (const [id, expected] of reviewedUntouchedShapes) {
    const channel = snapshot.channels.find((item) => item.id === id);
    if (!channel || channel.type !== expected.type || channel.parent_id !== expected.parentId) {
      throw new Error(`Reviewed untouched object ${id} does not match its pinned type and parent.`);
    }
  }
  const reviewedLegacyChannels = new Set<string>(LEGACY_CHANNEL_IDS);
  const unexpectedLegacyChildren = snapshot.channels.filter((channel) => channel.parent_id && LEGACY_CATEGORY_IDS.includes(channel.parent_id as never) && !reviewedLegacyChannels.has(channel.id));
  if (unexpectedLegacyChildren.length > 0) {
    throw new Error(`Reviewed legacy categories contain unexpected child IDs: ${unexpectedLegacyChildren.map((channel) => channel.id).join(', ')}.`);
  }
  const reviewed = new Set<string>([...ACTIVE_CATEGORY_IDS, ...ACTIVE_CHANNEL_IDS, ...LEGACY_CATEGORY_IDS, ...LEGACY_CHANNEL_IDS, ...reviewedUntouchedShapes.keys()]);
  const unknown = snapshot.channels.filter((channel) => !reviewed.has(channel.id));
  if (unknown.length > 0) throw new Error(`Fresh snapshot contains unreviewed channel/category IDs: ${unknown.map((channel) => channel.id).join(', ')}.`);
  if (snapshot.semanticHash !== sha256(semanticSnapshot(snapshot))) throw new Error('Snapshot semantic hash does not match its content.');
}

export function assertHierarchy(snapshot: LiveCleanupSnapshot): void {
  const owenMember = snapshot.members.find((member) => member.id === LIVE_BOT_APPLICATION_ID && member.bot);
  if (!owenMember) throw new Error('Owen is missing from the member inventory.');
  const owenRoles = snapshot.roles.filter((role) => owenMember.roles.includes(role.id));
  if (!owenRoles.some((role) => (BigInt(role.permissions) & ADMINISTRATOR) !== 0n)) throw new Error('Owen does not have Administrator.');
  const highestOwen = Math.max(...owenRoles.map((role) => role.position ?? -1));
  const managedTargets = snapshot.roles.filter((role) => role.managed && role.id !== LIVE_GUILD_ID && !owenMember.roles.includes(role.id));
  if (managedTargets.some((role) => (role.position ?? -1) >= highestOwen)) throw new Error('Owen is not above every managed target role.');
}

function referencedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/**
 * Channel IDs the live guild pins as publicly readable, read out of the references
 * block `captureSnapshot` already stores beside the snapshot.
 *
 * Discord rejects any channel PATCH that would deny `@everyone` View on one of these
 * with **400 code 350003 `Onboarding channels must be readable by everyone`**, and a
 * bot cannot clear the reference itself: `PUT /guilds/{id}/onboarding` answers
 * 403 code 20001 `Bots cannot use this endpoint`. Measured live on TOG-2806, where
 * apply stopped on operation 31 and five reviewed legacy channels stayed visible.
 *
 * Sources, all four observed to 400 in that run:
 *   - `rules_channel_id`, `public_updates_channel_id`, `safety_alerts_channel_id`
 *   - the Server Guide's default channels and every prompt option's channels
 *
 * The welcome screen is deliberately *not* a source: its channels were not observed
 * to refuse, and excluding a channel Discord would have accepted leaves it visible
 * for no reason, which is the exact failure this phase exists to fix.
 */
export function onboardingReferencedChannels(snapshot: Pick<LiveCleanupSnapshot, 'references'>): ArchiveOnboardingExclusion[] {
  const sources = new Map<string, Set<string>>();
  const note = (value: unknown, source: string): void => {
    const channelId = referencedId(value);
    if (!channelId) return;
    const existing = sources.get(channelId) ?? new Set<string>();
    existing.add(source);
    sources.set(channelId, existing);
  };
  const references = snapshot.references ?? {};
  const guildReferences = jsonObject(references.guildReferences);
  note(guildReferences?.rulesChannelId, 'guild.rules_channel_id');
  note(guildReferences?.publicUpdatesChannelId, 'guild.public_updates_channel_id');
  note(guildReferences?.safetyAlertsChannelId, 'guild.safety_alerts_channel_id');
  const onboarding = jsonObject(jsonObject(references.onboarding)?.body);
  // A disabled Server Guide pins nothing, and treating it as if it did would leave
  // its channels visible forever. Absent `enabled` is read as enabled: the guild
  // reference is the claim, and an unreadable claim must fail towards refusing.
  if (onboarding && onboarding.enabled !== false) {
    for (const id of jsonArray(onboarding.default_channel_ids)) note(id, 'onboarding.default_channel_ids');
    for (const prompt of jsonArray(onboarding.prompts)) {
      const promptId = referencedId(jsonObject(prompt)?.id) ?? 'unknown';
      for (const option of jsonArray(jsonObject(prompt)?.options)) {
        for (const id of jsonArray(jsonObject(option)?.channel_ids)) note(id, `onboarding.prompt:${promptId}`);
      }
    }
  }
  return [...sources]
    .map(([channelId, referencedBy]) => ({ channelId, referencedBy: [...referencedBy].sort() }))
    .sort((a, b) => a.channelId.localeCompare(b.channelId));
}

/** The subset of `onboardingReferencedChannels` that this phase would otherwise have hidden. */
export function archiveOnboardingExclusions(snapshot: LiveCleanupSnapshot): ArchiveOnboardingExclusion[] {
  const reviewed = new Set<string>(LEGACY_CHANNEL_IDS);
  return onboardingReferencedChannels(snapshot).filter((exclusion) => reviewed.has(exclusion.channelId));
}

export function planArchiveOperations(snapshot: LiveCleanupSnapshot): CleanupOperation[] {
  assertReviewedShape(snapshot);
  assertHierarchy(snapshot);
  const excluded = new Map(archiveOnboardingExclusions(snapshot).map((exclusion) => [exclusion.channelId, exclusion]));
  const channels = [...LEGACY_CHANNEL_IDS].sort().flatMap((objectId) => {
    const channel = snapshot.channels.find((item) => item.id === objectId)!;
    const parent = snapshot.channels.find((item) => item.id === channel.parent_id)!;
    const synchronized = stable(normalizeOverwrites(channel.permission_overwrites ?? [])) === stable(normalizeOverwrites(parent.permission_overwrites ?? []));
    const exclusion = excluded.get(objectId);
    if (exclusion) {
      // Skipping the channel PATCH is only half of it. A synchronized child inherits
      // whatever the category is set to, so the category deny would hide this channel
      // anyway — through a write Discord never gets to refuse, silently breaking the
      // reference that protects it. There is no partial plan that is honest here, so
      // refuse and name the reference the operator has to move first.
      if (synchronized) {
        throw new Error(`Reviewed legacy channel ${objectId} is pinned publicly readable by ${exclusion.referencedBy.join(', ')}, and Discord refuses to hide it (400 code 350003) — but it is permission-synchronized with category ${parent.id}, so the category deny would hide it by inheritance. Repoint that reference to an active channel before planning.`);
      }
      return [];
    }
    return synchronized ? [] : [{ objectId, objectType: 'channel' as const }];
  });
  const categories = [...LEGACY_CATEGORY_IDS].sort().map((objectId) => ({ objectId, objectType: 'category' as const }));
  const writes = [...channels, ...categories].map(({ objectId, objectType }) => {
    const target = snapshot.channels.find((channel) => channel.id === objectId)!;
    const before = normalizeOverwrites(target.permission_overwrites ?? []);
    const write = archiveVisibilityOverwrites(snapshot, target, before);
    return { objectId, objectType, before, write };
  });
  return writes.map(({ objectId, objectType, before, write }, index) => {
    const kind = objectType === 'category' ? 'patch-category-overwrites' as const : 'patch-channel-overwrites' as const;
    const body = { phase: ARCHIVE_PHASE, kind, objectType, objectId, expectedBefore: { permission_overwrites: before }, write: { permission_overwrites: write }, inverseWrite: { permission_overwrites: before } };
    return {
      version: 1,
      sequence: index + 1,
      id: `archive-legacy:${String(index + 1).padStart(3, '0')}:${objectType}:${objectId}:${sha256(body).slice(0, 16)}`,
      phase: ARCHIVE_PHASE,
      kind,
      objectType,
      objectId,
      expectedBefore: { permission_overwrites: before },
      write: { permission_overwrites: write },
      inverseWrite: { permission_overwrites: before },
    };
  });
}

export function operationSemanticHash(operations: CleanupOperation[]): string {
  return sha256(operations.map(({ sequence, id, phase, kind, objectType, objectId, expectedBefore, write, inverseWrite }) => ({ sequence, id, phase, kind, objectType, objectId, expectedBefore, write, inverseWrite })));
}

export function buildManifest(snapshot: LiveCleanupSnapshot, snapshotPath: string, operations: CleanupOperation[], token: string): CleanupManifest {
  const operationHash = operationSemanticHash(operations);
  const manifest: CleanupManifest = {
    version: 1,
    kind: 'live-clean-slate-cleanup',
    phase: ARCHIVE_PHASE,
    status: 'planned',
    generatedAt: snapshot.generatedAt,
    applicationId: snapshot.applicationId,
    guildId: snapshot.guildId,
    snapshotPath,
    snapshotGeneratedAt: snapshot.generatedAt,
    snapshotSemanticHash: snapshot.semanticHash,
    planSignature: planSignature(token, snapshot.generatedAt, snapshot.semanticHash, operationHash),
    journalSignature: '',
    journalSequence: 0,
    operationSemanticHash: operationHash,
    operationCount: operations.length,
    reviewedLegacyChannelIds: [...LEGACY_CHANNEL_IDS],
    reviewedLegacyCategoryIds: [...LEGACY_CATEGORY_IDS],
    activeChannelIds: [...ACTIVE_CHANNEL_IDS],
    activeCategoryIds: [...ACTIVE_CATEGORY_IDS],
    visibilityExemptions: archiveVisibilityExemptions(snapshot),
    onboardingExclusions: archiveOnboardingExclusions(snapshot),
    operations: operations.map((operation) => ({ ...operation, state: 'pending' })),
  };
  manifest.journalSignature = journalSignature(token, manifest);
  return manifest;
}
