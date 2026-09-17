/**
 * Every environment variable `src/` reads, classified by where it is allowed to
 * live and when a change to it takes effect.
 *
 * This is the load-bearing half of TOG-3100. `guild_settings` is only as safe
 * as the set of keys it refuses to hold, and that set is this file.
 *
 * ## The three classes
 *
 * - **`env_only`** - secrets, boot inputs, network binds, and anything that
 *   widens or loosens what the *website* can make the bot do. Never stored,
 *   never rendered in the admin UI. Refused by `assertStorableKey()`, and
 *   refused again by a CHECK constraint in
 *   `migrations/0027_guild_settings_env_only.sql` so a direct SQL write cannot
 *   route around the application.
 * - **`cold`** - storable and safe, but read once while the process boots, so a
 *   saved value applies at the next restart. The UI must say so; saving one
 *   files an `operator` card.
 * - **`hot`** - storable, and *eligible* to apply without a restart. See the
 *   warning on `HOT_WIRED` below: eligible is not the same as wired.
 *
 * ## Unknown keys are refused, not allowed
 *
 * `classifyKey()` returns `undefined` for a name that is not in this table, and
 * `isStorableKey()` treats that as "not storable". Fail-closed is the only
 * default that survives the codebase growing: the next capability gate somebody
 * adds is refused until they come here and classify it, rather than being
 * silently storable from the day it lands. `test/unit.settingscatalog.test.ts`
 * fails in both directions - a variable in `src/` that is missing here, and an
 * entry here that `src/` no longer reads.
 *
 * ## Why the `TWO_INTERNAL_` prefix alone was not enough (TOG-3183, CISO)
 *
 * The prefix test shipped on PR #125 is correct and stays, but the set of keys
 * that gate capability is larger than the namespace:
 *
 * - `TWO_MODERATION` co-gates nine moderation verbs with
 *   `TWO_INTERNAL_ALLOW_MODERATION` (`src/internal/config.ts:83`), and is
 *   outside the namespace.
 * - `TWO_ONBOARDING_MODE` is fed through `actionsForOnboardingMode()` at
 *   `src/index.ts:543`, which deletes `role.assign` from the allowlist in
 *   session mode (`src/onboarding/mode.ts:9`). A stored `legacy` would put that
 *   verb back at the next restart.
 *
 * Both are the primitive ADR TOG-3093 §2.4 exists to prevent - a settings write
 * that widens the allowlist that authorises settings writes - so both are
 * `env_only` even though neither carries the prefix.
 */

/**
 * Prefix test, kept alongside the exact-name table.
 *
 * A prefix rather than the ten `TWO_INTERNAL_*` names that exist today: the
 * next gate added inside the namespace is protected without anyone having to
 * remember this file.
 */
export const ENV_ONLY_KEY_PREFIXES = ['TWO_INTERNAL_'] as const;

export type SettingClass = 'hot' | 'cold' | 'env_only';

/**
 * Names that never reach `src/` through `process.env.X` or `env.X`, so the
 * TOG-3100 census grep cannot see them: they arrive as the fallback array of a
 * `readSecret()` call. All three are secrets, which is exactly the set you least
 * want a census to miss - two of them (`DISCORD_TOKEN`, the database URL) were
 * demonstrated storable in the TOG-3183 probe.
 */
export const SECRET_NAMES_NOT_IN_SRC_GREP = [
  'DISCORD_BOT_TOKEN', // src/core/config.ts:102
  'DISCORD_TOKEN', // src/core/config.ts:102
  'TWO_MODERATION_AUDIT_SECRET', // src/moderation/config.ts:36
] as const;

/**
 * The whole census. Keys are exactly the names `src/` reads, plus
 * `SECRET_NAMES_NOT_IN_SRC_GREP`.
 *
 * `cold` and `env_only` entries carry the citation that puts them there. `hot`
 * is the residual class and is not individually cited: a key is hot when
 * nothing reads it at boot.
 */
