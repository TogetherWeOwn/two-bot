/**
 * One-shot historical backfill. Runs, writes, exits - no always-on host.
 *
 *   DISCORD_TOKEN=... DISCORD_GUILD_ID=... TWO_DATABASE_URL=postgres://... node scripts/backfill.ts
 *   node scripts/backfill.ts --dry-run          # report, write nothing
 *   node scripts/backfill.ts --max-pages=50     # scan deeper per channel
 *
 * Why this exists
 * ---------------
 * The live bot can only see what happens while it is connected; Discord does
 * not replay joins. That made "the bot is not deployed yet" look like it cost
 * us the history permanently. It does not:
 *
 *   1. Discord stamps `joined_at` on every CURRENT member. One request per
 *      1000 members gives us the real join curve for the whole server.
 *   2. TWO has run logging bots for years, and they wrote joins, leaves and
 *      voice sessions into ordinary channels that are still readable. That is
 *      the only record of members who joined and then LEFT - they are gone
 *      from the member list, and omitting them would flatter every retention
 *      number we print.
 *
 *   3. Discord's member list also carries `pending`, the membership-screening
 *      flag, so the rules gate can be reconstructed as a binary for every
 *      current member (TOG-76).
 *
 * What is genuinely NOT recoverable, and so is not attempted here: which
 * invite a past join came from (Discord keeps no per-member invite record),
 * first-message timing, and WHEN a past member cleared the rules gate -
 * Discord reports `pending` present-tense and keeps no history of the flip.
 * Those need the bot online.
 *
 * Read-only against Discord. Safe to re-run: every write is idempotent.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { setLogLevel } from '../src/core/log.ts';
import type { FunnelEvent } from '../src/core/events.ts';
import {
  DiscordRest,
  fetchAllMembers,
  scanChannel,
  type RawChannel,
  type RawInvite,
} from '../src/discord/rest.ts';
import { collapseCrossSourceDuplicates } from '../src/backfill/dedupe.ts';
import {
  memberLogKindForChannel,
  parseMemberLogMessage,
  parseVoiceMessage,
} from '../src/backfill/parse.ts';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/backfill.ts [--dry-run] [--max-pages=<count>]');
  process.exit(0);
}

// --- args ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
};
const dryRun = flag('dry-run') !== null;
const maxPages = Number(flag('max-pages') ?? 25);
if (flag('db') !== null) {
  console.error('The --db option has been removed. Set TWO_DATABASE_URL instead.');
  process.exit(2);
}
const databaseUrl = process.env.TWO_DATABASE_URL?.trim();

setLogLevel((process.env.LOG_LEVEL as 'debug' | 'info' | 'error') || 'error');

// Accept either name. The systemd unit sets DISCORD_TOKEN; the agent runtime
// injects the same secret as DISCORD_BOT_TOKEN.
const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN (or DISCORD_BOT_TOKEN). See docs/SECRETS.md.');
  process.exit(2);
}
if (!databaseUrl) {
  console.error('Missing TWO_DATABASE_URL. See docs/SECRETS.md.');
  process.exit(2);
}
const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) {
  console.error('Missing DISCORD_GUILD_ID. Backfill targets exactly one server on purpose.');
  process.exit(2);
}

/**
 * Channels worth scanning. We do NOT trust the name to tell us what format a
 * channel holds - both parsers are run over every candidate and whichever one
 * matches wins. The name filter is only a cost control, so we do not page
 * through years of general chat looking for embeds that are not there.
 */
const CANDIDATE = /log|invite|wick|join|leave|member|voice|logger/i;
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT

/** Fraction of a channel's newest page that must be funnel data to scan it deeply. */
const MIN_PROBE_YIELD = 0.05;

const rest = new DiscordRest({ token });
const db = await openDb(databaseUrl);
const store = new EventStore(db);
const invites = new InviteTracker(db);

const t0 = Date.now();
console.log(`\nTWO backfill${dryRun ? '  (DRY RUN - nothing will be written)' : ''}`);
console.log(`  guild ${guildId}   max ${maxPages} pages/channel\n`);

// --- 1. current members: Discord's own joined_at ----------------------------

const members = await fetchAllMembers(rest, guildId);
if (members.length === 0) {
  console.error(
    'Read zero members. That usually means Server Members Intent is OFF -\n' +
      'the REST member list needs it too, not just the gateway. Run scripts/preflight.ts.',
  );
  process.exit(1);
}

const botIds = new Set<string>();
const memberListJoins: FunnelEvent[] = [];
const gateClearings: FunnelEvent[] = [];
let humans = 0;
let missingJoinedAt = 0;
let stuckAtGate = 0;

