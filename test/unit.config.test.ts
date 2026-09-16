import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboardingMode } from '../src/core/config.ts';

test('onboarding mode accepts only the explicit legacy and session enum values', () => {
  assert.equal(parseOnboardingMode(''), 'legacy');
  assert.equal(parseOnboardingMode('legacy'), 'legacy');
  assert.equal(parseOnboardingMode('session'), 'session');

  for (const invalid of ['sessions', 'SESSION', ' session ', ' ']) {
    assert.throws(
      () => parseOnboardingMode(invalid),
      /TWO_ONBOARDING_MODE must be exactly "legacy" or "session"/,
    );
  }
});
