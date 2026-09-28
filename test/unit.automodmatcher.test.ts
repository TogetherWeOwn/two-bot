/**
 * Automod matcher fixture suite (TOG-8674).
 *
 * Pure unit test: exercises `matchAutomod` / `MemoryRepeatTracker` directly
 * with literal fixtures. No database, no Discord client, no guild writes —
 * this file must stay free of `openTestDb` so it runs without
 * TWO_TEST_DATABASE_URL (unlike test/unit.automod.test.ts, which is
 * Postgres-gated at import).
 *
 * Table-driven on purpose: one test per matcher branch (plus precedence),
 * each with match / no-match / edge rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAutomod, MemoryRepeatTracker } from '../src/automod/matcher.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

const BASE_TIME = Date.parse('2026-09-09T06:00:00.000Z');

const policy: AutomodPolicy = {
  badWords: ['very bad', 'c++'],
  blockedAttachmentExtensions: ['exe'],
  allowedDomains: ['two.gg'],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

function message(overrides: Partial<AutomodMessage> = {}): AutomodMessage {
  return {
    guildId: '1545644954272137297',
    channelId: '1546211375251066941',
    messageId: '900000000000000010',
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

function match(patch: Partial<AutomodMessage>, tracker = new MemoryRepeatTracker()) {
  return matchAutomod(message(patch), policy, tracker);
}

test('bad_words: match, no-match and obfuscation edges', () => {
  const cases: Array<[string, string, string | null]> = [
    ['whole phrase', 'that was VERY   BAD.', 'bad_words'],
    ['case fold', 'THAT WAS very bad', 'bad_words'],
    ['fullwidth fold', 'that was ｖｅｒｙ ｂａｄ', 'bad_words'],
    ['spaced obfuscation', 'that was v e r y b a d', 'bad_words'],
    ['zero-width obfuscation', 'that was very​bad', 'bad_words'],
    ['punctuation boundary', 'that was (very bad!)', 'bad_words'],
    ['regex chars escaped', 'i love c++ lots', 'bad_words'],
    ['regex chars not over-matched', 'i love cxx lots', null],
    ['word boundary', 'very badly written', null],
    ['underscore boundary', 'very_bad news', null],
    ['substring of longer word is not a hit', 'everybad thing', null],
    ['clean message', 'ordinary message', null],
    ['empty message', '', null],
    ['whitespace only', '   ', null],
  ];
  for (const [name, content, expected] of cases) {
    assert.equal(match({ content }), expected, name);
  }
});

test('bad_words: empty word entries are skipped', () => {
  const emptyPolicy: AutomodPolicy = { ...policy, badWords: ['', '   ', 'very bad'] };
  assert.equal(matchAutomod(message({ content: 'ordinary message' }), emptyPolicy, new MemoryRepeatTracker()), null);
  assert.equal(matchAutomod(message({ content: 'that was very bad' }), emptyPolicy, new MemoryRepeatTracker()), 'bad_words');
  const blankPolicy: AutomodPolicy = { ...policy, badWords: ['', '   '] };
  assert.equal(matchAutomod(message({ content: 'anything at all' }), blankPolicy, new MemoryRepeatTracker()), null);
});

test('mention_spam: boundary at the limit', () => {
  assert.equal(match({ mentionedUserIds: [] }), null, 'no mentions');
  assert.equal(match({ mentionedUserIds: ['1', '2'] }), null, 'limit - 1');
  assert.equal(match({ mentionedUserIds: ['1', '2', '3'] }), 'mention_spam', 'at limit');
  assert.equal(match({ mentionedUserIds: ['1', '2', '3', '4'] }), 'mention_spam', 'over limit');
});

test('invite_link: variants match, non-invites do not', () => {
  const hits = [
    'join https://discord.gg/example',
    'join http://discord.gg/example',
    'join discord.gg/example',
    'join www.discord.gg/example',
    'join https://discord.com/invite/example',
    'join https://discordapp.com/invite/example',
    'JOIN HTTPS://DISCORD.GG/EXAMPLE',
    'join discord​.gg/example',
  ];
  for (const content of hits) {
    assert.equal(match({ content }), 'invite_link', content);
  }
  const misses: Array<[string, string, string | null]> = [
    ['plain chat', 'ordinary message', null],
    ['non-invite discord path', 'see https://discord.com/channels/1/2', 'external_link'],
    ['word invite alone', 'you are invited', null],
  ];
  for (const [name, content, expected] of misses) {
    assert.equal(match({ content }), expected, name);
  }
});

test('external_link: allowlist, bare domains and filename guards', () => {
  const cases: Array<[string, string, string | null]> = [
    ['allowed exact', 'read https://two.gg/rules', null],
    ['allowed www', 'read https://www.two.gg/rules', null],
    ['allowed subdomain', 'read https://foo.two.gg/rules', null],
    ['allowed bare', 'read two.gg/rules', null],
    ['allowed angle', 'read <https://two.gg/rules>', null],
    ['allowed trailing punct', 'read https://two.gg/rules.', null],
    ['allowed uppercase host', 'read HTTPS://WWW.TWO.GG/RULES', null],
    ['external', 'read https://example.net/rules', 'external_link'],
    ['scheme-less', 'read www.evil.example/path', 'external_link'],
    ['bare domain', 'read example.net/path', 'external_link'],
    ['bare subdomain', 'read foo.example.com/path', 'external_link'],
    ['zero-width host', 'read example​.net/path', 'external_link'],
    ['trailing punct stripped', 'see https://example.net/rules.', 'external_link'],
    ['email is not a link', 'email person@example.net', null],
    ['filename stem guard', 'see config.dev please', null],
    ['non-stem bare host flags', 'see evil.dev please', 'external_link'],
    ['package filename', 'inspect package.json', null],
    ['source path', 'inspect src/config.ts', null],
    ['readme filename', 'inspect README.md', null],
    ['tsconfig filename', 'inspect tsconfig.json', null],
    ['clean chat', 'ordinary message', null],
  ];
  for (const [name, content, expected] of cases) {
    assert.equal(match({ content }), expected, name);
  }
});

test('attachment_type: extension edges', () => {
  const cases: Array<[string, string[], string | null]> = [
    ['blocked upper', ['payload.EXE'], 'attachment_type'],
    ['blocked multi-dot', ['archive.tar.exe'], 'attachment_type'],
    ['safe png', ['screenshot.png'], null],
    ['no extension', ['README'], null],
    ['trailing dot', ['file.'], null],
    ['no attachments', [], null],
  ];
  for (const [name, attachmentNames, expected] of cases) {
    assert.equal(match({ attachmentNames }), expected, name);
  }
  const dotPolicy: AutomodPolicy = { ...policy, blockedAttachmentExtensions: ['.exe'] };
  assert.equal(
    matchAutomod(message({ attachmentNames: ['payload.exe'] }), dotPolicy, new MemoryRepeatTracker()),
    'attachment_type',
    'leading-dot policy entries work',
  );
});

test('filter precedence follows matcher order', () => {
  assert.equal(match({ content: 'very bad join https://discord.gg/x' }), 'bad_words', 'bad_words beats invite');
  assert.equal(
    match({ content: 'join https://discord.gg/x see https://example.net/y' }),
    'invite_link',
    'invite beats external',
  );
  assert.equal(
    match({ content: 'see https://example.net/y', attachmentNames: ['payload.exe'] }),
    'external_link',
    'external beats attachment',
  );
  assert.equal(
    match({ content: 'ordinary message', mentionedUserIds: ['1', '2', '3'], attachmentNames: ['payload.exe'] }),
    'mention_spam',
    'mention beats attachment',
  );
});

test('repeated_message: needs distinct ids with the same text inside the window', () => {
  const tracker = new MemoryRepeatTracker();
  const at = (ms: number) => BASE_TIME + ms;
  assert.equal(match({ messageId: '1', content: 'repeat me', observedTimestamp: at(0) }, tracker), null);
  assert.equal(match({ messageId: '1', content: 'other text', observedTimestamp: at(500) }, tracker), null, 'edit replaces same id');
  assert.equal(match({ messageId: '2', content: 'repeat me', observedTimestamp: at(1000) }, tracker), null);
  assert.equal(match({ messageId: '3', content: 'repeat me', observedTimestamp: at(2000) }, tracker), null);
  assert.equal(
    match({ messageId: '1', content: 'repeat me', observedTimestamp: at(3000) }, tracker),
    'repeated_message',
    'third distinct id trips the count',
  );
});

test('repeated_message: empty content never counts', () => {
  const tracker = new MemoryRepeatTracker();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      match({ messageId: `e${i}`, content: '   ', observedTimestamp: BASE_TIME + i * 1000 }, tracker),
      null,
      `empty ${i}`,
    );
  }
});

test('repeated_message: isolates authors and guilds, expires outside the window', () => {
  const tracker = new MemoryRepeatTracker();
  const at = (ms: number) => BASE_TIME + ms;
  assert.equal(match({ messageId: 'a1', content: 'same words', authorId: 'user-a', observedTimestamp: at(0) }, tracker), null);
  assert.equal(match({ messageId: 'b1', content: 'same words', authorId: 'user-b', observedTimestamp: at(1000) }, tracker), null);
  assert.equal(match({ messageId: 'b2', content: 'same words', authorId: 'user-b', observedTimestamp: at(2000) }, tracker), null);
  assert.equal(
    match({ messageId: 'b3', content: 'same words', authorId: 'user-b', observedTimestamp: at(3000) }, tracker),
    'repeated_message',
    'per-author counting trips at three',
  );
  assert.equal(
    match({ messageId: 'a2', content: 'same words', authorId: 'user-a', guildId: 'other-guild', observedTimestamp: at(4000) }, tracker),
    null,
    'other guild is a separate key',
  );
  const windowed = new MemoryRepeatTracker();
  assert.equal(match({ messageId: 'w1', content: 'windowed', observedTimestamp: at(0) }, windowed), null);
  assert.equal(match({ messageId: 'w2', content: 'windowed', observedTimestamp: at(1000) }, windowed), null);
  assert.equal(
    match({ messageId: 'w3', content: 'windowed', observedTimestamp: at(31_000) }, windowed),
    null,
    'first sighting expired outside the 30s window',
  );
  assert.equal(
    match({ messageId: 'w4', content: 'windowed', observedTimestamp: at(32_000) }, windowed),
    null,
    'still only two sightings inside the window',
  );
  assert.equal(
    match({ messageId: 'w5', content: 'windowed', observedTimestamp: at(33_000) }, windowed),
    'repeated_message',
    'third sighting inside the window trips',
  );
});

test('clean message returns null', () => {
  assert.equal(match({}), null);
  assert.equal(match({ content: 'hello everyone, see you at practice' }), null);
});
