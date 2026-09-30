/**
 * Automod matcher bypass fuzz (TOG-10004, round-5 gap list).
 *
 * Hermetic by construction: exercises `matchAutomod` / `MemoryRepeatTracker`
 * directly with literal fixtures. No database, no Discord client, no guild
 * writes — this file must stay free of `openTestDb` so it runs without
 * TWO_TEST_DATABASE_URL (like test/unit.automodmatcher.test.ts).
 *
 * Corpus discipline (this file's evasions are REVIEWED, so learn from the
 * mistake that cost a probe round): every non-ASCII row MUST be built with
 * `\uXXXX`/`\u{XXXXX}` escapes inside a plain ASCII literal, or via the
 * `E()` helper below. A raw non-ASCII literal is a trap — a homoglyph or a
 * lookalike can silently substitute for the intended codepoint and the test
 * passes for the wrong reason. `E()` additionally documents the codepoint in
 * the row so the next reader can audit it without a hexdump.
 *
 * What is pinned here, by class:
 *
 *   1. Invisible format characters (Cf, SHY, VS16) that `normalize()` lets
 *      through, splitting bad-words matches, the INVITE literal and repeat
 *      digests. Filed as [TOG-10048](/TOG/issues/TOG-10048).
 *   2. Combining-mark stacking (`\p{M}`) that split bad-words and repeat
 *      digests. FIXED by [TOG-10049](/TOG/issues/TOG-10049) (NFKD-strip in
 *      `normalize()` + `\p{M}`-tolerant gaps); the rows below pin the caught
 *      behaviour. Homoglyph / leet substitutions are a separate
 *      wordlist-level root cause, filed as [TOG-10066](/TOG/issues/TOG-10066)
 *      and pinned alongside.
 *   3. Bare-domain TLD allowlist gaps (only 15 TLDs in the alternation) that
 *      let scheme-less phishing links — including shorteners — through while
 *      the explicit-scheme path catches them. Filed as
 *      [TOG-10050](/TOG/issues/TOG-10050).
 *   4. Attachment-extension bypasses (trailing dot/space, fullwidth-dot
 *      separator that `normalize()` would fold but the attachment path never
 *      calls it, lookalike separators). Filed as
 *      [TOG-10051](/TOG/issues/TOG-10051).
 *   5. No-bypass pins: sharp-s/İ case semantics, NEL/MVS whitespace
 *      semantics, hyphen/digit word boundaries. Filed as
 *      [TOG-10052](/TOG/issues/TOG-10052).
 *
 * Expected-verdict convention: `null` rows are the BYPASS — the matcher
 * should have fired but does not (each cites its bug card). `*_PIN` constants
 * document the control/non-bypass rows so a future fix that over-blocks fails
 * loudly here instead of silently.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.automodmatcherbypassfuzz-offline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAutomod, MemoryRepeatTracker } from '../src/automod/matcher.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

const BASE_TIME = Date.parse('2026-09-29T00:00:00.000Z');

/** Decode `\\uXXXX` escapes in an ASCII literal into the real string. */
function E(asciiWithEscapes: string): string {
  return JSON.parse(`"${asciiWithEscapes}"`);
}

