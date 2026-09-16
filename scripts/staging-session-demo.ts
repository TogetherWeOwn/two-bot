/**
 * TOG-1644 staging demo driver.
 *
 * The bot process (already running in session mode against TWO Staging)
 * reacts to member events; this script does the half Discord will not do for
 * us without a human: it posts the exact welcome panel the bot posts - same
 * builder, same code - into #welcome, so the picker's rendering on the real
 * platform is provable now. The full member walk (join -> gate -> pick ->
 * goodbye) is then driven by the owner with the invite this script writes.
 *
 * It also produces the zero-role-write evidence. Three earlier revisions of
 * that proof were each falsifiable-looking and actually blind (TOG-2871,
 * TOG-2872, TOG-2886):
 *
 *   1. Wrong object. `GET /guilds/{id}/roles` returns role *definitions*.
 *      Granting a member an existing role changes `member.roles`, never the
 *      definition list, so both snapshots matched after a real role write.
 *   2. Wrong window. Both snapshots were taken seconds apart, before the owner
 *      had used the invite, so they could not span the walk under test.
 *   3. Wrong population. Snapshotting every member's roles before the walk and
 *      again after it still cannot see the member the walk is about: they join
 *      after the baseline and leave before the verify, so they are absent from
 *      both sides and compare equal. A role granted and then removed during the
 *      walk is invisible for the same reason.
 *
 * So the proof is now two independent checks over the same window, and BOTH
 * must pass:
 *
 *   a. The guild audit log. Every role write Discord performs lands here with
 *      an executor, whether or not the member is still in the guild and whether
 *      or not the write was later undone. The baseline records the newest audit
 *      entry id; --verify fails on any role-affecting entry after it. This is
 *      the check that covers the fresh member.
 *   b. The per-member role snapshot. Net state, for anything the audit log
 *      cannot attribute.
 *
 * Either read failing is a failure: a proof that cannot see its evidence must
 * not print a pass.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts
 *     -> posts the panel, writes the invite and the baseline to a private dir
 *   ...owner walks a fresh member: join -> gate -> pick -> goodbye...
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts --verify
 *     -> re-reads the audit log and member roles, revokes the invite, and
 *        exits non-zero on any role write in the window
 *
 * Reading members needs the GUILD_MEMBERS privileged intent and reading the
 * audit log needs VIEW_AUDIT_LOG; this app holds both.
 */
import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Both artifacts carry something that must not be casually readable - the
 * baseline is the guild's complete member->role map, the invite is a bearer
 * credential - and neither belongs in the checkout, where `git add -A` can
 * commit it. Default them into a private per-user runtime directory.
 */
const ARTIFACT_DIR =
  process.env.TWO_SESSION_DEMO_DIR ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'two-session-demo');
const SNAPSHOT_PATH = process.env.TWO_SESSION_DEMO_SNAPSHOT ?? join(ARTIFACT_DIR, 'baseline.json');
const INVITE_PATH = process.env.TWO_SESSION_DEMO_INVITE ?? join(ARTIFACT_DIR, 'invite.txt');

/** Audit log action types that represent a role write. */
const ROLE_AUDIT_ACTIONS: ReadonlyArray<{ type: number; name: string }> = [
  { type: 25, name: 'MEMBER_ROLE_UPDATE' },
  { type: 30, name: 'ROLE_CREATE' },
  { type: 31, name: 'ROLE_UPDATE' },
  { type: 32, name: 'ROLE_DELETE' },
];

/** Bounds the audit walk. A window this busy is not a demo window; say so. */
const MAX_AUDIT_PAGES = 10;
const AUDIT_PAGE_SIZE = 100;

interface MemberRoles {
  [memberId: string]: string[];
}

interface Baseline {
  guildId: string;
  takenAt: string;
  /** Newest audit log entry id at baseline time; '0' when the log was empty. */
  auditCursor: string;
  members: MemberRoles;
}

interface AuditEntry {
  id: string;
  user_id?: string | null;
  target_id?: string | null;
  action_type?: number;
}

/**
 * Write owner-only, refusing to follow a symlink someone planted at the path.
 * `O_NOFOLLOW` covers the final component; the 0600 mode is applied on create
 * AND after the fact, because an existing file keeps its old mode.
 */
