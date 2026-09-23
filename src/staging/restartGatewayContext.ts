/** Destination/session guard for the public @discordjs/ws context seam.
 * Not a socket sandbox: trusted pinned shards still decode input and generate
 * identify/resume/heartbeat frames (including Client's default online presence).
 * Identify content is NOT guarded here. This does not authorize staging execution.
 * Source: https://github.com/discordjs/discord.js/blob/%40discordjs%2Fws%401.2.3/packages/ws/src/strategies/context/IContextFetchingStrategy.ts
 */
import type { IContextFetchingStrategy, SessionInfo } from '@discordjs/ws';

const REFUSAL = 'Staging gateway context refused.';
const DISCORD_GATEWAY = 'wss://gateway.discord.gg';

/** An explicit local fixture endpoint is never inferred from gateway input/env.
 * Pin the entire string; URL normalization must not turn an unsafe spelling into
 * an allowed destination. Production resume hosts other than this pin refuse.
 */
export function restartGatewayEndpoint(value = DISCORD_GATEWAY): string {
  try {
    if (value === DISCORD_GATEWAY) return value;
    const url = new URL(value);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.pathname !== '/gw' || url.search || url.hash || url.username || url.password ||
        url.href !== value) throw new Error();
    return value;
  } catch { throw new Error(REFUSAL); }
}

/** Validate BOTH session reads and writes: READY stores its resume URL before
 * dispatch/ready forwarding. Never return null for invalid state (which would
 * silently reconnect with a fresh identify). Latch refusal for this context.
 *
 * Copies freeze the values consumed by the shard and delegated store, closing
 * reference-mutation gaps. This guards data, not hostile code in the process.
 */
export function createRestartGatewayContext(
  delegate: IContextFetchingStrategy,
  endpoint = DISCORD_GATEWAY,
) {
  const pinned = restartGatewayEndpoint(endpoint);
  let refused = false;
  const fail = (): never => { refused = true; throw new Error(REFUSAL); };
  const shard = (id: number) => { if (refused || id !== 0) fail(); };
  let options: IContextFetchingStrategy['options'];
  try {
    options = structuredClone(delegate.options);
    // discord.js 14.27 passes numeric 10 despite the ws string declaration.
    // Both become exactly v=10 in the shard; no other coercion is permitted.
    const version: unknown = options.version;
    if (options.gatewayInformation.url !== pinned || options.shardCount !== 1 ||
        version !== '10' && version !== 10 || options.encoding !== 'json') fail();
    Object.freeze(options.gatewayInformation.session_start_limit);
    Object.freeze(options.gatewayInformation);
    Object.freeze(options.identifyProperties);
    Object.freeze(options);
  } catch { return fail(); }

  const session = (value: SessionInfo | null): SessionInfo | null => {
    if (value === null) return null;
    if (!value || Object.keys(value).sort().join(',') !== 'resumeURL,sequence,sessionId,shardCount,shardId' ||
        value.resumeURL !== pinned || value.shardId !== 0 || value.shardCount !== 1 ||
        !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
        typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) fail();
    return Object.freeze({ ...value });
  };
  return Object.freeze({
    options,
    async retrieveSessionInfo(id: number) {
      shard(id);
      try {
        const value = await delegate.retrieveSessionInfo(id);
        shard(id);
        return session(value);
      } catch { return fail(); }
    },
    async updateSessionInfo(id: number, value: SessionInfo | null) {
      // Deletion is needed by shard.destroy even after refusal. It never resets
      // the latch or allows a reconnect/identify to proceed.
      if (value === null && id === 0) {
        try { await delegate.updateSessionInfo(id, null); return; }
        catch { fail(); }
      }
      shard(id);
      try { await delegate.updateSessionInfo(id, session(value)); }
      catch { fail(); }
    },
    async waitForIdentify(id: number, signal: AbortSignal) {
      shard(id);
      // Preserve the AbortError required by the public strategy contract. Other
      // delegate errors must not expose credentials or turn into reconnect loops.
      try { await delegate.waitForIdentify(id, signal); }
      catch { if (signal.aborted) throw signal.reason; fail(); }
      shard(id);
    },
  } satisfies IContextFetchingStrategy);
}
