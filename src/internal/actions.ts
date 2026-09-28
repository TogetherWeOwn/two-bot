/**
 * The allowlist. docs/INTERNAL_ACTIONS.md §3.
 *
 * This file is the whole authorisation model. An attacker holding the
 * website's shared secret can do exactly what is listed here and nothing
 * else - there is no verb for reading the guild, kicking, banning or changing
 * permissions, so there is nothing to escalate to.
 *
 * All four approved actions are now built. Two are naturally idempotent
 * (role.assign, guild.add_member); the other two would produce a second
 * announcement or a duplicate event if repeated, so they require an
 * Idempotency-Key and the durable store from TOG-44. See NEEDS_IDEMPOTENCY_KEY
 * below - that set is the machine-readable version of §3's "needs key" column.
 */
import { ActionError } from './errors.ts';
import type { ActionDiscord, ScheduledEventInput } from './discordActions.ts';
import type { InternalActionStore } from './store.ts';
import { isStorableKey } from '../core/settings.ts';
import { isDeclaredEnvOnly } from '../core/settingsCatalog.ts';
import type { ModerationResolver } from '../moderation/resolver.ts';
import type { ModerationService } from '../moderation/service.ts';
import { runModerationAction } from '../moderation/actions.ts';
import { WEB_ONE_CLICK_SOURCE, type ExpectedJoins } from '../core/expectedJoins.ts';
import { ALL_PICKS } from '../onboarding/catalog.ts';
import { MODERATION_ACTIONS } from '../moderation/types.ts';
import { MAX_CUSTOM_COMMANDS } from '../discord/commandNames.ts';
import { CommandCapacityError } from '../automations/errors.ts';

export const IMPLEMENTED_ACTIONS = [
  'role.assign',
  'guild.add_member',
  'announcement.post',
  'event.upsert',
  'event.cancel',
  'event.read',
  'automations.import',
  'automations.export',
  'settings.get',
  'settings.set',
  ...MODERATION_ACTIONS,
] as const;
export type ActionName = (typeof IMPLEMENTED_ACTIONS)[number];

/**
 * Actions where a repeat is not harmless, so the caller must send an
 * `Idempotency-Key` and the bot must remember the result.
 *
 * Adding an action to IMPLEMENTED_ACTIONS without deciding which side of this
 * line it falls on is the mistake this set exists to prevent.
 */
export const NEEDS_IDEMPOTENCY_KEY: ReadonlySet<string> = new Set([
  'announcement.post',
  'event.upsert',
  'event.cancel',
  'automations.import',
  // A settings write is not naturally idempotent the way role.assign is: two
  // deliveries of the same save are two audit rows and two version bumps, and
  // if a concurrent save landed in between, the second delivery silently
  // reverts it. The key makes the retry replay one stored result instead.
  'settings.set',
  ...MODERATION_ACTIONS,
]);

/**
 * Actions that cannot run without the config store wired in. Same shape as the
 * NEEDS_IDEMPOTENCY_KEY/store check: configured-on with nothing behind it is a
 * typed refusal, never a 500.
 */
export const NEEDS_SETTINGS_STORE: ReadonlySet<string> = new Set(['settings.get', 'settings.set']);

/**
 * What a settings key may look like: the shape of an environment variable,
 * which is what every reader in `src/` was written against.
 *
 * This is NOT the security guard - `TWO_INTERNAL_FOO` matches this pattern
 * perfectly well. It is here so a typo lands as a typed `malformed` instead of
 * a row nothing will ever read. The guard is isStorableKey(), below.
 */
const SETTINGS_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;

/** Discord's own ceiling on a message is 2000; a setting has no reason to be larger. */
const MAX_SETTING_VALUE_BYTES = 8192;

/** Discord's own ceilings. Rejecting here beats a bare 400 from Discord. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_EVENT_NAME_CHARS = 100;
const MAX_EVENT_DESCRIPTION_CHARS = 1000;

/**
 * The slice of `SettingsStore` (src/core/settings.ts) these actions use.
 * `SettingsStore` satisfies it structurally; nothing here imports the class.
 */
export interface SettingsPort {
  /** The stored value, or undefined when the key has no row. Never reads env. */
  get(guildId: string, key: string): unknown;
  /** Write (or, for `null`, delete) one key, with the actor recorded. */
  set(guildId: string, key: string, value: unknown, actor: string): Promise<void>;
}

