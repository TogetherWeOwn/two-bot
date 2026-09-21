import type { RotaNoticeCandidate } from '../analytics/onboardingRota.ts';

/** Deterministic identity prefix for a rota fallback notice. */
export function rotaNoticeEntryId(guildId: string, memberId: string, actionId: string): string {
  return `rota-notice:${guildId}:${memberId}:${actionId}`;
}

export interface RotaNoticePayload {
  /** Stable deterministic delivery identity: one subject/action sends at most once. */
  entryId: string;
  /** The exact labeled message content; no member text is interpolated. */
  content: string;
  /** Suppressed mentions, always. */
  allowedMentions: { parse: [] };
}

/**
 * Labeled deterministic operations notice. Contains only the pseudonymous
 * member reference, the action link, elapsed minutes, destination and coverage
 * label. The pseudonym is an HMAC, not a handle or raw id; the action link is
 * assembled from validated snowflakes, never member-supplied text.
 */
export function formatRotaNotice(
  candidate: RotaNoticeCandidate,
  opts: { guildId: string; destinationChannelId: string },
): RotaNoticePayload {
  if (!/^\d{17,20}$/.test(opts.guildId) || !/^\d{17,20}$/.test(opts.destinationChannelId) ||
      !/^\d{17,20}$/.test(candidate.actionId) || !/^\d{17,20}$/.test(candidate.channelId) ||
      !/^[0-9a-f]{64}$/.test(candidate.memberId)) {
    throw new Error('Invalid rota notice candidate');
  }
  if (!Number.isFinite(candidate.elapsedSeconds) || candidate.elapsedSeconds < 0) {
    throw new Error('Invalid rota notice candidate');
  }
  const entryId = rotaNoticeEntryId(opts.guildId, candidate.memberId, candidate.actionId);
  const elapsedMinutes = Math.floor(candidate.elapsedSeconds / 60);
  const actionLink = `https://discord.com/channels/${opts.guildId}/${candidate.channelId}/${candidate.actionId}`;
  const content = [
    `rota-notice:${entryId};`,
    '**rota fallback notice** (bot)',
    `newcomer \`${candidate.memberId}\``,
    `first message ${actionLink}`,
    `${elapsedMinutes} min without a human reply`,
    `from <#${candidate.channelId}>`,
    `coverage \`${candidate.coverageBlock}\``,
  ].join(' · ');
  if (content.length > 2000) throw new Error('Rota notice exceeds Discord content length');
  return { entryId, content, allowedMentions: { parse: [] } };
}

/** Marker prefix check for recovery scans, mirroring hasAuditEventIdentity. */
export function hasRotaNoticeIdentity(content: string, entryId: string): boolean {
  return content.startsWith(`rota-notice:${entryId};`);
}
