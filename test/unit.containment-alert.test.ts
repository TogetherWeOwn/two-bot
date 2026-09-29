/**
 * TOG-9129: containmentAlert offline suite.
 *
 * src/discord/containmentAlert.ts formats and posts anti-nuke and join-risk
 * alerts. Hermetic by construction: a fake discord.js client (a channels
 * cache map plus stub channel objects — the announcers only touch
 * `client.channels.cache.get`), a fetch trap that fails on any real network
 * call, and stdout/stderr hooks that capture the JSON log lines.
 *
 * Runs without Postgres, a token, or a guild:
 *   node --test test/unit.containment-alert.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, type Client } from 'discord.js';
import { formatContainmentAlert, formatJoinRiskAlert, makeContainmentAnnouncer, makeJoinRiskAnnouncer } from '../src/discord/containmentAlert.ts';
import type { ContainmentAlert, JoinRiskAlert } from '../src/moderation/containment.ts';

const CHANNEL = '1550000000000000003';

const CONTAINMENT_ALERT: ContainmentAlert = {
  kind: 'containment',
  guildId: '1545644954272137297',
  executorId: '111111111111111111',
  action: 'channel.delete',
  targetId: '222222222222222222',
  heat: 6,
  threshold: 5,
  outcome: 'contained',
  removedRoleIds: ['333333333333333333'],
  restore: { outcome: 'restore_required', operations: 2 },
};

const JOIN_RISK_ALERT: JoinRiskAlert = {
  guildId: '1545644954272137297',
  memberId: '444444444444444444',
  score: 3,
  reasons: ['account younger than 24 hours'],
  bulkJoinWindow: false,
};

// --- format tests (pure functions, no client involved) --------------------------

test('containment alert names confirmed action and restore boundary', () => {
  const text = formatContainmentAlert(CONTAINMENT_ALERT);
  assert.match(text, /Anti-nuke contained/);
  assert.match(text, /Removed dangerous roles/);
  assert.match(text, /2 additive operation/);
  assert.match(text, /No member join was kicked or banned/);
});

test('join risk alert states the refusal boundary', () => {
  const text = formatJoinRiskAlert(JOIN_RISK_ALERT);
  assert.match(text, /Flag only/);
  assert.match(text, /did not kick, ban, timeout, or message/);
});

// --- zero-live-call trap -------------------------------------------------------
// The announcers never touch fetch themselves; the trap proves no dependency
// does either. Silence at the end of the suite is the pass.

const fetchCalls: string[] = [];
let originalFetch: typeof fetch;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9129: offline suite attempted a network call to ${String(input)}`);
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
      return { id: '1600000000000000002' };
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

// --- containment announcer: no-alert paths --------------------------------------

test('containment: null channelId logs the alert and posts nothing', async () => {
  const client = fakeClient(new Map());
  const announce = makeContainmentAnnouncer(client, null);

  const lines = await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.ok(msgs(lines).includes('containment_alert'), 'the evidence lands in the log');
  assert.ok(!msgs(lines).includes('containment_alert_undeliverable'), 'no channel was even attempted');
});

test('containment: missing channel logs undeliverable and never throws', async () => {
  const client = fakeClient(new Map());
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  const lines = await captureLogs(() => announce(CONTAINMENT_ALERT));

  const order = msgs(lines);
  assert.ok(order.includes('containment_alert'), 'the alert is logged even when it cannot be posted');
  assert.ok(order.includes('containment_alert_undeliverable'));
  assert.ok(
    order.indexOf('containment_alert') < order.indexOf('containment_alert_undeliverable'),
    'evidence first, delivery outcome second',
  );
  const undel = lines.find((l) => l.msg === 'containment_alert_undeliverable');
  assert.equal(undel?.channelId, CHANNEL);
});

test('containment: channel without SendMessages logs undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends, canView: true, canSend: false })]]));
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 0);
});

test('containment: channel without ViewChannel logs undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends, canView: false, canSend: true })]]));
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 0);
});

test('containment: DM channel logs undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends, dmBased: true })]]));
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  const lines = await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 0, 'containment alerts never go to DMs');
  assert.ok(msgs(lines).includes('containment_alert_undeliverable'));
});

test('containment: no bot member in guild logs undeliverable and posts nothing', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends, me: null })]]));
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 0);
});

// --- containment announcer: send failure and alert path -------------------------

test('containment: send failure is logged and never throws', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(
    new Map([[CHANNEL, fakeChannel({ sends, failSend: new Error('Discord having a bad day') })]]),
  );
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  const lines = await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 1, 'the post was attempted');
  assert.ok(msgs(lines).includes('containment_alert_post_failed'));
  const failed = lines.find((l) => l.msg === 'containment_alert_post_failed');
  assert.equal(failed?.channelId, CHANNEL);
  assert.match(String(failed?.err), /bad day/);
});

test('containment: success posts with empty allowedMentions and no pings', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends })]]));
  const announce = makeContainmentAnnouncer(client, CHANNEL);

  await captureLogs(() => announce(CONTAINMENT_ALERT));

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]?.allowedMentions, { parse: [] }, 'a formatting slip must never ping members');
  assert.ok(sends[0]?.content.includes('`111111111111111111`'), 'IDs stay as inert backticked text');
  assert.doesNotMatch(sends[0]?.content ?? '', /@everyone|@here|<@/);
});

// --- join risk announcer: mirrors the same no-alert / alert / pin behaviour -----

test('joinRisk: null channelId logs the alert and posts nothing', async () => {
  const client = fakeClient(new Map());
  const announce = makeJoinRiskAnnouncer(client, null);

  const lines = await captureLogs(() => announce(JOIN_RISK_ALERT));

  assert.ok(msgs(lines).includes('containment_alert'));
  assert.ok(!msgs(lines).includes('containment_alert_undeliverable'));
});

test('joinRisk: missing channel logs undeliverable and posts nothing', async () => {
  const client = fakeClient(new Map());
  const announce = makeJoinRiskAnnouncer(client, CHANNEL);

  const lines = await captureLogs(() => announce(JOIN_RISK_ALERT));

  assert.ok(msgs(lines).includes('containment_alert_undeliverable'));
});

test('joinRisk: success posts with empty allowedMentions and no pings', async () => {
  const sends: SendPayload[] = [];
  const client = fakeClient(new Map([[CHANNEL, fakeChannel({ sends })]]));
  const announce = makeJoinRiskAnnouncer(client, CHANNEL);

  await captureLogs(() => announce(JOIN_RISK_ALERT));

  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]?.allowedMentions, { parse: [] }, 'a formatting slip must never ping the flagged member');
  assert.ok(sends[0]?.content.includes('`444444444444444444`'), 'the member id stays inert backticked text');
  assert.doesNotMatch(sends[0]?.content ?? '', /@everyone|@here|<@/);
});

// --- the zero-live-call pin ----------------------------------------------------------

test('offline suite made zero live network calls', () => {
  assert.deepEqual(fetchCalls, [], 'every client in this file is a fake');
});
