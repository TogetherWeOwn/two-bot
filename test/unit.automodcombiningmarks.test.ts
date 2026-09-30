import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAutomodConfig } from '../src/automod/config.ts';
import { matchAutomod, MemoryRepeatTracker, normalizeBadWord } from '../src/automod/matcher.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

// Offline regressions for TOG-10049: exercise the real config pipeline as well
// as direct policies. No database, Discord client or live guild access.
const policy = loadAutomodConfig({ TWO_AUTOMOD_ALLOWED_DOMAINS: 'two.gg' }, null).policy;

function message(content: string, overrides: Partial<AutomodMessage> = {}): AutomodMessage {
  return {
    guildId: 'test', channelId: 'test', messageId: '1', authorId: 'test',
    authorIsBot: false, roleIds: [], content, mentionedUserIds: [],
    attachmentNames: [], observedTimestamp: 0, ...overrides,
  };
}

function match(content: string, probe: AutomodPolicy = policy, overrides: Partial<AutomodMessage> = {}) {
  return matchAutomod(message(content, overrides), probe, new MemoryRepeatTracker());
}

function repeat(contents: string[]) {
  const tracker = new MemoryRepeatTracker();
  return contents.map((content, i) => matchAutomod(
    message(content, { messageId: String(i), observedTimestamp: i * 1000 }), policy, tracker,
  ));
}

test('accent folding cannot turn an external IDN into an allowed host', () => {
  for (const host of ['twó.gg', 'twó.gg', 'foo.twó.gg']) {
    assert.notEqual(new URL(`https://${host}/path`).hostname, 'two.gg');
    assert.equal(match(`https://${host}/path`), 'external_link', host);
  }
  assert.equal(match('https://two.gg/path'), null);
  const idnPolicy = { ...policy, allowedDomains: ['xn--tw-6ja.gg'] };
  assert.equal(match('https://twó.gg/path', idnPolicy), null, 'actual IDN identity can be allowed');
});

test('configured dotted-I matches itself and its canonical forms without a letter sentinel', () => {
  const configured = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: 'İstanbul' }, null).policy;
  for (const content of ['İstanbul', 'İstanbul', 'i̇stanbul']) {
    assert.equal(match(content, configured), 'bad_words', content);
    assert.equal(normalizeBadWord(content), normalizeBadWord(configured.badWords[0]));
  }
  assert.equal(match('istanbul', configured), null, 'ASCII i remains distinct');
  assert.equal(match('KİR', { ...policy, badWords: ['kır'] }), null, 'dotless i is a real letter');
  assert.equal(match('SHİT happens', { ...policy, badWords: ['shit'] }), null);
});

test('canonical dotted-I variants share a repeat digest', () => {
  assert.deepEqual(
    repeat(['İstanbul', 'İstanbul', 'i̇stanbul']),
    [null, null, 'repeated_message'],
  );
});

test('Latin accent stacking is folded on both sides of the bad-word policy', () => {
  const configured = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: 'véry bad' }, null).policy;
  for (const content of ['very bad', 'véry bad', 'verẏbad', 'very b⃝ad', 'vé̇⃝ry bad']) {
    assert.equal(match(content, configured), 'bad_words', content);
  }
  assert.deepEqual(repeat(['repeat me', 'repéat me', 'repeat mé']), [null, null, 'repeated_message']);
});

test('meaningful non-Latin marks distinguish bad words and their boundaries', () => {
  const cases: Array<[string, string, string]> = [
    ['Devanagari vowel sign', 'मूत', 'मत करो'],
    ['trailing Devanagari vowel sign', 'कल', 'कला'],
    ['Arabic vowel mark', 'عَلَم', 'علم'],
  ];
  for (const [name, word, content] of cases) {
    const probe = { ...policy, badWords: [word] };
    assert.equal(match(content, probe), null, name);
    assert.equal(match(word, probe), 'bad_words', `${name}: exact word`);
  }
});

test('standalone or punctuation-attached marks cannot hide a bad-word start', () => {
  const probe = { ...policy, badWords: ['shit'] };
  for (const prefix of ['́', '́̇⃝', '!́', '😀́', ' ́', 'safe!́']) {
    assert.equal(match(`${prefix}shit`, probe), 'bad_words', JSON.stringify(prefix));
  }
});

