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

function keepOverlays(run: string): string {
  return run.replace(/[^\u{334}-\u{338}]/gu, '');
}

// Fold accent stacking only on Latin letters. Indic matras, Arabic vowels and
// standalone marks remain meaningful; NFC restores other decomposed scripts.
// Dotted i keeps its dot after canonical case folding (no alphabetic sentinel).
// Overlays change the base's identity, including on Latin letters. Keep them
// here as well as in the gap-aware scanner so attached/spaced forms agree.
function foldLatinMarks(value: string): string {
  const dotAbove = String.fromCodePoint(0x0307);
  return value
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})(\p{M}+)/gu, (_cluster, letter: string, marks: string) =>
      letter + (letter === 'i' && marks.includes(dotAbove) ? dotAbove : '') + keepOverlays(marks),
    )
    .normalize('NFC');
}

/** Normalized form of one bad-words entry, shared with the wordlist lint (TOG-10066). */
export function normalizeBadWord(raw: string): string {
  // Gap removal can place two kept runs side by side; the trailing NFD
  // restores their canonical order AND decomposes precomposed letters, so a
  // spaced configuration meets the same form as attached content (`α ́λφα`
  // vs `άλφα`). Matches the content normalization in `hasBadWord`.
  return stripStandaloneMarkRuns(foldLatinMarks(normalize(raw))).replace(/\s+/g, '').normalize('NFD');
}

// Drop mark runs that decorate nothing, keeping required marks across
// allowed gaps. One forward pass carrying the last base character as the
// chain origin — each character is visited once, so repeated
// `space + mark` pairs stay linear (no backward rescan per run).
// The input is NFD-decomposed up front so a precomposed initial (ά) exposes
// its mark run to the same chain logic as a decomposed one (α + acute).
// A gap between a base and a following mark run stays a separator (the word
// pattern tolerates it), so `क ित` still matches `कित`.
// A gap between two mark runs belongs to one split chain (`عَ ّلَم`,
// `कि ंत`, `i̇ ̇stanbul`, `ά ̣λφα`): the later runs fold against the carried
// origin —
//   - origin is a Latin letter: same fold as directly-attached stacking
//     (dotted-i keeps its one dot per chain, other Latin stacking drops),
//     so `s ́h` folds exactly like `śh`;
//   - origin is another word character (non-Latin letter, digit,
//     underscore): the run is meaningful (Indic/Arabic vowel signs, chained
//     marks) and stays, so `क ित` still matches `कित` and `عَ ّلَم` still
//     matches `عَّلَم`;
//   - otherwise (string start, punctuation, emoji): standalone decoration,
//     dropped, so `f*́ck` matches `f*ck`.
// Combining overlays (U+0334–U+0338, e.g. the negation slash NFD exposes in
// ≠ → = + U+0338) are meaningful under every origin: they change the
// symbol's identity, so they are never dropped as decoration.
// A whole split chain is canonicalized together: the attached run plus every
// absorbed link are reordered as one mark sequence before the retained gaps,
// so a reverse-order multi-link chain (`عّ ُ َل`) meets the same form as the
// attached entry (`عَُّل`). The real input separators survive after the
// flushed chain as word boundaries (`İ ́shit` still reads as two tokens).
// Each original chain gap is also a possible word ending. Record the joined
// prefix at that gap, not an all-separated second reading of the message:
// internal chains may need joining while the final gap ends the candidate.
interface MarkEndings {
  maxLength: number;
  values: Array<{ offset: number; marks: string }>;
}

function stripStandaloneMarkRuns(value: string, endings?: MarkEndings): string {
  const dotAbove = String.fromCodePoint(0x0307);
  // NFD first: a precomposed initial must expose its marks before scanning.
  value = value.normalize('NFD');
  const at = (i: number): string => String.fromCodePoint(value.codePointAt(i) ?? 0);
  const isMark = (ch: string): boolean => /\p{M}/u.test(ch);
  const isGap = (ch: string): boolean => /[\s\p{Cf}]/u.test(ch);
  // Fold one run against its chain origin. A Latin `i` chain keeps a single
  // dot across all its links (attached run plus gap-split continuations);
  // other Latin stacking drops; non-Latin runs stay meaningful.
  const foldRun = (origin: string, run: string, chainHasDot: boolean): { text: string; hasDot: boolean } => {
    const overlays = keepOverlays(run);
    if (!origin || !/[\p{L}\p{N}_]/u.test(origin)) return { text: overlays, hasDot: false };
    if (!/\p{Script=Latin}/u.test(origin)) return { text: run, hasDot: false };
    if (origin !== 'i') return { text: overlays, hasDot: false };
    const hasDot = chainHasDot || run.includes(dotAbove);
    return { text: (!chainHasDot && run.includes(dotAbove) ? dotAbove : '') + overlays, hasDot };
  };
  let out = '';
  let origin = '';
  let chainHasDot = false;
  let i = 0;
  while (i < value.length) {
    const ch = at(i);
    if (isMark(ch)) {
      // Collect the maximal run and fold it against the carried origin.
      let run = '';
      while (i < value.length && isMark(at(i))) {
        const c = at(i);
        run += c;
        i += c.length;
      }
      const folded = foldRun(origin, run, chainHasDot);
      chainHasDot = folded.hasDot;
      // Absorb further chain links: each gap run followed by another mark
      // run extends the same chain. The links are buffered and canonicalized
      // with the attached run as one sequence; the retained gaps are emitted
      // after, so separators survive while the whole chain meets one form.
      // The scan only moves forward.
      let chain = folded.text;
      let hasGap = false;
      let lastEnding = '';
      while (true) {
        let g = i;
        while (g < value.length && isGap(at(g))) g += at(g).length;
        if (g > i && g < value.length && isMark(at(g))) {
          // A candidate ending here needs all preceding links, but none of
          // the next token's marks. Longer prefixes cannot fit any entry;
          // bound normalization/storage by entry length, not message length.
          if (endings && chain.length <= endings.maxLength && (!hasGap || chain !== lastEnding)) {
            endings.values.push({ offset: out.length, marks: chain.normalize('NFD') });
            lastEnding = chain;
          }
          hasGap = true;
          let next = '';
          while (g < value.length && isMark(at(g))) {
            const c = at(g);
            next += c;
            g += c.length;
          }
          const link = foldRun(origin, next, chainHasDot);
          chainHasDot = link.hasDot;
          chain += link.text;
          i = g;
        } else break;
      }
      out += chain.normalize('NFD');
      if (hasGap && !out.endsWith(' ')) out += ' ';
      continue;
    }
    // Gaps are separators — emit them (the word pattern tolerates gaps
    // between entry characters). The carried origin survives the gap so a
    // following mark run is judged by its base, exactly as before. A new
    // base character starts a new chain.
    if (isGap(ch)) {
      if (!out.endsWith(' ')) out += ' ';
    } else {
      out += ch;
      origin = ch;
      chainHasDot = false;
    }
    i += ch.length;
  }
  return out;
}

