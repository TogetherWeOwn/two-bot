/** Pre-consumer gateway seam, NOT a complete staging ingress policy.
 * Not installed by src/index.ts until a separately tested binding/payload policy
 * exists. The shard still decodes frames and maintains its protocol session;
 * refusal here prevents forwarding to discord.js raw listeners and caches.
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

/** Trusted synchronous policy. Only literal true permits the ORIGINAL payload.
 * Unknown events/fields/actors must be refused by the eventual policy. Never
 * rewrite ownership, roles or member state to make a handshake acceptable.
 */
export type RestartGatewayPolicy = (type: string, data: unknown) => boolean;

export function restartGatewayStrategy(policy: RestartGatewayPolicy):
  (manager: WebSocketManager) => IShardingStrategy {
  if (typeof policy !== 'function') throw new Error('Staging gateway policy required.');
  return (manager) => new RestartGatewayStrategy(manager, policy);
}

/** Uses the same public shards/context as SimpleShardingStrategy, in-process.
 * No private packet handlers, global monkeypatch, worker or replacement Client.
 */
class RestartGatewayStrategy implements IShardingStrategy {
  private readonly shards = new Collection<number, WebSocketShard>();
  private readonly manager: WebSocketManager;
  private readonly policy: RestartGatewayPolicy;

  constructor(manager: WebSocketManager, policy: RestartGatewayPolicy) {
    this.manager = manager;
    this.policy = policy;
  }

  private accepts(type: string, data: unknown): boolean {
    try { return this.policy(type, data) === true; }
    catch { return false; } // Policy errors cannot forward input or leak payloads.
  }

  async spawn(shardIds: number[]): Promise<void> {
    if (this.shards.size || new Set(shardIds).size !== shardIds.length) {
      throw new Error('Staging gateway shard ownership refused.');
    }
    const options = await managerToFetchingStrategyOptions(this.manager);
    for (const shardId of shardIds) {
      const shard = new WebSocketShard(new SimpleContextFetchingStrategy(this.manager, options), shardId);
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
    await Promise.all([...this.shards.values()].map((shard) => shard.connect()));
  }

  async destroy(options?: Parameters<IShardingStrategy['destroy']>[0]): Promise<void> {
    await Promise.all([...this.shards.values()].map((shard) => shard.destroy(options)));
    this.shards.clear();
  }

  async send(shardId: number, payload: Parameters<IShardingStrategy['send']>[1]): Promise<void> {
    const shard = this.shards.get(shardId);
    if (!shard) throw new Error('Staging gateway shard unavailable.');
    // This seam is ingress-only. Outbound gateway policy remains a separate gate.
    await shard.send(payload);
  }

  async fetchStatus(): Promise<Awaited<ReturnType<IShardingStrategy['fetchStatus']>>> {
    return this.shards.mapValues((shard) => shard.status);
  }
}
