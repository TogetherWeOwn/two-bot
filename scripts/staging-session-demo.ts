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
 *   4. Wrong window, again (TOG-2926). Scanning each audit action type once,
 *      sequentially, and then snapshotting members leaves an open interval: a
 *      write landing after its type was scanned, to a member who then leaves
 *      before the snapshot, is in neither result. Audit publication lag opens
 *      the same hole for a write made just before verification.
 *
 *   5. A timer is not a boundary (TOG-2949/TOG-2950). Waiting for two identical
 *      scans 15 seconds apart still passes over an entry that publishes after
 *      the second scan has read its tail, and Discord documents no maximum
 *      publication lag, so no wait length closes it. Both reviewers reproduced
 *      a pass by publishing at exactly that point.
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
 * The member snapshot is read FIRST, so every audit read is strictly after it.
 * The window is then closed by a FENCE rather than by a wait: --verify creates
 * and immediately deletes a throwaway channel, and refuses to report a result
 * until it has seen that deletion in the audit log. Entry ids are snowflakes,
 * so the fence is newer than any role write the walk could have produced -
 * seeing it published is the log saying it has caught up past the window. One
 * unfiltered read covers every action type at once, so a scan is a single
 * consistent view with no cross-type skew, and two agreeing scans are still
 * required on top of the fence.
 *
 * Either read failing is a failure: a proof that cannot see its evidence must
 * not print a pass. So is a fence that never appears.
 *
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts
 *     -> posts the panel, writes the invite and the baseline to a private dir
 *   ...owner walks a fresh member: join -> gate -> pick -> goodbye...
 *   DISCORD_STAGING_BOT_TOKEN=... node scripts/staging-session-demo.ts --verify
 *     -> re-reads member roles and the audit log, revokes the invite whatever
 *        the proof did, and exits non-zero on any role write in the window or
 *        on an unconfirmed revocation
 *
 * Reading members needs the GUILD_MEMBERS privileged intent and reading the
 * audit log needs VIEW_AUDIT_LOG; this app holds both.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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

/**
 * The audit action that carries the completion fence, and the name of the
 * throwaway channel that produces it. The name is self-describing because an
 * operator who sees it in the guild - which only happens if a --verify run died
 * between creating and deleting it - should be able to tell what it was for.
 */
const CHANNEL_DELETE_ACTION = 12;
const FENCE_CHANNEL_NAME = 'tog-1644-audit-fence';

/** Bounds the audit walk. A window this busy is not a demo window; say so. */
const MAX_AUDIT_PAGES = 10;
const AUDIT_PAGE_SIZE = 100;

/**
 * How long to wait between scans while the log catches up to the fence, and how
 * many times we are willing to go round. This is a backoff, NOT the evidence:
 * what closes the window is seeing the fence entry (see `closeAuditWindow`).
 * Overridable so the tests, which drive a synchronous stub, do not sleep for
 * real.
 */
const QUIESCE_MS = Number(process.env.TWO_SESSION_DEMO_QUIESCE_MS ?? 15_000);
const MAX_QUIESCE_ROUNDS = 8;

/** DELETE /invites statuses that mean the invite is definitely gone. */
const INVITE_GONE_STATUSES = new Set([200, 204, 404]);

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
 * TOG-2926: `mkdirSync(..., { mode })` only applies its mode when it creates the
 * directory, and the default lives under `tmpdir()` when `XDG_RUNTIME_DIR` is
 * unset. So the 0700 boundary the artifacts rely on has to be *checked*, not
 * assumed: `/tmp/two-session-demo` can already exist, owned by someone else or
 * world-readable, and both artifacts (a bearer invite and the guild's whole
 * member->role map) would land inside it.
 *
 * Validated by opening the directory itself - `O_NOFOLLOW` refuses a symlink
 * planted at that name, and every later check reads the fd, so the thing we
 * measured is the thing we write into. The parent is checked too, because a
 * group/world-writable parent without the sticky bit lets someone rename our
 * directory out from under the path.
 *
 * TOG-2949/TOG-2950: the caller gets the *open fd*, not just the path, and
 * every artifact is opened relative to it. Returning only the path meant the
 * validated directory was closed and then re-reached by name, so a directory
 * swapped in between the two steps would have been written to instead - the
 * checks proved something about an object we then stopped holding.
 *
 * Returns the resolved directory and an open fd on it; the caller must close
 * the fd. Throws with a fix-it message otherwise.
 */
