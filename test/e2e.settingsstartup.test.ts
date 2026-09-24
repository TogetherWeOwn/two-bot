/**
 * TOG-4230: the settings-service startup injection, pinned by tests.
 *
 * TOG-4104 recorded the gap: `src/index.ts` built the `SettingsStore` but never
 * passed it to `startInternalActions`, so `src/internal/server.ts` null-defaulted
 * `opts.settings` and both settings verbs refused with `action_not_allowed` /
 * `action_needs_settings` even with `TWO_INTERNAL_ALLOW_SETTINGS=1`. The fix is
 * one line in the startup call; this file makes sure it stays fixed.
 *
 * Two halves, matching the two failure modes:
 *
 * 1. The startup tripwire evaluates the actual `startInternalActions({...})`
 *    call text from the working tree's `src/index.ts` (same VM technique as
 *    `test/tog4104-runtime-wiring.test.ts`, but against the live tree rather
 *    than a pinned fixture) and asserts the in-scope `settings` instance is
 *    the one the server receives. A mutation control deletes the line and
 *    proves the tripwire goes red, so this cannot pass vacuously.
 *
 * 2. The HTTP round trip starts a real listener with a real `SettingsStore`
 *    over isolated Postgres - the same composition startup uses - and proves
 *    signed `settings.set` persists with audit, the poll refreshes the cache,
 *    the consumer sees it, `null` unsets back to the environment, and the
 *    refusal paths (unwired store, disabled verbs, env-only keys, bad HMAC)
 *    stay fail-closed.
 *
 * What this is not: a full application boot (that needs Discord and the whole
 * bootstrap), website non-admin authorization evidence (HMAC 401 here is the
 * bot's own auth contract, not the website's route policy), or staging
 * acceptance (local tests never are - see the TOG-4104 HOLD packet).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { startInternalActions, type InternalServer } from '../src/internal/server.ts';
import { assertAllowed } from '../src/internal/actions.ts';
import { KeyRing, sign } from '../src/internal/signing.ts';
import { SettingsStore } from '../src/core/settings.ts';
import { loadConfig, storeFirst } from '../src/core/config.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import type { ActionContext } from '../src/internal/actions.ts';
import { openTestDb, type TestDb } from './helpers/testDb.ts';

const KEY_ID = 'web-test';
const SECRET = 's'.repeat(48);
const WRONG_SECRET = 'w'.repeat(48);
const GUILD = '326474832151838730';
const ADMIN = '111111111111111111';
const KEY = 'TWO_RAID_JOIN_THRESHOLD';

// --- part 1: the startup tripwire --------------------------------------------

/**
 * The exact `startInternalActions({...})` call as written in src/index.ts,
 * extracted by bracket matching so line shifts do not matter. Anchored on both
 * ends: the marker line and the 2-space `});` that closes this call and no
 * inner one (inner closings sit deeper).
 */
function startupCallSource(): string {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const marker = 'internal = await startInternalActions({';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'the startup call must exist in src/index.ts');
  const lines = src.slice(start).split('\n');
  assert.ok(lines[0].endsWith('{'), 'marker must end on the opening brace');
  let depth = 0;
  const taken: string[] = [];
  for (const line of lines) {
    taken.push(line);
    const code = line.replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth === 0 && taken.length > 1) break;
  }
  assert.ok(depth === 0, 'the startup call must bracket-balance');
  assert.ok(taken.length > 5, 'the startup call must be a multi-line options object');
  const block = taken.join('\n');
  assert.ok(block.includes('new InternalActionStore'), 'extracted the wrong call: no durable store');
  assert.ok(block.includes('expectedJoins'), 'extracted the wrong call: no expectedJoins');
  return block;
}

/** Evaluate the startup call with every name it touches stubbed; capture the options. */
async function evaluateStartup(code: string): Promise<{ opts: Record<string, unknown>; settings: object }> {
  const settings = {};
  const captured: Record<string, unknown>[] = [];
  const sentinel = class {};
  const sandbox = {
    internal: null,
    internalCfg: { host: '127.0.0.1', port: 0, keys: [] },
    cfg: { guildId: GUILD, discordToken: 'offline-sentinel' },
    settings,
    db: {},
    expectedJoins: {},
    KeyRing: sentinel,
    DiscordActions: sentinel,
    InternalActionStore: sentinel,
    stagingRestartFetch: undefined,
    automationCfg: { enabled: false },
    automationService: null,
    commandRegistry: null,
    moderationResolver: null,
    moderationService: null,
    startInternalActions: async (opts: Record<string, unknown>) => {
      captured.push(opts);
      return opts;
    },
  };
  const js = stripTypeScriptTypes(code);
  await runInNewContext(`(async () => { ${js} })()`, sandbox, { timeout: 1000 });
  assert.equal(captured.length, 1, 'startup must call startInternalActions exactly once');
  return { opts: captured[0], settings };
}

