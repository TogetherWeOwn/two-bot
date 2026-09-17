/**
 * Config for the internal actions endpoint.
 *
 * Read straight from the environment rather than through src/core/config.ts,
 * because the endpoint is optional: a bot with none of these variables set
 * runs exactly as it does today, with no listener and no open port. Off is the
 * default, and turning it on is a deliberate act.
 *
 * | Variable | Meaning |
 * |---|---|
 * | `TWO_INTERNAL_ACTIONS` | `1` to run the listener at all. |
 * | `TWO_INTERNAL_BIND_HOST` | Private address or DNS name to bind; `private` discovers a private container NIC. Default `127.0.0.1`. Public/wildcard binds refuse to start. |
 * | `TWO_INTERNAL_PORT` | Default `8787`. |
 * | `TWO_INTERNAL_KEYS` | `key-id:secret,key-id:secret`. A real secret - see docs/SECRETS.md. In production it arrives as the systemd credential `internal_keys` instead. |
 * | `TWO_INTERNAL_ROLE_KEYS` | Extra `role-key:snowflake` pairs beyond the self-assignable set. |
 * | `TWO_INTERNAL_CHANNEL_KEYS` | `channel-key:snowflake` pairs. Empty by default, and `announcement.post` can address nothing without it. |
 * | `TWO_INTERNAL_ALLOW_ADD_MEMBER` | `1` to enable `guild.add_member`. **Requires the CEO's sign-off (TOG-44).** |
 * | `TWO_INTERNAL_ALLOW_AUTOMATIONS` | `1` to enable non-destructive `automations.import` and `automations.export`. Default off pending allowlist approval. |
 * | `TWO_INTERNAL_ALLOW_AUTOMATIONS_OVERWRITE` | `1` to permit destructive imports. Requires the base automations flag too. |
 * | `TWO_INTERNAL_ALLOW_SETTINGS` | `1` to enable `settings.get` and `settings.set`. Default off pending the CEO's allowlist sign-off (TOG-3101). |
 *
 * Every `TWO_INTERNAL_*` variable on this page is read from the environment
 * and from nowhere else. They are not settings and they must never become
 * settings: they are the switches that decide what the *website* may make the
 * bot do, so a website that could change them could grant itself the rest of
 * the allowlist. `settings.set` refuses the whole namespace - in the handler
 * (src/internal/actions.ts), in the store (src/core/settings.ts), and in the
 * schema (migrations/0026_guild_settings.sql).
 */
import { parseKeys, type SigningKey } from './signing.ts';
import { buildRoleKeys, buildChannelKeys, type ActionName } from './actions.ts';
import { readSecret, credentialSource } from '../core/credentials.ts';

export interface InternalActionsConfig {
  host: string;
  port: number;
  keys: SigningKey[];
  roleKeys: Map<string, string>;
  channelKeys: Map<string, string>;
  enabled: Set<ActionName>;
  allowAutomationOverwrite: boolean;
}

/** Null when the endpoint is switched off, which is the default. */
export function loadInternalActionsConfig(env: NodeJS.ProcessEnv = process.env): InternalActionsConfig | null {
  if (env.TWO_INTERNAL_ACTIONS !== '1') return null;

  const keys = parseKeys(
    readSecret('internal_keys', ['TWO_INTERNAL_KEYS'], credentialSource(env)) ?? '',
  );
  if (keys.length === 0) {
    throw new Error(
      'TWO_INTERNAL_ACTIONS=1 but no signing keys. Provide the systemd credential ' +
        '`internal_keys`, or set TWO_INTERNAL_KEYS. See docs/SECRETS.md.',
    );
  }

  // The three Phase 1 actions are approved and unconditional - they are what
  // the endpoint was asked for. guild.add_member is built and tested but stays
  // dark until the CEO signs off on the allowlist entry; the flag is the
  // record of that decision, not a convenience.
  //
  // announcement.post being on is not the same as it being able to do
  // anything: with no TWO_INTERNAL_CHANNEL_KEYS there is no channel it may
  // address, so an unconfigured bot refuses every post by key lookup.
  const enabled = new Set<ActionName>(['role.assign', 'announcement.post', 'event.upsert']);
  if (env.TWO_INTERNAL_ALLOW_ADD_MEMBER === '1') enabled.add('guild.add_member');
  // These verbs widen the website key's fixed allowlist, so merely shipping the
  // implementation must not enable them. The flag is the approval record and
  // defaults off. Destructive overwrite is checked separately at action time.
  if (env.TWO_INTERNAL_ALLOW_AUTOMATIONS === '1') {
    enabled.add('automations.import');
    enabled.add('automations.export');
  }
  // The admin dashboard's read and write path (TOG-3093 slice 2). Same
  // arrangement as the two above and for the same reason: shipping the
  // implementation must not widen the allowlist. The flag is the record of the
  // CEO's sign-off, not a convenience, and it defaults off.
  if (env.TWO_INTERNAL_ALLOW_SETTINGS === '1') {
    enabled.add('settings.get');
    enabled.add('settings.set');
  }
  if (env.TWO_INTERNAL_ALLOW_MODERATION === '1' && env.TWO_MODERATION === '1') {
    for (const action of [
      'moderation.ban',
      'moderation.tempban',
      'moderation.kick',
      'moderation.timeout',
      'moderation.warn',
      'moderation.purge',
      'moderation.slowmode',
      'moderation.lockdown',
      'moderation.unlock',
    ] as const) enabled.add(action);
  }

  return {
    host: env.TWO_INTERNAL_BIND_HOST || '127.0.0.1',
    port: Number(env.TWO_INTERNAL_PORT ?? 8787),
    keys,
    roleKeys: buildRoleKeys(env.TWO_INTERNAL_ROLE_KEYS ?? ''),
    channelKeys: buildChannelKeys(env.TWO_INTERNAL_CHANNEL_KEYS ?? ''),
    enabled,
    allowAutomationOverwrite:
      env.TWO_INTERNAL_ALLOW_AUTOMATIONS === '1' &&
      env.TWO_INTERNAL_ALLOW_AUTOMATIONS_OVERWRITE === '1',
  };
}
