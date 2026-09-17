/**
 * Auto-Voice-Channels liveness exercise (TOG-3126).
 *
 * The observation in `observe-tick.ts` is an absence-of-harm measurement: no
 * ghosts, `Lobby` untouched, generator present. Every one of those conditions
 * holds just as well when the AVC container is dead, because a Discord channel
 * object outlives the process watching it. Seven ticks of a bot that died on
 * day 1 are seven PASSes, and `no_ghost_rooms` is vacuous on any day nobody
 * used the generator.
 *
 * This file is the positive half: it drives one full create/destroy cycle
 * through the live AVC and reports what it witnessed.
 *
 *   join the generator  -> AVC must create a room under the category
 *                       -> AVC must move us into it   (a room somebody is in)
 *   disconnect          -> AVC must delete that room  (no ghost left behind)
 *
 * No human is needed for this, which is the whole point. `maybeCreate` upstream
 * (`bot/src/features/voice/handler.ts`) has no bot filter - `m.bot` is only
 * filtered out of the *emptiness* counts - so a bot's voice state takes the
 * identical path a member's does. We open a second gateway session and send
 * op 4; the deployed container's own session is undisturbed, and the voice UDP
 * handshake is never completed because the guild only ever sees the voice state.
 *
 * Self-cleaning by construction: the room AVC creates is deleted by AVC when we
 * leave. If AVC is dead, no room is ever created, so a failed exercise leaves
 * nothing behind - and that failure is the finding.
 */

/** Gateway intents: GUILDS (1 << 0) | GUILD_VOICE_STATES (1 << 7) = 129. Neither is privileged. */
const INTENTS = (1 << 0) | (1 << 7);

/** Discord channel type 2. */
const GUILD_VOICE = 2;

export type ExerciseEvidence = {
  /** The room AVC created when we joined the generator, if it created one. */
  createdRoom: { id: string; name: string; parentId: string | null } | null;
  /** ms from our join to AVC's CHANNEL_CREATE. null if no room appeared. */
  createMs: number | null;
  /** ms from our join to AVC moving us into that room. null if we were never moved. */
  movedMs: number | null;
  /** ms from our disconnect to AVC's CHANNEL_DELETE. null if the room outlived us. */
  deleteMs: number | null;
  /** Set when the room was still there when we stopped waiting. This is a real ghost. */
  residualRoomId: string | null;
};

export type ExerciseWindows = {
  /** How long to wait for AVC to create the room and move us in. */
  createMs: number;
  /** How long to wait for AVC to reclaim the room after we leave. */
  deleteMs: number;
};

export const DEFAULT_WINDOWS: ExerciseWindows = { createMs: 20_000, deleteMs: 60_000 };

/**
 * Thrown when the exercise could not be *performed* - no gateway, bad token,
 * the guild never arrived. That is INCONCLUSIVE, not a breach: a run that could
 * not drive the generator has learned nothing about whether AVC is alive, and
 * must never be scored as either a clean day or a broken one.
 */
export class ExerciseUnavailable extends Error {}

type Payload = { op: number; t?: string | null; d?: unknown };

/**
 * Drive one create/destroy cycle and return what the gateway actually emitted.
 *
 * Resolves with evidence whenever the cycle was *attempted* end to end, even if
 * AVC did nothing - "AVC did nothing" is the answer this exists to be able to
 * give. Rejects with ExerciseUnavailable only when we could not attempt it.
 */
