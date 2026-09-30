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
import { DiscordRest, fetchAllMembers, type RawInvite } from '../src/discord/rest.ts';

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
const grew = [...growth.keys()].sort();
const totalGrowth = [...growth.values()].reduce((a, b) => a + b, 0);

// --- 3. who is new in this window? ------------------------------------------

const members = await fetchAllMembers(rest, guildId);
if (members.length === 0) {
  console.error(
    'Read zero members. That is Server Members Intent being OFF - the REST\n' +
      'member list needs it too, not just the gateway. Run scripts/preflight.ts.',
  );
  process.exit(1);
}

const guild = await rest.get<{ vanity_url_code?: string | null }>(`/guilds/${guildId}`);
const hasVanity = !!guild?.vanity_url_code;

const newJoins: { id: string; joinedAt: string }[] = [];
let bots = 0;
for (const m of members) {
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
  if (since !== null && joinedAt > since) newJoins.push({ id, joinedAt });
}
newJoins.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));

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
    window: { from: since, to: capturedAt },
  },
}));

let written = 0;
if (!dryRun) {
  for (const e of events) {
    // A captured join is live current-member evidence, not a historical log
    // import: the member is on the roster NOW, so this observation outranks a
    // delayed removal stamped earlier. Occurrence stays Discord's joined_at;
    // only presence order uses the capture instant. Backfill member-list
    // joins stay observation-free on purpose - they are history, not presence.
    const res = await store.record(e, { membershipObservedAt: capturedAt });
    if (res.inserted) written++;
  }
  // Store the new counters last, so a crash mid-write re-reads the same window
  // next run instead of losing it.
  await tracker.diffAndStore(guildId, current);
  await db
    .prepare(`UPDATE invite_snapshots SET updated_at = ? WHERE guild_id = ?`)
    .run(capturedAt, guildId);
}

// --- 5. report ---------------------------------------------------------------

const label =
  since === null
    ? 'first capture - baseline only'
    : `window ${since} -> ${capturedAt}`;

console.log(`  ${label}`);
console.log(`  invites              ${current.length} readable, ${grew.length} moved` +
  (grew.length ? ` (${grew.map((c) => `${c} +${growth.get(c)}`).join(', ')})` : ''));
console.log(`  members              ${members.length} total (${bots} bots)`);
console.log(`  new joins in window  ${newJoins.length}`);
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
if (since !== null && totalGrowth !== newJoins.length) {
  console.log(
    `\n  note: invite counters moved ${totalGrowth}, member list gained ${newJoins.length}.` +
      `\n        Likely a join+leave inside the window, or a join through the vanity URL.` +
      `\n        Neither is recoverable later - shorter windows are the only lever.`,
  );
}

console.log(`\n  ${rest.requests} Discord requests. Nothing was posted, no roles changed.\n`);

await db.close();
