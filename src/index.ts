import { loadConfig } from './core/config.ts';
import { setLogLevel, log } from './core/log.ts';
import { openDb, isPostgresSpec } from './store/db.ts';
import { applyWebContract } from './store/webContract.ts';
import { EventStore } from './store/eventStore.ts';
import { InviteTracker } from './core/inviteTracker.ts';
import { ExpectedJoins } from './core/expectedJoins.ts';
import { FunnelHandlers } from './core/handlers.ts';
import { createClient, registerHandlers } from './discord/client.ts';
import { registerOnboarding, registerGameSelect } from './discord/onboarding.ts';
import { registerAnchorWelcome } from './discord/anchorWelcome.ts';
import { occurrencesFrom } from './onboarding/anchorEvent.ts';
import { RaidWatch } from './analytics/raidWatch.ts';
import { makeRaidAnnouncer } from './discord/raidAlert.ts';
import { OnboardingRecorder } from './onboarding/flow.ts';
import { flagInactive } from './jobs/inactivity.ts';
import { startPresenceProbe, type PresenceProbeHandle } from './jobs/presenceProbe.ts';
import {
  startCommunitySnapshots,
  type CommunitySnapshotHandle,
} from './jobs/communitySnapshots.ts';
import {
  startScheduledEventsPoller,
  type ScheduledEventsHandle,
} from './jobs/scheduledEvents.ts';
import { DiscordRest } from './discord/rest.ts';
import { loadInternalActionsConfig } from './internal/config.ts';
import { startInternalActions, type InternalServer } from './internal/server.ts';
import { KeyRing } from './internal/signing.ts';
import { DiscordActions } from './internal/discordActions.ts';
import { InternalActionStore } from './internal/store.ts';
import { startHealthServer, type HealthServer } from './core/health.ts';
import { LevelingService } from './leveling/service.ts';
import { registerLeveling } from './leveling/discord.ts';
import { loadModerationConfig } from './moderation/config.ts';
import { ModerationDiscord } from './moderation/discord.ts';
import { RestModerationResolver } from './moderation/resolver.ts';
import { ModerationService } from './moderation/service.ts';
import { ModerationStore } from './moderation/store.ts';
import { registerModerationCommands, registerModerationHandler } from './moderation/commands.ts';

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
const leveling = new LevelingService(db);
const handlers = new FunnelHandlers(store, leveling);

const client = createClient();
const moderationCfg = loadModerationConfig();
const moderationStore = new ModerationStore(db);
const moderationDiscord = new ModerationDiscord({
  token: cfg.discordToken,
  base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
});
const moderationResolver = cfg.guildId && moderationCfg.enabled
  ? new RestModerationResolver({
      token: cfg.discordToken,
      botUserId: moderationCfg.owenUserId,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    })
  : null;
const moderationService = moderationResolver
  ? new ModerationService(moderationDiscord, moderationStore, {
      owenUserId: moderationCfg.owenUserId,
      botUserId: moderationCfg.owenUserId,
      protectedRoleIds: moderationCfg.protectedRoleIds,
    })
  : null;

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

registerHandlers(client, { handlers, invites, raid, expectedJoins, leveling });
registerLeveling(client, { service: leveling, guildId: cfg.guildId });
if (cfg.guildId && moderationResolver && moderationService) {
  registerModerationHandler(client, {
    guildId: cfg.guildId,
    resolver: moderationResolver,
    service: moderationService,
  });
  client.once('ready', async () => {
    await registerModerationCommands(client, {
      guildId: cfg.guildId!,
      resolver: moderationResolver,
      service: moderationService,
    });
    log.info('moderation_enabled', {
      guildId: cfg.guildId,
      protectedRoles: moderationCfg.protectedRoleIds.size,
    });
  });
}

