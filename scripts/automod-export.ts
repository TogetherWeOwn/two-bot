import { writeFile } from 'node:fs/promises';
import { checkStagingToken, stagingGuildId } from '../src/staging/spec.ts';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) throw new Error('DISCORD_STAGING_BOT_TOKEN is required.');
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) throw new Error(tokenCheck.message);
const guildId = stagingGuildId();
const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
  headers: { Authorization: `Bot ${token}` },
});
if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} for the staging AutoMod export.`);
const rules = await res.json() as unknown[];
const output = process.argv[2] ?? 'audit/staging-automod-rules.json';
await writeFile(output, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${rules.length} staging AutoMod rule(s) to ${output}`);
