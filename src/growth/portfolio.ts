/**
 * Steps 2-5 of the TOG-92 weekly review: rank the portfolio on cost-per-AM30,
 * apply the pre-registered kill/scale rules, and check where effort actually
 * went.
 *
 * Step 1 - the per-code funnel - is already `npm run attribution`. This is
 * everything that happens to those numbers afterwards, and until now it was
 * prose in the experiment ledger: eight entries, five of which override the
 * standing rule in some way, re-read and re-interpreted by whoever is awake on
 * a Friday. `src/growth/gate.ts` exists because the same thing happened to the
 * six-criterion gate. Same fix, same reason: the rules have numbers in them, so
 * they belong in code, and the same input gives the same answer forever.
 *
 * Pure on purpose. `scripts/growth-review.ts` reads the database and the effort
 * file; this decides what the rows mean. So the rules can be tested with no
 * database, no token and no live guild - which matters, because the gate is red
 * and will stay red for a while, and a rule that cannot be verified until data
 * arrives is a rule nobody checks before betting the quarter on it.
 *
 * THE FOUR THINGS THIS REFUSES TO DO
 *
 *  1. **Kill a channel that was never actually run.** 0 AM30 from a channel
 *     nobody worked is a fact about us, not about the channel. The ledger says
 *     "sustained effort AND 0 AM30"; the conjunction is load-bearing and is the
 *     easiest half to drop. `HOLD-no-effort` is a distinct verdict here.
 *
 *  2. **Kill on less than four valid weeks.** Ledger §1: never kill on one
 *     week, 4-week rolling windows always. At ~15 joins a month the difference
 *     between a good and a bad channel is two people.
 *
 *  3. **Scale off a soft attribution row.** Ledger §1 forbids quoting an
 *     activation rate off a `~` row, and cost-per-AM30 is exactly such a rate.
 *     Kills survive soft rows and scale decisions do not - see `assess()`.
 *
 *  4. **Add hours to pounds.** See COST, below.
 *
 * COST: THE PRE-REGISTERED FORMULA IS NOT DIMENSIONALLY VALID, AND THAT IS FINE
 *
 * The ledger's §1 rule reads `cost-per-activated-member = (agent-hours + cash)
 * ÷ AM30`. Agent-hours plus cash is hours plus pounds; the sum has no unit and
 * the only way to produce one is an hours-to-pounds rate that nobody has ever
 * registered. Inventing one here would be exactly the post-hoc threshold this
 * ledger exists to prevent - and it would be an invented number sitting under
 * the rank that decides which channel gets double effort.
 *
 * So cost stays a PAIR: hours-per-AM30 and cash-per-AM30, both reported, never
 * summed. `rankPortfolio()` collapses them to one order only when it can do so
 * without a rate, and says why when it cannot:
 *
 *   - Every channel at £0 cash - the registered plan for month 1 and month 2,
 *     and arithmetically guaranteed while EXP-008 is locked - means cash is a
 *     constant across the portfolio, so ranking on hours alone gives the same
 *     order as ranking on any combined figure whatsoever. The rank is exact and
 *     needs no rate. This is the case that actually obtains.
 *   - Once any channel carries cash, the order genuinely depends on the rate,
 *     and the caller must supply one. That cannot happen without a per-proposal
 *     CEO approval (EXP-008), which is the natural moment to register a rate.
 *
 * Written down here rather than raised as a question because it decides
 * nothing today and would decide everything on the first week cash exists.
 */

/** Weeks of data a standing kill decision needs. Ledger §1: never on one week. */
export const KILL_WINDOW_WEEKS = 4;

/**
 * Joins that split `KILL-no-traffic` from `KILL-no-activation` (EXP-001,
 * EXP-002). Below it the channel did not deliver people - a distribution
 * failure. At or above it, it delivered people who never activated - an intent
 * failure, and the more dangerous one, because the join count looks like
 * success.
 */
export const KILL_TRAFFIC_SPLIT_JOINS = 5;

/**
 * Recorded agent-hours across the window below which "sustained effort" is not
 * satisfied and no kill may be issued.
 *
 * REGISTERED HERE, 2026-09-05, BEFORE ANY CHANNEL HAS STARTED. The ledger says
 * "sustained effort" without ever giving it a number, which makes the kill rule
 * unfalsifiable in the one direction that matters: any kill can be waved off
 * afterwards as "we did not really run it", and any non-run can be dressed up
 * as sustained. Two hours over four weeks is a deliberately low bar - it is
 * "somebody touched this at all", not "somebody tried hard" - because the
 * expensive mistake is killing a channel that was genuinely worked, not holding
 * one that was not.
 */
export const SUSTAINED_EFFORT_HOURS = 2;

