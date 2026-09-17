/**
 * The Auto-Voice observation tick (TOG-3052 phase 1), which is the gate phase 2
 * (TOG-3062) unblocks on.
 *
 * The tick reads the live guild, so the states it exists to catch - a ghost
 * room, an adopted Lobby, a deleted generator - are states nobody can produce
 * on demand to check it with. Driving the evaluator through them here is the
 * only way to know a green tick means anything.
 *
 * The failure mode worth guarding is the flattering one: a tick that passes
 * because it looked at nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, evaluate, type TickInput } from '../ops/auto-voice/observe-tick.ts';

for (const fixture of FIXTURES) {
  test(`observation tick: ${fixture.name} -> ${fixture.expect}`, () => {
    assert.equal(evaluate(fixture.input).verdict, fixture.expect);
  });
}

test('every check is named, so a FAIL says which condition broke', () => {
  const ghost = FIXTURES.find((f) => f.name.startsWith('ghost:'));
  assert.ok(ghost, 'the ghost fixture is the one that must keep existing');

  const result = evaluate(ghost.input);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(
    result.checks.filter((c) => !c.ok).map((c) => c.name),
    ['no_ghost_rooms'],
  );
  assert.deepEqual(result.ghosts, [{ id: '401', name: 'Hangout #1' }]);
});

test('an occupied room is reported but is not a breach', () => {
  const occupiedCase = FIXTURES.find((f) => f.name === 'somebody is in a generated room');
  assert.ok(occupiedCase);

  const result = evaluate(occupiedCase.input);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.occupied, [{ id: '401', name: 'Hangout #1', members: 1 }]);
  assert.deepEqual(result.ghosts, []);
});

test('voice states in other channels do not make a ghost look occupied', () => {
  // The bug this is here for: counting occupancy across the guild rather than
  // per channel, which would mark every room occupied whenever anyone is in
  // any voice channel at all - and the tick would then never fail.
  const input: TickInput = {
    categoryId: '100',
    generatorId: '200',
    lobbyId: '300',
    channels: [
      { id: '100', type: 4, name: '🔊 VOICE', parent_id: null },
      { id: '300', type: 2, name: 'Lobby', parent_id: '100' },
      { id: '200', type: 2, name: '➕ Join to Create', parent_id: '100' },
      { id: '401', type: 2, name: 'Hangout #1', parent_id: '100' },
    ],
    voiceStates: [{ user_id: 'u1', channel_id: '300' }],
  };

  const result = evaluate(input);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.ghosts, [{ id: '401', name: 'Hangout #1' }]);
});

test('a voice channel outside the category is none of this tick’s business', () => {
  const input: TickInput = {
    categoryId: '100',
    generatorId: '200',
    lobbyId: '300',
    channels: [
      { id: '100', type: 4, name: '🔊 VOICE', parent_id: null },
      { id: '300', type: 2, name: 'Lobby', parent_id: '100' },
      { id: '200', type: 2, name: '➕ Join to Create', parent_id: '100' },
      { id: '999', type: 2, name: 'Staff Voice', parent_id: '888' },
    ],
    voiceStates: [],
  };

  assert.equal(evaluate(input).verdict, 'PASS');
});

test('an empty observation cannot pass - a guild with no generator is a FAIL', () => {
  // The vacuous green: snapshot() rejects rather than returning empty, but if a
  // caller ever hands the evaluator nothing, it must not read as "all clear".
  const result = evaluate({
    categoryId: '100',
    generatorId: '200',
    lobbyId: '300',
    channels: [],
    voiceStates: [],
  });

  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(
    result.checks.filter((c) => !c.ok).map((c) => c.name),
    ['generator_present', 'lobby_untouched'],
  );
});
