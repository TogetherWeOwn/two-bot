import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assess,
  costPerAm30,
  effortAllocation,
  paidAskStatus,
  rankPortfolio,
  weekIsValid,
  windowOf,
  KILL_WINDOW_WEEKS,
  PAID_ASK_AM30,
  REGISTERED_CHANNELS,
  SUSTAINED_EFFORT_HOURS,
  type Assessment,
  type ChannelWeek,
  type ChannelWindow,
  type RegisteredChannel,
} from '../src/growth/portfolio.ts';

/**
 * Every one of these pins a way the weekly review could quietly go wrong. The
 * rules were registered before any data existed, which is the whole point - so
 * the tests have to hold whether or not a channel has ever run.
 */

function channel(id: string): RegisteredChannel {
  const c = REGISTERED_CHANNELS.find((x) => x.id === id);
  assert.ok(c, `${id} is not in the registered portfolio`);
  return c;
}

/** A worked, matured, zero-result window: the only shape a kill is allowed on. */
function killable(over: Partial<ChannelWindow> = {}): ChannelWindow {
  return {
    channelId: 'LIST-DISCADIA',
    validWeeks: KILL_WINDOW_WEEKS,
    invalidWeeks: [],
    joins: 0,
    joinsInexact: 0,
    am7: 0,
    am7Eligible: 6,
    am30: 0,
    am30Eligible: 0,
    agentHours: 4,
    cashPence: 0,
    effortUnrecorded: false,
    outputProduced: false,
    ...over,
  };
}

function week(over: Partial<ChannelWeek> = {}): ChannelWeek {
  return {
    channelId: 'LIST-DISCADIA',
    weekStart: '2026-09-07',
    joins: 0,
    joinsInexact: 0,
    am7: 0,
    am7Eligible: 0,
    am30: 0,
    am30Eligible: 0,
    agentHours: 1,
    cashPence: 0,
    ...over,
  };
}

test('a channel is never killed on less than the full window', () => {
  for (let weeks = 0; weeks < KILL_WINDOW_WEEKS; weeks++) {
    const a = assess(channel('LIST-DISCADIA'), killable({ validWeeks: weeks, joins: 40 }));
    assert.equal(a.verdict, 'HOLD', `${weeks} weeks must not decide anything`);
    assert.match(a.reason, new RegExp(`${weeks} of ${KILL_WINDOW_WEEKS}`));
  }
  assert.equal(assess(channel('LIST-DISCADIA'), killable({ joins: 40 })).verdict, 'KILL-no-activation');
});

test('0 AM30 from an unworked channel is a fact about us, not a kill', () => {
  const neglected = assess(
    channel('LIST-DISCADIA'),
    killable({ joins: 40, agentHours: SUSTAINED_EFFORT_HOURS - 0.5 }),
  );
  assert.equal(neglected.verdict, 'HOLD');
  assert.match(neglected.reason, /sustained effort/);

  // Unrecorded is not the same as zero, and it gets its own sentence.
  const unknown = assess(
    channel('LIST-DISCADIA'),
    killable({ joins: 40, agentHours: 0, effortUnrecorded: true }),
  );
  assert.equal(unknown.verdict, 'HOLD');
  assert.match(unknown.reason, /no effort was recorded/);
});

test('the two kills are told apart on joins, not on feel', () => {
  const thin = assess(channel('LIST-DISCADIA'), killable({ joins: 4 }));
  assert.equal(thin.verdict, 'KILL-no-traffic');
  assert.match(thin.reason, /distribution failure/);

  const dead = assess(channel('LIST-DISCADIA'), killable({ joins: 5 }));
  assert.equal(dead.verdict, 'KILL-no-activation');
  assert.match(dead.reason, /intent failure/);
});

test('a matured calendar with an unmatured cohort cannot kill', () => {
  // Four weeks have passed but the joins arrived on Thursday: nobody has had
  // the chance to activate, and 0 out of nobody is not a result.
  const a = assess(channel('LIST-DISCADIA'), killable({ joins: 9, am7Eligible: 0 }));
  assert.equal(a.verdict, 'HOLD');
  assert.match(a.reason, /matured cohort/);
});

