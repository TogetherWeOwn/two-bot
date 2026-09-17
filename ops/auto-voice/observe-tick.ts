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
 * Read-only. It opens a gateway session, reads the guild's own channel list and
 * voice states out of GUILD_CREATE, closes, and does one REST GET for the
 * offer channel's pins. It sends no writes and joins no voice channel, so it
 * cannot itself create the rooms it is counting.
 *
 * Exit codes are three, not two, because a tick that could not observe must not
 * be readable as either a pass or a breach:
 *
 *   0  PASS          - observed, every condition held
 *   1  FAIL          - observed, a condition was breached
 *   2  INCONCLUSIVE  - could not observe (no token, gateway refused, timeout)
 *
 * TWO DIMENSIONS, one verdict (TOG-3143, CTO direction on TOG-3150 item 4):
 *
 *   1. Channel hygiene - the TOG-3052 gate. No ghost rooms, Lobby untouched,
 *      generator present.
 *   2. The AGPL-3.0 §13 source offer. We run a MODIFIED Auto-Voice: the bot's
 *      Discord status is patched by ./status-patch.sh, so §13 obliges us to
 *      prominently offer Corresponding Source to the users interacting with it.
 *      That offer is delivered in-guild - channel topic AND a pinned message
 *      naming upstream and the pinned commit, with status-patch.sh attached.
 *      An offer is not a thing you post once: a topic edit or an unpin silently
 *      un-discharges it. This tick is what makes that drift loud.
 *
 * `AVC_OFFER_CHANNEL_ID` IS REQUIRED. Unset, the tick is INCONCLUSIVE (2), not
 * PASS - half the thing being checked would be invisible, and the whole point of
 * the third exit code is that unobserved never reads as fine. That is a
 * deliberate change to the TOG-3052 tick's environment, not an oversight.
 */

/** Discord channel type 2. The only type this tick reasons about. */
const GUILD_VOICE = 2;

/**
 * The upstream commit our deployment is pinned to, and therefore the commit the
 * §13 offer must name. If the pin is ever bumped, the offer in the guild has to
 * be edited in the same change - override with AVC_OFFER_COMMIT so this tick
 * goes red on an offer that still points at the old tree.
 */
const UPSTREAM_COMMIT = '8fab5e8d78aa252195dcea1bcd3d313cb1ba0802';

/** Upstream's repository, which the offer must name so it can be found. */
const UPSTREAM_REPO = 'Auto-Voice-Channels';

/** The one file that modifies upstream's program; §13 requires it unredacted. */
const PATCH_FILENAME = 'status-patch.sh';

/** Gateway intents: GUILDS (1 << 0) | GUILD_VOICE_STATES (1 << 7). Neither is privileged. */
const INTENTS = (1 << 0) | (1 << 7);

export type GuildChannel = {
  id: string;
  type: number;
  name: string;
  parent_id?: string | null;
  position?: number;
  /** Text channels only. Half of the §13 offer lives here. */
  topic?: string | null;
};

export type VoiceState = {
  user_id: string;
  channel_id?: string | null;
};

/** A pinned message, reduced to the two fields the offer check reasons about. */
export type PinnedMessage = {
  id: string;
  content: string;
  attachments?: Array<{ filename: string }>;
};

/** What the tick needs in order to score the §13 offer. */
export type OfferInput = {
  /** The channel whose topic and pins carry the offer. */
  channelId: string;
  /** Commit the offer must name. Defaults to the pin this repo deploys. */
  commit?: string;
  pinnedMessages: PinnedMessage[];
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
   * The §13 offer. Omitted, no offer checks are emitted at all — which is
   * exactly why the CLI refuses to run without one rather than letting it
   * default quietly away.
   */
  offer?: OfferInput;
};

export type TickCheck = { name: string; ok: boolean; detail: string };

export type TickResult = {
  verdict: 'PASS' | 'FAIL';
  checks: TickCheck[];
  /** Generated rooms with nobody in them. Any of these is a breach. */
  ghosts: Array<{ id: string; name: string }>;
  /** Generated rooms with somebody in them. Healthy; reported for context. */
  occupied: Array<{ id: string; name: string; members: number }>;
};

