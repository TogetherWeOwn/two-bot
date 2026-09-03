/**
 * The go.two.gg redirect service (TOG-116).
 *
 *   npm run redirect                  # bind 127.0.0.1:8088
 *   TWO_REDIRECT_PORT=9000 npm run redirect
 *
 * A separate process from the bot on purpose. The bot holds the Discord token
 * and keeps a gateway websocket open; this holds no credential and serves one
 * public GET. Restarting the redirect must never mean reconnecting the bot, and
 * a crawler hammering a short link must never cost us gateway stability.
 *
 * Put it behind the host's reverse proxy with TLS for go.two.gg. See
 * docs/INVITE_TRACKING.md.
 */
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { FunnelHandlers } from '../src/core/handlers.ts';
import { setLogLevel, log } from '../src/core/log.ts';
import { loadRedirectConfig } from '../src/redirect/config.ts';
import { CampaignStore } from '../src/redirect/campaigns.ts';
import { startRedirectServer } from '../src/redirect/server.ts';

setLogLevel((process.env.LOG_LEVEL as 'debug' | 'info' | 'error') || 'info');

const cfg = loadRedirectConfig();
const dbSpec = process.env.TWO_DATABASE_URL || process.env.TWO_DB_PATH || './data/two.db';

const db = await openDb(dbSpec, { applicationName: 'two-redirect', poolMax: 4 });
const campaigns = new CampaignStore(db);
const handlers = new FunnelHandlers(new EventStore(db));

const server = await startRedirectServer({
  host: cfg.host,
  port: cfg.port,
  guildId: cfg.guildId,
  campaigns,
  recorder: handlers,
  fallbackInviteCode: cfg.fallbackInviteCode,
});

const live = await campaigns.list();
log.info('invite_redirect_ready', {
  url: server.url,
  campaigns: live.filter((c) => !c.disabledAt).length,
  retired: live.filter((c) => c.disabledAt).length,
});
if (live.length === 0) {
  log.error('invite_redirect_no_campaigns', {
    hint: 'every link 404s until one exists: npm run campaigns -- --add <slug> <invite-code> "<where>"',
  });
}

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    log.info('invite_redirect_stopping', { signal: sig });
    void server
      .close()
      .then(() => db.close())
      .then(() => process.exit(0));
  });
}
