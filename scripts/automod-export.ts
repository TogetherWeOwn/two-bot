import { writeFile } from 'node:fs/promises';
import { checkStagingToken, stagingGuildId } from '../src/staging/spec.ts';
import { AutomodExportError, validateAutomodRules } from '../src/automod/rulesExport.ts';

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) throw new Error('DISCORD_STAGING_BOT_TOKEN is required.');
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) throw new Error(tokenCheck.message);
const guildId = stagingGuildId();
const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/auto-moderation/rules`, {
  headers: { Authorization: `Bot ${token}` },
});
if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} for the staging AutoMod export.`);
const payload = await res.json() as unknown;
// TOG-5700: refuse a payload with unidentifiable rules before writing
// anything. A partial file that looks complete is worse than no file.
let rules;
try {
  rules = validateAutomodRules(payload);
} catch (err) {
  if (!(err instanceof AutomodExportError)) throw err;
  console.error(`Refusing a partial AutoMod export - nothing was written:\n  ${err.problems.join('\n  ')}`);
  process.exit(1);
}
const output = process.argv[2] ?? 'audit/staging-automod-rules.json';
await writeFile(output, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${rules.length} staging AutoMod rule(s) to ${output}`);
