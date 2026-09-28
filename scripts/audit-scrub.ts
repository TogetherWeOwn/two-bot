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
 * Pure function, no network, no Discord token. Safe to import from tests:
 * importing this module has no side effects (unlike `audit-collect.ts`,
 * which starts collecting on import).
 */
export function stripUsers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUsers);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isUser =
        (k === 'user' || k === 'inviter' || k === 'target_user' || k === 'bot') &&
        v &&
        typeof v === 'object';
      out[k] = isUser ? { id: (v as { id?: string }).id ?? null } : stripUsers(v);
    }
    return out;
  }
  return value;
}
