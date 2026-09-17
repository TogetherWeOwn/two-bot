/**
 * Reconciliation wrapper around the MEE6 import (TOG-3191).
 *
 * `LevelingService.importMee6` is the importer and is not the missing piece.
 * What was missing was any way to know the write did what the export said: no
 * checksum of the file, no row/XP reconciliation either side of the write, and
 * no inventory of the live rows the import lands on top of.
 *
 * Merge semantics, for the record - the authority is the schema comment at
 * migrations/0010_leveling.sql:4-6, "Imported XP is kept separate from organic
 * message/voice XP so a corrected export can replace the import without erasing
 * activity earned after migration":
 *
 *   message_xp / voice_xp  never written by the import. Preserved exactly.
 *   imported_xp            OVERWRITTEN by the export's number.
 *   xp                     the sum, per the table's CHECK constraint.
 *
 * So "preserve organic live XP" is answered by the column split, not by the
 * merge - which is why the merge is overwrite and not add. Add would
 * double-count every re-import.
 *
 * Overwrite is symmetric, though, and that is the hole this module plugs: a
 * stale export carrying a LOWER number silently lowers a member's total, and
 * importMee6 reports it as a plain `updated`. Such rows are declined by default
 * and named in the manifest. `allowLower` opts back in.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Db } from '../store/driver.ts';
import {
  LevelingService,
  MAX_STORED_XP,
  levelForXp,
  type ImportSummary,
  type Mee6ImportRow,
} from './service.ts';

export const MANIFEST_VERSION = 1;

/** Why a row present in the export was not applied. */
export type SkipReason = 'duplicate_row' | 'would_lower_imported_xp' | 'exceeds_xp_ceiling';

export const SKIP_REASONS: readonly SkipReason[] = [
  'duplicate_row',
  'would_lower_imported_xp',
  'exceeds_xp_ceiling',
];

export interface SkippedRow {
  memberId: string;
  /** The XP the export asked for. */
  xp: number;
  reason: SkipReason;
  /** Human-readable justification, always naming the number that lost. */
  detail: string;
}

export interface FileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LevelInventory {
  guildId: string;
  memberRows: number;
  totalXp: number;
  totalOrganicXp: number;
  totalImportedXp: number;
}

export interface ImportAccounting {
  rowsIn: number;
  duplicateRows: number;
  uniqueMembersIn: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedMembers: number;
  /**
   * Both identities must hold, or the manifest is not a faithful account of the
   * file and the run fails:
   *   rowsIn          === duplicateRows + uniqueMembersIn
   *   uniqueMembersIn === inserted + updated + unchanged + skippedMembers
   */
  balances: boolean;
}

export interface ImportManifest {
  manifestVersion: number;
  guildId: string;
  mode: 'dry-run' | 'apply';
  file: FileDigest;
  /** Sum of `xp` over every row in the file, duplicates included. */
  totalXpIn: number;
  /** Sum of `xp` over unique members after the max-wins duplicate collapse. */
  uniqueXpIn: number;
  accounting: ImportAccounting;
  /** inserted + updated. Planned rather than performed when mode is dry-run. */
  rowsWritten: number;
  /** Sum of imported_xp set across those rows. */
  importedXpWritten: number;
  skipped: SkippedRow[];
  skippedByReason: Record<SkipReason, number>;
  inventoryBefore: LevelInventory;
  inventoryAfter: LevelInventory | null;
  /** Derived from the export plus the inventory, never from the post-write read. */
  totalXpAfterProjected: number;
  /** Read back from member_levels. Null in dry-run. */
  totalXpAfterMeasured: number | null;
  /** False means some number above does not add up. Callers must fail on it. */
  reconciled: boolean;
  reconciliationErrors: string[];
  importSummary: ImportSummary | null;
}

export interface ImportPlan {
  /** The rows handed to the service, in file order. */
  apply: Mee6ImportRow[];
  accounting: ImportAccounting;
  skipped: SkippedRow[];
  inventoryBefore: LevelInventory;
  totalXpIn: number;
  uniqueXpIn: number;
  importedXpWritten: number;
  totalXpAfterProjected: number;
}

export interface PlanOptions {
  /** Apply rows that lower a member's imported XP instead of skipping them. */
  allowLower?: boolean;
}

interface Mee6Player {
  id?: string;
  user_id?: string;
  xp?: number;
  level?: number;
}

/**
 * Every malformed row, not just the first.
 *
 * Fixing an export one error per run is how a 20k-row import takes a day.
 */
export class Mee6ExportError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`MEE6 export is not importable:\n  ${problems.join('\n  ')}`);
    this.name = 'Mee6ExportError';
    this.problems = problems;
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Digest bytes already in hand, so the hash and the parse cannot disagree. */
export function digestBuffer(path: string, contents: Buffer): FileDigest {
  return { path, bytes: contents.byteLength, sha256: sha256(contents) };
}

export async function digestFile(path: string): Promise<FileDigest> {
  return digestBuffer(path, await readFile(path));
}

