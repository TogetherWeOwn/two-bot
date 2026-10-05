/**
 * Host-less join capture. Runs, writes, exits - no always-on machine needed.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node scripts/capture.ts
 *   node scripts/capture.ts --dry-run     # report, write nothing
 *
 * Why this exists
 * ---------------
 * We do not have a host yet (TWO-11). The usual story is "every day without
 * the bot is a day of join data lost forever". That is only half true, and
 * this script exists to shrink the half that is true.
 *
 *   * WHO joined and WHEN is never lost. Discord stamps `joined_at` on every
 *     current member, so scripts/backfill.ts can rebuild the join curve at any
 *     point later.
 *   * WHICH INVITE they came through IS lost, permanently, unless somebody
 *     was watching. Discord keeps no per-member invite record. All you ever
 *     get is a per-code cumulative `uses` counter that you have to difference
 *     yourself.
 *
 * So attribution does not actually require an always-on bot. It requires that
 * *somebody reads the invite counters more often than people join*. At TWO's
 * current inflow - roughly a join every few days - a capture run every few
 * hours attributes nearly everything, because in almost every window exactly
 * one code moves and there is no ambiguity to resolve.
 *
 * That is the whole trick. This is the live bot's invite logic, sampled coarse
 * instead of continuously, and it runs from anywhere with the token.
 *
 * What this still cannot see, stated plainly:
 *   * Somebody who joins AND leaves inside one window is invisible to both
 *     this and the member list. Shorter windows shrink that hole; nothing
 *     closes it but a connected bot.
 *   * If two or more codes move in the same window we do NOT lose the window.
 *     When the counters and the member list agree on how many people arrived,
 *     the split is fully determined in aggregate - code A gained 2, code B
 *     gained 1, so A produced 2 joins and B produced 1 - and that is what gets
 *     recorded. Which member came through which is not observable, so those
 *     events carry `attribution_exact: false`: quote the per-code join counts,
 *     never a per-member rate off them. Only when the arithmetic does NOT close
 *     (a join+leave inside the window, or a vanity join) do we fall back to
 *     `ambiguous:a+b`. Honest beats tidy, but exact beats both.
 *   * first_message / first_voice still need the gateway. Not attempted here.
 *
 * Read-only against Discord: no messages, no roles, nothing posted. Safe to
 * re-run - every write is idempotent on (member, joined_at), and because that
 * key does not include the source, the FIRST attribution wins. That is the
 * behaviour we want: a re-run over an already-recorded window sees counters
 * that have stopped moving and would otherwise downgrade a good `invite:CODE`
 * to `unknown`.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { InviteTracker, inviteGrowth, attributeJoins } from '../src/core/inviteTracker.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import { DiscordRest, fetchAllMembersObserved, type RawInvite } from '../src/discord/rest.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/capture.ts [--dry-run]');
  process.exit(0);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();

const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID. See docs/SECRETS.md.');
  process.exit(2);
}
if (!databaseUrl) {
  console.error('Missing TWO_DATABASE_URL. See docs/SECRETS.md.');
  process.exit(2);
}

/**
 * Stamp the window BEFORE we read anything. A join that lands between this
 * instant and the fetch below would otherwise fall in the crack between two
 * windows; this way it simply lands in the next one. Double-counting is not a
 * risk - member_join is keyed on (guild, member, joined_at).
 *
 * This is the WINDOW watermark only (snapshot updated_at, window label). It is
 * NOT presence evidence: stamping a captured join with it would predate the
 * roster read below, so a removal and rejoin that both land mid-window would
 * lose to the removal. Presence gets its own stamp after the roster read.
 */
const capturedAt = new Date().toISOString();

/**
 * Test seam: point the invite/member reads at a loopback stub. Loopback-only,
 * so a live bot token can never be sent to an arbitrary host. Production never
 * sets this. Used by test/e2e.capture.test.ts for the offline REST regression.
 */
function apiBase(): string | undefined {
  const raw = process.env.DISCORD_API_BASE?.trim();
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    console.error(`DISCORD_API_BASE is not a URL: ${raw}`);
    process.exit(2);
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.error(`DISCORD_API_BASE is a test seam and only accepts loopback. Got host ${host}.`);
    process.exit(2);
  }
  return raw;
}

const api = apiBase();
const rest = new DiscordRest(api ? { token, base: api, minIntervalMs: 0 } : { token });
const db = await openDb(databaseUrl);
const store = new EventStore(db);
const tracker = new InviteTracker(db);

console.log(`\nTWO capture${dryRun ? '  (DRY RUN - nothing will be written)' : ''}`);
console.log(`  guild ${guildId}\n`);

// --- 1. where does the previous window end? ---------------------------------
//
// The invite snapshot's own timestamp IS the last capture. No extra bookkeeping
// table, and it cannot drift out of step with the counters it describes.

