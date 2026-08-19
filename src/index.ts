import { loadConfig } from './core/config.ts';
import { setLogLevel, log } from './core/log.ts';
import { openDb, isPostgresSpec } from './store/db.ts';
import { EventStore } from './store/eventStore.ts';
import { InviteTracker } from './core/inviteTracker.ts';
import { FunnelHandlers } from './core/handlers.ts';
import { createClient, registerHandlers } from './discord/client.ts';
import { registerOnboarding } from './discord/onboarding.ts';
import { OnboardingRecorder } from './onboarding/flow.ts';
import { flagInactive } from './jobs/inactivity.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);

const db = await openDb(cfg.dbPath, { poolMax: cfg.dbPoolMax });
log.info('datastore_open', {
  driver: db.kind,
  // Never log the URL itself - it carries the password. See docs/SECRETS.md.
  target: isPostgresSpec(cfg.dbPath) ? 'postgres' : cfg.dbPath,
  poolMax: db.kind === 'postgres' ? cfg.dbPoolMax : undefined,
});
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

// Onboarding (TWO-7). Skipped entirely if no landing channel is configured -
// better to run the funnel with onboarding off than to post into a guessed
// channel on a live 100-member server.
if (cfg.landingChannelIds.length === 0) {
  log.error('onboarding_disabled', { reason: 'DISCORD_LANDING_CHANNEL_IDS is empty' });
} else {
  registerOnboarding(client, {
    recorder: new OnboardingRecorder(store),
    landingChannelIds: cfg.landingChannelIds,
    dryRun: cfg.onboardingDryRun,
  });
  log.info('onboarding_enabled', {
    landingChannelIds: cfg.landingChannelIds,
    dryRun: cfg.onboardingDryRun,
  });
}

// Inactivity sweep once an hour. Cheap query; no outbound messages.
const sweep = setInterval(
  () => {
    void flagInactive(db, store, cfg.inactivityDays).catch((err: unknown) => {
      log.error('inactivity_sweep_failed', { err: String(err) });
    });
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
  await db.close();
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
