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
 * It also produces the zero-role-write evidence. Five earlier revisions of
 * that proof were each falsifiable-looking and actually blind (TOG-2871,
 * TOG-2872, TOG-2886, TOG-2949/TOG-2950, TOG-2963/TOG-2964):
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
 *   6. A fence is not a boundary either (TOG-2963/TOG-2964). The answer to (5)
 *      was to mint an entry of our own after the walk and read until it
 *      appeared, reasoning that snowflake ids make the fence newer than any
 *      role write the walk could have produced, so seeing it meant the log had
 *      published past the window. Both reviewers reproduced a pass over that
 *      too, and they are right. Discord documents that `after` returns "entries
 *      with ID greater than" the cursor, ascending - that is the ordering of
 *      what HAS been published, not a promise that an older id publishes before
 *      a newer one. Seeing the fence therefore bounds nothing.
 *
 * There is no seventh revision of this trick, because the approach itself was
 * wrong. Absence cannot be established from the audit log: that would need a
 * completeness guarantee, only Discord could give one, and Discord does not.
 * So this script no longer claims to prove absence. The claim it makes now is
 * the true one, and it is a stronger claim than the live walk could ever have
 * supported:
 *
 *   THE GUARANTEE IS IN THE CODE, NOT IN THE GUILD. Session mode cannot write a
 *   role because no registered code path reaches a role write, and the paths
 *   that could are refused at boot. TOG-2972 P1: that is four things, not one,
 *   so all four are named here rather than resting on the two pure helpers:
 *
 *     1. src/onboarding/mode.ts. `actionsForOnboardingMode` removes
 *        `role.assign` from the enabled internal actions;
 *        `levelRoleWritesForOnboardingMode` suppresses leveling reward roles.
 *        Both are pure and total over their input, and are asserted directly by
 *        test/unit.onboardingmode.test.ts.
 *     2. Their call sites, which are what make those two functions bind the
 *        running bot rather than only themselves: src/index.ts:813 (internal
 *        actions) and src/index.ts:426 (leveling).
 *     3. src/index.ts:717-759. Session mode registers ONLY the roleless
 *        `registerSessionWelcome`; the legacy picker and anchor-welcome
 *        handlers are left unregistered, and nothing in
 *        src/discord/sessionWelcome.ts calls `roles.add`/`roles.remove`.
 *     4. src/index.ts:145-149 and :158-163. Self-role panels and armed anti-nuke
 *        containment each write member roles, so session mode refuses to boot
 *        alongside either - at startup, not at the first incident.
 *
 *   test/e2e.session.test.ts is the evidence for (2), (3) and (4) together: it
 *   runs the bot against a mock gateway and asserts zero role-write requests
 *   across a full join -> gate -> pick -> goodbye walk, a withheld leveling
 *   reward role with the XP still awarded, and a refusal from each boot guard.
 *   That is a claim about this source tree, and no observation of one walk in
 *   one guild can be more complete than it - it can only agree or contradict.
 *
 * What the live walk contributes is therefore a FALSIFIER, whose job is to
 * catch a deployed build that does not behave like the tested one:
 *
 *   a. The guild audit log. Every role write Discord performs lands here with
 *      an executor, whether or not the member is still in the guild and whether
 *      or not the write was later undone. The baseline records the newest audit
 *      entry id; --verify fails on any role-affecting entry after it. This is
 *      the check that covers the fresh member. One unfiltered read covers every
 *      action type at once, so a scan is a single consistent view of the tail
 *      with no cross-type skew.
 *   b. The per-member role snapshot. Net state, for anything the audit log
 *      cannot attribute.
 *
 * The member snapshot is read FIRST, so every audit read is strictly after it.
 *
 * A finding in either is a hard failure. A clean result is reported as exactly
 * what it is - no role write OBSERVED, in the log as published at the moment it
 * was read - and this script will not print the word "proven" over it. Either
 * read failing is also a failure: a falsifier that cannot see its evidence must
 * not report a pass.
 *
 * The bot's permissions cannot supply the missing boundary either: it keeps
 * Manage Roles in staging for self-roles and, in legacy mode, leveling. Which
 * is precisely why the boundary has to be the code path, and is.
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
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

/** DELETE /invites statuses that mean the invite is definitely gone. */
const INVITE_GONE_STATUSES = new Set([200, 204, 404]);

