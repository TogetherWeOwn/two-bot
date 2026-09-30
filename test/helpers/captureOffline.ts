// Preloaded only in the capture CLI's hermetic child process.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock } from 'node:test';
import { EventStore } from '../../src/store/eventStore.ts';
import { InviteTracker, type InviteState } from '../../src/core/inviteTracker.ts';
import { DiscordRest, type RawMember } from '../../src/discord/rest.ts';
import type { FunnelEvent } from '../../src/core/events.ts';

export interface CaptureFixture {
  since: string | null;
  capturedAt: string;
  rosterReadAt: string;
  members: RawMember[];
  uses: number;
}

const fixture: CaptureFixture = JSON.parse(process.env.CAPTURE_TEST_FIXTURE!);
const calls: string[] = [];
const events: FunnelEvent[] = [];
const bots: string[] = [];
const snapshots: InviteState[][] = [];
const windowEnds: string[] = [];
mock.timers.enable({ apis: ['Date'], now: new Date(fixture.capturedAt) });

// Any missed stub fails immediately instead of contacting Discord or a DB.
globalThis.fetch = async () => { throw new Error('capture fixture attempted network access'); };
mock.method(DiscordRest.prototype, 'get', async function (path: string) {
  calls.push(path);
  if (path === '/guilds/fixture-guild/invites') return [{ code: 'fixture', uses: fixture.uses }];
  if (path === '/guilds/fixture-guild/members?limit=1000&after=0') {
    mock.timers.setTime(Date.parse(fixture.rosterReadAt));
    return fixture.members;
  }
  if (path === '/guilds/fixture-guild') return { vanity_url_code: null };
  throw new Error(`Unexpected REST path: ${path}`);
});
mock.method(EventStore.prototype, 'record', async (event: FunnelEvent) => {
  events.push(event);
  return { inserted: true, eventId: events.length };
});
mock.method(EventStore.prototype, 'markBot', async (guildId: string, id: string) => {
  assert.equal(guildId, 'fixture-guild');
  bots.push(id);
});
mock.method(InviteTracker.prototype, 'diffAndStore', async (guildId: string, current: InviteState[]) => {
  assert.equal(guildId, 'fixture-guild');
  snapshots.push(current);
  return [];
});

export async function openCaptureTestDb() {
  return {
    prepare(sql: string) {
      if (sql === 'SELECT code, uses, updated_at FROM invite_snapshots WHERE guild_id = ?') {
        return {
          async all(guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            return fixture.since === null ? [] : [{ code: 'fixture', uses: 5, updated_at: fixture.since }];
          },
        };
      }
      if (sql === 'UPDATE invite_snapshots SET updated_at = ? WHERE guild_id = ?') {
        return {
          async run(at: string, guildId: string) {
            assert.equal(guildId, 'fixture-guild');
            windowEnds.push(at);
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async close() {
      console.log(`CAPTURE_FIXTURE_RESULT ${JSON.stringify({ calls, events, bots, snapshots, windowEnds })}`);
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
