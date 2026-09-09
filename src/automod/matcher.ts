import { createHmac, randomBytes } from 'node:crypto';
import type { AutomodFilter, AutomodMessage, AutomodPolicy } from './types.ts';

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[-\w]+/iu;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/giu;
const TRAILING_URL_PUNCTUATION = /[>),.!?:;]+$/u;
const ZERO_WIDTH = /[​-‍⁠﻿]/gu;

export interface RepeatTracker {
  observe(message: AutomodMessage, normalizedContent: string, policy: AutomodPolicy): boolean;
}

export class MemoryRepeatTracker implements RepeatTracker {
  private rows = new Map<string, Array<{ messageId: string; digest: string; at: number }>>();
  private expiries = new Map<string, NodeJS.Timeout>();
  private digestKey = randomBytes(32);

  observe(message: AutomodMessage, normalizedContent: string, policy: AutomodPolicy): boolean {
    if (!normalizedContent) return false;
    const key = `${message.guildId}:${message.authorId}`;
    const windowMs = policy.repeatedMessageWindowSeconds * 1000;
    const cutoff = message.createdTimestamp - windowMs;
    const recent = (this.rows.get(key) ?? []).filter((row) => row.at >= cutoff);
    const existing = recent.findIndex((row) => row.messageId === message.messageId);
    if (existing >= 0) recent.splice(existing, 1);
    const digest = createHmac('sha256', this.digestKey).update(normalizedContent).digest('hex');
    recent.push({ messageId: message.messageId, digest, at: message.createdTimestamp });
    this.rows.set(key, recent.slice(-policy.repeatedMessageCount));
    this.scheduleExpiry(key, windowMs);
    return recent.filter((row) => row.digest === digest).length >= policy.repeatedMessageCount;
  }

  private scheduleExpiry(key: string, windowMs: number): void {
    const old = this.expiries.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.rows.delete(key);
      this.expiries.delete(key);
    }, windowMs);
    timer.unref();
    this.expiries.set(key, timer);
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
  // Only explicit mentions in message content are supplied here. Discord's
  // implicit reply reference does not count unless the author actually pinged it.
  if (message.mentionedUserIds.length >= policy.mentionLimit) return 'mention_spam';
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
    const word = normalize(raw).replace(ZERO_WIDTH, '').replace(/\s+/g, '');
    if (!word) continue;
    const escaped = [...word]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\u200B-\\u200D\\u2060\\uFEFF]*');
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu').test(content)) return true;
  }
  return false;
}

function hasExternalLink(content: string, allowedDomains: string[]): boolean {
  for (const match of content.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, '');
    try {
      const parsed = candidate.startsWith('www.') ? `https://${candidate}` : candidate;
      const host = new URL(parsed).hostname.toLowerCase().replace(/^www\./, '');
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