/**
 * Parse and fully validate a MEE6 export.
 *
 * Validation duplicates what `importMee6` asserts on the way in. That is
 * deliberate: the service throws mid-transaction on the first bad row, which
 * tells an operator nothing about the other 19,999.
 */
export function parseMee6Export(text: string): Mee6ImportRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Mee6ExportError([`file is not valid JSON: ${(error as Error).message}`]);
  }
  const players = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { players?: unknown }).players)
      ? (parsed as { players: unknown[] }).players
      : null;
  if (!players) {
    throw new Mee6ExportError(['export must be an array or an object with a players array']);
  }

  const problems: string[] = [];
  const rows: Mee6ImportRow[] = [];
  players.forEach((raw, index) => {
    const at = `row ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      problems.push(`${at} is not an object`);
      return;
    }
    const player = raw as Mee6Player;
    const memberId = player.id ?? player.user_id;
    if (typeof memberId !== 'string') {
      problems.push(`${at} has no id or user_id`);
      return;
    }
    if (!/^\d{17,20}$/.test(memberId)) {
      problems.push(`${at} has an invalid Discord member id: ${memberId}`);
      return;
    }
    if (!Number.isSafeInteger(player.xp) || Number(player.xp) < 0) {
      problems.push(`${at} has invalid xp`);
      return;
    }
    const xp = Number(player.xp);
    if (player.level !== undefined) {
      if (!Number.isInteger(player.level) || player.level < 0) {
        problems.push(`${at} has invalid level`);
        return;
      }
      if (levelForXp(xp) !== player.level) {
        problems.push(`${at} states level ${player.level} but ${xp} XP is level ${levelForXp(xp)}`);
        return;
      }
    }
    rows.push({ memberId, xp, level: player.level });
  });

  if (problems.length > 0) throw new Mee6ExportError(problems);
  return rows;
}

export async function inventory(db: Db, guildId: string): Promise<LevelInventory> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)                            AS member_rows,
              COALESCE(SUM(xp), 0)                AS total_xp,
              COALESCE(SUM(message_xp + voice_xp), 0) AS total_organic_xp,
              COALESCE(SUM(imported_xp), 0)       AS total_imported_xp
         FROM member_levels
        WHERE guild_id = ?`,
    )
    .get<{
      member_rows: number;
      total_xp: number;
      total_organic_xp: number;
      total_imported_xp: number;
    }>(guildId);
  return {
    guildId,
    memberRows: Number(row?.member_rows ?? 0),
    totalXp: Number(row?.total_xp ?? 0),
    totalOrganicXp: Number(row?.total_organic_xp ?? 0),
    totalImportedXp: Number(row?.total_imported_xp ?? 0),
  };
}

interface ExistingLevel {
  xp: number;
  organicXp: number;
  importedXp: number;
}

