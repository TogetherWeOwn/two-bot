/**
 * Temp-voice channel-name abuse corpus (TOG-6502).
 *
 * Pure unit test: exercises `filterChannelName` (create-path names through
 * automod) with no Discord client, no guild writes, no DB. The corpus pins the
 * filter's verdicts so future matcher/sanitizer drift shows up here first:
 *
 * - slurs-by-obfuscation the automod matcher catches (spaced, zero-width,
 *   fullwidth-folded, case-folded) are rejected;
 * - mass-mention sigils are NEUTRALISED (stripped, accepted) rather than
 *   rejected — channel names never render as message content, so there is
 *   nobody to ping; the assertion is that no `@`/backtick survives;
 * - zalgo / RTL-spoof names are NEUTRALISED (combining-mark floods and bidi
 *   overrides stripped, accepted as the cleaned name) — and a bad word hiding
 *   behind combining marks folds to the plain word, so the matcher rejects it;
 * - over-long names are rejected at Discord's 100-char bound;
 * - normal game names pass (false-positive guard).
 *
 * Reviewer protocol for this file: add one corpus row, watch it fail, then add
 * the fix row. Table-driven on purpose.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filterChannelName } from '../src/tempVoice/nameFilter.ts';
import type { AutomodPolicy } from '../src/automod/types.ts';

const POLICY: AutomodPolicy = {
  badWords: ['badword'],
  blockedAttachmentExtensions: [],
  allowedDomains: [],
  repeatedMessageCount: 3,
  repeatedMessageWindowSeconds: 60,
  mentionLimit: 5,
  bypassRoleIds: new Set(),
  exemptChannelIds: new Set(),
  sanctions: [],
};

const where = { guildId: '1545644954272137297', channelId: '1546211381844512798', userId: '1546451670500642001' };

describe('tempVoice nameFilter abuse corpus', () => {
  test('rejects slurs-by-obfuscation the matcher catches', () => {
    const blocked = [
      'a badword room',
      'BADWORD room',
      'b a d w o r d room',
      'b⁠a⁠d⁠w⁠o⁠r⁠d room',
      'ｂａｄｗｏｒｄ room',
    ];
    for (const input of blocked) {
      assert.equal(filterChannelName(input, POLICY, where).ok, false, JSON.stringify(input));
    }
  });

  test('rejects invite and external links, incl obfuscated hosts', () => {
    const blocked = [
      'join discord.gg/abc',
      'discord⁠.gg/abc',
      'check https://evil.example/x out',
      'go WWW.EVIL.EXAMPLE/x now',
    ];
    for (const input of blocked) {
      assert.equal(filterChannelName(input, POLICY, where).ok, false, JSON.stringify(input));
    }
  });

  test('neutralises mass-mention sigils instead of rejecting', () => {
    const cases: Array<[string, string]> = [
      ['@everyone raid now', 'everyone raid now'],
      ['@here grind', 'here grind'],
      ['```ping``` room', 'ping room'],
    ];
    for (const [input, name] of cases) {
      const result = filterChannelName(input, POLICY, where);
      assert.deepEqual(result, { ok: true, name });
      assert.ok(!result.name.includes('@') && !result.name.includes('`'), JSON.stringify(input));
    }
  });

  test('neutralises zalgo/RTL spoofing instead of passing it through', () => {
    // Combining-mark floods and bidi overrides are stripped in sanitize, so
    // the displayed name is the cleaned one. A bad word hidden behind
    // combining marks folds to the plain word and is rejected by the matcher.
    const cases: Array<[string, string]> = [
      ['zalgo c\u0336o\u0336o\u0336l\u0336 room', 'zalgo cool room'],
      ['room \u202e evil', 'room evil'],
    ];
    for (const [input, name] of cases) {
      assert.deepEqual(filterChannelName(input, POLICY, where), { ok: true, name });
    }
    assert.equal(filterChannelName('b\u0336a\u0336d\u0336w\u0336o\u0336r\u0336d room', POLICY, where).ok, false);
  });

  test('rejects over-long names at the 100-char bound', () => {
    assert.equal(filterChannelName('x'.repeat(100), POLICY, where).ok, true);
    assert.equal(filterChannelName('x'.repeat(101), POLICY, where).ok, false);
    // A stripped bidi override does not inflate length: 100 visible chars +
    // one override is exactly at the bound, so it is accepted as the 100 x's.
    assert.deepEqual(filterChannelName(`${'x'.repeat(100)}‮`, POLICY, where), { ok: true, name: 'x'.repeat(100) });
    assert.equal(filterChannelName(`${'x'.repeat(101)}‮`, POLICY, where).ok, false);
  });

  test('allows normal game names (false-positive guard)', () => {
    const allowed = [
      'Valorant squad',
      'Friday night customs',
      'Chill & grind 18+',
      "ava's lobby",
      'squad-4 | ranked',
      'café night',
      'naïve lobby',
      '東京 ranked grind',
      'القاهرة lobby',
      '카페 방',
      'Москва squad',
    ];
    for (const input of allowed) {
      const result = filterChannelName(input, POLICY, where);
      assert.deepEqual(result, { ok: true, name: input });
    }
  });
});
