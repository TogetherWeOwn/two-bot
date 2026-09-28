/**
 * PII scrubber for the server-audit collector (`scripts/audit-collect.ts`).
 *
 * WHY THIS EXISTS (TOG-7216). Discord attaches whole user objects to invites
 * and integrations. We need the id to attribute an invite; we do not need
 * anyone's username or avatar in the repo. The collector's original scrubber
 * covered `user` / `inviter` / `target_user` but missed
 * `integrations[].application.bot` - a full user object (username,
 * global_name, avatar, discriminator, banner) that landed verbatim in the
 * tracked `audit/raw/integrations.json`. This module is the single place the
 * rule lives, so the next embedded-user shape is fixed once, here.
 *
 * KEY COVERAGE (TOG-8300). Every Discord user-object key on a collected
 * endpoint maps to the same rule - object value reduced to `{ id }`:
 * - `inviter`, `target_user` (invites; target_user appears on
 *   target_type=1 stream invites and inside embedded guild_scheduled_events)
 * - `user` (integrations, guild/preview emoji + sticker uploaders)
 * - `bot` (integrations[].application.bot; boolean `bot: true` flags pass
 *   through because only object values are stripped)
 * - `creator` (scheduled events; also nested inside invites' embedded
 *   guild_scheduled_event)
 * Deliberately NOT stripped: bare snowflakes (`owner_id`, `creator_id`,
 * invite `channel`/`guild` ids - ids alone are attribution, not identity),
 * `integrations[].account.name` (service display name the audit needs; pinned
 * by test), server-level hashes (`guild.banner`), and aggregate counts.
 *
 * Pure function, no network, no Discord token. Safe to import from tests:
 * importing this module has no side effects (unlike `audit-collect.ts`,
 * which starts collecting on import).
 */
export const SCRUBBED_USER_KEYS = ['user', 'inviter', 'target_user', 'bot', 'creator'] as const;

export function stripUsers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUsers);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isUser =
        (SCRUBBED_USER_KEYS as readonly string[]).includes(k) && v && typeof v === 'object';
      out[k] = isUser ? { id: (v as { id?: string }).id ?? null } : stripUsers(v);
    }
    return out;
  }
  return value;
}