export const SETTING_CLASSES: Readonly<Record<string, SettingClass>> = {
  // ---------------------------------------------------------------- secrets
  DISCORD_BOT_TOKEN: 'env_only', // bot token; systemd credential `discord_token`
  DISCORD_TOKEN: 'env_only', // bot token, legacy name
  TWO_MODERATION_AUDIT_SECRET: 'env_only', // HMAC key, src/moderation/config.ts:36
  TWO_DATABASE_URL: 'env_only', // carries the Postgres password
  TWO_STAGING_DATABASE_URL: 'env_only',
  DISCORD_STAGING_BOT_TOKEN: 'env_only',
  TWO_BACKUP_S3_ACCESS_KEY_ID: 'env_only',
  TWO_BACKUP_S3_SECRET_ACCESS_KEY: 'env_only',

  // Not secrets, but they decide where a database backup is shipped. A
  // web-settable bucket or endpoint turns the backup job into an exfiltration
  // channel, which is worse than the credentials leaking on their own.
  TWO_BACKUP_S3_BUCKET: 'env_only',
  TWO_BACKUP_S3_ENDPOINT: 'env_only',
  TWO_BACKUP_S3_PREFIX: 'env_only',
  TWO_BACKUP_S3_REGION: 'env_only',

  // ------------------------------------------------------------------- boot
  // Read before the settings store exists, or used to find the store at all.
  CREDENTIALS_DIRECTORY: 'env_only', // where every systemd credential is read from
  TWO_DB_POOL_MAX: 'env_only', // pool is built by openDb() at src/index.ts:129
  // The store is keyed by guild id, so a guild-scoped row cannot tell the
  // process which guild it is. This one is structural, not a policy choice.
  DISCORD_GUILD_ID: 'env_only',
  DISCORD_STAGING_GUILD_ID: 'env_only',

  // ---------------------------------------------------------------- network
  TWO_HEALTH_BIND_HOST: 'env_only',
  TWO_HEALTH_PORT: 'env_only',
  TWO_REDIRECT_BIND_HOST: 'env_only',
  TWO_REDIRECT_PORT: 'env_only',
  // Repoints discord.js at another API host. Intended for tools/mock-discord;
  // settable from a web UI it is a redirect of every token-bearing request.
  DISCORD_API_BASE: 'env_only',

  // ------------------------------------------- capability gates and their bounds
  // The TWO_INTERNAL_* names are covered by the prefix as well; they are listed
  // so the census is complete and the drift test can see them.
  TWO_INTERNAL_ACTIONS: 'env_only',
  TWO_INTERNAL_ALLOW_ADD_MEMBER: 'env_only',
  TWO_INTERNAL_ALLOW_AUTOMATIONS: 'env_only',
  TWO_INTERNAL_ALLOW_AUTOMATIONS_OVERWRITE: 'env_only',
  TWO_INTERNAL_ALLOW_MODERATION: 'env_only',
  TWO_INTERNAL_ALLOW_SETTINGS: 'env_only',
  TWO_INTERNAL_BIND_HOST: 'env_only',
  TWO_INTERNAL_CHANNEL_KEYS: 'env_only',
  TWO_INTERNAL_PORT: 'env_only',
  TWO_INTERNAL_ROLE_KEYS: 'env_only',

  // Outside the namespace, inside the blast radius. See the file docblock.
  TWO_MODERATION: 'env_only', // src/internal/config.ts:83, co-gate on 9 verbs
  TWO_ONBOARDING_MODE: 'env_only', // src/index.ts:543 -> src/onboarding/mode.ts:9

  // These do not switch verbs on; they decide who an already-enabled verb may
  // reach. Widening them from the web is the same escalation one step later.
  TWO_MODERATION_PROTECTED_ROLE_IDS: 'env_only', // src/moderation/config.ts:21
  TWO_OWEN_USER_ID: 'env_only', // src/moderation/config.ts:19, containmentConfig.ts:47
  TWO_ANTI_NUKE_PROTECTED_USER_IDS: 'env_only', // exempt list, src/moderation/containment.ts:112
  TWO_ANTI_NUKE_TRUSTED_USER_IDS: 'env_only', // exempt list, src/moderation/containment.ts:113

  // A filesystem path chosen by a web form is a write primitive.
  TWO_ANTI_NUKE_SNAPSHOT_PATH: 'env_only',

  // ------------------------------------------------------------------- cold
  // Read once at boot. The card scoped cold to TWO_AUTOMOD; reading src/index.ts
  // says otherwise - every feature master switch gates construction or slash
  // command registration, and none of them can flip on a live client.
  TWO_AUTOMOD: 'cold', // partials/makeCache fixed at src/discord/client.ts:101, called once at src/index.ts:165
  TWO_ANNOUNCEMENTS: 'cold', // command data at src/index.ts:379, poller at :411
  TWO_AUTOMATIONS: 'cold', // command data at src/index.ts:378, registration at :385
  TWO_TEXT_COMMANDS: 'cold', // derived from TWO_AUTOMATIONS at src/automations/config.ts:24
  TWO_ANTI_NUKE: 'cold', // JoinRiskScorer built at src/index.ts:252, listeners at :280
  TWO_ANTI_NUKE_DRY_RUN: 'cold', // same construction, and guarded at src/index.ts:112
  TWO_COMMUNITY_SCORECARD: 'cold', // fact store at src/index.ts:162, job at :633
  TWO_COMMUNITY_RECOMMENDATIONS: 'cold', // passed into the job at src/index.ts:645
  TWO_COMMUNITY_CORRECTION_CYCLES: 'cold', // passed into the job at src/index.ts:646
  TWO_SELF_ROLE_PANELS: 'cold', // panels registered at src/index.ts:494
  TWO_PRESENCE_PROBE: 'cold', // probe started or skipped at src/index.ts:582
  TWO_FEED_POLL_SECONDS: 'cold', // interval fixed by startFeedPoller at src/index.ts:423
  TWO_INACTIVITY_DAYS: 'cold', // bound into the sweep closure at src/index.ts:671
  TWO_TICKET_COOLDOWN_SECONDS: 'cold', // ticket service built at src/index.ts:331
  LOG_LEVEL: 'cold', // setLogLevel() at src/index.ts:97; re-appliable, but not wired yet

  // -------------------------------------------------------------------- hot
  // Channel, role and category ids: read per event, so a saved value applies on
  // the next poll.
  DISCORD_ANCHOR_WELCOME_CHANNEL_ID: 'hot',
  DISCORD_AUDIT_LOG_CHANNEL_ID: 'hot',
  DISCORD_GOODBYE_CHANNEL_IDS: 'hot',
  DISCORD_LANDING_CHANNEL_IDS: 'hot',
  DISCORD_MODERATION_LOG_CHANNEL_ID: 'hot',
  DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID: 'hot',
  DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID: 'hot',
  DISCORD_STAFF_ALERT_CHANNEL_ID: 'hot',
  DISCORD_TICKET_CATEGORY_ID: 'hot',
  DISCORD_TICKET_PANEL_CHANNEL_ID: 'hot',
  DISCORD_VOICE_LOG_CHANNEL_ID: 'hot',
  DISCORD_TICKET_STAFF_ROLE_ID: 'hot',

  // Raid and join-risk thresholds. The raid pair is the one wired end to end -
  // see HOT_WIRED.
  TWO_RAID_JOIN_THRESHOLD: 'hot',
  TWO_RAID_WINDOW_SECONDS: 'hot',
  TWO_JOIN_RISK_THRESHOLD: 'hot',
  TWO_JOIN_RISK_WINDOW_SECONDS: 'hot',

  // Anti-nuke tuning. The master switch and the two exempt lists are not here -
  // they are env_only above. What is left is genuinely just tuning.
  TWO_ANTI_NUKE_EVENT_MAX_AGE_SECONDS: 'hot',
  TWO_ANTI_NUKE_HEAT_THRESHOLD: 'hot',
  TWO_ANTI_NUKE_WINDOW_SECONDS: 'hot',
  TWO_BULK_JOIN_WINDOW_UNTIL: 'hot',

  // Automod thresholds and lists. ADR §2.1: the master switch is cold, the
  // tuning is hot, and that split is the whole point of automod being usable
  // from the dashboard at all.
  TWO_AUTOMOD_ALLOWED_DOMAINS: 'hot',
  TWO_AUTOMOD_BAD_WORDS: 'hot',
  TWO_AUTOMOD_BLOCKED_ATTACHMENT_EXTENSIONS: 'hot',
  TWO_AUTOMOD_BYPASS_ROLE_IDS: 'hot',
  TWO_AUTOMOD_ENFORCE: 'hot',
  TWO_AUTOMOD_EXEMPT_CHANNEL_IDS: 'hot',
  TWO_AUTOMOD_MENTION_LIMIT: 'hot',
  TWO_AUTOMOD_REPEAT_COUNT: 'hot',
  TWO_AUTOMOD_REPEAT_WINDOW_SECONDS: 'hot',
  TWO_AUTOMOD_SANCTIONS: 'hot',

  // Community classifier inputs: read per scorecard run.
  TWO_COMMUNITY_AUTOMATION_ACTOR_IDS: 'hot',
  TWO_COMMUNITY_CLASSIFIER_VERSION: 'hot',
  TWO_COMMUNITY_HUMAN_CHANNEL_IDS: 'hot',
  TWO_COMMUNITY_RAID_ACTOR_IDS: 'hot',
  TWO_COMMUNITY_STAGING_ACTOR_IDS: 'hot',
  TWO_COMMUNITY_STAGING_GUILD_IDS: 'hot',
  TWO_COMMUNITY_TEST_ACTOR_IDS: 'hot',
  TWO_COMMUNITY_WELCOME_CHANNEL_IDS: 'hot',

  // Dry-run flags, read at the point of the write they suppress.
  TWO_ONBOARDING_DRY_RUN: 'hot',
  TWO_SELF_ROLE_DRY_RUN: 'hot',

  TWO_REDIRECT_FALLBACK_CODE: 'hot',
};