export async function exercise(opts: {
  token: string;
  guildId: string;
  generatorId: string;
  categoryId: string;
  /** Channels that already existed, so a room we did not cause is never claimed as ours. */
  knownChannelIds?: Iterable<string>;
  windows?: ExerciseWindows;
  now?: () => number;
}): Promise<ExerciseEvidence> {
  const windows = opts.windows ?? DEFAULT_WINDOWS;
  const now = opts.now ?? (() => Date.now());
  const known = new Set(opts.knownChannelIds ?? []);

  return await new Promise<ExerciseEvidence>((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    let selfId: string | null = null;
    let guildSeen = false;
    let joinedAt = 0;
    let leftAt = 0;

    const evidence: ExerciseEvidence = {
      createdRoom: null,
      createMs: null,
      movedMs: null,
      deleteMs: null,
      residualRoomId: null,
    };

    const shutdown = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (phaseTimer) clearTimeout(phaseTimer);
      try {
        ws.close();
      } catch {
        // already closing; the evidence is what matters
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      shutdown();
      resolve(evidence);
    };

    const unavailable = (why: string) => {
      if (settled) return;
      settled = true;
      shutdown();
      reject(new ExerciseUnavailable(why));
    };

    const send = (payload: unknown) => ws.send(JSON.stringify(payload));

    /** op 4 with a null channel is the disconnect. */
    const setVoice = (channelId: string | null) =>
      send({
        op: 4,
        d: { guild_id: opts.guildId, channel_id: channelId, self_mute: true, self_deaf: true },
      });

    const leaveAndWatchForCleanup = () => {
      if (phaseTimer) clearTimeout(phaseTimer);
      leftAt = now();
      setVoice(null);

      // Nothing was created, so there is nothing to reclaim and nothing to wait
      // for. Report immediately: the missing room is already the whole finding.
      if (!evidence.createdRoom) {
        finish();
        return;
      }

      phaseTimer = setTimeout(() => {
        evidence.residualRoomId = evidence.createdRoom?.id ?? null;
        finish();
      }, windows.deleteMs);
    };

    const startExercise = () => {
      joinedAt = now();
      setVoice(opts.generatorId);
      phaseTimer = setTimeout(leaveAndWatchForCleanup, windows.createMs);
    };

    // A session that never reaches READY + GUILD_CREATE cannot be scored at all.
    const connectTimer = setTimeout(
      () => unavailable(`gateway never delivered READY and GUILD_CREATE for ${opts.guildId}`),
      30_000,
    );

    ws.addEventListener('error', () => unavailable('gateway socket error'));
    ws.addEventListener('close', (ev) => {
      // Closing after we have our evidence is normal shutdown, not a failure.
      if (settled) return;
      // 4004 bad token, 4014 disallowed intent. Both are configuration.
      unavailable(`gateway closed mid-exercise (code ${(ev as CloseEvent).code})`);
    });

    ws.addEventListener('message', (ev) => {
      const payload = JSON.parse(String((ev as MessageEvent).data)) as Payload;

      if (payload.op === 10) {
        const hello = payload.d as { heartbeat_interval: number };
        heartbeat = setInterval(() => send({ op: 1, d: null }), hello.heartbeat_interval);
        send({
          op: 2,
          d: {
            token: opts.token,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'two-bot-avc-exercise', device: 'two-bot-avc-exercise' },
          },
        });
        return;
      }

      if (payload.op !== 0) return;

      if (payload.t === 'READY') {
        selfId = (payload.d as { user: { id: string } }).user.id;
      }

      if (payload.t === 'GUILD_CREATE') {
        const guild = payload.d as { id: string; channels?: Array<{ id: string }> };
        if (guild.id !== opts.guildId) return;
        // Everything already in the guild is somebody else's; only a channel
        // created after our join can be attributed to our join.
        for (const c of guild.channels ?? []) known.add(c.id);
        guildSeen = true;
      }

      if (guildSeen && selfId && !joinedAt) {
        clearTimeout(connectTimer);
        startExercise();
        return;
      }

      if (!joinedAt) return;

      if (payload.t === 'CHANNEL_CREATE' && !evidence.createdRoom) {
        const ch = payload.d as { id: string; type: number; name: string; parent_id?: string | null; guild_id?: string };
        if (ch.guild_id !== undefined && ch.guild_id !== opts.guildId) return;
        if (ch.type !== GUILD_VOICE || known.has(ch.id) || ch.id === opts.generatorId) return;
        evidence.createdRoom = { id: ch.id, name: ch.name, parentId: ch.parent_id ?? null };
        evidence.createMs = now() - joinedAt;
        return;
      }

      if (payload.t === 'VOICE_STATE_UPDATE') {
        const vs = payload.d as { user_id: string; channel_id?: string | null; guild_id?: string };
        if (vs.user_id !== selfId) return;
        if (
          evidence.movedMs === null &&
          evidence.createdRoom &&
          vs.channel_id === evidence.createdRoom.id
        ) {
          evidence.movedMs = now() - joinedAt;
          // Create and move both witnessed: the room exists and we are in it.
          // Nothing further is learned by sitting in it, so start the teardown
          // half of the cycle now rather than burning the rest of the window.
          leaveAndWatchForCleanup();
        }
        return;
      }

      if (payload.t === 'CHANNEL_DELETE' && evidence.createdRoom && leftAt) {
        const ch = payload.d as { id: string };
        if (ch.id !== evidence.createdRoom.id) return;
        evidence.deleteMs = now() - leftAt;
        finish();
      }
    });
  });
}

/**
 * Was this a complete, healthy cycle?
 *
 * Pure, so the fixtures in `observe-tick.ts` can drive it through the outcomes
 * the live guild will not produce on demand - AVC offline, AVC creating a room
 * in the wrong place, AVC leaking a room it never reclaims.
 */
export function describeExercise(
  evidence: ExerciseEvidence | undefined,
  categoryId: string,
): { alive: boolean; reclaimed: boolean; aliveDetail: string; reclaimedDetail: string } {
  if (!evidence) {
    return {
      alive: false,
      reclaimed: false,
      aliveDetail: 'no liveness evidence: this tick did not exercise the generator',
      reclaimedDetail: 'no liveness evidence: this tick did not exercise the generator',
    };
  }

  const room = evidence.createdRoom;

  if (!room) {
    return {
      alive: false,
      reclaimed: false,
      aliveDetail: 'joined the generator and no channel was created - AVC is not reacting',
      reclaimedDetail: 'no room was created, so nothing was reclaimed',
    };
  }

  const placed = room.parentId === categoryId;
  const moved = evidence.movedMs !== null;
  const alive = placed && moved;

  const aliveDetail = !placed
    ? `created ${room.id} ${JSON.stringify(room.name)} under parent=${room.parentId ?? 'null'}, not the 🔊 VOICE category`
    : !moved
      ? `created ${room.id} ${JSON.stringify(room.name)} in ${evidence.createMs}ms but never moved us into it`
      : `created ${room.id} ${JSON.stringify(room.name)} in ${evidence.createMs}ms, moved us in at ${evidence.movedMs}ms`;

  const reclaimed = evidence.deleteMs !== null;
  const reclaimedDetail = reclaimed
    ? `deleted ${room.id} ${evidence.deleteMs}ms after we left`
    : `${room.id} ${JSON.stringify(room.name)} still existed when we stopped waiting - this is a ghost`;

  return { alive, reclaimed, aliveDetail, reclaimedDetail };
}
