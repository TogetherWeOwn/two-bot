import { loadConfig } from './core/config.ts';
import { setLogLevel, log } from './core/log.ts';
import { openDb, isPostgresSpec } from './store/db.ts';
import { applyWebContract } from './store/webContract.ts';
import { EventStore } from './store/eventStore.ts';
import { InviteTracker } from './core/inviteTracker.ts';
import { ExpectedJoins } from './core/expectedJoins.ts';
import { FunnelHandlers } from './core/handlers.ts';
import { createClient, registerHandlers } from './discord/client.ts';
import { registerOnboarding } from './discord/onboarding.ts';
import { RaidWatch } from './analytics/raidWatch.ts';
import { makeRaidAnnouncer } from './discord/raidAlert.ts';
import { OnboardingRecorder } from './onboarding/flow.ts';
import { flagInactive } from './jobs/inactivity.ts';
import { startPresenceProbe, type PresenceProbeHandle } from './jobs/presenceProbe.ts';
import {
  startCommunitySnapshots,
  type CommunitySnapshotHandle,
} from './jobs/communitySnapshots.ts';
import { DiscordRest } from './discord/rest.ts';
import { loadInternalActionsConfig } from './internal/config.ts';
import { startInternalActions, type InternalServer } from './internal/server.ts';
import { KeyRing } from './internal/signing.ts';
import { DiscordActions } from './internal/discordActions.ts';
import { InternalActionStore } from './internal/store.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);

const db = await openDb(cfg.dbPath, { poolMax: cfg.dbPoolMax });
log.info('datastore_open', {
  driver: db.kind,
  // Never log the URL itself - it carries the password. See docs/SECRETS.md.
  target: isPostgresSpec(cfg.dbPath) ? 'postgres' : cfg.dbPath,
  poolMax: db.kind === 'postgres' ? cfg.dbPoolMax : undefined,
});

// Keep the website's read-only views (docs/WEBSITE_CONTRACT.md) in step with
// the code that owns them. Idempotent, so this is a no-op on a normal boot.
//
// Deliberately NOT fatal. The bot's job is recording funnel events, and those
// are the only thing here we cannot recover after the fact; refusing to start -
// and therefore dropping joins on the floor - to protect a view the website
// reads would be the wrong trade. This is loud instead, and it has a detection
// path that does not rely on anyone reading a log: `npm run web:views -- --status`
// reports missing views, and `npm run verify:web-role` fails CI.
if (db.kind === 'postgres') {
  try {
    const applied = await applyWebContract(db);
    log.info('web_contract_ready', { ...applied });
  } catch (err) {
    log.error('web_contract_failed', {
      err: String(err),
      // CREATE OR REPLACE VIEW cannot rename, reorder or retype a column, so
      // this is usually not a typo: it is a change that needs a web_v2 schema
      // rather than an edit. See docs/WEBSITE_CONTRACT.md §1.
      hint: 'run `npm run web:views` for the full error',
    });
  }
}

const store = new EventStore(db);
const invites = new InviteTracker(db);
// One instance, two ends: guild.add_member writes the "expect this member"
// note, the gateway join handler consumes it. docs/INTERNAL_ACTIONS.md §7.
const expectedJoins = new ExpectedJoins();
const handlers = new FunnelHandlers(store);

const client = createClient();

// Point discord.js at a different API host. Only used by tools/mock-discord.
if (cfg.apiBase) {
  client.rest.options.api = cfg.apiBase;
  log.info('api_base_override', { apiBase: cfg.apiBase });
}

// Join-burst detection (TWO-56). Always on - three raids reached this server
// unnoticed. Where the alert goes is configurable; whether we watch is not.
const raid = {
  watch: new RaidWatch({
    threshold: cfg.raidJoinThreshold,
    windowSeconds: cfg.raidWindowSeconds,
  }),
  announce: makeRaidAnnouncer(client, { channelId: cfg.staffAlertChannelId }),
};
log.info('raid_watch_enabled', {
  threshold: cfg.raidJoinThreshold,
  windowSeconds: cfg.raidWindowSeconds,
  // No staff channel means the alert exists only in this log. Said out loud at
  // boot so it is a known state rather than a surprise during a raid.
  alertTarget: cfg.staffAlertChannelId ?? 'log only (DISCORD_STAFF_ALERT_CHANNEL_ID unset)',
});

registerHandlers(client, { handlers, invites, raid, expectedJoins });

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

// The internal actions endpoint (TWO-24 / TWO-59). Off unless
// TWO_INTERNAL_ACTIONS=1 - a bot without it runs exactly as before and opens
// no port. When it is on, a bad bind address or a missing key is a startup
// crash rather than a quietly-exposed remote control for the server.
const internalCfg = loadInternalActionsConfig();
let internal: InternalServer | null = null;
if (internalCfg) {
  if (!cfg.guildId) {
    throw new Error('TWO_INTERNAL_ACTIONS=1 requires DISCORD_GUILD_ID - the actions act on one guild.');
  }
  internal = await startInternalActions({
    host: internalCfg.host,
    port: internalCfg.port,
    keys: new KeyRing(internalCfg.keys),
    guildId: cfg.guildId,
    discord: new DiscordActions({
      token: cfg.discordToken,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    }),
    roleKeys: internalCfg.roleKeys,
    channelKeys: internalCfg.channelKeys,
    enabled: internalCfg.enabled,
    // The durable nonce, idempotency and audit tables (TOG-44). The same
    // database as everything else, so it is covered by the same backups.
    store: new InternalActionStore(db),
    expectedJoins,
  });
}

// The internal presence instrument (TOG-469). Hourly, REST-only, and nothing
// it collects is reachable from the website - the table is in the bot schema,
// which the website's role is REVOKEd from, and no `web_v1` view reads it.
//
// Needs a guild to ask about and a Postgres to write to; the table arrives in
// migration 0004 and the SQLite bootstrap does not have it. Missing either is
// a logged skip, never a crash - this is an instrument for an internal
// question and it does not get to stop the funnel from recording joins.
let presenceProbe: PresenceProbeHandle | null = null;
if (!cfg.presenceProbe) {
  log.info('presence_probe_disabled', { reason: 'TWO_PRESENCE_PROBE=0' });
} else if (!cfg.guildId) {
  log.info('presence_probe_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
} else if (db.kind !== 'postgres') {
  log.info('presence_probe_disabled', { reason: 'needs Postgres (migration 0004)' });
} else {
  presenceProbe = startPresenceProbe({
    db,
    rest: new DiscordRest({
      token: cfg.discordToken,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    }),
    guildId: cfg.guildId,
  });
}

// The published member/rank snapshots (TOG-73). A full member list is read in
// one pass so bots and dynamically-derived raid accounts are excluded from the
// counter, rank aggregates and public member projection by the same decision.
// The collector is Postgres-only because migrations 0003 and 0005 own its
// tables. A failed or ungrounded read writes nothing and ages out in web_v1.
let communitySnapshots: CommunitySnapshotHandle | null = null;
if (!cfg.guildId) {
  log.info('community_snapshots_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
} else if (db.kind !== 'postgres') {
  log.info('community_snapshots_disabled', { reason: 'needs Postgres (migrations 0003 and 0005)' });
} else {
  communitySnapshots = startCommunitySnapshots({
    db,
    rest: new DiscordRest({
      token: cfg.discordToken,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    }),
    guildId: cfg.guildId,
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
  presenceProbe?.stop();
  communitySnapshots?.stop();
  if (internal) await internal.close();
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
