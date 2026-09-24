import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedRequest } from '../tools/mock-discord/server.ts';
import { GAME_HUB_CHANNEL_ID, pickByKey } from '../src/onboarding/catalog.ts';
import { waitForInteractionReply } from './helpers/interactionReply.ts';

const TOKEN = 'mock-game-current';
const shooters = pickByKey('shooters')!;
function reply(content: string, token = TOKEN, original = '%40original'): CapturedRequest {
  return {
    method: 'PATCH',
    url: `/api/v10/webhooks/900000000000000002/${token}/messages/${original}`,
    body: { content },
  };
}

for (const original of ['@original', '%40original']) {
  test(`waits for a delayed ${original} reply from the selected interaction`, async () => {
    const captured = [reply('stale reply', 'mock-game-previous')];
    const waiting = waitForInteractionReply({ captured }, TOKEN);
    // Delivery happens after the first read, just as it can after channel_routed.
    queueMicrotask(() => captured.push(reply(GAME_HUB_CHANNEL_ID, TOKEN, original)));
    assert.match(await waiting, new RegExp(GAME_HUB_CHANNEL_ID));
  });
}

test('a missing reply times out despite unrelated writes and a deferred acknowledgement', async () => {
  const captured: CapturedRequest[] = [
    reply(GAME_HUB_CHANNEL_ID, 'mock-game-previous'),
    { ...reply(GAME_HUB_CHANNEL_ID), method: 'GET' },
    reply(GAME_HUB_CHANNEL_ID, TOKEN, '%40original-extra'),
    {
      method: 'POST',
      url: `/api/v10/interactions/123/${TOKEN}/callback`,
      body: { type: 5 },
    },
  ];
  await assert.rejects(
    waitForInteractionReply({ captured }, TOKEN, 50),
    /timed out waiting for interaction reply/,
  );
});

test('a captured empty reply is returned for assertion, not mistaken for missing delivery', async () => {
  const content = await waitForInteractionReply({ captured: [reply('')] }, TOKEN);
  assert.equal(content, '');
  assert.throws(() => assert.match(content, new RegExp(GAME_HUB_CHANNEL_ID)), assert.AssertionError);
});

for (const [expected, wrong] of [
  [GAME_HUB_CHANNEL_ID, shooters.primaryChannelId!],
  [shooters.primaryChannelId!, GAME_HUB_CHANNEL_ID],
]) {
  test(`wrong-channel reply fails the ${expected} assertion instead of waiting for correct text`, async () => {
    const captured = [reply(wrong), reply(expected)];
    const content = await waitForInteractionReply({ captured }, TOKEN);
    assert.equal(content, wrong, 'a later correct edit must not hide the wrong first link');
    assert.throws(() => assert.match(content, new RegExp(expected)), assert.AssertionError);
    assert.throws(() => assert.doesNotMatch(content, new RegExp(wrong)), assert.AssertionError);
  });
}