export interface ActionContext {
  guildId: string;
  discord: ActionDiscord;
  /**
   * The roles the website may assign, by key. A second allowlist inside the
   * first one: the website never names a Discord snowflake.
   */
  roleKeys: Map<string, string>;
  /**
   * The channels the website may post to, by key. Same reasoning as roleKeys,
   * and it starts EMPTY - there is no default announcement channel, so a fresh
   * deployment cannot post anywhere until an operator names one.
   */
  channelKeys: Map<string, string>;
  /**
   * Which of IMPLEMENTED_ACTIONS are live. guild.add_member stays out until
   * the CEO signs off on it (TOG-44) - the code is finished and tested, the
   * switch is theirs.
   */
  enabled: Set<string>;
  /** Durable state. Required by every action in NEEDS_IDEMPOTENCY_KEY. */
  store: InternalActionStore | null;
  /**
   * The config store (TOG-3100), narrowed to the two calls these actions make.
   *
   * A port rather than the SettingsStore class on purpose: this file must be
   * testable against a store that does NOT enforce the key rules, which is the
   * only way to prove the refusal below is enforced *here* and is not just the
   * store's refusal showing through. See test/unit.internalsettings.test.ts.
   */
  settings?: SettingsPort | null;
  /** Automations import/export service; absent means those verbs fail closed. */
  automations?: {
    importMee6(
      guildId: string,
      body: unknown,
      actorId: string,
      options?: { overwrite?: boolean; maxCommands?: number },
    ): Promise<{ imported: number; skipped: number; conflicts?: string[] }>;
    exportCommands(guildId: string): Promise<unknown[]>;
  } | null;
  /** Moderation lookups and execution. Present only when moderation actions are enabled. */
  moderation?: { resolver: ModerationResolver; service: ModerationService } | null;
  /** Destructive imports need a stronger, separately configured capability. */
  allowAutomationOverwrite?: boolean;
  /** Publish changed custom slash commands after a successful import. */
  syncCommands?: (() => Promise<number>) | null;
  /** The signed caller's idempotency key, supplied by server.ts. */
  idempotencyKey?: string | null;
  /**
   * Join attribution for guild.add_member (§7). The same instance the gateway
   * guildMemberAdd handler reads, which is why it is passed in rather than
   * constructed here. Optional: without it joins still land, filed `unknown`,
   * exactly as they did before this existed.
   */
  expectedJoins?: ExpectedJoins | null;
}

export interface ActionOutcome {
  result: Record<string, unknown>;
  /** For the log line. Never any part of the request body. */
  outcome: string;
  /** Inner moderation row supplied the stored result during outer recovery. */
  innerReplayed?: boolean;
}

/**
 * Build the role-key map: every role a member can already self-assign in
 * Discord, plus anything named explicitly in TWO_INTERNAL_ROLE_KEYS.
 *
 * Starting from the self-assignable set is the conservative default - it hands
 * the website no privilege a member does not already have by clicking a menu.
 */
export function buildRoleKeys(extraSpec = ''): Map<string, string> {
  const map = new Map<string, string>();
  for (const pick of ALL_PICKS) map.set(pick.key, pick.roleId);
  return addPairs(map, extraSpec, 'TWO_INTERNAL_ROLE_KEYS', 'role');
}

/**
 * Build the channel-key map from TWO_INTERNAL_CHANNEL_KEYS.
 *
 * Unlike roles there is no safe starting set to inherit: every channel the bot
 * can see is one it could post in, and "announcements" is not a channel we can
 * guess. So this starts empty and an unconfigured bot answers
 * `action_not_allowed` to every announcement.post - which is the correct
 * answer, not a gap.
 */
export function buildChannelKeys(spec = ''): Map<string, string> {
  return addPairs(new Map(), spec, 'TWO_INTERNAL_CHANNEL_KEYS', 'channel');
}

function addPairs(
  map: Map<string, string>,
  spec: string,
  envName: string,
  what: string,
): Map<string, string> {
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, id] = entry.split(':').map((s) => s.trim());
    if (!key || !/^\d{17,20}$/.test(id ?? '')) {
      throw new Error(`${envName} entries must be "${what}-key:<${what} snowflake>".`);
    }
    map.set(key, id);
  }
  return map;
}

