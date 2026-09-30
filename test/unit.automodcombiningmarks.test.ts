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

test('configured accented attachment extensions retain their identity', () => {
  for (const extension of ['réf', '.réf', 'ＲÉＦ']) {
    const configured = loadAutomodConfig({ TWO_AUTOMOD_BLOCKED_ATTACHMENT_EXTENSIONS: extension }, null).policy;
    for (const filename of ['document.réf', 'document.réf', 'document.RÉF. ']) {
      assert.equal(match('ordinary message', configured, { attachmentNames: [filename] }), 'attachment_type', filename);
    }
    assert.equal(match('ordinary message', configured, { attachmentNames: ['document.ref'] }), null, 'ASCII extension differs');
  }
});
