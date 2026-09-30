import { createHmac, randomBytes } from 'node:crypto';
import type { AutomodFilter, AutomodMessage, AutomodPolicy } from './types.ts';
import { BARE_TLDS } from './tlds.ts';

// Catch hyphenation-point dots and invisible separators stripped to discordgg.
const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord[.\u2027]?gg|discord(?:app)?\.com\/invite)\/[-\w]+/iu;
const EXPLICIT_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/giu;
// Bare `label.tld` links have no scheme to anchor on, so the TLD group is a
// generic ASCII shape checked against the IANA snapshot in `./tlds.ts` inside
// `hasExternalLink` — a second hardcoded alternation here would silently
// reopen the TOG-10050 gap on every new phishing TLD. The leading-letter TLD
// requirement keeps version strings (`v1.2.3`) and IPv4 literals out.
const BARE_DOMAIN_PATTERN =
  /(?<![\p{L}\p{N}@._/\\-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[^\s<]*)?/giu;
// Dot lookalikes with no NFKC fold to ASCII: ideographic full stop U+3002
// (halfwidth U+FF61 folds to it), middle dot U+00B7, hyphenation point U+2027.
// Folded for the bare-domain pass only — the invite literal keeps its own
// fix (TOG-10048 owns that).
const BARE_DOT_LOOKALIKE_CODES = ['3002', '00b7', '2027'];
const COMMON_FILENAME_STEMS = new Set(['changelog', 'config', 'license', 'package', 'readme', 'tsconfig']);
const TRAILING_URL_PUNCTUATION = /[>),.!?:;]+$/u;
// Format controls (including SHY/MVS/bidi) and variation selectors must not
// split words, invite hosts or repeat digests. Selectors are Mn, not Cf.
const INVISIBLE_FORMAT = /[\p{Cf}\ufe00-\ufe0f\u{E0100}-\u{E01EF}]/gu;

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
  // Accent folding is a text-filter policy, never a URL-host identity transform.
  const linkContent = normalized;
  const moderationContent = foldLatinMarks(normalized);
  if (hasBadWord(moderationContent, policy.badWords)) return 'bad_words';
  if (repeats.observe(message, moderationContent, policy)) return 'repeated_message';
  // Only explicit mentions in message content are supplied here. Discord's
  // implicit reply reference does not count unless the author actually pinged it.
  if (message.mentionedUserIds.length >= policy.mentionLimit) return 'mention_spam';
  if (INVITE.test(linkContent)) return 'invite_link';
  if (hasExternalLink(linkContent, policy.allowedDomains)) return 'external_link';
  if (hasBlockedAttachment(message.attachmentNames, policy.blockedAttachmentExtensions)) return 'attachment_type';
  return null;
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_FORMAT, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Fold accent stacking only on Latin letters. Indic matras, Arabic vowels and
// standalone marks remain meaningful; NFC restores other decomposed scripts.
// Dotted i keeps its dot after canonical case folding (no alphabetic sentinel).
function foldLatinMarks(value: string): string {
  const dotAbove = String.fromCodePoint(0x0307);
  return value
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})(\p{M}+)/gu, (_cluster, letter: string, marks: string) =>
      letter === 'i' && marks.includes(dotAbove) ? `${letter}${dotAbove}` : letter,
    )
    .normalize('NFC');
}

/** Normalized form of one bad-words entry, shared with the wordlist lint (TOG-10066). */
export function normalizeBadWord(raw: string): string {
  return foldLatinMarks(normalize(raw)).replace(/\s+/g, '');
}

function hasBadWord(content: string, words: string[]): boolean {
  for (const raw of words) {
    const word = normalizeBadWord(raw);
    if (!word) continue;
    const escaped = [...word]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\p{Cf}]*');
    // Marks extending a letter stay part of its word. Skip leading marks only
    // after a real boundary (start/punctuation), never after a word character.
    if (new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_])\\p{M}*${escaped}([^\\p{L}\\p{N}\\p{M}_]|$)`, 'iu').test(content)) return true;
  }
  return false;
}

/** Fold the no-NFKC dot lookalikes to ASCII dots (codepoints kept as hex so no homoglyph can hide here). */
function foldBareDots(value: string): string {
  return value.replace(
    new RegExp(`[${BARE_DOT_LOOKALIKE_CODES.map((hex) => `\\u{${hex}}`).join('')}]`, 'gu'),
    '.',
  );
}

function linkHostname(candidate: string): string {
  const cleaned = candidate.replace(TRAILING_URL_PUNCTUATION, '');
  const parsed = /^https?:\/\//iu.test(cleaned) ? cleaned : `https://${cleaned}`;
  return new URL(parsed).hostname.toLowerCase().replace(/^www\./, '');
}

function hasExternalLink(content: string, allowedDomains: string[]): boolean {
  const isAllowed = (host: string) => allowedDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  for (const match of content.matchAll(EXPLICIT_URL_PATTERN)) {
    try {
      if (!isAllowed(linkHostname(match[0]))) return true;
    } catch {
      return true;
    }
  }
  // Explicit links have already been judged by host. Do not interpret their
  // path/query/fragment as another link, or concatenate surrounding bare text.
  const bareContent = content.replace(EXPLICIT_URL_PATTERN, ' ');
  for (const match of foldBareDots(bareContent).matchAll(BARE_DOMAIN_PATTERN)) {
    try {
      const detectedHost = linkHostname(match[0]);
      const domainLabels = detectedHost.split('.').slice(0, -1);
      if (!domainLabels.some((label) => !COMMON_FILENAME_STEMS.has(label))) continue;
      if (!BARE_TLDS.has(detectedHost.split('.').pop() ?? '')) continue;
      // Dot folding only discovers candidates. Authorize the original IDNA
      // identity: U+00B7 may be part of a real label, not a subdomain separator.
      // Every folded separator is one UTF-16 unit, so these offsets are stable.
      const original = bareContent.slice(match.index, match.index + match[0].length);
      if (!isAllowed(linkHostname(original))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function hasBlockedAttachment(names: string[], blocked: string[]): boolean {
  const blockedSet = new Set(blocked.map((value) => normalize(value).replace(/^\./, '')));
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
