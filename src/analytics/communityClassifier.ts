export const COMMUNITY_CLASSIFICATIONS = [
  'eligible_human',
  'bot',
  'webhook',
  'staff_automation',
  'raid',
  'staging',
  'test',
] as const;

export type CommunityClassification = (typeof COMMUNITY_CLASSIFICATIONS)[number];

export interface CommunityClassificationResult {
  classification: CommunityClassification;
  classifierVersion: string;
  matchedRule: string;
}

export interface CommunityClassifierInput {
  guildId: string;
  actorId: string;
  isBot?: boolean;
  webhookId?: string | null;
  isStaffAutomation?: boolean;
  isRaid?: boolean;
  isStaging?: boolean;
  isTest?: boolean;
}

export interface CommunityClassifierConfig {
  version: string;
  automationActorIds: ReadonlySet<string>;
  raidActorIds: ReadonlySet<string>;
  stagingGuildIds: ReadonlySet<string>;
  stagingActorIds: ReadonlySet<string>;
  testActorIds: ReadonlySet<string>;
}

export class CommunityClassifier {
  private config: CommunityClassifierConfig;

  constructor(config: CommunityClassifierConfig) {
    this.config = config;
  }

  get version(): string {
    return this.config.version;
  }

  classify(input: CommunityClassifierInput): CommunityClassificationResult {
    const result = (classification: CommunityClassification, matchedRule: string) => ({
      classification,
      classifierVersion: this.config.version,
      matchedRule,
    });

    // Contract precedence is deliberate. A Discord bot posting through a webhook
    // is a bot bucket, not two exclusions, so reconciliation remains exact.
    if (input.isBot) return result('bot', 'discord_bot');
    if (input.webhookId) return result('webhook', 'discord_webhook');
    if (input.isStaffAutomation || this.config.automationActorIds.has(input.actorId)) {
      return result('staff_automation', 'configured_automation_actor');
    }
    if (input.isRaid || this.config.raidActorIds.has(input.actorId)) {
      return result('raid', 'configured_raid_actor');
    }
    if (
      input.isStaging ||
      this.config.stagingGuildIds.has(input.guildId) ||
      this.config.stagingActorIds.has(input.actorId)
    ) {
      return result('staging', 'configured_staging_scope');
    }
    if (input.isTest || this.config.testActorIds.has(input.actorId)) {
      return result('test', 'configured_test_actor');
    }
    return result('eligible_human', 'no_exclusion_matched');
  }
}

function ids(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export function loadCommunityClassifierConfig(
  env: NodeJS.ProcessEnv = process.env,
): CommunityClassifierConfig {
  return {
    version: env.TWO_COMMUNITY_CLASSIFIER_VERSION || 'community-v1',
    automationActorIds: ids(env.TWO_COMMUNITY_AUTOMATION_ACTOR_IDS),
    raidActorIds: ids(env.TWO_COMMUNITY_RAID_ACTOR_IDS),
    stagingGuildIds: ids(env.TWO_COMMUNITY_STAGING_GUILD_IDS),
    stagingActorIds: ids(env.TWO_COMMUNITY_STAGING_ACTOR_IDS),
    testActorIds: ids(env.TWO_COMMUNITY_TEST_ACTOR_IDS),
  };
}
