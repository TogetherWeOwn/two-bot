import { planSelfRoleChange } from './plan.ts';
import type { SelfRolePanel } from './types.ts';

/**
 * Prove a panel grants its role to a disposable fixture member and revokes it
 * again, using the same role planner the live dispatch runs
 * (`planSelfRoleChange` in `./plan.ts`, also used by `recomputeDelta` in
 * `src/discord/selfRoles.ts`).
 *
 * Pure in-memory role set: no Discord call, no guild lookup, no live guild
 * role touched. The member id is a fixture constant, never resolved against
 * any guild. Returns the proof lines for the dry-run output; throws on any
 * failure so the caller fails closed.
 */
export function proveGrantRevoke(panel: SelfRolePanel): string[] {
  const option = panel.options[0];
  if (!option) throw new Error(`panel "${panel.id}" has no options to prove`);
  const memberId = '100000000000000001'; // disposable fixture member, never a guild lookup
  const held = new Set<string>();
  const lines: string[] = [];

  const grant = planSelfRoleChange({
    panel,
    optionKey: option.key,
    memberRoleIds: [...held],
    source: panel.mode,
    remove: false,
  });
  if (!grant.ok) throw new Error(`grant plan failed: ${grant.reason}`);
  if (!grant.addRoleIds.includes(option.roleId)) {
    throw new Error(`grant plan for option "${option.key}" adds nothing (outcome ${grant.outcome})`);
  }
  for (const roleId of grant.removeRoleIds) held.delete(roleId);
  for (const roleId of grant.addRoleIds) held.add(roleId);
  if (!held.has(option.roleId)) {
    throw new Error(`grant did not take: role ${option.roleId} absent after applying the delta`);
  }
  lines.push(`grant: disposable member ${memberId} now holds role ${option.roleId} ("${option.label}")`);

  const revoke = planSelfRoleChange({
    panel,
    optionKey: option.key,
    memberRoleIds: [...held],
    source: panel.mode,
    remove: true,
  });
  if (!revoke.ok) throw new Error(`revoke plan failed: ${revoke.reason}`);
  if (!revoke.removeRoleIds.includes(option.roleId)) {
    throw new Error(`revoke plan for option "${option.key}" removes nothing (outcome ${revoke.outcome})`);
  }
  for (const roleId of revoke.removeRoleIds) held.delete(roleId);
  for (const roleId of revoke.addRoleIds) held.add(roleId);
  if (held.has(option.roleId)) {
    throw new Error(`revoke did not clear: role ${option.roleId} still held after applying the delta`);
  }
  lines.push(`revoke: disposable member ${memberId} no longer holds role ${option.roleId}`);
  return lines;
}
