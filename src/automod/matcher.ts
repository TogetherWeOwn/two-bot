import { createHmac, randomBytes } from 'node:crypto';
import type { AutomodFilter, AutomodMessage, AutomodPolicy } from './types.ts';

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[-\w]+/iu;
const EXPLICIT_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/giu;
const BARE_DOMAIN_PATTERN =
  /(?<![\p{L}\p{N}@._/\\-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:app|ca|co|com|dev|gg|io|me|net|org|tv|uk|us|xyz)(?:\/[^\s<]*)?/giu;
const COMMON_FILENAME_STEMS = new Set(['changelog', 'config', 'license', 'package', 'readme', 'tsconfig']);
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
    const cutoff = message.observedTimestamp - windowMs;
    const recent = (this.rows.get(key) ?? []).filter((row) => row.at >= cutoff);
    const existing = recent.findIndex((row) => row.messageId === message.messageId);
    if (existing >= 0) recent.splice(existing, 1);
    const digest = createHmac('sha256', this.digestKey).update(normalizedContent).digest('hex');
    recent.push({ messageId: message.messageId, digest, at: message.observedTimestamp });
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
  const linkContent = normalized.replace(ZERO_WIDTH, '');
  if (hasBadWord(normalized, policy.badWords)) return 'bad_words';
  if (repeats.observe(message, normalized, policy)) return 'repeated_message';
  // Only explicit mentions in message content are supplied here. Discord's
  // implicit reply reference does not count unless the author actually pinged it.
  if (message.mentionedUserIds.length >= policy.mentionLimit) return 'mention_spam';
  if (INVITE.test(linkContent)) return 'invite_link';
  if (hasExternalLink(linkContent, policy.allowedDomains)) return 'external_link';
  if (hasBlockedAttachment(message.attachmentNames, policy.blockedAttachmentExtensions)) return 'attachment_type';
  return null;
}

// TOG-10049: NFKC leaves combining marks (`\p{M}`) intact, so one accent
// keystroke (`véry bad`) split bad-words matches and repeat digests.
// NFKD decomposes the pinned compatibility folds identically (fullwidth,
// Kelvin K, long s, ﬁ ligature — see TOG-10052), then marks are stripped.
// Turkish dotted capital İ (U+0130) is sentineled to dotless ı (U+0131)
// first so the İ≠i no-overblock pin keeps holding.
const COMBINING_MARKS = /\p{M}/gu;

function normalize(value: string): string {
  return value
    .replace(/İ/g, 'ı')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hasBadWord(content: string, words: string[]): boolean {
  for (const raw of words) {
    const word = normalize(raw).replace(ZERO_WIDTH, '').replace(/\s+/g, '');
    if (!word) continue;
    // TOG-10049: tolerate residual combining marks between letters so a
    // stray accent that survives normalization cannot split the word.
    const escaped = [...word]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\u200B-\\u200D\\u2060\\uFEFF\\p{M}]*');
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu').test(content)) return true;
  }
  return false;
}

function hasExternalLink(content: string, allowedDomains: string[]): boolean {
  for (const pattern of [EXPLICIT_URL_PATTERN, BARE_DOMAIN_PATTERN]) {
    for (const match of content.matchAll(pattern)) {
      const candidate = match[0].replace(TRAILING_URL_PUNCTUATION, '');
      try {
        const parsed = /^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`;
        const host = new URL(parsed).hostname.toLowerCase().replace(/^www\./, '');
        const domainLabels = host.split('.').slice(0, -1);
        if (pattern === BARE_DOMAIN_PATTERN && !domainLabels.some((label) => !COMMON_FILENAME_STEMS.has(label))) continue;
        if (!allowedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function hasBlockedAttachment(names: string[], blocked: string[]): boolean {
  const blockedSet = new Set(blocked.map((value) => value.toLowerCase().replace(/^\./, '')));
  return names.some((name) => {
    // NFKC folds lookalike separators (e.g. fullwidth dot U+FF0E) to ASCII
    // dots; strip trailing dots/spaces Discord preserves in download names.
    const cleaned = normalize(name).replace(/[.\s]+$/u, '');
    // Strip invisible format chars (SHY, bidi overrides, zero-width, …)
    // from the extension so `e\xADxe` still reads as `exe`.
    const part = cleaned.split('.').pop()?.replace(/\p{Cf}/gu, '');
    return part ? blockedSet.has(part) : false;
  });
}
