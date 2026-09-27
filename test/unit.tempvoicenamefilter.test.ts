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
 * - zalgo / RTL-spoof names currently PASS THROUGH the sanitizer (documented
 *   below, not rejected) — tightening that is follow-up work, not this card;
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

  test('documents zalgo/RTL pass-through (accepted, follow-up to tighten)', () => {
    // The sanitizer NFKC-folds but keeps combining marks and bidi controls, so
    // these are accepted today. Pinned so any future tightening/fallback shows
    // up as a deliberate diff, not silent drift.
    const passthrough = ['zalgo c̶o̶o̶l̶ room', 'room ‮ evil'];
    for (const input of passthrough) {
      assert.equal(filterChannelName(input, POLICY, where).ok, true, JSON.stringify(input));
    }
  });

  test('rejects over-long names at the 100-char bound', () => {
    assert.equal(filterChannelName('x'.repeat(100), POLICY, where).ok, true);
    assert.equal(filterChannelName('x'.repeat(101), POLICY, where).ok, false);
    assert.equal(filterChannelName(`${'x'.repeat(100)}‮`, POLICY, where).ok, false);
  });

  test('allows normal game names (false-positive guard)', () => {
    const allowed = [
      'Valorant squad',
      'Friday night customs',
      'Chill & grind 18+',
      "ava's lobby",
      'squad-4 | ranked',
    ];
    for (const input of allowed) {
      const result = filterChannelName(input, POLICY, where);
      assert.deepEqual(result, { ok: true, name: input });
    }
  });
});
