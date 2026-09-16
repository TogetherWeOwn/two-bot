import {
  applicationIdFromToken,
  STAGING_BOT_APPLICATION_ID,
  TWO_STAGING_GUILD_ID,
} from '../staging/spec.ts';

/** Fail closed until a separately reviewed live rollout deliberately replaces this fence. */
export function assertSelfRoleStagingBoundary(guildId: string, token: string): void {
  const applicationId = applicationIdFromToken(token);
  if (guildId !== TWO_STAGING_GUILD_ID || applicationId !== STAGING_BOT_APPLICATION_ID) {
    throw new Error(
      `TOG-1646 is staging-only: expected guild ${TWO_STAGING_GUILD_ID} and application ${STAGING_BOT_APPLICATION_ID}; ` +
        `got guild ${guildId} and application ${applicationId ?? 'unknown'}.`,
    );
  }
}