test('TOG-4230 startup passes the initialized settings service to internal actions', async () => {
  const { opts, settings } = await evaluateStartup(startupCallSource());
  assert.ok(Object.hasOwn(opts, 'settings'), 'the startup options must carry settings');
  assert.equal(opts.settings, settings, 'it must be the already-initialized instance, not a fresh one');
  assert.ok(opts.store, 'the durable action store is still wired alongside it');

  // The captured option must satisfy the real gate, not a copied predicate.
  for (const action of ['settings.get', 'settings.set'] as const) {
    assert.doesNotThrow(() =>
      assertAllowed(action, {
        enabled: new Set([action]),
        store: {} as ActionContext['store'],
        settings: opts.settings as ActionContext['settings'],
      }),
    );
  }
});

test('TOG-4230 tripwire control: removing the line re-opens the TOG-4104 gap', async () => {
  const original = startupCallSource();
  const mutated = original.replace(/^\s*settings,\s*\n/m, '');
  assert.notEqual(mutated, original, 'the control must actually remove the settings line');
  const { opts } = await evaluateStartup(mutated);
  assert.equal(Object.hasOwn(opts, 'settings'), false, 'without the line, no settings option exists');
  for (const action of ['settings.get', 'settings.set'] as const) {
    assert.throws(
      () =>
        assertAllowed(action, {
          enabled: new Set([action]),
          store: {} as ActionContext['store'],
          settings: (opts as { settings?: null }).settings ?? null,
        }),
      (err: unknown) =>
        (err as { code?: string; logReason?: string }).code === 'action_not_allowed' &&
        (err as { code?: string; logReason?: string }).logReason === 'action_needs_settings',
    );
  }
});

// --- part 2: the wired server over HTTP --------------------------------------

let testDb: TestDb;
const servers: InternalServer[] = [];

const savedEnv = {
  discordToken: process.env.DISCORD_TOKEN,
  databaseUrl: process.env.TWO_DATABASE_URL,
  raidThreshold: process.env.TWO_RAID_JOIN_THRESHOLD,
};

before(async () => {
  testDb = await openTestDb(import.meta.filename);
  // loadConfig() reads these from the environment and always will - the
  // bootstrap. Set explicitly so what follows is store-beats-env, not
  // store-beats-a-default.
  process.env.DISCORD_TOKEN ??= 'test-token-not-a-real-one';
  process.env.TWO_DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';
  process.env.TWO_RAID_JOIN_THRESHOLD = '5';
});

after(async () => {
  for (const s of servers) await s.close();
  await testDb.cleanup();
  for (const [k, v] of [
    ['DISCORD_TOKEN', savedEnv.discordToken],
    ['TWO_DATABASE_URL', savedEnv.databaseUrl],
    ['TWO_RAID_JOIN_THRESHOLD', savedEnv.raidThreshold],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await testDb.reset();
});

/** Live config exactly the way src/index.ts composes it: store first, env behind. */
function liveCfgOf(store: SettingsStore) {
  return loadConfig(storeFirst(store.envSnapshot(GUILD)));
}

async function startWired(
  store: SettingsStore,
  over: { enabled?: Set<string>; settings?: SettingsStore | null } = {},
): Promise<InternalServer> {
  const srv = await startInternalActions({
    host: '127.0.0.1',
    port: 0,
    keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
    guildId: GUILD,
    discord: new Proxy({}, {
      get() {
        return () => {
          throw new Error('settings actions must never reach Discord');
        };
      },
    }) as ActionContext['discord'],
    roleKeys: new Map(),
    channelKeys: new Map(),
    enabled: over.enabled ?? new Set(['settings.get', 'settings.set']),
    store: new InternalActionStore(testDb.db),
    settings: over.settings === undefined ? store : over.settings,
  });
  servers.push(srv);
  return srv;
}

async function signed(
  srv: InternalServer,
  body: Record<string, unknown>,
  opts: { secret?: string; idempotencyKey?: string; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = Buffer.from(opts.raw ?? JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-two-key-id': KEY_ID,
    'x-two-timestamp': timestamp,
    'x-two-nonce': nonce,
    'x-two-signature': sign(opts.secret ?? SECRET, timestamp, nonce, raw),
  };
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(srv.url, { method: 'POST', headers, body: raw });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function newKey(): string {
  return `tog4230-${randomBytes(12).toString('hex')}`;
}

test('signed settings.set persists, audits, refreshes the cache and reaches the consumer', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store);
  assert.equal(liveCfgOf(store).raidJoinThreshold, 5, 'the environment value is the starting point');

  const get0 = await signed(srv, { action: 'settings.get', key: KEY });
  assert.equal(get0.status, 200);
  assert.deepEqual((get0.body.result as object), { key: KEY, value: null, source: 'unset' });

  const set = await signed(
    srv,
    { action: 'settings.set', key: KEY, value: '7', updated_by: ADMIN },
    { idempotencyKey: newKey() },
  );
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.result, { key: KEY, outcome: 'saved' });

  // Persisted audit, with the Filament actor and a timestamp - the row the
  // dashboard's history reads, not a log line.
  const audit = await testDb.db
    .prepare(
      `SELECT old_value, new_value, actor, at FROM guild_settings_audit WHERE guild_id = ? AND key = ?`,
    )
    .get<{ old_value: unknown; new_value: unknown; actor: string; at: string }>(GUILD, KEY);
  assert.deepEqual(
    audit && { old_value: audit.old_value, new_value: audit.new_value, actor: audit.actor },
    { old_value: null, new_value: '7', actor: ADMIN },
  );
  assert.ok(Number.isFinite(Date.parse(audit?.at ?? '')), 'the audit row must carry a timestamp');

  // The write lands in the table, not the cache: the running consumer still
  // sees the old value until the poll runs. That is the documented contract
  // (default 15s), asserted here so a future "synchronous refresh" change has
  // to update this test rather than silently changing read-your-write.
  assert.equal(store.get(GUILD, KEY), undefined, 'the cache is untouched until the poll');
  assert.equal(liveCfgOf(store).raidJoinThreshold, 5, 'so is the consumer');
  assert.equal(await store.refreshIfChanged(), true, 'the version poll saw the write');

  const get1 = await signed(srv, { action: 'settings.get', key: KEY });
  assert.equal(get1.status, 200);
  assert.deepEqual(get1.body.result, { key: KEY, value: '7', source: 'store' });
  assert.equal(liveCfgOf(store).raidJoinThreshold, 7, 'the store beat the environment');
});

test('settings.set with null unsets the key and hands it back to the environment', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store);

  const save = await signed(
    srv,
    { action: 'settings.set', key: KEY, value: '7', updated_by: ADMIN },
    { idempotencyKey: newKey() },
  );
  assert.equal(save.status, 200);
  assert.equal(await store.refreshIfChanged(), true);
  assert.equal(liveCfgOf(store).raidJoinThreshold, 7);

  const unset = await signed(
    srv,
    { action: 'settings.set', key: KEY, value: null, updated_by: ADMIN },
    { idempotencyKey: newKey() },
  );
  assert.equal(unset.status, 200);
  assert.deepEqual(unset.body.result, { key: KEY, outcome: 'unset' });
  assert.equal(await store.refreshIfChanged(), true, 'the delete reaches the poll via the row count');

  const get = await signed(srv, { action: 'settings.get', key: KEY });
  assert.deepEqual(get.body.result, { key: KEY, value: null, source: 'unset' });
  assert.equal(liveCfgOf(store).raidJoinThreshold, 5, 'back to the environment value');
});