function openPrivateArtifactDir(): { dir: string; fd: number } {
  const dir = resolve(ARTIFACT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const parent = dirname(dir);
  if (parent !== dir) {
    // `statSync` reports the *target* of a symlinked parent, which would hide an
    // attacker-owned link sitting on the path: repointing that link moves our
    // directory as surely as renaming it, while the stat still shows a
    // reassuring root-owned sticky /tmp. Ask what the name itself is first.
    const link = lstatSync(parent);
    const p = statSync(parent);
    const selfUid = typeof process.getuid === 'function' ? process.getuid() : p.uid;
    if (link.isSymbolicLink() && link.uid !== 0 && link.uid !== selfUid) {
      throw new Error(
        `Artifact directory parent ${parent} is a symlink owned by uid ${link.uid}, not root or uid ` +
          `${selfUid}, so it can be repointed after this check. Set TWO_SESSION_DEMO_DIR to a path ` +
          'with no foreign symlinks on it.',
      );
    }
    const parentWritableByOthers = (p.mode & 0o022) !== 0;
    const sticky = (p.mode & 0o1000) !== 0;
    if (p.uid !== 0 && p.uid !== selfUid) {
      throw new Error(
        `Artifact directory parent ${parent} is owned by uid ${p.uid}, not root or uid ${selfUid}. ` +
          'Set TWO_SESSION_DEMO_DIR to a directory under storage you control.',
      );
    }
    if (parentWritableByOthers && !sticky) {
      throw new Error(
        `Artifact directory parent ${parent} is writable by others without the sticky bit, so ${dir} ` +
          'can be replaced between checks. Set TWO_SESSION_DEMO_DIR to a private directory.',
      );
    }
  }

  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Linux answers O_DIRECTORY|O_NOFOLLOW on a symlink with ENOTDIR, not
    // ELOOP, so ask what is actually there rather than trusting the errno.
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      let isLink = false;
      try {
        isLink = lstatSync(dir).isSymbolicLink();
      } catch {
        isLink = code === 'ELOOP';
      }
      throw new Error(
        isLink
          ? `Artifact directory ${dir} is a symlink. It must be a real directory this user owns, ` +
            'so that the 0700 boundary cannot be redirected somewhere world-readable.'
          : `Artifact path ${dir} is not a directory.`,
      );
    }
    throw err;
  }
  try {
    let st = fstatSync(fd);
    if (!st.isDirectory()) {
      throw new Error(`Artifact path ${dir} is not a directory.`);
    }
    const selfUid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    if (st.uid !== selfUid) {
      throw new Error(
        `Artifact directory ${dir} is owned by uid ${st.uid}, not uid ${selfUid}. ` +
          'Refusing to write a bearer invite and the guild member map into someone else\'s directory.',
      );
    }
    if ((st.mode & 0o077) !== 0) {
      // Ours, so tighten it in place rather than failing the operator - then
      // re-read the fd, because a chmod that did not take must not pass.
      fchmodSync(fd, 0o700);
      st = fstatSync(fd);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `Artifact directory ${dir} is mode ${(st.mode & 0o7777).toString(8)}; it must be 0700. ` +
          'Fix its permissions or set TWO_SESSION_DEMO_DIR elsewhere.',
      );
    }
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return { dir, fd };
}

/**
 * Artifacts must live inside the validated directory. An override pointing
 * outside it would sidestep every check above while still looking configured.
 *
 * Returns the single path component to open relative to the directory fd -
 * never a path, so there is nothing left for a later resolution step to
 * reinterpret.
 */
function artifactNameInDir(path: string, dir: string): string {
  const full = resolve(path);
  if (dirname(full) !== dir) {
    throw new Error(`Artifact ${full} is outside the private directory ${dir}; refusing to use it.`);
  }
  const name = basename(full);
  if (name === '' || name === '.' || name === '..') {
    throw new Error(`Artifact ${full} does not name a file inside ${dir}; refusing to use it.`);
  }
  return name;
}