test('marks decorating separators cannot split a bad word', () => {
  const probe = { ...policy, badWords: ['shit'] };
  // Corpus discipline (see the fuzz suite): non-ASCII rows are ASCII literals
  // decoded through E() so every codepoint stays auditable.
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  for (const [name, content] of [
    ['acute on the space', E('s \\u0301h i t')],
    ['stacked marks on separators', E('s \\u0301\\u0307h i\\u20dd t')],
    ['zero-width plus mark between letters', E('s\\u200b\\u0301h i t')],
  ] as Array<[string, string]>) {
    assert.equal(match(content, probe), 'bad_words', name);
  }
  // Contrast: a mark attached to a letter folds (Latin stacking) or extends
  // the word (dotted-i dot) — it is never a skippable separator.
  assert.equal(match(E('s\\u0301hit'), probe), 'bad_words', 'Latin-attached stacking folds');
  assert.equal(match('SHİT happens', probe), null, 'dotted-I dot stays meaningful');
});

test('marks decorating internal punctuation cannot split a bad word', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  for (const [name, entry, content] of [
    ['acute on the star', 'f*ck', E('f*\\u0301ck')],
    ['stacked marks on the star', 'f*ck', E('f*\\u0301\\u20ddck')],
    ['decorated star plus spaced letters', 'f*ck', E('f*\\u0301 c k')],
    ['acute on the plus', 'c++', E('c+\\u0301+')],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [entry] }), 'bad_words', name);
  }
  // Contrast: marks must be skippable only after non-letters. A letter in the
  // message where the entry has punctuation still bounds, and surviving
  // letter-attached marks stay meaningful.
  const starProbe = { ...policy, badWords: ['f*ck'] };
  assert.equal(match('f*!ck', starProbe), null, 'content letter for entry punctuation still bounds');
  assert.equal(match(E('fx\\u0301ck'), starProbe), null, 'mark extending a content letter still bounds');
  assert.equal(match('i love c++ lots', { ...policy, badWords: ['c++'] }), 'bad_words', 'punctuation entry still matches');
});

test('punctuation-ended entries tolerate trailing standalone marks', () => {
  const probe = { ...policy, badWords: ['shit!'] };
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  for (const [name, content] of [
    ['trailing acute after bang', E('shit!\\u0301 is forbidden')],
    ['parenthesised trailing mark', E('(shit!\\u0301)')],
  ] as Array<[string, string]>) {
    assert.equal(match(content, probe), 'bad_words', name);
  }
  // The tolerance skips marks only: a word character after the mark still
  // bounds, and letter-ended words keep the strict trailing boundary, where a
  // following mark may be a meaningful vowel sign.
  assert.equal(match(E('shit!\\u0301x'), probe), null, 'word character after the mark still bounds');
  assert.equal(match('कला', { ...policy, badWords: ['कल'] }), null, 'trailing Devanagari vowel sign');
});

test('marks chained after a meaningful mark stay meaningful', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // Decoration eligibility comes from the run's origin, never the preceding
  // mark: a shadda chained after a fatha (or an anusvara after a vowel sign)
  // extends the same word, so the longer form must not match the shorter entry.
  for (const [name, entry, content] of [
    ['Arabic shadda after fatha', E('\\u0639\\u064e\\u0644\\u064e\\u0645'), E('\\u0639\\u064e\\u0651\\u0644\\u064e\\u0645')],
    ['Devanagari anusvara after vowel sign', E('\\u0915\\u093f\\u0924'), E('\\u0915\\u093f\\u0902\\u0924')],
  ] as Array<[string, string, string]>) {
    const probe = { ...policy, badWords: [entry] };
    assert.equal(match(content, probe), null, name);
    assert.equal(match(entry, probe), 'bad_words', `${name}: exact entry still matches`);
  }
});