function writePrivate(path: string, contents: string): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
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
   * role grant actually changes. Paginated because `limit` caps at 1000 and a
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

  /** `after === null` asks for the newest entries; Discord's ordering under an
   * explicit `after` is not documented as stable, so every caller filters and
   * pages by entry id rather than by position. */
  async function auditPage(actionType: number, after: string | null): Promise<AuditEntry[]> {
    const page = await api<{ audit_log_entries?: AuditEntry[] }>(
      'GET',
      `/guilds/${guildId}/audit-logs?limit=${AUDIT_PAGE_SIZE}&action_type=${actionType}` +
        (after === null ? '' : `&after=${after}`),
    );
    if (page.status !== 200 || !Array.isArray(page.body?.audit_log_entries)) {
      throw new Error(
        `Could not read the audit log for guild ${guildId} (action ${actionType}): HTTP ${page.status}. ` +
          'The zero-role-write claim cannot be proven without it.',
      );
    }
    return page.body.audit_log_entries;
  }

  /** The newest role-affecting audit entry id, or '0' if there is none. */
  async function newestRoleAuditId(): Promise<string> {
    let newest = 0n;
    for (const action of ROLE_AUDIT_ACTIONS) {
      for (const entry of await auditPage(action.type, null)) {
        const id = BigInt(entry.id);
        if (id > newest) newest = id;
      }
    }
    return newest.toString();
  }

  /** Role writes recorded after `cursor`, described for a human. */
  async function roleWritesSince(cursor: string): Promise<string[]> {
    const found = new Map<string, string>();
    const floor = BigInt(cursor);
    for (const action of ROLE_AUDIT_ACTIONS) {
      let after = cursor;
      for (let page = 0; ; page++) {
        if (page >= MAX_AUDIT_PAGES) {
          throw new Error(
            `More than ${MAX_AUDIT_PAGES * AUDIT_PAGE_SIZE} ${action.name} entries since the baseline. ` +
              'That is not a demo window - re-baseline and walk again.',
          );
        }
        const entries = await auditPage(action.type, after);
        let highest = BigInt(after);
        for (const entry of entries) {
          const id = BigInt(entry.id);
          if (id > floor) {
            // Keyed by id: paging by highest-seen can re-serve an entry, and
            // the same write must not read as two.
            found.set(
              entry.id,
              `${action.name} entry ${entry.id}: executor ${entry.user_id ?? 'unknown'}, target ${entry.target_id ?? 'unknown'}`,
            );
          }
          if (id > highest) highest = id;
        }
        if (entries.length < AUDIT_PAGE_SIZE || highest === BigInt(after)) break;
        after = highest.toString();
      }
    }
    return [...found.values()].sort();
  }

  if (verifyOnly) {
    let baseline: Baseline;
    try {
      baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Baseline;
    } catch {
      throw new Error(
        `No baseline at ${SNAPSHOT_PATH}. Run this script without --verify before the member walk.`,
      );
    }
    if (baseline.guildId !== guildId || typeof baseline.auditCursor !== 'string' || !baseline.members) {
      throw new Error(
        `Baseline at ${SNAPSHOT_PATH} is for guild ${baseline.guildId ?? 'unknown'} or predates the audit-log ` +
          `proof; it cannot cover this walk. Re-baseline against ${guildId} and walk again.`,
      );
    }

    // (a) The audit log: the only check that can see a member who has left.
    const writes = await roleWritesSince(baseline.auditCursor);
    // (b) Net state, for anything the audit log could not attribute.
    const deltas = roleDeltas(baseline.members, await memberRoles());

    // Revoke the invite before reporting, so a failure does not leave a live
    // credential behind. Best effort: a missing or already-expired invite is
    // not a proof failure.
    let invite = '';
    try {
      invite = readFileSync(INVITE_PATH, 'utf8');
    } catch {
      invite = '';
    }
    const code = invite.trim().split('/').pop() ?? '';
    if (code) {
      const revoked = await api<unknown>('DELETE', `/invites/${code}`);
      console.log(`--- invite ---`);
      console.log(`revoked demo invite (HTTP ${revoked.status}); removing ${INVITE_PATH}`);
      rmSync(INVITE_PATH, { force: true });
    }

    console.log('--- role writes since baseline (audit log) ---');
    if (writes.length) {
      throw new Error(`The guild audit log records role writes during this window:\n${writes.join('\n')}`);
    }
    console.log(`NONE across ${ROLE_AUDIT_ACTIONS.map((a) => a.name).join(', ')} since entry ${baseline.auditCursor}`);

    console.log('--- member role delta since baseline ---');
    if (deltas.length) {
      throw new Error(`Member roles changed:\n${deltas.join('\n')}`);
    }
    console.log(`IDENTICAL - zero role delta across ${Object.keys(baseline.members).length} members`);
    return;
  }

  const baseline: Baseline = {
    guildId,
    takenAt: new Date().toISOString(),
    auditCursor: await newestRoleAuditId(),
    members: await memberRoles(),
  };
  writePrivate(SNAPSHOT_PATH, JSON.stringify(baseline, null, 2));
  console.log('--- baseline ---');
  console.log(
    `${Object.keys(baseline.members).length} members and audit cursor ${baseline.auditCursor} recorded to ${SNAPSHOT_PATH}`,
  );

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

  // One use, one hour: the walk needs exactly one fresh member, and --verify
  // revokes whatever is left. A wider invite is a standing way into the guild.
  const invite = await api<{ code: string }>('POST', `/channels/${EXPECTED_CHANNEL.id}/invites`, {
    max_age: 3600,
    max_uses: 1,
    unique: true,
  });
  if (invite.status !== 200 || !invite.body?.code) {
    throw new Error(`Failed to create demo invite: HTTP ${invite.status} ${JSON.stringify(invite.body)}.`);
  }
  // The invite is a bearer credential: anyone holding the URL can join the
  // guild until it expires. Operator and CI transcripts are retained, so it
  // goes to an owner-only file and only the path is printed.
  writePrivate(INVITE_PATH, `https://discord.gg/${invite.body.code}\n`);
  console.log('--- invite for the fresh test member ---');
  console.log(`written to ${INVITE_PATH} (max_age 3600s, max_uses 1) - not printed here`);

  console.log('--- next ---');
  console.log('walk a fresh member through join -> gate -> pick -> goodbye, then run:');
  console.log('  node scripts/staging-session-demo.ts --verify');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