/**
 * Open an artifact *through the validated directory fd* rather than by
 * pathname. `/proc/self/fd/<fd>` is the portable-on-Linux spelling of
 * `openat(2)`: it resolves to the inode the fd holds, so the directory we
 * checked is provably the directory we write into even if something replaces
 * the name in between. `O_NOFOLLOW` still applies to the final component,
 * which is the only component left.
 *
 * Where procfs is absent the open falls back to the validated pathname. That
 * path is not race-free, and it is the reason the parent must be sticky or
 * unwritable by others: without write access to the parent nobody can swap the
 * directory out from under the name in the first place.
 */
function openInDir(dirFd: number, dir: string, name: string, flags: number, mode?: number): number {
  const viaProc = `/proc/self/fd/${dirFd}/${name}`;
  let pinned = false;
  try {
    const held = fstatSync(dirFd);
    const seen = statSync(`/proc/self/fd/${dirFd}`);
    pinned = seen.ino === held.ino && seen.dev === held.dev;
  } catch {
    pinned = false;
  }
  const target = pinned ? viaProc : join(dir, name);
  return mode === undefined ? openSync(target, flags) : openSync(target, flags, mode);
}

/**
 * Write owner-only, refusing to follow a symlink someone planted at the path.
 * `O_NOFOLLOW` covers the final component; the 0600 mode is applied on create
 * AND after the fact, because an existing file keeps its old mode.
 */
function writePrivate(path: string, contents: string): void {
  const { dir, fd: dirFd } = openPrivateArtifactDir();
  try {
    const name = artifactNameInDir(path, dir);
    const fd = openInDir(
      dirFd,
      dir,
      name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, contents);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirFd);
  }
}