const prevRows = await db
  .prepare(`SELECT code, uses, updated_at FROM invite_snapshots WHERE guild_id = ?`)
  .all<{ code: string; uses: number; updated_at: string }>(guildId);

const since = prevRows.reduce<string | null>(
  (max, r) => (max === null || r.updated_at > max ? r.updated_at : max),
  null,
);
const prevUses = new Map(prevRows.map((r) => [r.code, Number(r.uses)]));
const pendingJoins = await db
  .prepare(`SELECT member_id AS id, joined_at AS "joinedAt" FROM capture_pending_joins WHERE guild_id = ?`)
  .all<{ id: string; joinedAt: string }>(guildId);

// Capture-owned processing evidence. `invite_snapshots.updated_at` is written
// by three independent writers (live bot on ready, backfill, this tracker's
// own diffAndStore), none of which drains pending joins — so it cannot prove
// the saved observations were recorded. The retained table below holds the
// invite read the retaining run already observed; reconciliation needs the
// baseline, the retained read, and the fresh read together. Missing-table
// reads mean a pre-0043 database with no retained rows, not a failure.
interface RetainedGrowthRow {
  code: string; uses: number; inviterId: string | null; channelId: string | null; observedAt: string;
}
const retainedGrowth: RetainedGrowthRow[] = [];
try {
  retainedGrowth.push(...await db
    .prepare(`SELECT code, uses, inviter_id AS "inviterId", channel_id AS "channelId", observed_at AS "observedAt" FROM capture_retained_growth WHERE guild_id = ?`)
    .all<RetainedGrowthRow>(guildId));
} catch (err) {
  if (!(err instanceof Error) || !/capture_retained_growth/.test(err.message)) throw err;
}
// A previous run may have retained its window (pending joins plus the invite
// growth it already observed) and then lost its baseline: another snapshot
// writer advances invite_snapshots.updated_at, or the snapshot rows were never
// there. A null baseline falls back to the oldest retained read, which is the
// window those joins were actually observed in.
const oldestRetainedAt = retainedGrowth.reduce<string | null>(
  (min, r) => (min === null || r.observedAt < min ? r.observedAt : min),
  null,
);
const effectiveSince = since ?? oldestRetainedAt;

// --- 2. read the invite counters --------------------------------------------

const rawInvites = await rest.get<RawInvite[]>(`/guilds/${guildId}/invites`);
if (!rawInvites) {
  console.error(
    'Could not read the invite list. That is the Manage Server permission -\n' +
      'without it every join records as `unknown`. Run scripts/preflight.ts.',
  );
  process.exit(1);
}

const current = rawInvites.map((i) => ({
  code: i.code,
  uses: Number(i.uses ?? 0),
  inviterId: i.inviter?.id ?? null,
  channelId: i.channel?.id ?? null,
}));

const growth = inviteGrowth(prevUses, current);
// Reconcile with the retained read: per-code growth is the max of the
// baseline-derived delta and the already-observed retained delta, taking the
// larger surviving sample per code. When both see the same code the deltas
// match and nothing double-counts; when a code vanished before retry, the
// retained delta survives and attribution cannot collapse to a false exact
// single-code distribution.
for (const r of retainedGrowth) {
  const base = prevUses.get(r.code);
  const retainedDelta = base === undefined ? r.uses : r.uses - base;
  const seen = growth.get(r.code) ?? 0;
  if (retainedDelta > seen) growth.set(r.code, retainedDelta);
}
const grew = [...growth.keys()].sort();
const totalGrowth = [...growth.values()].reduce((a, b) => a + b, 0);

// --- 3. who is new in this window? ------------------------------------------

// Per-page request bounds: scan/body completion does not prove presence at
// completion. A member may leave while a page streams. The conservative
// request-start bound keeps that departure; a newer joined_at in the response
// still proves a genuine rejoin during the request. `capturedAt` is only the
// invite-window watermark, not membership observation evidence.
const observed = await fetchAllMembersObserved(rest, guildId);
if (!observed || observed.length === 0) {
  console.error(
    'Read zero members. That is Server Members Intent being OFF - the REST\n' +
      'member list needs it too, not just the gateway. Run scripts/preflight.ts.',
  );
  process.exit(1);
}
const members = observed.map((o) => o.member);

const guild = await rest.get<{ vanity_url_code?: string | null }>(`/guilds/${guildId}`);
const hasVanity = !!guild?.vanity_url_code;

