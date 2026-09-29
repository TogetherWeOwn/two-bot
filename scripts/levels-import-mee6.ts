/**
 * MEE6 import and its reconciliation manifest (TOG-1645, TOG-3191).
 *
 * Dry run is the default. `--apply` is the only thing that writes, because an
 * import that runs by accident against a guild with organic XP is not something
 * you can undo from a manifest.
 *
 * Exit codes: 0 fine, 1 the export or the write did not reconcile, 2 usage
 * or bad config (unknown flag/command, bad --guild, bad TWO_DB_POOL_MAX).
 */
import { statSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/store/db.ts';
import { LIVE_GUILD_ID } from '../src/staging/spec.ts';
import {
  Mee6ExportError,
  inventory,
  runMee6Import,
  type ImportManifest,
} from '../src/leveling/importManifest.ts';

function usage(): never {
  console.error(
    'Usage: node scripts/levels-import-mee6.ts [import] --guild <snowflake> --file <export.json>\n' +
      '                                          [--apply] [--allow-lower] [--manifest <path>] [--allow-live-guild]\n' +
      '       node scripts/levels-import-mee6.ts inventory --guild <snowflake>\n' +
      '\n' +
      'Accepted JSON: an array of players, or {players:[...]}; each player needs id/user_id and xp.\n' +
      'Without --apply nothing is written and the full manifest is still produced.\n' +
      "--allow-lower applies rows that would lower a member's imported XP; they are skipped by default.\n" +
      '--allow-live-guild is only for an owner-approved rollout.',
  );
  process.exit(2);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith('--')) usage();
  return value;
}

function optional(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) usage();
  return value;
}

// Any bare word that is not a flag value is a subcommand candidate: the only
// accepted ones are `import` (the default when no subcommand is given) and
// `inventory`. Anything else (e.g. a typo like `inventroy`) is a usage error,
// exit 2, before the guild is parsed and before the database opens — so a
// read-only intent can never become a write just because `--apply` is present
// (TOG-9912).
const VALUE_FLAGS = new Set(['--guild', '--file', '--manifest']);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, '--apply', '--allow-lower', '--allow-live-guild']);
const bareWords: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (VALUE_FLAGS.has(token)) {
    i++;
    continue;
  }
  if (token.startsWith('--')) {
    // A typo'd write-intent flag (e.g. --aply) must fail loudly: silently
    // ignoring it turns an intended --apply into a dry run with exit 0
    // (TOG-9913).
    if (!KNOWN_FLAGS.has(token)) {
      console.error(`Unknown flag "${token}".`);
      usage();
    }
    continue;
  }
  bareWords.push(token);
}
const unknown = bareWords.find((word) => word !== 'import' && word !== 'inventory');
if (unknown !== undefined || bareWords.length > 1) {
  console.error(`Unknown subcommand "${unknown ?? bareWords[1]}".`);
  usage();
}
const command = bareWords[0] === 'inventory' ? 'inventory' : 'import';

const guildId = arg('--guild');
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('--guild must be a Discord snowflake (17-20 digits).');
  usage();
}

// Before the database opens, so a mistyped guild fails on the fence rather than
// on a connection string.
//
// The fence covers `import` whether or not --apply was passed: the contract the
// suite pins is "default-deny the live guild", and a dry run that has to be
// re-run with --apply teaches the operator to reach for --allow-live-guild
// first. `inventory` is exempt because it only reads, and reading the live
// member_levels before an import is the entire point of having it.
const writes = command === 'import' && process.argv.includes('--apply');
if (command === 'import' && guildId === LIVE_GUILD_ID && !process.argv.includes('--allow-live-guild')) {
  console.error(
    `Refusing live guild ${LIVE_GUILD_ID}. ` +
      'Use --allow-live-guild only for an owner-approved rollout.',
  );
  process.exit(2);
}

const file = command === 'import' ? arg('--file') : null;
const manifestPath = optional('--manifest');

// Fail fast before the database opens: a manifest destination that is already
// a directory can never accept the evidence write, so refusing here keeps a
// doomed --apply from mutating member_levels first (TOG-9914).
if (command === 'import' && manifestPath) {
  let destinationIsDirectory = false;
  try {
    destinationIsDirectory = statSync(manifestPath).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (destinationIsDirectory) {
    console.error(`--manifest destination is a directory, refusing to import: ${manifestPath}`);
    process.exit(2);
  }
}

const databaseUrl = process.env.TWO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TWO_DATABASE_URL is required.');
// A non-numeric TWO_DB_POOL_MAX must fail here, not as NaN handed to pg-pool
// with a passing exit code (TOG-9913).
const poolMaxRaw = process.env.TWO_DB_POOL_MAX ?? '5';
const poolMax = Number(poolMaxRaw);
if (!Number.isInteger(poolMax) || poolMax <= 0) {
  console.error(`TWO_DB_POOL_MAX must be a positive integer, got "${poolMaxRaw}".`);
  usage();
}
const db = await openDb(databaseUrl, { poolMax });

let manifest: ImportManifest | null = null;
try {
  if (command === 'inventory') {
    console.log(JSON.stringify(await inventory(db, guildId), null, 2));
  } else {
    manifest = await runMee6Import(db, guildId, file!, {
      apply: writes,
      allowLower: process.argv.includes('--allow-lower'),
    });
    const rendered = JSON.stringify(manifest, null, 2);
    // Stdout first, so a failed --manifest file write never destroys the only
    // copy of what was just mutated (TOG-9914).
    console.log(rendered);
    if (manifestPath) {
      try {
        writeFileSync(manifestPath, `${rendered}\n`);
      } catch (error) {
        console.error(
          `Failed to write --manifest ${manifestPath}: ${(error as Error).message}. ` +
            'The manifest above was still printed to stdout.',
        );
        process.exitCode = 1;
      }
    }
  }
} catch (error) {
  if (!(error instanceof Mee6ExportError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}

if (manifest && !manifest.reconciled) {
  console.error(
    `Import did not reconcile:\n  ${manifest.reconciliationErrors.join('\n  ')}`,
  );
  process.exitCode = 1;
}
