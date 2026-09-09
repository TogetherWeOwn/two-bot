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
import { buildSessionPicks, sessionWelcomeText } from '../src/onboarding/session.ts';
import {
  LIVE_GUILD_ID,
  STAGING_BOT_APPLICATION_ID,
  checkStagingToken,
  stagingGuildId,
} from '../src/staging/spec.ts';

const API = process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
const EXPECTED_CHANNEL = { id: '1546451669284552726', name: 'welcome', type: 0 } as const;

async function main(): Promise<void> {
  const token = process.env.DISCORD_STAGING_BOT_TOKEN;
  if (!token) throw new Error('Missing DISCORD_STAGING_BOT_TOKEN.');
  const tokenCheck = checkStagingToken(token);
  if (!tokenCheck.ok) throw new Error(tokenCheck.message);

  const guildId = stagingGuildId();
  if (guildId === LIVE_GUILD_ID) {
    throw new Error(`Refusing to touch the live TWO guild (${LIVE_GUILD_ID}).`);
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as T | null };
  }

  const me = await api<{ id: string }>('GET', '/users/@me');
  if (me.status !== 200 || me.body?.id !== STAGING_BOT_APPLICATION_ID) {
    throw new Error(
      `Expected staging application ${STAGING_BOT_APPLICATION_ID}; Discord returned HTTP ${me.status}.`,
    );
  }

  const channel = await api<{ id: string; guild_id?: string; name?: string; type?: number }>(
    'GET',
    `/channels/${EXPECTED_CHANNEL.id}`,
  );
  if (
    channel.status !== 200 ||
    channel.body?.id !== EXPECTED_CHANNEL.id ||
    channel.body.guild_id !== guildId ||
    channel.body.name !== EXPECTED_CHANNEL.name ||
    channel.body.type !== EXPECTED_CHANNEL.type
  ) {
    throw new Error(
      `Expected #${EXPECTED_CHANNEL.name} (${EXPECTED_CHANNEL.id}) in guild ${guildId}; ` +
        `received HTTP ${channel.status} ${JSON.stringify(channel.body)}.`,
    );
  }

  const roles = await api<Array<{ id: string; name: string }>>('GET', `/guilds/${guildId}/roles`);
  if (roles.status !== 200 || !Array.isArray(roles.body)) {
    throw new Error(`Could not read roles for guild ${guildId}: HTTP ${roles.status}.`);
  }
  const before = roles.body
    .map((r) => `${r.id}:${r.name}`)
    .sort()
    .join('\n');
  console.log('--- role snapshot BEFORE ---');
  console.log(before);

  // The demo panel: same text and menu the bot posts on gate clear, addressed
  // to the guild rather than one member, so it is self-describing on the wall.
  const sessionPicks = buildSessionPicks({
    lookingToPlay: '1546211377847337020',
    lobbyVoice: '1546211378430345286',
  });
  const payload = {
    content:
      sessionWelcomeText('') +
      '\n\n*(TOG-1644 staging demo panel - this is the exact welcome the bot posts when a new member clears the rules gate. Click it as yourself: it routes and records, it does not label you.)*',
    components: [buildSessionMenu(sessionPicks).toJSON()],
  };
  const posted = await api<{ id: string }>(
    'POST',
    `/channels/${EXPECTED_CHANNEL.id}/messages`,
    payload,
  );
  if (posted.status !== 200 || !posted.body?.id) {
    throw new Error(`Failed to post demo panel: HTTP ${posted.status} ${JSON.stringify(posted.body)}.`);
  }
  console.log('--- demo panel ---');
  console.log(`posted message ${posted.body.id} in #${EXPECTED_CHANNEL.name}`);

  // A time-limited invite for the owner's test member.
  const invite = await api<{ code: string }>('POST', `/channels/${EXPECTED_CHANNEL.id}/invites`, {
    max_age: 86400,
    max_uses: 3,
    unique: true,
  });
  if (invite.status !== 200 || !invite.body?.code) {
    throw new Error(`Failed to create demo invite: HTTP ${invite.status} ${JSON.stringify(invite.body)}.`);
  }
  console.log('--- invite for the fresh test member ---');
  console.log(`https://discord.gg/${invite.body.code}`);

  const rolesAfter = await api<Array<{ id: string; name: string }>>('GET', `/guilds/${guildId}/roles`);
  if (rolesAfter.status !== 200 || !Array.isArray(rolesAfter.body)) {
    throw new Error(`Could not re-read roles for guild ${guildId}: HTTP ${rolesAfter.status}.`);
  }
  const after = rolesAfter.body
    .map((r) => `${r.id}:${r.name}`)
    .sort()
    .join('\n');
  console.log('--- role snapshot AFTER (must equal BEFORE) ---');
  if (after !== before) throw new Error(`Role snapshot changed:\n${after}`);
  console.log('IDENTICAL - zero role delta');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