test('maturity is judged on joins past day 7, never on am30Eligible', () => {
  // The bug the first live run found. `am30Eligible` counts AM7 members old
  // enough to have had 30 days - so a channel where NOBODY activated has an
  // empty AM30 denominator by construction. Guarding maturity on it makes
  // KILL-no-activation unreachable forever: the exact channel the verdict
  // exists to catch would hold on "not matured yet" every week, permanently.
  const sixDeadJoins = killable({ joins: 6, am7: 0, am7Eligible: 6, am30: 0, am30Eligible: 0 });
  const a = assess(channel('LIST-DISCADIA'), sixDeadJoins);
  assert.equal(a.verdict, 'KILL-no-activation');
  assert.match(a.reason, /6 of 6 joins matured past day 7/);
});

test('a soft row can still be killed - it cannot be scaled', () => {
  // Soft attribution moves members between codes; it never changes the total,
  // so a zero is a zero on every row.
  const soft = assess(channel('LIST-DISCADIA'), killable({ joins: 12, joinsInexact: 12 }));
  assert.equal(soft.verdict, 'KILL-no-activation');
  assert.equal(soft.costIsHard, false);

  const producing = assess(
    channel('LIST-DISFORGE'),
    killable({ channelId: 'LIST-DISFORGE', joins: 12, joinsInexact: 12, am30: 4, am30Eligible: 12 }),
  );
  assert.equal(producing.verdict, 'CONTINUE');
  const ranked = rankPortfolio([producing]);
  assert.equal(ranked.scale, null, 'a ~ row must never win the scale decision');
  assert.ok(ranked.blockers.some((b) => b.blocker === 'soft-attribution'));
});

test('cost-per-AM30 with no AM30 is absent, not infinite', () => {
  const c = costPerAm30(killable({ agentHours: 20 }));
  assert.equal(c.hoursPerAm30, null);
  assert.equal(c.cashPencePerAm30, null);
  assert.equal(c.am30, 0);
  // Infinity would sort as merely "expensive" and could be beaten by a worse
  // channel; null keeps it out of the ranking entirely.
  assert.ok(!Number.isFinite(c.hoursPerAm30 as unknown as number));
});

test('the scale winner is the cheapest hours-per-AM30, and only among producers', () => {
  const mk = (id: string, hours: number, am30: number): Assessment => ({
    channelId: id,
    experiment: 'EXP-002',
    verdict: 'CONTINUE',
    reason: '',
    cost: { hoursPerAm30: am30 ? hours / am30 : null, cashPencePerAm30: am30 ? 0 : null, am30 },
    costIsHard: true,
  });
  const r = rankPortfolio([mk('A', 12, 2), mk('B', 6, 3), mk('C', 30, 0)]);
  assert.deepEqual(r.ordered.map((a) => a.channelId), ['B', 'A']);
  assert.equal(r.scale?.channelId, 'B');
});

test('hours and pounds are never summed without a registered rate', () => {
  const cash: Assessment = {
    channelId: 'PAID',
    experiment: 'EXP-008',
    verdict: 'CONTINUE',
    reason: '',
    cost: { hoursPerAm30: 1, cashPencePerAm30: 500, am30: 4 },
    costIsHard: true,
  };
  const free: Assessment = {
    channelId: 'REF',
    experiment: 'EXP-003',
    verdict: 'CONTINUE',
    reason: '',
    cost: { hoursPerAm30: 3, cashPencePerAm30: 0, am30: 2 },
    costIsHard: true,
  };
  const blocked = rankPortfolio([cash, free]);
  assert.equal(blocked.scale, null);
  assert.ok(blocked.blockers.some((b) => b.blocker === 'mixed-cash'));

  // With a rate supplied the ranking is available again: 1h @ £2 + £5 = £7 per
  // AM30 for PAID, against 3h @ £2 = £6 for REF.
  const ranked = rankPortfolio([cash, free], { hourlyRatePence: 200 });
  assert.equal(ranked.scale?.channelId, 'REF');
});

