/**
 * Apply the `web_v1` contract - the views the website reads.
 *
 * The SQL is in `sql/web_v1.sql` and that file is the contract. This module
 * only decides which schema to put it in and runs it. Keeping the SQL as SQL
 * means the thing a reviewer reads is the thing Postgres runs; there is no
 * query builder in between to disagree with the documentation.
 *
 * Idempotent: everything in the file is CREATE OR REPLACE / IF NOT EXISTS, so
 * this runs on every boot and is a no-op when nothing has changed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './driver.ts';
import { log } from '../core/log.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const WEB_CONTRACT_SQL = join(here, '..', '..', 'sql', 'web_v1.sql');

/** The major version, which is also the schema name in production. */
export const WEB_CONTRACT_SCHEMA = 'web_v1';

/**
 * The full version this build implements. Must match the row seeded in
 * migration 0003 and the changelog in docs/WEBSITE_CONTRACT.md.
 */
export const WEB_CONTRACT_VERSION = '1.0';

/**
 * Every view in the contract. The grant script grants SELECT on exactly these
 * and the verify script proves the website can read exactly these - so this
 * list is the single place "what the website can see" is written down.
 */
export const WEB_CONTRACT_VIEWS = [
  'contract_meta',
  'live_counts',
  'rank_counts',
  'members',
  'member_milestones',
  'upcoming_events',
  'next_event',
  'funnel_daily',
  'funnel_by_source',
] as const;

/**
 * Which schema the contract goes in, given the schema the bot's tables are in.
 *
 * Production is `public` -> `web_v1`, exactly as documented. The tests run each
 * file in its own schema (see test/helpers/testDb.ts) and they run in parallel,
 * so each one needs its own copy of the contract or they overwrite each other's
 * views mid-run. Same DDL either way; only the name moves.
 */
export function webSchemaFor(botSchema: string): string {
  return botSchema === 'public' ? WEB_CONTRACT_SCHEMA : `${botSchema}_${WEB_CONTRACT_SCHEMA}`;
}

/** Identifiers are interpolated into DDL, not bound. Be strict. */
function assertSafeSchema(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,58}$/.test(name)) {
    throw new Error(`unsafe schema name: ${name}`);
  }
}

export interface ApplyWebContractResult {
  /** The schema the views were created in. */
  webSchema: string;
  /** The schema the bot's tables live in, that those views read. */
  botSchema: string;
}

/**
 * Create or update the contract views. Postgres only - these are views over a
 * live schema and the SQLite path is on its way out.
 */
export async function applyWebContract(
  db: Db,
  sqlPath: string = WEB_CONTRACT_SQL,
): Promise<ApplyWebContractResult> {
  if (db.kind !== 'postgres') {
    throw new Error('applyWebContract() is Postgres-only');
  }

  const row = await db.prepare(`SELECT current_schema() AS schema`).get<{ schema: string }>();
  const botSchema = row?.schema;
  if (!botSchema) {
    // search_path resolved to nothing that exists. Creating views now would
    // put them somewhere nobody asked for.
    throw new Error('current_schema() is null - search_path points at no existing schema');
  }
  assertSafeSchema(botSchema);

  const webSchema = webSchemaFor(botSchema);
  assertSafeSchema(webSchema);

  const source = readFileSync(sqlPath, 'utf8');
  // The file names the production schema. Rewriting the whole-word token is
  // the identity in production, where webSchema IS 'web_v1'.
  const sql =
    webSchema === WEB_CONTRACT_SCHEMA
      ? source
      : source.replace(new RegExp(`\\b${WEB_CONTRACT_SCHEMA}\\b`, 'g'), webSchema);

  await db.exec(sql);

  log.info('web_contract_applied', {
    webSchema,
    botSchema,
    version: WEB_CONTRACT_VERSION,
    views: WEB_CONTRACT_VIEWS.length,
  });

  return { webSchema, botSchema };
}
