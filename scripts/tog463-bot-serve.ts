/**
 * TOG-463: hold a real internal-actions listener open so another process — the
 * two-web Laravel worker — can call it over real HTTP.
 *
 * Same wiring as scripts/tog463-dryrun-rig.ts, but it does not run the harness
 * and it does not exit: the caller kills it. It prints one JSON line naming the
 * endpoint, the signing key and the store, so a shell can read them out.
 *
 * TWO_RIG_DB may name an existing store file to reuse, which is how the Laravel
 * run and the acceptance harness end up writing into one internal_action_log.
 */
import { randomBytes } from 'node:crypto';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { startInternalActions } from '../src/internal/server.ts';
import { KeyRing } from '../src/internal/signing.ts';
import { buildRoleKeys, buildChannelKeys, IMPLEMENTED_ACTIONS } from '../src/internal/actions.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { openDb } from '../src/store/db.ts';

const KEY_ID = process.env.TWO_RIG_KEY_ID ?? 'web-staging';
const SECRET = process.env.TWO_RIG_SECRET ?? 'k'.repeat(48);
const CHANNEL_KEY = 'qa-throwaway';
const PORT = Number(process.env.TWO_RIG_PORT ?? 0);

const dbFile =
  process.env.TWO_RIG_DB ??
  `${process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? '/tmp'}/tog463-serve-${randomBytes(4).toString('hex')}.db`;

const mock = await startMockDiscord();
const db = await openDb(dbFile);

const server = await startInternalActions({
  host: '127.0.0.1',
  port: PORT,
  keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
  guildId: mock.guildId,
  discord: new DiscordActions({ token: 'mock-bot-token', base: `${mock.apiBase}/v10` }),
  roleKeys: buildRoleKeys(),
  channelKeys: buildChannelKeys(`${CHANNEL_KEY}:${mock.textChannelId}`),
  enabled: new Set<string>(IMPLEMENTED_ACTIONS),
  store: new InternalActionStore(db),
});

console.log(
  JSON.stringify({
    rig: 'tog463-bot-serve',
    // The bot's own base, without the path: two-web's client appends
    // /internal/actions itself (InternalActionClient::endpoint()).
    origin: `http://127.0.0.1:${server.port}`,
    url: server.url,
    keyId: KEY_ID,
    channelKey: CHANNEL_KEY,
    db: dbFile,
    mock: mock.apiBase,
  }),
);

async function shutdown(): Promise<void> {
  await server.close();
  await db.close();
  await mock.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