export function isImplemented(action: string): action is ActionName {
  return (IMPLEMENTED_ACTIONS as readonly string[]).includes(action);
}

/**
 * Check the action is one we will run, before anything looks at the rest of
 * the body. Throws action_not_allowed, which is never retryable.
 */
export function assertAllowed(
  action: string,
  ctx: Pick<ActionContext, 'enabled' | 'store'> & Partial<Pick<ActionContext, 'settings'>>,
): asserts action is ActionName {
  if (!isImplemented(action)) {
    throw new ActionError('action_not_allowed', `"${action}" is not an allowlisted action`, {
      logReason: 'action_unknown',
    });
  }
  if (!ctx.enabled.has(action)) {
    throw new ActionError('action_not_allowed', `"${action}" is not enabled on this bot`, {
      logReason: 'action_disabled',
    });
  }
  // Configured on but with no database behind it. Only reachable if the
  // endpoint is started without a store, which src/index.ts does not do; a
  // typed refusal beats a 500 if that ever changes.
  if (NEEDS_IDEMPOTENCY_KEY.has(action) && !ctx.store) {
    throw new ActionError('action_not_allowed', `"${action}" needs the durable store`, {
      logReason: 'action_needs_store',
    });
  }
  if (NEEDS_SETTINGS_STORE.has(action) && !ctx.settings) {
    throw new ActionError('action_not_allowed', `"${action}" needs the config store`, {
      logReason: 'action_needs_settings',
    });
  }
}

export async function runAction(
  action: ActionName,
  body: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  switch (action) {
    case 'role.assign':
      return roleAssign(body, ctx);
    case 'guild.add_member':
      return guildAddMember(body, ctx);
    case 'announcement.post':
      return announcementPost(body, ctx);
    case 'event.upsert':
      return eventUpsert(body, ctx);
    case 'event.cancel':
      return eventCancel(body, ctx);
    case 'event.read':
      return eventRead(body, ctx);
    case 'automations.import':
      return automationsImport(body, ctx);
    case 'automations.export':
      return automationsExport(ctx);
    case 'settings.get':
      return settingsGet(body, ctx);
    case 'settings.set':
      return settingsSet(body, ctx);
    case 'moderation.ban':
    case 'moderation.tempban':
    case 'moderation.kick':
    case 'moderation.timeout':
    case 'moderation.warn':
    case 'moderation.purge':
    case 'moderation.slowmode':
    case 'moderation.lockdown':
    case 'moderation.unlock':
      if (!ctx.moderation || !ctx.idempotencyKey) {
        throw new ActionError('action_not_allowed', 'Moderation actions are not configured', {
          logReason: 'moderation_not_configured',
        });
      }
      return runModerationAction(action, body, {
        guildId: ctx.guildId,
        resolver: ctx.moderation.resolver,
        service: ctx.moderation.service,
        idempotencyKey: ctx.idempotencyKey,
      });
  }
}

/**
 * `role.assign` - naturally idempotent, because Discord no-ops a role the
 * member already holds.
 *
 * We read the member first so the website can tell "role added" from "you
 * already had this", which are different things to show a person. If that read
 * fails for any reason we go straight to the write: a redundant PUT is
 * harmless, and refusing to assign a role because we could not read a member
 * would be the wrong trade.
 */
async function roleAssign(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const discordId = requireSnowflake(body, 'discord_id');
  const roleKey = requireString(body, 'role_key');

  const roleId = ctx.roleKeys.get(roleKey);
  if (!roleId) {
    throw new ActionError('action_not_allowed', `"${roleKey}" is not an assignable role key`, {
      logReason: 'role_key_unknown',
    });
  }

  let held: string[] | null = null;
  try {
    held = await ctx.discord.memberRoles(ctx.guildId, discordId);
  } catch {
    held = null;
  }
  if (held?.includes(roleId)) {
    return { result: { outcome: 'already_held' }, outcome: 'already_held' };
  }

  await ctx.discord.addRole(ctx.guildId, discordId, roleId);
  return { result: { outcome: 'assigned' }, outcome: 'assigned' };
}

