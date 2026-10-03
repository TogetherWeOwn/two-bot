/**
 * TOG-3481 staging slice: leveling import dry-run check (MEE6 parity probe).
 *
 * Staging-only, read-only. Never writes live guild roles.
 * - Reads a MEE6-style export fixture (or generates a synthetic one).
 * - Validates Owen leveling import mapping without writing.
 * - Reports mapped vs unmapped reward roles.
 * - Asserts zero writes to live guild 326474832151838730.
 *
 * No PII export: fixture uses synthetic Discord IDs 90000000000000001+.
 * Exit codes: 0 ok, 1 not reconciled / mapping check failed, 2 usage / live fence.
 */
import { readFile, writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { openDb } from '../src/store/db.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';
import { LevelingService, levelForXp } from '../src/leveling/service.ts';
import {
  Mee6ExportError,
  digestBuffer,
  inventory,
  parseMee6Export,
  planMee6Import,
  sha256,
  type ImportPlan,
} from '../src/leveling/importManifest.ts';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-mee6-parity-probe.ts --guild <snowflake> [--file <export.json>] [--manifest <path>] [--allow-live-guild]\n' +
      '  Reads a MEE6 export fixture (array or {players:[...]}) and validates the Owen leveling import mapping.\n' +
      '  Without --file a synthetic fixture is generated (synthetic IDs 90000000000000001+).\n' +
      '  Dry-run only: nothing is written, even with --allow-live-guild the probe never applies.\n' +
      '  Reports mapped vs unmapped reward roles and asserts zero writes to live guild 326474832151838730.\n' +
      '  --guild defaults to staging guild 1545644954272137297.\n' +
      '  --allow-live-guild is accepted but still dry-run; it only bypasses the default-deny fence for inspection.\n',
  );
  process.exit(2);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) usage();
  return v;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

// ---------------------------------------------------------------------------
// Synthetic fixture: no PII, deterministic, covers MEE6 curve thresholds.
// Uses the same 9000... block as src/staging/fixtures.ts.
// ---------------------------------------------------------------------------
const SYNTHETIC_IDS = [
  '90000000000000001',
  '90000000000000002',
  '90000000000000003',
  '90000000000000004',
  '90000000000000005',
  '90000000000000006',
  '90000000000000007',
  '90000000000000008',
] as const;

interface SyntheticRow {
  id: string;
  xp: number;
  level?: number;
}

function syntheticFixture(): { json: string; rows: SyntheticRow[] } {
  // Thresholds: level 0=0, 1=100, 5=1150, 10=4675, 20=23850
  // Include a mid-level and a duplicate max-wins case.
  const rows: SyntheticRow[] = [
    { id: SYNTHETIC_IDS[0], xp: 0 },
    { id: SYNTHETIC_IDS[1], xp: 100, level: 1 },
    { id: SYNTHETIC_IDS[2], xp: 1150, level: 5 },
    { id: SYNTHETIC_IDS[3], xp: 4675, level: 10 },
    { id: SYNTHETIC_IDS[4], xp: 23850, level: 20 },
    { id: SYNTHETIC_IDS[5], xp: 5000 }, // ~level 10, between thresholds
    // Duplicate for same member: max-wins must keep 900, not 100
    { id: SYNTHETIC_IDS[6], xp: 100 },
    { id: SYNTHETIC_IDS[6], xp: 900, level: 4 },
    { id: SYNTHETIC_IDS[7], xp: 250 },
  ];
  return { json: JSON.stringify(rows, null, 2), rows };
}

function mappedVsUnmapped(
  rewards: Array<{ level: number; roleId: string }>,
  memberLevels: number[],
) {
  const maxLevel = memberLevels.length ? Math.max(...memberLevels) : -1;
  const mapped: typeof rewards = [];
  const unmapped: typeof rewards = [];
  for (const r of rewards) {
    // A reward is mapped if at least one member's level reaches it.
    const hits = memberLevels.some((lv) => lv >= r.level);
    if (hits) mapped.push(r);
    else unmapped.push(r);
  }
  // Also compute per-reward hit count for the report.
  const hitsByReward = rewards.map((r) => ({
    level: r.level,
    roleId: r.roleId,
    earnedByMembers: memberLevels.filter((lv) => lv >= r.level).length,
    mapped: memberLevels.some((lv) => lv >= r.level),
  }));
  return { mapped, unmapped, hitsByReward, maxLevel };
}