const candidates = new Map<string, { id: string; joinedAt: string; observedAt: string }>();
// Pending rows are replayed by identity, never by the shared watermark. The
// snapshot timestamp is written by three independent writers (live bot on
// ready, backfill, this tracker's own diffAndStore), none of which drains
// pending joins — so a row at or before the live baseline is NOT proof it was
// recorded, and gating replay on `since` silently discards saved unrecorded
// joins after an unrelated watermark advance. Replaying everything is safe:
// store.record() is first-wins on (member, joined_at), so an already-recorded
// row re-emits without duplicating storage, and the handled-only clear below
// removes exactly the rows this run proved recorded. Anything still pending
// stays for the next run.
for (const j of pendingJoins) {
  candidates.set(JSON.stringify([j.id, j.joinedAt]), { id: j.id, joinedAt: j.joinedAt, observedAt: j.joinedAt });
}
let bots = 0;
for (const { member: m, observedAt } of observed) {
  const id = m.user?.id;
  if (!id || !m.joined_at) continue;
  if (m.user?.bot) {
    bots++;
    if (!dryRun) await store.markBot(guildId, id);
    continue;
  }
  const joinedAt = new Date(m.joined_at).toISOString();
  // First ever capture has no `since`; the member list is history, not this
  // window, and backfill.ts owns history. Baseline only, emit nothing.
  // A retained window with no live baseline still replays its own window.
  if (effectiveSince !== null && joinedAt > effectiveSince) {
    candidates.set(JSON.stringify([id, joinedAt]), { id, joinedAt, observedAt: joinedAt > observedAt ? joinedAt : observedAt });
  }
}
// Keep the window (since, capturedAt]: observations after the stamp remain
// pending, even if the member leaves before the next roster read.
const observedJoins = [...candidates.values()].sort((a, b) =>
  a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id));
const newJoins = observedJoins.filter((j) => j.joinedAt <= capturedAt);
const deferredJoins = observedJoins.length - newJoins.length;

// --- 4. attribute ------------------------------------------------------------
//
// One code moved -> that is the code, for everyone in the window.
// Several moved and the counters agree with the member list -> hand each code
//   as many joins as it gained. Per-code counts are exact; who got which is
//   not, and every such event carries attribution_exact: false to say so.
// Several moved and they DISAGREE -> `ambiguous:a+b`. Honest beats tidy.
// Nothing moved -> vanity URL or Discovery, which leave no counter behind.
//
// The per-join decision lives in attributeJoins() (src/core/inviteTracker.ts)
// so it can be unit tested against inviteGrowth() output with no Discord and
// no database.

const attributions = attributeJoins(growth, newJoins.length, hasVanity);

// The attribution window is the window the joins were actually observed in:
// normally the live baseline, but a retained replay after a lost baseline
// attributes the retained window rather than an unknowable one.
const windowFrom = effectiveSince;

const events: FunnelEvent[] = newJoins.map((j, i) => ({
  memberId: j.id,
  guildId,
  eventType: 'member_join',
  occurredAt: j.joinedAt,
  source: attributions[i].source,
  metadata: {
    capture: true,
    // Read by scripts/attribution.ts. False means the per-code JOIN COUNT is
    // still right but this member's own code is a placement, not an
    // observation - so per-member rates on that row are soft.
    attribution_exact: attributions[i].exact,
    window: { from: windowFrom, to: capturedAt },
  },
}));

// A post-stamp join may already be reflected in the invite read. Keep both
// counters AND their window end until it is eligible, rather than consuming
// that evidence now. Defer attribution too: splitting this growth over an
// incomplete roster could lock in worse first-wins attribution. Persist the
// observations separately so departures before retry cannot erase them.
// The observed invite read is persisted alongside the observations, so a
// deleted/expired/reset code cannot erase already-seen growth before retry.
// First capture still establishes a baseline, and no-growth reads lose no delta.
const retainSnapshot = effectiveSince !== null && deferredJoins > 0 && totalGrowth > 0;

