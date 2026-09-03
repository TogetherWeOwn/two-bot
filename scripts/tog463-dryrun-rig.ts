/**
 * TOG-463 dry-run rig: stand up a REAL internal-actions listener on the current
 * tree, backed by mock-Discord and a real SQLite store, then hand its URL to
 * scripts/internal-actions-acceptance.ts.
 *
 * Why this exists: the acceptance harness (b42037c) was last proven green on
 * 0d917e1. main has moved 14 commits since. The question this rig answers is
 * narrow and worth answering without staging credentials: does the harness
 * still pass against the code that is on main today, or has the endpoint
 * drifted out from under it?
 *
 * What this is NOT: it is not the TOG-463 acceptance run. There is no Laravel
 * job here and no real Discord — a PASS here is a statement about harness/endpoint
 * agreement only, and the issue's own Done-when clause stays unproven.
 *
 * Usage: node scripts/tog463-dryrun-rig.ts
 * Exit code is the acceptance harness's own: 0 all checks passed, 1 a check
 * failed, 2 misconfigured.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { startInternalActions } from '../src/internal/server.ts';
import { KeyRing } from '../src/internal/signing.ts';
import { buildRoleKeys, buildChannelKeys, IMPLEMENTED_ACTIONS } from '../src/internal/actions.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { openDb } from '../src/store/db.ts';

const KEY_ID = 'web-staging';
const SECRET = 'k'.repeat(48);
/** Throwaway by construction: mock-Discord, not a real channel. */
const CHANNEL_KEY = 'qa-throwaway';
const ROLE_KEY = 'rocketleague';
const MEMBER = '900000000000009999';

const dbFile = `${process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? '/tmp'}/tog463-dryrun-${randomBytes(4).toString('hex')}.db`;

const mock = await startMockDiscord();
// openDb bootstraps SQLite from src/store/schema.sql, which is where
// internal_action_log lives. migrate() is the Postgres-only path.
const db = await openDb(dbFile);

const server = await startInternalActions({
  host: '127.0.0.1',
  port: 0,
  keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
  guildId: mock.guildId,
  // mock.apiBase omits the version; this client talks to the API directly, so
  // it says which version it wants — same wiring as e2e.internalactions.test.ts.
  discord: new DiscordActions({ token: 'mock-bot-token', base: `${mock.apiBase}/v10` }),
  roleKeys: buildRoleKeys(),
  channelKeys: buildChannelKeys(`${CHANNEL_KEY}:${mock.textChannelId}`),
  enabled: new Set<string>(IMPLEMENTED_ACTIONS),
  store: new InternalActionStore(db),
});

console.log(`rig: mock-discord at ${mock.apiBase}`);
console.log(`rig: endpoint at ${server.url}`);
console.log(`rig: store at ${dbFile}\n`);

const child = spawn(
  process.execPath,
  ['scripts/internal-actions-acceptance.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TWO_ACCEPT_URL: server.url,
      TWO_ACCEPT_KEY_ID: KEY_ID,
      TWO_ACCEPT_SECRET: SECRET,
      TWO_ACCEPT_CHANNEL_KEY: CHANNEL_KEY,
      TWO_ACCEPT_ROLE_KEY: ROLE_KEY,
      TWO_ACCEPT_DISCORD_ID: MEMBER,
      TWO_ACCEPT_DB: dbFile,
    },
  },
);

const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));

await server.close();
await db.close();
await mock.close();

console.log(`\nrig: acceptance harness exited ${code}`);
process.exit(code);
