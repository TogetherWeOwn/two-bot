/**
 * PII scrubber for the server-audit collector (`scripts/audit-collect.ts`).
 *
 * WHY THIS EXISTS (TOG-7216). Discord attaches whole user objects to invites
 * and integrations. We need the id to attribute an invite; we do not need
 * anyone's username or avatar in the repo. The collector's original scrubber
 * covered `user` / `inviter` / `target_user` but missed
 * `integrations[].application.bot` - a full user object (username,
 * global_name, avatar, discriminator, banner) that landed verbatim in
 * `audit/raw/integrations.json` and was removed from HEAD with the rest of
 * the raw dumps by TOG-8963. This module is the single place the
 * rule lives, so the next embedded-user shape is fixed once, here.
 *
 * Pure function, no network, no Discord token. Safe to import from tests:
 * importing this module has no side effects (unlike `audit-collect.ts`,
 * which starts collecting on import).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // TOG-8694: registry entry boots offline on --help. Read argv before
  // anything else so --help needs no token, no DB, no network. Any other
  // invocation is a usage error: this module exports stripUsers for
  // audit-collect.ts; it takes no input of its own.
  if (process.argv.slice(2).includes('--help')) {
    console.log('usage: node scripts/audit-scrub.ts --help');
    console.log('');
    console.log('PII scrubber for the server-audit collector (scripts/audit-collect.ts).');
    console.log('Exports stripUsers, which reduces embedded Discord user objects');
    console.log('(user / inviter / target_user / bot) to { id }. Imported by the');
    console.log('collector; running this file directly only prints this help.');
    process.exit(0);
  }
  console.error('usage: node scripts/audit-scrub.ts --help');
  console.error('audit-scrub is a library: import { stripUsers } from ./audit-scrub.ts.');
  process.exit(2);
}
