/**
 * Staging voice-occupant fixture acceptance (TOG-6499).
 *
 * WHY THIS EXISTS. scripts/staging-voice-occupant.ts landed after the round-1
 * baseline with zero test-file references, yet it is the fourth process in the
 * TOG-3052 temp-voice proof: it holds a voice state open across the bot
 * restart so "occupied, not stranded" is a claim about a real occupant. This
 * file pins its occupant-snapshot output on canned voice state with a mock
 * gateway, including the empty-channel output, so a reviewer reruns on the
 * same fixtures and diffs clean.
 *
 * Hermetic: pure functions plus a fake shard/client. No token, no database,
 * no Discord, no network, no process exit. Importing the script has no side
 * effects (the live gateway session only runs under direct invocation); the
 * --help boot path stays covered by test/unit.scriptregistryhelp.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OCCUPANT_GUILD_ID,
  buildJoinPayload,
  buildLeavePayload,
  joinedLine,
  leftLine,
  parseOccupantArgv,
  snapshotOccupants,
  wireOccupant,
  type OccupantClient,
  type OccupantGuild,
  type VoiceStatePayload,
} from '../scripts/staging-voice-occupant.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

// Synthetic snowflake-shaped ids: valid argv, never a live channel or member.
const CHANNEL = '190000000000000001';
const OCCUPANT_A = '190000000000000011';
const OCCUPANT_B = '190000000000000012';
const BOT = '190000000000000021';

test('the occupant is pinned to the staging guild, never the live one', () => {
  assert.equal(OCCUPANT_GUILD_ID, TWO_STAGING_GUILD_ID);
  assert.notEqual(OCCUPANT_GUILD_ID, LIVE_GUILD_ID);
});

test('join and leave payloads pin op 4, the staging guild and silent state', () => {
  assert.deepEqual(buildJoinPayload(CHANNEL), {
    op: 4,
    d: { guild_id: TWO_STAGING_GUILD_ID, channel_id: CHANNEL, self_mute: true, self_deaf: true },
  });
  assert.deepEqual(buildLeavePayload(), {
    op: 4,
    d: { guild_id: TWO_STAGING_GUILD_ID, channel_id: null },
  });
});

test('argv parsing accepts only a snowflake channel id', () => {
  assert.equal(parseOccupantArgv(['node', 'staging-voice-occupant.ts', CHANNEL]), CHANNEL);
  for (const argv of [
    ['node', 'staging-voice-occupant.ts'],
    ['node', 'staging-voice-occupant.ts', 'create'],
    ['node', 'staging-voice-occupant.ts', '123'],
    ['node', 'staging-voice-occupant.ts', 'not-a-channel'],
    ['node', 'staging-voice-occupant.ts', ''],
  ]) {
    assert.throws(() => parseOccupantArgv(argv), /usage: staging-voice-occupant\.ts <channelId>/);
  }
});

test('snapshot pins occupants on canned voice state, sorted and de-duplicated', () => {
  assert.deepEqual(snapshotOccupants(CHANNEL, [OCCUPANT_B, OCCUPANT_A, OCCUPANT_B]), {
    guildId: TWO_STAGING_GUILD_ID,
    channelId: CHANNEL,
    occupants: [OCCUPANT_A, OCCUPANT_B],
    occupantCount: 2,
    empty: false,
  });
});

test('empty-channel output is an empty list, not null, and reruns identically', () => {
  const snapshot = snapshotOccupants(CHANNEL, []);
  assert.deepEqual(snapshot, {
    guildId: TWO_STAGING_GUILD_ID,
    channelId: CHANNEL,
    occupants: [],
    occupantCount: 0,
    empty: true,
  });
  // A reviewer reruns on the same canned state and diffs clean.
  assert.deepEqual(snapshotOccupants(CHANNEL, []), snapshot);
  assert.deepEqual(
    snapshotOccupants(CHANNEL, [OCCUPANT_A]),
    snapshotOccupants(CHANNEL, [OCCUPANT_A]),
  );
});

test('proof log lines carry the join/leave events with channel and user', () => {
  assert.deepEqual(JSON.parse(joinedLine(CHANNEL, BOT)), {
    event: 'occupant_joined',
    channelId: CHANNEL,
    userId: BOT,
  });
  assert.deepEqual(JSON.parse(leftLine(CHANNEL)), {
    event: 'occupant_left',
    channelId: CHANNEL,
  });
});

/** Mock gateway: records op 4 sends, never touches the network. */
class FakeClient implements OccupantClient {
  readonly user = { id: BOT };
  readonly sent: VoiceStatePayload[] = [];
  readonly fetched: string[] = [];
  cached: OccupantGuild | undefined;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    const shard = { send: (payload: VoiceStatePayload): void => void this.sent.push(payload) };
    this.cached = { shard };
  }

  once(event: 'ready', listener: () => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  guilds = {
    fetch: async (guildId: string): Promise<OccupantGuild> => {
      this.fetched.push(guildId);
      return { shard: { send: (payload: VoiceStatePayload): void => void this.sent.push(payload) } };
    },
    cache: {
      get: (guildId: string): OccupantGuild | undefined =>
        guildId === OCCUPANT_GUILD_ID ? this.cached : undefined,
    },
  };

  emitReady(): void {
    for (const listener of this.listeners.get('ready') ?? []) listener();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('wireOccupant joins on ready and leaves through the mock gateway', async () => {
  const client = new FakeClient();
  const lines: string[] = [];
  const { leave } = wireOccupant(client, CHANNEL, (line) => void lines.push(line));

  client.emitReady();
  await tick();

  assert.deepEqual(client.fetched, [TWO_STAGING_GUILD_ID]);
  assert.deepEqual(client.sent, [buildJoinPayload(CHANNEL)]);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    event: 'occupant_joined',
    channelId: CHANNEL,
    userId: BOT,
  });

  leave();
  assert.deepEqual(client.sent, [buildJoinPayload(CHANNEL), buildLeavePayload()]);
  assert.deepEqual(JSON.parse(lines[1] ?? ''), {
    event: 'occupant_left',
    channelId: CHANNEL,
  });
});

test('leave with no cached guild still logs the departure without sending', () => {
  const client = new FakeClient();
  client.cached = undefined;
  const lines: string[] = [];
  const { leave } = wireOccupant(client, CHANNEL, (line) => void lines.push(line));

  leave();
  assert.deepEqual(client.sent, []);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    event: 'occupant_left',
    channelId: CHANNEL,
  });
});
