import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSelfRoleStagingBoundary } from '../src/selfRoles/stagingFence.ts';
import { LIVE_GUILD_ID, STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const tokenFor = (id: string) => `${Buffer.from(id).toString('base64url')}.mock.signature`;

test('self-role runtime accepts only the exact staging guild and application', () => {
  assert.doesNotThrow(() => assertSelfRoleStagingBoundary(TWO_STAGING_GUILD_ID, tokenFor(STAGING_BOT_APPLICATION_ID)));

  assert.throws(
    () => assertSelfRoleStagingBoundary(LIVE_GUILD_ID, tokenFor(STAGING_BOT_APPLICATION_ID)),
    /TOG-1646 is staging-only/,
  );
  assert.throws(
    () => assertSelfRoleStagingBoundary('1555555555555555555', tokenFor(STAGING_BOT_APPLICATION_ID)),
    /TOG-1646 is staging-only/,
  );
  assert.throws(
    () => assertSelfRoleStagingBoundary(TWO_STAGING_GUILD_ID, tokenFor('1555555555555555556')),
    /TOG-1646 is staging-only/,
  );
});
