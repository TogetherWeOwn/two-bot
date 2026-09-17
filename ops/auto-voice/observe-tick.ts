/**
 * Auto-Voice-Channels live-guild observation tick (TOG-3052 phase 1).
 *
 *   node ops/auto-voice/observe-tick.ts            # observe the live guild, print a tick
 *   node ops/auto-voice/observe-tick.ts --selftest # run the fixtures, touch no network
 *
 * Phase 2 (TOG-3062) is gated on AVC running clean in the live guild for seven
 * consecutive days. That gate was written as prose with numbers in it, which is
 * how a gate gets re-improvised every time somebody checks it. This file is the
 * gate: one tick per day, one JSON object per tick, and the exit code is the
 * verdict.
 *
 * A tick is two halves, in this order:
 *
 *   1. Observation - absence of harm. A gateway session reads the guild's own
 *      channel list and voice states out of GUILD_CREATE and closes. No REST
 *      writes, no voice join, so it cannot manufacture the rooms it counts, and
 *      it measures the guild before we have touched it.
 *   2. Exercise (`exercise.ts`) - presence of the feature. A second session
 *      joins the generator, and AVC must create a room, move us into it, and
 *      reclaim it when we leave.
 *
 * Half 2 exists because half 1 passes with AVC dead (TOG-3126): a Discord
 * channel object outlives the process watching it, so "generator present, Lobby
 * untouched, no ghosts" is equally true of a container that died on day 1, and
 * `no_ghost_rooms` is vacuous on any day nobody used the generator. Seven days
 * of nothing-bad-is-visible is not seven days of AVC running clean.
 *
 * Exit codes are three, not two, because a tick that could not observe must not
 * be readable as either a pass or a breach:
 *
 *   0  PASS          - observed and exercised, every condition held
 *   1  FAIL          - observed, a condition was breached
 *   2  INCONCLUSIVE  - could not observe or could not exercise (no token,
 *                      gateway refused, timeout)
 */
import {
  DEFAULT_WINDOWS,
  ExerciseUnavailable,
  describeExercise,
  exercise,
  type ExerciseEvidence,
} from './exercise.ts';

/** Discord channel type 2. The only type this tick reasons about. */
const GUILD_VOICE = 2;

/** Gateway intents: GUILDS (1 << 0) | GUILD_VOICE_STATES (1 << 7). Neither is privileged. */
const INTENTS = (1 << 0) | (1 << 7);

export type GuildChannel = {
  id: string;
  type: number;
  name: string;
  parent_id?: string | null;
  position?: number;
};

export type VoiceState = {
  user_id: string;
  channel_id?: string | null;
};

export type TickInput = {
  /** 🔊 VOICE category the generator lives under. */
  categoryId: string;
  /** The join-to-create generator channel. */
  generatorId: string;
  /** The permanent channel AVC must never touch. */
  lobbyId: string;
  channels: GuildChannel[];
  voiceStates: VoiceState[];
  /**
   * Voice channels under the category that are legitimately permanent and are
   * neither the generator nor Lobby. Empty by default: an unexplained room is
   * a finding, and the safe direction for this check to fail is loudly.
   */
  ignoreChannelIds?: string[];
  /**
   * What the liveness exercise witnessed. Optional in the type and fatal in the
   * verdict: a tick with no exercise evidence FAILs `avc_alive`, because the
   * whole defect this closes is a tick that passes by looking at nothing.
   */
  exercise?: ExerciseEvidence;
};

export type TickCheck = { name: string; ok: boolean; detail: string };

export type TickResult = {
  verdict: 'PASS' | 'FAIL';
  checks: TickCheck[];
  /** Generated rooms with nobody in them. Any of these is a breach. */
  ghosts: Array<{ id: string; name: string }>;
  /** Generated rooms with somebody in them. Healthy; reported for context. */
  occupied: Array<{ id: string; name: string; members: number }>;
  /** The create/destroy cycle this tick drove, echoed into the ledger verbatim. */
  exercise: ExerciseEvidence | null;
};

/**
 * The whole verdict, as a pure function of what the guild reported.
 *
 * Kept separate from the gateway so the fixtures below can drive it through
 * states the live guild will not hold still for - a ghost, a renamed Lobby, a
 * deleted generator - without anybody creating those states for real.
 */
