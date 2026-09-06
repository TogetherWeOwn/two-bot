/**
 * The gate rule is "all six, or red". These tests pin the two ways that rule
 * gets broken quietly.
 *
 * The first is partial credit: five green criteria and one failure reading as
 * "nearly there", which is how a Friday check turns into a Sunday event with a
 * broken welcome path. `event-go-no-go` §1 is explicit - five of six is red.
 *
 * The second is the dangerous one. Two criteria cannot be observed without a
 * live host, so the common case is an UNKNOWN rather than a fail. If unknown
 * counted as ok, the gate would go green the moment nobody could check it -
 * the check would be at its most permissive exactly when it is least informed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT_CODE,
  WEB_HOMEPAGE_CODE,
  allChecks,
  botChecks,
  failing,
  scoringLoopRuns,
  verdict,
  websiteChecks,
  type Observations,
} from '../src/growth/gate.ts';

/** Everything observably true - the only shape that may ever be green. */
const GREEN: Observations = {
  serviceActive: true,
  attributedJoins: 1,
  welcomeDelivered: true,
  domainLive: true,
  joinButtonWorks: true,
  webCodeRowPresent: true,
};

test('all six observably true is the only green', () => {
  const checks = allChecks(GREEN);
  assert.equal(checks.length, 6);
  assert.equal(verdict(checks), 'green');
  assert.equal(failing(checks).length, 0);
  assert.equal(EXIT_CODE.green, 0);
});

test('five of six is red, on every single one of the six', () => {
  const keys: (keyof Observations)[] = [
    'serviceActive',
    'attributedJoins',
    'welcomeDelivered',
    'domainLive',
    'joinButtonWorks',
    'webCodeRowPresent',
  ];
  for (const k of keys) {
    // `attributedJoins` is a count, so its false case is 0 rather than `false`.
    const broken: Observations = { ...GREEN, [k]: k === 'attributedJoins' ? 0 : false };
    const checks = allChecks(broken);
    assert.equal(verdict(checks), 'red', `${k} false should be red`);
    assert.equal(failing(checks).length, 1, `${k} should be the only failure`);
  }
});

test('an unmeasured criterion is unknown, and unknown is red - never green', () => {
  // The live case: nothing bound, nothing reachable, nothing observed.
  const checks = allChecks({});
  assert.equal(checks.length, 6);
  assert.ok(
    checks.every((c) => c.status === 'unknown'),
    'no observations means every criterion is unknown',
  );
  assert.equal(verdict(checks), 'red');
  assert.equal(EXIT_CODE.red, 1);
});

test('one unknown among five ok is still red', () => {
  const { serviceActive, ...rest } = GREEN;
  const checks = allChecks(rest);
  const unknowns = checks.filter((c) => c.status === 'unknown');
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0].id, 'bot-service');
  assert.equal(verdict(checks), 'red');
});

test('no bot criterion blames TOG-13 or systemctl for a deploy that shipped', () => {
  // TOG-13 closed 2026-09-06 - the bot runs as the Coolify container
  // `two-bot-dk`, never as a systemd unit. For one day this module answered
  // every bot criterion with "TOG-13 has not deployed one", which is a false
  // statement in the one artifact nobody is supposed to second-guess. An
  // unknown on the bot side must mean "we could not look", not "it never
  // shipped", so no bot-side text may name a closed card or the wrong tool.
  for (const o of [{} as Observations, { serviceActive: false, welcomeDelivered: false } as Observations]) {
    for (const c of botChecks(o)) {
      const text = `${c.title} ${c.detail} ${c.owner ?? ''} ${c.action ?? ''}`;
      assert.doesNotMatch(text, /TOG-13/, `${c.id} must not cite the closed TOG-13`);
      assert.doesNotMatch(text, /systemctl|systemd/i, `${c.id} must not cite systemctl - the bot is a container`);
    }
  }
});

test('zero attributed joins fails rather than reads as not-yet', () => {
  const [, join] = botChecks({ ...GREEN, attributedJoins: 0 });
  assert.equal(join.id, 'bot-attributed-join');
  assert.equal(join.status, 'fail');
  assert.match(join.detail, /0 joins carry an invite code/);
});

test('the zero-joins detail relays what was observed, not a remembered baseline', () => {
  // Someone re-litigates "but the funnel shows 3 joins" every time this is
  // reported, so the fail has to carry the shape of the table it read. An
  // empty table and three unattributed backfill rows are different findings
  // and the module must not flatten them into one sentence.
  const empty = botChecks({ attributedJoins: 0, funnelDetail: 'the events table holds no member_join rows at all.' })[1];
  assert.match(empty.detail, /no member_join rows at all/);

  const baseline = botChecks({
    attributedJoins: 0,
    funnelDetail: '3 join(s) on file, none carrying an invite code (backfill and vanity rows are attributed to nothing).',
  })[1];
  assert.equal(baseline.status, 'fail');
  assert.match(baseline.detail, /3 join\(s\) on file/);
  assert.match(baseline.detail, /backfill/);
});

test('an unreadable funnel is unknown, not zero joins', () => {
  // The distinction the module exists for: "we looked and found none" is a
  // fail someone owns; "we could not look" is not a finding at all.
  const [, join] = botChecks({ funnelDetail: 'TWO_DATABASE_URL is not bound.' });
  assert.equal(join.status, 'unknown');
  assert.match(join.detail, /TWO_DATABASE_URL/);
});

test('every criterion that is not ok names an owner and an action', () => {
  for (const o of [{} as Observations, { ...GREEN, domainLive: false, attributedJoins: 0 }]) {
    for (const c of failing(allChecks(o))) {
      assert.ok(c.owner, `${c.id} must name an owner`);
      assert.ok(c.action, `${c.id} must name an action`);
    }
  }
});

test('the website code row is about a funnel row, not a bound code', () => {
  const row = websiteChecks({ ...GREEN, webCodeRowPresent: false }).find((c) => c.id === 'web-code-row')!;
  assert.equal(row.status, 'fail');
  assert.match(row.detail, new RegExp(WEB_HOMEPAGE_CODE));
});

test('the scoring loop runs only on green', () => {
  assert.equal(scoringLoopRuns(verdict(allChecks(GREEN))), true);
  assert.equal(scoringLoopRuns(verdict(allChecks({}))), false);
  assert.equal(scoringLoopRuns(verdict(allChecks({ ...GREEN, domainLive: false }))), false);
});