/**
 * `guild.add_member` - the one action that recruits members. Naturally
 * idempotent: Discord answers 204 if the person is already in.
 *
 * `access_token` is read straight out of the parsed body into a local and
 * handed to one function. It is never copied into the log fields, never
 * returned in the result, and there is nowhere in the audit record for it to
 * go. A test asserts it appears in no log line, including on a thrown error.
 */
async function guildAddMember(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const discordId = requireSnowflake(body, 'discord_id');
  const accessToken = requireString(body, 'access_token');

  // The note goes down BEFORE the Discord call: the gateway can deliver
  // guildMemberAdd before the REST response returns, and a note taken after
  // would miss exactly the joins it exists to attribute (§7). If the call
  // fails, nobody joins and the note expires unread.
  ctx.expectedJoins?.expect(ctx.guildId, discordId, WEB_ONE_CLICK_SOURCE);

  const outcome = await ctx.discord.addMember(ctx.guildId, discordId, accessToken);
  return { result: { outcome }, outcome };
}

/**
 * `announcement.post` - the first action where a repeat is not harmless.
 *
 * Nothing here guards against a double post, and that is correct: the guard is
 * the idempotency key, applied in server.ts before this function is reached.
 * Two layers of half-protection would be harder to reason about than one that
 * is either on or off.
 *
 * The message id comes back in the result so a retry that replays the stored
 * result still tells the website *which* message it has.
 */
async function announcementPost(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const channelId = requireChannel(body, ctx);
  const content = requireString(body, 'body');
  if (content.length > MAX_MESSAGE_CHARS) {
    throw new ActionError('malformed', `"body" is longer than ${MAX_MESSAGE_CHARS} characters`, {
      logReason: 'body_too_long',
    });
  }

  const messageId = await ctx.discord.postMessage(channelId, content);
  return { result: { outcome: 'posted', message_id: messageId }, outcome: 'posted' };
}

/**
 * `event.upsert` - create once, modify thereafter.
 *
 * The website owns a stable `event_key`; we keep `event_key ->
 * discord_event_id` in internal_discord_events. That mapping is what makes the
 * *second* call an update rather than a duplicate event, and it is a different
 * guarantee from the idempotency key: the key makes a retry of one request
 * safe, the mapping makes a deliberate edit next week land on the same event.
 */
async function eventUpsert(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const store = ctx.store;
  if (!store) {
    throw new ActionError('internal', 'The durable store is not available', {
      logReason: 'store_missing',
    });
  }

  const eventKey = requireString(body, 'event_key');
  const input = readEventInput(body, ctx);

  const existing = await store.discordEventId(ctx.guildId, eventKey);
  if (existing) {
    await ctx.discord.updateEvent(ctx.guildId, existing, input);
    return { result: { outcome: 'updated', event_id: existing }, outcome: 'updated' };
  }

  const eventId = await ctx.discord.createEvent(ctx.guildId, input);
  // Written after Discord confirms, so a failed create leaves no mapping and
  // the next call is another create rather than an update of nothing.
  await store.rememberDiscordEvent(ctx.guildId, eventKey, eventId);
  return { result: { outcome: 'created', event_id: eventId }, outcome: 'created' };
}

/** Cancel only events this endpoint created; never accept a raw Discord id. */
async function eventCancel(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const store = ctx.store;
  if (!store) {
    throw new ActionError('internal', 'The durable store is not available', {
      logReason: 'store_missing',
    });
  }
  const eventKey = requireString(body, 'event_key');
  const eventId = await store.discordEventId(ctx.guildId, eventKey);
  if (!eventId) {
    throw new ActionError('action_not_allowed', 'No event is mapped to this key in this guild', {
      logReason: 'event_key_unknown',
    });
  }
  await ctx.discord.cancelEvent(ctx.guildId, eventId);
  // Retain the mapping: a late edit must not recreate a cancelled event. The
  // server's durable idempotency result handles retries of this cancellation.
  return { result: { outcome: 'cancelled', event_id: eventId }, outcome: 'cancelled' };
}

/**
 * `event.read` - the narrow mapped-event verifier (TOG-5510, Gate 2 scope).
 *
 * Given the website's `event_key`, answer with the Discord mirror this
 * endpoint mapped for it: id, name, start, location, lifecycle, and when we
 * looked. Unknown keys refuse with `action_not_allowed` before any Discord
 * call, so the key map is the whole address space - there is no field for a
 * raw Discord id and no room for a predicate, listing, attendees or member
 * data.
 *
 * Naturally read-only: a repeat changes nothing, so no `Idempotency-Key` is
 * required (same posture as `settings.get` and `automations.export`). The
 * mapping is deliberately NOT consulted beyond lookup - a 404 from Discord
 * (mirror deleted out-of-band) surfaces as `discord_rejected` and keeps the
 * mapping, because terminal state belongs to `event.cancel`, not to the read.
 */