for (const m of members) {
  const id = m.user?.id;
  if (!id) continue;
  if (m.user?.bot) {
    botIds.add(id);
    if (!dryRun) await store.markBot(guildId, id);
    continue;
  }
  humans++;
  if (!m.joined_at) {
    missingJoinedAt++;
    continue;
  }
  memberListJoins.push({
    memberId: id,
    guildId,
    eventType: 'member_join',
    occurredAt: new Date(m.joined_at).toISOString(),
    source: 'backfill:member_list',
    metadata: { backfill: true },
  });

  /**
   * The rules gate (TOG-76).
   *
   * `pending` is Discord's live answer to "are they still behind the
   * membership screen". It is the ONLY way to learn the gate state of somebody
   * who joined before the listener existed - which on TWO is almost everybody.
   *
   * Read the timestamp honestly. `occurred_at` here is the JOIN time, not a
   * clearing time, because Discord keeps no history of the transition and we
   * are guessing at nothing. That makes it a placeholder: `source` says
   * `backfill:member_list`, labelSource() marks anything `backfill:` as
   * unattributable, and no time-to-clear arithmetic may use these rows. What
   * the row DOES establish, truthfully, is the binary: this member is through.
   *
   * `pending === undefined` means screening is off for the guild, in which
   * case there is no gate and everybody is trivially through it. Only an
   * explicit `true` is a member who is stuck.
   */
  if (m.pending === true) {
    stuckAtGate++;
  } else {
    gateClearings.push({
      memberId: id,
      guildId,
      eventType: 'gate_cleared',
      occurredAt: new Date(m.joined_at).toISOString(),
      source: 'backfill:member_list',
      metadata: {
        backfill: true,
        // Loud, in the row itself, because this timestamp will otherwise be
        // read as a real clearing time by the next person to touch it.
        timestampIsJoinTime: true,
        screeningEnabled: m.pending !== undefined,
      },
    });
  }
}

console.log(
  `  member list          ${String(members.length).padStart(5)} members  ` +
    `(${humans} human, ${botIds.size} bots${missingJoinedAt ? `, ${missingJoinedAt} with no joined_at` : ''})`,
);
console.log(
  `  rules gate           ${String(gateClearings.length).padStart(5)} through  ` +
    `(${stuckAtGate} still behind it and unable to interact)`,
);

// --- 2. the server's own log channels ---------------------------------------

const channels = (await rest.get<RawChannel[]>(`/guilds/${guildId}/channels`)) ?? [];
const targets = channels.filter(
  (c) => TEXT_CHANNEL_TYPES.has(c.type) && CANDIDATE.test(c.name ?? ''),
);

const logJoins: FunnelEvent[] = [];
const logLeaves: FunnelEvent[] = [];
const voiceEvents: FunnelEvent[] = [];
const truncatedChannels: string[] = [];
let scannedMessages = 0;
let oldestSeen: string | null = null;

let skipped = 0;

for (const ch of targets) {
  /**
   * Probe one page before committing to a deep scan. Most channels matching
   * the name filter are role/message/server logs that neither parser will ever
   * recognise, and paging years of them costs hundreds of requests to produce
   * nothing.
   *
   * The bar is a HIT RATE, not a single hit. TWO's catch-all #audit-log
   * carries every kind of server event, so a handful of joins scroll past in
   * among tens of thousands of unrelated entries - it cleared a
   * "one hit is enough" test and cost 200 requests to yield 82 records that
   * the dedicated channels already had. A channel that is genuinely a join or
   * voice feed has its newest page almost entirely full of them.
   */
  const channelKind = memberLogKindForChannel(ch.name);
  const probe = await scanChannel(rest, ch.id, { maxPages: 1 });
  const probeHits = probe.messages.filter(
    (m) => parseMemberLogMessage(m, channelKind) !== null || parseVoiceMessage(m) !== null,
  ).length;
  const yieldRate = probe.messages.length ? probeHits / probe.messages.length : 0;
  if (probeHits === 0 || yieldRate < MIN_PROBE_YIELD) {
    if (probeHits > 0) {
      console.log(
        `  ${(ch.name ?? ch.id).padEnd(20)} skipped - only ${(yieldRate * 100).toFixed(0)}% of its ` +
          `newest page is funnel data (mixed feed, covered by the dedicated channels)`,
      );
    }
    skipped++;
    continue;
  }

  const res = await scanChannel(rest, ch.id, { maxPages });
  if (res.messages.length === 0) continue;
  scannedMessages += res.messages.length;
  if (res.truncated) truncatedChannels.push(ch.name ?? ch.id);
  if (res.scannedBackTo && (!oldestSeen || res.scannedBackTo < oldestSeen)) {
    oldestSeen = res.scannedBackTo;
  }

  let hits = 0;
  for (const msg of res.messages) {
    const mem = parseMemberLogMessage(msg, channelKind);
    if (mem && !botIds.has(mem.memberId)) {
      hits++;
      (mem.kind === 'join' ? logJoins : logLeaves).push({
        memberId: mem.memberId,
        guildId,
        eventType: mem.kind === 'join' ? 'member_join' : 'member_leave',
        occurredAt: new Date(mem.occurredAt).toISOString(),
        source: `backfill:log:${ch.name ?? ch.id}`,
        metadata: { backfill: true },
      });
      continue;
    }

    const voice = parseVoiceMessage(msg);
    // 'leave' tells us a session ended; the session's START is what the funnel
    // measures, and a join or a move already gave us that. Counting leaves too
    // would just re-stamp the same session at a later time.
    if (voice && voice.kind !== 'leave' && !botIds.has(voice.memberId)) {
      hits++;
      voiceEvents.push({
        memberId: voice.memberId,
        guildId,
        eventType: 'first_voice_session',
        occurredAt: new Date(voice.occurredAt).toISOString(),
        source: voice.channelId ? `channel:${voice.channelId}` : `backfill:log:${ch.name ?? ch.id}`,
        metadata: { backfill: true },
      });
    }
  }
  if (hits > 0) {
    console.log(
      `  ${(ch.name ?? ch.id).padEnd(20)} ${String(res.messages.length).padStart(5)} messages  ` +
        `${String(hits).padStart(5)} usable${res.truncated ? '  (TRUNCATED)' : ''}`,
    );
  }
}