/**
 * The invite artifact is two lines: a `run <id>` header naming the baseline run
 * that owns it, then one payload line. Splitting it this way keeps the bearer
 * URL alone on its own line for the operator to copy, and gives every state the
 * file can be in an owner.
 *
 *   run <id>\npending                              staged, before the POST
 *   run <id>\nhttps://discord.gg/<code>            a live invite
 *   run <id>\nrevoked <code> HTTP <n> at <iso>     a revocation receipt
 */
const ARTIFACT_RE = /^run ([0-9a-f-]{36})\n(.+)\n?$/;
const PENDING_PAYLOAD = 'pending';
const INVITE_URL_RE = /^https:\/\/discord\.gg\/([A-Za-z0-9-]+)$/;

/**
 * The one line a confirmed revocation is allowed to leave behind, and the only
 * shape `--verify` will accept as one on a later run.
 *
 * TOG-2964 P2: the old matcher was `/^revoked\s+(\S+)\s+HTTP\s+(\d{3})\b/m` -
 * any three digits, anywhere in the file, multiline. So a hand-edited
 * `revoked invite-code HTTP 500 ...` certified a LIVE invite as already gone
 * and made zero DELETE requests. The receipt is evidence, so it has to be the
 * exact text this script writes: one payload line, a real invite code, and a
 * status that actually means gone (checked against INVITE_GONE_STATUSES below,
 * not by the pattern).
 */
const RECEIPT_RE = /^revoked ([A-Za-z0-9-]+) HTTP (\d{3}) at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;

interface MemberRoles {
  [memberId: string]: string[];
}

interface Baseline {
  guildId: string;
  takenAt: string;
  /**
   * Identifies this baseline run, and through it the invite that run created.
   * TOG-2971 P1: a receipt only speaks for the invite of the run that wrote it,
   * so the shortcut that skips the DELETE has to check which run that was.
   */
  demoRunId: string;
  /** Newest audit log entry id at baseline time; '0' when the log was empty. */
  auditCursor: string;
  members: MemberRoles;
}