test('an all-free portfolio ranks exactly, with no rate at all', () => {
  // Cash is a constant at zero, so hours alone give the same order any combined
  // figure would. This is the case that actually obtains while EXP-008 is locked.
  const mk = (id: string, hoursPerAm30: number): Assessment => ({
    channelId: id,
    experiment: 'EXP-002',
    verdict: 'CONTINUE',
    reason: '',
    cost: { hoursPerAm30, cashPencePerAm30: 0, am30: 3 },
    costIsHard: true,
  });
  const r = rankPortfolio([mk('A', 9), mk('B', 2)]);
  assert.equal(r.scale?.channelId, 'B');
  assert.deepEqual(r.blockers, []);
});

test('an empty portfolio ranks nothing and scales nothing', () => {
  // The state on every red-gate Friday. It must say "nothing to rank", not
  // hand double effort to whichever row sorted first.
  const r = rankPortfolio([]);
  assert.equal(r.scale, null);
  assert.deepEqual(r.ordered, []);
  assert.ok(r.blockers.some((b) => b.blocker === 'no-producers'));
});

test('EXP-003 is killed on the ask, never on AM30', () => {
  const ref = channel('REF');
  // Zero result, fully worked, four weeks - the standard rule would kill it.
  const zero = killable({ channelId: 'REF', joins: 9 });
  assert.equal(assess(ref, zero, { referralLinkCreators: 4 }).verdict, 'CONTINUE');

  const failed = assess(ref, zero, { referralLinkCreators: 2 });
  assert.equal(failed.verdict, 'KILL-ask-failed');
  assert.match(failed.reason, /2 of 5/);

  // Un-asked is not failed.
  assert.equal(assess(ref, zero).verdict, 'HOLD');
});

test('EXP-004 stops a partner without killing the channel', () => {
  const part = channel('PART');
  const zero = killable({ channelId: 'PART', joins: 6 });

  const stopped = assess(part, zero, { partnerNights: 2, partnersWithZeroAm30: 1 });
  assert.equal(stopped.verdict, 'STOP-partner');

  const dead = assess(part, zero, { partnerNights: 2, partnersWithZeroAm30: 3 });
  assert.equal(dead.verdict, 'KILL-no-activation');
  assert.match(dead.reason, /3 different partners/);
});

test('EXP-005 checks output at 4 weeks and AM30 at 8', () => {
  const cont = channel('CONT-YTSHORTS');
  const zero = killable({ channelId: 'CONT-YTSHORTS', joins: 8 });

  const early = assess(cont, { ...zero, outputProduced: true }, { weeksLive: 5 });
  assert.equal(early.verdict, 'HOLD', 'clips exist, AM30 is not due until week 8');

  const noOutput = assess(cont, zero, { weeksLive: 5 });
  assert.equal(noOutput.verdict, 'KILL-no-traffic');
  assert.match(noOutput.reason, /failure to run the experiment/);

  const matured = assess(cont, { ...zero, outputProduced: true }, { weeksLive: 8 });
  assert.equal(matured.verdict, 'KILL-no-activation');
});

test('EXP-006 and the reporting buckets cannot be killed by any input', () => {
  for (const id of ['WEB-HOMEPAGE', 'ORGANIC-MEMBER', 'LEGACY-ORGANIC']) {
    const a = assess(channel(id), killable({ channelId: id, joins: 40, agentHours: 50 }));
    assert.equal(a.verdict, 'NOT-A-BET', `${id} must never be killed`);
  }
});

test('every registered channel gets a verdict, and no verdict is a kill by default', () => {
  // The nothing-has-run state, which is where the portfolio actually is.
  for (const c of REGISTERED_CHANNELS) {
    const a = assess(c, {
      channelId: c.id,
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
      effortUnrecorded: true,
      outputProduced: false,
    });
    assert.ok(!a.verdict.startsWith('KILL'), `${c.id} must not be killed before it runs`);
    assert.ok(a.reason.length > 0, `${c.id} must say why`);
  }
});

