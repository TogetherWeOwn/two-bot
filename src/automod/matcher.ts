import { createHash } from 'node:crypto';
import type { AutomodFilter, AutomodMessage, AutomodPolicy } from './types.ts';

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[-\w]+/iu;
const URL_PATTERN = /https?:\/\/[^\s<]+/giu;

export interface RepeatTracker {
  observe(message: AutomodMessage, normalizedContent: string, policy: AutomodPolicy): boolean;
}

export class MemoryRepeatTracker implements RepeatTracker {
  private rows = new Map<string, Array<{ messageId: string; hash: string; at: number }>>();

  observe(message: AutomodMessage, normalizedContent: string, policy: AutomodPolicy): boolean {
    if (!normalizedContent) return false;
    const key = `${message.guildId}:${message.authorId}`;
    const cutoff = message.createdTimestamp - policy.repeatedMessageWindowSeconds * 1000;
    const recent = (this.rows.get(key) ?? []).filter((row) => row.at >= cutoff);
    const existing = recent.findIndex((row) => row.messageId === message.messageId);
    if (existing >= 0) recent.splice(existing, 1);
    const hash = createHash('sha256').update(normalizedContent).digest('hex');
    recent.push({ messageId: message.messageId, hash, at: message.createdTimestamp });
    this.rows.set(key, recent.slice(-policy.repeatedMessageCount));
    return recent.filter((row) => row.hash === hash).length >= policy.repeatedMessageCount;
  }
}

export function matchAutomod(
  message: AutomodMessage,
  policy: AutomodPolicy,
  repeats: RepeatTracker,
): AutomodFilter | null {
  const normalized = normalize(message.content);
  if (hasBadWord(normalized, policy.badWords)) return 'bad_words';
  if (repeats.observe(message, normalized, policy)) return 'repeated_message';
  if (new Set(message.mentionedUserIds).size >= policy.mentionLimit) return 'mention_spam';
  if (INVITE.test(message.content)) return 'invite_link';
  if (hasExternalLink(message.content, policy.allowedDomains)) return 'external_link';
  if (hasBlockedAttachment(message.attachmentNames, policy.blockedAttachmentExtensions)) return 'attachment_type';
  return null;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasBadWord(content: string, words: string[]): boolean {
  for (const raw of words) {
    const word = normalize(raw);
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu').test(content)) return true;
  }
  return false;
}

function hasExternalLink(content: string, allowedDomains: string[]): boolean {
  for (const match of content.matchAll(URL_PATTERN)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase().replace(/^www\./, '');
      if (!allowedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function hasBlockedAttachment(names: string[], blocked: string[]): boolean {
  const blockedSet = new Set(blocked.map((value) => value.toLowerCase().replace(/^\./, '')));
  return names.some((name) => {
    const part = name.toLowerCase().split('.').pop();
    return part ? blockedSet.has(part) : false;
  });
}
