import { createHash, createHmac } from 'node:crypto';
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
  kind: 'patch-category-overwrites';
  objectType: 'category';
  objectId: string;
  expectedBefore: { permission_overwrites: Overwrite[] };
  write: { permission_overwrites: Overwrite[] };
  inverseWrite: { permission_overwrites: Overwrite[] };
};
export type OperationState = 'pending' | 'requesting' | 'applied' | 'rolled_back';
export type RollbackEntry = CleanupOperation & { state: OperationState; requestStartedAt?: string; appliedAt?: string; rolledBackAt?: string };
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
  operationSemanticHash: string;
  operationCount: number;
  reviewedLegacyChannelIds: string[];
  reviewedLegacyCategoryIds: string[];
  activeChannelIds: string[];
  activeCategoryIds: string[];
  operations: RollbackEntry[];
};

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

export function semanticSnapshot(input: Omit<LiveCleanupSnapshot, 'semanticHash'>): JsonObject {
  return {
    version: input.version,
    applicationId: input.applicationId,
    guildId: input.guildId,
    guild: input.guild,
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
    const parent = snapshot.channels.find((item) => item.id === channel.parent_id)!;
    if (stable(normalizeOverwrites(channel.permission_overwrites ?? [])) !== stable(normalizeOverwrites(parent.permission_overwrites ?? []))) {
      throw new Error(`Reviewed legacy channel ${id} is permission-unsynchronized from category ${parent.id}; category-only archive cannot prove it will inherit the deny.`);
    }
  }
  const reviewed = new Set([...ACTIVE_CATEGORY_IDS, ...ACTIVE_CHANNEL_IDS, ...LEGACY_CATEGORY_IDS, ...LEGACY_CHANNEL_IDS]);
  const duplicateMergeIds = new Set(['1545924265868525588', '1545924268489973841']);
  const ignoredEmptyIds = new Set(['1545924265247903884', '1545924267453976696']);
  const unknown = snapshot.channels.filter((channel) => !reviewed.has(channel.id as never) && !duplicateMergeIds.has(channel.id) && !ignoredEmptyIds.has(channel.id));
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

export function planArchiveOperations(snapshot: LiveCleanupSnapshot): CleanupOperation[] {
  assertReviewedShape(snapshot);
  assertHierarchy(snapshot);
  return [...LEGACY_CATEGORY_IDS].sort().map((objectId, index) => {
    const category = snapshot.channels.find((channel) => channel.id === objectId)!;
    const before = normalizeOverwrites(category.permission_overwrites ?? []);
    const write = archiveEveryoneOverwrite(snapshot.guildId, before);
    const body = { phase: ARCHIVE_PHASE, objectId, expectedBefore: { permission_overwrites: before }, write: { permission_overwrites: write }, inverseWrite: { permission_overwrites: before } };
    return {
      version: 1,
      sequence: index + 1,
      id: `archive-legacy:${String(index + 1).padStart(3, '0')}:${objectId}:${sha256(body).slice(0, 16)}`,
      phase: ARCHIVE_PHASE,
      kind: 'patch-category-overwrites',
      objectType: 'category',
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
  return {
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
    operationSemanticHash: operationHash,
    operationCount: operations.length,
    reviewedLegacyChannelIds: [...LEGACY_CHANNEL_IDS],
    reviewedLegacyCategoryIds: [...LEGACY_CATEGORY_IDS],
    activeChannelIds: [...ACTIVE_CHANNEL_IDS],
    activeCategoryIds: [...ACTIVE_CATEGORY_IDS],
    operations: operations.map((operation) => ({ ...operation, state: 'pending' })),
  };
}
