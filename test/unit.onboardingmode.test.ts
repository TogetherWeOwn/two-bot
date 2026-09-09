import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsForOnboardingMode } from '../src/onboarding/mode.ts';
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