test('an unwired server refuses both verbs with the TOG-4104 typed refusal', async () => {
  // The exact failure this card repairs, pinned at the wire level: enabled
  // flags alone must never serve settings.
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store, { settings: null });

  for (const body of [
    { action: 'settings.get', key: KEY },
    { action: 'settings.set', key: KEY, value: '7', updated_by: ADMIN },
  ]) {
    const res = await signed(srv, body, { idempotencyKey: newKey() });
    assert.equal(res.status, 403);
    assert.equal((res.body.error as { code?: string })?.code, 'action_not_allowed');
    assert.equal((res.body.error as { retryable?: boolean })?.retryable, false);
  }

  const rows = await testDb.db
    .prepare(`SELECT count(*)::int AS n FROM guild_settings`)
    .get<{ n: number }>();
  assert.equal(rows?.n, 0, 'the refused write stored nothing');
});

test('disabled verbs stay disabled even with the store wired', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store, { enabled: new Set(['role.assign']) });

  const res = await signed(srv, { action: 'settings.get', key: KEY });
  assert.equal(res.status, 403);
  assert.equal((res.body.error as { code?: string })?.code, 'action_not_allowed');
});

test('env-only keys are refused at the wire and never reach the store', async () => {
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store);

  const res = await signed(
    srv,
    { action: 'settings.set', key: 'TWO_INTERNAL_KEYS', value: 'x', updated_by: ADMIN },
    { idempotencyKey: newKey() },
  );
  assert.equal(res.status, 403);
  assert.equal((res.body.error as { code?: string })?.code, 'action_not_allowed');

  const rows = await testDb.db
    .prepare(`SELECT count(*)::int AS n FROM guild_settings`)
    .get<{ n: number }>();
  assert.equal(rows?.n, 0, 'the refused key left no row');
  const audits = await testDb.db
    .prepare(`SELECT count(*)::int AS n FROM guild_settings_audit`)
    .get<{ n: number }>();
  assert.equal(audits?.n, 0, 'and no audit row');
});

test('a bad signature is the bot HMAC 401, not website authorization evidence', async () => {
  // This pins the bot's own auth contract (code, message, non-retryable).
  // Website non-admin denial is a separate claim needing staging website
  // route evidence; nothing here asserts it.
  const store = new SettingsStore(testDb.db);
  await store.load();
  const srv = await startWired(store);

  const res = await signed(
    srv,
    { action: 'settings.get', key: KEY },
    { secret: WRONG_SECRET },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(res.body.error, {
    code: 'unauthorized',
    message: 'Signature verification failed',
    retryable: false,
  });
});