function hasBadWord(content: string, words: string[]): boolean {
  // Decoration is stripped once, up front: the per-gap pattern below then
  // stays a plain separator class with no overlapping alternatives or nested
  // quantifiers, so near-miss input cannot backtrack exponentially. The
  // trailing NFD decomposes precomposed letters AND reorders runs a
  // permitted gap split apart (reverse-order chains), matching the entry
  // normalization in `normalizeBadWord`.
  const entries = words.map(normalizeBadWord).filter(Boolean);
  if (entries.length === 0) return false;
  const maxLength = entries.reduce((max, word) => Math.max(max, word.length), 0);
  const endings: MarkEndings = { maxLength, values: [] };
  const plain = stripStandaloneMarkRuns(content, endings);
  // Keep only a candidate-sized suffix for each local ending. Gaps in plain
  // are collapsed, so a word of W UTF-16 units spans at most 2W units. Carry
  // the real start eligibility into truncated windows: cutting a long run of
  // attached marks must not invent a boundary, nor lose a genuine one.
  const canStart = new Uint8Array(plain.length + 1);
  canStart[0] = 1;
  let offset = 0;
  for (const ch of plain) {
    canStart[offset + ch.length] = /\p{M}/u.test(ch) ? canStart[offset] : Number(!/[\p{L}\p{N}_]/u.test(ch));
    offset += ch.length;
  }
  const localEnds = endings.values.map(({ offset, marks }) => {
    let start = Math.max(0, offset - 2 * maxLength);
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(plain[start] ?? '') && /[\uD800-\uDBFF]/u.test(plain[start - 1])) start--;
    return (canStart[start] ? ' ' : 'x') + plain.slice(start, offset) + marks;
  });
  for (const word of entries) {
    // One atom per entry character. The category lookahead is case-SENSITIVE
    // (`(?-i:...)`, supported by V8): without it, the NFD-exposed combining
    // iota-subscript (U+0345, the only mark in all of Unicode that
    // case-folds to a letter — enumerated, not assumed) also satisfies a
    // case-insensitive `[\p{L}\p{N}_]`, so it would match an iota letter
    // under the `iu` flag below. A letter atom only matches letter-like
    // content; a mark atom only matches a mark, blocking the same collapse
    // in reverse. Letter case behaviour itself is unchanged (the literals
    // still carry `iu`), and `αι`/`ᾳ` self-matches plus the canonical `ᾳ`
    // form still catch.
    const escaped = [...word]
      .map((char) => {
        const literal = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (/[\p{L}\p{N}]/u.test(char)) return `(?-i:(?=[\\p{L}\\p{N}_]))${literal}`;
        if (/\p{M}/u.test(char)) return `(?-i:(?=\\p{M}))${literal}`;
        return literal;
      })
      .join('(?:[\\s\\p{Cf}])*');
    // Marks extending a letter stay part of its word. Skip leading marks only
    // after a real boundary (start/punctuation), never after a word character.
    // An overlay before a separate word cannot veto its start. It remains
    // required inside an entry and is not tolerated after an entry's operator.
    // Scope boundary categories too: under iu, \p{M} also consumes real iota.
    const leading = `(?-i:(^|[^\\p{L}\\p{N}\\p{M}_])\\p{M}*)`;
    // A mark after a punctuation-ended entry is standalone decoration (the
    // entry cannot extend it). After a letter-ended word it may be meaningful
    // (Devanagari/Arabic vowel signs extend the word), so keep the strict
    // boundary there.
    const decoration = /[\p{L}\p{N}\p{M}_]$/u.test(word)
      ? ''
      : '(?-i:(?:(?![\\u0334-\\u0338])\\p{M})*)';
    const trailing = `${decoration}(?-i:([^\\p{L}\\p{N}\\p{M}_]|$))`;
    const pattern = new RegExp(`${leading}${escaped}${trailing}`, 'iu');
    if (pattern.test(plain)) return true;
    const atOriginalGap = new RegExp(`${leading}${escaped}${decoration}$`, 'iu');
    if (localEnds.some((end) => atOriginalGap.test(end))) return true;
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