/** Chunked so a 20k-row export does not build a 20k-placeholder statement. */
async function existingLevels(
  db: Db,
  guildId: string,
  memberIds: readonly string[],
): Promise<Map<string, ExistingLevel>> {
  const out = new Map<string, ExistingLevel>();
  const chunkSize = 500;
  for (let i = 0; i < memberIds.length; i += chunkSize) {
    const chunk = memberIds.slice(i, i + chunkSize);
    const rows = await db
      .prepare(
        `SELECT member_id, xp, message_xp, voice_xp, imported_xp
           FROM member_levels
          WHERE guild_id = ?
            AND member_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all<{
        member_id: string;
        xp: number;
        message_xp: number;
        voice_xp: number;
        imported_xp: number;
      }>(guildId, ...chunk);
    for (const row of rows) {
      out.set(row.member_id, {
        xp: Number(row.xp),
        organicXp: Number(row.message_xp) + Number(row.voice_xp),
        importedXp: Number(row.imported_xp),
      });
    }
  }
  return out;
}

/**
 * Classify every row against the live table without writing anything.
 *
 * The duplicate collapse is max-wins and must happen before the lowering check,
 * or a member listed twice as (900, 100) would be judged on the 100.
 */
export async function planMee6Import(
  db: Db,
  guildId: string,
  rows: readonly Mee6ImportRow[],
  options: PlanOptions = {},
): Promise<ImportPlan> {
  const skipped: SkippedRow[] = [];
  const winner = new Map<string, number>();
  let totalXpIn = 0;

  for (const row of rows) {
    totalXpIn += row.xp;
    const held = winner.get(row.memberId);
    if (held === undefined) {
      winner.set(row.memberId, row.xp);
      continue;
    }
    const kept = Math.max(held, row.xp);
    const dropped = Math.min(held, row.xp);
    winner.set(row.memberId, kept);
    skipped.push({
      memberId: row.memberId,
      xp: dropped,
      reason: 'duplicate_row',
      detail: `member listed more than once; kept the highest XP ${kept}, dropped ${dropped}`,
    });
  }
  const duplicateRows = skipped.length;

  const inventoryBefore = await inventory(db, guildId);
  const existing = await existingLevels(db, guildId, [...winner.keys()]);

  const declined = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let uniqueXpIn = 0;
  let importedXpWritten = 0;
  let projectedDelta = 0;

  for (const [memberId, xp] of winner) {
    uniqueXpIn += xp;
    const live = existing.get(memberId);
    if (!live) {
      inserted++;
      importedXpWritten += xp;
      projectedDelta += xp;
      continue;
    }
    if (live.importedXp === xp) {
      unchanged++;
      continue;
    }
    if (xp < live.importedXp && !options.allowLower) {
      declined.add(memberId);
      skipped.push({
        memberId,
        xp,
        reason: 'would_lower_imported_xp',
        detail:
          `export XP ${xp} is below the ${live.importedXp} already imported for this member; ` +
          `applying it would drop the stored total from ${live.xp} to ${live.organicXp + xp}. ` +
          'Pass --allow-lower to apply it anyway.',
      });
      continue;
    }
    if (live.organicXp + xp > MAX_STORED_XP) {
      declined.add(memberId);
      skipped.push({
        memberId,
        xp,
        reason: 'exceeds_xp_ceiling',
        detail: `organic XP ${live.organicXp} plus imported ${xp} exceeds the ${MAX_STORED_XP} ceiling`,
      });
      continue;
    }
    updated++;
    importedXpWritten += xp;
    projectedDelta += xp - live.importedXp;
  }

  const skippedMembers = declined.size;
  const uniqueMembersIn = winner.size;
  const accounting: ImportAccounting = {
    rowsIn: rows.length,
    duplicateRows,
    uniqueMembersIn,
    inserted,
    updated,
    unchanged,
    skippedMembers,
    balances:
      rows.length === duplicateRows + uniqueMembersIn &&
      uniqueMembersIn === inserted + updated + unchanged + skippedMembers,
  };

  return {
    apply: rows.filter((row) => !declined.has(row.memberId)),
    accounting,
    skipped,
    inventoryBefore,
    totalXpIn,
    uniqueXpIn,
    importedXpWritten,
    totalXpAfterProjected: inventoryBefore.totalXp + projectedDelta,
  };
}

function tally(skipped: readonly SkippedRow[]): Record<SkipReason, number> {
  const counts = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
  for (const row of skipped) counts[row.reason]++;
  return counts;
}

export interface ImportRunOptions extends PlanOptions {
  /** Writes only when true. Everything else is a dry run by construction. */
  apply?: boolean;
  importedAt?: string;
}

/**
 * Plan, optionally write, then prove the write matched the plan.
 *
 * `reconciled: false` is the loud failure: it means the projection derived from
 * the export disagrees with what the database actually holds, and the caller is
 * expected to exit non-zero on it.
 */
export async function runMee6Import(
  db: Db,
  guildId: string,
  filePath: string,
  options: ImportRunOptions = {},
): Promise<ImportManifest> {
  // One read, hashed and parsed. Reading twice would let the manifest attest a
  // checksum of bytes other than the ones it imported.
  const contents = await readFile(filePath);
  const file = digestBuffer(filePath, contents);
  const rows = parseMee6Export(contents.toString('utf8'));
  const plan = await planMee6Import(db, guildId, rows, options);

  const reconciliationErrors: string[] = [];
  if (!plan.accounting.balances) {
    reconciliationErrors.push(
      `row accounting does not balance: ${JSON.stringify(plan.accounting)}`,
    );
  }

  let importSummary: ImportSummary | null = null;
  let inventoryAfter: LevelInventory | null = null;
  let totalXpAfterMeasured: number | null = null;

  if (options.apply) {
    importSummary = await new LevelingService(db).importMee6(
      guildId,
      plan.apply,
      options.importedAt,
    );
    inventoryAfter = await inventory(db, guildId);
    totalXpAfterMeasured = inventoryAfter.totalXp;

    if (totalXpAfterMeasured !== plan.totalXpAfterProjected) {
      reconciliationErrors.push(
        `total XP after the write is ${totalXpAfterMeasured}, projected ${plan.totalXpAfterProjected}`,
      );
    }
    for (const [field, planned] of [
      ['inserted', plan.accounting.inserted],
      ['updated', plan.accounting.updated],
      ['unchanged', plan.accounting.unchanged],
    ] as const) {
      const actual = importSummary[field];
      if (actual !== planned) {
        reconciliationErrors.push(`service reported ${field}=${actual}, planned ${planned}`);
      }
    }
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    guildId,
    mode: options.apply ? 'apply' : 'dry-run',
    file,
    totalXpIn: plan.totalXpIn,
    uniqueXpIn: plan.uniqueXpIn,
    accounting: plan.accounting,
    rowsWritten: plan.accounting.inserted + plan.accounting.updated,
    importedXpWritten: plan.importedXpWritten,
    skipped: plan.skipped,
    skippedByReason: tally(plan.skipped),
    inventoryBefore: plan.inventoryBefore,
    inventoryAfter,
    totalXpAfterProjected: plan.totalXpAfterProjected,
    totalXpAfterMeasured,
    reconciled: reconciliationErrors.length === 0,
    reconciliationErrors,
    importSummary,
  };
}