async function eventRead(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const store = ctx.store;
  if (!store) {
    throw new ActionError('internal', 'The durable store is not available', {
      logReason: 'store_missing',
    });
  }
  const eventKey = requireString(body, 'event_key');
  const eventId = await store.discordEventId(ctx.guildId, eventKey);
  if (!eventId) {
    throw new ActionError('action_not_allowed', 'No event is mapped to this key in this guild', {
      logReason: 'event_key_unknown',
    });
  }
  const mirror = await ctx.discord.readEvent(ctx.guildId, eventId);
  return {
    result: {
      outcome: 'read',
      event_id: mirror.eventId,
      name: mirror.name,
      starts_at: mirror.startsAt,
      location: mirror.location,
      status: mirror.status,
      observed_at: mirror.observedAt,
    },
    outcome: 'read',
  };
}

function readEventInput(body: Record<string, unknown>, ctx: ActionContext): ScheduledEventInput {
  const name = requireString(body, 'name');
  if (name.length > MAX_EVENT_NAME_CHARS) {
    throw new ActionError('malformed', `"name" is longer than ${MAX_EVENT_NAME_CHARS} characters`, {
      logReason: 'name_too_long',
    });
  }

  const startsAt = requireTimestamp(body, 'starts_at');
  const endsAt = requireTimestamp(body, 'ends_at');
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new ActionError('malformed', '"ends_at" must be after "starts_at"', {
      logReason: 'ends_before_starts',
    });
  }

  const description = optionalString(body, 'description');
  if (description && description.length > MAX_EVENT_DESCRIPTION_CHARS) {
    throw new ActionError('malformed', `"description" is longer than ${MAX_EVENT_DESCRIPTION_CHARS} characters`, {
      logReason: 'description_too_long',
    });
  }

  // Discord takes an event in a voice channel OR an external one with a place
  // written on it, never both and never neither. Deciding here means the
  // caller gets a typed error naming the field instead of Discord's bare 400.
  const hasChannel = body.channel_key !== undefined;
  const hasLocation = body.location !== undefined;
  if (hasChannel === hasLocation) {
    throw new ActionError('malformed', 'Send exactly one of "channel_key" or "location"', {
      logReason: 'event_place_ambiguous',
    });
  }

  return hasChannel
    ? { name, startsAt, endsAt, description, channelId: requireChannel(body, ctx) }
    : { name, startsAt, endsAt, description, location: requireString(body, 'location') };
}

/** Resolve `channel_key` through the allowlist. Never a raw snowflake. */
function requireChannel(body: Record<string, unknown>, ctx: ActionContext): string {
  const channelKey = requireString(body, 'channel_key');
  const channelId = ctx.channelKeys.get(channelKey);
  if (!channelId) {
    throw new ActionError('action_not_allowed', `"${channelKey}" is not a postable channel key`, {
      logReason: 'channel_key_unknown',
    });
  }
  return channelId;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ActionError('malformed', `"${field}" must be a non-empty string`, {
      logReason: `missing_${field}`,
    });
  }
  return v;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  return requireString(body, field);
}

function requireSnowflake(body: Record<string, unknown>, field: string): string {
  const v = requireString(body, field);
  if (!/^\d{17,20}$/.test(v)) {
    throw new ActionError('malformed', `"${field}" must be a Discord id`, {
      logReason: `bad_${field}`,
    });
  }
  return v;
}

/**
 * An ISO-8601 instant, normalised to what Discord wants.
 *
 * Accepting only strings Date.parse understands AND re-emitting our own
 * formatting means a caller cannot smuggle a subtly different timestamp past
 * us, and the value stored in the request hash is the one we sent.
 */
function requireTimestamp(body: Record<string, unknown>, field: string): string {
  const v = requireString(body, field);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new ActionError('malformed', `"${field}" must be an ISO-8601 timestamp`, {
      logReason: `bad_${field}`,
    });
  }
  return new Date(ms).toISOString();
}

