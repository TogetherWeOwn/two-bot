import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';
import {
  canonicalSnapshot,
  configHash,
  snapshotCounts,
  type GuildConfigSnapshot,
} from '../src/redesign/guildConfig.ts';
import { applyRestorePlan, planRestore } from '../src/redesign/guildConfigRestore.ts';
import { readSecret } from '../src/core/credentials.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  checkStagingToken,
  stagingGuildId,
} from '../src/staging/spec.ts';

function die(message: string, code = 1): never {
  console.error(`guild-config-restore: ${message}`);
  process.exit(code);
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const apply = process.argv.includes('--apply');
const confirmed = process.argv.includes('--confirm-staging-guild');
const snapshotArgument = argument('--snapshot');
const evidenceArgument = argument('--evidence');
if (!snapshotArgument) die('usage: node scripts/guild-config-restore.ts --snapshot FILE [--confirm-staging-guild --apply] [--evidence FILE]', 2);
if (apply && !confirmed) die('refusing to write without --confirm-staging-guild', 2);

const token = readSecret('discord_staging_token', ['DISCORD_STAGING_BOT_TOKEN']);
if (!token) die('missing DISCORD_STAGING_BOT_TOKEN', 2);
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) die(tokenCheck.message, 2);
const guildId = stagingGuildId();
if (guildId === LIVE_GUILD_ID) die(`refusing the live guild ${LIVE_GUILD_ID}`, 2);

let snapshot: GuildConfigSnapshot;
const snapshotPath = resolve(snapshotArgument);
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as GuildConfigSnapshot;
} catch (error) {
  die(`cannot read snapshot ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`, 2);
}
if (snapshot.version !== 1) die(`unsupported snapshot version ${String(snapshot.version)}`, 2);
if (snapshot.guildId !== guildId) die(`snapshot guild ${snapshot.guildId} does not match staging guild ${guildId}`, 2);
if (snapshot.applicationId !== STAGING_BOT_APPLICATION_ID) {
  die(`snapshot application ${snapshot.applicationId} is not Owen QA Test ${STAGING_BOT_APPLICATION_ID}`, 2);
}

const api = new GuildConfigDiscordApi({
  apiBase: process.env.GUILD_CONFIG_API_BASE,
  token,
  applicationId: STAGING_BOT_APPLICATION_ID,
  guildId,
});
await api.assertIdentity();
const before = await api.capture();
const plan = planRestore(snapshot, before);
if (apply && plan.counts.operations > 0) await api.assertRestorePermissions(before, plan.counts);
console.log(`guild-config-restore: ${apply ? 'applying' : 'planned'} ${plan.counts.operations} operation(s)`);
for (const operation of plan.operations) console.log(`${apply ? 'DID' : 'WOULD'} ${operation.label}`);

if (!apply) {
  console.log(`guild-config-restore: counts=${JSON.stringify(plan.counts)}; add --confirm-staging-guild --apply to write`);
  process.exit(0);
}

await applyRestorePlan(api, plan);
const after = await api.capture();
const remaining = planRestore(snapshot, after);
const beforeCounts = snapshotCounts(before);
const targetCounts = snapshotCounts(snapshot);
const afterCounts = snapshotCounts(after);
const evidence = {
  version: 1,
  generatedAt: new Date().toISOString(),
  guildId,
  source: snapshotPath,
  sourceHash: configHash(canonicalSnapshot(snapshot)),
  beforeHash: configHash(canonicalSnapshot(before)),
  afterHash: configHash(canonicalSnapshot(after)),
  counts: { before: beforeCounts, source: targetCounts, after: afterCounts },
  applied: plan.counts,
  remaining: remaining.counts,
  remainingOperations: remaining.operations,
};
if (evidenceArgument) writeFileSync(resolve(evidenceArgument), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(`guild-config-restore: before=${evidence.beforeHash} after=${evidence.afterHash} source=${evidence.sourceHash}`);
console.log(`guild-config-restore: counts=${JSON.stringify(evidence.counts)} applied=${JSON.stringify(plan.counts)} remaining=${remaining.counts.operations}`);
if (remaining.counts.operations > 0) die(`restore is incomplete; ${remaining.counts.operations} operation(s) remain`);
console.log(`guild-config-restore: complete with ${api.writes} Discord write(s)`);