// Onboarding (TWO-7). Skipped entirely if no landing channel is configured -
// better to run the funnel with onboarding off than to post into a guessed
// channel on a live 100-member server.
//
// Exactly one thing may own the rules-gate-clear moment, because
// `onboarding_prompted` is once-per-member by design and whichever handler got
// there first would silently starve the other. DISCORD_ANCHOR_WELCOME_CHANNEL_ID
// chooses which (TOG-93); with it unset this block behaves as it always has.
const onboardingDeps = {
  recorder: new OnboardingRecorder(store),
  landingChannelIds: cfg.landingChannelIds,
  dryRun: cfg.onboardingDryRun,
};

if (cfg.anchorWelcomeChannelId) {
  registerAnchorWelcome(client, {
    recorder: onboardingDeps.recorder,
    channelId: cfg.anchorWelcomeChannelId,
    dryRun: cfg.onboardingDryRun,
  });
  // The picker panel outlives any one welcome, so its handler stays live even
  // though it no longer greets anybody.
  registerGameSelect(client, onboardingDeps);
  log.info('anchor_welcome_enabled', {
    channelId: cfg.anchorWelcomeChannelId,
    nextOccurrence: occurrencesFrom(Date.now(), 1)[0],
    dryRun: cfg.onboardingDryRun,
  });
} else if (cfg.landingChannelIds.length === 0) {
  log.error('onboarding_disabled', { reason: 'DISCORD_LANDING_CHANNEL_IDS is empty' });
} else {
  registerOnboarding(client, onboardingDeps);
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
    moderation: moderationResolver && moderationService
      ? { resolver: moderationResolver, service: moderationService }
      : null,
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

// The website's event feed (TOG-74). A successful Discord read replaces the
// guild's mirror atomically, including replacing it with zero rows. A failed or
// malformed read leaves the last good snapshot in place rather than publishing
// "no events" as a transport error.
let scheduledEvents: ScheduledEventsHandle | null = null;
if (!cfg.guildId) {
  log.info('scheduled_events_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
} else if (db.kind !== 'postgres') {
  log.info('scheduled_events_disabled', { reason: 'needs Postgres (migration 0003)' });
} else {
  scheduledEvents = startScheduledEventsPoller({
    db,
    rest: new DiscordRest({
      token: cfg.discordToken,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    }),
    guildId: cfg.guildId,
  });
}

const moderationSweep = moderationService
  ? setInterval(() => {
      void moderationService.runDueUnbans().catch((err: unknown) => {
        log.error('moderation_unban_sweep_failed', { err: String(err) });
      });
    }, 30_000)
  : null;
moderationSweep?.unref();

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

// The container health endpoint (TOG-13). Started BEFORE client.login, so that
// during the seconds a cold start spends connecting to the gateway the platform
// gets an honest `503 gateway_disconnected` rather than a refused connection -
// the two look identical to a probe, and only one of them is worth restarting.
//
// Off unless TWO_HEALTH_PORT is set, so nothing about running the bot under
// systemd changes and no port is opened on a host that did not ask for one.
// The container image sets it; see docs/DEPLOY.md.
let health: HealthServer | null = null;
const healthPort = Number(process.env.TWO_HEALTH_PORT ?? 0);
if (healthPort > 0) {
  health = await startHealthServer({
    host: process.env.TWO_HEALTH_BIND_HOST || '0.0.0.0',
    port: healthPort,
    // `client.isReady()` is discord.js' own view of the gateway session, so a
    // reconnect flips readiness back without any bookkeeping of our own.
    gatewayReady: () => client.isReady(),
    databaseReady: async () => {
      try {
        await db.prepare('SELECT 1').get();
        return true;
      } catch (err) {
        log.error('health_db_probe_failed', { err: String(err) });
        return false;
      }
    },
  });
}

async function shutdown(signal: string) {
  log.info('shutdown', { signal });
  clearInterval(sweep);
  if (moderationSweep) clearInterval(moderationSweep);
  presenceProbe?.stop();
  communitySnapshots?.stop();
  scheduledEvents?.stop();
  // Health goes down first: while the rest is closing, the bot must already be
  // reporting itself out of service so the platform stops routing to it.
  if (health) await health.close();
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