/**
 * `automations.import` (TOG-1648): translate an MEE6 custom-command export
 * into Owen command definitions. It requires the shared durable
 * Idempotency-Key path: a retry must replay one stored result, while a caller
 * deliberately importing changed content uses a fresh key.
 *
 * The request body holds admin-authored templates only. It is the one
 * internal-action body where storing a hash is slightly awkward (the useful
 * diff is the content), and the answer is the same as everywhere else: we
 * hash it, we do not keep it.
 */
async function automationsImport(
  body: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  if (!ctx.automations) {
    throw new ActionError('action_not_allowed', '"automations.import" is not wired on this bot', {
      logReason: 'automations_not_wired',
    });
  }
  if (!ctx.syncCommands) {
    throw new ActionError('action_not_allowed', 'Automation command sync is not wired on this bot', {
      logReason: 'automations_sync_not_wired',
    });
  }
  const commands = body.commands;
  if (!Array.isArray(commands)) {
    throw new ActionError('malformed', '"commands" must be an array of MEE6 command objects', {
      logReason: 'missing_commands',
    });
  }
  if (commands.length > MAX_CUSTOM_COMMANDS) {
    throw new ActionError('malformed', `"commands" may contain at most ${MAX_CUSTOM_COMMANDS} entries`, {
      logReason: 'too_many_commands',
    });
  }
  const overwrite = body.overwrite === true;
  if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
    throw new ActionError('malformed', '"overwrite" must be a boolean', {
      logReason: 'bad_overwrite',
    });
  }
  if (overwrite && !ctx.allowAutomationOverwrite) {
    throw new ActionError('action_not_allowed', 'Destructive automation imports are not enabled on this bot', {
      logReason: 'automations_overwrite_disabled',
    });
  }
  let result: Awaited<ReturnType<NonNullable<ActionContext['automations']>['importMee6']>>;
  try {
    result = await ctx.automations.importMee6(
      ctx.guildId,
      commands,
      'internal:automations.import',
      { overwrite, maxCommands: MAX_CUSTOM_COMMANDS },
    );
  } catch (error) {
    if (error instanceof CommandCapacityError) {
      throw new ActionError('malformed', error.message, { logReason: 'command_capacity_exceeded' });
    }
    throw error;
  }
  let published: number | null = null;
  if (result.imported > 0) published = await ctx.syncCommands();
  return {
    result: {
      imported: result.imported,
      skipped: result.skipped,
      conflicts: result.conflicts ?? [],
      published,
    },
    outcome: `imported ${result.imported}, skipped ${result.skipped}, published ${published ?? 0}`,
  };
}

/**
 * `automations.export` (TOG-1648): the reverse - every command definition as
 * an MEE6-shaped array, so a migration off MEE6 is reversible and auditable.
 */
async function automationsExport(ctx: ActionContext): Promise<ActionOutcome> {
  if (!ctx.automations) {
    throw new ActionError('action_not_allowed', '"automations.export" is not wired on this bot', {
      logReason: 'automations_not_wired',
    });
  }
  const commands = await ctx.automations.exportCommands(ctx.guildId);
  return {
    result: { commands },
    outcome: `exported ${commands.length}`,
  };
}

/**
 * The key guard for both settings actions (TOG-3101, TOG-3093 ADR §2.4).
 *
 * Since TOG-3100 the rule is catalog membership, not a prefix: a key is
 * writable if `src/core/settingsCatalog.ts` classes it `hot` or `cold`, and
 * refused otherwise. That is fail-closed - a name nobody has classified is
 * refused rather than allowed - which is what closes TOG-3183, where
 * `TWO_MODERATION` co-gated nine moderation verbs while carrying no
 * `TWO_INTERNAL_` prefix and so passed the old namespace test.
 *
 * `src/core/settings.ts` refuses the same set, and migrations
 * 0026_guild_settings.sql and 0027_guild_settings_env_only.sql refuse it again
 * with two CHECK constraints.
 * That repetition is deliberate, and this copy is the one that matters most,
 * because it is the only one that runs before an attacker-supplied key reaches
 * any of our code that writes.
 *
 * The property being defended is the first paragraph of this file: an attacker
 * holding the website's key can do exactly what is on the allowlist and
 * nothing else. `TWO_INTERNAL_ALLOW_*` are the switches that decide what is on
 * that allowlist, and `TWO_INTERNAL_KEYS` is the signing secret itself. An
 * action that could set - or read - one of those turns a website compromise
 * into a bot compromise.
 */
