import { setTimeout as sleep } from 'node:timers/promises';
import type { MockDiscord } from '../../tools/mock-discord/server.ts';

/** Wait for delivery, not expected text: a wrong or empty reply must still fail assertions. */
export async function waitForInteractionReply(
  mock: Pick<MockDiscord, 'captured'>,
  token: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const reply = mock.captured.find((c) => {
      // discord.js percent-encodes @original on the wire.
      const match = /^\/api\/v10\/webhooks\/\d+\/([^/]+)\/messages\/(?:@|%40)original$/.exec(c.url);
      return c.method === 'PATCH' && match?.[1] === token;
    });
    if (reply) return (reply.body as { content?: string })?.content ?? '';
    await sleep(Math.min(25, Math.max(0, deadline - performance.now())));
  }
  throw new Error('timed out waiting for interaction reply');
}