/** The invite artifact, split into the run that owns it and its one payload line. */
function parseArtifact(contents: string): { runId: string; payload: string } | null {
  const m = ARTIFACT_RE.exec(contents);
  return m ? { runId: m[1], payload: m[2] } : null;
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
 * TOG-2964: where procfs is absent this used to fall back to the validated
 * pathname, which silently drops exactly the guarantee the fd was obtained for
 * - the checks would still pass, the artifacts would still be written, and
 * nothing in the output would say the race-free property had been given up.
 * A boundary that disappears without telling you is worse than one you never
 * had, so the absent-procfs case now fails closed. Both artifacts here hold
 * something sensitive (a bearer invite; the guild's whole member->role map),
 * and this script is Linux-only in practice - it drives a staging host.
 */
function pinnedInDir(dirFd: number, dir: string, name: string): string {
  let pinned = false;
  try {
    const held = fstatSync(dirFd);
    const seen = statSync(`/proc/self/fd/${dirFd}`);
    pinned = seen.ino === held.ino && seen.dev === held.dev;
  } catch {
    pinned = false;
  }
  if (!pinned) {
    throw new Error(
      `Cannot pin ${dir} through /proc/self/fd/${dirFd}, so ${name} would have to be reached by ` +
        'pathname and could be redirected between the check and the open. Refusing to write a ' +
        'bearer invite or the guild member map that way. Run this on a host with procfs mounted.',
    );
  }
  return `/proc/self/fd/${dirFd}/${name}`;
}

function openInDir(dirFd: number, dir: string, name: string, flags: number, mode?: number): number {
  const target = pinnedInDir(dirFd, dir, name);
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

/** The `pending` marker exactly as a claim writes it, for the run that owns it. */
function pendingMarker(demoRunId: string): string {
  return `run ${demoRunId}\n${PENDING_PAYLOAD}\n`;
}

/**
 * TOG-2999 P1: a baseline must not write over a handle that may name a live
 * invite.
 *
 * `INVITE_PATH` holds exactly one invite's handle, and the baseline used to
 * replace it unconditionally - so a second baseline in the same directory
 * destroyed the first run's URL before anything had revoked it. The next
 * `--verify` then found run B's handle, bound it to run B's snapshot, DELETEd
 * run B's code and exited 0 printing `revoked demo invite (HTTP 200)`: run A's
 * invite stayed live for its full `max_age` with nothing on disk naming it, and
 * the exit code an operator reads said clean.
 *
 * TOG-3027: the first fix for that read the file, refused on anything live, and
 * left the `pending` write where it already was - several round trips later,
 * after `preflightGuild()`, `newestAuditId()` and the paginated member walk.
 * That is check-then-act, and the reviewer reproduced the same orphan through
 * it: two baselines started together both read "no file", both proceeded, and
 * the second overwrote the first run's only handle. So the check and the claim
 * are one step now, and they happen before the first network call of the run.
 * `O_EXCL` is what makes it one step: exactly one of any number of concurrent
 * baselines creates the marker, and `EEXIST` is every other one's refusal.
 *
 * Only a terminal receipt - the one artifact state that says the invite it
 * names is gone - lets a new baseline take the name. Everything else, `pending`
 * and a present-but-unreadable file included, means an invite may be live,
 * which is a state to resolve rather than erase. Same reasoning as
 * `revokeInvite`: the states we know least about are the ones that must be loud.
 *
 * Returns null when this run holds the claim, or the operator-facing reason.
 */
function claimInviteHandle(demoRunId: string): string | null {
  const fix =
    'Run `node scripts/staging-session-demo.ts --verify` to revoke it (or delete the demo invite in the ' +
    `guild's invite list by hand and remove ${INVITE_PATH}), then baseline again.`;
  const marker = pendingMarker(demoRunId);
  const { dir, fd: dirFd } = openPrivateArtifactDir();
  try {
    const name = artifactNameInDir(INVITE_PATH, dir);
    /** Create-or-fail. True means this run owns the name from here on. */
    const stake = (): boolean => {
      let fd: number;
      try {
        fd = openInDir(
          dirFd,
          dir,
          name,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, marker);
      } finally {
        closeSync(fd);
      }
      return true;
    };

    if (stake()) return null;

    // Something already holds the name. Read it through the same directory fd
    // and judge it; only a terminal receipt frees the name.
    let contents: string;
    try {
      const fd = openInDir(dirFd, dir, name, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        contents = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // It existed for the create and was gone for the read, so another
        // baseline is live in this directory right now. Refuse rather than
        // retry: a loop here races the same window it is trying to close.
        return (
          `${INVITE_PATH} appeared and vanished while this baseline was claiming it, so another baseline ` +
          `is running against ${dir} at the same time. Run one at a time; wait for that one to finish, ` +
          `then baseline again.`
        );
      }
      return (
        `${INVITE_PATH} exists but could not be read (${err instanceof Error ? err.message : String(err)}), ` +
        `so it may name a demo invite that is still live. ${fix}`
      );
    }

    const artifact = parseArtifact(contents);
    if (!artifact) {
      return (
        `${INVITE_PATH} does not hold a recognisable invite handle, so it may name a demo invite that is ` +
        `still live and this baseline would overwrite it. ${fix}`
      );
    }
    const receipt = RECEIPT_RE.exec(artifact.payload);
    if (receipt && INVITE_GONE_STATUSES.has(Number(receipt[2]))) {
      // The invite this names is gone, so the name is free - but taking it is
      // still a create-or-fail, so that two baselines reading the same receipt
      // do not both proceed. Whoever unlinks first loses nothing; whoever
      // creates first wins, and the other gets EEXIST and refuses below.
      try {
        unlinkSync(pinnedInDir(dirFd, dir, name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (stake()) return null;
      return (
        `${INVITE_PATH} held a spent revocation receipt from baseline run ${artifact.runId}, but another ` +
        `baseline claimed it first. Run one at a time; wait for that one to finish, then baseline again.`
      );
    }
    if (artifact.payload === PENDING_PAYLOAD) {
      return (
        `${INVITE_PATH} was staged by baseline run ${artifact.runId} and never recorded an invite code, so ` +
        `that run may have created an invite that is still live with no handle to revoke it by. ${fix}`
      );
    }
    return (
      `${INVITE_PATH} still holds the invite handle for baseline run ${artifact.runId}, so that run's invite ` +
      `may still be live and a new baseline would overwrite the only record of it. ${fix}`
    );
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Give the claim back, but only when this run is certain no invite of its own
 * can exist - i.e. it failed before the create POST was ever put on the wire.
 *
 * The claim now happens before `preflightGuild()`, so without this a bad token
 * or a lost permission would leave a `pending` marker behind and wedge every
 * later baseline in that directory over an invite that was never created. After
 * the POST is attempted this must not run: a request that timed out or returned
 * an unexpected shape may still have created a live invite, and `pending` is
 * exactly the loud state that case needs.
 *
 * Only ever removes the marker this run wrote, byte for byte. If the file holds
 * anything else, someone else's handle is in it and it is not ours to delete.
 */
function releaseUnusedClaim(demoRunId: string): void {
  const marker = pendingMarker(demoRunId);
  const { dir, fd: dirFd } = openPrivateArtifactDir();
  try {
    const name = artifactNameInDir(INVITE_PATH, dir);
    let contents: string;
    try {
      const fd = openInDir(dirFd, dir, name, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        contents = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      // Already gone, or unreadable. Either way there is nothing this run is
      // entitled to remove.
      return;
    }
    if (contents !== marker) return;
    unlinkSync(pinnedInDir(dirFd, dir, name));
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
      // TOG-2971 P2 / TOG-2972 P2: this used to say the claim "cannot be proven
      // without it", which implies the log could prove it given the chance. It
      // cannot - that is the whole retraction above. The reason to fail here is
      // narrower and true: a falsifier that cannot read its evidence has not run.
      throw new Error(
        `Could not read the audit log for guild ${guildId}: HTTP ${page.status}. ` +
          'This check is a falsifier and it could not read its evidence, so it has not run; ' +
          'a check that has not run must not report a pass.',
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
   * One full scan of everything recorded after `cursor`, returning the role
   * writes it found.
   *
   * This is a falsifier, not a boundary: it reports what the log had published
   * at the moment it was read. An entry that publishes later is not in it, and
   * no amount of re-reading changes that (see the header, revisions 5 and 6) -
   * which is why the caller reports "observed" and never "proven".
   */
  async function auditSince(cursor: string): Promise<string[]> {
    const roleWrites = new Map<string, string>();
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
    return [...roleWrites.values()].sort();
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
   * TOG-2971 P1: the receipt shortcut is the one path that skips the DELETE, so
   * it is the one path that has to know WHICH invite it is talking about. It
   * used to accept any well-formed receipt with a terminal status - so a
   * receipt left by an older demo run, or one hand-written naming a code that
   * was never ours, certified this run's invite as gone and sent nothing. The
   * reviewer reproduced it with a canonical `revoked foreign-code HTTP 200`.
   * The shortcut now requires the artifact's `run` header to match the current
   * baseline's `demoRunId`; anything else is unconfirmed. Attempting a DELETE
   * is always safe, so an unbound artifact that still carries a code is retried
   * anyway - it just cannot report success for an invite it cannot identify.
   *
   * `baselineRunId` is null when the baseline is unreadable, which is exactly
   * when nothing can be bound and nothing may be believed.
   *
   * Never throws: it runs on the failure path, where it must not mask the
   * proof's own error.
   */
  async function revokeInvite(baselineRunId: string | null): Promise<{ ok: boolean; message: string }> {
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

    const artifact = parseArtifact(contents);
    if (!artifact) {
      return {
        ok: false,
        message:
          `${INVITE_PATH} does not hold a usable invite handle or a revocation receipt, so revocation is ` +
          'unconfirmed. Check the guild\'s invite list in Discord and delete any demo invite by hand.',
      };
    }
    /** Does this artifact describe the invite the CURRENT baseline run created? */
    const bound = baselineRunId !== null && artifact.runId === baselineRunId;

    // The baseline stages this marker before it asks Discord for an invite, so
    // seeing it means the POST may have succeeded while the write of its code
    // did not. That is the one case where a live invite exists and its code was
    // never recorded anywhere - it has to be loud, not silent.
    if (artifact.payload === PENDING_PAYLOAD) {
      return {
        ok: false,
        message:
          `${INVITE_PATH} was staged by baseline run ${artifact.runId} but never recorded an invite code, ` +
          'so an invite that run created may be live with no handle to revoke it by. Check the guild\'s ' +
          'invite list in Discord and delete any demo invite by hand, then re-baseline before walking again.',
      };
    }

    // A confirmed revocation leaves a receipt rather than removing the file, so
    // that a second --verify can tell "already revoked, and here is the status
    // Discord actually returned" apart from "the handle is missing".
    //
    // TOG-2964 P2: the receipt must be the exact line this script writes AND
    // carry a status that means gone. TOG-2971 P1: it must ALSO belong to this
    // baseline's run, or it is a statement about some other invite.
    const receipt = RECEIPT_RE.exec(artifact.payload);
    if (receipt && INVITE_GONE_STATUSES.has(Number(receipt[2]))) {
      if (bound) {
        return {
          ok: true,
          message: `demo invite already revoked (HTTP ${receipt[2]}); receipt in ${INVITE_PATH}`,
        };
      }
      return {
        ok: false,
        message:
          `${INVITE_PATH} holds a revocation receipt for baseline run ${artifact.runId}, but this walk's ` +
          `baseline is ${baselineRunId ?? 'unreadable'}. That receipt says nothing about the invite this ` +
          'baseline created, so revocation is unconfirmed: check the guild\'s invite list in Discord and ' +
          'delete any demo invite by hand, then re-baseline before walking again.',
      };
    }
    // A receipt-shaped line whose status does not mean gone is not a receipt at
    // all - it is a record of a revocation that FAILED, and the code in it is
    // still live. So take the code from it and try the DELETE again rather than
    // trusting it or merely refusing.
    const code = receipt?.[1] ?? INVITE_URL_RE.exec(artifact.payload)?.[1] ?? '';
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
    // and the file that remains is evidence rather than a secret. The receipt
    // keeps the artifact's own run header: it is evidence about the invite that
    // run created, and re-stamping it with a different run would manufacture
    // exactly the binding this check exists to test.
    try {
      writePrivate(
        INVITE_PATH,
        `run ${artifact.runId}\nrevoked ${code} HTTP ${status} at ${new Date().toISOString()}\n`,
      );
    } catch (err) {
      return {
        ok: false,
        message:
          `The demo invite was revoked (HTTP ${status}) but the receipt could not be written to ${INVITE_PATH}: ` +
          `${err instanceof Error ? err.message : String(err)}. Remove that file by hand.`,
      };
    }
    // A DELETE that succeeded against a code we cannot tie to this baseline did
    // remove *something*, and saying so is useful - but it is not confirmation
    // that this walk's invite is gone, so it must not exit 0 as if it were.
    if (!bound) {
      return {
        ok: false,
        message:
          `Revoked invite ${code} (HTTP ${status}) from ${INVITE_PATH}, but that handle belongs to baseline ` +
          `run ${artifact.runId} and this walk's baseline is ${baselineRunId ?? 'unreadable'}. An invite ` +
          'created by the current baseline may still be live: check the guild\'s invite list in Discord, ' +
          'then re-baseline before walking again.',
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
      if (
        baseline.guildId !== guildId ||
        typeof baseline.auditCursor !== 'string' ||
        typeof baseline.demoRunId !== 'string' ||
        !baseline.demoRunId ||
        !baseline.members
      ) {
        throw new Error(
          `Baseline at ${SNAPSHOT_PATH} is for guild ${baseline.guildId ?? 'unknown'} or predates the current ` +
            `artifact format; it cannot cover this walk. Re-baseline against ${guildId} and walk again.`,
        );
      }

      // (b) Net state first, so every audit read below is strictly after it and
      // no write can slip through the gap between the two checks.
      const deltas = roleDeltas(baseline.members, await memberRoles());
      // (a) The audit log: the only check that can see a member who has left.
      const readAt = new Date().toISOString();
      const writes = await auditSince(baseline.auditCursor);

      console.log('--- role writes since baseline (audit log) ---');
      if (writes.length) {
        throw new Error(`The guild audit log records role writes during this window:\n${writes.join('\n')}`);
      }
      console.log(
        `NONE OBSERVED across ${ROLE_AUDIT_ACTIONS.map((a) => a.name).join(', ')} since entry ` +
          `${baseline.auditCursor}, in the log as published at ${readAt}`,
      );

      console.log('--- member role delta since baseline ---');
      if (deltas.length) {
        throw new Error(`Member roles changed:\n${deltas.join('\n')}`);
      }
      console.log(`IDENTICAL - zero role delta across ${Object.keys(baseline.members).length} members`);

      // The grading line. It exists because five revisions of this script in a
      // row printed a clean audit scan and let a reader take it for proof of
      // absence, and twice a reviewer built a sequence that published just
      // after the final read and sailed through. Neither check below can
      // establish absence, so neither is allowed to be reported as if it did.
      console.log('--- what this does and does not establish ---');
      console.log(
        'OBSERVED, NOT PROVEN: both checks above are falsifiers. Discord documents audit entry ' +
          'ordering but no publication-completeness guarantee, so an entry published after the read ' +
          'above is in neither result, and a member who joined and left inside the window is in no ' +
          'snapshot. A clean run here is consistent with zero role writes; it does not demonstrate them.',
      );
      console.log(
        'The zero-role-write guarantee is in the code, not in this run: session mode registers only ' +
          'the roleless welcome (src/index.ts:717-759), drops role.assign and leveling role writes ' +
          '(src/onboarding/mode.ts, wired at src/index.ts:813 and :426), and refuses to boot beside ' +
          'self-role panels or armed containment (src/index.ts:145-149, :158-163). The two helpers are ' +
          'asserted by test/unit.onboardingmode.test.ts and the wiring, the boot guards and a full ' +
          'zero-role-write walk by test/e2e.session.test.ts.',
      );
      console.log(
        'This run does not identify which build the staging bot is serving - it reads a guild, not a ' +
          'deployment - so it can contradict that claim but never add to it.',
      );
    } catch (err) {
      proofError = err;
    }

    // Always, whatever the proof did: a failed verification is exactly when a
    // live bearer invite is most likely to be forgotten.
    //
    // The run id is re-read here rather than taken from the block above, and
    // read in a way that cannot throw, because revocation has to run even when
    // the baseline is unreadable (TOG-2950). An unreadable baseline yields null,
    // which binds nothing - that is the honest answer, not a reason to skip the
    // DELETE.
    let baselineRunId: string | null = null;
    try {
      const parsed = JSON.parse(readPrivate(SNAPSHOT_PATH)) as Partial<Baseline>;
      if (typeof parsed.demoRunId === 'string' && parsed.demoRunId) baselineRunId = parsed.demoRunId;
    } catch {
      baselineRunId = null;
    }
    const revocation = await revokeInvite(baselineRunId);
    console.log('--- invite ---');
    console.log(revocation.message);
    if (proofError) {
      if (!revocation.ok) console.error(revocation.message);
      throw proofError;
    }
    if (!revocation.ok) throw new Error(revocation.message);
    return;
  }

  // TOG-2971 P1 / TOG-3027: claim the invite handle BEFORE the first network
  // call of this run, in one atomic step that both checks the name and stakes
  // it. The handle on disk is the only record of the previous run's invite, and
  // everything below is about to replace it; staging the marker is also what
  // stops a receipt from an earlier run outliving the invite it was about,
  // because a POST that succeeds and a handle write that then fails now lands
  // on `pending`, which fails closed and says so. See claimInviteHandle.
  const demoRunId = randomUUID();
  const staleInvite = claimInviteHandle(demoRunId);
  if (staleInvite) throw new Error(staleInvite);

  // The claim is this run's to give back only while no invite of ours can
  // exist. Set before the await, not after: a create request that throws or
  // times out may still have reached Discord.
  let invitePostAttempted = false;
  try {
    await preflightGuild();

    const baseline: Baseline = {
      guildId,
      takenAt: new Date().toISOString(),
      demoRunId,
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
    invitePostAttempted = true;
    const invite = await api<{ code: string }>('POST', `/channels/${EXPECTED_CHANNEL.id}/invites`, {
      max_age: 3600,
      max_uses: 1,
      unique: true,
    });
    if (invite.status !== 200 || !invite.body?.code) {
      // TOG-2999 P3: the body is not printed. This branch is reached by a 200
      // whose shape we did not expect as well as by an error status, and a create
      // response carries the invite code - so dumping it would put the bearer
      // credential into the transcript everything else here works to keep it out
      // of. The status is what an operator acts on.
      throw new Error(
        `Failed to create demo invite: HTTP ${invite.status}. The response body is not printed because a ` +
          "create response can carry the invite code; check the bot's permissions on the channel.",
      );
    }
    // The invite is a bearer credential: anyone holding the URL can join the
    // guild until it expires. Operator and CI transcripts are retained, so it
    // goes to an owner-only file and only the path is printed.
    writePrivate(INVITE_PATH, `run ${demoRunId}\nhttps://discord.gg/${invite.body.code}\n`);
  } catch (err) {
    if (!invitePostAttempted) {
      try {
        releaseUnusedClaim(demoRunId);
      } catch (releaseErr) {
        // Never let the cleanup bury the reason the run failed; say both.
        console.error(
          `Could not release this run's claim on ${INVITE_PATH}: ` +
            `${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}. ` +
            'Remove it by hand before the next baseline.',
        );
      }
    }
    throw err;
  }
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
