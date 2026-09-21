/** Derived milestones, not new raw streams in the community scorecard. */
export const ONBOARDING_FACT_TYPES = [
  'onboarding_rules_accepted',
  'onboarding_prompt_shown',
  'onboarding_prompt_acted',
  'onboarding_first_eligible_message',
  'onboarding_first_human_reply',
  'onboarding_reply_latency',
  'onboarding_seven_day_return',
] as const;

export type OnboardingFactType = (typeof ONBOARDING_FACT_TYPES)[number];