export function evaluate(input: TickInput): TickResult {
  const ignore = new Set(input.ignoreChannelIds ?? []);
  const byId = new Map(input.channels.map((c) => [c.id, c]));

  const occupancy = new Map<string, number>();
  for (const vs of input.voiceStates) {
    if (!vs.channel_id) continue;
    occupancy.set(vs.channel_id, (occupancy.get(vs.channel_id) ?? 0) + 1);
  }

  const checks: TickCheck[] = [];

  const generator = byId.get(input.generatorId);
  checks.push({
    name: 'generator_present',
    ok:
      generator !== undefined &&
      generator.type === GUILD_VOICE &&
      generator.parent_id === input.categoryId,
    detail: generator
      ? `${JSON.stringify(generator.name)} type=${generator.type} parent=${generator.parent_id ?? 'null'}`
      : 'generator channel does not exist',
  });

  // Lobby is checked by name as well as by parent: AVC renames the rooms it
  // owns, so a renamed Lobby is the signature of it having adopted a channel it
  // was never given. That is the failure this card's constraints exist to catch.
  const lobby = byId.get(input.lobbyId);
  checks.push({
    name: 'lobby_untouched',
    ok:
      lobby !== undefined &&
      lobby.type === GUILD_VOICE &&
      lobby.parent_id === input.categoryId &&
      lobby.name === 'Lobby',
    detail: lobby
      ? `${JSON.stringify(lobby.name)} type=${lobby.type} parent=${lobby.parent_id ?? 'null'}`
      : 'Lobby does not exist',
  });

  const generated = input.channels.filter(
    (c) =>
      c.type === GUILD_VOICE &&
      c.parent_id === input.categoryId &&
      c.id !== input.generatorId &&
      c.id !== input.lobbyId &&
      !ignore.has(c.id),
  );

  const ghosts = generated
    .filter((c) => (occupancy.get(c.id) ?? 0) === 0)
    .map((c) => ({ id: c.id, name: c.name }));

  const occupied = generated
    .filter((c) => (occupancy.get(c.id) ?? 0) > 0)
    .map((c) => ({ id: c.id, name: c.name, members: occupancy.get(c.id) ?? 0 }));

  checks.push({
    name: 'no_ghost_rooms',
    ok: ghosts.length === 0,
    detail:
      ghosts.length === 0
        ? generated.length === 0
          ? 'no generated rooms under the category'
          : `${generated.length} generated room(s) under the category, all occupied`
        : `empty generated room(s): ${ghosts.map((g) => `${g.id} ${JSON.stringify(g.name)}`).join(', ')}`,
  });

  // The positive half. Everything above this line is satisfied by a guild that
  // AVC stopped touching days ago; these two are the only checks that require a
  // process to have been running during this tick.
  const ex = describeExercise(input.exercise, input.categoryId);
  checks.push({ name: 'avc_alive', ok: ex.alive, detail: ex.aliveDetail });
  checks.push({ name: 'room_reclaimed', ok: ex.reclaimed, detail: ex.reclaimedDetail });

  return {
    verdict: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    checks,
    ghosts,
    occupied,
    exercise: input.exercise ?? null,
  };
}

/**
 * Open a gateway session, take one snapshot of the guild, close.
 *
 * Rejects rather than resolving empty on every failure path, so a guild we
 * could not read can never be scored as a guild with no ghosts in it.
 */
export async function snapshot(
  token: string,
  guildId: string,
  timeoutMs = 30_000,
): Promise<{ channels: GuildChannel[]; voiceStates: VoiceState[] }> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const done = (err: Error | null, value?: { channels: GuildChannel[]; voiceStates: VoiceState[] }) => {
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing; the snapshot is what matters
      }
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(
      () => done(new Error(`no GUILD_CREATE for ${guildId} within ${timeoutMs}ms`)),
      timeoutMs,
    );

    ws.addEventListener('error', () => done(new Error('gateway socket error')));
    ws.addEventListener('close', (ev) => {
      // 4014 = disallowed intent, 4004 = bad token. Both are configuration, not a breach.
      done(new Error(`gateway closed before GUILD_CREATE (code ${(ev as CloseEvent).code})`));
    });

    ws.addEventListener('message', (ev) => {
      const payload = JSON.parse(String((ev as MessageEvent).data)) as {
        op: number;
        t?: string | null;
        d?: unknown;
      };

      if (payload.op === 10) {
        const hello = payload.d as { heartbeat_interval: number };
        heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), hello.heartbeat_interval);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: INTENTS,
              properties: { os: 'linux', browser: 'two-bot-avc-observe', device: 'two-bot-avc-observe' },
            },
          }),
        );
        return;
      }

      if (payload.op === 0 && payload.t === 'GUILD_CREATE') {
        const guild = payload.d as { id: string; channels?: GuildChannel[]; voice_states?: VoiceState[] };
        if (guild.id !== guildId) return;
        done(null, { channels: guild.channels ?? [], voiceStates: guild.voice_states ?? [] });
      }
    });
  });
}

