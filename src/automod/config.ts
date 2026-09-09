import { LIVE_GUILD_ID } from '../staging/spec.ts';
import type { AutomodPolicy, AutomodSanction } from './types.ts';

const DEFAULT_BLOCKED_ATTACHMENTS = ['bat', 'cmd', 'com', 'exe', 'js', 'jse', 'msi', 'ps1', 'scr', 'vbs', 'wsf'];
const DEFAULT_SANCTIONS: AutomodSanction[] = [
  { violations: 1, action: 'delete' },
  { violations: 2, action: 'warn' },
  { violations: 3, action: 'timeout', timeoutSeconds: 600 },
];

export interface AutomodConfig {
  enabled: boolean;
  dryRun: boolean;
  policy: AutomodPolicy;
}

export function loadAutomodConfig(env: NodeJS.ProcessEnv = process.env): AutomodConfig {
  const enabled = env.TWO_AUTOMOD === '1';
  if (enabled && env.DISCORD_GUILD_ID?.trim() === LIVE_GUILD_ID) {
    throw new Error(
      `TWO_AUTOMOD=1 is staging-only and refuses the live TWO guild (${LIVE_GUILD_ID}). ` +
      'Live rollout requires a separately reviewed operator change.',
    );
  }
  const dryRun = env.TWO_AUTOMOD_ENFORCE !== '1';
  const policy: AutomodPolicy = {
    badWords: csv(env.TWO_AUTOMOD_BAD_WORDS).map(normalize).filter(Boolean),
    blockedAttachmentExtensions: csv(env.TWO_AUTOMOD_BLOCKED_ATTACHMENT_EXTENSIONS ?? DEFAULT_BLOCKED_ATTACHMENTS.join(','))
      .map((value) => value.toLowerCase().replace(/^\./, '')),
    allowedDomains: csv(env.TWO_AUTOMOD_ALLOWED_DOMAINS).map((value) => value.toLowerCase()),
    repeatedMessageCount: integer(env.TWO_AUTOMOD_REPEAT_COUNT, 3, 2, 20, 'TWO_AUTOMOD_REPEAT_COUNT'),
    repeatedMessageWindowSeconds: integer(env.TWO_AUTOMOD_REPEAT_WINDOW_SECONDS, 30, 1, 3600, 'TWO_AUTOMOD_REPEAT_WINDOW_SECONDS'),
    mentionLimit: integer(env.TWO_AUTOMOD_MENTION_LIMIT, 5, 1, 50, 'TWO_AUTOMOD_MENTION_LIMIT'),
    bypassRoleIds: snowflakes(env.TWO_AUTOMOD_BYPASS_ROLE_IDS, 'TWO_AUTOMOD_BYPASS_ROLE_IDS'),
    exemptChannelIds: snowflakes(env.TWO_AUTOMOD_EXEMPT_CHANNEL_IDS, 'TWO_AUTOMOD_EXEMPT_CHANNEL_IDS'),
    sanctions: parseSanctions(env.TWO_AUTOMOD_SANCTIONS),
  };
  return { enabled, dryRun, policy };
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function snowflakes(value: string | undefined, name: string): Set<string> {
  const values = new Set(csv(value));
  for (const id of values) {
    if (!/^\d{17,20}$/.test(id)) throw new Error(`${name} must contain Discord ids.`);
  }
  return values;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function parseSanctions(value: string | undefined): AutomodSanction[] {
  if (!value?.trim()) return DEFAULT_SANCTIONS;
  const sanctions = value.split(',').map((part) => {
    const [atRaw, actionRaw, secondsRaw] = part.trim().split(':');
    const violations = Number(atRaw);
    if (!Number.isInteger(violations) || violations < 1 || violations > 100) {
      throw new Error('TWO_AUTOMOD_SANCTIONS thresholds must be integers between 1 and 100.');
    }
    if (actionRaw === 'delete' || actionRaw === 'warn') {
      return { violations, action: actionRaw } satisfies AutomodSanction;
    }
    if (actionRaw === 'timeout') {
      return {
        violations,
        action: 'timeout' as const,
        timeoutSeconds: integer(secondsRaw, 600, 60, 28 * 24 * 60 * 60, 'automod timeout seconds'),
      };
    }
    throw new Error('TWO_AUTOMOD_SANCTIONS actions must be delete, warn, or timeout.');
  });
  sanctions.sort((a, b) => a.violations - b.violations);
  if (sanctions[0]?.violations !== 1) {
    throw new Error('TWO_AUTOMOD_SANCTIONS must start at violation 1.');
  }
  for (let i = 1; i < sanctions.length; i++) {
    if (sanctions[i - 1].violations === sanctions[i].violations) {
      throw new Error('TWO_AUTOMOD_SANCTIONS thresholds must be unique.');
    }
  }
  return sanctions;
}
