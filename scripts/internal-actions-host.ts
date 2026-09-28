/**
 * A standalone internal-actions host, for driving the TOG-463 acceptance
 * harness out-of-process (TOG-463 step 2 onward).
 *
 * The harness in scripts/internal-actions-acceptance.ts deliberately does not
 * import the bot's server - it talks HTTP to a *running* process, so it
 * measures a deployment rather than a copy of the source. That means something
 * has to be running. On real staging that is the bot itself. Until the
 * `test-two` token lands (TWO-21) there is no Discord to log in to, so this
 * boots the same startInternalActions() the bot boots, against the same real
 * Postgres, with tools/mock-discord standing in for Discord's REST API.
 *
 * What that buys, precisely: the auth, replay, idempotency and audit layers are
 * exercised over real sockets against a real durable store. What it does NOT
 * buy: proof that a real Discord accepted the call. Steps 3 and 4's "one
 * message in the channel" is checked against the mock, not against Discord.
 * Do not read a green run of this as the staging acceptance TOG-463 asks for.
 *
 *   TWO_HOST_DB=postgres://.../twobot_staging \
 *   TWO_HOST_KEY_ID=web-staging TWO_HOST_SECRET=... \
 *   TWO_HOST_PORT=8787 \
 *   node scripts/internal-actions-host.ts
 *
 * Prints one JSON line `acceptance_host_ready` with the url and channel key,
 * then serves until SIGTERM.
 */
import { startInternalActions } from '../src/internal/server.ts';
import { KeyRing } from '../src/internal/signing.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { buildRoleKeys, buildChannelKeys, IMPLEMENTED_ACTIONS } from '../src/internal/actions.ts';
import { openDb } from '../src/store/db.ts';
import { startMockDiscord } from '../tools/mock-discord/server.ts';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    console.error(`FATAL ${name} is not set. See the header of this file.`);
    process.exit(2);
  }
  return v;
}

const DB_SPEC = env('TWO_HOST_DB');
const KEY_ID = env('TWO_HOST_KEY_ID', 'web-staging');
const SECRET = env('TWO_HOST_SECRET');
const PORT = Number(env('TWO_HOST_PORT', '8787'));
/**
 * A throwaway channel key, per the issue's step 1. The mock absorbs the posts,
 * so nothing reaches a real channel - but the key is still named rather than
 * defaulted, so this cannot quietly address the real announcements channel.
 */
const CHANNEL_KEY = env('TWO_HOST_CHANNEL_KEY', 'qa-throwaway');

const mock = await startMockDiscord();

// Schema-isolated like the test fixtures: this writes real rows to the real
// staging database, and QA acceptance traffic must not land in the tables a
// later seeded run reads. Drop the schema to undo.
const SCHEMA = process.env.TWO_HOST_SCHEMA ?? 'qa_tog463';
const db = await openDb(DB_SPEC, { schema: SCHEMA, applicationName: `two-bot-qa:${SCHEMA}` });

const store = new InternalActionStore(db);

const srv = await startInternalActions({
  host: '127.0.0.1',
  port: PORT,
  keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
  guildId: mock.guildId,
  discord: new DiscordActions({ token: 'mock-token', base: `${mock.apiBase}/v10` }),
  roleKeys: buildRoleKeys(),
  channelKeys: buildChannelKeys(`${CHANNEL_KEY}:1045943373007171674`),
  enabled: new Set<string>(IMPLEMENTED_ACTIONS),
  store,
});

console.log(
  JSON.stringify({
    msg: 'acceptance_host_ready',
    url: srv.url,
    schema: SCHEMA,
    channelKey: CHANNEL_KEY,
    keyId: KEY_ID,
    discord: 'mock',
  }),
);

/**
 * Step 4 asks for "exactly one message in the channel", and steps 5 and 6 assert
 * a NEGATIVE - that a forged or replayed request reached Discord not at all. The
 * same `message_id` twice is necessary but not sufficient for either: it does not
 * prove the bot sent one request rather than two. The traffic the bot actually
 * emitted lives in THIS process, not the harness's, so expose it read-only on a
 * separate loopback port. Mock runs only; against a real Discord the count has to
 * come from the channel itself.
 */
const INTROSPECT_PORT = Number(process.env.TWO_HOST_INTROSPECT_PORT ?? '0');
if (INTROSPECT_PORT > 0) {
  const { createServer } = await import('node:http');
  createServer((_req, res) => {
    const posts = mock.captured.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        messagePosts: posts.length,
        urls: posts.map((p) => p.url),
        // GETs are not captured by the mock, so every entry here is a write.
        totalCaptured: mock.captured.length,
        allCalls: mock.captured.map((c) => `${c.method} ${c.url}`),
      }),
    );
  }).listen(INTROSPECT_PORT, '127.0.0.1');
}

async function shutdown(): Promise<void> {
  await srv.close();
  await db.close();
  await mock.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
