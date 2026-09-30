import { normalizeBadWord } from './matcher.ts';

/**
 * Wordlist lint core (TOG-10066).
 *
 * WHY THIS EXISTS. The bad-words matcher matches exactly after
 * NFKD+lowercase, and Unicode never folds scripts: a Cyrillic-ie lookalike
 * of `very bad` renders identically but is a different string, so it never
 * matches. Same for leet digits (`sh1t`, `v3ry b4d`). Deliberately NOT fixed
 * in the matcher: folding Cyrillic into `normalize()` would silently broaden
 * matching for every word and over-block legitimate non-English text
 * (Cyrillic ie U+0435 is a real letter, unlike the invisible format chars
 * from TOG-10048). The wordlist is the control surface instead: this lint
 * warns when a configured entry has obvious uncovered lookalikes.
 *
 * ASCII discipline (same spirit as the fuzz corpus): this file builds every
 * non-ASCII codepoint from hex numbers via `cp()` below, so a homoglyph can
 * never silently substitute for the intended codepoint in this file.
 * `grep -nP '[^\x00-\x7F]'` on this file must print nothing.
 */

/** Build lookalike characters from hex codepoints; keeps this file ASCII. */
function cp(...hex: string[]): string[] {
  return hex.map((h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

// Cyrillic + Greek lookalikes for Latin letters, keyed by the ASCII letter.
// Deliberately small: only codepoints that render near-identically at chat
// font sizes. Excluded on purpose: d/r/u/z lookalikes (U+0501, U+0433,
// U+0438, U+0491) are font-dependent, not identical -- suggesting them
// would push wordlists toward noise entries nobody can visually verify.
const HOMOGLYPHS: Readonly<Record<string, readonly string[]>> = {
  a: cp('0430', '03B1'),
  b: cp('0432'),
  c: cp('0441', '03F2'),
  e: cp('0435', '03B5'),
  h: cp('04BB'),
  i: cp('0456', '03B9'),
  j: cp('0458'),
  k: cp('043A', '03BA'),
  m: cp('043C', '03BC'),
  n: cp('03BD'),
  o: cp('043E', '03BF'),
  p: cp('0440', '03C1'),
  s: cp('0455'),
  t: cp('0442', '03C4'),
  v: cp('0475'),
  w: cp('051D'),
  x: cp('0445', '03C7'),
  y: cp('0443'),
};

const LEET: Readonly<Record<string, readonly string[]>> = {
  a: ['4', '@'],
  b: ['8'],
  e: ['3'],
  g: ['9'],
  i: ['1', '!'],
  l: ['1'],
  o: ['0'],
  s: ['5', '$'],
  t: ['7'],
};

export interface WordlistSuggestion {
  entry: string;
  kind: 'homoglyph' | 'leet' | 'mixed-script';
  detail: string;
  variants: string[];
}

function singleSubstitutions(word: string, table: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  const chars = [...word];
  for (let i = 0; i < chars.length; i += 1) {
    for (const sub of table[chars[i]!] ?? []) {
      out.push([...chars.slice(0, i), sub, ...chars.slice(i + 1)].join(''));
    }
  }
  return out;
}

function mixesLatinWithLookalikes(word: string): boolean {
  return /\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word);
}

/**
 * Suggest homoglyph/leet variants missing from a bad-words list. Entries are
 * run through the matcher's own `normalizeBadWord` first, so the lint and
 * the matcher can never disagree about what an entry means. Advisory only:
 * a wordlist that trips the lint still enforces (the listed forms match).
 * Only single substitutions are suggested; combinations such as `v3ry b4d`
 * still need explicit entries. A quiet lint is not proof of exhaustive coverage.
 */
export function lintWordlist(rawWords: string[]): WordlistSuggestion[] {
  const words = [...new Set(rawWords.map(normalizeBadWord).filter(Boolean))];
  const have = new Set(words);
  const suggestions: WordlistSuggestion[] = [];
  for (const entry of words) {
    if (mixesLatinWithLookalikes(entry)) {
      suggestions.push({
        entry,
        kind: 'mixed-script',
        detail: 'entry already mixes scripts -- verify it is an intentional variant, not a homoglyph typo',
        variants: [],
      });
      continue;
    }
    const missingHomoglyphs = singleSubstitutions(entry, HOMOGLYPHS).filter((v) => !have.has(normalizeBadWord(v)));
    if (missingHomoglyphs.length > 0) {
      suggestions.push({
        entry,
        kind: 'homoglyph',
        detail: `${missingHomoglyphs.length} single-glyph Cyrillic/Greek lookalike(s) not in the wordlist`,
        variants: missingHomoglyphs,
      });
    }
    const missingLeet = singleSubstitutions(entry, LEET).filter((v) => !have.has(normalizeBadWord(v)));
    if (missingLeet.length > 0) {
      suggestions.push({
        entry,
        kind: 'leet',
        detail: `${missingLeet.length} single-character leet variant(s) not in the wordlist`,
        variants: missingLeet,
      });
    }
  }
  return suggestions;
}
