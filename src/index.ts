import { loadConfig, storeFirst, HOT_WIRED_FIELDS } from './core/config.ts';
import { SettingsStore } from './core/settings.ts';
import { setLogLevel, log } from './core/log.ts';
import { openDb } from './store/db.ts';
import { applyWebContract } from './store/webContract.ts';
import { EventStore } from './store/eventStore.ts';
import { InviteTracker } from './core/inviteTracker.ts';
import { ExpectedJoins } from './core/expectedJoins.ts';
import { FunnelHandlers } from './core/handlers.ts';
import { createClient, registerHandlers } from './discord/client.ts';
import { registerOnboarding, registerGameSelect } from './discord/onboarding.ts';
import { registerSessionWelcome } from './discord/sessionWelcome.ts';
import { registerSelfRoles } from './discord/selfRoles.ts';
import { SessionRecorder, buildSessionPicks } from './onboarding/session.ts';
import { actionsForOnboardingMode, levelRoleWritesForOnboardingMode } from './onboarding/mode.ts';
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
import { registerTickets } from './discord/tickets.ts';
import { loadSelfRolePanels, validateSelfRolePanelRoles } from './selfRoles/config.ts';
import { SelfRoleStore } from './store/selfRoleStore.ts';
import { startHealthServer, type HealthServer } from './core/health.ts';
import { LevelingService } from './leveling/service.ts';
import { registerLeveling } from './leveling/discord.ts';
import { loadModerationConfig } from './moderation/config.ts';
import { ModerationDiscord } from './moderation/discord.ts';
import { RestModerationResolver } from './moderation/resolver.ts';
import { ModerationService } from './moderation/service.ts';
import { ModerationStore } from './moderation/store.ts';
import { enforceModerationShutdownPreflight } from './moderation/shutdownPreflight.ts';
import { MODERATION_COMMAND_DATA, registerModerationHandler } from './moderation/commands.ts';
import { ANNOUNCEMENT_COMMAND_DATA, AUTOMATION_COMMAND_DATA, COMMUNITY_COMMAND_DATA } from './discord/commandNames.ts';
import { loadAutomodConfig } from './automod/config.ts';
import { AutomodService } from './automod/service.ts';
import { AutomodStore } from './automod/store.ts';
import { OperationalAuditStore } from './audit/store.ts';
import { makeOperationalAudit } from './audit/service.ts';
import { loadContainmentConfig } from './moderation/containmentConfig.ts';
import { ContainmentStore } from './moderation/containmentStore.ts';
import { ContainmentDiscord } from './moderation/containmentDiscord.ts';
import {
  DestructiveContainment,
  JoinRiskScorer,
  SnapshotRestoreAdvisor,
  registerContainment,
} from './moderation/containment.ts';
import { makeContainmentAnnouncer, makeJoinRiskAnnouncer } from './discord/containmentAlert.ts';
import { GuildConfigDiscordApi } from './discord/guildConfigApi.ts';
import type { GuildConfigSnapshot } from './redesign/guildConfig.ts';
import { readFileSync } from 'node:fs';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './staging/spec.ts';
import {
  assertStagingRestartPreflight,
  parseSyntheticStagingActorIds,
  stagingRestartContainmentArmed,
  StagingRestartFunnelFirewall,
} from './staging/restartContainment.ts';
import { assertSelfRoleStagingBoundary } from './selfRoles/stagingFence.ts';
import { CommandRegistry } from './discord/commandRegistry.ts';
import { AutomationStore } from './automations/store.ts';
import { AutomationDiscord, registerAutomationCommands } from './automations/discord.ts';
import { AutomationService } from './automations/service.ts';
import { registerAutomationGateway } from './automations/gateway.ts';
import { startScheduler } from './automations/scheduler.ts';
import { loadAutomationConfig } from './automations/config.ts';
import {
  AutomationDisableIncomplete,
  RestGuildCommandRegistrar,
  removeDbBackedCommands,
  summariseDisable,
} from './automations/disable.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from './analytics/communityClassifier.ts';
import { CommunityFactStore } from './analytics/communityFacts.ts';
import { OnboardingRota } from './analytics/onboardingRota.ts';
import { loadOnboardingRotaConfig } from './analytics/onboardingRotaConfig.ts';
import { DiscordOnboardingRota } from './discord/onboardingRota.ts';
import { ROTA_ACKNOWLEDGEMENT_COMMAND, registerRotaAcknowledgement } from './discord/rotaAcknowledgement.ts';
import { RotaNoticeDelivery } from './discord/rotaNoticeDelivery.ts';
import { startRotaNoticeScheduler } from './discord/rotaNoticeScheduler.ts';
import {
  startCommunityScorecardJob,
  type CommunityScorecardJobHandle,
} from './jobs/communityScorecard.ts';
import { registerCommunityAttendance } from './analytics/communityAttendance.ts';
import { loadAnnouncementsConfig } from './announcements/config.ts';
import { AnnouncementsStore } from './announcements/store.ts';
import { AnnouncementsService } from './announcements/service.ts';
import { DiscordAnnouncements, XmlFeedReader, registerAnnouncementCommands, startFeedPoller } from './announcements/discord.ts';

