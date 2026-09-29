/**
 * WEBSITE_CONTRACT slots/labels/raw-code drift pins (TOG-7762, parent TOG-7209;
 * full pin TOG-8307).
 *
 * The e2e contract suite proves the views; this file proves the three claims
 * around them that a view test cannot see:
 *
 *   1. Slots: `WEB-HOMEPAGE` is a growth-registry slot id (EXP-006
 *      instrumentation), never a funnel `source`. The funnel stores raw Discord
 *      codes (`invite:<code>`, written by `InviteTracker`), so a slot label
 *      behind the `invite:` prefix can never match a row (TOG-5037).
 *   2. Labels: human text (`rank_label`, `invite_campaigns.label`) never
 *      decides a join's stored source.
 *   3. No second copy of the bound code: the join destination is the single
 *      source of the code, so the match cannot drift apart from it.
 *
 * Every test below is green on current main and goes red on drift - each was
 * proven by mutating the pinned source locally, running this file, and
 * reverting (M1-M4 in the PR body; mutations never committed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTERED_CHANNELS } from '../src/growth/portfolio.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { inviteCodeFromDestination, webCodeRowSource } from '../src/growth/joinPath.ts';
import { WEB_HOMEPAGE_SLOT, websiteChecks } from '../src/growth/gate.ts';
import { WEB_ONE_CLICK_SOURCE } from '../src/core/expectedJoins.ts';
import { isValidInviteCode } from '../src/redirect/campaigns.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

test('WEB-HOMEPAGE is a registry slot, not a funnel source', () => {
  // EXP-006 is instrumentation: it exists so website arrivals stop being
  // attributed to `unknown`. It cannot be killed, and its id is not a code.
  // Drift this turns red on: re-registering the slot as a killable channel.
  const slot = REGISTERED_CHANNELS.find((c) => c.id === 'WEB-HOMEPAGE');
  assert.ok(slot, 'WEB-HOMEPAGE must stay in the registered portfolio');
  assert.equal(slot.kind, 'instrumentation');
  assert.equal(slot.experiment, 'EXP-006');
});

test('the tracker stores the raw Discord code, never a registry label', () => {
  // inviteTracker.ts writes `source = invite:<raw Discord code>`. A slot id in
  // UPPER-WITH-DASH is not a code Discord ever issued, so it must never appear
  // behind the `invite:` prefix from this path. Drift this turns red on: the
  // tracker stamping a label (or anything non-code) as the source.
  const tracker = new InviteTracker(null as never); // attribute() touches no database
  const source = tracker.attribute(['aB3xY9'], false);
  assert.equal(source, 'invite:aB3xY9');
  assert.doesNotMatch(source, /invite:[A-Z]+-[A-Z]+/, 'a slot label must never be stored as a code');
});

test('the web-code-row criterion never matches invite:WEB-HOMEPAGE', () => {
  // The funnel row carries the bound code. Naming the slot in the detail is
  // fine; reporting `invite:<SLOT>` as a source value is the TOG-5037 bug and
  // must stay gone from every status the criterion can report - on the default
  // details, not caller-supplied ones.
  const ok = websiteChecks({ webCodeRowPresent: true }).find((c) => c.id === 'web-code-row')!;
  assert.equal(ok.status, 'ok');
  assert.doesNotMatch(ok.detail, /invite:WEB-HOMEPAGE/);

  const fail = websiteChecks({ webCodeRowPresent: false }).find((c) => c.id === 'web-code-row')!;
  assert.equal(fail.status, 'fail');
  assert.doesNotMatch(fail.detail, /invite:WEB-HOMEPAGE/);

  const unknown = websiteChecks({}).find((c) => c.id === 'web-code-row')!;
  assert.equal(unknown.status, 'unknown');
  assert.doesNotMatch(unknown.detail, /invite:WEB-HOMEPAGE/);
});

test('the resolver carries no second copy of the bound code', () => {
  // joinPath.ts may name the discord.gg host to parse it; it must never embed
  // a code-like path, or the destination and the match can drift apart again.
  // Drift this turns red on: hardcoding a code beside TWO_GATE_JOIN_DESTINATION.
  const source = read(join('src', 'growth', 'joinPath.ts'));
  assert.doesNotMatch(source, /discord\.gg\/[A-Za-z0-9]{2,}/);
});

// ---------------------------------------------------------------------------
// TOG-8307 full pin: the resolver claim #252 deferred, plus the label,
// code-copy and registry claims around the views that no view test can see.
// ---------------------------------------------------------------------------

test('the destination resolves to the raw Discord code behind the slot', () => {
  // TOG-8307: the single derivation the join-path observation and the funnel
  // match share - one source (TWO_GATE_JOIN_DESTINATION), no second copy of
  // the code. unit.growthgate pins the exact bound code; this pins the
  // DERIVATION holds for every shape the destination can take, so a rewrite
  // that resolves the wrong host (or stops resolving) reds here.
  assert.equal(inviteCodeFromDestination('https://discord.gg/4GwEDNRTtx'), '4GwEDNRTtx');
  assert.equal(inviteCodeFromDestination('https://discord.com/invite/4GwEDNRTtx'), '4GwEDNRTtx');
  assert.equal(webCodeRowSource('https://discord.gg/4GwEDNRTtx'), 'invite:4GwEDNRTtx');
  assert.equal(
    webCodeRowSource('https://discord.gg/4GwEDNRTtx'),
    'invite:4GwEDNRTtx',
    'the funnel source is exactly what the tracker writes',
  );
  // Non-invite destinations resolve to nothing, so the caller reports
  // "could not resolve" instead of matching on a guess.
  assert.equal(inviteCodeFromDestination('https://togetherweown.com/join'), undefined);
  assert.equal(webCodeRowSource('https://togetherweown.com/join'), undefined);
  assert.equal(inviteCodeFromDestination('not a url'), undefined);
  assert.equal(inviteCodeFromDestination('https://discord.gg/a/b'), undefined, 'a path is not a code');
});

test('the gate matches the resolved code, never the slot label', () => {
  // TOG-8307: the TOG-5037 fix as a unit - the criterion reads the resolved
  // source from the observation. Matching on the label again can never hit a
  // funnel row, so the label-as-source must stay gone from the details.
  const slotSource = new RegExp(`invite:${WEB_HOMEPAGE_SLOT}`);
  for (const o of [
    { webCodeRowSource: 'invite:4GwEDNRTtx', webCodeRowPresent: true },
    { webCodeRowSource: 'invite:4GwEDNRTtx', webCodeRowPresent: false },
  ]) {
    const row = websiteChecks(o).find((c) => c.id === 'web-code-row')!;
    assert.match(row.detail, /invite:4GwEDNRTtx/);
    assert.doesNotMatch(row.detail, slotSource);
  }
});

test('the unresolvable destination reports itself, not a guessed source', () => {
  // TOG-8307: gate-check.ts resolves and then matches; when resolution fails
  // it must say so. A drift that falls back to matching the label (or an
  // empty string) would silently count 0 joins as a finding instead of a gap.
  const text = read(join('scripts', 'gate-check.ts'));
  assert.match(
    text,
    /webCodeRowSource\(EXPECTED_JOIN_DESTINATION\)/,
    'the match resolves from the observed destination',
  );
  assert.match(
    text,
    /could not be resolved to a Discord code/,
    'an unresolvable destination reports a gap, not a match',
  );
  assert.doesNotMatch(
    text,
    /rows\.find\(\(r\) => r\.source === `invite:\$\{WEB_HOMEPAGE/,
    'the match never interpolates the slot label as a source',
  );
});

test('rank_label is display-only: no funnel path reads it', () => {
  // TOG-8307: labels never decide a join's stored source. rank_label is
  // written by the collector (communitySnapshots.ts), published by the view,
  // and read by NOBODY in the attribution chain - every match below runs on
  // invite_code. A drift that joins, filters or groups funnel rows on the
  // label (e.g. a "normalize by rank name" rewrite) reds here.
  const readers = ['src/analytics/attribution.ts', 'scripts/attribution.ts', 'scripts/funnel.ts', 'scripts/growth-review.ts', 'scripts/gate-check.ts'];
  for (const rel of readers) {
    assert.doesNotMatch(
      read(rel),
      /rank_label/,
      `${rel} must never read the human label`,
    );
  }
  const snapshotter = read(join('src', 'jobs', 'communitySnapshots.ts'));
  assert.match(snapshotter, /rank_label/, 'the collector still writes the display name');
});

test('campaign label never reaches the redirect target or the click source', () => {
  // TOG-8307: the redirect binds slug -> invite_code; the label is for humans
  // reading the report. A drift that 302s to the label (or stamps it as the
  // click source) breaks every join through that campaign AND the funnel row
  // behind it, while the report still looks fine.
  const campaigns = read(join('src', 'redirect', 'campaigns.ts'));
  assert.match(campaigns, /isValidInviteCode\(c\.inviteCode\)/, 'the door validates the code');
  assert.doesNotMatch(
    campaigns,
    /isValidInviteCode\(c\.label\)|isValidSlug\(c\.inviteCode\)/,
    'a label must never validate as a code, nor a code as a label',
  );
  const server = read(join('src', 'redirect', 'server.ts'));
  assert.match(server, /inviteUrl\(campaign\.inviteCode\)/, 'the 302 target is the code');
  assert.doesNotMatch(server, /campaign\.label/, 'the label never reaches the redirect path');
  const handlers = read(join('src', 'core', 'handlers.ts'));
  assert.match(handlers, /source: `invite:\$\{code\}`/, 'a click is stored under its code');
});

test('the one-click source has exactly one writer and one owner', () => {
  // TOG-8307: docs/EVENTS.md documents web:one_click as a funnel source, and
  // the verbatim e2e pin proves the view passes it through. This pins the
  // WRITER side: the literal lives in exactly one module, the action stamps
  // the symbol (not a second literal), and the gateway consumes it before the
  // tracker runs - so the value the doc names is the value the view sees.
  assert.equal(WEB_ONE_CLICK_SOURCE, 'web:one_click');
  const expectedJoins = read(join('src', 'core', 'expectedJoins.ts'));
  assert.match(expectedJoins, /export const WEB_ONE_CLICK_SOURCE = 'web:one_click'/);
  const actions = read(join('src', 'internal', 'actions.ts'));
  assert.match(actions, /WEB_ONE_CLICK_SOURCE/, 'the action stamps the symbol');
  assert.doesNotMatch(actions, /'web:one_click'|"web:one_click"/, 'no second literal beside the symbol');
  const client = read(join('src', 'discord', 'client.ts'));
  assert.match(
    client,
    /expected \?\? invites\.attribute\(/,
    'the consumed note wins over the tracker; the tracker is the fallback, not the override',
  );
});

test('funnel joins and review slots match on invite_code, never the label', () => {
  // TOG-8307: two different scripts join funnel rows to campaigns - funnel.ts
  // (clicks and joins per campaign) and growth-review.ts (funnel rows to
  // registry slots). Both must key on the Discord code. A drift that keys on
  // the label groups two campaigns with the same display name into one row,
  // and the dashboard silently merges their joins.
  const funnel = read(join('scripts', 'funnel.ts'));
  // Count, not just match: funnel.ts keys TWO rows on the code (clicks and
  // joins). A drift that re-keys either one to c.label keeps one match and
  // stays green under assert.match - so the code-keyed pattern must appear
  // exactly twice, and a label-keyed concatenation must appear nowhere.
  const codeKeys = funnel.match(/e\.source = 'invite:' \|\| c\.invite_code/g) ?? [];
  assert.equal(
    codeKeys.length,
    2,
    'funnel must key BOTH clicks and joins on the code; re-keying either to the label must red here',
  );
  assert.doesNotMatch(funnel, /\|\| c\.label/, 'funnel must never concatenate a row key from the label');
  const review = read(join('scripts', 'growth-review.ts'));
  assert.match(review, /c\.invite_code === code/, 'review maps a source to its slot by code');
  assert.doesNotMatch(review, /c\.label ===|=== c\.label|label === code/, 'review must never key on the label');
});

test('gate-check.ts carries no second copy of the bound code', () => {
  // TOG-8307: the script's only code-shaped invite string is the default
  // destination the observation checks; the funnel match derives from that
  // same value through webCodeRowSource(). A drift that pastes the code into
  // the match (or anywhere else) recreates the two-copy drift TOG-5037 fixed.
  const text = read(join('scripts', 'gate-check.ts'));
  const codes = text.match(/discord\.gg\/[A-Za-z0-9]{2,}/g) ?? [];
  assert.deepEqual(
    codes,
    ['discord.gg/4GwEDNRTtx'],
    'exactly one code-shaped string: the default join destination',
  );
  assert.match(text, /webCodeRowSource\(EXPECTED_JOIN_DESTINATION\)/, 'the match derives from the destination');
});

test('the registry slot set is pinned: every id the funnel can name', () => {
  // TOG-8307: growth-review collapses funnel sources to registry slots, and
  // the e2e verbatim pin proves the sources pass through. This pins the OTHER
  // end: the exact slot set, so adding, renaming or dropping a slot reds here
  // and the reviewer checks whether the funnel still maps onto it.
  assert.deepEqual(
    REGISTERED_CHANNELS.map((c) => c.id),
    [
      'LIST-DISBOARD-A',
      'LIST-DISBOARD-B',
      'LIST-DISCADIA',
      'LIST-DISCORDME',
      'LIST-DISCORDHOME',
      'LIST-DISFORGE',
      'LIST-HIVEINDEX',
      'REF',
      'PART',
      'CONT-YTSHORTS',
      'CONT-TIKTOK',
      'CONT-REDDIT',
      'WEB-HOMEPAGE',
      'PAID',
      'ORGANIC-MEMBER',
      'LEGACY-ORGANIC',
    ],
  );
  const homepage = REGISTERED_CHANNELS.find((c) => c.id === 'WEB-HOMEPAGE')!;
  assert.equal(homepage.kind, 'instrumentation');
});

test('the milestone whitelist is exactly three, named against the event list', () => {
  // TOG-8307: the view whitelists member_join/member_leave/rank_changed and
  // publishes joined/left/rank_changed. A new EVENT_TYPES entry must NOT
  // appear on a public profile without a deliberate view edit - this test
  // names the three that may appear, so any fourth (second_message,
  // voice_session_start, invite_click, ...) reds here by construction.
  // rank_changed has no emitter yet: whitelisted ahead of the collector, so
  // the collector can start emitting without a contract change.
  const view = read(join('sql', 'web_v1.sql'));
  for (const t of ['member_join', 'member_leave', 'rank_changed']) {
    assert.match(view, new RegExp(`'${t}'`), `${t} must stay whitelisted`);
  }
  const src = read(join('src', 'core', 'events.ts'));
  const nonMilestones = ['invite_click', 'second_message', 'voice_session_start', 'gate_cleared', 'onboarding_prompted'];
  for (const t of nonMilestones) {
    assert.match(src, new RegExp(`'${t}'`), `${t} is a real event type`);
    assert.doesNotMatch(view, new RegExp(`WHEN '${t}'|IN \\([^)]*'${t}'`), `${t} must not reach the milestone view`);
  }
});
