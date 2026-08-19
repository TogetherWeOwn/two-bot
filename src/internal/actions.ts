/**
 * The allowlist. docs/INTERNAL_ACTIONS.md §3.
 *
 * This file is the whole authorisation model. An attacker holding the
 * website's shared secret can do exactly what is listed here and nothing
 * else - there is no verb for reading the guild, kicking, banning or changing
 * permissions, so there is nothing to escalate to.
 *
 * Two actions ship in this slice (TWO-59), both naturally idempotent, because
 * neither needs the durable idempotency-key store that waits on Postgres.
 * announcement.post and event.upsert are approved but not built yet; they are
 * named here so the website gets a typed refusal instead of a 500.
 */
import { ActionError } from './errors.ts';
import type { ActionDiscord } from './discordActions.ts';
import { ALL_PICKS } from '../onboarding/catalog.ts';

export const IMPLEMENTED_ACTIONS = ['role.assign', 'guild.add_member'] as const;
export type ActionName = (typeof IMPLEMENTED_ACTIONS)[number];

/** Approved in the spec, waiting on the durable store (TWO-18 -> TWO-24). */
export const PENDING_STORE_ACTIONS = ['announcement.post', 'event.upsert'];

export interface ActionContext {
  guildId: string;
  discord: ActionDiscord;
  /**
   * The roles the website may assign, by key. A second allowlist inside the
   * first one: the website never names a Discord snowflake.
   */
  roleKeys: Map<string, string>;
  /**
   * Which of IMPLEMENTED_ACTIONS are live. guild.add_member stays out until
   * the CEO signs off on it (TWO-24) - the code is finished and tested, the
   * switch is theirs.
   */
  enabled: Set<string>;
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
  for (const entry of extraSpec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, roleId] = entry.split(':').map((s) => s.trim());
    if (!key || !/^\d{17,20}$/.test(roleId ?? '')) {
      throw new Error('TWO_INTERNAL_ROLE_KEYS entries must be "role-key:<role snowflake>".');
    }
    map.set(key, roleId);
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
export function assertAllowed(action: string, enabled: Set<string>): asserts action is ActionName {
  if (isImplemented(action) && enabled.has(action)) return;

  if (PENDING_STORE_ACTIONS.includes(action)) {
    throw new ActionError('action_not_allowed', `"${action}" is not available yet on this bot`, {
      logReason: 'action_pending_store',
    });
  }
  if (isImplemented(action)) {
    throw new ActionError('action_not_allowed', `"${action}" is not enabled on this bot`, {
      logReason: 'action_disabled',
    });
  }
  throw new ActionError('action_not_allowed', `"${action}" is not an allowlisted action`, {
    logReason: 'action_unknown',
  });
}

export async function runAction(
  action: ActionName,
  body: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  if (action === 'role.assign') return roleAssign(body, ctx);
  return guildAddMember(body, ctx);
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

  const outcome = await ctx.discord.addMember(ctx.guildId, discordId, accessToken);
  return { result: { outcome }, outcome };
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

function requireSnowflake(body: Record<string, unknown>, field: string): string {
  const v = requireString(body, field);
  if (!/^\d{17,20}$/.test(v)) {
    throw new ActionError('malformed', `"${field}" must be a Discord id`, {
      logReason: `bad_${field}`,
    });
  }
  return v;
}
