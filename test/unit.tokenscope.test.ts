/**
 * Token-scope least-privilege regression assertions (TOG-5054).
 *
 * Static review of the scopes and permission flags the bot asks for, pinned
 * as tests so a future widening is a red test on a laptop instead of a
 * silently broader grant. Offline by construction: no token, no network, no
 * database, no discord.js - only the repo's own files.
 *
 * Re-run: `node --test test/unit.tokenscope.test.ts`
 * Live-grant check (needs token + network): `npm run verify:grant`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED, NAMES, RATIONALE } from '../scripts/verify-grant.ts';
import { STAGING_INVITE_PERMISSIONS, stagingInviteUrl } from '../src/staging/spec.ts';

const root = join(import.meta.dirname, '..');

test('every workflow keeps its least-privilege permissions block', () => {
  // TOG-5054 finding F6: ci.yml had NO `permissions:` block (repo-default
  // token for a read-only workflow). TOG-5257 pinned it to `contents: read`,
  // so all five workflows are asserted here - dropping any block re-broadens
  // that workflow's token silently.
  for (const file of ['ci.yml', 'secret-scan.yml', 'main-guard.yml', 'plan-watch.yml', 'codeowners.yml']) {
    const body = readFileSync(join(root, '.github/workflows', file), 'utf8');
    assert.match(body, /^permissions:/m, `${file} must keep its permissions block`);
  }
});

test('every authorized grant bit has a name and a rationale', () => {
  // The live grant is an integer; review happens in English. A bit without a
  // name reports as "(unknown)" and a bit without a rationale cannot be
  // challenged - both are how an extra bit survives review unnoticed.
  const bits: number[] = [];
  for (let b = 0; b < 64; b++) if ((EXPECTED >> BigInt(b)) & 1n) bits.push(b);
  assert.deepEqual(bits, [0, 5, 10, 11, 28, 33], 'the live least-privilege set changed - see docs/SECRETS.md');
  for (const b of bits) {
    assert.ok(NAMES[b], `live bit ${b} has no name in verify-grant.ts`);
    assert.ok(RATIONALE[b], `live bit ${b} has no rationale in verify-grant.ts`);
  }
  // Staging-only enforcement bits must also resolve to English. TOG-5054 found
  // bits 40 (Moderate Members) and 44 (Create Events) absent from NAMES, so a
  // live grant carrying either reported it as "(unknown)" instead of by name.
  assert.equal(NAMES[40], 'Moderate Members');
  assert.equal(NAMES[44], 'Create Events');
});

test('both invite URLs request the application-commands scope', () => {
  // Over-narrow scope found by TOG-5054: the live URL in docs/SECRETS.md
  // invited with `scope=bot` only, while `guild.commands.set` in
  // src/discord/commandRegistry.ts publishes slash commands - which needs the
  // `applications.commands` scope, or registration 403s. Staging already
  // invites with both scopes; the live URL must match.
  assert.ok(
    stagingInviteUrl().includes('scope=bot%20applications.commands'),
    'staging invite must keep the applications.commands scope',
  );
  const secrets = readFileSync(join(root, 'docs/SECRETS.md'), 'utf8');
  const urls = [...secrets.matchAll(/https:\/\/discord\.com\/api\/oauth2\/authorize\?[^\s)]+/g)].map((m) => m[0]);
  assert.ok(urls.length >= 1, 'expected a live invite URL in docs/SECRETS.md');
  for (const url of urls) {
    assert.ok(url.includes('permissions=8858373153'), `live invite must carry the six-bit grant: ${url}`);
    assert.ok(
      url.includes('applications.commands'),
      `live invite must carry the applications.commands scope or slash-command registration 403s: ${url}`,
    );
  }
});

test('the staging invite stays Administrator-free', () => {
  // Staging is where we prove the live bot needs no more than the scoped set.
  // An Administrator staging invite would make every staging run pass and
  // prove nothing about production. (Also pinned in unit.staging.test.ts;
  // repeated here so the whole scope surface is re-runnable from one file.)
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 3n), 0n, 'Administrator');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 2n), 0n, 'Ban Members');
  assert.equal(STAGING_INVITE_PERMISSIONS & (1n << 1n), 0n, 'Kick Members');
});
