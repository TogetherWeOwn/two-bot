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
 * | `TWO_INTERNAL_KEYS` | `key-id:secret,key-id:secret`. A real secret - see docs/SECRETS.md. |
 * | `TWO_INTERNAL_ROLE_KEYS` | Extra `role-key:snowflake` pairs beyond the self-assignable set. |
 * | `TWO_INTERNAL_ALLOW_ADD_MEMBER` | `1` to enable `guild.add_member`. **Requires the CEO's sign-off (TWO-24).** |
 */
import { parseKeys, type SigningKey } from './signing.ts';
import { buildRoleKeys, type ActionName } from './actions.ts';

export interface InternalActionsConfig {
  host: string;
  port: number;
  keys: SigningKey[];
  roleKeys: Map<string, string>;
  enabled: Set<ActionName>;
}

/** Null when the endpoint is switched off, which is the default. */
export function loadInternalActionsConfig(env: NodeJS.ProcessEnv = process.env): InternalActionsConfig | null {
  if (env.TWO_INTERNAL_ACTIONS !== '1') return null;

  const keys = parseKeys(env.TWO_INTERNAL_KEYS ?? '');
  if (keys.length === 0) {
    throw new Error('TWO_INTERNAL_ACTIONS=1 but TWO_INTERNAL_KEYS is empty. See docs/SECRETS.md.');
  }

  // role.assign is approved and unconditional. guild.add_member is built and
  // tested but stays dark until the CEO signs off on the allowlist entry - the
  // flag is the record of that decision, not a convenience.
  const enabled = new Set<ActionName>(['role.assign']);
  if (env.TWO_INTERNAL_ALLOW_ADD_MEMBER === '1') enabled.add('guild.add_member');

  return {
    host: env.TWO_INTERNAL_BIND_HOST || '127.0.0.1',
    port: Number(env.TWO_INTERNAL_PORT ?? 8787),
    keys,
    roleKeys: buildRoleKeys(env.TWO_INTERNAL_ROLE_KEYS ?? ''),
    enabled,
  };
}