/**
 * Fraction of a week's expected listing bumps that must actually have happened
 * for that week to count toward the kill window.
 *
 * REGISTERED HERE, 2026-09-05, BEFORE ANY CHANNEL HAS STARTED. EXP-001 says a
 * low-compliance week "invalidates that week rather than counting against the
 * channel" and never says what low means. Lapsed bumps are reported to cost
 * listing servers ~80% of their traffic, so an uncompiled week is measuring the
 * bump discipline rather than the listing. Half is the bar: below it the week is
 * dropped from the window, which makes the window take longer to fill and can
 * never make a kill arrive sooner.
 */
export const BUMP_COMPLIANCE_FLOOR = 0.5;

/** AM30 from a free channel that earns the right to ASK for spend. EXP-008. */
export const PAID_ASK_AM30 = 3;

/**
 * Effort share above which listings are eating the portfolio.
 *
 * REGISTERED HERE, 2026-09-05, BEFORE ANY CHANNEL HAS STARTED. `roadmap-30d` §9
 * names this as a standing risk - "effort collapses onto listings because
 * they're the easiest thing to do, while referral and partners get neglected" -
 * and says the weekly review checks effort allocation, not just results. It
 * then leaves the check as a human intention, which is the same failure the
 * gate had. Listings are ranked 5th of 6 on expected activation and 1st on
 * convenience, so this is the drift that happens by default rather than by
 * decision.
 */
export const LISTING_EFFORT_CEILING = 0.5;

/**
 * Effort share below which the two highest-activation channels are being
 * starved. Same registration and same reasoning as the ceiling above; a ceiling
 * alone is satisfiable by doing nothing at all, which is not the intent.
 */
export const HIGH_ACTIVATION_EFFORT_FLOOR = 0.25;

/**
 * How a channel's fate is decided. Five of the eight registered experiments
 * override the standing rule in some way, and every one of those overrides was
 * a deliberate, recorded decision - so they are encoded rather than flattened.
 */
export type KillRule =
  /** The standing rule. 0 AM30 over the window, split on joins. EXP-001, EXP-002. */
  | { kind: 'standard' }
  /**
   * EXP-003. With 5 members asked, 0 AM30 says nothing about referral - it says
   * 5 is too few to conclude anything. The channel is killed only if the ASK
   * fails: fewer than `minCreators` of `asked` create a link at all. That is a
   * real signal and it points at the anchor event, not at the channel.
   */
  | { kind: 'ask'; asked: number; minCreators: number }
  /**
   * EXP-004. A partner who produced nothing twice is a dead partner, not a dead
   * channel. The channel dies only after `partnersBeforeChannelKill` different
   * partners have each produced 0 AM30.
   */
  | { kind: 'per-partner'; nightsPerPartner: number; partnersBeforeChannelKill: number }
  /**
   * EXP-005. Content is the one channel where four weeks genuinely cannot
   * conclude anything, so the 4-week check is on OUTPUT (were clips made and
   * posted) and the AM30 check runs at 8 weeks. An explicit override of the
   * standing rule, recorded as one in the ledger.
   */
  | { kind: 'output-then-am30'; outputWeeks: number; am30Weeks: number }
  /**
   * EXP-006. `WEB-HOMEPAGE` is instrumentation, not a bet: its purpose is to
   * stop attributing website arrivals to `unknown`. It cannot fail, so it
   * cannot be killed, and it is registered precisely so nobody later mistakes
   * it for a channel that did.
   */
  | { kind: 'never' }
  /** EXP-008. No budget exists, so there is nothing running to kill. */
  | { kind: 'locked' };

export interface RegisteredChannel {
  /** The registry §2 slot name, e.g. `LIST-DISBOARD-A`. */
  id: string;
  /** Ledger entry this channel belongs to. */
  experiment: string;
  /** Human label for the report. */
  label: string;
  killRule: KillRule;
  /**
   * Ranked expected activation from `roadmap-30d` §5. Drives the effort-
   * allocation check, which is about where hours went rather than what they
   * produced - so it has to read the plan's own ranking, not this week's result.
   */
  activationTier: 'highest' | 'high' | 'medium' | 'low' | 'unknown';
  /** Whether this slot is a real acquisition channel at all. */
  kind: 'channel' | 'instrumentation' | 'reporting-bucket';
}

/**
 * The portfolio as registry §2 binds it. Codes are in the registry document and
 * deliberately not repeated here - a code can be rebound, and duplicating it in
 * code creates a second source of truth that drifts silently. The script joins
 * these to live codes through `invite_snapshots`.
 */
