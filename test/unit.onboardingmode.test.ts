import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsForOnboardingMode,
  levelRoleWritesForOnboardingMode,
} from '../src/onboarding/mode.ts';
import type { ActionName } from '../src/internal/actions.ts';

const enabled = new Set<ActionName>(['role.assign', 'announcement.post', 'event.upsert']);

test('session onboarding removes role.assign from internal actions', () => {
  assert.deepEqual(
    [...actionsForOnboardingMode('session', enabled)].sort(),
    ['announcement.post', 'event.upsert'],
  );
});

test('legacy onboarding leaves internal actions unchanged', () => {
  assert.deepEqual([...actionsForOnboardingMode('legacy', enabled)].sort(), [...enabled].sort());
});

test('session onboarding suppresses leveling reward role writes', () => {
  assert.equal(levelRoleWritesForOnboardingMode('session'), false);
});

test('legacy onboarding still applies leveling reward roles', () => {
  assert.equal(levelRoleWritesForOnboardingMode('legacy'), true);
});