// Even without growth, a deferred observation must survive departure before
// retry. The handled-only clear below removes eligible rows, not post-stamp ones.
if (!dryRun && deferredJoins > 0) {
  for (const j of observedJoins) {
    await db.prepare(
      `INSERT INTO capture_pending_joins (guild_id, member_id, joined_at)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).run(guildId, j.id, j.joinedAt);
  }
}
if (!dryRun && retainSnapshot) {
  try {
    for (const inv of current) {
      await db.prepare(
        `INSERT INTO capture_retained_growth (guild_id, code, uses, inviter_id, channel_id, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, code) DO UPDATE SET
           uses = excluded.uses, inviter_id = excluded.inviter_id,
           channel_id = excluded.channel_id, observed_at = excluded.observed_at`,
      ).run(guildId, inv.code, inv.uses, inv.inviterId, inv.channelId, capturedAt);
    }
  } catch (err) {
    // Pre-0043 database: no retained-growth table. The pending observations
    // above are still saved; only the growth-reconciliation evidence is lost,
    // which is exactly the pre-0043 behaviour.
    if (!(err instanceof Error) || !/capture_retained_growth/.test(err.message)) throw err;
  }
}

let written = 0;
if (!dryRun && !retainSnapshot) {
  const handledKeys = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // Request-start evidence beats older removals, never departures while the
    // response streams. If joined_at is newer than the request, it proves a
    // new spell after that bound and must not be ordered before its own join.
    // Occurrence remains Discord's joined_at. Backfill joins stay historical.
    const res = await store.record(e, { membershipObservedAt: newJoins[i].observedAt });
    if (res.inserted) written++;
    // First-wins idempotency means an already-recorded join is handled too:
    // its event exists, so the saved observation must not linger for a later
    // run to re-emit or to be dropped by an unrelated snapshot advance.
    handledKeys.add(JSON.stringify([e.memberId, e.occurredAt]));
  }
  // Store the new counters last, so a crash mid-write re-reads the same window
  // next run instead of losing it.
  await tracker.diffAndStore(guildId, current);
  await db
    .prepare(`UPDATE invite_snapshots SET updated_at = ? WHERE guild_id = ?`)
    .run(capturedAt, guildId);
  // Clear only observations proven recorded (this run wrote or found their
  // events). The shared snapshot watermark may have advanced independently
  // (live bot on ready, backfill) without consuming anything, so a
  // timestamp-based clear would silently discard saved unrecorded joins.
  // Anything still pending stays for the next run to replay by identity.
  if (handledKeys.size > 0) {
    const pairs = [...handledKeys].map((k) => JSON.parse(k) as [string, string]);
    const conds = pairs.map(() => `(member_id = ? AND joined_at = ?)`).join(' OR ');
    const params: string[] = [];
    for (const [id, at] of pairs) params.push(id, at);
    await db.prepare(
      `DELETE FROM capture_pending_joins WHERE guild_id = ? AND (${conds})`,
    ).run(guildId, ...params);
  }
  // The window this run just recorded supersedes any retained read: drop it so
  // a later retain starts from fresh evidence rather than stale counters.
  // A retained window whose baseline met a zero-growth live read is also done:
  // the growth it waited on never materialized in the fresh counters.
  // Missing-table failures are pre-0043 databases with nothing to clear.
  if (retainedGrowth.length > 0 && (newJoins.length > 0 || totalGrowth === 0)) {
    try {
      await db.prepare(`DELETE FROM capture_retained_growth WHERE guild_id = ?`).run(guildId);
    } catch (err) {
      if (!(err instanceof Error) || !/capture_retained_growth/.test(err.message)) throw err;
    }
  }
}

// --- 5. report ---------------------------------------------------------------

const label =
  windowFrom === null
    ? (newJoins.length ? 'replayed pending joins without a live baseline' : 'first capture - baseline only')
    : `window ${windowFrom} -> ${capturedAt}`;

console.log(`  ${label}`);
console.log(`  invites              ${current.length} readable, ${grew.length} moved` +
  (grew.length ? ` (${grew.map((c) => `${c} +${growth.get(c)}`).join(', ')})` : ''));
console.log(`  members              ${members.length} total (${bots} bots)`);
console.log(`  new joins in window  ${newJoins.length}`);
if (retainSnapshot) {
  console.log(`  ${dryRun ? 'would retain' : 'retaining'} previous counters and window: ` +
    `${deferredJoins} post-stamp join(s) may already be in the invite growth; ` +
    `${observedJoins.length} observation(s) ${dryRun ? 'would be saved' : 'saved'} pending attribution.`);
}
if (newJoins.length) {
  // One line per source, not one line per join: the operator wants to see the
  // split the campaign will be read off.
  const bySource = new Map<string, { n: number; exact: number }>();
  for (const a of attributions) {
    const e = bySource.get(a.source) ?? { n: 0, exact: 0 };
    e.n++;
    if (a.exact) e.exact++;
    bySource.set(a.source, e);
  }
  const split = [...bySource.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([s, e]) => `${s} x${e.n}${e.exact === e.n ? '' : ' (~ who-got-which not observed)'}`);
  console.log(`  attributed as        ${split.join('\n                       ')}`);
  console.log(`  written              ${dryRun ? '0 (dry run)' : written} new events`);
}

/**
 * A mismatch between counter growth and new members is not a bug and is worth
 * printing every time: the usual cause is somebody who joined and left again
 * inside the window, which is exactly the blind spot this script cannot fix.
 */
if (windowFrom !== null && totalGrowth !== newJoins.length && !retainSnapshot) {
  console.log(
    `\n  note: invite counters moved ${totalGrowth}, member list gained ${newJoins.length}.` +
      `\n        Likely a join+leave inside the window, or a join through the vanity URL.` +
      `\n        Neither is recoverable later - shorter windows are the only lever.`,
  );
}

console.log(`\n  ${rest.requests} Discord requests. Nothing was posted, no roles changed.\n`);

await db.close();