/* ------------------------------------------------------------------ fixtures */

const CAT = '100';
const GEN = '200';
const LOBBY = '300';

const baseChannels: GuildChannel[] = [
  { id: CAT, type: 4, name: '🔊 VOICE', parent_id: null, position: 2 },
  { id: LOBBY, type: GUILD_VOICE, name: 'Lobby', parent_id: CAT, position: 12 },
  { id: GEN, type: GUILD_VOICE, name: '➕ Join to Create', parent_id: CAT, position: 13 },
];

/** A complete, healthy create/destroy cycle: AVC made a room, put us in it, took it back. */
const healthyExercise: ExerciseEvidence = {
  joinLandedMs: 118,
  createdRoom: { id: '900', name: 'Squad #1', parentId: CAT },
  createMs: 366,
  movedMs: 392,
  deleteMs: 152,
  residualRoomId: null,
};

const base = {
  categoryId: CAT,
  generatorId: GEN,
  lobbyId: LOBBY,
  channels: baseChannels,
  voiceStates: [],
  exercise: healthyExercise,
};

/**
 * Each case names the real-world event it stands for. A tick that cannot tell
 * these six apart is not measuring the gate, and the only way to know it can is
 * to drive it through them - the live guild will not produce a ghost on demand.
 */
export const FIXTURES: ReadonlyArray<{ name: string; input: TickInput; expect: 'PASS' | 'FAIL' }> = [
  {
    name: 'idle guild: generator and Lobby only',
    input: base,
    expect: 'PASS',
  },
  {
    name: 'somebody is in a generated room',
    input: {
      ...base,
      channels: [...baseChannels, { id: '401', type: GUILD_VOICE, name: 'Hangout #1', parent_id: CAT, position: 14 }],
      voiceStates: [{ user_id: 'u1', channel_id: '401' }],
    },
    expect: 'PASS',
  },
  {
    name: 'ghost: a generated room outlived its last member',
    input: {
      ...base,
      channels: [...baseChannels, { id: '401', type: GUILD_VOICE, name: 'Hangout #1', parent_id: CAT, position: 14 }],
      voiceStates: [],
    },
    expect: 'FAIL',
  },
  {
    name: 'a permanent room somebody added is a finding until it is allowlisted',
    input: {
      ...base,
      channels: [...baseChannels, { id: '402', type: GUILD_VOICE, name: 'AFK', parent_id: CAT, position: 14 }],
    },
    expect: 'FAIL',
  },
  {
    name: 'the same room, allowlisted',
    input: {
      ...base,
      channels: [...baseChannels, { id: '402', type: GUILD_VOICE, name: 'AFK', parent_id: CAT, position: 14 }],
      ignoreChannelIds: ['402'],
    },
    expect: 'PASS',
  },
  {
    name: 'AVC adopted Lobby and renamed it',
    input: {
      ...base,
      channels: [
        baseChannels[0]!,
        { id: LOBBY, type: GUILD_VOICE, name: "Greg's spot", parent_id: CAT, position: 12 },
        baseChannels[2]!,
      ],
    },
    expect: 'FAIL',
  },
  {
    name: 'the generator was deleted',
    input: { ...base, channels: [baseChannels[0]!, baseChannels[1]!] },
    expect: 'FAIL',
  },

  // TOG-3126. Every case above this line is a state the *guild* can be in, and
  // every one of them is reachable with the AVC container switched off. These
  // are the cases that tell a live bot from a dead one.
  {
    // `joinLandedMs` set is what makes this a breach rather than a bad tick: we
    // were demonstrably sitting in voice and AVC still did nothing. The variant
    // where the join never landed never reaches the evaluator - `exercise`
    // rejects it as INCONCLUSIVE - which is the distinction the streak needs.
    name: 'AVC is dead: the guild looks perfect and joining the generator does nothing',
    input: {
      ...base,
      exercise: { joinLandedMs: 118, createdRoom: null, createMs: null, movedMs: null, deleteMs: null, residualRoomId: null },
    },
    expect: 'FAIL',
  },
  {
    name: 'the tick did not exercise the generator at all',
    input: { ...base, exercise: undefined },
    expect: 'FAIL',
  },
  {
    name: 'AVC created the room somewhere other than the 🔊 VOICE category',
    input: {
      ...base,
      exercise: { ...healthyExercise, createdRoom: { id: '900', name: 'Squad #1', parentId: '777' } },
    },
    expect: 'FAIL',
  },
  {
    name: 'AVC created the room but never moved anybody into it',
    input: { ...base, exercise: { ...healthyExercise, movedMs: null } },
    expect: 'FAIL',
  },
  {
    name: 'AVC created the room and never reclaimed it - a ghost we caused',
    input: {
      ...base,
      exercise: { ...healthyExercise, deleteMs: null, residualRoomId: '900' },
    },
    expect: 'FAIL',
  },
];

