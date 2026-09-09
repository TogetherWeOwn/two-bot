#!/usr/bin/env node
/**
 * Render or post one configured self-role panel.
 *
 * Dry-run by default. `--apply` posts a new Discord message and prints the exact
 * config entry to persist. It refuses the live guild and accepts only the Owen
 * QA Test staging token.
 */
import { checkStagingToken, LIVE_GUILD_ID, STAGING_BOT_APPLICATION_NAME, stagingGuildId } from '../src/staging/spec.ts';
import { loadSelfRolePanels } from '../src/selfRoles/config.ts';
import { buildSelfRoleComponents } from '../src/discord/selfRoles.ts';
import { reactionEndpointEmoji } from '../src/selfRoles/plan.ts';

const apply = process.argv.includes('--apply');
const idAt = process.argv.indexOf('--panel');
const panelId = idAt >= 0 ? process.argv[idAt + 1] : null;
if (!panelId) {
  console.error('usage: node scripts/self-role-panel.ts --panel <id> [--apply]');
  process.exit(2);
}
const panels = loadSelfRolePanels();
const panel = panels.find((candidate) => candidate.id === panelId);
if (!panel) {
  console.error(`panel "${panelId}" is not in TWO_SELF_ROLE_PANELS`);
  process.exit(2);
}
let guildId: string;
try {
  guildId = stagingGuildId();
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
if (guildId === LIVE_GUILD_ID) {
  console.error(`refusing the live guild ${LIVE_GUILD_ID}`);
  process.exit(2);
}
const token = process.env.DISCORD_STAGING_BOT_TOKEN ?? '';
const tokenCheck = checkStagingToken(token);
if (!token || !tokenCheck.ok) {
  console.error(token ? tokenCheck.message : `missing ${STAGING_BOT_APPLICATION_NAME} token`);
  process.exit(2);
}

const body = {
  content: panel.color ? 'Choose one color.' : panel.exclusive ? 'Choose one role.' : 'Choose any roles.',
  components: buildSelfRoleComponents(panel).map((row) => row.toJSON()),
};
console.log(`\nself-role panel ${panel.id}\n  guild   ${guildId}\n  channel ${panel.channelId}\n  mode    ${panel.mode}\n`);
if (!apply) {
  console.log(JSON.stringify(body, null, 2));
  console.log('\nDry run. Nothing was posted. Re-run with --apply.\n');
  process.exit(0);
}
const res = await fetch(`https://discord.com/api/v10/channels/${panel.channelId}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const result = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
if (res.status !== 200 || !result?.id) {
  console.error(`Discord rejected the panel: HTTP ${res.status} ${result?.message ?? ''}`);
  process.exit(1);
}
console.log(`posted message ${result.id}`);
if (panel.mode === 'reaction') {
  for (const option of panel.options) {
    const encoded = encodeURIComponent(reactionEndpointEmoji(option.emoji!));
    const reaction = await fetch(
      `https://discord.com/api/v10/channels/${panel.channelId}/messages/${result.id}/reactions/${encoded}/@me`,
      { method: 'PUT', headers: { Authorization: `Bot ${token}` } },
    );
    if (reaction.status !== 204) {
      console.error(`Discord rejected reaction ${option.emoji}: HTTP ${reaction.status}`);
      process.exit(1);
    }
  }
  console.log(`added ${panel.options.length} configured reaction(s)`);
}
console.log('\nReplace this panel\'s messageId in TWO_SELF_ROLE_PANELS with the id above, then restart the bot.\n');