// The environment-only view. Everything needed to reach the database has to
// come from here, because the settings store lives in the database: this is the
// bootstrap, and it is why TWO_DB_POOL_MAX and the URL itself are env-only in
// src/core/settingsCatalog.ts rather than by policy.
//
// `liveCfg` below replaces this once the store is open. Read that, not this,
// anywhere a value can change while the process runs.
const cfg = loadConfig();
const onboardingRotaCfg = loadOnboardingRotaConfig();
if (onboardingRotaCfg.enabled && onboardingRotaCfg.noticeEnabled &&
    (!onboardingRotaCfg.noticeChannelId || !onboardingRotaCfg.primaryActorId || !onboardingRotaCfg.readerIds?.length)) {
  throw new Error(
    'Onboarding rota notices require DISCORD_STAFF_ALERT_CHANNEL_ID, ' +
    'TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID and TWO_ONBOARDING_ROTA_READER_IDS.',
  );
}
const automationCfg = loadAutomationConfig();
const processStartedAt = new Date().toISOString();
const announcementsCfg = loadAnnouncementsConfig();
const selfRolePanels = loadSelfRolePanels();
// Read here, not at its point of use further down, so the session-mode guard
// below refuses the process before the database is opened or the gateway is
// touched. It is a pure read of process.env.
const containmentCfg = loadContainmentConfig();
setLogLevel(cfg.logLevel);

// Acceptance-only registration and ingestion boundary. Validate before opening
// storage; unrelated handlers/jobs are not registered, rather than pretending
// their Discord writes succeeded. The real rota observer and scheduler remain.
// Both verdicts use the same effective config, including systemd credentials.
// A conflicting plain env value must never make a refused boot continue.
const stagingRestartControls = {
  discordToken: cfg.discordToken,
  databaseUrl: cfg.databaseUrl,
  stagingDatabaseUrl: process.env.TWO_STAGING_DATABASE_URL ?? null,
  guildId: cfg.guildId,
};
const stagingRestartFlag = process.env.TWO_STAGING_RESTART_CONTAINMENT;
if (stagingRestartFlag !== undefined && stagingRestartFlag !== '' && stagingRestartFlag !== '0' && stagingRestartFlag !== '1') {
  throw new Error('TWO_STAGING_RESTART_CONTAINMENT must be exactly 0 or 1.');
}
const stagingRestartArmed = stagingRestartContainmentArmed(process.env, stagingRestartControls);
if (stagingRestartFlag === '1') {
  assertStagingRestartPreflight(process.env, stagingRestartControls);
  log.info('staging_restart_containment_armed', { guildId: cfg.guildId });
}
const stagingSyntheticActors = stagingRestartArmed
  ? parseSyntheticStagingActorIds(process.env.TWO_STAGING_RESTART_SYNTHETIC_ACTORS)
  : null;
const communityClassifierCfg = loadCommunityClassifierConfig();
if (stagingRestartArmed && !communityClassifierCfg.stagingGuildIds.has(TWO_STAGING_GUILD_ID)) {
  throw new Error('Staging restart containment requires explicit community staging-guild classification.');
}

if (cfg.onboardingMode === 'session' && selfRolePanels.length) {
  throw new Error(
    'TWO_ONBOARDING_MODE=session forbids TWO_SELF_ROLE_PANELS because session mode guarantees zero role writes.',
  );
}

// Anti-nuke containment quarantines an executor by DELETEing their dangerous
// roles (src/moderation/containmentDiscord.ts), which is a member-role write -
// so it is not exempt from the zero-role-write guarantee just because it is a
// moderation path rather than an onboarding one. Dry run stops short of
// `quarantine()` (src/moderation/containment.ts), so that combination is still
// allowed; an armed one is refused at boot rather than at the first incident,
// when the write would already be the response to a live raid.
if (cfg.onboardingMode === 'session' && containmentCfg.enabled && !containmentCfg.dryRun) {
  throw new Error(
    'TWO_ONBOARDING_MODE=session forbids armed anti-nuke containment because quarantine removes member roles. ' +
      'Set TWO_ANTI_NUKE_DRY_RUN=1 (alerts only) or TWO_ANTI_NUKE=0.',
  );
}

if (
  cfg.onboardingMode === 'session' &&
  (!cfg.guildId || !cfg.sessionLookingToPlayChannelId || !cfg.sessionLobbyVoiceChannelId)
) {
  throw new Error(
    'TWO_ONBOARDING_MODE=session requires DISCORD_GUILD_ID, ' +
      'DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID and DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID.',
  );
}

const db = await openDb(cfg.databaseUrl, { poolMax: cfg.dbPoolMax });
// Never log the URL itself - it carries the password. See docs/SECRETS.md.
log.info('datastore_open', { poolMax: cfg.dbPoolMax });

// The config store (TOG-3100 / TOG-3093 slice 1).
//
// Additive by construction: a key with no row reads exactly as it did before
// this table existed, so the day this ships nothing changes and the Coolify
// environment can be emptied one key at a time. The undo path for the whole
// admin-dashboard programme is "stop writing rows".
//
// It polls `SELECT max(version)` every 15s rather than using LISTEN/NOTIFY,
// which would need a dedicated connection; docs/STACK.md sizes the pool at 5
// deliberately and this is not worth one of them.
const settings = new SettingsStore(db);
await settings.load();

