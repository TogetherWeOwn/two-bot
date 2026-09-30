// Preloaded only in the capture CLI's hermetic child process.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock } from 'node:test';
import { EventStore } from '../../src/store/eventStore.ts';
import type { InviteState } from '../../src/core/inviteTracker.ts';
import { DiscordRest, type RawMember } from '../../src/discord/rest.ts';
import type { FunnelEvent } from '../../src/core/events.ts';

export interface CaptureSnapshot extends InviteState {
  updated_at: string;
}

export interface PendingCaptureJoin {
  id: string;
  joinedAt: string;
}

export interface RetainedCaptureGrowth extends InviteState {
  observed_at: string;
}

export interface CaptureFixture {
  since: string | null;
  capturedAt: string;
  rosterReadAt: string;
  members: RawMember[];
  uses: number;
  invites?: InviteState[];
  previousRows?: CaptureSnapshot[];
  previousEvents?: FunnelEvent[];
  previousPending?: PendingCaptureJoin[];
  previousRetained?: RetainedCaptureGrowth[];
}

export interface CaptureResult {
  calls: string[];
  events: FunnelEvent[];
  storedEvents: FunnelEvent[];
  bots: string[];
  snapshots: InviteState[];
  rows: CaptureSnapshot[];
  windowEnds: string[];
  pending: PendingCaptureJoin[];
  pendingWrites: number;
  retained: RetainedCaptureGrowth[];
}

const fixture: CaptureFixture = JSON.parse(process.env.CAPTURE_TEST_FIXTURE!);
const calls: string[] = [];
const events: FunnelEvent[] = [];
const storedEvents = [...(fixture.previousEvents ?? [])];
const bots: string[] = [];
const snapshots: InviteState[] = [];
const windowEnds: string[] = [];
let pending = [...(fixture.previousPending ?? [])];
let pendingWrites = 0;
// Retained invite reads carried across fixture runs, like the real
// capture_retained_growth rows: already-observed growth that a retry must
// reconcile rather than recompute from the (preserved) baseline.
let retained: RetainedCaptureGrowth[] = [...(fixture.previousRetained ?? [])];
let rows: CaptureSnapshot[] = fixture.previousRows ?? (fixture.since === null ? [] : [{
  code: 'fixture', uses: 5, inviterId: null, channelId: null, updated_at: fixture.since,
}]);
mock.timers.enable({ apis: ['Date'], now: new Date(fixture.capturedAt) });

// Any missed stub fails immediately instead of contacting Discord or a DB.
globalThis.fetch = async () => { throw new Error('capture fixture attempted network access'); };
mock.method(DiscordRest.prototype, 'get', async function (path: string) {
  calls.push(path);
  if (path === '/guilds/fixture-guild/invites') {
    return fixture.invites ?? [{ code: 'fixture', uses: fixture.uses }];
  }
  if (path === '/guilds/fixture-guild/members?limit=1000&after=0') {
    mock.timers.setTime(Date.parse(fixture.rosterReadAt));
    return fixture.members;
  }
  if (path === '/guilds/fixture-guild') return { vanity_url_code: null };
  throw new Error(`Unexpected REST path: ${path}`);
});
mock.method(EventStore.prototype, 'record', async (event: FunnelEvent) => {
  const index = storedEvents.findIndex((previous) =>
    previous.guildId === event.guildId && previous.memberId === event.memberId &&
    previous.eventType === event.eventType && previous.occurredAt === event.occurredAt);
  if (index !== -1) return { inserted: false, eventId: index + 1 };
  storedEvents.push(event);
  events.push(event);
  return { inserted: true, eventId: storedEvents.length };
});
mock.method(EventStore.prototype, 'markBot', async (guildId: string, id: string) => {
  assert.equal(guildId, 'fixture-guild');
  bots.push(id);
});