/**
 * The hot keys whose consumers actually read through the live config today.
 *
 * **Hot is a permission, not a promise.** Most `hot` values are still handed to
 * a constructor once at boot (`cfg.ticketCooldownSeconds` into the ticket
 * service, and so on), so storing one changes the loaded `Config` and nothing
 * else until that consumer is converted to read live. Shipping a dashboard
 * field for a key that is hot-but-unwired would show the owner a saved value
 * that silently does nothing - the failure this set exists to prevent.
 *
 * Slice 1 wires the raid pair, because that is what TOG-3100's staging proof
 * asks for. Converting the rest is slice 2 work; the UI should render an
 * unwired hot key as "next restart" until it appears here.
 */
export const HOT_WIRED: ReadonlySet<string> = new Set([
  'TWO_RAID_JOIN_THRESHOLD',
  'TWO_RAID_WINDOW_SECONDS',
]);

/** `undefined` for a name this file has never heard of. */
export function classifyKey(key: string): SettingClass | undefined {
  return Object.prototype.hasOwnProperty.call(SETTING_CLASSES, key)
    ? SETTING_CLASSES[key]
    : undefined;
}

/**
 * True for a key that must stay in the environment.
 *
 * Unknown keys are env-only: see the fail-closed note in the file docblock.
 */
export function isEnvOnlyKey(key: string): boolean {
  if (ENV_ONLY_KEY_PREFIXES.some((p) => key.startsWith(p))) return true;
  return classifyKey(key) !== 'hot' && classifyKey(key) !== 'cold';
}

/**
 * True when this file *declares* the key environment-only, as opposed to
 * refusing it for never having heard of it.
 *
 * `isEnvOnlyKey()` answers the security question and both cases are a refusal,
 * so nothing that enforces should branch on this. It exists for the things that
 * report to a human: "this key is environment-only" and "there is no such
 * setting" send an admin to two different places, and only one of them is a
 * policy argument.
 *
 * Note the prefix arm. `TWO_INTERNAL_KEYS` reaches `src/` through a
 * `readSecret()` fallback array rather than a property access, so the census
 * never sees it and `SETTING_CLASSES` has no row for it - but it is the signing
 * secret, and calling it "unknown" would be absurd. The prefix is a positive
 * declaration, not a fallback.
 */
export function isDeclaredEnvOnly(key: string): boolean {
  if (ENV_ONLY_KEY_PREFIXES.some((p) => key.startsWith(p))) return true;
  return classifyKey(key) === 'env_only';
}
