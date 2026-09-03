/**
 * The §7 note store: guild.add_member writes "expect a join for this member",
 * the gateway consumes it. docs/INTERNAL_ACTIONS.md §7, src/core/expectedJoins.ts.
 *
 * Everything with a clock in it is here, on an injected clock - the wiring
 * (note actually beats the invite diff on a real gateway event) is in
 * unit.joinwiring.test.ts, and the action taking the note at all is asserted
 * in e2e.internalactions.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExpectedJoins, WEB_ONE_CLICK_SOURCE } from '../src/core/expectedJoins.ts';

const GUILD = '326474832151838730';
const MEMBER = '900000000000001111';

test('a noted join is consumed once, with its source', () => {
  const ej = new ExpectedJoins();
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  assert.equal(ej.consume(GUILD, MEMBER), 'web:one_click');
  // One join consumes one note: a rejoin next week is an ordinary join.
  assert.equal(ej.consume(GUILD, MEMBER), null);
});

test('an unannounced join gets no source', () => {
  const ej = new ExpectedJoins();
  assert.equal(ej.consume(GUILD, MEMBER), null);
});

test('notes are scoped to guild and member', () => {
  const ej = new ExpectedJoins();
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  assert.equal(ej.consume(GUILD, '900000000000002222'), null);
  assert.equal(ej.consume('999999999999999999', MEMBER), null);
  assert.equal(ej.consume(GUILD, MEMBER), 'web:one_click');
});

test('a note expires after 30 seconds', () => {
  let t = 1_000_000;
  const ej = new ExpectedJoins({ now: () => t });
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);

  t += 29_999;
  assert.equal(ej.consume(GUILD, MEMBER), 'web:one_click', 'still fresh at 29.999s');

  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  t += 30_000;
  assert.equal(ej.consume(GUILD, MEMBER), null, 'gone at 30s');
});

test('a fresh note replaces a stale one for the same member', () => {
  let t = 0;
  const ej = new ExpectedJoins({ now: () => t });
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  t += 60_000; // first attempt failed; the site retried
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  t += 1_000;
  assert.equal(ej.consume(GUILD, MEMBER), 'web:one_click');
});

test('expired notes are swept, so the map stays bounded', () => {
  let t = 0;
  const ej = new ExpectedJoins({ now: () => t });
  for (let i = 0; i < 50; i++) ej.expect(GUILD, `90000000000000${1000 + i}`, WEB_ONE_CLICK_SOURCE);
  assert.equal(ej.size, 50);
  t += 30_000;
  ej.expect(GUILD, MEMBER, WEB_ONE_CLICK_SOURCE);
  assert.equal(ej.size, 1, 'the 50 expired notes were dropped on the next write');
});
