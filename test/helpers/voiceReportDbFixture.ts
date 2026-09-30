/** Hermetic voice-report collector: only SQL predicates select fixture rows. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Db, Statement } from '../../src/store/driver.ts';

export interface VoiceReportEvent {
  guild_id: string;
  event_type: string;
  member_id: string | null;
  occurred_at: string;
  recorded_at: string;
  source: string;
  metadata: string | null;
}

const events: VoiceReportEvent[] = JSON.parse(process.env.VOICE_REPORT_EVENTS ?? '[]');
const now = Date.parse('2026-09-30T12:00:00.000Z');
Date.now = () => now;

function select(sql: string, params: unknown[]): unknown[] {
  assert.match(sql, /FROM events\b/);
  assert.equal((sql.match(/\?/g) ?? []).length, params.length, 'every placeholder must be bound');
  // Honor predicates only when the actual query contains them. An unscoped
  // query therefore really returns foreign rows, rather than a canned result.
  const bound = (pattern: RegExp): unknown => {
    const match = pattern.exec(sql);
    if (!match) return undefined;
    const index = (sql.slice(0, match.index).match(/\?/g) ?? []).length;
    return params[index];
  };
  const guild = bound(/guild_id\s*=\s*\?/);
  const since = bound(/(?:occurred_at|recorded_at)\s*>=\s*\?/);
  const timestamp = /recorded_at\s*>=\s*\?/.test(sql) ? 'recorded_at' : 'occurred_at';
  const type = /event_type\s*=\s*'([^']+)'/.exec(sql)?.[1];
  const rows = events.filter((row) =>
    (guild === undefined || row.guild_id === guild) &&
    (type === undefined || row.event_type === type) &&
    (!/member_id IS NOT NULL/.test(sql) || row.member_id !== null) &&
    (since === undefined || row[timestamp] >= String(since)),
  );
  if (/COUNT\(\*\)/.test(sql)) return [{ n: rows.length }];
  if (/ORDER BY/.test(sql)) rows.sort((a, b) => a[timestamp].localeCompare(b[timestamp]));
  if (/recorded_at AS at/.test(sql)) return rows.map((row) => ({ at: row.recorded_at }));
  return rows;
}

export async function openDb(spec: string): Promise<Db> {
  assert.equal(spec, 'fixture://voice-report', 'never use a real database');
  console.error('fixture: openDb');
  const db: Db = {
    prepare(sql): Statement {
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          return select(sql, params) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          return select(sql, params)[0] as T | undefined;
        },
        async run() { throw new Error('voice report must not write'); },
      };
    },
    async exec() { throw new Error('voice report must not write'); },
    async transaction() { throw new Error('voice report must not write'); },
    async close() { console.error('fixture: close'); },
  };
  return db;
}

// Node 24 synchronous hooks run before the CLI entry point via --import.
// https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions
const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url === dbUrl) {
      return {
        format: 'module',
        source: `export { openDb } from ${JSON.stringify(import.meta.url)};`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
