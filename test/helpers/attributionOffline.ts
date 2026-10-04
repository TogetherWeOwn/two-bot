import { registerHooks } from 'node:module';

export interface AttributionFixture {
  now: string;
  events: {
    guild_id: string;
    event_type: string;
    member_id: string | null;
    occurred_at: string;
    source: string;
    metadata: string | null;
  }[];
  members: {
    guild_id: string;
    member_id: string;
    first_message_at: string | null;
    third_message_at: string | null;
    first_voice_at: string | null;
    last_active_at: string | null;
    left_at: string | null;
    is_bot: number;
  }[];
}

const fixture: AttributionFixture = JSON.parse(process.env.ATTRIBUTION_TEST_FIXTURE!);
Date.now = () => Date.parse(fixture.now);

// Exercise the CLI's own query selection and guild binding without a database.
export async function openAttributionTestDb(url: string) {
  if (url !== 'fixture-not-a-database') throw new Error('Unexpected database URL');
  return {
    prepare(sql: string) {
      const query = sql.replace(/\s+/g, ' ').trim();
      const scoped = /guild_id\s*=\s*\?/.test(query);
      const events = (guild: unknown) => fixture.events.filter((e) => !scoped || e.guild_id === guild);
      const members = (guild: unknown) => fixture.members.filter((m) => !scoped || m.guild_id === guild);
      return {
        async all(guild: unknown, since: unknown) {
          if (query.startsWith('SELECT member_id, occurred_at, source, metadata FROM events')) {
            return events(guild).filter((e) => e.event_type === 'member_join' && e.member_id !== null && e.occurred_at >= String(since));
          }
          if (query.startsWith('SELECT member_id, first_message_at')) return members(guild);
          if (query.startsWith('SELECT source, COUNT(*) AS n FROM events')) {
            const counts = new Map<string, number>();
            for (const e of events(guild).filter((e) => e.event_type === 'invite_click' && e.occurred_at >= String(since))) {
              counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
            }
            return [...counts].map(([source, n]) => ({ source, n }));
          }
          if (query === 'SELECT code, uses, channel_id, updated_at FROM invite_snapshots ORDER BY code') return [];
          throw new Error(`Unexpected all query: ${query}`);
        },
        async get(guild: unknown) {
          if (query.startsWith('SELECT MAX(occurred_at) AS t FROM events')) {
            const types = [...query.matchAll(/'([^']+)'/g)].map((m) => m[1]);
            const dates = events(guild).filter((e) => types.includes(e.event_type)).map((e) => e.occurred_at).sort();
            return { t: dates.at(-1) ?? null };
          }
          if (query.startsWith('SELECT MAX(last_active_at) AS t FROM members')) {
            const dates = members(guild).map((m) => m.last_active_at).filter((d) => d !== null).sort();
            return { t: dates.at(-1) ?? null };
          }
          if (query === 'SELECT COUNT(*) AS n FROM invite_campaigns') return { n: 0 };
          if (query.startsWith('SELECT COUNT(*) AS n FROM members')) {
            return { n: members(guild).filter((m) => !m.is_bot && m.left_at === null).length };
          }
          throw new Error(`Unexpected get query: ${query}`);
        },
      };
    },
    async close() {},
  };
}

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== dbUrl) return nextLoad(url, context);
    return {
      format: 'module',
      source: `export { openAttributionTestDb as openDb } from ${JSON.stringify(import.meta.url)};`,
      shortCircuit: true,
    };
  },
});