test('a low-compliance bump week is dropped, and dropping can only delay a kill', () => {
  assert.equal(weekIsValid(week({ bumpsExpected: 14, bumpsDone: 3 })).valid, false);
  assert.equal(weekIsValid(week({ bumpsExpected: 14, bumpsDone: 9 })).valid, true);
  assert.equal(weekIsValid(week()).valid, true, 'a non-listing week has no bump bar');

  // The dropped week's joins still count; only the right to conclude is withheld.
  const w = windowOf('LIST-DISCADIA', [
    week({ joins: 3, bumpsExpected: 14, bumpsDone: 1 }),
    week({ weekStart: '2026-09-14', joins: 2 }),
  ]);
  assert.equal(w.validWeeks, 1);
  assert.equal(w.invalidWeeks.length, 1);
  assert.equal(w.joins, 5);
});

test('unrecorded effort survives a window as unrecorded, and zero does not', () => {
  const none = windowOf('LIST-DISCADIA', [week({ agentHours: null, cashPence: null })]);
  assert.equal(none.effortUnrecorded, true);

  const zero = windowOf('LIST-DISCADIA', [week({ agentHours: 0, cashPence: 0 })]);
  assert.equal(zero.effortUnrecorded, false, '0 hours is a measurement; null is not');
});

test('effort allocation catches the drift onto listings', () => {
  const win = (channelId: string, agentHours: number): ChannelWindow =>
    killable({ channelId, agentHours, effortUnrecorded: false });

  const drifted = effortAllocation([
    win('LIST-DISCADIA', 8),
    win('LIST-DISFORGE', 6),
    win('REF', 1),
  ]);
  assert.equal(drifted.recorded, true);
  assert.ok(drifted.findings.some((f) => /Listings took/.test(f)));
  assert.ok(drifted.findings.some((f) => /starved/.test(f)));

  const balanced = effortAllocation([win('LIST-DISCADIA', 3), win('REF', 4), win('PART', 3)]);
  assert.ok(balanced.findings.every((f) => !/ceiling/.test(f) || /within the registered bounds/.test(f)));
});

test('effort allocation says so when no hours were recorded, rather than reporting 0%', () => {
  const a = effortAllocation([killable({ channelId: 'REF', agentHours: 0, effortUnrecorded: true })]);
  assert.equal(a.recorded, false);
  assert.match(a.findings[0], /cannot be checked/);
});

test('3 AM30 buys the right to ask, and nothing else', () => {
  const mk = (id: string, am30: number, hard = true): Assessment => ({
    channelId: id,
    experiment: 'EXP-002',
    verdict: 'CONTINUE',
    reason: '',
    cost: { hoursPerAm30: am30 ? 1 : null, cashPencePerAm30: am30 ? 0 : null, am30 },
    costIsHard: hard,
  });

  const below = paidAskStatus([mk('LIST-DISCADIA', PAID_ASK_AM30 - 1)]);
  assert.equal(below.earned, false);
  assert.match(below.detail, /LOCKED/);

  const earned = paidAskStatus([mk('LIST-DISCADIA', PAID_ASK_AM30)]);
  assert.equal(earned.earned, true);
  assert.match(earned.detail, /RIGHT TO ASK/);
  assert.ok(!/approved|authorised|proceed/i.test(earned.detail), 'reaching the bar authorises no spend');

  // Item 1 of the proposal needs every free channel's measured cost-per-AM30,
  // and that cannot be quoted off a soft row - so soft rows block the ask too.
  const soft = paidAskStatus([mk('LIST-DISCADIA', PAID_ASK_AM30 + 2), mk('LIST-DISFORGE', 2, false)]);
  assert.equal(soft.earned, true);
  assert.equal(soft.proposalAssemblable, false);
  assert.match(soft.detail, /cannot be assembled/);
});

test('PAID is held while it is locked, whatever the table says', () => {
  const a = assess(channel('PAID'), killable({ channelId: 'PAID', joins: 20, cashPence: 5000 }));
  assert.equal(a.verdict, 'HOLD');
  assert.match(a.reason, /locked/);
});
