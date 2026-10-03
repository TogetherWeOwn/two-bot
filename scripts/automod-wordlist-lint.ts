/**
 * Wordlist lint CLI for TWO_AUTOMOD_BAD_WORDS (TOG-10066).
 *
 * Thin wrapper over `src/automod/wordlist.ts` (the lint core lives there so
 * unit tests import it without spawning a process). See that file for WHY:
 * the matcher matches exactly after NFKD+lowercase, Unicode never folds
 * scripts, and folding Cyrillic in `normalize()` would over-block real
 * non-English text -- so the wordlist is the control surface and this lint
 * suggests the homoglyph/leet variants a configured entry leaves uncovered.
 *
 * Exit 0 always carries machine-readable JSON on stdout; warnings are
 * advisory, never a boot refusal -- a wordlist that trips the lint still
 * enforces (the listed forms still match). Exit 2 means the lint could not
 * tell (no wordlist configured or unreadable input); that is never a pass.
 *
 *   TWO_AUTOMOD_BAD_WORDS="very bad,shit" node scripts/automod-wordlist-lint.ts
 *   TWO_AUTOMOD_BAD_WORDS="very bad,shit" node scripts/automod-wordlist-lint.ts --strict
 *   node scripts/automod-wordlist-lint.ts --words "very bad,shit"
 *
 * `--strict` exits 1 when any suggestion exists (for CI or a config review);
 * without it, suggestions print and the exit stays 0.
 */
import { normalizeBadWord } from '../src/automod/matcher.ts';
import { lintWordlist } from '../src/automod/wordlist.ts';

function readWords(argv: string[], env: NodeJS.ProcessEnv): { words: string[]; source: string } {
  const flag = argv.indexOf('--words');
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--words needs a comma-separated value.');
    return { words: value.split(','), source: '--words' };
  }
  return { words: (env.TWO_AUTOMOD_BAD_WORDS ?? '').split(','), source: 'TWO_AUTOMOD_BAD_WORDS' };
}

const invoked = process.argv[1]?.endsWith('automod-wordlist-lint.ts') ?? false;
if (invoked) {
  if (process.argv.includes('--help')) {
    console.log('usage: [TWO_AUTOMOD_BAD_WORDS="a,b"] node scripts/automod-wordlist-lint.ts [--words "a,b"] [--strict]');
    console.log('');
    console.log('Suggests homoglyph/leet variants missing from the automod bad-words list (TOG-10066).');
    console.log('Advisory only: exit 0 with suggestions, 1 with --strict and suggestions, 2 when unreadable.');
    console.log('Single substitutions only; combined forms need explicit entries. A quiet lint is not exhaustive coverage.');
    process.exit(0);
  }
  let parsed: { words: string[]; source: string };
  try {
    parsed = readWords(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`wordlist lint could not read input: ${String(err)}`);
    process.exit(2);
  }
  const normalized = parsed.words.map(normalizeBadWord).filter(Boolean);
  if (normalized.length === 0) {
    console.error(`wordlist lint could not tell: no usable entries from ${parsed.source} (exit 2 is never a pass).`);
    process.exit(2);
  }
  const suggestions = lintWordlist(parsed.words);
  console.log(JSON.stringify({ entries: normalized.length, suggestions }, null, 2));
  if (suggestions.length > 0 && process.argv.includes('--strict')) process.exit(1);
}