// Use the real InviteTracker: carry its SQL-written rows into the next fixture.
export async function openCaptureTestDb() {
  return {
    prepare(sql: string) {
      if (sql === 'SELECT code, uses, inviter_id AS "inviterId", channel_id AS "channelId", observed_at AS "observedAt" FROM capture_retained_growth WHERE guild_id = ?') {
        return {
          async all(guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            return retained.map((r) => ({ ...r }));
          },
        };
      }
      if (sql.startsWith('INSERT INTO capture_retained_growth')) {
        return {
          async run(guildId: string, code: string, uses: number, inviterId: string | null,
                    channelId: string | null, observedAt: string) {
            assert.equal(guildId, 'fixture-guild');
            retained = retained.filter((r) => r.code !== code);
            retained.push({ code, uses, inviterId, channelId, observed_at: observedAt });
          },
        };
      }
      if (sql === 'DELETE FROM capture_retained_growth WHERE guild_id = ?') {
        return {
          async run(guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            retained = [];
          },
        };
      }
      if (sql === 'SELECT member_id AS id, joined_at AS "joinedAt" FROM capture_pending_joins WHERE guild_id = ?') {
        return {
          async all(guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            return pending.map((j) => ({ ...j }));
          },
        };
      }
      if (sql.startsWith('INSERT INTO capture_pending_joins')) {
        return {
          async run(guildId: string, id: string, joinedAt: string) {
            assert.equal(guildId, 'fixture-guild');
            pendingWrites++;
            if (!pending.some((j) => j.id === id && j.joinedAt === joinedAt)) pending.push({ id, joinedAt });
          },
        };
      }
      if (sql === 'DELETE FROM capture_pending_joins WHERE guild_id = ? AND joined_at <= ?') {
        return {
          async run(guildId: string, at: string) {
            assert.equal(guildId, 'fixture-guild');
            pendingWrites++;
            pending = pending.filter((j) => j.joinedAt > at);
          },
        };
      }
      if (sql.startsWith('DELETE FROM capture_pending_joins WHERE guild_id = ? AND (')) {
        return {
          async run(guildId: string, ...keys: string[]) {
            assert.equal(guildId, 'fixture-guild');
            pendingWrites++;
            const handled = new Set<string>();
            for (let i = 0; i + 1 < keys.length; i += 2) handled.add(JSON.stringify([keys[i], keys[i + 1]]));
            pending = pending.filter((j) => !handled.has(JSON.stringify([j.id, j.joinedAt])));
          },
        };
      }
      if (sql === 'SELECT code, uses, updated_at FROM invite_snapshots WHERE guild_id = ?' ||
          sql === 'SELECT code, uses FROM invite_snapshots WHERE guild_id = ?') {
        return {
          async all(guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            return rows.map((row) => ({ ...row }));
          },
        };
      }
      if (sql.startsWith('INSERT INTO invite_snapshots')) {
        return {
          async run(guildId: string, code: string, uses: number, inviterId: string | null,
                    channelId: string | null, updated_at: string) {
            assert.equal(guildId, 'fixture-guild');
            const snapshot = { code, uses, inviterId, channelId };
            snapshots.push(snapshot);
            rows = rows.filter((row) => row.code !== code);
            rows.push({ ...snapshot, updated_at });
          },
        };
      }
      if (sql === 'DELETE FROM invite_snapshots WHERE guild_id = ? AND code = ?') {
        return {
          async run(guildId: string, code: string) {
            assert.equal(guildId, 'fixture-guild');
            rows = rows.filter((row) => row.code !== code);
          },
        };
      }
      if (sql === 'UPDATE invite_snapshots SET updated_at = ? WHERE guild_id = ?') {
        return {
          async run(at: string, guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            windowEnds.push(at);
            for (const row of rows) row.updated_at = at;
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async close() {
      console.log(`CAPTURE_FIXTURE_RESULT ${JSON.stringify({
        calls, events, storedEvents, bots, snapshots, rows, windowEnds, pending, pendingWrites, retained,
      })}`);
    },
  };
}

const dbUrl = new URL('../../src/store/db.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== dbUrl) return nextLoad(url, context);
    return {
      format: 'module',
      source: `export { openCaptureTestDb as openDb } from ${JSON.stringify(import.meta.url)};`,
      shortCircuit: true,
    };
  },
});
