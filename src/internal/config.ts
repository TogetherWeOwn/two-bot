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
 * | `TWO_INTERNAL_BIND_HOST` | Private address to bind. Default `127.0.0.1`. A public address refuses to start. |
 * | `TWO_INTERNAL_PORT` | Default `8787`. |
 * | `TWO_INTERNAL_KEYS` | `key-id:secret,key-id:secret`. A real secret - see docs/SECRETS.md. In production it arrives as the systemd credential `internal_keys` instead. |
 * | `TWO_INTERNAL_ROLE_KEYS` | Extra `role-key:snowflake` pairs beyond the self-assignable set. |
 * | `TWO_INTERNAL_CHANNEL_KEYS` | `channel-key:snowflake` pairs. Empty by default, and `announcement.post` can address nothing without it. |
 * | `TWO_INTERNAL_ALLOW_ADD_MEMBER` | `1` to enable `guild.add_member`. **Requires the CEO's sign-off (TOG-44).** |
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
  };
}
