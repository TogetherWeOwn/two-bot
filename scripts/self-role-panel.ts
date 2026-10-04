#!/usr/bin/env node
/**
 * Render or post one configured self-role panel.
 *
 * Dry-run by default. `--apply` posts a new Discord message and prints the exact
 * config entry to persist. It refuses the live guild and accepts only the Owen
 * QA Test staging token.
 *
 * The dry-run also proves the panel's grant+revoke path against a disposable
 * fixture member: it runs the configured role through the same role planner
 * the live dispatch uses, applies the resulting deltas to an in-memory role
 * set, and fails closed if the grant does not take or the revoke does not
 * clear. No Discord call is made; no live guild role is touched.
 */
import {
  applicationIdFromToken,
  checkStagingToken,
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  STAGING_BOT_APPLICATION_NAME,
  stagingGuildId,
} from '../src/staging/spec.ts';
import { loadSelfRolePanels, SelfRoleConfigError } from '../src/selfRoles/config.ts';
import { buildSelfRoleComponents } from '../src/discord/selfRoles.ts';
import { reactionEndpointEmoji } from '../src/selfRoles/plan.ts';
import { proveGrantRevoke } from '../src/selfRoles/proof.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/self-role-panel.ts --panel <id> [--apply]');
  process.exit(0);
}

const API = process.env.SELF_ROLE_PANEL_API_BASE ?? 'https://discord.com/api/v10';
if (API !== 'https://discord.com/api/v10' && !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(?:\/|$)/.test(API)) {
  console.error('SELF_ROLE_PANEL_API_BASE may only override Discord with a loopback test server');
  process.exit(2);
}

const apply = process.argv.includes('--apply');
const idAt = process.argv.indexOf('--panel');
const panelId = idAt >= 0 ? process.argv[idAt + 1] : null;
if (!panelId) {
  console.error('usage: node scripts/self-role-panel.ts --panel <id> [--apply]');
  process.exit(2);
}
let panels: ReturnType<typeof loadSelfRolePanels>;
try {
  panels = loadSelfRolePanels();
} catch (err) {
  if (err instanceof SelfRoleConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
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
const tokenApplicationId = applicationIdFromToken(token);
if (!token || !tokenCheck.ok || tokenApplicationId !== STAGING_BOT_APPLICATION_ID) {
  console.error(
    !token
      ? `missing ${STAGING_BOT_APPLICATION_NAME} token`
      : tokenApplicationId !== STAGING_BOT_APPLICATION_ID
        ? `refusing application ${tokenApplicationId ?? 'unknown'}; expected ${STAGING_BOT_APPLICATION_NAME} (${STAGING_BOT_APPLICATION_ID})`
        : tokenCheck.message,
  );
  process.exit(2);
}

const body = {
  content: panel.color ? 'Choose one color.' : panel.exclusive ? 'Choose one role.' : 'Choose any roles.',
  components: buildSelfRoleComponents(panel).map((row) => row.toJSON()),
};
console.log(`\nself-role panel ${panel.id}\n  guild   ${guildId}\n  channel ${panel.channelId}\n  mode    ${panel.mode}\n`);
if (!apply) {
  console.log(JSON.stringify(body, null, 2));
  let proof: string[];
  try {
    proof = proveGrantRevoke(panel);
  } catch (err) {
    console.error(`grant+revoke proof FAILED: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log('\ngrant+revoke proof (fixture member, no Discord calls):');
  for (const line of proof) console.log(`  ${line}`);
  console.log('\nDry run. Nothing was posted. Re-run with --apply.\n');
  process.exit(0);
}
const channelRes = await fetch(`${API}/channels/${panel.channelId}`, {
  headers: { Authorization: `Bot ${token}` },
});
const channel = (await channelRes.json().catch(() => null)) as { guild_id?: string; message?: string } | null;
if (channelRes.status !== 200 || channel?.guild_id !== guildId) {
  console.error(
    channelRes.status !== 200
      ? `Discord rejected the channel lookup: HTTP ${channelRes.status} ${channel?.message ?? ''}`
      : `refusing channel ${panel.channelId}: Discord says guild ${channel?.guild_id ?? 'unknown'}, expected ${guildId}`,
  );
  process.exit(1);
}
const res = await fetch(`${API}/channels/${panel.channelId}/messages`, {
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
      `${API}/channels/${panel.channelId}/messages/${result.id}/reactions/${encoded}/@me`,
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