/** Read back through the same boundary; a verification read is a read of secrets too. */
function readPrivate(path: string): string {
  const { dir, fd: dirFd } = openPrivateArtifactDir();
  try {
    const name = artifactNameInDir(path, dir);
    const fd = openInDir(dirFd, dir, name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(dirFd);
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

  // Before anything is read or written: prove the place the invite and the
  // member map will live is actually private, and that both artifacts are
  // really inside it. Failing here costs nothing; failing after the invite
  // exists means a live bearer credential in a shared directory.
  const preflight = openPrivateArtifactDir();
  try {
    artifactNameInDir(SNAPSHOT_PATH, preflight.dir);
    artifactNameInDir(INVITE_PATH, preflight.dir);
  } finally {
    closeSync(preflight.fd);
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

  /**
   * Identity is the one check that cannot move inside the cleanup-protected
   * region below: revocation is itself a write, and a DELETE sent with a token
   * we have not yet confirmed belongs to the staging application could revoke
   * something in a guild this script was never pointed at. Failing here is also
   * the one case where no invite of ours can exist yet on a --verify run that
   * has not reached the baseline, and where a live one is better left alone
   * than deleted by the wrong identity.
   */
  const me = await api<{ id: string }>('GET', '/users/@me');
  if (me.status !== 200 || me.body?.id !== STAGING_BOT_APPLICATION_ID) {
    throw new Error(
      `Expected staging application ${STAGING_BOT_APPLICATION_ID}; Discord returned HTTP ${me.status}.`,
    );
  }

  /** The reads that must succeed before the script trusts the guild it is in. */
  async function preflightGuild(): Promise<void> {
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

  /**
   * One audit read, unfiltered.
   *
   * TOG-2949/TOG-2950: this used to take an `action_type` and be called once per
   * role action, so a single "full scan" was four sequential HTTP requests. An
   * entry of the first type that published while the fourth request was in
   * flight was in neither that scan nor the previous one - and both reviewers
   * reproduced exactly that, injecting on the last request of a scan.
   *
   * Asking for every action type at once makes a scan ONE request, so its result
   * is a single consistent view of the log tail and the cross-type skew does not
   * exist. Role types are selected here instead of by the server.
   *
   * `after === null` asks for the newest entries; Discord's ordering under an
   * explicit `after` is not documented as stable, so every caller filters and
   * pages by entry id rather than by position.
   */
  async function auditPage(after: string | null): Promise<AuditEntry[]> {
    const page = await api<{ audit_log_entries?: AuditEntry[] }>(
      'GET',
      `/guilds/${guildId}/audit-logs?limit=${AUDIT_PAGE_SIZE}` + (after === null ? '' : `&after=${after}`),
    );
    if (page.status !== 200 || !Array.isArray(page.body?.audit_log_entries)) {
      throw new Error(
        `Could not read the audit log for guild ${guildId}: HTTP ${page.status}. ` +
          'The zero-role-write claim cannot be proven without it.',
      );
    }
    return page.body.audit_log_entries;
  }

  /** The newest audit entry id of any type, or '0' if the log is empty. */
  async function newestAuditId(): Promise<string> {
    let newest = 0n;
    for (const entry of await auditPage(null)) {
      const id = BigInt(entry.id);
      if (id > newest) newest = id;
    }
    return newest.toString();
  }

  const ROLE_ACTION_NAMES = new Map(ROLE_AUDIT_ACTIONS.map((a) => [a.type, a.name]));

  /**
   * One full scan of everything recorded after `cursor`.
   *
   * Returns both halves because the caller needs them for different jobs: the
   * role writes are the finding, and every id seen is what the fence below is
   * checked against.
   */
  async function auditSince(cursor: string): Promise<{ roleWrites: Map<string, string>; seen: AuditEntry[] }> {
    const roleWrites = new Map<string, string>();
    const seen: AuditEntry[] = [];
    const floor = BigInt(cursor);
    let after = cursor;
    for (let page = 0; ; page++) {
      if (page >= MAX_AUDIT_PAGES) {
        throw new Error(
          `More than ${MAX_AUDIT_PAGES * AUDIT_PAGE_SIZE} audit entries since the baseline. ` +
            'That is not a demo window - re-baseline and walk again.',
        );
      }
      const entries = await auditPage(after);
      let highest = BigInt(after);
      for (const entry of entries) {
        const id = BigInt(entry.id);
        if (id > floor) {
          seen.push(entry);
          const name = entry.action_type === undefined ? undefined : ROLE_ACTION_NAMES.get(entry.action_type);
          // Keyed by id: paging by highest-seen can re-serve an entry, and the
          // same write must not read as two.
          if (name) {
            roleWrites.set(
              entry.id,
              `${name} entry ${entry.id}: executor ${entry.user_id ?? 'unknown'}, target ${entry.target_id ?? 'unknown'}`,
            );
          }
        }
        if (id > highest) highest = id;
      }
      if (entries.length < AUDIT_PAGE_SIZE || highest === BigInt(after)) break;
      after = highest.toString();
    }
    return { roleWrites, seen };
  }

  /**
   * Mint the completion fence: an audit entry we author ourselves, after the
   * walk is over, whose id is therefore newer than any role write the walk could
   * have produced.
   *
   * TOG-2949/TOG-2950: the previous version closed the window when two scans
   * 15 seconds apart agreed. That is a timer, not a boundary - an entry that
   * publishes after the second scan reads its tail is in neither scan, and both
   * reviewers reproduced a pass over exactly that. Discord documents no maximum
   * publication lag, so there is no wait length that would fix it. The only way
   * to know the log has caught up to a moment is to put something of our own at
   * that moment and read until we see it.
   *
   * A throwaway channel is the marker: it is not a role write (so it cannot be
   * confused with the thing under test), not a credential (unlike an invite, a
   * leaked one grants nobody anything), and it is created and deleted within a
   * few milliseconds. `CHANNEL_DELETE` is the fence because it is the later of
   * the two entries.
   *
   * The channel is deleted on every path; a marker we could not clean up is
   * reported rather than swallowed, because a leftover channel in the guild is
   * an operator-visible mess even though it is harmless.
   */
  async function mintAuditFence(): Promise<string> {
    const created = await api<{ id: string }>('POST', `/guilds/${guildId}/channels`, {
      name: FENCE_CHANNEL_NAME,
      type: 0,
    });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(
        `Could not create the audit fence channel in guild ${guildId}: HTTP ${created.status}. ` +
          'Without a marker of our own the audit window cannot be closed, and an unfenced scan ' +
          'is a timed guess rather than a proof. Grant the staging app MANAGE_CHANNELS and re-verify.',
      );
    }
    const channelId = created.body?.id;
    if (!channelId) {
      throw new Error(`Discord accepted the audit fence channel but returned no id: ${JSON.stringify(created.body)}.`);
    }
    const deleted = await api<unknown>('DELETE', `/channels/${channelId}`);
    if (deleted.status !== 200 && deleted.status !== 204) {
      throw new Error(
        `Could not delete the audit fence channel ${channelId}: HTTP ${deleted.status}. ` +
          `Delete #${FENCE_CHANNEL_NAME} by hand, then re-verify.`,
      );
    }
    return channelId;
  }

  /**
   * Close the window by observation rather than by waiting.
   *
   * Mint a fence (an entry we authored after the walk ended), then scan until
   * that entry is visible in the log. Because audit entry ids are snowflakes,
   * every role write the walk could have produced has a smaller id than the
   * fence; seeing the fence is the log telling us it has published past the
   * point where such a write would be. A scan that cannot find the fence has
   * not caught up, so it is repeated - and a log that never catches up is a
   * failure, not a pass.
   *
   * The two-agreeing-scans rule is kept on top of the fence as defence in
   * depth, so a write that publishes out of id order still has to land in two
   * consecutive identical scans to be missed.
   */
  async function closeAuditWindow(cursor: string, fenceChannelId: string): Promise<string[]> {
    let previous: Map<string, string> | null = null;
    for (let round = 1; ; round++) {
      const { roleWrites, seen } = await auditSince(cursor);
      const fenced = seen.some((e) => e.action_type === CHANNEL_DELETE_ACTION && e.target_id === fenceChannelId);
      const prior = previous;
      const settled =
        prior !== null && prior.size === roleWrites.size && [...roleWrites.keys()].every((id) => prior.has(id));
      if (fenced && settled) return [...roleWrites.values()].sort();
      if (round >= MAX_QUIESCE_ROUNDS) {
        throw new Error(
          fenced
            ? `The audit log was still changing after ${MAX_QUIESCE_ROUNDS} rounds ` +
              `(${previous?.size ?? 0} -> ${roleWrites.size} role writes since ${cursor}). ` +
              'The window is not closed, so this proof would be a guess - stop the walk and re-verify.'
            : `The audit log never published the fence entry for channel ${fenceChannelId} after ` +
              `${MAX_QUIESCE_ROUNDS} rounds. The log is lagging further behind than this proof can ` +
              'wait, so anything the walk wrote may still be unpublished - re-verify rather than trust this.',
        );
      }
      previous = roleWrites;
      await sleep(QUIESCE_MS);
    }
  }

  /**
   * TOG-2925/TOG-2926: revocation has to survive a failed proof and has to tell
   * the truth about its own outcome.
   *
   * The old code ran after the audit and member reads, so any read failure left
   * the bearer invite live; and it removed the local copy whatever Discord
   * answered, so a 500 printed "revoked" and destroyed the only handle for the
   * retry. Only a confirmed deletion (200/204) or an already-gone invite (404)
   * is terminal. Anything else keeps the file and fails the run.
   *
   * Never throws: it runs on the failure path, where it must not mask the
   * proof's own error.
   */
  async function revokeInvite(): Promise<{ ok: boolean; message: string }> {
    let contents: string;
    try {
      contents = readPrivate(INVITE_PATH);
    } catch {
      // TOG-2949/TOG-2950: this used to return ok. "I cannot find the handle"
      // is not "the invite is gone" - it is the one state where we know least,
      // and the baseline run only ever writes this file after Discord has
      // confirmed a live invite. Deleting it (or a write that failed after the
      // POST succeeded) must not read as a clean revocation.
      return {
        ok: false,
        message:
          `No invite handle at ${INVITE_PATH}, so revocation is unconfirmed. An invite created by the ` +
          'baseline run may still be live: check the guild\'s invite list in Discord and delete it by hand, ' +
          'then re-baseline before walking again.',
      };
    }

    // A confirmed revocation leaves a receipt rather than removing the file, so
    // that a second --verify can tell "already revoked, and here is the status
    // Discord actually returned" apart from "the handle is missing".
    const receipt = contents.match(/^revoked\s+(\S+)\s+HTTP\s+(\d{3})\b/m);
    if (receipt) {
      return { ok: true, message: `demo invite already revoked (HTTP ${receipt[2]}); receipt in ${INVITE_PATH}` };
    }

    const url = contents.trim();
    const code = /^https:\/\/discord\.gg\/([A-Za-z0-9-]+)$/.exec(url)?.[1] ?? '';
    if (!code) {
      return {
        ok: false,
        message:
          `${INVITE_PATH} does not hold a usable invite handle or a revocation receipt, so revocation is ` +
          'unconfirmed. Check the guild\'s invite list in Discord and delete any demo invite by hand.',
      };
    }

    let status: number;
    try {
      status = (await api<unknown>('DELETE', `/invites/${code}`)).status;
    } catch (err) {
      return {
        ok: false,
        message:
          `Could not reach Discord to revoke the demo invite: ${err instanceof Error ? err.message : String(err)}. ` +
          `The invite is still live; ${INVITE_PATH} is kept so you can retry.`,
      };
    }
    if (!INVITE_GONE_STATUSES.has(status)) {
      return {
        ok: false,
        message:
          `Revoking the demo invite returned HTTP ${status}, which does not confirm deletion. ` +
          `The invite may still be live; ${INVITE_PATH} is kept so you can retry.`,
      };
    }
    // The bearer URL is overwritten in place by the receipt, so the credential
    // stops existing on disk at the same moment it stops existing in Discord,
    // and the file that remains is evidence rather than a secret.
    try {
      writePrivate(INVITE_PATH, `revoked ${code} HTTP ${status} at ${new Date().toISOString()}\n`);
    } catch (err) {
      return {
        ok: false,
        message:
          `The demo invite was revoked (HTTP ${status}) but the receipt could not be written to ${INVITE_PATH}: ` +
          `${err instanceof Error ? err.message : String(err)}. Remove that file by hand.`,
      };
    }
    return {
      ok: true,
      message:
        status === 404
          ? `demo invite was already gone (HTTP 404); receipt written to ${INVITE_PATH}`
          : `revoked demo invite (HTTP ${status}); receipt written to ${INVITE_PATH}`,
    };
  }

  if (verifyOnly) {
    /**
     * TOG-2949/TOG-2950: everything that can fail now sits inside this block,
     * because revocation runs after it unconditionally. Previously the baseline
     * parse and the guild preflight ran above it, so a corrupted snapshot or a
     * lost permission failed the run with zero DELETE requests and left the
     * bearer invite live - which is the exact moment an operator stops reading
     * output.
     */
    let proofError: unknown = null;
    try {
      await preflightGuild();

      let baseline: Baseline;
      try {
        baseline = JSON.parse(readPrivate(SNAPSHOT_PATH)) as Baseline;
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

      // (b) Net state first, so every audit read below is strictly after it and
      // no write can slip through the gap between the two checks.
      const deltas = roleDeltas(baseline.members, await memberRoles());
      // The fence is minted after the member read and before the audit scan, so
      // its id is newer than any role write this walk could have produced.
      const fenceChannelId = await mintAuditFence();
      // (a) The audit log: the only check that can see a member who has left.
      const writes = await closeAuditWindow(baseline.auditCursor, fenceChannelId);

      console.log('--- role writes since baseline (audit log) ---');
      if (writes.length) {
        throw new Error(`The guild audit log records role writes during this window:\n${writes.join('\n')}`);
      }
      console.log(
        `NONE across ${ROLE_AUDIT_ACTIONS.map((a) => a.name).join(', ')} since entry ${baseline.auditCursor}`,
      );
      console.log(`window closed by observing fence entry for channel ${fenceChannelId}`);

      console.log('--- member role delta since baseline ---');
      if (deltas.length) {
        throw new Error(`Member roles changed:\n${deltas.join('\n')}`);
      }
      console.log(`IDENTICAL - zero role delta across ${Object.keys(baseline.members).length} members`);
    } catch (err) {
      proofError = err;
    }

    // Always, whatever the proof did: a failed verification is exactly when a
    // live bearer invite is most likely to be forgotten.
    const revocation = await revokeInvite();
    console.log('--- invite ---');
    console.log(revocation.message);
    if (proofError) {
      if (!revocation.ok) console.error(revocation.message);
      throw proofError;
    }
    if (!revocation.ok) throw new Error(revocation.message);
    return;
  }

  await preflightGuild();

  const baseline: Baseline = {
    guildId,
    takenAt: new Date().toISOString(),
    auditCursor: await newestAuditId(),
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
