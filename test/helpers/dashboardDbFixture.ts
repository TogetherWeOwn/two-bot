/** Read-only dashboard fake: only predicates in the SQL select fixture rows. */
import assert from 'node:assert/strict';
import type { MemberRow } from '../../src/analytics/dashboard.ts';
import type { Db, Statement } from '../../src/store/driver.ts';

export interface DashboardFixture {
  members: Array<MemberRow & { guild_id: string; is_bot: boolean }>;
  events: Array<{
    id: number;
    guild_id: string;
    event_type: string;
    member_id: string | null;
    occurred_at: string;
    recorded_at: string;
    source: string;
    metadata: string | null;
  }>;
}

export interface DashboardRead {
  sql: string;
  params: unknown[];
}

export function dashboardDb(fixture: DashboardFixture, reads: DashboardRead[] = []): Db {
  const select = (sql: string, params: unknown[]): unknown[] => {
    reads.push({ sql, params });
    assert.equal((sql.match(/\?/g) ?? []).length, params.length, 'bind every placeholder');
    const bound = (pattern: RegExp): unknown => {
      const match = pattern.exec(sql);
      if (!match) return undefined;
      return params[(sql.slice(0, match.index).match(/\?/g) ?? []).length];
    };
    const guild = bound(/\bguild_id\s*=\s*\?/);
    if (/FROM members\b/.test(sql)) {
      return fixture.members.filter((row) =>
        (guild === undefined || row.guild_id === guild) &&
        (!/NOT is_bot/.test(sql) || !row.is_bot),
      );
    }
    assert.match(sql, /FROM events\b/, 'only known dashboard reads are allowed');
    const type = /event_type\s*=\s*'([^']+)'/.exec(sql)?.[1];
    const since = bound(/occurred_at\s*>=\s*\?/);
    const until = bound(/occurred_at\s*<\s*\?/);
    const rows = fixture.events.filter((row) =>
      (guild === undefined || row.guild_id === guild) &&
      (type === undefined || row.event_type === type) &&
      (!/source LIKE 'channel:%'/.test(sql) || row.source.startsWith('channel:')) &&
      (since === undefined || row.occurred_at >= String(since)) &&
      (until === undefined || row.occurred_at < String(until)),
    );
    if (/ORDER BY id DESC/.test(sql)) rows.sort((a, b) => b.id - a.id);
    return /LIMIT 1/.test(sql) ? rows.slice(0, 1) : rows;
  };
  return {
    prepare(sql): Statement {
      return {
        async all<T>(...params: unknown[]): Promise<T[]> { return select(sql, params) as T[]; },
        async get<T>(...params: unknown[]): Promise<T | undefined> {
          return select(sql, params)[0] as T | undefined;
        },
        async run() { throw new Error('dashboard must not write'); },
      };
    },
    async exec() { throw new Error('dashboard must not write'); },
    async transaction() { throw new Error('dashboard must not write'); },
    async close() {},
  };
}

export function assertDashboardGuildReads(reads: DashboardRead[], guild: string): void {
  assert.ok(reads.length >= 6, 'member, join, leave, voice, channel and gate reads must run');
  for (const { sql, params } of reads) {
    const match = /\bWHERE\b[^;]*\bguild_id\s*=\s*\?/s.exec(sql);
    assert.ok(match, `missing bound guild predicate: ${sql}`);
    const guildPosition = sql.indexOf('guild_id', match.index);
    const index = (sql.slice(0, guildPosition).match(/\?/g) ?? []).length;
    assert.equal(params[index], guild, `wrong guild binding: ${sql}`);
  }
}
