/**
 * Session routing (TOG-1644 / TOG-1654), unit level: the pure decisions.
 *
 * Everything asserted here is the acceptance the CPO wrote on TOG-1654:
 * two options, exact labels, exact destinations, no roles anywhere in the
 * plan, idempotent re-selection, and a safe retry (not a crash, not a silent
 * nothing) on invalid or stale keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOKING_TO_PLAY_CHANNEL_ID,
  LOBBY_VOICE_CHANNEL_ID,
  SESSION_PICKS,
  goodbyeText,
  daysInGuild,
  buildSessionPicks,
  planSession,
  pickByKey,
  sessionAckText,
  sessionWelcomeText,
} from '../src/onboarding/session.ts';

const anyVisible = () => true;
const nothingVisible = () => false;

test('the picker offers exactly the two accepted options, in order', () => {
  assert.deepEqual(
    SESSION_PICKS.map((p) => p.key),
    ['find-players', 'join-voice'],
  );
  assert.equal(SESSION_PICKS[0].label, 'Find people to play with');
  assert.equal(SESSION_PICKS[1].label, 'Join voice now');
});

test('both destinations are the accepted clean-slate channels', () => {
  assert.equal(pickByKey('find-players')!.channelId, LOOKING_TO_PLAY_CHANNEL_ID);
  assert.equal(pickByKey('join-voice')!.channelId, LOBBY_VOICE_CHANNEL_ID);
  assert.equal(LOOKING_TO_PLAY_CHANNEL_ID, '1546211377847337020'); // #looking-to-play
  assert.equal(LOBBY_VOICE_CHANNEL_ID, '1546211378430345286'); // Lobby
});

test('no pick carries a role - the structure forbids it', () => {
  for (const p of SESSION_PICKS) {
    assert.equal('roleId' in p, false, `${p.key} must not have a roleId`);
  }
});

test('runtime session picks use the configured guild channel ids', () => {
  const picks = buildSessionPicks({ lookingToPlay: '111111111111111111', lobbyVoice: '222222222222222222' });
  assert.deepEqual(picks.map((p) => p.channelId), ['111111111111111111', '222222222222222222']);
});

test('planSession: both keys -> both destinations, deduped and ordered', () => {
  const plan = planSession(['find-players', 'join-voice'], anyVisible);
  assert.deepEqual(plan.channelIds, [LOOKING_TO_PLAY_CHANNEL_ID, LOBBY_VOICE_CHANNEL_ID]);
  assert.deepEqual(plan.unknownKeys, []);
  assert.deepEqual(plan.unavailable, []);
});

test('planSession: channelIds follow catalog order regardless of submission order (TOG-7439)', () => {
  const plan = planSession(['join-voice', 'find-players'], anyVisible);
  assert.deepEqual(plan.channelIds, [LOOKING_TO_PLAY_CHANNEL_ID, LOBBY_VOICE_CHANNEL_ID]);
  assert.deepEqual(
    plan.picks.map((p) => p.key),
    ['find-players', 'join-voice'],
  );
});

test('planSession: re-selecting the same option is idempotent', () => {
  const once = planSession(['find-players'], anyVisible);
  const twice = planSession(['find-players', 'find-players'], anyVisible);
  assert.deepEqual(once, twice, 'duplicate submissions must plan identically');
  assert.deepEqual(once.channelIds, [LOOKING_TO_PLAY_CHANNEL_ID]);
});

test('planSession: an invisible destination is withheld, not linked', () => {
  const plan = planSession(['join-voice'], nothingVisible);
  assert.deepEqual(plan.channelIds, []);
  assert.deepEqual(plan.unavailable.map((p) => p.key), ['join-voice']);
  // And the ack must not contain the id of a room they cannot open.
  assert.doesNotMatch(sessionAckText(plan), new RegExp(LOBBY_VOICE_CHANNEL_ID));
});

test('planSession: a stale key no longer sinks the valid picks (TOG-8768)', () => {
  // A stale panel from before an option was renamed or removed: the stale key
  // is reported, but the valid pick routes alongside it - like planSelection.
  const plan = planSession(['survival', 'find-players'], anyVisible);
  assert.deepEqual(plan.unknownKeys, ['survival']);
  assert.deepEqual(plan.channelIds, [LOOKING_TO_PLAY_CHANNEL_ID]);
  const ack = sessionAckText(plan);
  assert.match(ack, new RegExp(`<#${LOOKING_TO_PLAY_CHANNEL_ID}>`), 'valid pick must still link');
  assert.match(ack, /stale/i, 'the stale part must still surface a retry note');
  assert.doesNotMatch(ack, /nothing was changed/i, 'must not claim nothing changed when a pick routed');
});

test('planSession: an entirely unknown submission routes nothing and offers a retry', () => {
  const none = planSession(['nonsense'], anyVisible);
  assert.deepEqual(none.channelIds, []);
  assert.deepEqual(none.unknownKeys, ['nonsense']);
  assert.match(sessionAckText(none), /stale/i);
  assert.match(sessionAckText(none), /nothing was changed/i);
});

test('sessionAckText: an all-unknown submission offers a retry, not silence', () => {
  const plan = planSession(['gone-option'], anyVisible);
  const ack = sessionAckText(plan);
  assert.match(ack, /stale/i);
  assert.match(ack, /open the picker again/i);
  assert.match(ack, /nothing was changed/i);
});

test('sessionAckText: a normal selection links the destination', () => {
  const ack = sessionAckText(planSession(['find-players'], anyVisible));
  assert.match(ack, new RegExp(`<#${LOOKING_TO_PLAY_CHANNEL_ID}>`));
  assert.doesNotMatch(ack, new RegExp(LOBBY_VOICE_CHANNEL_ID));
});

test('sessionAckText is byte-identical across identical submissions', () => {
  const a = sessionAckText(planSession(['join-voice'], anyVisible));
  const b = sessionAckText(planSession(['join-voice'], anyVisible));
  assert.equal(a, b);
});

test('welcome text greets the member and states the picker', () => {
  const text = sessionWelcomeText('<@123>');
  assert.match(text, /<@123>/);
  assert.match(text, /what do you want to do right now/i);
  assert.match(text, /not a label forever/i);
});

test('goodbyeText: names the leaver, states the stay, never pings', () => {
  assert.equal(goodbyeText('dave', 3), '**dave** left the server (was here 3 days). Their messages and voice history stay on the books.');
  assert.equal(goodbyeText('sam', 1), '**sam** left the server (was here 1 day). Their messages and voice history stay on the books.');
  assert.equal(goodbyeText('kim', 0), '**kim** left the server (was here less than a day). Their messages and voice history stay on the books.');
  // Unknown join date says nothing rather than inventing a number.
  assert.equal(goodbyeText('lee', null), '**lee** left the server. Their messages and voice history stay on the books.');
  for (const t of [goodbyeText('dave', 3), goodbyeText('lee', null)]) {
    assert.doesNotMatch(t, /<@/);
  }
});

test('daysInGuild floors whole days and rejects nonsense', () => {
  const t0 = '2026-09-01T12:00:00Z';
  assert.equal(daysInGuild(t0, '2026-09-04T11:00:00Z'), 2);
  assert.equal(daysInGuild(t0, '2026-09-04T13:00:00Z'), 3);
  assert.equal(daysInGuild(null, t0), null);
  assert.equal(daysInGuild('not-a-date', t0), null);
});
