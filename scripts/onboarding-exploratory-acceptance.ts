/**
 * TOG-7193 exploratory onboarding-flow acceptance: join -> welcome ->
 * first-message, plus the community welcome packs that feed the same flow.
 *
 *   node scripts/onboarding-exploratory-acceptance.ts [--staging]
 *   npm run onboarding:exploratory
 *
 * Offline by default: no network, no Postgres, no Discord token, no secrets.
 * The funnel walk runs against an in-memory SQLite database behind the repo's
 * own narrow Db surface (`?` placeholders, UPSERT) - the same handlers, the
 * same EventStore, only the driver swapped. The Postgres-backed e2e
 * session/onboarding suites still cover the same handlers against the real
 * driver.
 *
 * What this pins (passing behavior, exploratory notes where the code and the
 * docs disagree):
 *   A. session picker contract: exactly the two accepted options, in order,
 *      with the accepted destinations and no role anywhere in the plan.
 *   B. session behavior: idempotent re-selection, stale keys reported never
 *      routed (valid picks still route), invisible destinations withheld not linked.
 *   C. legacy picker regression (TOG-7438): repeated keys must not double-count
 *      roleIds, degradedCount or unknownKeys. The original defect probes remain
 *      even after the deduplication fix.
 *   D. session doc defect (TOG-7439): SessionPlan.channelIds is documented
 *      "in catalog order" but follows input order.
 *   E. anchor event: DST-safe wall-clock recurrence (the 1 Nov 2026
 *      changeover), near/live voices, goodbye copy never pings.
 *   F. funnel walk: join -> gate_cleared -> onboarding_prompted ->
 *      channel_routed -> first/second/third message rungs; prompted stays
 *      once-per-member while routed repeats; redelivered same-ms messages do
 *      not advance the ladder.
 *   G. welcome packs: week-5 Series window correct (EDT); week-6 Series
 *      regression (TOG-7440): the 1 Nov run is EST (UTC-5) so 20:00 must be
 *      01:00Z, not 00:00Z. Both hardcoded <t:> stamps verified correct
 *      against zonedEpochMs.
 *
 * --staging runs an additional READ-ONLY live probe (guild identity, landing
 * and goodbye channel resolvability). It needs DISCORD_STAGING_BOT_TOKEN and
 * DISCORD_STAGING_GUILD_ID, refuses non-staging tokens, and POSTs nothing.
 * Without the flag the section reports N-A, which is not failure.
 *
 * Exit codes: 0 every check passed (N-A allowed) - 1 a check failed -
 * 2 usage or an incomplete checkout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { isMeasurableGateClearing } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/log.ts';
import type { Db, Statement } from '../src/store/driver.ts';
import {
  LOOKING_TO_PLAY_CHANNEL_ID,
  LOBBY_VOICE_CHANNEL_ID,
  SESSION_PICKS,
  SESSION_SELECT_ID,
  buildSessionPicks,
  daysInGuild,
  goodbyeText,
  pickByKey as pickSessionByKey,
  planSession,
  sessionAckText,
  sessionWelcomeText,
} from '../src/onboarding/session.ts';
import {
  OnboardingRecorder,
  currentGameKeys,
  decidePrompt,
  planSelection,
} from '../src/onboarding/flow.ts';
import {
  GAME_HUB_CHANNEL_ID,
  pickByKey as pickLegacyByKey,
} from '../src/onboarding/catalog.ts';
import {
  SUNDAY_SQUAD,
  anchorWelcomeText,
  occurrenceContext,
  zonedEpochMs,
} from '../src/onboarding/anchorEvent.ts';
import {
  TWO_STAGING_GUILD_ID,
  checkStagingToken,
} from '../src/staging/spec.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The funnel walk (section F) records events through the handlers, which log.
// Errors stay loud; info lines would bury the check output.
setLogLevel('error');

let passed = 0;
let failed = 0;
let na = 0;

function ok(name: string): void {
  passed++;
  console.log(`ok   ${name}`);
}

function fail(name: string, detail: string): void {
  failed++;
  console.log(`FAIL ${name}  -  ${detail}`);
}

function check(name: string, cond: boolean, detail = 'assertion did not hold'): void {
  if (cond) ok(name);
  else fail(name, detail);
}

function skip(name: string, why: string): void {
  na++;
  console.log(`N-A  ${name}  -  ${why}`);
}

const USAGE = 'Usage: node scripts/onboarding-exploratory-acceptance.ts [--staging] [--help|-h]';
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

for (const a of process.argv.slice(2)) {
  if (a !== '--staging') usage();
}
const withStaging = process.argv.includes('--staging');

// --- step 0: preconditions. An incomplete checkout refuses, never half-runs.
const REQUIRED = [
  'src/onboarding/session.ts',
  'src/onboarding/flow.ts',
  'src/onboarding/catalog.ts',
  'src/onboarding/anchorEvent.ts',
  'src/core/handlers.ts',
  'src/core/events.ts',
  'src/store/eventStore.ts',
  'src/staging/spec.ts',
  'community/week5-onboarding-content-kit.md',
  'community/week6-onboarding-content-kit.md',
  'community/contributor-onboarding-drip-3-posts.md',
  'community/welcome-post-refresh-pack3.md',
];
const missing = REQUIRED.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length > 0) {
  console.error(`onboarding-exploratory-acceptance: incomplete checkout, missing: ${missing.join(', ')}`);
  process.exit(2);
}
console.log('-- preconditions ok (12 flow + pack files present) --');

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const SNOWFLAKE = /^\d{17,20}$/;
const seeEverything = () => true;
const seeNothing = () => false;

// --- A. session picker contract (TOG-1654 acceptance, offline mirror) ---
console.log('== A. session picker contract ==');
check(
  'picker offers exactly the two accepted options, in order',
  SESSION_PICKS.map((p) => p.key).join(',') === 'find-players,join-voice',
  `got ${SESSION_PICKS.map((p) => p.key).join(',')}`,
);
check('find-players label pinned', SESSION_PICKS[0]?.label === 'Find people to play with', String(SESSION_PICKS[0]?.label));
check('join-voice label pinned', SESSION_PICKS[1]?.label === 'Join voice now', String(SESSION_PICKS[1]?.label));
check(
  'destinations are the accepted clean-slate channels',
  pickSessionByKey('find-players')?.channelId === LOOKING_TO_PLAY_CHANNEL_ID &&
    pickSessionByKey('join-voice')?.channelId === LOBBY_VOICE_CHANNEL_ID,
  'picker destinations moved',
);
check('select-menu custom id pinned', SESSION_SELECT_ID === 'two:onboarding:session', SESSION_SELECT_ID);
check(
  'no pick carries a role - the structure forbids it',
  SESSION_PICKS.every((p) => !('roleId' in p)),
  'a session pick grew a roleId',
);
check(
  'runtime picks use the configured guild channel ids, never shared fixtures',
  buildSessionPicks({ lookingToPlay: '111111111111111111', lobbyVoice: '222222222222222222' }).map((p) => p.channelId).join(',') ===
    '111111111111111111,222222222222222222',
  'buildSessionPicks ignores its arguments',
);
{
  const text = sessionWelcomeText('<@123>');
  check('welcome greets the member and states the picker', /<@123>/.test(text) && /what do you want to do right now/i.test(text), text.slice(0, 80));
  check('welcome states routing-not-label', /not a label forever/i.test(text), 'welcome copy moved');
}

// --- B. session behavior pins ---
console.log('== B. session behavior ==');
{
  const once = planSession(['find-players'], seeEverything);
  const twice = planSession(['find-players', 'find-players'], seeEverything);
  check('re-selecting the same option plans identically (idempotent)', JSON.stringify(once) === JSON.stringify(twice), 'duplicate submission plans differently');
  const ackA = sessionAckText(planSession(['join-voice'], seeEverything));
  const ackB = sessionAckText(planSession(['join-voice'], seeEverything));
  check('identical submissions ack byte-identically', ackA === ackB, 'ack text wobbles');
  check('normal selection links the destination', new RegExp(`<#${LOOKING_TO_PLAY_CHANNEL_ID}>`).test(sessionAckText(once)), sessionAckText(once));
}
{
  const stale = planSession(['survival-games'], seeEverything);
  check('stale keys reported, never routed', stale.channelIds.length === 0 && stale.unknownKeys.join(',') === 'survival-games', JSON.stringify(stale));
  check('stale ack offers a retry, not silence', /stale/i.test(sessionAckText(stale)) && /nothing was changed/i.test(sessionAckText(stale)), sessionAckText(stale));
  // TOG-8768: stale choices are skipped; valid choices in the same submission still route.
  const mixed = planSession(['survival', 'find-players'], seeEverything);
  const mixedAck = sessionAckText(mixed);
  check(
    'mixed submission reports the stale key and still links the valid destination',
    mixed.unknownKeys.join(',') === 'survival' &&
      mixed.channelIds.join(',') === LOOKING_TO_PLAY_CHANNEL_ID &&
      mixedAck.includes(`<#${LOOKING_TO_PLAY_CHANNEL_ID}>`) &&
      /stale/i.test(mixedAck) && !/nothing was changed/i.test(mixedAck),
    JSON.stringify({ plan: mixed, ack: mixedAck }),
  );
}
{
  const dark = planSession(['join-voice'], seeNothing);
  check('invisible destination withheld, not linked', dark.channelIds.length === 0 && dark.unavailable.map((p) => p.key).join(',') === 'join-voice', JSON.stringify(dark));
  check('dark ack names no room the member cannot open', !new RegExp(LOBBY_VOICE_CHANNEL_ID).test(sessionAckText(dark)), sessionAckText(dark));
}

// --- C. legacy picker duplicate-key defect (child card, NOT fixed here) ---
console.log('== C. legacy planSelection duplicate keys (known defect, pinned) ==');
{
  const dup = planSelection(['shooters', 'shooters'], seeNothing);
  check(
    'DEFECT? repeated key grants the role once (roleIds deduped)',
    new Set(dup.roleIds).size === dup.roleIds.length,
    `roleIds carry the grant twice: ${JSON.stringify(dup.roleIds)} - filed as child card, not fixed here`,
  );
  check(
    'DEFECT? repeated key counts degraded once',
    dup.degradedCount <= 1,
    `one dark pick counted as degraded ${dup.degradedCount}x - filed as child card, not fixed here`,
  );
  const dupUnknown = planSelection(['nonsense', 'nonsense'], seeNothing);
  check(
    'DEFECT? repeated unknown key reported once',
    dupUnknown.unknownKeys.length === 1,
    `unknownKeys repeat: ${JSON.stringify(dupUnknown.unknownKeys)} - filed as child card, not fixed here`,
  );
}

// --- D. session catalog-order doc defect (child card, NOT fixed here) ---
console.log('== D. SessionPlan channel order vs its doc comment (known defect, pinned) ==');
{
  const reversed = planSession(['join-voice', 'find-players'], seeEverything);
  check(
    'DEFECT? channelIds follow catalog order as SessionPlan documents',
    JSON.stringify(reversed.channelIds) === JSON.stringify([LOOKING_TO_PLAY_CHANNEL_ID, LOBBY_VOICE_CHANNEL_ID]),
    `input order wins over catalog order: ${JSON.stringify(reversed.channelIds)} - interface comment says "in catalog order", filed as child card, not fixed here`,
  );
}

// --- E. anchor event: DST wall-clock, voices, goodbye ---
console.log('== E. anchor event + goodbye ==');
{
  // The 1 Nov 2026 DST changeover: 20:00 America/New_York is EST (UTC-5),
  // i.e. 01:00Z Nov 2. A fixed +7d recurrence from the Oct 25 run would say 00:00Z.
  const nov1 = zonedEpochMs(2026, 11, 1, 20, 0, 'America/New_York');
  check('1 Nov 20:00 ET resolves to 01:00Z (EST), not 00:00Z', new Date(nov1).toISOString() === '2026-11-02T01:00:00.000Z', new Date(nov1).toISOString());
  const oct25 = zonedEpochMs(2026, 10, 25, 20, 0, 'America/New_York');
  check('25 Oct 20:00 ET resolves to 00:00Z (EDT)', new Date(oct25).toISOString() === '2026-10-26T00:00:00.000Z', new Date(oct25).toISOString());
  // 25 Oct 20:00 ET is 26 Oct 00:00Z (EDT): one hour before is 23:00Z.
  const ctx = occurrenceContext(new Date('2026-10-25T23:00:00.000Z').getTime());
  check('join 1h before the run is near, not live', ctx.near === true && ctx.live === false, JSON.stringify(ctx));
  const mid = occurrenceContext(new Date('2026-10-26T00:30:00.000Z').getTime());
  check('join mid-run names the running occurrence', mid.near === true && mid.live === true, JSON.stringify(mid));
  const far = occurrenceContext(new Date('2026-10-22T12:00:00.000Z').getTime());
  check('join days out is neither near nor live', far.near === false && far.live === false, JSON.stringify(far));
  const nearText = anchorWelcomeText('<@1>', new Date('2026-10-25T23:00:00.000Z').getTime());
  check('near-event voice names the running event', /happening right now/i.test(nearText), nearText.slice(0, 120));
  const normalText = anchorWelcomeText('<@1>', new Date('2026-10-22T12:00:00.000Z').getTime());
  check('normal voice carries a relative timestamp, never a stored date', /<t:\d+:R>/.test(normalText), normalText.slice(0, 200));
  void SUNDAY_SQUAD;
}
{
  check(
    'goodbye names the leaver, states the stay, never pings',
    goodbyeText('dave', 3) === '**dave** left the server (was here 3 days). Their messages and voice history stay on the books.' &&
      goodbyeText('lee', null) === '**lee** left the server. Their messages and voice history stay on the books.' &&
      !/<@/.test(goodbyeText('dave', 3)),
    goodbyeText('dave', 3),
  );
  check('daysInGuild floors and rejects nonsense', daysInGuild('2026-09-01T12:00:00Z', '2026-09-04T13:00:00Z') === 3 && daysInGuild(null, '2026-09-01T12:00:00Z') === null, 'daysInGuild moved');
}

// --- F. funnel walk on an in-memory database ---
console.log('== F. join -> gate -> welcome -> routed -> first-message ==');

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, member_id TEXT, guild_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, metadata TEXT, idempotency_key TEXT NOT NULL UNIQUE
  )`);
  db.exec(`CREATE TABLE members (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    joined_at TEXT, join_source TEXT, gate_cleared_at TEXT,
    first_message_at TEXT, third_message_at TEXT, first_voice_at TEXT,
    last_active_at TEXT, left_at TEXT, inactive_flagged_at TEXT,
    is_bot INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id)
  )`);
  const wrap = (sql: string): Statement => {
    const stmt = db.prepare(sql);
    return {
      get: async <T>(...params: unknown[]): Promise<T | undefined> =>
        stmt.get(...(params as never[])) as T | undefined,
      all: async <T>(...params: unknown[]): Promise<T[]> =>
        stmt.all(...(params as never[])) as T[],
      run: async (...params: unknown[]): Promise<{ changes: number }> => {
        const r = stmt.run(...(params as never[]));
        return { changes: Number(r.changes) };
      },
    };
  };
  const facade: Db = {
    prepare: (sql) => wrap(sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

{
  const G = 'g7193';
  const M = '900000000000007193';
  const db = openOfflineDb();
  try {
    const store = new EventStore(db);
    const handlers = new FunnelHandlers(store);
    const recorder = new OnboardingRecorder(store);
    const T0 = Date.parse('2026-09-27T12:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    // Recorder timestamps and gateway fixtures share one controlled clock.
    mock.timers.enable({ apis: ['Date'], now: T0 });

    // 1. join behind the gate: prompted must refuse while pending.
    await handlers.onJoin({ guildId: G, memberId: M, isBot: false, source: 'invite:abc', occurredAt: iso(T0) });
    const gated = await decidePrompt(store, { guildId: G, memberId: M, isBot: false, pending: true });
    check('gated member is not prompted', gated.shouldPrompt === false && gated.reason === 'still_pending', JSON.stringify(gated));

    // 2. gate clears -> welcome goes out, exactly once.
    await handlers.onGateCleared({ guildId: G, memberId: M, isBot: false, occurredAt: iso(T0 + 5_000) });
    const first = await decidePrompt(store, { guildId: G, memberId: M, isBot: false, pending: false });
    check('cleared member is promptable', first.shouldPrompt === true, JSON.stringify(first));
    mock.timers.setTime(T0 + 6_000);
    await recorder.prompted(G, M, 'chan-welcome');
    const second = await decidePrompt(store, { guildId: G, memberId: M, isBot: false, pending: false });
    check('welcome stays once-per-member', second.shouldPrompt === false && second.reason === 'already_prompted', JSON.stringify(second));
    const promptedAgain = await store.record({
      guildId: G, memberId: M, eventType: 'onboarding_prompted', occurredAt: iso(T0 + 6_000), source: 'channel:chan-welcome',
    });
    check('re-recorded prompted dedupes (no funnel inflation)', promptedAgain.inserted === false, 'second onboarding_prompted inserted');

    // 3. legacy pick: withhold invisible rooms; route only to a visible hub.
    const darkPlan = planSelection(['shooters'], seeNothing);
    check('invisible legacy fallback is withheld, not routed', darkPlan.channelIds.length === 0 && darkPlan.degradedCount === 0, JSON.stringify(darkPlan));
    const seeHub = (channelId: string) => channelId === GAME_HUB_CHANNEL_ID;
    const plan = planSelection(['shooters'], seeHub);
    check('dark pick routes to the visible hub, flagged degraded', plan.channelIds.join(',') === GAME_HUB_CHANNEL_ID && plan.degradedCount === 1, JSON.stringify(plan));
    mock.timers.setTime(T0 + 9_000);
    await recorder.selected(G, M, plan);
    mock.timers.setTime(T0 + 10_000);
    await recorder.routed(G, M, plan);
    // Member changes their mind: routed repeats by design, reach still counts one.
    const plan2 = planSelection(['horror'], seeHub);
    mock.timers.setTime(T0 + 19_000);
    await recorder.selected(G, M, plan2);
    mock.timers.setTime(T0 + 20_000);
    await recorder.routed(G, M, plan2);
    check('re-pick reach counts people, not clicks', (await store.countMembersWith('channel_routed')) === 1, 'countMembersWith(channel_routed) != 1');
    const sel = await recorder.selected(G, M, planSelection(['shooters', 'horror'], seeEverything));
    check(
      'selection metadata carries game keys only, never member text',
      JSON.stringify(sel.metadata) === JSON.stringify({ picks: ['shooters', 'horror'] }),
      JSON.stringify(sel.metadata),
    );

    // 4. time-to-route: the number TWO-7 is judged on (target: under 60s).
    const ttr = await store.secondsBetween(G, M, 'member_join', 'channel_routed');
    check('join -> routed is 10s (the under-60s claim shape)', ttr === 10, String(ttr));
    const gateSeconds = await store.timeToGateClearSeconds(G, M);
    check('join -> gate_cleared measurable (gateway source)', gateSeconds === 5, String(gateSeconds));

    // 5. backfilled gate clearings count for conversion but never feed timing.
    const MB = '900000000000007194';
    await handlers.onJoin({ guildId: G, memberId: MB, isBot: false, source: 'invite:abc', occurredAt: iso(T0) });
    await store.record({
      guildId: G, memberId: MB, eventType: 'gate_cleared', occurredAt: iso(T0),
      source: 'backfill:member_list', metadata: { timestampIsJoinTime: true },
    });
    check('backfilled clearing is not measurable for timing', (await store.timeToGateClearSeconds(G, MB)) === null, 'backfill fed time-to-clear arithmetic');
    check(
      'backfill placeholder refused by either signal alone',
      isMeasurableGateClearing('backfill:x', undefined) === false &&
        isMeasurableGateClearing('gateway', { timestampIsJoinTime: true }) === false &&
        isMeasurableGateClearing('gateway', undefined) === true,
      'isMeasurableGateClearing moved',
    );

    // 6. first message: the ladder fills first/second/third, then stops.
    const msg = async (at: number) =>
      handlers.onMessage({ guildId: G, memberId: M, isBot: false, channelId: 'c1', occurredAt: iso(at) });
    const r1 = await msg(T0 + 40_000);
    check('first message fills the first rung', r1?.eventType === 'first_message', String(r1?.eventType));
    const replay1 = await msg(T0 + 40_000);
    check(
      'first-message redelivery leaves the second rung empty',
      replay1 === null && !(await store.hasEvent(G, M, 'second_message')),
      String(replay1?.eventType),
    );
    const r2 = await msg(T0 + 50_000);
    check('second message fills the middle rung', r2?.eventType === 'second_message', String(r2?.eventType));
    const replay2 = await msg(T0 + 50_000);
    check(
      'second-message redelivery leaves the third rung empty',
      replay2 === null && !(await store.hasEvent(G, M, 'third_message')),
      String(replay2?.eventType),
    );
    const r3 = await msg(T0 + 60_000);
    check('third message clears the AM7 bar', r3?.eventType === 'third_message', String(r3?.eventType));
    const r4 = await msg(T0 + 70_000);
    check('past the bar: recency only, no fourth rung', r4 === null, String(r4?.eventType));
    const joinToFirst = await store.secondsBetween(G, M, 'member_join', 'first_message');
    check('join -> first_message is 40s (the under-60s claim shape)', joinToFirst === 40, String(joinToFirst));

    // 7. legacy picker reflects what the member holds.
    const shooters = pickLegacyByKey('shooters')!;
    const horror = pickLegacyByKey('horror')!;
    check(
      'currentGameKeys reflects held roles only',
      JSON.stringify(currentGameKeys([shooters.roleId, '999999999999999999']).sort()) === JSON.stringify(['shooters']) &&
        currentGameKeys([horror.roleId]).join(',') === 'horror',
      'currentGameKeys moved',
    );
  } finally {
    mock.timers.reset();
    await db.close();
  }
}

// --- G. welcome packs (copy proposals; the UTC lines are checkable) ---
console.log('== G. community welcome packs ==');
{
  const week5 = read('community/week5-onboarding-content-kit.md');
  const week6 = read('community/week6-onboarding-content-kit.md');
  const drip = read('community/contributor-onboarding-drip-3-posts.md');

  check('week-5 Series window matches EDT (20:00 -> 00:00Z)', week5.includes('25 Oct 2026-10-26T00:00Z–01:00Z'), 'week-5 Series line moved');
  check(
    'week-5 hardcoded stamp is the 1 Nov 20:00 EST run',
    week5.includes('<t:1793581200:R>') && new Date(1793581200 * 1000).toISOString() === '2026-11-02T01:00:00.000Z',
    'week-5 <t:> stamp moved',
  );
  check(
    'week-6 hardcoded stamp is the 8 Nov 20:00 EST run',
    week6.includes('<t:1794186000:R>') && new Date(1794186000 * 1000).toISOString() === '2026-11-09T01:00:00.000Z',
    'week-6 <t:> stamp moved',
  );
  check(
    'DEFECT? week-6 Series window matches EST (20:00 -> 01:00Z)',
    week6.includes('1 Nov 2026-11-02T01:00Z–02:00Z'),
    'kit prints "2026-11-02T00:00Z–01:00Z" but 1 Nov runs on EST (UTC-5): 20:00 is 01:00Z, not 00:00Z - filed as child card, not fixed here',
  );
  check(
    'drip cross-links resolve to real pack files',
    drip.includes('community/welcome-post-refresh-pack3.md') &&
      drip.includes('community/contributor-spotlight-template.md') &&
      drip.includes('community/sunday-squad-event-2026-10-18.md') &&
      existsSync(join(ROOT, 'community/welcome-post-refresh-pack3.md')) &&
      existsSync(join(ROOT, 'community/contributor-spotlight-template.md')) &&
      existsSync(join(ROOT, 'community/sunday-squad-event-2026-10-18.md')),
    'drip references a pack file that does not exist',
  );
  check('drip takes no live action (copy only)', /no bot change, no post, no DM, no schedule/i.test(drip), 'drip scope guard moved');
  for (const p of ['welcome-post-refresh-pack3.md', 'week5-onboarding-content-kit.md', 'week6-onboarding-content-kit.md']) {
    const body = read(`community/${p}`);
    // Guard lines name the rule ("no @everyone/@here"); the failure mode is an
    // actual mass ping outside a guard sentence, so strip guard sentences first.
    const actionable = body
      .split('\n')
      .filter((line) => !/no @everyone/i.test(line))
      .join('\n');
    check(`${p}: no @everyone/@here round-ups`, !/@everyone|@here/.test(actionable), `${p} pings everyone outside its guard line`);
  }
}

// --- H. opt-in read-only staging probe ---
console.log('== H. staging live probe (read-only, --staging only) ==');
if (!withStaging) {
  skip('staging live probe', 'run with --staging plus DISCORD_STAGING_BOT_TOKEN and DISCORD_STAGING_GUILD_ID for the read-only guild check');
} else {
  const token = process.env.DISCORD_STAGING_BOT_TOKEN ?? '';
  const tc = checkStagingToken(token);
  check('staging token belongs to the staging app (fails closed otherwise)', tc.ok, tc.message);
  let guildId = '';
  try {
    if (!process.env.DISCORD_STAGING_GUILD_ID) throw new Error('Missing DISCORD_STAGING_GUILD_ID.');
    if (process.env.DISCORD_STAGING_GUILD_ID !== TWO_STAGING_GUILD_ID) {
      throw new Error(`DISCORD_STAGING_GUILD_ID must be ${TWO_STAGING_GUILD_ID}; refusing to continue.`);
    }
    guildId = TWO_STAGING_GUILD_ID;
  } catch (err) {
    fail('staging guild guard', err instanceof Error ? err.message : String(err));
  }
  if (tc.ok && guildId) {
    const api = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
      const r = await fetch(`https://discord.com/api/v10${path}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as T | null };
    };
    try {
      const me = await api<{ id: string; username: string }>('/users/@me');
      check('staging token valid', me.status === 200 && !!me.body, `HTTP ${me.status}`);
      const guild = await api<{ id: string; name: string }>(`/guilds/${guildId}`);
      check('staging guild reachable', guild.status === 200 && guild.body?.id === guildId, `HTTP ${guild.status}`);
      const channels = await api<Array<{ id: string; name: string; type: number }>>(`/guilds/${guildId}/channels`);
      if (channels.status !== 200 || !channels.body) {
        fail('staging channels readable', `HTTP ${channels.status}`);
      } else {
        const byId = new Map(channels.body.map((c) => [c.id, c]));
        for (const envName of ['DISCORD_LANDING_CHANNEL_IDS', 'DISCORD_GOODBYE_CHANNEL_IDS'] as const) {
          const ids = (process.env[envName] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          if (!ids.length) {
            skip(`${envName} resolvable`, `${envName} is empty - onboarding posts nothing by design (see docs/ROUTING.md)`);
            continue;
          }
          const resolved = ids.find((id) => {
            const c = byId.get(id);
            return c && c.type === 0;
          });
          check(`${envName} resolves to a real text channel`, !!resolved, `ids [${ids.join(', ')}] match no text channel in staging`);
        }
        check('staging has a #welcome channel', channels.body.some((c) => c.name === 'welcome' && c.type === 0), 'no #welcome text channel');
      }
    } catch (err) {
      fail('staging probe request', err instanceof Error ? err.message : String(err));
    }
  }
}

console.log(`\nonboarding-exploratory-acceptance: ${passed} passed, ${failed} failed${na > 0 ? `, ${na} N-A` : ''}.`);
process.exitCode = failed > 0 ? 1 : 0;