/**
 * Score the AGPL-3.0 §13 source offer, as a pure function of what the guild
 * reported. Three checks, because §13 is not one obligation:
 *
 *   offer_channel   the channel carrying the offer still exists and is a text
 *                   channel, so the topic and pins can exist at all.
 *   offer_in_topic  the *prominent offer* half. A topic is what a user sees
 *                   without scrolling; it is the part that makes the offer
 *                   prominent rather than merely present.
 *   offer_pinned    the *access* half. A pinned message naming upstream and the
 *                   commit, with status-patch.sh attached unredacted — our patch
 *                   plus that commit IS the Corresponding Source.
 *
 * Both halves are required. The CTO's ruling on TOG-3150 was that §13 is two
 * halves and satisfying one discharges nothing, so one check would encode the
 * wrong law.
 *
 * Matching is deliberately loose on prose and strict on the two facts that can
 * go stale: the repository name and the commit. Whoever writes the offer may
 * word it however reads best in the guild; they may not drop the commit, and
 * they may not leave the old commit there after a pin bump.
 */
export function evaluateOffer(
  offer: OfferInput,
  channels: GuildChannel[],
): TickCheck[] {
  const commit = offer.commit ?? UPSTREAM_COMMIT;
  // The short sha is what a human writes in a Discord message; accepting the
  // prefix accepts the full form too, since the full form contains it.
  const shortCommit = commit.slice(0, 8).toLowerCase();
  const names = (text: string) => {
    const t = text.toLowerCase();
    return t.includes(UPSTREAM_REPO.toLowerCase()) && t.includes(shortCommit);
  };
  const missing = (text: string) => {
    const t = text.toLowerCase();
    const gaps: string[] = [];
    if (!t.includes(UPSTREAM_REPO.toLowerCase())) gaps.push(`does not name ${UPSTREAM_REPO}`);
    if (!t.includes(shortCommit)) gaps.push(`does not name commit ${shortCommit}`);
    return gaps.join(' and ');
  };

  const checks: TickCheck[] = [];
  const channel = channels.find((c) => c.id === offer.channelId);

  checks.push({
    name: 'offer_channel',
    ok: channel !== undefined && channel.type !== GUILD_VOICE,
    detail: channel
      ? `${JSON.stringify(channel.name)} type=${channel.type}`
      : `offer channel ${offer.channelId} does not exist in this guild`,
  });

  const topic = channel?.topic ?? '';
  checks.push({
    name: 'offer_in_topic',
    ok: channel !== undefined && names(topic),
    detail:
      channel === undefined
        ? 'no channel to read a topic from'
        : topic === ''
          ? 'channel topic is empty — the prominent half of the §13 offer is gone'
          : names(topic)
            ? `topic names ${UPSTREAM_REPO} and ${shortCommit}`
            : `topic ${missing(topic)}`,
  });

  // An offer that names everything but ships no patch provides no access, and a
  // redacted patch is not Corresponding Source. Both are scored here.
  const naming = offer.pinnedMessages.filter((m) => names(m.content));
  const complete = naming.filter((m) =>
    (m.attachments ?? []).some((a) => a.filename === PATCH_FILENAME),
  );
  checks.push({
    name: 'offer_pinned',
    ok: complete.length > 0,
    detail:
      complete.length > 0
        ? `pinned message ${complete[0]!.id} names ${UPSTREAM_REPO}, ${shortCommit}, and attaches ${PATCH_FILENAME}`
        : offer.pinnedMessages.length === 0
          ? 'nothing is pinned in the offer channel'
          : naming.length > 0
            ? `${naming.length} pinned message(s) name the source but none attaches ${PATCH_FILENAME}`
            : `${offer.pinnedMessages.length} pinned message(s), none naming the source: ${offer.pinnedMessages
                .map((m) => `${m.id} (${missing(m.content)})`)
                .join(', ')}`,
  });

  return checks;
}

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

  if (input.offer) checks.push(...evaluateOffer(input.offer, input.channels));

  return {
    verdict: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    checks,
    ghosts,
    occupied,
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

/**
 * Read the offer channel's pinned messages over REST.
 *
 * Rejects rather than returning `[]` on every failure path, for the same reason
 * `snapshot` does: a channel we could not read must not be scored as a channel
 * with nothing pinned in it. That would turn a 403 into "the offer is gone" and
 * a FAIL into a fire drill — or worse, be read the other way round.
 *
 * The one failure the caller is expected to act on rather than retry is 404,
 * so the rejection carries `status`. A 404 is not "could not observe": the
 * channel holding the offer is gone, which is precisely the drift this exists
 * to catch. See `main`.
 */
export async function fetchPins(
  token: string,
  channelId: string,
  timeoutMs = 15_000,
): Promise<PinnedMessage[]> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins`, {
    headers: { authorization: `Bot ${token}`, 'user-agent': 'two-bot-avc-observe (TOG-3143)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(
      `GET /channels/${channelId}/pins -> ${res.status} ${res.statusText}` +
        (res.status === 403 ? ' (bot lacks View Channel / Read Message History here)' : ''),
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const body: unknown = await res.json();
  // The classic endpoint returns a bare array; the paginated one returns
  // { items: [{ message }] }. Accept both so a Discord-side migration reads as
  // a schema change we handle, not as an empty pin list.
  const raw = Array.isArray(body)
    ? body
    : ((body as { items?: Array<{ message?: unknown }> }).items ?? []).map((i) => i.message);
  return (raw as Array<Record<string, unknown>>).filter(Boolean).map((m) => ({
    id: String(m['id'] ?? ''),
    content: String(m['content'] ?? ''),
    attachments: ((m['attachments'] as Array<{ filename?: unknown }> | undefined) ?? []).map((a) => ({
      filename: String(a.filename ?? ''),
    })),
  }));
}

/* ------------------------------------------------------------------ fixtures */

const CAT = '100';
const GEN = '200';
const LOBBY = '300';
const OFFER_CH = '500';

/** A discharged offer: both halves present, patch attached unredacted. */
const goodTopic =
  'TWO voice rooms · This bot is a modified Auto-Voice-Channels ' +
  '(github.com/GregZaal/Auto-Voice-Channels) at commit 8fab5e8d — source offer pinned below.';
const goodPin: PinnedMessage = {
  id: '900',
  content:
    'AGPL-3.0 §13 source offer. We run a modified Auto-Voice-Channels, upstream ' +
    'commit 8fab5e8d78aa252195dcea1bcd3d313cb1ba0802. Our only change is attached.',
  attachments: [{ filename: PATCH_FILENAME }],
};
const offerChannel: GuildChannel = { id: OFFER_CH, type: 0, name: 'voice-chat', parent_id: CAT, topic: goodTopic };
const goodOffer: OfferInput = { channelId: OFFER_CH, pinnedMessages: [goodPin] };

const baseChannels: GuildChannel[] = [
  { id: CAT, type: 4, name: '🔊 VOICE', parent_id: null, position: 2 },
  { id: LOBBY, type: GUILD_VOICE, name: 'Lobby', parent_id: CAT, position: 12 },
  { id: GEN, type: GUILD_VOICE, name: '➕ Join to Create', parent_id: CAT, position: 13 },
];

const base = { categoryId: CAT, generatorId: GEN, lobbyId: LOBBY, channels: baseChannels, voiceStates: [] };

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

  /* --- the §13 offer (TOG-3143). Each case is a way an offer silently dies. --- */
  {
    name: 'offer discharged: topic and pin both name upstream and the commit',
    input: { ...base, channels: [...baseChannels, offerChannel], offer: goodOffer },
    expect: 'PASS',
  },
  {
    name: 'offer: somebody cleared the channel topic',
    input: {
      ...base,
      channels: [...baseChannels, { ...offerChannel, topic: 'TWO voice rooms' }],
      offer: goodOffer,
    },
    expect: 'FAIL',
  },
  {
    name: 'offer: the message was unpinned',
    input: {
      ...base,
      channels: [...baseChannels, offerChannel],
      offer: { channelId: OFFER_CH, pinnedMessages: [] },
    },
    expect: 'FAIL',
  },
  {
    name: 'offer: pin survives but the patch attachment was removed',
    input: {
      ...base,
      channels: [...baseChannels, offerChannel],
      offer: { channelId: OFFER_CH, pinnedMessages: [{ ...goodPin, attachments: [] }] },
    },
    expect: 'FAIL',
  },
  {
    name: 'offer: the upstream pin was bumped and the offer still names the old commit',
    input: {
      ...base,
      channels: [...baseChannels, offerChannel],
      offer: { ...goodOffer, commit: 'c0ffee1234567890c0ffee1234567890c0ffee12' },
    },
    expect: 'FAIL',
  },
  {
    name: 'offer: the offer channel itself was deleted',
    input: { ...base, channels: baseChannels, offer: goodOffer },
    expect: 'FAIL',
  },
  {
    name: 'offer: a different message is pinned, naming nothing',
    input: {
      ...base,
      channels: [...baseChannels, offerChannel],
      offer: {
        channelId: OFFER_CH,
        pinnedMessages: [{ id: '901', content: 'read the rules', attachments: [] }],
      },
    },
    expect: 'FAIL',
  },
  {
    name: 'offer: pointed at a voice channel, which cannot carry a topic or a pin',
    input: {
      ...base,
      channels: [...baseChannels, { id: OFFER_CH, type: GUILD_VOICE, name: 'Lounge', parent_id: CAT }],
      offer: goodOffer,
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

  const token = process.env.AVC_OBSERVE_TOKEN ?? process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.AVC_OBSERVE_GUILD_ID ?? process.env.DISCORD_GUILD_ID;
  const categoryId = process.env.AVC_OBSERVE_CATEGORY_ID ?? '1545924266590081115';
  const generatorId = process.env.AVC_OBSERVE_GENERATOR_ID ?? '1546777867978018887';
  const lobbyId = process.env.AVC_OBSERVE_LOBBY_ID ?? '1546777866648289300';
  const ignoreChannelIds = (process.env.AVC_OBSERVE_IGNORE_CHANNEL_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const offerChannelId = process.env.AVC_OFFER_CHANNEL_ID;
  const offerCommit = process.env.AVC_OFFER_COMMIT ?? UPSTREAM_COMMIT;

  if (!token || !guildId) {
    console.error('INCONCLUSIVE: need a bot token in the guild (AVC_OBSERVE_TOKEN or DISCORD_BOT_TOKEN) and a guild id');
    return 2;
  }

  // Not a default. We run a modified AGPL work, so a tick that cannot see the
  // §13 offer has observed half the thing it exists to observe — and the one
  // outcome worse than a red tick is a green one that never looked.
  if (!offerChannelId) {
    console.error(
      'INCONCLUSIVE: AVC_OFFER_CHANNEL_ID is unset, so the AGPL §13 offer was not checked. ' +
        'Set it to the channel carrying the offer topic and pin (TOG-3143). ' +
        'This tick will not report PASS without it.',
    );
    return 2;
  }

  let observed;
  try {
    observed = await snapshot(token, guildId);
  } catch (err) {
    console.error(`INCONCLUSIVE: ${(err as Error).message}`);
    return 2;
  }

  let pinnedMessages: PinnedMessage[];
  try {
    pinnedMessages = await fetchPins(token, offerChannelId);
  } catch (err) {
    // 404 means the channel itself is gone, so there is nothing inconclusive
    // about it: the offer has been deleted. Score it — `offer_channel` reports
    // the deletion by name and all three offer checks go red. Every other
    // failure (403, timeout, 5xx) really is "could not observe".
    if ((err as { status?: number }).status !== 404) {
      console.error(`INCONCLUSIVE: could not read the offer channel's pins: ${(err as Error).message}`);
      return 2;
    }
    console.error(`offer channel ${offerChannelId} returned 404 — scoring the offer as absent`);
    pinnedMessages = [];
  }

  const result = evaluate({
    categoryId,
    generatorId,
    lobbyId,
    ignoreChannelIds,
    offer: { channelId: offerChannelId, commit: offerCommit, pinnedMessages },
    ...observed,
  });
  const tick = {
    card: 'TOG-3052 + TOG-3143',
    guildId,
    offerChannelId,
    offerCommit,
    observedAt: new Date().toISOString(),
    ...result,
  };
  console.log(JSON.stringify(tick, null, 2));
  return result.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
