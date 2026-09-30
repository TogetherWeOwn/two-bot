/**
 * TOG-9991: automations gateway drop-containment offline suite.
 *
 * Gap (round-5 gap list C11): reconnect/backoff around
 * `src/automations/gateway.ts` was untested. The gateway owns no timers or
 * retry policy itself — reconnect is discord.js's job, and bounded retry
 * with Retry-After honoring lives one layer down (`retryDelayMs` in
 * service.ts, covered by unit.automations.test.ts). What the gateway DOES
 * own on a drop is containment: a failed sticky check must not wedge the
 * text path, a failed text reply must not reject the listener, bot-authored
 * messages (our own sticky re-posts) must never re-trigger, and a burst of
 * queued events after an outage must each be handled independently. This
 * suite pins those semantics with a fake service behind an EventEmitter bus.
 *
 * Hermetic by construction: no Postgres, no token, no network.
 *   node --test test/unit.gateway-drops-offline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import type { AutomationService } from '../src/automations/service.ts';
import { DiscordPostError } from '../src/automations/discord.ts';
import { registerAutomationGateway } from '../src/automations/gateway.ts';

const GUILD = '1545644954272137297';
const CHANNEL = '100000000000000001';
const ACTOR = '900000000000000001';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

interface Counts {
  stickyChecks: number;
  triggerLookups: number;
  replies: number;
}

function wire(opts: {
  textCommandsEnabled?: boolean;
  onChannelActivity?: (guildId: string, channelId: string, actorId: string) => Promise<'reposted' | 'held' | 'none'>;
  findTrigger?: (guildId: string, word: string) => Promise<{ name: string } | null>;
  postTextReply?: (guildId: string, channelId: string, name: string, actorId: string) => Promise<string>;
}): { bus: EventEmitter; counts: Counts } {
  const bus = new EventEmitter();
  const counts: Counts = { stickyChecks: 0, triggerLookups: 0, replies: 0 };
  registerAutomationGateway(bus as unknown as Client, {
    guildId: GUILD,
    textCommandsEnabled: opts.textCommandsEnabled ?? true,
    service: {
      onChannelActivity: async (...args: [string, string, string]) => {
        counts.stickyChecks++;
        return opts.onChannelActivity?.(...args) ?? 'none';
      },
      postTextReply: async (...args: [string, string, string, string]) => {
        counts.replies++;
        return opts.postTextReply?.(...args) ?? 'message';
      },
    } as unknown as AutomationService,
    findTrigger: async (guildId: string, word: string) => {
      counts.triggerLookups++;
      const found = (await opts.findTrigger?.(guildId, word)) ?? null;
      if (!found) return null;
      return {
        guildId,
        name: found.name,
        description: 'Test command',
        template: 'hi',
        textTrigger: word,
        enabled: true,
        createdBy: ACTOR,
        createdAt: 't',
        updatedBy: ACTOR,
        updatedAt: 't',
      };
    },
  });
  return { bus, counts };
}

function commandMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    author: { id: ACTOR, bot: false },
    content: '!faq',
    createdTimestamp: 1,
    ...overrides,
  };
}

test('gateway: bot-authored messages never reach stickies or triggers', async () => {
  // Our own sticky re-posts arrive as bot-authored MessageCreate events; if
  // the gateway acted on them, every re-post would re-trigger the sticky
  // check and any !trigger in the sticky body, looping forever.
  const { bus, counts } = wire({ findTrigger: async () => ({ name: 'faq' }) });
  bus.emit('automationMessageAccepted', commandMessage({ author: { id: 'bot-id', bot: true } }));
  await settle();
  assert.deepEqual(counts, { stickyChecks: 0, triggerLookups: 0, replies: 0 });
});

test('gateway: a rejected sticky check still delivers the text path', async () => {
  // A transient store/Discord failure on the sticky half must not wedge the
  // text half of the same message: the two paths are independent.
  const { bus, counts } = wire({
    onChannelActivity: async () => { throw new Error('database down'); },
    findTrigger: async () => ({ name: 'faq' }),
  });
  bus.emit('automationMessageAccepted', commandMessage());
  await settle();
  assert.equal(counts.stickyChecks, 1);
  assert.equal(counts.triggerLookups, 1);
  assert.equal(counts.replies, 1);
});

test('gateway: a synchronously-throwing sticky check is contained', async () => {
  // The try wraps the CALL, not just the await: even a service that throws
  // before returning a promise must not escape the listener.
  const { bus, counts } = wire({
    onChannelActivity: () => { throw new Error('sync failure'); },
    findTrigger: async () => ({ name: 'faq' }),
  });
  bus.emit('automationMessageAccepted', commandMessage());
  await settle();
  assert.equal(counts.stickyChecks, 1);
  assert.equal(counts.replies, 1);
});

test('gateway: a failed text reply is contained and poisons nothing', async () => {
  // A retryable Discord failure (429/5xx/network) on the reply audits as a
  // failed command.run row inside the service; the gateway itself resolves,
  // emits no unhandled rejection, and the next message processes cleanly.
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => { rejections.push(err); };
  process.on('unhandledRejection', onRejection);
  try {
    let attempts = 0;
    const { bus, counts } = wire({
      postTextReply: async () => {
        attempts++;
        if (attempts === 1) throw new DiscordPostError('rate limited', { status: 429, retryAfterMs: 2_000 });
        return 'message';
      },
      findTrigger: async () => ({ name: 'faq' }),
    });
    bus.emit('automationMessageAccepted', commandMessage());
    await settle();
    bus.emit('automationMessageAccepted', commandMessage());
    await settle();
    assert.equal(counts.stickyChecks, 2);
    assert.equal(counts.replies, 2);
    assert.deepEqual(rejections, []);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
});

test('gateway: a burst after a drop is handled message by message', async () => {
  // After a gateway outage the funnel re-emits every accepted message at
  // once. One message's sticky failure must not abort, delay, or duplicate
  // the handling of the rest of the burst.
  const { bus, counts } = wire({
    onChannelActivity: async (_guildId, channelId) => {
      if (channelId === 'failing-channel') throw new Error('database down');
      return 'none';
    },
    findTrigger: async () => ({ name: 'faq' }),
  });
  for (let i = 0; i < 5; i++) {
    bus.emit('automationMessageAccepted', commandMessage({
      channelId: i === 2 ? 'failing-channel' : `${CHANNEL}-${i}`,
    }));
  }
  await settle();
  assert.equal(counts.stickyChecks, 5);
  assert.equal(counts.triggerLookups, 5);
  assert.equal(counts.replies, 5);
});

test('gateway: malformed events return without lookups or throws', async () => {
  const { bus, counts } = wire({ findTrigger: async () => ({ name: 'faq' }) });
  bus.emit('automationMessageAccepted', { guildId: GUILD, author: { id: ACTOR } }); // no channelId
  bus.emit('automationMessageAccepted', { guildId: null, channelId: CHANNEL, author: { id: ACTOR } });
  // No author: upstream always supplies one, but the gateway still runs the
  // sticky check with an empty actor id rather than throwing. No trigger
  // lookup follows because there is no content to parse.
  bus.emit('automationMessageAccepted', { guildId: GUILD, channelId: CHANNEL });
  bus.emit('automationMessageAccepted', {}); // nothing at all
  await settle();
  assert.deepEqual(counts, { stickyChecks: 1, triggerLookups: 0, replies: 0 });
});

test('gateway: non-command chatter never reaches trigger lookup', async () => {
  const { bus, counts } = wire({ findTrigger: async () => ({ name: 'faq' }) });
  bus.emit('automationMessageAccepted', commandMessage({ content: 'hello there' }));
  bus.emit('automationMessageAccepted', commandMessage({ content: undefined }));
  await settle();
  // Stickies are metadata-only and still run; the privileged text-command
  // path (and its MessageContent surface) stays off for plain chatter.
  assert.equal(counts.stickyChecks, 2);
  assert.equal(counts.triggerLookups, 0);
  assert.equal(counts.replies, 0);
});
