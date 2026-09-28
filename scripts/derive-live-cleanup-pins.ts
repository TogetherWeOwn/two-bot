/**
 * Re-derive test/fixtures/live-cleanup-expected-operations.json from the
 * production-shaped state fixture.
 *
 * The expected-operations fixture pins the planner's *determinism*: the same snapshot
 * must always produce the same operations, so it must never be hand-edited. Run this
 * after any change to the planner and commit the result; `test/e2e.livecleanup.test.ts`
 * then re-proves the pin by running the real dry-run script against the stub guild and
 * asserting equality, which is also what catches any drift between the snapshot shape
 * built here and the one `captureSnapshot` builds from Discord.
 *
 *   node scripts/derive-live-cleanup-pins.ts
 *
 * **It is not a number the operator should expect a live dry-run to reproduce, and an
 * earlier version of this comment said it was.** The operation count is a function of
 * how far the live guild has drifted from its parent categories at capture time — every
 * legacy child that is *unsynchronized* earns its own PATCH, and a child that someone
 * has since re-synchronized is covered by its category instead. Measured on 2026-09-17:
 * this fixture (captured 2026-09-16T10:27Z) derives 65 = 47 channel + 18 category, while
 * the same planner against the live guild at 23:46Z derives 59 = 41 + 18 — six legacy
 * children synchronized in the interval, none gained. Both are correct plans.
 *
 * So an operator must never gate apply on matching 65, or a correct run reads as
 * tampering. The live checks that do hold regardless of drift are the ones the dry-run
 * prints: `N of N` reviewed legacy channels hidden, and `AUDIT PASSED` from
 * `scripts/audit-live-cleanup-visibility.ts`. Apply re-derives the plan from a fresh
 * snapshot and compares it against *that run's own* manifest, not against this file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Channel,
  type JsonObject,
  type LiveCleanupSnapshot,
  normalizedChannel,
  operationSemanticHash,
  planArchiveOperations,
  type Role,
  withSemanticHash,
} from '../src/redesign/live-cleanup.ts';
import { LIVE_BOT_APPLICATION_ID } from '../src/staging/spec.ts';

// --help prints usage without reading the fixture or rewriting the pin.
if (process.argv.includes('--help')) {
  console.log('usage: node scripts/derive-live-cleanup-pins.ts');
  console.log('');
  console.log('Re-derive test/fixtures/live-cleanup-expected-operations.json from the production-shaped state fixture.');
  console.log('Run after any planner change and commit the result; --help reads and writes nothing.');
  process.exit(0);
}

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
  channels: state.channels.map(normalizedChannel),
  members: state.members.map((member) => ({
    id: member.user.id,
    bot: Boolean(member.user.bot),
    username: member.user.username ?? null,
    roles: [...member.roles].sort(),
    premiumSince: member.premium_since ?? null,
    pending: Boolean(member.pending),
  })).sort((a, b) => a.id.localeCompare(b.id)),
  integrations: [],
  // A readable Server Guide that pins nothing, and a readable guild reference block that
  // pins nothing, both in the shapes `captureSnapshot` records. `planArchiveOperations`
  // refuses an unreadable one of either, so `references: {}` made this throw and the
  // operator's pin unregenerable (TOG-3059/TOG-3060); omitting `guildReferences` alone
  // would do it again. Declaring both readable-and-empty keeps the output a pure function
  // of the channel/category fixture.
  references: {
    onboarding: { status: 200, body: { enabled: false, default_channel_ids: [], prompts: [] } },
    guildReferences: { applicationId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null, safetyAlertsChannelId: null },
  },
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
