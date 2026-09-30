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