test('gap-split mark chains inherit their base origin', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // A chain attached to one base letter may be split by a permitted gap; the
  // later run carries the same base origin as its attached form. The shorter
  // entry must not catch the split longer chain, and the longer entry must.
  for (const [name, entry, content, expected] of [
    ['Arabic split chain misses shorter entry', E('\\u0639\\u064e\\u0644\\u064e\\u0645'), E('\\u0639\\u064e \\u0651\\u0644\\u064e\\u0645'), null],
    ['Arabic split chain matches longer entry', E('\\u0639\\u064e\\u0651\\u0644\\u064e\\u0645'), E('\\u0639\\u064e \\u0651\\u0644\\u064e\\u0645'), 'bad_words'],
    ['Devanagari split chain misses shorter entry', E('\\u0915\\u093f\\u0924'), E('\\u0915\\u093f \\u0902\\u0924'), null],
    ['Devanagari split chain matches longer entry', E('\\u0915\\u093f\\u0902\\u0924'), E('\\u0915\\u093f \\u0902\\u0924'), 'bad_words'],
  ] as Array<[string, string, string, string | null]>) {
    assert.equal(match(content, { ...policy, badWords: [entry] }), expected, name);
  }
  // A spaced-chain configuration keeps its longer identity: it matches its
  // own spaced content but not the shorter word.
  const spacedCfg = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: E('\\u0915\\u093f \\u0902\\u0924') }, null).policy;
  assert.equal(match(E('\\u0915\\u093f \\u0902\\u0924'), spacedCfg), 'bad_words', 'spaced-chain config matches spaced content');
  assert.equal(match(E('\\u0915\\u093f\\u0924'), spacedCfg), null, 'spaced-chain config vs shorter word');
});

test('reverse-order mark chains meet their canonical form', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const revAttached = `ع${String.fromCodePoint(0x651, 0x64e)}ل${String.fromCodePoint(0x64e)}م`;
  const revSplit = `ع${String.fromCodePoint(0x651)} ${String.fromCodePoint(0x64e)}ل${String.fromCodePoint(0x64e)}م`;
  const fwdSplit = E('\\u0639\\u064e \\u0651\\u0644\\u064e\\u0645');
  const entry = E('\\u0639\\u064e\\u0651\\u0644\\u064e\\u0645');
  const short = E('\\u0639\\u064e\\u0644\\u064e\\u0645');
  // A gap-split chain is rejoined before canonical ordering, so the split
  // form meets the attached form whatever mark order the author used.
  for (const [name, cfgEntry, content] of [
    ['reverse-order attached matches', entry, revAttached],
    ['reverse-order split matches', entry, revSplit],
    ['reverse-spaced config matches attached canonical', revSplit, entry],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [cfgEntry] }), 'bad_words', name);
  }
  // Shorter/longer identity is preserved: the short entry still misses the
  // reverse split, and the spaced chain config still misses the short word.
  assert.equal(match(revSplit, { ...policy, badWords: [short] }), null, 'short entry vs reverse split');
  const spacedCfg = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: revSplit }, null).policy;
  assert.equal(match(entry, spacedCfg), 'bad_words', 'reverse-spaced config self shape via entry form');
  assert.equal(match(short, spacedCfg), null, 'reverse-spaced config vs shorter word');
  assert.equal(match(fwdSplit, { ...policy, badWords: [entry] }), 'bad_words', 'forward-order split control');
});

test('mark-chain gaps keep real word boundaries', () => {
  const probe = { ...policy, badWords: ['shit'] };
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // A gap between two mark runs absorbs into one chain, but the separator
  // survives: a marked prefix token before a real space cannot hide a
  // separately spaced forbidden word. All six catch; the parent repair that
  // absorbed chains and discarded the gap missed every one.
  for (const [name, content] of [
    ['dotted-I prefix token', E('\\u0130 \\u0301shit')],
    ['decomposed dotted-I prefix token', E('i\\u0307 \\u0301shit')],
    ['Arabic prefix token', E('\\u0639\\u064e \\u0301shit')],
    ['Devanagari prefix token', E('\\u0915\\u093f \\u0301shit')],
    ['digit prefix token', E('1\\u0301 \\u0301shit')],
    ['underscore prefix token', E('_\\u0301 \\u0301shit')],
  ] as Array<[string, string]>) {
    assert.equal(match(content, probe), 'bad_words', name);
  }
  // Controls: an ordinary marked prefix still reads as its own token, and
  // attached prefix marks stay part of the preceding word.
  assert.equal(match(E('x \\u0301shit'), probe), 'bad_words', 'ordinary marked prefix');
  for (const prefix of ['x́', 'i̇', 'ά', 'क़', 'عَ', '1́', '_́']) {
    assert.equal(match(`${prefix}shit`, probe), null, `attached ${JSON.stringify(prefix)} still bounds`);
  }
});