function requireSettingsKey(body: Record<string, unknown>, action: string): string {
  const key = requireString(body, 'key');
  if (!SETTINGS_KEY_PATTERN.test(key)) {
    throw new ActionError('malformed', '"key" must look like an environment variable name', {
      logReason: 'settings_key_malformed',
    });
  }
  if (!isStorableKey(key)) {
    // Both refusals are absolute, but they are not the same answer and the
    // dashboard should not conflate them. "Environment-only" is a policy
    // decision about a key we do classify. An unclassified key is almost
    // always a typo, and telling that admin it is "environment-only" sends
    // them to argue with a policy document about a key that does not exist.
    const declared = isDeclaredEnvOnly(key);
    throw new ActionError(
      'action_not_allowed',
      declared
        ? `"${key}" is environment-only and cannot be reached by "${action}"`
        : `"${key}" is not a setting this bot reads, so "${action}" will not reach it`,
      { logReason: declared ? 'settings_key_env_only' : 'settings_key_unknown' },
    );
  }
  return key;
}

/**
 * `settings.get` - read one configured key. Naturally idempotent; no key needed.
 *
 * It answers from the config store and **only** from the config store. It does
 * not fall through to `process.env`, even though `loadConfig()` does, and that
 * asymmetry is the point: the environment holds `DISCORD_TOKEN`,
 * `DATABASE_URL` and `TWO_INTERNAL_KEYS`, so a read-through would turn the
 * first settings verb into a credential exfiltration primitive. An unset key
 * answers `source: "unset"`, which is what the dashboard needs to show "still
 * coming from the environment" without being told what the value is.
 */
async function settingsGet(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const settings = ctx.settings;
  if (!settings) {
    throw new ActionError('internal', 'The config store is not available', {
      logReason: 'settings_store_missing',
    });
  }

  const key = requireSettingsKey(body, 'settings.get');
  const value = settings.get(ctx.guildId, key);
  const source = value === undefined ? 'unset' : 'store';
  return {
    result: { key, value: value === undefined ? null : value, source },
    // The key, never the value: this line goes to our structured log and a
    // setting can hold a webhook URL or an invite code.
    outcome: `read ${key} (${source})`,
  };
}

/**
 * `settings.set` - write one configured key, or delete it with `value: null`.
 *
 * `updated_by` is the Discord user id of the admin who clicked save. The
 * caller passes it and we record it; the bot never infers it, because the only
 * thing the bot could infer is "the website", which is exactly the attribution
 * an audit trail is useless without.
 *
 * A repeat is NOT harmless (see NEEDS_IDEMPOTENCY_KEY), so server.ts has
 * already taken the idempotency claim by the time this runs. Nothing here
 * re-implements that guard - same reasoning as announcement.post.
 */
async function settingsSet(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
  const settings = ctx.settings;
  if (!settings) {
    throw new ActionError('internal', 'The config store is not available', {
      logReason: 'settings_store_missing',
    });
  }

  const key = requireSettingsKey(body, 'settings.set');
  const updatedBy = requireSnowflake(body, 'updated_by');

  if (!('value' in body)) {
    throw new ActionError('malformed', '"value" is required; send null to unset the key', {
      logReason: 'missing_value',
    });
  }
  const value = body.value ?? null;
  if (value !== null) {
    // Cheap ceiling on what one setting may weigh. A dashboard field that
    // needs more than this is not a setting, and the cap keeps one signed
    // request from filling the table.
    const encoded = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
    if (encoded > MAX_SETTING_VALUE_BYTES) {
      throw new ActionError('malformed', `"value" is larger than ${MAX_SETTING_VALUE_BYTES} bytes`, {
        logReason: 'settings_value_too_large',
      });
    }
  }

  await settings.set(ctx.guildId, key, value, updatedBy);

  const outcome = value === null ? 'unset' : 'saved';
  // No value in the result either. The website already knows what it sent, and
  // the result is what gets stored against the idempotency key and replayed.
  return { result: { key, outcome }, outcome: `${outcome} ${key}` };
}
