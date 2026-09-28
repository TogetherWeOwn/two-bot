/**
 * WEBSITE_CONTRACT slots/labels/raw-code drift pins (TOG-7762, parent TOG-7209).
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
 *
 * The resolver pins (`inviteCodeFromDestination()` / `webCodeRowSource()` and
 * the gate matching the resolved source) land in the follow-up slice after
 * PR #184 merges ([TOG-5136](/TOG/issues/TOG-5136)) - asserting them here
 * would red CI on a main that still carries the TOG-5037 bug, by design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTERED_CHANNELS } from '../src/growth/portfolio.ts';
import { InviteTracker } from '../src/core/inviteTracker.ts';
import { websiteChecks } from '../src/growth/gate.ts';

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
