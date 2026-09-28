/**
 * Hold a voice state open in TWO Staging until killed (TOG-3052 evidence).
 *
 *   node scripts/staging-voice-occupant.ts <channelId>
 *
 * This exists so the temp-voice bot can be restarted while somebody is still
 * sitting in a generated channel. The occupant has to outlive the bot process,
 * so it cannot be the bot process: it runs as its own gateway session and keeps
 * the voice state alive while the runtime under test is killed and re-launched.
 *
 * Only the voice STATE is established (gateway op 4). No UDP audio connection is
 * opened, because `occupantsOf` reads the channel's member list and nothing here
 * needs to make a sound.
 *
 * Staging only, and it says so twice: the guild is pinned to the constant rather
 * than read from the environment, where DISCORD_GUILD_ID is the live guild.
 *
 * Library + CLI (TOG-6499): the wire payloads, log lines, occupant snapshot,
 * argv parsing and the ready/leave wiring below are exported and pinned by
 * test/unit.stagingvoiceoccupant.test.ts on canned voice state with a
 * mock gateway. Importing this file never reads argv, never exits and never
 * opens a connection; the live gateway session only runs under direct
 * invocation (the isMain block at the bottom).
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

/**
 * The only guild this script ever addresses: the pinned staging constant,
 * never DISCORD_GUILD_ID (which holds the live guild in this environment).
 */
export const OCCUPANT_GUILD_ID = TWO_STAGING_GUILD_ID;

/** A gateway op 4 voice-state update: join carries the channel, leave nulls it. */
export interface VoiceStatePayload {
  op: 4;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute?: boolean;
    self_deaf?: boolean;
  };
}

/**
 * The op 4 that parks this process in a voice channel: state only, no UDP
 * audio, muted and deafened so it never makes a sound.
 */
export function buildJoinPayload(channelId: string): VoiceStatePayload {
  return {
    op: 4,
    d: { guild_id: OCCUPANT_GUILD_ID, channel_id: channelId, self_mute: true, self_deaf: true },
  };
}

/**
 * The op 4 that vacates: a null channel leaves no lingering voice state, so
 * the next run's "the channel is empty now" step stays true.
 */
export function buildLeavePayload(): VoiceStatePayload {
  return { op: 4, d: { guild_id: OCCUPANT_GUILD_ID, channel_id: null } };
}

/** The stdout line the join emits: the proof's "somebody is sitting here" record. */
export function joinedLine(channelId: string, userId: string | undefined): string {
  return JSON.stringify({ event: 'occupant_joined', channelId, userId });
}

/** The stdout line the departure emits: the proof's "the channel is empty now" record. */
export function leftLine(channelId: string): string {
  return JSON.stringify({ event: 'occupant_left', channelId });
}

export interface OccupantSnapshot {
  guildId: string;
  channelId: string;
  occupants: string[];
  occupantCount: number;
  empty: boolean;
}

/**
 * Canonical snapshot of who is in a voice channel, for staging proofs.
 * Sorted and de-duplicated so a rerun over the same canned state diffs clean;
 * an empty channel snapshots to occupants: [] with empty: true rather than
 * null, so "nobody here" and "no such channel" never look alike.
 */
export function snapshotOccupants(channelId: string, memberIds: Iterable<string>): OccupantSnapshot {
  const occupants = [...new Set(memberIds)].sort();
  return {
    guildId: OCCUPANT_GUILD_ID,
    channelId,
    occupants,
    occupantCount: occupants.length,
    empty: occupants.length === 0,
  };
}

/** Channel id from argv, or the usage error the CLI prints. */
export function parseOccupantArgv(argv: ReadonlyArray<string | undefined>): string {
  const channelId = argv[2];
  if (typeof channelId !== 'string' || !/^\d{17,20}$/.test(channelId)) {
    throw new Error('usage: staging-voice-occupant.ts <channelId>');
  }
  return channelId;
}

/** The smallest surface wireOccupant needs: a shard that records op 4, and the guild cache. */
export interface OccupantShard {
  send(payload: VoiceStatePayload): void;
}

export interface OccupantGuild {
  shard: OccupantShard;
}

export interface OccupantClient {
  readonly user?: { readonly id?: string } | null;
  once(event: 'ready', listener: () => void): unknown;
  guilds: {
    fetch(guildId: string): Promise<OccupantGuild>;
    cache: { get(guildId: string): OccupantGuild | undefined };
  };
}

/**
 * Drive the occupant against any client with the shape above: on ready, send
 * the join op 4 over the live shard and log the joined line; the returned
 * leave() sends the vacate op 4 (when the guild is still cached) and logs the
 * departure. No timers, no destroy, no process.exit here: the CLI owns the
 * shutdown sequence, so tests can drive join and leave on a mock gateway with
 * zero side effects.
 */
export function wireOccupant(
  client: OccupantClient,
  channelId: string,
  log: (line: string) => void = console.log,
): { leave: () => void } {
  client.once('ready', () => {
    void (async () => {
      const guild = await client.guilds.fetch(OCCUPANT_GUILD_ID);
      guild.shard.send(buildJoinPayload(channelId));
      log(joinedLine(channelId, client.user?.id));
    })();
  });
  const leave = (): void => {
    client.guilds.cache.get(OCCUPANT_GUILD_ID)?.shard.send(buildLeavePayload());
    log(leftLine(channelId));
  };
  return { leave };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/staging-voice-occupant.ts <channelId>');
    console.log('');
    console.log('Hold a voice state open in TWO Staging until killed (TOG-3052 evidence).');
    console.log('');
    console.log('Flags:');
    console.log('  <channelId>  Voice channel to hold open (required).');
    console.log('  --help       Show this help and exit.');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/staging-voice-occupant.ts --help');
    console.log('  node scripts/staging-voice-occupant.ts <channelId>');
    console.log('');
    console.log('Staging only. Requires DISCORD_STAGING_BOT_TOKEN; --help needs no token and opens no connection.');
    process.exit(0);
  }

  const channelId = parseOccupantArgv(process.argv);

  const token = process.env.DISCORD_STAGING_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_STAGING_BOT_TOKEN is required; this script is staging-only.');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  });

  const { leave } = wireOccupant(client, channelId);

  // Leaving cleanly matters: a lingering voice state would make the next run's
  // "the channel is empty now" step quietly untrue.
  const leaveAndExit = () => {
    leave();
    setTimeout(() => {
      client.destroy();
      process.exit(0);
    }, 1000);
  };
  process.on('SIGINT', leaveAndExit);
  process.on('SIGTERM', leaveAndExit);

  await client.login(token);
}