console.log(
  `  scanned              ${String(scannedMessages).padStart(5)} messages across ` +
    `${targets.length - skipped} of ${targets.length} candidate channels ` +
    `(${skipped} held no join/leave/voice entries)\n`,
);

// --- 3. reconcile the sources ------------------------------------------------

/**
 * First, the log channels against each other. TWO ran several logging bots at
 * once, each with its own channel, so one join is written twice seconds apart.
 * See src/backfill/dedupe.ts - unhandled this overstated joins by 42%.
 */
const joinDedupe = collapseCrossSourceDuplicates(logJoins);
const leaveDedupe = collapseCrossSourceDuplicates(logLeaves);
const dedupedJoins = joinDedupe.kept;
const dedupedLeaves = leaveDedupe.kept;

/**
 * Then the member list against the logs. The member list and the join log both
 * know about current members, and their
 * timestamps differ by seconds (Discord's stamp vs when the logger bot posted).
 * Left unhandled that is one join counted twice. The event store's idempotency
 * key includes the timestamp - deliberately, because rejoins are real - so it
 * cannot collapse these for us.
 *
 * Rule: the log is the richer record, so it wins. A member-list join is only
 * kept if no log-derived join for that member lands within the tolerance.
 */
const TOLERANCE_MS = 5 * 60 * 1000;
const logJoinsByMember = new Map<string, number[]>();
for (const e of dedupedJoins) {
  const arr = logJoinsByMember.get(e.memberId!) ?? [];
  arr.push(Date.parse(e.occurredAt));
  logJoinsByMember.set(e.memberId!, arr);
}

let supersededByLog = 0;
const keptMemberListJoins = memberListJoins.filter((e) => {
  const near = logJoinsByMember.get(e.memberId!);
  if (!near) return true;
  const at = Date.parse(e.occurredAt);
  const dup = near.some((t) => Math.abs(t - at) <= TOLERANCE_MS);
  if (dup) supersededByLog++;
  return !dup;
});

/**
 * Order matters. `member_join` clears `left_at` in the members projection, so
 * replaying a rejoiner's history out of order would leave someone who left
 * looking present, or vice versa. Sorting ascending makes the projection land
 * on the same state it would have reached live.
 */
const all = [
  ...dedupedJoins,
  ...dedupedLeaves,
  ...keptMemberListJoins,
  // Every clearing we found, not just the ones whose join survived the dedupe
  // above. A member whose join came from a log channel still cleared the gate,
  // and the gate row is keyed on the member, not on which source told us they
  // arrived.
  ...gateClearings,
  ...voiceEvents,
].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

// --- 4. write ----------------------------------------------------------------

const inserted = { member_join: 0, member_leave: 0, gate_cleared: 0, first_voice_session: 0 };
let alreadyOnFile = 0;

