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
 * It also produces the zero-role-delta evidence, in two halves. An earlier
 * revision compared `GET /guilds/{id}/roles` before and after, and that proved
 * nothing twice over (TOG-2871 / TOG-2872):
 *
 *   1. Wrong object. That endpoint returns role *definitions*. Granting a member
 *      an existing role changes `member.roles`, never the definition list, so
 *      the two snapshots matched even after a real role write.
 *   2. Wrong window. Both snapshots were taken seconds apart, before the owner
 *      had even used the invite - so they could not span the member walk that is
 *      the thing under test.
 *
 * So the proof now snapshots every member's role IDs, and is split across the
 * walk:
 *
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts
 *     -> posts the panel, writes the invite and the baseline snapshot to files
 *   ...owner walks a fresh member: join -> gate -> pick -> goodbye...
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts --verify
 *     -> re-reads member roles and exits non-zero on any delta
 *
 * Reading members needs the GUILD_MEMBERS privileged intent, which this app
 * already holds.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
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
const SNAPSHOT_PATH =
  process.env.TWO_SESSION_DEMO_SNAPSHOT ?? '.staging-session-demo-snapshot.json';
const INVITE_PATH = process.env.TWO_SESSION_DEMO_INVITE ?? '.staging-session-demo-invite.txt';

interface MemberRoles {
  [memberId: string]: string[];
}

/** Members whose role set differs between two snapshots, in either direction. */
function roleDeltas(before: MemberRoles, after: MemberRoles): string[] {
  const deltas: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = (before[id] ?? []).slice().sort();
    const a = (after[id] ?? []).slice().sort();
    if (b.join(',') !== a.join(',')) {
      deltas.push(`${id}: [${b.join(', ')}] -> [${a.join(', ')}]`);
    }
  }
  return deltas.sort();
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
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

  /**
   * Every member's role IDs. This - not the guild role list - is the object a
   * role grant actually changes, so it is the only snapshot that can falsify
   * the zero-role-write claim. Paginated because `limit` caps at 1000 and a
   * short read would silently look like "no members changed".
   */
  async function memberRoles(): Promise<MemberRoles> {
    const out: MemberRoles = {};
    let after = '0';
    for (;;) {
      const page = await api<Array<{ user?: { id: string }; roles?: string[] }>>(
        'GET',
        `/guilds/${guildId}/members?limit=1000&after=${after}`,
      );
      if (page.status !== 200 || !Array.isArray(page.body)) {
        throw new Error(`Could not read members for guild ${guildId}: HTTP ${page.status}.`);
      }
      if (!page.body.length) return out;
      for (const m of page.body) {
        if (m.user?.id) out[m.user.id] = m.roles ?? [];
      }
      const last = page.body[page.body.length - 1]?.user?.id;
      if (!last || page.body.length < 1000) return out;
      after = last;
    }
  }

  if (verifyOnly) {
    let baseline: MemberRoles;
    try {
      baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as MemberRoles;
    } catch {
      throw new Error(
        `No baseline at ${SNAPSHOT_PATH}. Run this script without --verify before the member walk.`,
      );
    }
    const deltas = roleDeltas(baseline, await memberRoles());
    console.log('--- member role delta since baseline ---');
    if (deltas.length) {
      throw new Error(`Member roles changed:\n${deltas.join('\n')}`);
    }
    console.log(`IDENTICAL - zero role delta across ${Object.keys(baseline).length} members`);
    return;
  }

  const before = await memberRoles();
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(before, null, 2));
  console.log('--- member role snapshot BEFORE ---');
  console.log(`${Object.keys(before).length} members recorded to ${SNAPSHOT_PATH}`);

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
  // The invite is a bearer credential: anyone holding the URL can join the
  // guild until it expires. Operator and CI transcripts are retained, so it
  // goes to an owner-only file and only the path is printed.
  writeFileSync(INVITE_PATH, `https://discord.gg/${invite.body.code}\n`, { mode: 0o600 });
  chmodSync(INVITE_PATH, 0o600);
  console.log('--- invite for the fresh test member ---');
  console.log(`written to ${INVITE_PATH} (max_age 86400s, max_uses 3) - not printed here`);

  console.log('--- next ---');
  console.log('walk a fresh member through join -> gate -> pick -> goodbye, then run:');
  console.log('  node scripts/staging-session-demo.ts --verify');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
