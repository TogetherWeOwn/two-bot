/**
 * The clean-slate structure accepted by the owner on TOG-1317 (2026-09-06,
 * confirmation `f99d1067`): copy, categories, channels, topics, and roles.
 *
 * Both provisioning scripts build from THIS file, so staging and the main
 * guild can never drift apart. The staging script reconciles destructively
 * (it deletes what is not wanted); the main-guild script is additive-only
 * because TOG-1313's removal gates are closed and nothing in the accepted
 * proposal removes a bot or an existing channel.
 *
 * Copy source: Community Platform Messaging Style & Tone Research (TOG-1329):
 * warm irreverence for positioning, recognition-not-scale for belonging,
 * action mode for onboarding, literal clarity for rules and operations.
 */

export const SERVER_DESCRIPTION =
  'An 18+ gaming clan since 1998. No application, no interview, no member number — join the Discord, play a session, and find out what it is like when people notice you came back.';
export const WELCOME_DESCRIPTION =
  'The internet has enough crowded rooms. This one is small on purpose: join, play, come back — that is the whole onboarding process.';
export const STARTER_MESSAGE =
  "**You're in — that was the whole application.** Tell us what you're playing, on what platform, and when you're usually around. Need a crew tonight? Post the game, platform, and start time in #looking-to-play, then claim a voice room when the party forms.";

export const TOPICS = {
  'start-here': 'Four rules, then the server is yours. There is no application, no interview, and no quiz — this page is the only gate. Say hello in #general when you are ready.',
  announcements: 'Important TWO news and scheduled events. Low-volume and read-only; if it is posted here, it matters.',
  general: 'The shared table for games, life, questionable strategies, and introductions. New here? Say hello and tell us what you play — this is a place where people notice who comes back.',
  'looking-to-play': 'Finding a group should not require a spreadsheet, three bots, and divine intervention. Post the game, the platform if it matters, and your start time; claim a voice room when the party forms.',
  'discord-updates': 'Discord Community and platform notices. Internal record; no conversation.',
  'moderation-log': 'Screening, anti-raid, report, and moderation actions. Internal evidence; no conversation.',
  'audit-log': 'Channel, role, configuration, and retained-bot events. Internal evidence; no conversation.',
  'voice-log': 'Voice join, leave, and session telemetry used for community-health metrics. Internal evidence; no conversation.',
} as const;

export const CATEGORIES = [
  { name: '👋 START HERE', channels: ['start-here', 'announcements'] },
  { name: '💬 COMMUNITY', channels: ['general', 'looking-to-play'] },
  { name: '🔊 VOICE', channels: ['Lobby', 'Squad'] },
  { name: '🔒 OPERATIONS', channels: ['discord-updates', 'moderation-log', 'audit-log', 'voice-log'] },
] as const;

export const RULES = [
  'Treat people with respect. Harassment, hate, threats, and targeted abuse are not allowed.',
  'Keep content legal and appropriate for an 18+ gaming community.',
  'No spam, scams, malicious links, raids, or unsolicited promotion.',
  "Follow moderator direction. If something feels unsafe, use Discord's report tools or contact the Owner directly.",
];

export const SCREENING_DESCRIPTION =
  'Accept the four community rules to enter TWO. This is the only membership gate — there is no application and nothing else to pass.';

export const OWNER_ROLE = {
  name: 'Owner',
  color: 0xd4af37,
  hoist: true,
  permissions: '0',
  mentionable: false,
};
export const MODERATOR_ROLE = {
  name: 'Moderator',
  color: 0x5865f2,
  hoist: true,
  permissions: String((1n << 1n) | (1n << 2n) | (1n << 13n) | (1n << 16n) | (1n << 28n) | (1n << 40n)),
  mentionable: false,
};

export const TEXT_CHANNEL_NAMES = new Set(Object.keys(TOPICS));
export const VOICE_CHANNEL_NAMES = new Set(['Lobby', 'Squad']);
export const PUBLIC_READ_ONLY = new Set(['start-here', 'announcements']);
export const OPERATIONS_CHANNEL_NAMES = new Set(['discord-updates', 'moderation-log', 'audit-log', 'voice-log']);