test('composable clusters meet one form across permitted gaps', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const attached = E('\\u03ac\\u03bb\\u03c6\\u03b1');
  const spaced = E('\\u03b1 \\u0301\\u03bb\\u03c6\\u03b1');
  const spacedCfg = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: spaced }, null).policy;
  // NFD decomposes the precomposed first letter on both sides, so a gap
  // inside the cluster meets the attached cluster, and a spaced entry
  // matches its own content.
  assert.equal(match(spaced, { ...policy, badWords: [attached] }), 'bad_words', 'attached config vs spaced content');
  assert.equal(match(spaced, spacedCfg), 'bad_words', 'spaced config matches spaced content');
  assert.equal(match(attached, spacedCfg), 'bad_words', 'spaced config vs attached content');
  // Accented-vs-unaccented identity is preserved: the marks are part of the
  // letter, so stripping them still differs.
  const unaccented = E('\\u03b1\\u03bb\\u03c6\\u03b1');
  assert.equal(match(unaccented, { ...policy, badWords: [attached] }), null, 'unaccented content still differs');
  assert.equal(match(attached, { ...policy, badWords: [unaccented] }), null, 'unaccented config still differs');
});

test('dotted-i chains keep one dot across gap splits', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const entry = E('\\u0130stanbul');
  const attachedDup = E('i\\u0307\\u0307stanbul');
  const splitDup = E('i\\u0307 \\u0307stanbul');
  const required = E('i \\u0307stanbul');
  // A logical i-chain keeps a single dot however many links it has, so
  // attached, split and spaced-config duplicates share one key.
  for (const content of [attachedDup, splitDup, required]) {
    assert.equal(match(content, { ...policy, badWords: [entry] }), 'bad_words', JSON.stringify(content));
    assert.equal(normalizeBadWord(content), normalizeBadWord(entry), `shared key ${JSON.stringify(content)}`);
  }
  const splitCfg = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: splitDup }, null).policy;
  assert.equal(match(entry, splitCfg), 'bad_words', 'split config matches canonical content');
  assert.equal(match(attachedDup, splitCfg), 'bad_words', 'split config matches attached duplicate');
  // The dot-vs-ASCII distinction survives: plain ASCII stays distinct.
  assert.equal(match('istanbul', { ...policy, badWords: [entry] }), null, 'ASCII stays distinct');
  assert.equal(match('istanbul', splitCfg), null, 'ASCII stays distinct under split config');
});

test('internal chain joins compose with a separate marked suffix', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const cases = [
    [E('\\u0639\\u064e\\u0644\\u064e\\u0651\\u0645\\u064e'), E('\\u0639\\u064e\\u0644\\u0651 \\u064e\\u0645\\u064e')],
    [E('\\u03b1\\u0323\\u0301\\u03bb\\u03c6\\u03ac'), E('\\u03ac \\u0323\\u03bb\\u03c6\\u03ac')],
  ];
  for (const [entry, split] of cases) {
    for (const configuredEntry of [entry, split]) {
      const configured = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: configuredEntry }, null).policy;
      for (const suffix of [' \\u0323ok', ' \\u0301ok', ' \\u0338ok', ' \\u0323']) {
        for (const prefix of ['', E('\\u03b9 '), E('!') + E('\\u0338').repeat(200)]) {
          assert.equal(match(prefix + split + E(suffix), configured), 'bad_words', JSON.stringify([prefix, split, suffix]));
        }
      }
      for (const suffix of ['\\u0323ok', '\\u0301ok', '\\u0338ok']) {
        assert.equal(match(split + E(suffix), configured), null, 'attached continuation remains distinct');
      }
      assert.equal(match('x' + split + E(' \\u0323ok'), configured), null, 'attached prefix still bounds');
      assert.equal(match('x' + E('\\u0338').repeat(200) + split + E(' \\u0323ok'), configured), null, 'long attached marks do not create a start');
    }
  }
  // The final chain itself can need a join before a later gap ends the word.
  const entry = E('\\u03b1\\u0323\\u0301');
  const split = E('\\u03b1\\u0301 \\u0323');
  assert.equal(match(split + E(' \\u0338ok'), { ...policy, badWords: [entry] }), 'bad_words');
  assert.equal(match(split + E('\\u0338ok'), { ...policy, badWords: [entry] }), null);
});