const policy: AutomodPolicy = {
  badWords: ['very bad', 'shit', 'strasse'],
  blockedAttachmentExtensions: ['exe'],
  allowedDomains: ['two.gg'],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

let seq = 0;
function message(overrides: Partial<AutomodMessage> = {}): AutomodMessage {
  seq += 1;
  return {
    guildId: '1545644954272137297',
    channelId: '1546211375251066941',
    messageId: `fuzz-${seq}`,
    authorId: '900000000000000001',
    authorIsBot: false,
    roleIds: [],
    content: 'ordinary message',
    mentionedUserIds: [],
    attachmentNames: [],
    observedTimestamp: BASE_TIME,
    ...overrides,
  };
}

function match(patch: Partial<AutomodMessage>, words: string[] = policy.badWords) {
  const probe: AutomodPolicy = words === policy.badWords ? policy : { ...policy, badWords: words };
  return matchAutomod(message(patch), probe, new MemoryRepeatTracker());
}

test('invisible format chars no longer split bad-words (TOG-10048)', () => {
  const caught: Array<[string, string]> = [
    ['soft hyphen U+00AD', E('very\\u00adbad')],
    ['left-to-right mark U+200E', E('very\\u200ebad')],
    ['right-to-left mark U+200F', E('very\\u200fbad')],
    ['bidi embedding U+202A', E('very\\u202abad')],
    ['bidi isolate FSI U+2066', E('very\\u2066bad')],
    ['bidi isolate PDI U+2069', E('very\\u2069bad')],
    ['invisible separator U+2063', E('very\\u2063bad')],
    ['mongolian vowel separator U+180E', E('very\\u180ebad')],
  ];
  for (const [name, content] of caught) {
    assert.equal(match({ content }), 'bad_words', `${name}: caught (TOG-10048)`);
  }
  // VS16 U+FE0F is category Mn, so the TOG-10049 mark-strip catches it as a
  // side effect — pinned as caught, not bypass.
  assert.equal(match({ content: E('very\\ufe0fbad') }), 'bad_words', 'VS16 U+FE0F caught via TOG-10049');
});

test('combining marks no longer split bad-words or repeat counts (TOG-10049)', () => {
  // Fixed: NFKD-strip in normalize() folds every row to the plain phrase.
  const caught: Array<[string, string]> = [
    ['combining acute U+0301 on the e', E('ve\\u0301ry bad')],
    ['combining dot above U+0307 splitting the words', E('very\\u0307bad')],
    ['combining enclosing U+20DD on the a', E('very b\\u20ddad')],
  ];
  for (const [name, content] of caught) {
    assert.equal(match({ content }, ['very bad']), 'bad_words', `${name}: caught (TOG-10049)`);
  }
  // Mark variants now hash to one digest: the third sighting trips the count.
  const tracker = new MemoryRepeatTracker();
  const texts = ['repeat me', E('repe\\u0301at me'), E('repeat me\\u0301')];
  const outcomes = texts.map((content, i) =>
    matchAutomod(
      message({ messageId: `mark-${i}`, content, observedTimestamp: BASE_TIME + i * 1000 }),
      policy,
      tracker,
    ),
  );
  assert.deepEqual(outcomes, [null, null, 'repeated_message'], 'mark variants share one digest (TOG-10049)');
});

test('invisible format chars no longer split repeat counts (TOG-10048)', () => {
  const tracker = new MemoryRepeatTracker();
  // Insert invisibles without removing a visible space: whitespace is meaningful.
  const texts = ['repeat me', E('re\\u200bpeat me'), E('repeat me\\u200c')];
  const outcomes = texts.map((content, i) =>
    matchAutomod(
      message({ messageId: `zw-${i}`, content, observedTimestamp: BASE_TIME + i * 1000 }),
      policy,
      tracker,
    ),
  );
  assert.deepEqual(outcomes, [null, null, 'repeated_message'], 'zero-width variants share one digest (TOG-10048)');
});

test('bypass fuzz: homoglyph substitution defeats bad-words (TOG-10066)', () => {
  // Cyrillic lookalikes are visually identical but different codepoints;
  // NFKC does not fold scripts. Pinned as bypass alongside combining marks.
  const bypasses: Array<[string, string, string[]]> = [
    ['cyrillic ie U+0435 for e', E('v\\u0435ry bad'), ['very bad']],
    ['cyrillic i U+0456 for i', E('sh\\u0456t happens'), ['shit']],
  ];
  for (const [name, content, words] of bypasses) {
    assert.equal(match({ content }, words), null, `${name}: still bypasses`);
  }
});

test('invisible chars and hyphenation point no longer defeat invites (TOG-10048)', () => {
  for (const content of [
    E('join discord\\u180e.gg/example'),
    E('join discord\\u180egg/example'),
    E('join discord\\u2027gg/example'),
  ]) {
    assert.equal(match({ content }), 'invite_link', 'invite evasion caught (TOG-10048)');
  }
});

test('bare-domain TLD gaps and dot lookalikes no longer bypass links (TOG-10050)', () => {
  // The IANA snapshot covers shorteners, ccTLDs, generic and punycode TLDs.
  // Bare-dot folding catches separators with no NFKC fold to ASCII.
  const caughtBare: Array<[string, string]> = [
    ['shortener bit.ly', 'read bit.ly/abc'],
    ['shortener caps BIT.LY', 'read BIT.LY/ABC'],
    ['germany .de', 'read evil.de/x'],
    ['generic .link', 'read evil.link/x'],
    ['generic .shop', 'read evil.shop/x'],
    ['generic .online', 'read evil.online/x'],
    ['generic .club', 'read evil.club/x'],
    ['generic .ai', 'read evil.ai/x'],
    ['short .ly', 'read evil.ly/x'],
    ['punycode IDN TLD', 'read evil.xn--p1ai/abc'],
    ['ideographic stop U+3002 as dot', E('read evil\\u3002net/x')],
    ['halfwidth stop U+FF61 as dot', E('read evil\\uff61net/x')],
    ['middle dot U+00B7 as dot (bare)', E('read evil\\u00b7net/x')],
    ['hyphenation point U+2027 as dot (bare)', E('read evil\\u2027net/x')],
  ];
  for (const [name, content] of caughtBare) {
    assert.equal(match({ content }), 'external_link', `${name}: caught (TOG-10050)`);
  }
  // Parity: the explicit-scheme form of representative hosts IS caught.
  const caught: Array<[string, string]> = [
    ['scheme bit.ly', 'read https://bit.ly/abc'],
    ['scheme evil.de', 'read https://evil.de/x'],
    ['scheme middle-dot folds host', E('see https://evil\\u00b7net/x')],
  ];
  for (const [name, content] of caught) {
    assert.equal(match({ content }), 'external_link', `${name}: scheme form caught (parity)`);
  }
});

test('bypass fuzz: attachment extension evasions (TOG-10051)', () => {
  // Fixed: every row is now caught as 'attachment_type'.
  const bypasses: Array<[string, string[]]> = [
    ['trailing dot', ['payload.exe.']],
    ['trailing space', ['payload.exe ']],
    ['fullwidth dot U+FF0E separator', [E('payload\\uff0eexe')]],
    ['soft hyphen U+00AD in extension', [E('payload.e\\u00adxe')]],
    ['RTL override U+202E in extension', [E('payload.ex\\u202ee')]],
    ['zero-width space in extension', [E('payload.e\\u200bxe')]],
  ];
  for (const [name, attachmentNames] of bypasses) {
    assert.equal(
      match({ content: 'ordinary message', attachmentNames }),
      'attachment_type',
      `${name}: caught (TOG-10051)`,
    );
  }
  // Controls that must keep working after any fix.
  assert.equal(
    match({ content: 'ordinary message', attachmentNames: ['payload.EXE'] }),
    'attachment_type',
    'plain exe still caught',
  );
  assert.equal(
    match({ content: 'ordinary message', attachmentNames: ['.exe'] }),
    'attachment_type',
    'dotfile exe still caught',
  );
});

// --- no-bypass pins (TOG-10052): correct behaviour, must not over-block -----

test('no-bypass pins: case folding semantics (TOG-10052)', () => {
  // Turkish dotted capital I lowercases to i + combining dot, not plain i.
  assert.equal(match({ content: E('SH\\u0130T happens') }, ['shit']), null, 'İ ≠ i under NFKC+lowercase');
  // Capital sharp-s lowercases to ß, not ss.
  assert.equal(match({ content: E('STRA\\u1e9ESSE bahn') }, ['strasse']), null, 'ẞ ≠ ss under NFKC+lowercase');
  // Kelvin sign DOES fold to k — control proving the escape discipline works.
  assert.equal(match({ content: E('\\u212aICK him') }, ['kick']), 'bad_words', 'Kelvin K folds to k');
  // Long s and ﬁ ligature fold under NFKC — controls.
  assert.equal(match({ content: E('\\u017fhit happens') }, ['shit']), 'bad_words', 'long s folds to s');
  assert.equal(match({ content: E('\\ufb01re alarm') }, ['fire']), 'bad_words', 'ﬁ ligature folds to fi');
});

test('no-bypass pins: whitespace and separator semantics (TOG-10052)', () => {
  // NEL U+0085 is not matched by JS \s: the words stay glued. Pinned.
  assert.equal(match({ content: E('very\\u0085bad') }, ['very bad']), null, 'NEL is not \\s in JS');
  // MVS is Cf, not whitespace: strip it as an invisible evasion (TOG-10048).
  assert.equal(match({ content: E('very\\u180ebad') }, ['very bad']), 'bad_words', 'MVS is stripped');
  // Hyphens and digits are word characters per the boundary guard — correct.
  for (const content of ['very-bad', E('very\\u2011bad'), 'very2bad news']) {
    assert.equal(match({ content }, ['very bad']), null, `${JSON.stringify(content)} is a word-boundary miss`);
  }
});

test('no-bypass pins: full-stop lookalikes that already fold (TOG-10052)', () => {
  // NFKC folds fullwidth stop to ASCII dot before the bare-domain regex runs.
  assert.equal(match({ content: E('read evil\\uff0enet/x') }), 'external_link', 'fullwidth stop folds');
  // U+2027 has no NFKC decomposition; its explicit bare-dot fold and the
  // invite literal are covered by the caught regression rows above.
});
