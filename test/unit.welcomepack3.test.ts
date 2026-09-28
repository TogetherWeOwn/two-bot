/**
 * TOG-7184: welcome-post pack 3 staging dry-run — render without posting.
 *
 * Renders `community/welcome-post-refresh-pack3.md`'s two voices through the
 * real `anchorWelcomeText()` at post-pilot dates (after Mon 12 Oct 2026) and
 * prints both so the reviewer sees the exact post text in test output.
 *
 * OFFLINE BY CONSTRUCTION: this file imports only `src/onboarding/anchorEvent.ts`
 * (pure strings + date maths) and `src/staging/spec.ts` (id constants). It never
 * imports `discord.js`, never reads a token, never touches the network — so a
 * green run is proof of zero live Discord writes. The static test below pins
 * that property instead of trusting it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUNDAY_SQUAD,
  anchorWelcomeText,
  occurrenceContext,
} from '../src/onboarding/anchorEvent.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

// Post-pilot dates per the pack ("from Mon 12 Oct 2026"): a quiet Wednesday
// (>2h before the event) and one hour before Sunday's 20:00 ET start.
const NORMAL_AT = Date.parse('2026-10-14T15:00:00Z'); // Wed 14 Oct 2026
const NEAR_AT = Date.parse('2026-10-18T23:00:00Z'); // Sun 18 Oct, 19:00 ET
const MEMBER = '@member'; // pack placeholder, as written in the draft

const PACK_FIRST = `Hey ${MEMBER} — glad you're here.`;
const PACK_LAST =
  "You don't need to sign up or say anything first — just join the voice room and I'll get you into the party. Haven't got Fall Guys? Come anyway, there's something we can play right there in the room. If you can't make Sunday, hop in whenever and see who's about.";
const PACK_NEAR_MIDDLE =
  'The thing to know: **Sunday Squad** is happening right now in <#1175127344072118405> — Fall Guys, for about another hour. Come say hi. You don\'t need it installed to join in.';

test('pack 3 normal voice renders against staging config (dry-run, no post)', () => {
  const ctx = occurrenceContext(NORMAL_AT);
  assert.equal(ctx.near, false, 'Wednesday fixture must take the normal voice');

  const text = anchorWelcomeText(MEMBER, NORMAL_AT);
  // The evidence the card asks for: the reviewer reads this in test output.
  console.log('--- TOG-7184 pack 3 dry-run: normal voice ---\n' + text + '\n--- end normal voice ---');

  const paras = text.split('\n\n');
  assert.equal(paras.length, 3);
  assert.equal(paras[0], PACK_FIRST);
  assert.equal(paras[2], PACK_LAST);
  assert.match(
    paras[1],
    /The thing to know: \*\*Sunday Squad\*\*, every Sunday at 8pm Eastern in <#1175127344072118405>\. We play Fall Guys for about an hour\. Next one is <t:\d{10}:R>\./,
  );
  // Pack's intended channel is the Lobby text chat; the renderer posts there.
  assert.equal(SUNDAY_SQUAD.channelId, '1175127344072118405');
  assert.ok(text.includes(`<#${SUNDAY_SQUAD.channelId}>`));
  // Computed relative timestamp, never a written-out date that can go stale.
  assert.match(text, /<t:\d{10}:R>/);
  assert.doesNotMatch(text, /2026|2027/);
  assert.equal(text.match(/<@|@everyone|@here/)?.[0], undefined, 'pack placeholder is not a real ping');
  assert.ok(text.length <= 2000, 'still one Discord message');
});

test('pack 3 near-event voice renders against staging config (dry-run, no post)', () => {
  const ctx = occurrenceContext(NEAR_AT);
  assert.equal(ctx.near, true, 'one hour before start must take the near-event voice');

  const text = anchorWelcomeText(MEMBER, NEAR_AT);
  console.log('--- TOG-7184 pack 3 dry-run: near-event voice ---\n' + text + '\n--- end near-event voice ---');

  const paras = text.split('\n\n');
  assert.equal(paras.length, 3);
  assert.equal(paras[0], PACK_FIRST);
  assert.equal(paras[1], PACK_NEAR_MIDDLE);
  assert.equal(paras[2], PACK_LAST);
  assert.doesNotMatch(text, /<t:\d+:R>/, 'live copy names no occurrence');
});

test('zero live Discord writes: renderer is offline and staging is not live', () => {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const src = readFileSync(resolve(root, 'src/onboarding/anchorEvent.ts'), 'utf8');
  for (const marker of ['discord.js', 'DISCORD_TOKEN', 'DISCORD_BOT_TOKEN', 'fetch(', 'globalThis.fetch', 'node-fetch']) {
    assert.ok(!src.includes(marker), `renderer must not reference ${marker}`);
  }
  // Staging guardrails: the staging guild is a fixed non-live id.
  assert.notEqual(TWO_STAGING_GUILD_ID, LIVE_GUILD_ID);
  assert.equal(LIVE_GUILD_ID, '326474832151838730');
  assert.equal(TWO_STAGING_GUILD_ID, '1545644954272137297');
  // This dry-run performed no sends: the only outbound path (anchorWelcome.ts
  // `target.send`) lives outside the imported renderer and was never called.
});
