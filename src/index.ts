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
import { registerSelfRoles } from './discord/selfRoles.ts';
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
import { assertSelfRoleStagingBoundary } from './selfRoles/stagingFence.ts';
import { CommandRegistry } from './discord/commandRegistry.ts';
import { AutomationStore } from './automations/store.ts';
import { AutomationDiscord, registerAutomationCommands } from './automations/discord.ts';
import { AutomationService } from './automations/service.ts';
import { registerAutomationGateway } from './automations/gateway.ts';
import { startScheduler } from './automations/scheduler.ts';
import { loadAutomationConfig } from './automations/config.ts';
import { CommunityClassifier, loadCommunityClassifierConfig } from './analytics/communityClassifier.ts';
import { CommunityFactStore } from './analytics/communityFacts.ts';
import {
  startCommunityScorecardJob,
  type CommunityScorecardJobHandle,
} from './jobs/communityScorecard.ts';
import { registerCommunityAttendance } from './analytics/communityAttendance.ts';
import { loadAnnouncementsConfig } from './announcements/config.ts';
import { AnnouncementsStore } from './announcements/store.ts';
import { AnnouncementsService } from './announcements/service.ts';
import { DiscordAnnouncements, XmlFeedReader, registerAnnouncementCommands, startFeedPoller } from './announcements/discord.ts';

const cfg = loadConfig();
const automationCfg = loadAutomationConfig();
const processStartedAt = new Date().toISOString();
const announcementsCfg = loadAnnouncementsConfig();
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
const communityClassifier = new CommunityClassifier(loadCommunityClassifierConfig());
const communityFacts = cfg.communityScorecard ? new CommunityFactStore(db, communityClassifier) : null;
const handlers = new FunnelHandlers(store, leveling, communityFacts);

const client = createClient(process.env.TWO_AUTOMOD === '1');
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
const audit = makeOperationalAudit(client, {
  guildId: cfg.guildId,
  channels: {
    audit: cfg.auditLogChannelId,
    voice: cfg.voiceLogChannelId,
    moderation: cfg.moderationLogChannelId,
  },
  store: new OperationalAuditStore(db),
});
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
if (automodCfg.enabled && !moderationService) {
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
        dryRun: automodCfg.dryRun,
        owenUserId: moderationCfg.owenUserId,
        botHighestRolePosition: await moderationResolver.botHighestRolePosition(cfg.guildId),
        policy: automodCfg.policy,
      },
    )
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

const containmentCfg = loadContainmentConfig();
const containmentStore = new ContainmentStore(db);
const joinRisk = containmentCfg.enabled
  ? new JoinRiskScorer({
      store: containmentStore,
      config: containmentCfg,
      announce: makeJoinRiskAnnouncer(client, containmentCfg.alertChannelId),
    })
  : undefined;

registerHandlers(client, {
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
  automod: automodService && cfg.guildId ? { service: automodService, guildId: cfg.guildId } : undefined,
  joinRisk,
  audit,
  auditGuildId: cfg.guildId,
  moderationAuditSecret: moderationCfg.moderationAuditSecret,
});

if (containmentCfg.enabled && containmentCfg.guildId) {
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
    announce: makeContainmentAnnouncer(client, containmentCfg.alertChannelId),
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

if (communityFacts) {
  registerCommunityAttendance(client, { facts: communityFacts, guildId: cfg.guildId });
}

if (cfg.ticketCategoryId && cfg.ticketStaffRoleId && cfg.ticketPanelChannelId) {
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
registerLeveling(client, { service: leveling, guildId: cfg.guildId });
if (automodService) {
  log.info('automod_enabled', {
    guildId: cfg.guildId,
    dryRun: automodCfg.dryRun,
    badWords: automodCfg.policy.badWords.length,
    bypassRoles: automodCfg.policy.bypassRoleIds.size,
    exemptChannels: automodCfg.policy.exemptChannelIds.size,
  });
}
if (cfg.guildId && moderationResolver && moderationService) {
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

let commandRegistry: CommandRegistry | null = null;
if (cfg.guildId) {
  commandRegistry = new CommandRegistry(client, {
    guildId: cfg.guildId,
    automations: automationStore,
    additionalBuiltins: [
      ...(communityFacts ? COMMUNITY_COMMAND_DATA : []),
      ...(automationCfg.enabled ? AUTOMATION_COMMAND_DATA : []),
      ...(announcementsCfg.enabled ? ANNOUNCEMENT_COMMAND_DATA : []),
      ...(moderationResolver && moderationService ? MODERATION_COMMAND_DATA : []),
    ],
  });
  commandRegistry.register();
}
if (cfg.guildId && automationCfg.enabled) {
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
} else {
  log.info('automations_disabled', {
    reason: cfg.guildId ? 'TWO_AUTOMATIONS is not 1' : 'DISCORD_GUILD_ID is unset',
  });
}

// Announcements / scheduled-event RSVP / LFG / feed relays (TOG-1649).
let feedPoller: ReturnType<typeof startFeedPoller> | null = null;
if (cfg.guildId && announcementsCfg.enabled) {
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

// Hardened self-role panels (TOG-1646). The panel catalogue is deployment data:
// ids are never guessed from the live guild, and an empty catalogue is a clean
// disable rather than an implicit panel with production ids.
const selfRolePanels = loadSelfRolePanels();
if (selfRolePanels.length) {
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

let communityScorecard: CommunityScorecardJobHandle | null = null;
if (!cfg.communityScorecard) {
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
client.once('ready', auditRetry);
const auditSweep = setInterval(auditRetry, 30_000);
auditSweep.unref();

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
  automationScheduler?.stop();
  clearInterval(auditSweep);
  feedPoller?.stop();
  if (moderationSweep) clearInterval(moderationSweep);
  presenceProbe?.stop();
  communitySnapshots?.stop();
  scheduledEvents?.stop();
  communityScorecard?.stop();
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
