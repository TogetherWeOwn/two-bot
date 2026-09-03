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
import { WEB_ONE_CLICK_SOURCE, type ExpectedJoins } from '../core/expectedJoins.ts';
import { ALL_PICKS } from '../onboarding/catalog.ts';

export const IMPLEMENTED_ACTIONS = [
  'role.assign',
  'guild.add_member',
  'announcement.post',
  'event.upsert',
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
]);

/** Discord's own ceilings. Rejecting here beats a bare 400 from Discord. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_EVENT_NAME_CHARS = 100;
const MAX_EVENT_DESCRIPTION_CHARS = 1000;

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
export function assertAllowed(action: string, ctx: Pick<ActionContext, 'enabled' | 'store'>): asserts action is ActionName {
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
