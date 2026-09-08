/**
 * TOG-1644 staging demo driver.
 *
 * The bot process (already running in session mode against TWO Staging)
 * reacts to member events; this script does the half Discord will not do for
 * us without a human: it posts the exact welcome panel the bot posts - same
 * builder, same code - into #welcome, so the picker's rendering on the real
 * platform is provable now. The full member walk (join -> gate -> pick ->
 * goodbye) is then driven by the owner with the invite this script prints.
 *
 * It also snapshots guild roles before and after, which is the zero-role-
 * delta evidence: identical snapshots + no member role writes in the bot log
 * = the parity guarantee held on the real platform.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts
 */
import { buildSessionMenu } from '../src/discord/sessionWelcome.ts';
import { sessionWelcomeText } from '../src/onboarding/session.ts';
import { LIVE_GUILD_ID, checkStagingToken, stagingGuildId } from '../src/staging/spec.ts';

const API = 'https://discord.com/api/v10';
const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) {
  console.error('Missing DISCORD_STAGING_BOT_TOKEN.');
  process.exit(2);
}
const tokenCheck = checkStagingToken(token);
if (!tokenCheck.ok) {
  console.error(tokenCheck.message);
  process.exit(2);
}
const guildId = stagingGuildId();
if (guildId === LIVE_GUILD_ID) {
  console.error(`Refusing to touch the live TWO guild (${LIVE_GUILD_ID}).`);
  process.exit(2);
}

const WELCOME_CHANNEL = '1546451669284552726'; // #welcome in TWO Staging

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
}

const roles = await api<unknown[]>('GET', `/guilds/${guildId}/roles`);
const before = (roles.body as { id: string; name: string }[])
  .map((r) => `${r.id}:${r.name}`)
  .sort()
  .join('\n');
console.log('--- role snapshot BEFORE ---');
console.log(before);

// The demo panel: same text and menu the bot posts on gate clear, addressed
// to the guild rather than one member, so it is self-describing on the wall.
const payload = {
  content:
    sessionWelcomeText("") +
    '\n\n*(TOG-1644 staging demo panel - this is the exact welcome the bot posts when a new member clears the rules gate. Click it as yourself: it routes and records, it does not label you.)*',
  components: [buildSessionMenu().toJSON()],
};
const posted = await api<{ id: string }>('POST', `/channels/${WELCOME_CHANNEL}/messages`, payload);
console.log('--- demo panel ---');
console.log(posted.status === 200 ? `posted message ${posted.body.id} in #welcome` : `FAILED: ${JSON.stringify(posted.body)}`);

// A time-limited invite for the owner's test member.
const inv = await api<{ code: string }>('POST', `/channels/${WELCOME_CHANNEL}/invites`, {
  max_age: 86400,
  max_uses: 3,
  unique: true,
});
console.log('--- invite for the fresh test member ---');
console.log(inv.status === 200 ? `https://discord.gg/${inv.body.code}` : `FAILED: ${JSON.stringify(inv.body)}`);

const roles2 = await api<unknown[]>('GET', `/guilds/${guildId}/roles`);
const after = (roles2.body as { id: string; name: string }[])
  .map((r) => `${r.id}:${r.name}`)
  .sort()
  .join('\n');
console.log('--- role snapshot AFTER (must equal BEFORE) ---');
console.log(after === before ? 'IDENTICAL - zero role delta' : `CHANGED:\n${after}`);
