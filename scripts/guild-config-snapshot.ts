import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GuildConfigDiscordApi } from '../src/discord/guildConfigApi.ts';
import { canonicalSnapshot, configHash, driftAgainstAcceptedSpec } from '../src/redesign/guildConfig.ts';
import { checkStagingToken, stagingGuildId, STAGING_BOT_APPLICATION_ID } from '../src/staging/spec.ts';
import { buildUploadArgv } from '../src/store/uploadCmd.ts';
import { readSecret } from '../src/core/credentials.ts';

function die(message: string): never {
  console.error(`guild-config-snapshot: ${message}`);
  process.exit(1);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

const token = readSecret('discord_staging_token', ['DISCORD_STAGING_BOT_TOKEN']);
if (!token) die('missing DISCORD_STAGING_BOT_TOKEN');
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) die(tokenCheck.message);

let guildId: string;
try {
  guildId = stagingGuildId();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}

const api = new GuildConfigDiscordApi({
  apiBase: process.env.GUILD_CONFIG_API_BASE,
  cdnBase: process.env.GUILD_CONFIG_CDN_BASE,
  token,
  applicationId: STAGING_BOT_APPLICATION_ID,
  guildId,
});
await api.assertIdentity();
const snapshot = await api.capture();
const report = driftAgainstAcceptedSpec(snapshot);
const stamp = snapshot.generatedAt.replace(/[:.]/g, '-');
const outputDir = resolve(process.env.TWO_GUILD_CONFIG_BACKUP_DIR ?? '/var/backups/two-bot/guild-config');
const snapshotPath = join(outputDir, `two-staging-guild-config-${stamp}.json`);
const driftPath = join(outputDir, `two-staging-guild-config-${stamp}.drift.json`);
atomicJson(snapshotPath, snapshot);
atomicJson(driftPath, report);

const onDisk = JSON.parse(readFileSync(snapshotPath, 'utf8'));
if (configHash(canonicalSnapshot(onDisk)) !== report.snapshotHash) die(`snapshot hash changed after write: ${snapshotPath}`);
console.log(`guild-config-snapshot: stored ${snapshotPath}`);
console.log(`guild-config-snapshot: hash=${report.snapshotHash} roles=${report.counts.roles} channels=${report.counts.channels} overwrites=${report.counts.overwrites} emojis=${report.counts.emojis}`);
console.log(`guild-config-snapshot: drift=${report.counts.drift} report=${driftPath}`);

const upload = buildUploadArgv(process.env.TWO_GUILD_CONFIG_UPLOAD_CMD ?? process.env.TWO_BACKUP_UPLOAD_CMD, snapshotPath);
if (!upload) die('TWO_GUILD_CONFIG_UPLOAD_CMD (or TWO_BACKUP_UPLOAD_CMD) is required; refusing a local-only snapshot');
const uploaded = spawnSync(upload.cmd, upload.args, { stdio: 'inherit', env: process.env });
if (uploaded.error) die(`upload failed to start: ${uploaded.error.message}`);
if (uploaded.status !== 0) die(`upload failed with exit ${uploaded.status ?? 'signal'}`);

const driftUpload = buildUploadArgv(process.env.TWO_GUILD_CONFIG_UPLOAD_CMD ?? process.env.TWO_BACKUP_UPLOAD_CMD, driftPath)!;
const uploadedDrift = spawnSync(driftUpload.cmd, driftUpload.args, { stdio: 'inherit', env: process.env });
if (uploadedDrift.error) die(`drift report upload failed to start: ${uploadedDrift.error.message}`);
if (uploadedDrift.status !== 0) die(`drift report upload failed with exit ${uploadedDrift.status ?? 'signal'}`);
console.log('guild-config-snapshot: snapshot and drift report uploaded');