test('boundary mark tolerances never consume a Greek iota letter', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  for (const letter of ['\\u03b9', '\\u0399', '\\u1f30', '\\u1f31']) {
    assert.equal(match(E(letter) + 'shit', { ...policy, badWords: ['shit'] }), null, letter);
    assert.equal(match('c++' + E(letter), { ...policy, badWords: ['c++'] }), null, letter);
  }
  assert.equal(match(E('\\u03b9 shit'), { ...policy, badWords: ['shit'] }), 'bad_words');
  assert.equal(match(E('\\u0345shit'), { ...policy, badWords: ['shit'] }), 'bad_words');
  assert.equal(match(E('c++\\u0345'), { ...policy, badWords: ['c++'] }), 'bad_words');
  assert.equal(match(E('c++\\u0301'), { ...policy, badWords: ['c++'] }), 'bad_words');
});

test('repeated separator-plus-mark runs stay linear', () => {
  const probe = { ...policy, badWords: ['shit'] };
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // Each space+acute pair must cost O(1): 2000 pairs (~4000 UTF-16 units)
  // stay well under the old 81–83 ms quadratic timing on this machine.
  const content = `s${E(' \\u0301').repeat(2000)}hik`;
  const started = Date.now();
  assert.equal(match(content, probe), null);
  assert.ok(Date.now() - started < 1000, '2000-pair near-miss stays bounded');
});

test('local chain endings stay bounded on mark-heavy near misses', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const probe = { ...policy, badWords: [E('\\u03b1\\u0323\\u0301\\u03bb\\u03c6\\u03ac')] };
  for (const content of [
    E('\\u03b1\\u0301') + E(' \\u0323').repeat(2000) + E('\\u03bb\\u03c6\\u03ac \\u0323ok'),
    E('\\u03b1\\u0301 \\u0323x ').repeat(2000),
  ]) {
    const started = Date.now();
    assert.equal(match(content, probe), null);
    assert.ok(Date.now() - started < 1000, 'long chains and many local endings stay bounded');
  }
});

test('required marks survive across allowed gaps', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // A mark whose origin (skipping gap separators) is a word character is
  // required, not decoration: Latin stacking folds like its attached form,
  // non-Latin and dotted-i marks stay for literal match.
  for (const [name, entry, content] of [
    ['Devanagari vowel sign across space', E('\\u0915\\u093f\\u0924'), E('\\u0915 \\u093f\\u0924')],
    ['Devanagari vowel sign across tab', E('\\u0915\\u093f\\u0924'), E('\\u0915\\u0009\\u093f\\u0924')],
    ['Arabic vowel across space', E('\\u0639\\u064e\\u0644\\u064e\\u0645'), E('\\u0639 \\u064e\\u0644\\u064e\\u0645')],
    ['dotted-i dot across space', E('\\u0130stanbul'), E('i \\u0307stanbul')],
    ['Latin stacking across space folds', 'shit', E('s \\u0301h i t')],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [entry] }), 'bad_words', name);
  }
  // A spaced dotted-I configuration keeps its dot, so plain ASCII stays distinct.
  const spacedCfg = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: E('i \\u0307stanbul') }, null).policy;
  assert.equal(match('istanbul', spacedCfg), null, 'spaced dotted-I config vs ASCII');
  assert.equal(match(E('i \\u0307stanbul'), spacedCfg), 'bad_words', 'spaced config matches spaced content');
});

test('separator-plus-mark near-misses match in linear time', () => {
  const probe = { ...policy, badWords: ['shit'] };
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // 28 space+acute pairs (58 UTF-16 units) took the old overlapping-gap
  // pattern past a 3 s isolated-process limit; the single-pass strip plus
  // plain separator gaps keep this near-instant.
  const content = `s${E(' \\u0301').repeat(28)}hik`;
  const started = Date.now();
  assert.equal(match(content, probe), null);
  assert.ok(Date.now() - started < 1000, 'near-miss stays bounded');
});

test('marks extending a preceding word do not create a bad-word boundary', () => {
  const probe = { ...policy, badWords: ['shit'] };
  for (const prefix of ['x́', 'i̇', 'ά', 'क़', 'عَ', '1́', '_́']) {
    assert.equal(match(`${prefix}shit`, probe), null, JSON.stringify(prefix));
  }
});

test('nonempty mark-only content still counts toward repeats', () => {
  // Rendering-invisible selectors are separately excluded by TOG-10048.
  for (const content of ['ा', '́', '⃝']) {
    assert.deepEqual(repeat([content, content, content]), [null, null, 'repeated_message'], content);
  }
  assert.deepEqual(repeat(['कल', 'कला', 'कल']), [null, null, null]);
});