if (!dryRun) {
  for (const e of all) {
    // first_voice_session is once-per-member, and the backfill can legitimately
    // discover a session older than one already recorded. recordEarliest keeps
    // the true first. Joins and leaves genuinely repeat, so they use record.
    const res =
      e.eventType === 'first_voice_session' ? await store.recordEarliest(e) : await store.record(e);
    if (res.inserted) inserted[e.eventType as keyof typeof inserted]++;
    else alreadyOnFile++;

    /**
     * Every voice session is evidence the member was around at that moment,
     * not just their first one. But `first_voice_session` is a once-per-member
     * event, so only the earliest is ever stored - which means the members
     * projection would leave `last_active_at` pinned to the day of someone's
     * FIRST ever voice call, years ago, and D7/D30 retention would read as
     * near-zero for people who are in fact still here every week.
     *
     * touchActivity only ever moves recency forward, so replaying in
     * ascending order lands on the true last-seen time.
     */
    if (e.eventType === 'first_voice_session' && e.memberId) {
      await store.touchActivity(guildId, e.memberId, e.occurredAt);
    }
  }
}

// --- 5. seed the invite baseline ---------------------------------------------

/**
 * Not history - a starting line. Attribution works by noticing which invite's
 * use count went up. Without a stored "before", the FIRST live join after
 * deploy has nothing to diff against and records as `unknown`. Writing the
 * counts now means that join is attributable the moment the bot comes up.
 */
const rawInvites = (await rest.get<RawInvite[]>(`/guilds/${guildId}/invites`)) ?? null;
let inviteNote: string;
if (!rawInvites) {
  inviteNote = 'FAILED to read invite list - check Manage Server (scripts/preflight.ts)';
} else if (dryRun) {
  inviteNote = `${rawInvites.length} invites readable (not stored - dry run)`;
} else {
  // Must be awaited: the store is async since the Postgres migration, and an
  // unawaited write here lands after db.close() at the end of the script - so
  // the invite baseline silently does not get stored, and the first live join
  // has nothing to diff against.
  await invites.diffAndStore(
    guildId,
    rawInvites.map((i) => ({
      code: i.code,
      uses: i.uses ?? 0,
      inviterId: i.inviter?.id ?? null,
      channelId: i.channel?.id ?? null,
    })),
  );
  const used = rawInvites.filter((i) => (i.uses ?? 0) > 0).length;
  inviteNote = `${rawInvites.length} invites stored as the attribution baseline (${used} with uses on the clock)`;
}

// --- 6. report ----------------------------------------------------------------

const span = (() => {
  const times = all.map((e) => e.occurredAt).sort();
  return times.length ? `${times[0].slice(0, 10)} .. ${times[times.length - 1].slice(0, 10)}` : 'none';
})();

console.log(`  recovered events     ${String(all.length).padStart(5)}   spanning ${span}`);
console.log(`    joins              ${String(dedupedJoins.length + keptMemberListJoins.length).padStart(5)}   ` +
  `(${dedupedJoins.length} from logs, ${keptMemberListJoins.length} from the member list)`);
console.log(`    leaves             ${String(dedupedLeaves.length).padStart(5)}`);
console.log(`    gate clearings     ${String(gateClearings.length).padStart(5)}   ` +
  `(binary only - occurred_at is the join time, see migrations/0007)`);
console.log(`    de-duplicated      ${String(joinDedupe.collapsed + leaveDedupe.collapsed + supersededByLog).padStart(5)}   ` +
  `(${joinDedupe.collapsed} joins and ${leaveDedupe.collapsed} leaves logged twice by different bots, ` +
  `${supersededByLog} member-list joins already in a log)`);
console.log(`    voice sessions     ${String(voiceEvents.length).padStart(5)}`);
if (!dryRun) {
  console.log(
    `\n  written              ${String(inserted.member_join + inserted.member_leave + inserted.gate_cleared + inserted.first_voice_session).padStart(5)} new ` +
      `(${inserted.member_join} joins, ${inserted.member_leave} leaves, ` +
      `${inserted.gate_cleared} gate clearings, ${inserted.first_voice_session} voice)`,
  );
  console.log(`  already on file      ${String(alreadyOnFile).padStart(5)}   (re-run is a no-op, as intended)`);
}
console.log(`  invites              ${inviteNote}`);

if (truncatedChannels.length) {
  // Say this loudly. A truncated scan and an exhaustive one produce different
  // numbers, and a reader has no way to tell them apart from the totals alone.
  console.log(
    `\n  INCOMPLETE: hit the ${maxPages}-page cap on ${truncatedChannels.join(', ')}.` +
      `\n  There is older history we did not read. Re-run with --max-pages=${maxPages * 4}.`,
  );
}

console.log(
  `\n  ${rest.requests} Discord requests in ${((Date.now() - t0) / 1000).toFixed(1)}s.` +
    `${dryRun ? '' : '  Now run: node scripts/funnel.ts 3650'}\n`,
);

await db.close();
