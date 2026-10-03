/**
 * Automod wordlist lint (TOG-10066).
 *
 * Hermetic by construction: exercises `lintWordlist` in
 * `src/automod/wordlist.ts` directly plus the `scripts/automod-wordlist-lint.ts`
 * CLI via `spawnSync` with literal fixtures. No database, no Discord client,
 * no guild writes -- this file must stay free of `openTestDb` so it runs
 * without TWO_TEST_DATABASE_URL.
 *
 * Escape discipline (same as the bypass fuzz corpus): every non-ASCII row is
 * built with `\uXXXX` escapes inside a plain ASCII literal via `E()` below,
 * so a homoglyph can never silently substitute for the intended codepoint
 * in this file.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.automodwordlistlint-offline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { matchAutomod, MemoryRepeatTracker } from '../src/automod/matcher.ts';
import { lintWordlist } from '../src/automod/wordlist.ts';
import type { AutomodMessage, AutomodPolicy } from '../src/automod/types.ts';

/** Decode `\uXXXX` escapes in an ASCII literal into the real string. */
function E(asciiWithEscapes: string): string {
  return JSON.parse(`"${asciiWithEscapes}"`);
}

const BASE_TIME = Date.parse('2026-09-30T00:00:00.000Z');

function message(content: string): AutomodMessage {
  return {
    guildId: '1545644954272137297',
    channelId: '1546211375251066941',
    messageId: 'lint-probe',
    authorId: '900000000000000001',
    authorIsBot: false,
    roleIds: [],
    content,
    mentionedUserIds: [],
    attachmentNames: [],
    observedTimestamp: BASE_TIME,
  };
}

function match(content: string, words: string[]): string | null {
  const policy: AutomodPolicy = {
    badWords: words,
    blockedAttachmentExtensions: ['exe'],
    allowedDomains: ['two.gg'],
    repeatedMessageCount: 3,
    repeatedMessageWindowSeconds: 30,
    mentionLimit: 3,
    bypassRoleIds: new Set(),
    exemptChannelIds: new Set(),
    sanctions: [],
  };
  return matchAutomod(message(content), policy, new MemoryRepeatTracker());
}

test('lint flags uncovered homoglyph and leet variants (TOG-10066)', () => {
  const suggestions = lintWordlist(['shit']);
  const homoglyph = suggestions.find((s) => s.kind === 'homoglyph');
  const leet = suggestions.find((s) => s.kind === 'leet');
  assert.ok(homoglyph, 'expected a homoglyph suggestion for shit');
  assert.ok(leet, 'expected a leet suggestion for shit');
  // Pinned bypass forms must be among the suggestions: adding them closes it.
  assert.ok(homoglyph.variants.includes(E('sh\\u0456t')), 'cyrillic-i variant suggested');
  assert.ok(leet.variants.includes('sh1t'), 'leet sh1t suggested');
});

test('suggested variants close the pinned bypass rows (TOG-10066)', () => {
  // Fuzz corpus pins these as bypass (null); the wordlist fix is to carry
  // the variants the lint suggests.
  const byWord: Array<[string, string, string[]]> = [
    ['very bad', E('v\\u0435ry bad'), ['very bad']],
    ['shit', E('sh\\u0456t happens'), ['shit']],
  ];
  for (const [label, content, words] of byWord) {
    assert.equal(match(content, words), null, `${label}: bypass still open without variants`);
    const variants = lintWordlist(words).flatMap((s) => s.variants);
    assert.equal(match(content, [...words, ...variants]), 'bad_words', `${label}: suggested variants catch it`);
  }
});

test('leet suggestions enforce without silently expanding the base policy (TOG-10066)', () => {
  const words = ['shit'];
  assert.equal(match('sh1t', words), null);
  const variants = lintWordlist(words).flatMap((s) => s.variants);
  assert.equal(match('sh1t', [...words, ...variants]), 'bad_words');
  assert.equal(match('v3ry b4d', ['very bad']), null);
  assert.equal(match('v3ry b4d', ['very bad', 'v3ry b4d']), 'bad_words');
});

test('lint uses normalized coverage and does not flag single-script words (TOG-10066)', () => {
  const words = ['cat', E('\\u03c2at')];
  const suggestions = lintWordlist(words);
  const homoglyph = suggestions.find((s) => s.entry === 'cat' && s.kind === 'homoglyph');
  assert.ok(homoglyph);
  // Greek lunate sigma U+03F2 normalizes to final sigma U+03C2 in the matcher.
  assert.ok(!homoglyph.variants.includes(E('\\u03f2at')));
  assert.deepEqual(lintWordlist(['cat', ' CAT ']), lintWordlist(['cat']));
  assert.deepEqual(lintWordlist([E('\\u0431\\u0430\\u0434')]), []);
  assert.deepEqual(lintWordlist([E('\\u03b1\\u03b2\\u03b3')]), []);
});

test('lint stays quiet for covered variants and empty input (TOG-10066)', () => {
  const covered = lintWordlist(['shit', E('sh\\u0456t')]);
  const homoglyph = covered.find((s) => s.kind === 'homoglyph');
  assert.ok(homoglyph, 'other variants still suggested');
  assert.ok(!homoglyph.variants.includes(E('sh\\u0456t')), 'covered variant not re-suggested');
  assert.deepEqual(lintWordlist([]), [], 'no entries, no suggestions');
  assert.deepEqual(lintWordlist(['', '   ']), [], 'blank entries skipped like the matcher skips them');
});

test('lint flags mixed-script entries as suspicious (TOG-10066)', () => {
  const suggestions = lintWordlist([E('sh\\u0456t')]);
  assert.equal(suggestions.length, 1, 'one mixed-script suggestion');
  assert.equal(suggestions[0]!.kind, 'mixed-script');
  assert.deepEqual(suggestions[0]!.variants, [], 'no variants: verify by hand, do not auto-expand');
});

test('lint CLI: advisory JSON, strict gate, and never-a-pass exit 2 (TOG-10066)', () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ['scripts/automod-wordlist-lint.ts', ...args], {
      env,
      encoding: 'utf8',
    });
  const baseEnv = { ...process.env, TWO_AUTOMOD_BAD_WORDS: 'very bad,shit' };

  const advisory = run([], baseEnv);
  assert.equal(advisory.status, 0, 'suggestions print but exit stays 0 without --strict');
  const payload = JSON.parse(advisory.stdout) as { entries: number; suggestions: unknown[] };
  assert.equal(payload.entries, 2, 'two usable entries');
  assert.ok(payload.suggestions.length > 0, 'suggestions present');

  const strict = run(['--strict'], baseEnv);
  assert.equal(strict.status, 1, '--strict exits 1 with suggestions');

  const clean = run(['--words', E('sh\\u0456t')], { ...process.env, TWO_AUTOMOD_BAD_WORDS: '' });
  assert.equal(clean.status, 0, 'fully covered single variant: exit 0 even with --strict absent');

  const empty = run([], { ...process.env, TWO_AUTOMOD_BAD_WORDS: '' });
  assert.equal(empty.status, 2, 'empty wordlist: exit 2 is never a pass');
  assert.equal(run(['--words'], baseEnv).status, 2, 'missing argument is unreadable');
  assert.equal(run(['--words', '--strict'], baseEnv).status, 2, 'flag is not a wordlist value');
  assert.equal(run(['--words', E('\\u0431\\u0430\\u0434'), '--strict'], baseEnv).status, 0, 'single-script entry is not suspicious');
});