/* ----------------------------------------------------------------------- cli */

function selftest(): number {
  let bad = 0;
  for (const f of FIXTURES) {
    const got = evaluate(f.input).verdict;
    const ok = got === f.expect;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f.expect.padEnd(4)} ${f.name}${ok ? '' : ` -> got ${got}`}`);
  }
  console.log(`\n${FIXTURES.length - bad}/${FIXTURES.length} fixtures`);
  return bad === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv.includes('--selftest')) return selftest();

  const token = process.env.AVC_OBSERVE_TOKEN ?? process.env.AVC_DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.AVC_OBSERVE_GUILD_ID ?? process.env.DISCORD_GUILD_ID;
  const categoryId = process.env.AVC_OBSERVE_CATEGORY_ID ?? '1545924266590081115';
  const generatorId = process.env.AVC_OBSERVE_GENERATOR_ID ?? '1546777867978018887';
  const lobbyId = process.env.AVC_OBSERVE_LOBBY_ID ?? '1546777866648289300';
  const ignoreChannelIds = (process.env.AVC_OBSERVE_IGNORE_CHANNEL_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!token || !guildId) {
    console.error('INCONCLUSIVE: need a bot token in the guild (AVC_OBSERVE_TOKEN or DISCORD_BOT_TOKEN) and a guild id');
    return 2;
  }

  // Observe first, on a guild we have not touched, so our own exercise room can
  // never be counted among the ghosts this tick is looking for.
  let observed;
  try {
    observed = await snapshot(token, guildId);
  } catch (err) {
    console.error(`INCONCLUSIVE: ${(err as Error).message}`);
    return 2;
  }
  const observedAt = new Date().toISOString();

  const exerciseToken = process.env.AVC_EXERCISE_TOKEN ?? token;
  let evidence: ExerciseEvidence;
  try {
    evidence = await exercise({
      token: exerciseToken,
      guildId,
      generatorId,
      categoryId,
      knownChannelIds: observed.channels.map((c) => c.id),
      windows: {
        createMs: Number(process.env.AVC_EXERCISE_CREATE_MS ?? DEFAULT_WINDOWS.createMs),
        deleteMs: Number(process.env.AVC_EXERCISE_DELETE_MS ?? DEFAULT_WINDOWS.deleteMs),
      },
    });
  } catch (err) {
    // Could not drive the generator at all. That is not a clean day and it is
    // not a breach either - it is a tick that learned nothing.
    if (err instanceof ExerciseUnavailable) {
      console.error(`INCONCLUSIVE: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const result = evaluate({ categoryId, generatorId, lobbyId, ignoreChannelIds, ...observed, exercise: evidence });
  const tick = {
    card: 'TOG-3126',
    guildId,
    observedAt,
    exercisedAt: new Date().toISOString(),
    ...result,
  };
  console.log(JSON.stringify(tick, null, 2));
  return result.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