/**
 * The store-first config, rebuilt whenever the store changes.
 *
 * Read this rather than `cfg` for anything that can change at runtime. It is
 * still the same `loadConfig()`, and every env-only key inside it is still read
 * from the environment - see the note on loadConfig() for which, and why three
 * of them could not come from the store even if policy allowed it.
 */
let liveCfg = loadConfig(storeFirst(settings.envSnapshot(cfg.guildId)));

settings.onChange(() => {
  const previous = liveCfg;
  liveCfg = loadConfig(storeFirst(settings.envSnapshot(cfg.guildId)));
  // One line naming what actually moved. A raid threshold that changed at
  // 03:00 with no record of it is the kind of thing that makes an incident
  // unreconstructable afterwards, and "config reloaded" would not have told
  // anyone which number they are now living with.
  for (const [key, read] of Object.entries(HOT_WIRED_FIELDS)) {
    const from = read(previous);
    const to = read(liveCfg);
    if (from !== to) log.info('setting_changed', { key, from, to });
  }
});
settings.start();
log.info('settings_store_ready', {
  rows: settings.size(),
  version: settings.currentVersion(),
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

const store = new EventStore(db);
const invites = new InviteTracker(db);
// One instance, two ends: guild.add_member writes the "expect this member"
// note, the gateway join handler consumes it. docs/INTERNAL_ACTIONS.md §7.
const expectedJoins = new ExpectedJoins();
const leveling = new LevelingService(db);
const communityClassifier = new CommunityClassifier(communityClassifierCfg);
const communityFacts = cfg.communityScorecard ? new CommunityFactStore(db, communityClassifier) : null;
// The dispatcher rejects unbound actors before attribution or persistence.
// This second boundary protects direct funnel calls; staging eligibility and
// the real observer's per-subject ordering remain unchanged.
const handlers = stagingRestartArmed && stagingSyntheticActors
  ? new StagingRestartFunnelFirewall(store, leveling, communityFacts, stagingSyntheticActors)
  : new FunnelHandlers(store, leveling, communityFacts);

const client = createClient(process.env.TWO_AUTOMOD === '1');
const moderationCfg = loadModerationConfig();
// Narrowed once: property access below stays on the enabled member.
const rotaCfg = onboardingRotaCfg.enabled === true ? onboardingRotaCfg : undefined;
const onboardingRotaCore = rotaCfg
  ? new OnboardingRota(db, communityClassifier, rotaCfg)
  : undefined;
const onboardingRota = onboardingRotaCore && rotaCfg
  ? new DiscordOnboardingRota(db, onboardingRotaCore, {
    guildId: rotaCfg.guildId,
    primaryActorId: rotaCfg.primaryActorId,
    staffRoleIds: new Set([
      ...moderationCfg.protectedRoleIds,
      ...(cfg.ticketStaffRoleId ? [cfg.ticketStaffRoleId] : []),
    ]),
    staffActorIds: new Set(moderationCfg.owenUserId ? [moderationCfg.owenUserId] : []),
    humanChannelIds: new Set([
      ...cfg.communityHumanChannelIds, ...cfg.communityWelcomeChannelIds,
      ...(cfg.onboardingMode === 'session' && cfg.sessionLookingToPlayChannelId
        ? [cfg.sessionLookingToPlayChannelId] : []),
      ...(cfg.onboardingMode !== 'session' && cfg.anchorWelcomeChannelId ? [cfg.anchorWelcomeChannelId] : []),
    ]),
  })
  : undefined;
const moderationStore = new ModerationStore(db);
// TOG-3190. Switching moderation off while a tempban's unban is still pending,
// or a channel is still locked down, leaves nothing running to release them.
// Refuse to boot in that state, naming every member and channel affected.
// TWO_MODERATION_DISABLE_OVERRIDE=1 proceeds and logs the stranded set instead.
// Before the edit, run `npm run moderation:disable-preflight` - same reads, no
// restart. See docs/MODERATION.md "Turning moderation off".
await enforceModerationShutdownPreflight({
  enabled: moderationCfg.enabled,
  store: moderationStore,
});
const moderationDiscord = new ModerationDiscord({
  token: cfg.discordToken,
  base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
});
const moderationResolver = !stagingRestartArmed && cfg.guildId && moderationCfg.enabled
  ? new RestModerationResolver({
      token: cfg.discordToken,
      botUserId: moderationCfg.owenUserId,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    })
  : null;
const operationalAuditStore = new OperationalAuditStore(db);
// Under staging restart containment the audit mirror never POSTs: dryRun
// keeps the durable rows and kill-switch semantics while every send path
// records 'dry_run' instead. Normal production behavior is unchanged.
const audit = makeOperationalAudit(client, {
  guildId: cfg.guildId,
  channels: {
    audit: cfg.auditLogChannelId,
    voice: cfg.voiceLogChannelId,
    moderation: cfg.moderationLogChannelId,
  },
  store: operationalAuditStore,
  ...(stagingRestartArmed ? { dryRun: true } : {}),
});
// Staging-only rota fallback notices. The boot guard above guarantees the
// channel, primary and reader bindings are all present when this constructs;
// the delivery service rechecks gates, eligibility and effective-reader
// access before every send. No fallback destination, no permission writes.
const rotaNoticeDelivery = onboardingRotaCore && rotaCfg &&
  rotaCfg.noticeEnabled && rotaCfg.noticeChannelId &&
  rotaCfg.primaryActorId && rotaCfg.readerIds?.length
  ? new RotaNoticeDelivery(client, {
    guildId: rotaCfg.guildId,
    noticeChannelId: rotaCfg.noticeChannelId,
    readerIds: rotaCfg.readerIds,
  }, { rota: onboardingRotaCore, store: operationalAuditStore })
  : undefined;
if (rotaNoticeDelivery && rotaCfg) {
  // Under staging restart containment the scheduler stays live (its lifecycle
  // is under test) but the delivery service is stopped at construction, so no
  // POST can begin — including work already waiting on access/history I/O.
  // Tier T1 proves the negative (zero facts, no sends); Tier T2 stays gated.
  if (stagingRestartArmed) {
    rotaNoticeDelivery.stop();
    log.info('rota_notice_delivery_contained', {
      guildId: rotaCfg.guildId,
      noticeChannel: rotaCfg.noticeChannelId,
    });
  } else {
    log.info('rota_notice_delivery_enabled', {
      guildId: rotaCfg.guildId,
      noticeChannel: rotaCfg.noticeChannelId,
    });
  }
} else {
  log.info('rota_notice_delivery_disabled', {
    reason: !rotaCfg ? 'measurement off'
      : !rotaCfg.noticeEnabled ? 'notice off' : 'notice binding incomplete',
  });
}
log.info('operational_audit_enabled', {
  guildId: cfg.guildId ?? 'all joined guilds (Discord mirrors disabled)',
  auditTarget: cfg.auditLogChannelId ?? 'durable/process log only',
  voiceTarget: cfg.voiceLogChannelId ?? cfg.auditLogChannelId ?? 'durable/process log only',
  moderationTarget: cfg.moderationLogChannelId ?? cfg.auditLogChannelId ?? 'durable/process log only',
});
const moderationService = moderationResolver
  ? new ModerationService(moderationDiscord, moderationStore, {
      owenUserId: moderationCfg.owenUserId,
      botUserId: moderationCfg.owenUserId,
      protectedRoleIds: moderationCfg.protectedRoleIds,
      moderationAuditSecret: moderationCfg.moderationAuditSecret,
    }, Date.now, audit)
  : null;
if (moderationCfg.enabled && !moderationCfg.moderationAuditSecret) {
  log.error('moderation_audit_secret_missing', {
    hint: 'provide the systemd credential `moderation_audit_secret` or TWO_MODERATION_AUDIT_SECRET; '
      + 'without it, moderation-service gateway correlation (TOG-2223 #8) is disabled',
  });
}
const automodCfg = loadAutomodConfig();
if (!stagingRestartArmed && automodCfg.enabled && !moderationService) {
  throw new Error('TWO_AUTOMOD=1 requires TWO_MODERATION=1 so sanctions use the reviewed moderation path.');
}
const automodService = cfg.guildId && automodCfg.enabled && moderationResolver && moderationService
  ? new AutomodService(
      moderationDiscord,
      moderationService,
      moderationStore,
      new AutomodStore(db),
      moderationResolver,
      {
        // Under staging restart containment automod inspects but never
        // deletes or sanctions: message deletion is a Discord mutation
        // outside the rota lifecycle. Production default unchanged.
        dryRun: stagingRestartArmed ? true : automodCfg.dryRun,
        owenUserId: moderationCfg.owenUserId,
        botHighestRolePosition: await moderationResolver.botHighestRolePosition(cfg.guildId),
        policy: automodCfg.policy,
      },
      undefined,
      () => liveCfg.automodRepeatedMessageCount,
    )
  : null;

// Point discord.js at a different API host. Only used by tools/mock-discord.
if (cfg.apiBase) {
  client.rest.options.api = cfg.apiBase;
  log.info('api_base_override', { apiBase: cfg.apiBase });
}

// Join-burst detection (TWO-56). Always on - three raids reached this server
// unnoticed. Where the alert goes is configurable; whether we watch is not.
//
// Thunks, not numbers: these two are the keys slice 1 wires live, so each join
// is judged against whatever the last settings poll left in `liveCfg` rather
// than against whatever the environment said at boot. Everything else here
// still reads `cfg` - see the HOT_WIRED note in src/core/settingsCatalog.ts for
// why "hot" is a permission and not yet a promise.
// Under staging restart containment the staff announcers log only and post
// nothing: the watch/scorer still observe (their lifecycle is under test) but
// the channel write is replaced with a null channel. Production defaults and
// the session-mode armed-containment refusal above are unchanged.
const raid = {
  watch: new RaidWatch({
    threshold: () => liveCfg.raidJoinThreshold,
    windowSeconds: () => liveCfg.raidWindowSeconds,
  }),
  announce: makeRaidAnnouncer(client, {
    channelId: stagingRestartArmed ? null : cfg.staffAlertChannelId,
    ...(stagingRestartArmed ? { dryRun: true } : {}),
  }),
};
log.info('raid_watch_enabled', {
  threshold: liveCfg.raidJoinThreshold,
  windowSeconds: liveCfg.raidWindowSeconds,
  // No staff channel means the alert exists only in this log. Said out loud at
  // boot so it is a known state rather than a surprise during a raid.
  alertTarget: cfg.staffAlertChannelId ?? 'log only (DISCORD_STAFF_ALERT_CHANNEL_ID unset)',
});

const containmentStore = new ContainmentStore(db);
const joinRisk = containmentCfg.enabled
  ? new JoinRiskScorer({
      store: containmentStore,
      config: containmentCfg,
      announce: makeJoinRiskAnnouncer(
        client,
        stagingRestartArmed ? null : containmentCfg.alertChannelId,
      ),
    })
  : undefined;

registerHandlers(client, {
  onboardingRota,
  handlers,
  invites,
  community: communityFacts
    ? {
        humanChannelIds: new Set(cfg.communityHumanChannelIds),
        welcomeChannelIds: new Set(cfg.communityWelcomeChannelIds),
      }
    : undefined,
  raid,
  expectedJoins,
  leveling,
  levelRoleWrites: levelRoleWritesForOnboardingMode(cfg.onboardingMode),
  automod: automodService && cfg.guildId ? { service: automodService, guildId: cfg.guildId } : undefined,
  joinRisk,
  audit,
  auditGuildId: cfg.guildId,
  moderationAuditSecret: moderationCfg.moderationAuditSecret,
  ...(stagingRestartArmed && stagingSyntheticActors ? {
    stagingRestart: { guildId: TWO_STAGING_GUILD_ID, syntheticActorIds: stagingSyntheticActors },
  } : {}),
});

if (!stagingRestartArmed && containmentCfg.enabled && containmentCfg.guildId) {
  if (containmentCfg.guildId !== TWO_STAGING_GUILD_ID || containmentCfg.botUserId !== STAGING_BOT_APPLICATION_ID) {
    throw new Error(
      `TOG-1650 is staging-only: expected guild ${TWO_STAGING_GUILD_ID} and application ${STAGING_BOT_APPLICATION_ID}.`,
    );
  }
  const guildConfigApi = new GuildConfigDiscordApi({
    token: cfg.discordToken,
    applicationId: STAGING_BOT_APPLICATION_ID,
    guildId: TWO_STAGING_GUILD_ID,
    apiBase: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
  });
  await guildConfigApi.assertIdentity();
  const restore = containmentCfg.snapshotPath
    ? new SnapshotRestoreAdvisor(
        JSON.parse(readFileSync(containmentCfg.snapshotPath, 'utf8')) as GuildConfigSnapshot,
        async () => guildConfigApi.capture(),
      )
    : null;
  const containment = new DestructiveContainment({
    store: containmentStore,
    discord: new ContainmentDiscord({
      token: cfg.discordToken,
      botUserId: containmentCfg.botUserId,
      base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
    }),
    config: containmentCfg,
    announce: makeContainmentAnnouncer(
      client,
      stagingRestartArmed ? null : containmentCfg.alertChannelId,
    ),
    restore,
  });
  registerContainment(client, containment, containmentCfg.guildId);
  log.info('anti_nuke_enabled', {
    guildId: containmentCfg.guildId,
    dryRun: containmentCfg.dryRun,
    heatThreshold: containmentCfg.heatThreshold,
    windowSeconds: containmentCfg.windowSeconds,
    snapshot: containmentCfg.snapshotPath ? 'configured' : 'not configured',
  });
}

if (communityFacts && !stagingRestartArmed) {
  registerCommunityAttendance(client, { facts: communityFacts, guildId: cfg.guildId });
} else if (communityFacts) {
  log.info('community_attendance_disabled', { reason: 'staging restart containment' });
}

// Under staging restart containment tickets stay unregistered: ticket
// creation opens private channels and posts member-facing messages —
// unrelated Discord mutations the Tier T1 negative proof must exclude.
// Production defaults unchanged.
if (stagingRestartArmed) {
  log.info('tickets_disabled', { reason: 'staging restart containment' });
} else if (cfg.ticketCategoryId && cfg.ticketStaffRoleId && cfg.ticketPanelChannelId) {
  registerTickets(client, {
    db,
    guildId: cfg.guildId,
    categoryId: cfg.ticketCategoryId,
    staffRoleId: cfg.ticketStaffRoleId,
    panelChannelId: cfg.ticketPanelChannelId,
    cooldownSeconds: cfg.ticketCooldownSeconds,
  });
  log.info('tickets_enabled', {
    guildId: cfg.guildId ?? 'all',
    panelChannelId: cfg.ticketPanelChannelId,
    categoryId: cfg.ticketCategoryId,
    staffRoleId: cfg.ticketStaffRoleId,
    cooldownSeconds: cfg.ticketCooldownSeconds,
  });
} else {
  log.info('tickets_disabled', { reason: 'ticket channel, category, and staff role are not all configured' });
}
if (!stagingRestartArmed) registerLeveling(client, { service: leveling, guildId: cfg.guildId });
if (automodService) {
  log.info('automod_enabled', {
    guildId: cfg.guildId,
    dryRun: automodCfg.dryRun,
    badWords: automodCfg.policy.badWords.length,
    bypassRoles: automodCfg.policy.bypassRoleIds.size,
    exemptChannels: automodCfg.policy.exemptChannelIds.size,
  });
}
// Under staging restart containment the moderation slash handler stays
// unregistered: kick/ban/timeout/lockdown are destructive Discord mutations
// outside the rota lifecycle. The moderation service still exists for the
// automod wiring decision below; no command reaches it. Production unchanged.
if (stagingRestartArmed) {
  log.info('moderation_handler_disabled', { reason: 'staging restart containment' });
} else if (cfg.guildId && moderationResolver && moderationService) {
  registerModerationHandler(client, {
    guildId: cfg.guildId,
    resolver: moderationResolver,
    service: moderationService,
  });

}

// Automations (TOG-1648): custom commands, scheduled messages, stickies.
let automationScheduler: ReturnType<typeof startScheduler> | null = null;
const automationStore = new AutomationStore(db);
const automationDiscord = new AutomationDiscord({
  token: cfg.discordToken,
  base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
});
const automationService = new AutomationService(automationStore, automationDiscord);

/**
 * Deregister every DB-backed custom command an earlier enabled boot published
 * (TOG-3189). Runs as the command registry's `beforeFirstSync` hook rather than
 * off its own ready listener: it has to read the set Discord is *currently*
 * publishing, and the registry's first sync replaces that set wholesale.
 */
async function sweepDisabledAutomationCommands(guildId: string): Promise<void> {
  const applicationId = client.application?.id;
  if (!applicationId) {
    log.error('automations_disable_sweep_failed', {
      guildId,
      err: 'client.application is unset at ready; custom commands may still be published',
    });
    return;
  }
  const registrar = new RestGuildCommandRegistrar({
    token: cfg.discordToken,
    applicationId,
    guildId,
    base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
  });
  try {
    const result = await removeDbBackedCommands(guildId, automationStore, registrar);
    log.info('automations_disable_sweep', {
      summary: summariseDisable(result),
      removed: result.removed,
      alreadyAbsent: result.alreadyAbsent,
    });
  } catch (err) {
    // Loud, and specific about what is still answering. Not fatal: the handler
    // wiring below already refuses every one of these, so a retryable Discord
    // failure must not turn into a boot loop.
    const partial = err instanceof AutomationDisableIncomplete ? err.result : null;
    log.error('automations_disable_sweep_failed', {
      guildId,
      err: String(err),
      removed: partial?.removed ?? [],
      stillPublished: partial?.failed.map((f) => f.name) ?? [],
      untouched: partial?.untouched ?? [],
    });
  }
}

let commandRegistry: CommandRegistry | null = null;
// No publication, cleanup DELETE, or reconnect sync during acceptance.
if (!stagingRestartArmed && cfg.guildId) {
  const registryGuildId = cfg.guildId;
  commandRegistry = new CommandRegistry(client, {
    guildId: registryGuildId,
    automations: automationStore,
    additionalBuiltins: [
      ...(communityFacts ? COMMUNITY_COMMAND_DATA : []),
      ...(onboardingRotaCfg.enabled && onboardingRotaCfg.primaryActorId ? [ROTA_ACKNOWLEDGEMENT_COMMAND] : []),
      ...(automationCfg.enabled ? AUTOMATION_COMMAND_DATA : []),
      ...(announcementsCfg.enabled ? ANNOUNCEMENT_COMMAND_DATA : []),
      ...(moderationResolver && moderationService ? MODERATION_COMMAND_DATA : []),
    ],
    // Disabled automations must not have their custom commands re-published by
    // the very next sync after the disable sweep removed them (TOG-3189).
    automationsEnabled: automationCfg.enabled,
    beforeFirstSync: automationCfg.enabled
      ? undefined
      : () => sweepDisabledAutomationCommands(registryGuildId),
  });
}
// Even disabled-command replies are writes, so containment omits both paths.
if (stagingRestartArmed) {
  log.info('automations_disabled', { reason: 'staging restart containment' });
} else if (cfg.guildId && automationCfg.enabled) {
  registerAutomationCommands(client, {
    guildId: cfg.guildId,
    service: automationService,
    store: automationStore,
    syncCommands: () => commandRegistry!.sync(),
  });
  registerAutomationGateway(client, {
    guildId: cfg.guildId,
    service: automationService,
    textCommandsEnabled: automationCfg.textCommandsEnabled,
    findTrigger: (guildId, word) => automationStore.findTextTrigger(guildId, word),
  });
  automationScheduler = startScheduler(automationService, cfg.guildId);
  log.info('automations_enabled', {
    guildId: cfg.guildId,
    textCommands: automationCfg.textCommandsEnabled ? 'on' : 'off (slash-only)',
  });
} else if (cfg.guildId) {
  // Disabled, but the guild is configured - so admin-defined commands may still
  // be published from a previous enabled boot. Two halves, both needed
  // (TOG-3189): refuse every invocation, and deregister the commands.
  registerAutomationCommands(client, {
    guildId: cfg.guildId,
    service: automationService,
    store: automationStore,
    enabled: false,
  });
  // The deregister half runs as the command registry's beforeFirstSync hook
  // (above), so it reads the published set before the first full-set replace.
  log.info('automations_disabled', {
    reason: 'TWO_AUTOMATIONS is not 1',
  });
} else {
  log.info('automations_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
}
if (!stagingRestartArmed && onboardingRota && onboardingRotaCfg.enabled && onboardingRotaCfg.primaryActorId) {
  registerRotaAcknowledgement(client, onboardingRotaCfg.guildId, onboardingRota);
}
commandRegistry?.register();

// Announcements / scheduled-event RSVP / LFG / feed relays (TOG-1649).
// Under staging restart containment the feed poller never starts: it relays
// external feed content into Discord channels — unrelated sends the Tier T1
// negative proof must exclude. Command handlers are omitted as well.
let feedPoller: ReturnType<typeof startFeedPoller> | null = null;
if (stagingRestartArmed) {
  log.info('announcements_disabled', { reason: 'staging restart containment' });
} else if (cfg.guildId && announcementsCfg.enabled) {
  const announcementsStore = new AnnouncementsStore(db);
  const announcementsService = new AnnouncementsService(
    announcementsStore,
    new DiscordAnnouncements({ token: cfg.discordToken, base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined }),
    new XmlFeedReader(),
  );
  registerAnnouncementCommands(client, {
    guildId: cfg.guildId,
    service: announcementsService,
    store: announcementsStore,
  });
  feedPoller = startFeedPoller(announcementsService, cfg.guildId, announcementsCfg.feedPollSeconds);
  log.info('announcements_enabled', { guildId: cfg.guildId, feedPollSeconds: announcementsCfg.feedPollSeconds });
} else {
  log.info('announcements_disabled', {
    reason: cfg.guildId ? 'TWO_ANNOUNCEMENTS is not 1' : 'DISCORD_GUILD_ID is unset',
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
  onboardingRota,
  recorder: new OnboardingRecorder(store),
  landingChannelIds: () => liveCfg.landingChannelIds,
  dryRun: cfg.onboardingDryRun,
};

// Session mode (TOG-1654): the roleless flow owns the gate-clear moment
// instead, and no other onboarding handler may be registered alongside it -
// see the starvation note above. The legacy picker code stays in the tree,
// unregistered, selected back by unsetting TWO_ONBOARDING_MODE.
//
// Welcome/picker listeners write directly through their own recorders and can
// send even in production dry-run mode. Omit registration for acceptance;
// never redefine that normal behavior or fabricate a promptShown observation.
if (stagingRestartArmed) {
  log.info('onboarding_disabled', { reason: 'staging restart containment' });
} else if (cfg.onboardingMode === 'session') {
  registerSessionWelcome(client, {
    onboardingRota,
    recorder: new SessionRecorder(store),
    guildId: cfg.guildId!,
    store,
    landingChannelIds: () => liveCfg.landingChannelIds,
    goodbyeChannelIds: cfg.goodbyeChannelIds,
    picks: buildSessionPicks({
      lookingToPlay: cfg.sessionLookingToPlayChannelId!,
      lobbyVoice: cfg.sessionLobbyVoiceChannelId!,
    }),
    dryRun: cfg.onboardingDryRun,
  });
  log.info('session_onboarding_enabled', {
    landingChannelIds: cfg.landingChannelIds,
    goodbyeChannelIds: cfg.goodbyeChannelIds,
    dryRun: cfg.onboardingDryRun,
  });
} else if (cfg.anchorWelcomeChannelId) {
  registerAnchorWelcome(client, {
    onboardingRota,
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

// Hardened self-role panels (TOG-1646). The panel catalogue is deployment data:
// ids are never guessed from the live guild, and an empty catalogue is a clean
// disable rather than an implicit panel with production ids.
if (stagingRestartArmed) {
  log.info('self_roles_disabled', { reason: 'staging restart containment' });
} else if (selfRolePanels.length) {
  if (!cfg.guildId) {
    throw new Error('TWO_SELF_ROLE_PANELS requires DISCORD_GUILD_ID - every panel belongs to one guild.');
  }
  assertSelfRoleStagingBoundary(cfg.guildId, cfg.discordToken);
  const selfRoleRest = new DiscordRest({
    token: cfg.discordToken,
    base: cfg.apiBase ? `${cfg.apiBase}/v10` : undefined,
  });
  const [selfRoleRoles, selfRoleChannels] = await Promise.all([
    selfRoleRest.get<Array<{ id: string; name?: string; permissions: string }>>(`/guilds/${cfg.guildId}/roles`),
    selfRoleRest.get<Array<{
      id: string;
      name?: string;
      permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
    }>>(`/guilds/${cfg.guildId}/channels`),
  ]);
  if (!selfRoleRoles || !selfRoleChannels) {
    throw new Error(`TWO_SELF_ROLE_PANELS roles or channels could not be resolved for guild ${cfg.guildId}`);
  }
  validateSelfRolePanelRoles(
    selfRolePanels,
    selfRoleRoles,
    selfRoleChannels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      permissionOverwrites: channel.permission_overwrites,
    })),
    cfg.guildId,
  );
  registerSelfRoles(client, {
    panels: selfRolePanels,
    store: new SelfRoleStore(db),
    dryRun: cfg.selfRoleDryRun,
  });
  log.info('self_roles_enabled', {
    panels: selfRolePanels.length,
    modes: [...new Set(selfRolePanels.map((panel) => panel.mode))],
    dryRun: cfg.selfRoleDryRun,
  });
} else {
  log.info('self_roles_disabled', { reason: 'TWO_SELF_ROLE_PANELS is empty' });
}

// The internal actions endpoint (TWO-24 / TWO-59). Off unless
// TWO_INTERNAL_ACTIONS=1 - a bot without it runs exactly as before and opens
// no port. When it is on, a bad bind address or a missing key is a startup
// crash rather than a quietly-exposed remote control for the server.
const internalCfg = loadInternalActionsConfig();
if (internalCfg) internalCfg.enabled = actionsForOnboardingMode(cfg.onboardingMode, internalCfg.enabled);
// Under staging restart containment the internal actions listener never
// starts: role.assign/event.upsert/guild.add_member are Discord mutations
// outside the rota lifecycle. Production defaults unchanged.
let internal: InternalServer | null = null;
if (stagingRestartArmed) {
  log.info('internal_actions_disabled', { reason: 'staging restart containment' });
} else if (internalCfg) {
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
    automations: automationCfg.enabled ? automationService : null,
    allowAutomationOverwrite: automationCfg.enabled && internalCfg.allowAutomationOverwrite,
    syncCommands: automationCfg.enabled && commandRegistry ? () => commandRegistry!.sync() : null,
    moderation: moderationResolver && moderationService
      ? { resolver: moderationResolver, service: moderationService }
      : null,
  });
}

// The internal presence instrument (TOG-469). Hourly, REST-only, and nothing
// it collects is reachable from the website - the table is in the bot schema,
// which the website's role is REVOKEd from, and no `web_v1` view reads it.
//
// Needs a guild to ask about. A missing guild is a logged skip, never a crash -
// this is an instrument for an internal question and it does not get to stop
// the funnel from recording joins.
// Under staging restart containment the member-list snapshot jobs stay off:
// communitySnapshots writes member_ranks.member_id/member_exclusions rows for
// every real member (TOG-3903 launch blocker), presenceProbe/scheduledEvents
// ingest real-member presence/event state, and the scorecard derives
// member-attributed facts. The rota observer/scheduler lifecycle under test is
// untouched. Production defaults are unchanged.
let presenceProbe: PresenceProbeHandle | null = null;
if (stagingRestartArmed) {
  log.info('presence_probe_disabled', { reason: 'staging restart containment' });
} else if (!cfg.presenceProbe) {
  log.info('presence_probe_disabled', { reason: 'TWO_PRESENCE_PROBE=0' });
} else if (!cfg.guildId) {
  log.info('presence_probe_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
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
// A failed or ungrounded read writes nothing and ages out in web_v1.
let communitySnapshots: CommunitySnapshotHandle | null = null;
if (stagingRestartArmed) {
  log.info('community_snapshots_disabled', { reason: 'staging restart containment' });
} else if (!cfg.guildId) {
  log.info('community_snapshots_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
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
if (stagingRestartArmed) {
  log.info('scheduled_events_disabled', { reason: 'staging restart containment' });
} else if (!cfg.guildId) {
  log.info('scheduled_events_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
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

let communityScorecard: CommunityScorecardJobHandle | null = null;
if (stagingRestartArmed) {
  log.info('community_scorecard_disabled', { reason: 'staging restart containment' });
} else if (!cfg.communityScorecard) {
  log.info('community_scorecard_disabled', { reason: 'TWO_COMMUNITY_SCORECARD is not 1' });
} else if (!cfg.guildId) {
  log.info('community_scorecard_disabled', { reason: 'DISCORD_GUILD_ID is unset' });
} else {
  communityScorecard = startCommunityScorecardJob({
    db,
    guildId: cfg.guildId,
    classifierVersion: communityClassifier.version,
    facts: communityFacts!,
    captureStartedAt: processStartedAt,
    recommendationsEnabled: cfg.communityRecommendations,
    correctionCycles: cfg.communityCorrectionCycles,
  });
}

const auditRetry = () => {
  void audit.retryPending().catch(() => {
    log.error('operational_audit_retry_failed', { classification: 'audit_retry_failed' });
  });
};
if (!stagingRestartArmed) client.once('ready', auditRetry);
const auditSweep = stagingRestartArmed ? null : setInterval(auditRetry, 30_000);
auditSweep?.unref();

// Rota fallback-notice ticker. Same non-overlapping shape as the automation
// scheduler; the durable claim row (not the interval) is the queue, so a
// missed tick or restart loses nothing.
const rotaNoticeScheduler = rotaNoticeDelivery ? startRotaNoticeScheduler(rotaNoticeDelivery) : null;

const moderationSweep = !stagingRestartArmed && moderationService
  ? setInterval(() => {
      void moderationService.runDueUnbans().catch((err: unknown) => {
        log.error('moderation_unban_sweep_failed', { err: String(err) });
      });
    }, 30_000)
  : null;
moderationSweep?.unref();

// Inactivity sweep once an hour. Cheap query; no outbound messages.
const sweep = stagingRestartArmed ? null : setInterval(
  () => {
    void flagInactive(db, store, cfg.inactivityDays).catch((err: unknown) => {
      log.error('inactivity_sweep_failed', { err: String(err) });
    });
  },
  60 * 60 * 1000,
);
sweep?.unref();

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
  if (sweep) clearInterval(sweep);
  automationScheduler?.stop();
  if (auditSweep) clearInterval(auditSweep);
  rotaNoticeScheduler?.stop();
  feedPoller?.stop();
  if (moderationSweep) clearInterval(moderationSweep);
  presenceProbe?.stop();
  communitySnapshots?.stop();
  scheduledEvents?.stop();
  communityScorecard?.stop();
  // Before db.close(), or the next poll runs a query against a closed pool and
  // the last line of a clean shutdown is a settings_poll_failed.
  settings.stop();
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
