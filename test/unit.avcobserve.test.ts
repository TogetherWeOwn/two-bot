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
import type { ExerciseEvidence } from '../ops/auto-voice/exercise.ts';

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
    exercise: {
      createdRoom: { id: '900', name: 'Squad #1', parentId: '100' },
      createMs: 366,
      movedMs: 392,
      deleteMs: 152,
      residualRoomId: null,
    },
  };

  assert.equal(evaluate(input).verdict, 'PASS');
  assert.deepEqual(
    evaluate(input).checks.filter((c) => !c.ok),
    [],
  );
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
    ['generator_present', 'lobby_untouched', 'avc_alive', 'room_reclaimed'],
  );
});

/* --------------------------------------------------- TOG-3126: liveness half */

/**
 * The defect these are here for: every check above is satisfied by a guild the
 * AVC container stopped touching days ago, because a Discord channel object
 * outlives the process watching it. A seven-day streak built out of those ticks
 * measures "nothing bad is visible", not "AVC ran clean".
 */

const LIVE_GUILD: Omit<TickInput, 'exercise'> = {
  categoryId: '100',
  generatorId: '200',
  lobbyId: '300',
  channels: [
    { id: '100', type: 4, name: '🔊 VOICE', parent_id: null },
    { id: '300', type: 2, name: 'Lobby', parent_id: '100' },
    { id: '200', type: 2, name: '➕ Join to Create', parent_id: '100' },
  ],
  voiceStates: [],
};

const HEALTHY_CYCLE: ExerciseEvidence = {
  createdRoom: { id: '900', name: 'Squad #1', parentId: '100' },
  createMs: 366,
  movedMs: 392,
  deleteMs: 152,
  residualRoomId: null,
};

test('the exact tree TOG-3044 describes, with AVC offline, is a FAIL', () => {
  // This input PASSed before TOG-3126 - it is the live 🔊 VOICE tree with
  // nobody in voice, which is what the guild looks like on a quiet day whether
  // or not anything is running. Only the exercise can tell those apart.
  const result = evaluate({
    ...LIVE_GUILD,
    exercise: { createdRoom: null, createMs: null, movedMs: null, deleteMs: null, residualRoomId: null },
  });

  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(
    result.checks.filter((c) => !c.ok).map((c) => c.name),
    ['avc_alive', 'room_reclaimed'],
  );
  assert.deepEqual(
    result.checks.filter((c) => c.ok).map((c) => c.name),
    ['generator_present', 'lobby_untouched', 'no_ghost_rooms'],
  );
});

test('the same tree with a witnessed create/destroy cycle is a PASS', () => {
  const result = evaluate({ ...LIVE_GUILD, exercise: HEALTHY_CYCLE });

  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.checks.filter((c) => !c.ok), []);
  assert.deepEqual(result.exercise, HEALTHY_CYCLE);
});

test('a tick that skipped the exercise cannot pass', () => {
  // Forgetting to run the positive half must fail closed, not default to the
  // pre-TOG-3126 behaviour of passing on absence of harm.
  const result = evaluate(LIVE_GUILD);

  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.checks.find((c) => c.name === 'avc_alive' && !c.ok));
  assert.equal(result.exercise, null);
});

test('a room created outside the category is not proof AVC is behaving', () => {
  const result = evaluate({
    ...LIVE_GUILD,
    exercise: { ...HEALTHY_CYCLE, createdRoom: { id: '900', name: 'Squad #1', parentId: '777' } },
  });

  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.checks.find((c) => c.name === 'avc_alive' && !c.ok));
});

test('a room created but never joined is not a room somebody was in', () => {
  const result = evaluate({ ...LIVE_GUILD, exercise: { ...HEALTHY_CYCLE, movedMs: null } });

  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.checks.find((c) => c.name === 'avc_alive' && !c.ok));
});

test('a room we caused and AVC never reclaimed is a ghost, even at zero ghosts observed', () => {
  // The observation half ran before the exercise, so it correctly reports no
  // ghosts; the leak shows up only in the cycle. Both halves are needed.
  const result = evaluate({
    ...LIVE_GUILD,
    exercise: { ...HEALTHY_CYCLE, deleteMs: null, residualRoomId: '900' },
  });

  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.ghosts, []);
  assert.deepEqual(
    result.checks.filter((c) => !c.ok).map((c) => c.name),
    ['room_reclaimed'],
  );
});
