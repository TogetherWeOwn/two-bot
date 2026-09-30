import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAutomod, MemoryRepeatTracker, normalizeBadWord } from '../src/automod/matcher.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

// Hermetic regression for TOG-10048: no DB, Discord client or credentials.
const policy: AutomodPolicy = {
  badWords: ['very bad'],
  blockedAttachmentExtensions: ['exe'],
  allowedDomains: ['two.gg'],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 30,
  mentionLimit: 3,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

function message(content: string, id = '1'): AutomodMessage {
  return {
    guildId: 'guild', channelId: 'channel', messageId: id, authorId: 'author',
    authorIsBot: false, roleIds: [], content, mentionedUserIds: [], attachmentNames: [],
    observedTimestamp: Number(id) * 1000,
  };
}

function match(content: string, probe = policy) {
  return matchAutomod(message(content), probe, new MemoryRepeatTracker());
}

// Numeric codepoints keep the corpus auditable without raw invisible literals.
const C = (codepoint: number) => String.fromCodePoint(codepoint);
const invisibles = [
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062,
  0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  0xfe00, 0xfe0f, 0xe0001, 0xe0061, 0xe0100, 0xe01ef,
].map(C);

test('invisible corpus cannot split bad-words, invites, external hosts or repeat digests', () => {
  for (const char of invisibles) {
    const label = `U+${char.codePointAt(0)!.toString(16)}`;
    assert.equal(match(`ve${char}ry bad`), 'bad_words', label);
    assert.equal(match('very bad', { ...policy, badWords: [`ve${char}ry bad`] }), 'bad_words', label);
    assert.equal(normalizeBadWord(`ve${char}ry bad`), 'verybad', label);
    assert.equal(match(`join dis${char}cord.gg/example`), 'invite_link', label);
    assert.equal(match(`join discord.com/in${char}vite/example`), 'invite_link', label);
    assert.equal(match(`read evil${char}.net/path`), 'external_link', label);
    assert.equal(match(`read two${char}.gg/rules`), null, label);
    const tracker = new MemoryRepeatTracker();
    const outcomes = ['repeat me', `re${char}peat me`, `repeat me${char}`].map((content, i) =>
      matchAutomod(message(content, String(i + 1)), policy, tracker),
    );
    assert.deepEqual(outcomes, [null, null, 'repeated_message'], label);
  }
});

test('invite separator support retains literal dots and nonempty invite codes', () => {
  for (const content of [`discord${C(0x2027)}gg/example`, `discord${C(0x180e)}gg/example`, 'www.discord.gg/example']) {
    assert.equal(match(content), 'invite_link', content);
  }
  for (const content of ['ordinary discord chat', 'discordgg/', 'discordXgg', 'discordXcom/invite/example']) {
    assert.notEqual(match(content), 'invite_link', content);
  }
});

test('stripping invisible characters preserves word boundaries and meaningful spaces', () => {
  for (const content of [`every${C(0x00ad)}bad thing`, `very${C(0x200e)}badly`, 'very_bad', 'very2bad']) {
    assert.equal(match(content), null, content);
  }
  const tracker = new MemoryRepeatTracker();
  const outcomes = ['repeat me', `repeat${C(0x200b)}me`, `repeat${C(0x200c)}me`].map((content, i) =>
    matchAutomod(message(content, String(i + 1)), policy, tracker),
  );
  assert.deepEqual(outcomes, [null, null, null], 'removing a visible space is not an equivalent message');
});

test('invisible-only messages and bad-word entries are empty after normalization', () => {
  const emptyPolicy = { ...policy, badWords: [invisibles.join('')] };
  assert.equal(match('ordinary message', emptyPolicy), null);
  const tracker = new MemoryRepeatTracker();
  for (let i = 1; i <= 4; i++) {
    assert.equal(matchAutomod(message(invisibles.join(''), String(i)), emptyPolicy, tracker), null);
  }
});