test('multi-link split chains canonicalize as one sequence', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const attached = E('\\u0639\\u064e\\u064f\\u0651\\u0644');
  const reverseSplit = E('\\u0639\\u0651 \\u064f \\u064e\\u0644');
  const forwardSplit = E('\\u0639\\u064e \\u064f \\u0651\\u0644');
  const attachedReverse = E('\\u0639\\u0651\\u064f\\u064e\\u0644');
  const short = E('\\u0639\\u064e\\u0644');
  // Every link of one logical chain is canonicalized together, so a
  // reverse-order multi-link split meets the attached entry — while an
  // earlier link-before-gap emission left a barrier between the links.
  for (const [name, cfgEntry, content] of [
    ['reverse split matches attached entry', attached, reverseSplit],
    ['reverse spaced config matches itself', reverseSplit, reverseSplit],
    ['reverse spaced config matches attached entry', reverseSplit, attached],
    ['forward split control', attached, forwardSplit],
    ['attached reverse control', attached, attachedReverse],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [cfgEntry] }), 'bad_words', name);
  }
  assert.equal(match(reverseSplit, { ...policy, badWords: [short] }), null, 'shorter entry vs multi-link split');
});

test('precomposed initials expose their marks to chain scanning', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const spaced = E('\\u03ac \\u0323\\u03bb\\u03c6\\u03b1');
  const attached = E('\\u03b1\\u0323\\u0301\\u03bb\\u03c6\\u03b1');
  const decomposed = E('\\u03b1\\u0301 \\u0323\\u03bb\\u03c6\\u03b1');
  const unaccented = E('\\u03b1\\u03bb\\u03c6\\u03b1');
  const acuteOnly = E('\\u03ac\\u03bb\\u03c6\\u03b1');
  // The strip pass NFD-decomposes first, so a precomposed initial meets the
  // same chain form as a decomposed one — NFC at the fold step hid it before.
  for (const [name, cfgEntry, content] of [
    ['precomposed spaced self', spaced, spaced],
    ['attached lower-dot+acute config vs spaced content', attached, spaced],
    ['spaced config vs attached content', spaced, attached],
    ['decomposed spaced self', decomposed, decomposed],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [cfgEntry] }), 'bad_words', name);
  }
  // Accent identity is preserved: the marks are part of the letters.
  assert.equal(match(unaccented, { ...policy, badWords: [acuteOnly] }), null, 'unaccented content still differs');
  assert.equal(match(acuteOnly, { ...policy, badWords: [unaccented] }), null, 'unaccented config still differs');
});

test('decomposed iota-subscript stays distinct from an iota letter', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  const letters = E('\\u03b1\\u03b9');
  const subscript = E('\\u1fb3');
  const canonical = E('\\u03b1\\u0345');
  // NFD exposes U+0345, which a case-insensitive letter class equates with
  // U+03B9; the per-atom category guard keeps the mark/letter boundary.
  assert.equal(match(subscript, { ...policy, badWords: [letters] }), null, 'subscript content vs letter entry');
  assert.equal(match(letters, { ...policy, badWords: [subscript] }), null, 'letter content vs subscript entry');
  assert.notEqual(normalizeBadWord(letters), normalizeBadWord(subscript), 'distinct entry keys');
  for (const [name, cfgEntry, content] of [
    ['letter self', letters, letters],
    ['subscript self', subscript, subscript],
    ['canonical subscript decomposition', subscript, canonical],
  ] as Array<[string, string, string]>) {
    assert.equal(match(content, { ...policy, badWords: [cfgEntry] }), 'bad_words', name);
  }
});

test('decomposed operator overlays keep their symbol identity', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  // NFD exposes the negation overlay (U+0338) in negated operators; the
  // punctuation trailing tolerance must not consume it as decoration, while
  // a genuine acute on the same entry stays tolerated.
  for (const [name, cfgEntry, content, expected] of [
    ['not-equal vs equal', 'x=', E('x\\u2260'), null],
    ['not-equivalent vs equivalent', E('x\\u2261'), E('x\\u2262'), null],
    ['not-less-than vs less-than', 'x<', E('x\\u226e'), null],
    ['equal self', 'x=', 'x=', 'bad_words'],
    ['not-equal self', E('x\\u2260'), E('x\\u2260'), 'bad_words'],
    ['genuine acute decoration', 'x=', E('x=\\u0301'), 'bad_words'],
  ] as Array<[string, string, string, string | null]>) {
    assert.equal(match(content, { ...policy, badWords: [cfgEntry] }), expected, name);
  }
});

