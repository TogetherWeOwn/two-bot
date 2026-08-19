import { loadConfig } from './core/config.ts';
import { setLogLevel, log } from './core/log.ts';
import { openDb } from './store/db.ts';
import { EventStore } from './store/eventStore.ts';
import { InviteTracker } from './core/inviteTracker.ts';
import { FunnelHandlers } from './core/handlers.ts';
import { createClient, registerHandlers } from './discord/client.ts';
import { flagInactive } from './jobs/inactivity.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);

const db = openDb(cfg.dbPath);
const store = new EventStore(db);
const invites = new InviteTracker(db);
const handlers = new FunnelHandlers(store);

const client = createClient();

// Point discord.js at a different API host. Only used by tools/mock-discord.
if (cfg.apiBase) {
  client.rest.options.api = cfg.apiBase;
  log.info('api_base_override', { apiBase: cfg.apiBase });
}

registerHandlers(client, { handlers, invites });

// Inactivity sweep once an hour. Cheap query; no outbound messages.
const sweep = setInterval(
  () => {
    try {
      flagInactive(db, store, cfg.inactivityDays);
    } catch (err) {
      log.error('inactivity_sweep_failed', { err: String(err) });
    }
  },
  60 * 60 * 1000,
);
sweep.unref();

async function shutdown(signal: string) {
  log.info('shutdown', { signal });
  clearInterval(sweep);
  try {
    await client.destroy();
  } catch {
    /* already down */
  }
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Let the process die on an unexpected failure. systemd restarts it; a
// half-broken bot that stays up is worse than one that bounces.
process.on('unhandledRejection', (err) => {
  log.error('unhandled_rejection', { err: String(err) });
  process.exit(1);
});

await client.login(cfg.discordToken);
