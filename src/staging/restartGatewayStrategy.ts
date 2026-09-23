/** Pre-consumer gateway seam, NOT a complete staging transport sandbox.
 * Not installed by src/index.ts until binding/handshake compatibility is proven.
 * Real shards still decode frames and generate protocol traffic; the public
 * context pins destinations, and application-initiated sends are denied.
 */
import { Collection } from '@discordjs/collection';
import {
  SimpleContextFetchingStrategy,
  WebSocketShard,
  WebSocketShardEvents,
  managerToFetchingStrategyOptions,
  type IShardingStrategy,
  type WebSocketManager,
} from '@discordjs/ws';
import { createRestartGatewayContext, restartGatewayEndpoint } from './restartGatewayContext.ts';

/** Trusted synchronous policy. Only literal true permits the ORIGINAL payload.
 * Unknown events/fields/actors must be refused by the eventual policy. Never
 * rewrite ownership, roles or member state to make a handshake acceptable.
 */
export type RestartGatewayPolicy = (type: string, data: unknown) => boolean;

export function restartGatewayStrategy(policy: RestartGatewayPolicy, endpoint?: string):
  (manager: WebSocketManager) => IShardingStrategy {
  if (typeof policy !== 'function') throw new Error('Staging gateway policy required.');
  const pinned = restartGatewayEndpoint(endpoint);
  return (manager) => new RestartGatewayStrategy(manager, policy, pinned);
}

/** Uses the same public shards/context as SimpleShardingStrategy, in-process.
 * No private packet handlers, global monkeypatch, worker or replacement Client.
 */
class RestartGatewayStrategy implements IShardingStrategy {
  private readonly shards = new Collection<number, WebSocketShard>();
  private readonly manager: WebSocketManager;
  private readonly policy: RestartGatewayPolicy;
  private readonly endpoint: string;
  private context?: ReturnType<typeof createRestartGatewayContext>;

  constructor(manager: WebSocketManager, policy: RestartGatewayPolicy, endpoint: string) {
    this.manager = manager;
    this.policy = policy;
    this.endpoint = endpoint;
  }

  private accepts(type: string, data: unknown): boolean {
    try { return this.policy(type, data) === true; }
    catch { return false; } // Policy errors cannot forward input or leak payloads.
  }

  async spawn(shardIds: number[]): Promise<void> {
    if (this.shards.size || shardIds.length !== 1 || shardIds[0] !== 0) {
      throw new Error('Staging gateway shard ownership refused.');
    }
    const options = await managerToFetchingStrategyOptions(this.manager);
    const context = createRestartGatewayContext(new SimpleContextFetchingStrategy(this.manager, options), this.endpoint);
    this.context = context;
    for (const shardId of shardIds) {
      const shard = new WebSocketShard(context, shardId);
      const events = WebSocketShardEvents;
      shard.on(events.Dispatch, ({ data }) => {
        if (this.accepts(data.t, data.d)) this.manager.emit(events.Dispatch, { data, shardId });
      });
      // READY has a second path carrying the entire handshake. Filtering only
      // Dispatch would still expose it to discord.js's shardReady consumer.
      shard.on(events.Ready, ({ data }) => {
        if (this.accepts('READY', data)) this.manager.emit(events.Ready, { data, shardId });
      });
      shard.on(events.Closed, (payload) => this.manager.emit(events.Closed, { ...payload, shardId }));
      shard.on(events.Hello, () => this.manager.emit(events.Hello, { shardId }));
      shard.on(events.Resumed, () => this.manager.emit(events.Resumed, { shardId }));
      shard.on(events.HeartbeatComplete, (payload) =>
        this.manager.emit(events.HeartbeatComplete, { ...payload, shardId }));
      shard.on(events.Error, () => this.manager.emit(events.Error, {
        error: new Error('Staging gateway transport failed.'), shardId,
      }));
      // Do not forward dependency debug strings or arbitrary future events.
      this.shards.set(shardId, shard);
    }
  }

  async connect(): Promise<void> {
    if (!this.context) throw new Error('Staging gateway context unavailable.');
    // ws starts internalConnect detached. Reject an already-poisoned session on
    // this awaited path instead of leaving connect waiting forever for READY.
    await this.context.retrieveSessionInfo(0);
    await Promise.all([...this.shards.values()].map((shard) => shard.connect()));
  }

  async destroy(options?: Parameters<IShardingStrategy['destroy']>[0]): Promise<void> {
    await Promise.all([...this.shards.values()].map((shard) => shard.destroy(options)));
    this.shards.clear();
  }

  async send(_shardId: number, _payload: Parameters<IShardingStrategy['send']>[1]): Promise<void> {
    // No app-originated frame is needed for passive restarts. Shard-generated
    // identify/resume/heartbeats do NOT flow through this public send method.
    // Refuse even opcodes 1/2/6 here; do not fabricate successful sends.
    throw new Error('Staging gateway outbound refused.');
  }

  async fetchStatus(): Promise<Awaited<ReturnType<IShardingStrategy['fetchStatus']>>> {
    return this.shards.mapValues((shard) => shard.status);
  }
}