test('unattached overlays cannot hide a bad-word start', () => {
  const probe = { ...policy, badWords: ['shit'] };
  for (let cp = 0x334; cp <= 0x338; cp++) {
    const overlay = String.fromCodePoint(cp);
    for (const prefix of ['', '!', '😀', 'safe!', 'x ', 'ά ']) {
      assert.equal(match(`${prefix}${overlay}shit`, probe), 'bad_words', `${cp.toString(16)} after ${prefix}`);
    }
    for (const prefix of ['x', 'i̇', 'ά', '1', '_']) {
      assert.equal(match(`${prefix}${overlay}shit`, probe), null, 'attached overlay does not create a boundary');
    }
  }
});

test('Latin overlay identity agrees across attached and spaced forms', () => {
  for (let cp = 0x334; cp <= 0x338; cp++) {
    const overlay = String.fromCodePoint(cp);
    for (const base of ['x', 'i', 'i̇']) {
      const attached = `${base}${overlay}=`;
      const spaced = `${base} ${overlay}=`;
      for (const entry of [attached, spaced]) {
        const configured = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: entry }, null).policy;
        for (const content of [attached, spaced]) {
          assert.equal(match(content, configured), 'bad_words', `${JSON.stringify(entry)} vs ${JSON.stringify(content)}`);
        }
        assert.equal(match(`${base}=`, configured), null, 'overlay entry differs from plain content');
        assert.equal(match(`${base}=${overlay}`, configured), null, 'overlay on another base differs');
      }
      assert.equal(match(attached, { ...policy, badWords: [`${base}=`] }), null, 'plain entry differs from overlay content');
      assert.equal(normalizeBadWord(attached), normalizeBadWord(spaced), 'shared entry identity');
    }
  }
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  assert.deepEqual(repeat(['x=', E('x\\u0338='), 'x=']), [null, null, null], 'overlays retain repeat identity');
  assert.deepEqual(
    repeat([E('x\\u0338='), E('x\\u0338\\u0301='), E('x\\u0301\\u0338=')]),
    [null, null, 'repeated_message'], 'genuine Latin accents still fold',
  );
});

test('complete preceding tokens survive marks after a real gap', () => {
  const E = (asciiWithEscapes: string): string => JSON.parse(`"${asciiWithEscapes}"`);
  for (const entry of [
    E('\\u0915\\u0932\\u093e'),
    E('\\u0639\\u064e\\u0644\\u064e\\u0645\\u064e'),
    E('\\u03ac'),
    E('\\u03b1\\u03bb\\u03c6\\u03ac'),
  ]) {
    const configured = loadAutomodConfig({ TWO_AUTOMOD_BAD_WORDS: entry }, null).policy;
    for (const marks of [E('\\u0323'), E('\\u0301'), E('\\u0338'), E('\\u0323 \\u0301')]) {
      for (const gap of [' ', '\t', '\n']) {
        assert.equal(match(`${entry}${gap}${marks}ok`, configured), 'bad_words', 'complete preceding token');
        assert.equal(match(`${entry} ${marks}`, configured), 'bad_words', 'complete token before mark-only suffix');
      }
    }
    assert.equal(match(`${entry}${E('\\u0323')}ok`, configured), null, 'without a gap the word continues');
    assert.equal(match(`${entry}x ${E('\\u0323')}ok`, configured), null, 'a longer preceding token stays distinct');
  }
});

test('configured accented attachment extensions retain their identity', () => {
  for (const extension of ['réf', '.réf', 'ＲÉＦ']) {
    const configured = loadAutomodConfig({ TWO_AUTOMOD_BLOCKED_ATTACHMENT_EXTENSIONS: extension }, null).policy;
    for (const filename of ['document.réf', 'document.réf', 'document.RÉF. ']) {
      assert.equal(match('ordinary message', configured, { attachmentNames: [filename] }), 'attachment_type', filename);
    }
    assert.equal(match('ordinary message', configured, { attachmentNames: ['document.ref'] }), null, 'ASCII extension differs');
  }
});
