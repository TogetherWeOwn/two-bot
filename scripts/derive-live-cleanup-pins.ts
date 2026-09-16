/**
 * Re-derive test/fixtures/live-cleanup-expected-operations.json from the
 * production-shaped state fixture.
 *
 * The expected-operations fixture is the pin the operator compares a live dry-run
 * against, so it must never be hand-edited. Run this after any change to the
 * planner and commit the result; `test/e2e.livecleanup.test.ts` then re-proves the
 * pin by running the real dry-run script against the stub guild and asserting
 * equality, which is also what catches any drift between the snapshot shape built
 * here and the one `captureSnapshot` builds from Discord.
 *
 *   node scripts/derive-live-cleanup-pins.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Channel,
  type JsonObject,
  type LiveCleanupSnapshot,
  normalizeOverwrites,
  operationSemanticHash,
  planArchiveOperations,
  type Role,
  withSemanticHash,
} from '../src/redesign/live-cleanup.ts';
import { LIVE_BOT_APPLICATION_ID } from '../src/staging/spec.ts';

type FixtureMember = { user: { id: string; username: string; bot: boolean }; roles: string[]; premium_since: string | null; pending: boolean };
type FixtureState = {
  guild: JsonObject;
  roles: Role[];
  channels: Channel[];
  integrations: JsonObject[];
  application: JsonObject;
  members: FixtureMember[];
};

const statePath = fileURLToPath(new URL('../test/fixtures/live-cleanup-production-state.json', import.meta.url));
const pinPath = fileURLToPath(new URL('../test/fixtures/live-cleanup-expected-operations.json', import.meta.url));
const state = JSON.parse(readFileSync(statePath, 'utf8')) as FixtureState;

// Mirrors captureSnapshot() in scripts/live-clean-slate-cleanup.ts. Only the fields
// planArchiveOperations reads have to be faithful; the stub-driven e2e test proves it.
const snapshot: LiveCleanupSnapshot = withSemanticHash({
  version: 1,
  generatedAt: '1970-01-01T00:00:00.000Z',
  applicationId: LIVE_BOT_APPLICATION_ID,
  guildId: String(state.guild.id),
  guild: state.guild,
  roles: state.roles,
  channels: state.channels.map((channel) => ({ ...channel, permission_overwrites: normalizeOverwrites(channel.permission_overwrites ?? []) })),
  members: state.members.map((member) => ({
    id: member.user.id,
    bot: Boolean(member.user.bot),
    username: member.user.username ?? null,
    roles: [...member.roles].sort(),
    premiumSince: member.premium_since ?? null,
    pending: Boolean(member.pending),
  })).sort((a, b) => a.id.localeCompare(b.id)),
  integrations: [],
  // A readable Server Guide that pins nothing — the shape `captureSnapshot` records for a
  // real 200 (`{status, body}`), with `enabled: false`. `planArchiveOperations` refuses an
  // unreadable one outright, so `references: {}` made this script throw and the operator's
  // pin unregenerable (TOG-3059/TOG-3060). Declaring it readable-and-empty keeps the pin
  // a pure function of the channel/category fixture: 69 operations, hash unchanged.
  references: { onboarding: { status: 200, body: { enabled: false, default_channel_ids: [], prompts: [] } } },
});

const operations = planArchiveOperations(snapshot);
const pin = {
  operationCount: operations.length,
  operationSemanticHash: operationSemanticHash(operations),
  operations: operations.map(({ sequence, id, objectType, objectId }) => ({ sequence, id, objectType, objectId })),
};
writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
console.log(`operationCount: ${pin.operationCount}`);
console.log(`channel operations: ${operations.filter((operation) => operation.objectType === 'channel').length}`);
console.log(`category operations: ${operations.filter((operation) => operation.objectType === 'category').length}`);
console.log(`operationSemanticHash: ${pin.operationSemanticHash}`);
