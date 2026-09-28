/**
 * TOG-9121: raidAlert announcer offline suite.
 *
 * src/discord/raidAlert.ts posts staff alerts and must never ping members.
 * Hermetic by construction: a fake discord.js client (a channels cache map
 * plus stub channel objects — `makeRaidAnnouncer` only touches
 * `client.channels.cache.get`), a fetch trap that fails on any real network
 * call, and stdout/stderr hooks that capture the JSON log lines.
 *
 * Runs without Postgres, a token, or a guild:
 *   node --test test/unit.raidalert.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, type Client } from 'discord.js';
import { makeRaidAnnouncer } from '../src/discord/raidAlert.ts';
import type { RaidAlert } from '../src/analytics/raidWatch.ts';

const GUILD = '326474832151838730';
const CHANNEL = '1550000000000000002';

const ALERT: RaidAlert = {
  guildId: GUILD,
  count: 6,
  windowSeconds: 60,
  firstJoinAt: '2026-02-01T20:00:00.000Z',
  lastJoinAt: '2026-02-01T20:00:05.000Z',
  spanSeconds: 5,
  memberIds: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
  truncated: false,
  repeat: false,
};

// --- zero-live-call trap -------------------------------------------------------
// The announcer never touches fetch itself; the trap proves no dependency does
// either. Silence at the end of the suite is the pass.

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9121: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

// --- fake client ---------------------------------------------------------------
// botCanPost only reads client.channels.cache.get, then the channel's
// isTextBased/isDMBased/guild.members.me/permissionsFor/send. Plain objects
// are a faithful stand-in; no discord.js Client is ever constructed.

interface SendPayload {
  content: string;
  allowedMentions: { parse: string[] };
}

function fakeChannel(o: {
  sends: SendPayload[];
  canView?: boolean;
  canSend?: boolean;
  textBased?: boolean;
  dmBased?: boolean;
  failSend?: Error;
  me?: object | null;
}) {
  const canView = o.canView ?? true;
  const canSend = o.canSend ?? true;
  return {
    isTextBased: () => o.textBased ?? true,
    isDMBased: () => o.dmBased ?? false,
    guild: { members: { me: o.me === undefined ? {} : o.me } },
    permissionsFor: () => ({
      has: (flag: bigint) =>
        flag === PermissionsBitField.Flags.ViewChannel
          ? canView
          : flag === PermissionsBitField.Flags.SendMessages
            ? canSend
            : false,
    }),
    send: async (payload: SendPayload) => {
      o.sends.push(payload);
      if (o.failSend) throw o.failSend;
      return { id: '1600000000000000001' };
    },
  };
}

function fakeClient(channels: Map<string, unknown>): Client {
  return { channels: { cache: channels } } as unknown as Client;
}

// --- log capture ---------------------------------------------------------------
// log.error writes JSON lines to stderr, log.info to stdout. Hook both, parse
// the JSON lines, swallow them so the TAP stream stays clean.

async function captureLogs(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const makeHook =
    (real: (chunk: unknown, ...rest: unknown[]) => boolean) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Non-JSON runner output passes through to its own stream untouched.
          real(line + '\n', ...rest);
        }
      }
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = makeHook(realOut as never);
  process.stderr.write = makeHook(realErr as never);
  try {
    await fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return lines;
}

const msgs = (lines: Array<Record<string, unknown>>) => lines.map((l) => String(l.msg));

// --- null channelId: logs-only path ---------------------------------------------

test('null channelId logs the alert and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map());
  const announce = makeRaidAnnouncer(client, { channelId: null });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 0);
  assert.ok(msgs(lines).includes('raid_alert'), 'the evidence lands in the log');
  const alert = lines.find((l) => l.msg === 'raid_alert');
  assert.equal(alert?.guildId, GUILD);
  assert.equal(alert?.count, 6);
  assert.deepEqual(msgs(lines).filter((m) => m !== 'raid_alert'), [], 'nothing else is logged');
});

// --- dryRun posts nothing --------------------------------------------------------

test('dryRun logs what would be posted and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends })]]));
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL, dryRun: true });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 0, 'a dry run must never reach the channel');
  assert.ok(msgs(lines).includes('raid_alert'));
  assert.ok(msgs(lines).includes('raid_alert_dry_run'));
  const dry = lines.find((l) => l.msg === 'raid_alert_dry_run');
  assert.equal(dry?.channelId, CHANNEL);
  assert.ok(!msgs(lines).includes('raid_alert_posted'));
});

// --- missing / no-permission channel ----------------------------------------------

test('missing channel logs raid_alert_undeliverable and never throws', async () => {
  const client = fakeClient(new Map());
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL });

  const lines = await captureLogs(() => announce(ALERT));

  const order = msgs(lines);
  assert.ok(order.includes('raid_alert'), 'the alert is logged even when it cannot be posted');
  assert.ok(order.includes('raid_alert_undeliverable'));
  assert.ok(
    order.indexOf('raid_alert') < order.indexOf('raid_alert_undeliverable'),
    'evidence first, delivery outcome second',
  );
  const undel = lines.find((l) => l.msg === 'raid_alert_undeliverable');
  assert.equal(undel?.channelId, CHANNEL);
});

test('channel without SendMessages logs raid_alert_undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(
    new Map([[CHANNEL, fakeChannel({ sends, canView: true, canSend: false })]]),
  );
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 0);
  assert.ok(msgs(lines).includes('raid_alert_undeliverable'));
  assert.ok(!msgs(lines).includes('raid_alert_posted'));
});

test('DM channel logs raid_alert_undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends, dmBased: true })]]));
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 0, 'staff alerts never go to DMs');
  assert.ok(msgs(lines).includes('raid_alert_undeliverable'));
});

// --- send failure: logged, never throws; success pins allowedMentions -------------

test('send failure is logged and never throws', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(
    new Map([[CHANNEL, fakeChannel({ sends, failSend: new Error('Discord having a bad day') })]]),
  );
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 1, 'the post was attempted');
  assert.ok(msgs(lines).includes('raid_alert'));
  assert.ok(msgs(lines).includes('raid_alert_post_failed'));
  const failed = lines.find((l) => l.msg === 'raid_alert_post_failed');
  assert.equal(failed?.channelId, CHANNEL);
  assert.match(String(failed?.err), /bad day/);
});

test('success posts with empty allowedMentions and no pings', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends })]]));
  const announce = makeRaidAnnouncer(client, { channelId: CHANNEL });

  const lines = await captureLogs(() => announce(ALERT));

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]?.allowedMentions, { parse: [] }, 'a formatting slip must never ping members');
  assert.ok(sends[0]?.content.includes('`m0`'), 'IDs stay as inert backticked text');
  assert.doesNotMatch(sends[0]?.content ?? '', /@everyone|@here|<@/);
  assert.ok(msgs(lines).includes('raid_alert_posted'));
  const posted = lines.find((l) => l.msg === 'raid_alert_posted');
  assert.equal(posted?.channelId, CHANNEL);
  assert.equal(posted?.count, 6);
});

// --- the zero-live-call pin ----------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every client in this file is a fake');
});
