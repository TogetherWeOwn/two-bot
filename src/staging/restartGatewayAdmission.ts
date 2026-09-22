/**
 * UNWIRED staging identity/event admission (TOG-4007 Slice B).
 *
 * This is NOT a synthetic actor or field-readability policy. Real member data
 * may pass transiently; the dispatcher and StagingRestartFunnelFirewall must
 * still refuse non-synthetic persistence. Never substitute this predicate for
 * those gates. createRestartGatewayPolicy remains a strict fixture contract.
 *
 * Only plain decoded gateway JSON is in scope. This checks binding fields, not
 * the complete Discord schema, session ordering or arbitrary object behavior.
 * Additive vendor fields are retained, not projected, rewritten or logged.
 * It is deliberately not installed by the entrypoint or the dispatcher.
 *
 * Event fields: https://docs.discord.com/developers/events/gateway-events#ready
 * and #guild-create, #guild-member-add, #guild-member-update,
 * #guild-member-remove, #message-create on the same official page.
 */
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from './spec.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snowflake(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[1-9]\d{16,18}|1\d{19})$/.test(value) &&
    BigInt(value) <= (1n << 64n) - 1n;
}

function actor(value: unknown): boolean {
  return record(value) && snowflake(value['id']);
}

/** Bound identity and the six retained event types; never persistence consent. */
export function restartGatewayAdmission(type: string, data: unknown): boolean {
  if (!record(data)) return false;
  switch (type) {
    case 'READY': {
      const user = data['user'];
      const application = data['application'];
      const guilds = data['guilds'];
      const shard = data['shard'];
      return data['v'] === 10 &&
        record(user) && user['id'] === STAGING_BOT_APPLICATION_ID && user['bot'] === true &&
        record(application) && application['id'] === STAGING_BOT_APPLICATION_ID &&
        Array.isArray(guilds) && guilds.length === 1 && record(guilds[0]) &&
        guilds[0]['id'] === TWO_STAGING_GUILD_ID &&
        typeof data['session_id'] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data['session_id']) &&
        data['resume_gateway_url'] === 'wss://gateway.discord.gg' &&
        // Discord omits shard when not sent at Identify. The context independently
        // pins shard 0 of 1; if supplied here the declaration must agree.
        (shard === undefined || Array.isArray(shard) && shard.length === 2 && shard[0] === 0 && shard[1] === 1);
    }
    case 'GUILD_CREATE':
      if (data['id'] !== TWO_STAGING_GUILD_ID) return false;
      // Unavailable guilds can contain only id + unavailable. Available guilds
      // carry a genuine owner id, which is metadata, NOT a synthetic actor.
      if (data['unavailable'] === true && data['owner_id'] === undefined) return true;
      return snowflake(data['owner_id']);
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE':
    case 'GUILD_MEMBER_REMOVE':
      return data['guild_id'] === TWO_STAGING_GUILD_ID && actor(data['user']);
    case 'MESSAGE_CREATE':
      return data['guild_id'] === TWO_STAGING_GUILD_ID && actor(data['author']) &&
        snowflake(data['id']) && snowflake(data['channel_id']);
    default:
      return false;
  }
}