// ---------------------------------------------------------------------------
// Args and live fence (before DB opens, like levels-import-mee6.ts)
// ---------------------------------------------------------------------------
const guildId = arg('--guild') ?? TWO_STAGING_GUILD_ID;
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('--guild must be a Discord snowflake');
  usage();
}
const allowLive = hasFlag('--allow-live-guild');
if (guildId === LIVE_GUILD_ID && !allowLive) {
  console.error(
    `Refusing live guild ${LIVE_GUILD_ID}. ` +
      'Use --allow-live-guild only for an owner-approved rollout. ' +
      'This probe is staging-only and dry-run by construction.',
  );
  process.exit(2);
}
const filePath = arg('--file');
const manifestPath = arg('--manifest');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');

const db = await openDb(databaseUrl, {
  poolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5),
});

let exitCode = 0;
try {
  // Snapshot live inventory before anything (read-only, exempt from fence).
  const liveBefore = await inventory(db, LIVE_GUILD_ID);
  const stagingBefore = await inventory(db, guildId);

  let fileDigest: { path: string; bytes: number; sha256: string };
  let sourceText: string;
  let synthetic = false;

  if (filePath) {
    const buf = await readFileAsync(filePath);
    fileDigest = digestBuffer(filePath, buf);
    sourceText = buf.toString('utf8');
  } else {
    const { json } = syntheticFixture();
    sourceText = json;
    const buf = Buffer.from(json, 'utf8');
    // Use a synthetic path label so the digest is still meaningful.
    const syntheticPath = 'synthetic:mee6-fixture';
    fileDigest = digestBuffer(syntheticPath, buf);
    synthetic = true;
  }

  let rows: ReturnType<typeof parseMee6Export>;
  try {
    rows = parseMee6Export(sourceText);
  } catch (e) {
    if (e instanceof Mee6ExportError) {
      console.error(e.message);
      process.exitCode = 1;
      throw e;
    }
    throw e;
  }

  const plan: ImportPlan = await planMee6Import(db, guildId, rows, {
    allowLower: hasFlag('--allow-lower'),
  });

  // Fetch configured level -> role rewards for the probed guild.
  const service = new LevelingService(db);
  const rewards = await service.roleRewards(guildId);

  // Member levels present in the export (unique members after max-wins collapse).
  // Use the same max-wins map as planMee6Import so mapped/unmapped agrees with the import.
  const byMember = new Map<string, number>();
  for (const r of rows) {
    const held = byMember.get(r.memberId);
    if (held === undefined) byMember.set(r.memberId, r.xp);
    else byMember.set(r.memberId, Math.max(held, r.xp));
  }
  const memberLevels = [...byMember.values()].map((xp) => levelForXp(xp)).sort((a, b) => a - b);
  const uniqueMemberLevels = [...new Set(memberLevels)].sort((a, b) => a - b);

  const { mapped, unmapped, hitsByReward, maxLevel } = mappedVsUnmapped(rewards, memberLevels);

  // Re-read inventories: plan is read-only, so these must be identical to before.
  const liveAfter = await inventory(db, LIVE_GUILD_ID);
  const stagingAfter = await inventory(db, guildId);

  const liveWritesVerified =
    liveBefore.memberRows === liveAfter.memberRows &&
    liveBefore.totalXp === liveAfter.totalXp &&
    liveBefore.totalOrganicXp === liveAfter.totalOrganicXp &&
    liveBefore.totalImportedXp === liveAfter.totalImportedXp;

  const stagingWritesVerified =
    stagingBefore.memberRows === stagingAfter.memberRows &&
    stagingBefore.totalXp === stagingAfter.totalXp &&
    stagingBefore.totalOrganicXp === stagingAfter.totalOrganicXp &&
    stagingBefore.totalImportedXp === stagingAfter.totalImportedXp;

  const reconciled = plan.accounting.balances && stagingWritesVerified && liveWritesVerified;
  const reconciliationErrors: string[] = [];
  if (!plan.accounting.balances) {
    reconciliationErrors.push(`row accounting does not balance: ${JSON.stringify(plan.accounting)}`);
  }
  if (!stagingWritesVerified) {
    reconciliationErrors.push(
      `staging inventory changed during dry-run: before ${JSON.stringify(stagingBefore)} after ${JSON.stringify(stagingAfter)}`,
    );
  }
  if (!liveWritesVerified) {
    reconciliationErrors.push(
      `live guild ${LIVE_GUILD_ID} inventory changed during dry-run: before ${JSON.stringify(liveBefore)} after ${JSON.stringify(liveAfter)}`,
    );
  }

  const report = {
    manifestVersion: 1 as const,
    probe: 'levels-mee6-parity-probe' as const,
    guildId,
    liveGuildId: LIVE_GUILD_ID,
    mode: 'dry-run' as const,
    syntheticFixture: synthetic,
    file: fileDigest,
    // Deterministic checksum of the bytes actually parsed (not a second read).
    fileSha256Verified: fileDigest.sha256 === sha256(Buffer.from(sourceText, 'utf8')),
    totalXpIn: plan.totalXpIn,
    uniqueXpIn: plan.uniqueXpIn,
    importedXpWritten: plan.importedXpWritten,
    rowsWritten: plan.accounting.inserted + plan.accounting.updated,
    accounting: plan.accounting,
    skipped: plan.skipped,
    skippedByReason: (() => {
      const counts: Record<string, number> = {
        duplicate_row: 0,
        would_lower_imported_xp: 0,
        exceeds_xp_ceiling: 0,
      };
      for (const s of plan.skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
      return counts;
    })(),
    inventoryBefore: plan.inventoryBefore,
    inventoryAfter: null as null,
    totalXpAfterProjected: plan.totalXpAfterProjected,
    totalXpAfterMeasured: null as null,
    reconciled,
    reconciliationErrors,
    // Reward mapping
    rewards: {
      configured: rewards,
      configuredCount: rewards.length,
      memberLevels,
      uniqueMemberLevels,
      maxLevelInExport: maxLevel,
      mapped,
      unmapped,
      mappedCount: mapped.length,
      unmappedCount: unmapped.length,
      hitsByReward,
    },
    // Live-guild write assertion (the acceptance criterion)
    liveGuildWriteCheck: {
      liveGuildId: LIVE_GUILD_ID,
      writesToLive: 0,
      verified: liveWritesVerified,
      liveInventoryBefore: liveBefore,
      liveInventoryAfter: liveAfter,
      stagingInventoryBefore: stagingBefore,
      stagingInventoryAfter: stagingAfter,
      stagingWritesVerified,
      note: 'dry-run only: no rows written to any guild; live guild inventory re-read and compared',
    },
  };

  const rendered = JSON.stringify(report, null, 2);
  if (manifestPath) writeFileSync(manifestPath, `${rendered}\n`);
  console.log(rendered);

  if (!reconciled) {
    console.error(`Probe did not reconcile:\n  ${reconciliationErrors.join('\n  ')}`);
    exitCode = 1;
  }
  // Also fail if rewards are configured but none mapped and none unmapped is impossible;
  // instead warn when rewards exist but export has no members that reach any of them.
  if (rewards.length > 0 && mapped.length === 0) {
    console.error(
      `All ${rewards.length} reward roles are unmapped: no member in the fixture reaches any reward level. ` +
        `Max level in export is ${maxLevel}; rewards at ${rewards.map((r) => r.level).join(', ')}. ` +
        'This is reported, not a failure, but check if the fixture is representative.',
    );
  }

  process.exitCode = exitCode;
} catch (error) {
  if (error instanceof Mee6ExportError) {
    // Already logged and exitCode set; keep 1 unless fence already set 2.
    if (process.exitCode === 0) process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.close();
  if (exitCode !== 0 && process.exitCode === 0) process.exitCode = exitCode;
}