export const REGISTERED_CHANNELS: readonly RegisteredChannel[] = [
  { id: 'LIST-DISBOARD-A', experiment: 'EXP-001', label: 'Disboard listing, copy A', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-DISBOARD-B', experiment: 'EXP-001', label: 'Disboard listing, copy B', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-DISCADIA', experiment: 'EXP-002', label: 'Discadia listing', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-DISCORDME', experiment: 'EXP-002', label: 'Discord.me listing', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-DISCORDHOME', experiment: 'EXP-002', label: 'DiscordHome listing', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-DISFORGE', experiment: 'EXP-002', label: 'Disforge listing', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  { id: 'LIST-HIVEINDEX', experiment: 'EXP-002', label: 'Hive Index listing', killRule: { kind: 'standard' }, activationTier: 'low', kind: 'channel' },
  // Wave 1 is the 5 members active in the last 21 days; 3 of 5 must create a
  // link or the ask itself has failed. Both numbers are EXP-003's, not ours.
  { id: 'REF', experiment: 'EXP-003', label: 'Member referral, wave 1', killRule: { kind: 'ask', asked: 5, minCreators: 3 }, activationTier: 'highest', kind: 'channel' },
  { id: 'PART', experiment: 'EXP-004', label: 'Partner joint game nights', killRule: { kind: 'per-partner', nightsPerPartner: 2, partnersBeforeChannelKill: 3 }, activationTier: 'high', kind: 'channel' },
  { id: 'CONT-YTSHORTS', experiment: 'EXP-005', label: 'Short-form clips, YouTube Shorts', killRule: { kind: 'output-then-am30', outputWeeks: 4, am30Weeks: 8 }, activationTier: 'medium', kind: 'channel' },
  { id: 'CONT-TIKTOK', experiment: 'EXP-005', label: 'Short-form clips, TikTok', killRule: { kind: 'output-then-am30', outputWeeks: 4, am30Weeks: 8 }, activationTier: 'medium', kind: 'channel' },
  { id: 'CONT-REDDIT', experiment: 'EXP-005', label: 'Game-subreddit profile invite', killRule: { kind: 'output-then-am30', outputWeeks: 4, am30Weeks: 8 }, activationTier: 'medium', kind: 'channel' },
  { id: 'WEB-HOMEPAGE', experiment: 'EXP-006', label: 'Website join button', killRule: { kind: 'never' }, activationTier: 'unknown', kind: 'instrumentation' },
  { id: 'PAID', experiment: 'EXP-008', label: 'Paid listing placement', killRule: { kind: 'locked' }, activationTier: 'unknown', kind: 'channel' },
  // Not channels. Present so their joins are never silently folded into one
  // that is - registry §3 and §6 are both explicit that these get their own row.
  { id: 'ORGANIC-MEMBER', experiment: '-', label: 'Member invites made before the referral ask', killRule: { kind: 'never' }, activationTier: 'unknown', kind: 'reporting-bucket' },
  { id: 'LEGACY-ORGANIC', experiment: '-', label: 'Pre-campaign invite links', killRule: { kind: 'never' }, activationTier: 'unknown', kind: 'reporting-bucket' },
];

/**
 * One channel, one week. The funnel half comes from `rollUp()` in
 * src/analytics/attribution.ts; the cost half comes from the effort file,
 * because nothing in the database has ever recorded an agent-hour.
 */
export interface ChannelWeek {
  channelId: string;
  /** UTC Monday of the week, `YYYY-MM-DD`. */
  weekStart: string;
  joins: number;
  /** Of `joins`, how many were placed on this code rather than observed on it. */
  joinsInexact: number;
  am7: number;
  /** Joins old enough to have had their 7 days. */
  am7Eligible: number;
  am30: number;
  /**
   * AM7 members old enough to have had their 30 days. Note this counts AM7
   * members, not joins - so a channel where nobody activated has an empty AM30
   * denominator by construction, which is a RESULT and not immaturity. See the
   * maturity branch in `assess()`, which turns on exactly that distinction.
   */
  am30Eligible: number;
  /**
   * Hours worked on this channel this week. `null` means NOT RECORDED, which is
   * different from zero in every way that matters: zero is evidence the channel
   * was neglected, null is the absence of evidence about anything. The verdict
   * function will not kill on either, and says which one it saw.
   */
  agentHours: number | null;
  /** Cash in pence. Same null-vs-zero distinction. £0 is the registered plan. */
  cashPence: number | null;
  /** Listing bumps expected this week, when the channel is a listing. */
  bumpsExpected?: number;
  bumpsDone?: number;
  /** EXP-005 only: were clips actually produced and posted this week? */
  outputProduced?: boolean;
}

/** Whether a week counts toward the kill window, and why not when it does not. */
export function weekIsValid(w: ChannelWeek): { valid: boolean; reason?: string } {
  if (w.bumpsExpected !== undefined && w.bumpsExpected > 0) {
    const done = w.bumpsDone ?? 0;
    const compliance = done / w.bumpsExpected;
    if (compliance < BUMP_COMPLIANCE_FLOOR) {
      return {
        valid: false,
        reason: `bump compliance ${done}/${w.bumpsExpected} is below ${Math.round(BUMP_COMPLIANCE_FLOOR * 100)}% - this week measures our bump discipline, not the listing (EXP-001)`,
      };
    }
  }
  return { valid: true };
}

/** A channel's trailing window, already collapsed. */
export interface ChannelWindow {
  channelId: string;
  /** Weeks that count toward a kill decision. */
  validWeeks: number;
  /** Weeks dropped, with the reason each was dropped. */
  invalidWeeks: { weekStart: string; reason: string }[];
  joins: number;
  joinsInexact: number;
  am7: number;
  /** Joins matured past day 7. The denominator a kill actually needs. */
  am7Eligible: number;
  am30: number;
  am30Eligible: number;
  /** Summed across weeks that recorded a number. */
  agentHours: number;
  cashPence: number;
  /** True if EVERY week left effort unrecorded - the absence-of-evidence case. */
  effortUnrecorded: boolean;
  /** EXP-005: did any week in the window actually produce and post output? */
  outputProduced: boolean;
}

/** Collapse a channel's weeks into the window the rules read. */
export function windowOf(channelId: string, weeks: ChannelWeek[]): ChannelWindow {
  const mine = weeks.filter((w) => w.channelId === channelId);
  const win: ChannelWindow = {
    channelId,
    validWeeks: 0,
    invalidWeeks: [],
    joins: 0,
    joinsInexact: 0,
    am7: 0,
    am7Eligible: 0,
    am30: 0,
    am30Eligible: 0,
    agentHours: 0,
    cashPence: 0,
    effortUnrecorded: mine.length > 0,
    outputProduced: false,
  };

  for (const w of mine) {
    const { valid, reason } = weekIsValid(w);
    if (valid) win.validWeeks++;
    else win.invalidWeeks.push({ weekStart: w.weekStart, reason: reason! });

    // Funnel numbers accumulate from EVERY week, valid or not. An invalidated
    // week still delivered whatever it delivered; invalidating it withholds the
    // right to conclude from it, and deleting its joins would be a different and
    // much stranger claim.
    win.joins += w.joins;
    win.joinsInexact += w.joinsInexact;
    win.am7 += w.am7;
    win.am7Eligible += w.am7Eligible;
    win.am30 += w.am30;
    win.am30Eligible += w.am30Eligible;

    if (w.agentHours !== null) {
      win.agentHours += w.agentHours;
      win.effortUnrecorded = false;
    }
    if (w.cashPence !== null) {
      win.cashPence += w.cashPence;
      win.effortUnrecorded = false;
    }
    if (w.outputProduced) win.outputProduced = true;
  }

  return win;
}

/**
 * Cost per activated member, as a pair. Never a scalar - see the COST note in
 * the header. `null` on either half means the denominator is zero, i.e. the
 * channel has produced no AM30: that is the kill signal, not a ranking value,
 * and returning Infinity would let it sort as merely "expensive".
 */
export interface CostPerAm30 {
  hoursPerAm30: number | null;
  cashPencePerAm30: number | null;
  /** The denominator, so nothing quotes the rate without it. Ledger §1. */
  am30: number;
}

export function costPerAm30(win: ChannelWindow): CostPerAm30 {
  if (win.am30 <= 0) return { hoursPerAm30: null, cashPencePerAm30: null, am30: 0 };
  return {
    hoursPerAm30: win.agentHours / win.am30,
    cashPencePerAm30: win.cashPence / win.am30,
    am30: win.am30,
  };
}

export type Verdict =
  /** Best cost-per-AM30 in the portfolio. Gets double effort next cycle. */
  | 'SCALE'
  /** Running, producing, not the best. Carry on. */
  | 'CONTINUE'
  /** A decision is not available yet, and the reason says which one is missing. */
  | 'HOLD'
  /** Delivered too few people to conclude anything about intent. Distribution failure. */
  | 'KILL-no-traffic'
  /** Delivered people who never activated. Intent failure - the dangerous one. */
  | 'KILL-no-activation'
  /** EXP-003 only: the ask itself failed. Points at the server, not the channel. */
  | 'KILL-ask-failed'
  /** EXP-004 only: this partner is done; the channel is not. */
  | 'STOP-partner'
  /** Cannot be killed by registration. EXP-006, and the reporting buckets. */
  | 'NOT-A-BET';

export interface Assessment {
  channelId: string;
  experiment: string;
  verdict: Verdict;
  /** One sentence, quoting the numbers that produced it. */
  reason: string;
  cost: CostPerAm30;
  /**
   * True when the verdict rests only on columns that are exact. A window with
   * placed rather than observed joins can still be killed - see `assess()` -
   * but its cost-per-AM30 must not be quoted or ranked.
   */
  costIsHard: boolean;
}

/** Extra facts the standing rule cannot get from the funnel. */
export interface AssessInput {
  /** EXP-003: how many of the asked members created a link at all. */
  referralLinkCreators?: number;
  /** EXP-004: nights run with the current partner, and partners exhausted so far. */
  partnerNights?: number;
  partnersWithZeroAm30?: number;
  /** EXP-005: weeks since this channel started, for the 8-week AM30 check. */
  weeksLive?: number;
}

/**
 * Apply the pre-registered rules to one channel's window.
 *
 * Order matters and is not arbitrary. Registration beats data (a channel that
 * cannot be killed is never killed, whatever it did); maturity beats effort (a
 * two-week window is not evidence about anything, so there is no point asking
 * whether we worked it); effort beats result (0 AM30 from an unworked channel
 * is a fact about us). Only then does the result decide.
 */
export function assess(
  channel: RegisteredChannel,
  win: ChannelWindow,
  input: AssessInput = {},
): Assessment {
  const cost = costPerAm30(win);
  // Soft attribution mixes members BETWEEN codes; it never changes the total
  // set. So a zero stays a zero on every row - kills survive it - while any
  // non-zero rate might belong to the code next door. EXP-002 spells this out.
  const costIsHard = win.joinsInexact === 0;
  const base = { channelId: channel.id, experiment: channel.experiment, cost, costIsHard };
  const held = (reason: string): Assessment => ({ ...base, verdict: 'HOLD', reason });

  if (channel.kind !== 'channel') {
    return {
      ...base,
      verdict: 'NOT-A-BET',
      reason:
        channel.kind === 'instrumentation'
          ? `${channel.id} is instrumentation, not a bet - it exists so website arrivals stop being attributed to \`unknown\` (EXP-006). It has no threshold and cannot be killed.`
          : `${channel.id} is a reporting bucket, not a channel (registry §3/§6). Its joins are real and are never credited to a campaign.`,
    };
  }

  switch (channel.killRule.kind) {
    case 'never':
      return { ...base, verdict: 'NOT-A-BET', reason: `${channel.id} is registered as unkillable.` };

    case 'locked':
      return {
        ...base,
        verdict: 'HOLD',
        reason: `${channel.experiment} is locked - no budget exists, £0 spent, no code created. Nothing is running to score.`,
      };

    case 'ask': {
      const { asked, minCreators } = channel.killRule;
      const creators = input.referralLinkCreators;
      if (creators === undefined) {
        return held(
          `the referral ask has not been made, so nobody has been asked to create a link. ${channel.experiment} is killed on the ask, never on AM30 - with ${asked} members asked, 0 AM30 would mean ${asked} is too few to conclude anything.`,
        );
      }
      if (creators < minCreators) {
        return {
          ...base,
          verdict: 'KILL-ask-failed',
          reason: `${creators} of ${asked} asked members created a link, below the pre-registered ${minCreators}. That is a real signal and it points at the anchor event and the state of the server, not at referral as a channel.`,
        };
      }
      // The ask held, so this channel has no other kill condition. It must NOT
      // fall through to the standing rule: "kill only if the ask fails" is
      // exhaustive, and the whole point of the override is that 0 AM30 from 5
      // people is not evidence about referral either way.
      return {
        ...base,
        verdict: 'CONTINUE',
        reason: `${creators} of ${asked} asked members created a link, so the ask held; ${win.am30} AM30 of ${win.am30Eligible} matured. ${channel.experiment} is killed only on the ask, never on AM30 - ${asked} members is too few for an activation result to mean anything.`,
      };
    }

    case 'per-partner': {
      const { nightsPerPartner, partnersBeforeChannelKill } = channel.killRule;
      const nights = input.partnerNights ?? 0;
      const exhausted = input.partnersWithZeroAm30 ?? 0;
      if (exhausted >= partnersBeforeChannelKill && win.am30 === 0) {
        return {
          ...base,
          verdict: 'KILL-no-activation',
          reason: `${exhausted} different partners have each produced 0 AM30, which is the registered bar for killing the channel rather than a partner.`,
        };
      }
      if (nights >= nightsPerPartner && win.am30 === 0) {
        return {
          ...base,
          verdict: 'STOP-partner',
          reason: `${nights} joint nights with this partner and 0 AM30. Stop with this partner; the channel stands until ${partnersBeforeChannelKill} partners have failed (${exhausted} so far).`,
        };
      }
      if (nights === 0) {
        return held(
          `no joint night has been run. ${channel.experiment} is measured per night, and Stage-2 vetting is blocked on a human with a Discord account.`,
        );
      }
      // Nights have run and either produced AM30 or not yet reached the
      // per-partner bar. No fall-through to the standing rule: EXP-004's unit
      // is the partner, and the standing 4-week rule would kill the channel on
      // one partner's bad fortnight.
      return win.am30 > 0
        ? {
            ...base,
            verdict: 'CONTINUE',
            reason: `${win.am30} AM30 of ${win.am30Eligible} matured over ${nights} joint night(s). One AM30 from a night is the registered success bar - book a second night with this partner.`,
          }
        : held(
            `${nights} of ${nightsPerPartner} nights with this partner and 0 AM30 so far. A partner is not judged until the second night, and the channel not until ${partnersBeforeChannelKill} partners have failed (${exhausted} so far).`,
          );
    }

    case 'output-then-am30': {
      const { outputWeeks, am30Weeks } = channel.killRule;
      const live = input.weeksLive ?? win.validWeeks;
      if (live < am30Weeks) {
        // The deliberate override: four weeks cannot conclude anything about
        // content, so the 4-week check is on output and AM30 waits for 8.
        if (live >= outputWeeks && !win.outputProduced) {
          return {
            ...base,
            verdict: 'KILL-no-traffic',
            reason: `${live} weeks live and no clip was produced or posted. ${channel.experiment} checks OUTPUT at ${outputWeeks} weeks and AM30 only at ${am30Weeks} - this fails the output check, which is a failure to run the experiment rather than a result from it.`,
          };
        }
        return held(
          `${live} of ${am30Weeks} weeks. ${channel.experiment} overrides the standing rule on purpose: content is the one channel where four weeks genuinely cannot conclude anything, so its AM30 check runs at ${am30Weeks} weeks.`,
        );
      }
      break;
    }

    case 'standard':
      break;
  }

  // --- the standing rule -----------------------------------------------------

  if (win.validWeeks < KILL_WINDOW_WEEKS) {
    const dropped = win.invalidWeeks.length;
    return held(
      `${win.validWeeks} of ${KILL_WINDOW_WEEKS} valid weeks${dropped ? `, ${dropped} dropped (${win.invalidWeeks.map((i) => i.reason).join('; ')})` : ''}. Never kill on less than the full window - at this volume a bad week and a bad channel look identical.`,
    );
  }

  if (win.effortUnrecorded) {
    return held(
      `no effort was recorded for any week in the window, so "sustained effort" cannot be tested. 0 AM30 with unknown effort is not evidence about this channel. Record hours in data/growth-effort.json and re-run.`,
    );
  }

  if (win.agentHours < SUSTAINED_EFFORT_HOURS && win.cashPence === 0) {
    return held(
      `${win.agentHours.toFixed(1)} agent-hours over ${win.validWeeks} weeks is below the ${SUSTAINED_EFFORT_HOURS}-hour bar for sustained effort. 0 AM30 here is a fact about us, not about the channel - this is HOLD-no-effort, and killing it would let neglect masquerade as a negative result.`,
    );
  }

  if (win.am30 > 0) {
    return {
      ...base,
      verdict: 'CONTINUE',
      reason: `${win.am30} AM30 of ${win.am30Eligible} matured, on ${win.agentHours.toFixed(1)} agent-hours and £${(win.cashPence / 100).toFixed(2)}. Producing; ranked against the portfolio for the scale decision.`,
    };
  }

  // 0 AM30, full window, sustained effort. The only place a kill is issued.
  //
  // Maturity is tested on AM7-ELIGIBLE JOINS, not on `am30Eligible`.
  // `am30Eligible` counts AM7 members old enough to have had their 30 days, so
  // a channel where nobody activated has an empty AM30 denominator BY
  // CONSTRUCTION - which is precisely the KILL-no-activation case. Guarding on
  // it would make that verdict unreachable forever, and the channel it exists
  // to catch would hold on "not matured yet" for as long as anyone kept
  // running the review. Caught by the first live smoke run rather than by any
  // of the unit tests, which is why one real call was worth more than the
  // twenty-one green assertions above it.
  if (win.am7Eligible === 0) {
    return held(
      `${win.joins} joins, none of which has had its 7 days yet, so nobody has had the chance to activate. A kill needs a matured cohort, not just a matured calendar.`,
    );
  }

  const matured = `${win.am7Eligible} of ${win.joins} joins matured past day 7`;
  return win.joins < KILL_TRAFFIC_SPLIT_JOINS
    ? {
        ...base,
        verdict: 'KILL-no-traffic',
        reason: `${win.joins} joins (< ${KILL_TRAFFIC_SPLIT_JOINS}) and 0 AM30, ${matured}, on ${win.agentHours.toFixed(1)} sustained agent-hours. A distribution failure: the channel did not deliver people.`,
      }
    : {
        ...base,
        verdict: 'KILL-no-activation',
        reason: `${win.joins} joins (>= ${KILL_TRAFFIC_SPLIT_JOINS}) and 0 AM30, ${matured}, on ${win.agentHours.toFixed(1)} sustained agent-hours. An intent failure - it delivered people who never activated, which is the dangerous one, because the join count reads as success.`,
      };
}

/**
 * Why the portfolio could not be ranked, when it could not be.
 *
 * `mixed-cash` is the dimensional problem in the header: once a channel carries
 * cash, the order depends on an hours-to-pounds rate nobody has registered, and
 * picking one here would put an invented number under the decision that hands
 * out double effort.
 */
export type RankBlocker = 'no-producers' | 'mixed-cash' | 'soft-attribution';

export interface Ranking {
  /** Rankable entries, cheapest cost-per-AM30 first. Empty when blocked. */
  ordered: Assessment[];
  /** The scale winner, or null. */
  scale: Assessment | null;
  blockers: { blocker: RankBlocker; detail: string }[];
}

export interface RankOptions {
  /**
   * Pence per agent-hour, for the day cash exists. Deliberately not defaulted:
   * an unregistered default would silently decide the ranking the first week
   * somebody spends money.
   */
  hourlyRatePence?: number;
}

/**
 * Rank the portfolio and name the scale winner.
 *
 * Only channels that produced AM30 are rankable - a cost-per-AM30 with a zero
 * denominator is not a large number, it is not a number - and only ones whose
 * rows are hard, because §1 forbids quoting an activation rate off a `~` row and
 * this rate decides who gets double effort.
 */
export function rankPortfolio(assessments: Assessment[], opts: RankOptions = {}): Ranking {
  const blockers: Ranking['blockers'] = [];

  const producers = assessments.filter((a) => a.cost.am30 > 0);
  if (producers.length === 0) {
    blockers.push({
      blocker: 'no-producers',
      detail: 'no channel has produced a single AM30, so cost-per-AM30 has a zero denominator everywhere. There is nothing to rank and nothing to scale.',
    });
    return { ordered: [], scale: null, blockers };
  }

  const soft = producers.filter((a) => !a.costIsHard);
  if (soft.length > 0) {
    blockers.push({
      blocker: 'soft-attribution',
      detail: `${soft.map((a) => a.channelId).join(', ')} carry joins that were placed rather than observed, so their AM30 may belong to another code. Ledger §1 forbids quoting an activation rate off those rows; excluded from the ranking. Raise capture cadence to separate them (registry §5).`,
    });
  }
  const hard = producers.filter((a) => a.costIsHard);
  if (hard.length === 0) return { ordered: [], scale: null, blockers };

  const withCash = hard.filter((a) => (a.cost.cashPencePerAm30 ?? 0) > 0);
  if (withCash.length > 0 && opts.hourlyRatePence === undefined) {
    blockers.push({
      blocker: 'mixed-cash',
      detail: `${withCash.map((a) => a.channelId).join(', ')} carry cash, so hours and pounds must be combined to rank - and the ledger's "(agent-hours + cash) ÷ AM30" adds hours to pounds, which has no unit. Supply an agreed pence-per-agent-hour rate, registered in the ledger before it is used.`,
    });
    return { ordered: [], scale: null, blockers };
  }

  // Every channel at £0: cash is a constant, so ordering on hours alone gives
  // the same order as any combined figure. Exact, and needs no rate.
  const rate = opts.hourlyRatePence ?? 0;
  const total = (a: Assessment) => (a.cost.hoursPerAm30 ?? 0) * rate + (a.cost.cashPencePerAm30 ?? 0);
  const key = (a: Assessment) =>
    withCash.length > 0 ? total(a) : (a.cost.hoursPerAm30 ?? 0);

  const ordered = [...hard].sort((a, b) => key(a) - key(b) || a.channelId.localeCompare(b.channelId));
  return { ordered, scale: ordered[0] ?? null, blockers };
}

/**
 * Step 5: where did the hours actually go?
 *
 * The predictable failure mode named in `roadmap-30d` §9 - listings are the
 * easiest thing to do and the least likely to produce an activated member, so
 * effort drifts onto them while referral and partners are neglected. A result
 * table cannot see this: a portfolio can look fine on results while every hour
 * went to the channel ranked 5th of 6 on activation.
 */
export interface EffortAllocation {
  totalHours: number;
  byTier: Record<RegisteredChannel['activationTier'], number>;
  listingShare: number;
  highActivationShare: number;
  findings: string[];
  /** True when hours were recorded at all. Everything above is meaningless without it. */
  recorded: boolean;
}

export function effortAllocation(
  windows: ChannelWindow[],
  channels: readonly RegisteredChannel[] = REGISTERED_CHANNELS,
): EffortAllocation {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const byTier: EffortAllocation['byTier'] = { highest: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  let totalHours = 0;
  let anyRecorded = false;

  for (const w of windows) {
    const c = byId.get(w.channelId);
    if (!c) continue;
    if (!w.effortUnrecorded) anyRecorded = true;
    byTier[c.activationTier] += w.agentHours;
    totalHours += w.agentHours;
  }

  const findings: string[] = [];
  if (!anyRecorded || totalHours === 0) {
    findings.push(
      'No agent-hours are recorded for any channel, so effort allocation cannot be checked. This is the check `roadmap-30d` §9 asks for and it is the one input nothing in the system captures - record hours per channel per week in data/growth-effort.json.',
    );
    return { totalHours, byTier, listingShare: 0, highActivationShare: 0, findings, recorded: false };
  }

  const listingShare = byTier.low / totalHours;
  const highActivationShare = (byTier.highest + byTier.high) / totalHours;

  if (listingShare > LISTING_EFFORT_CEILING) {
    findings.push(
      `Listings took ${Math.round(listingShare * 100)}% of ${totalHours.toFixed(1)} recorded agent-hours, above the ${Math.round(LISTING_EFFORT_CEILING * 100)}% ceiling. They are ranked 5th of 6 on expected activation and 1st on convenience; this is the drift roadmap-30d §9 predicts.`,
    );
  }
  if (highActivationShare < HIGH_ACTIVATION_EFFORT_FLOOR) {
    findings.push(
      `Referral and partners took ${Math.round(highActivationShare * 100)}% of recorded agent-hours, below the ${Math.round(HIGH_ACTIVATION_EFFORT_FLOOR * 100)}% floor. They are the two highest-activation channels in the portfolio and they are being starved.`,
    );
  }
  if (findings.length === 0) {
    findings.push(
      `Effort is within the registered bounds: listings ${Math.round(listingShare * 100)}% (ceiling ${Math.round(LISTING_EFFORT_CEILING * 100)}%), referral+partners ${Math.round(highActivationShare * 100)}% (floor ${Math.round(HIGH_ACTIVATION_EFFORT_FLOOR * 100)}%), over ${totalHours.toFixed(1)} hours.`,
    );
  }

  return { totalHours, byTier, listingShare, highActivationShare, findings, recorded: true };
}

/**
 * EXP-008: has any free channel earned the RIGHT TO ASK for spend?
 *
 * Not a trigger. Reaching the bar obliges nobody to spend anything and
 * authorises no agent to commit a penny - approval is per-proposal and there is
 * no standing cap. What it produces is permission to write four specific things
 * down and put them in front of the CEO.
 */
export interface PaidAskStatus {
  earned: boolean;
  /** Channels at or above the bar, free ones only. */
  qualifying: string[];
  bestFreeAm30: number;
  /**
   * Whether a proposal could actually be assembled. Item 1 of the ask needs the
   * measured cost-per-AM30 of EVERY free channel then running, and §1 bans
   * quoting that off a soft row - so an unowned capture cadence blocks the
   * proposal, not just the scaling decision. Stated in EXP-008 and easy to miss.
   */
  proposalAssemblable: boolean;
  detail: string;
}

export function paidAskStatus(
  assessments: Assessment[],
  channels: readonly RegisteredChannel[] = REGISTERED_CHANNELS,
): PaidAskStatus {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const free = assessments.filter((a) => {
    const c = byId.get(a.channelId);
    return c?.kind === 'channel' && (a.cost.cashPencePerAm30 ?? 0) === 0;
  });
  const qualifying = free.filter((a) => a.cost.am30 >= PAID_ASK_AM30).map((a) => a.channelId);
  const bestFreeAm30 = free.reduce((n, a) => Math.max(n, a.cost.am30), 0);
  const running = free.filter((a) => a.cost.am30 > 0);
  const proposalAssemblable = running.length > 0 && running.every((a) => a.costIsHard);

  if (qualifying.length === 0) {
    return {
      earned: false,
      qualifying,
      bestFreeAm30,
      proposalAssemblable,
      detail: `no free channel has reached ${PAID_ASK_AM30} AM30 (best: ${bestFreeAm30}). EXP-008 stays LOCKED, £0 spent, no code created.`,
    };
  }
  return {
    earned: true,
    qualifying,
    bestFreeAm30,
    proposalAssemblable,
    detail: proposalAssemblable
      ? `${qualifying.join(', ')} reached ${PAID_ASK_AM30}+ AM30. That earns the RIGHT TO ASK and nothing else - write the four-part proposal (every free channel's measured cost-per-AM30, the spend as amount and duration, what it should buy in AM30, and the result that would cut it) and put it to the CEO. No agent commits cash without approval of that specific proposal.`
      : `${qualifying.join(', ')} reached ${PAID_ASK_AM30}+ AM30, but the proposal cannot be assembled: item 1 needs every free channel's measured cost-per-AM30 and some rows are soft. Raise capture cadence until one code moves per window, then draft it.`,
  };
}
