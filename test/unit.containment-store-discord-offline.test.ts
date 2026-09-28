/**
 * TOG-9140: containmentStore + containmentDiscord offline suite.
 *
 * Hermetic by construction: node:sqlite behind the narrow `Db` surface (the
 * one Postgres-ism in the store path, `pg_advisory_xact_lock`, is emulated as
 * a no-op — the suite is single-threaded so there is no rival transaction to
 * serialize against), a controllable clock, and a FakeDiscordTransport injected
 * as `fetchImpl`. A global fetch trap fails the run on any real network call,
 * and every quarantine path asserts its transport counters explicitly — zero
 * live Discord sends, zero live guild writes.
 *
 * Runs without Postgres or a token:
 *   node --test test/unit.containment-store-discord-offline.test.ts
 *
 * Pins:
 * - claimEvent dedupe, sliding-window heat (stale excluded, reverse-delivered
 *   counted at occurrence time), future-entry refusal, null-executor and
 *   non-observe passthrough
 * - beginIncident single-winner lease, heat-window cooldown retry, uncertain
 *   durable lockout, completeIncident terminal states + result payload
 * - recordJoinRisk dedupe, burst scoring, flag threshold, bulk-window suppression
 * - quarantine happy path (dangerous-only removal, reason header), @everyone
 *   exclusion, managed/hierarchy refusal before any write, 404-tolerant
 *   removal, partial-failure QuarantineError, 403/429/5xx mapping, timeout and
 *   unreachable mapping
 * - end-to-end observe -> quarantine -> announce for contained / dry_run /
 *   refused / uncertain with the real ContainmentDiscord on the fake transport
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ContainmentStore, type ContainmentEventRow } from '../src/moderation/containmentStore.ts';
import {
  ContainmentDiscord,
  QuarantineError,
} from '../src/moderation/containmentDiscord.ts';
import { DestructiveContainment, type ContainmentAlert } from '../src/moderation/containment.ts';
import type { ContainmentConfig } from '../src/moderation/containmentConfig.ts';
import { ActionError } from '../src/internal/errors.ts';
import type { Db, Statement } from '../src/store/driver.ts';

const GUILD = '1545644954272137297';
const EXECUTOR = '111111111111111111';
const BOT = '1469137636663758888';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

before(() => {
  // Pin the hermetic guarantee: this suite must stay green with no database.
  delete process.env.TWO_TEST_DATABASE_URL;
});

// --- zero-live-call trap ------------------------------------------------------
// ContainmentDiscord always uses the injected fetchImpl, so the global fetch
// must never fire. Silence at the end of the suite is the pass.

const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`TOG-9140: offline suite attempted a network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});

// --- offline Db over node:sqlite ----------------------------------------------
// Mirrors migrations/0015_anti_nuke_containment.sql in sqlite types. The store
// path is plain SQL with `?` placeholders, ISO-8601 comparisons and
// ON CONFLICT DO NOTHING, all of which run unmodified on modern sqlite.

function wrapStatement(db: DatabaseSync, sql: string): Statement {
  if (sql.includes('pg_advisory_xact_lock')) {
    return {
      get: async <T>(): Promise<T | undefined> => ({}) as T,
      all: async <T>(): Promise<T[]> => [],
      run: async () => ({ changes: 0 }),
    };
  }
  const stmt = db.prepare(sql);
  return {
    get: async <T>(...params: unknown[]): Promise<T | undefined> =>
      stmt.get(...(params as never[])) as T | undefined,
    all: async <T>(...params: unknown[]): Promise<T[]> =>
      stmt.all(...(params as never[])) as T[],
    run: async (...params: unknown[]): Promise<{ changes: number }> => {
      const r = stmt.run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
  };
}

function openOfflineDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE containment_events (
    audit_entry_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, executor_id TEXT,
    action TEXT NOT NULL, target_id TEXT, weight INTEGER NOT NULL,
    occurred_at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE containment_incidents (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, executor_id TEXT NOT NULL,
    trigger_audit_entry_id TEXT NOT NULL UNIQUE, heat INTEGER NOT NULL,
    state TEXT NOT NULL, result_json TEXT, started_at TEXT NOT NULL,
    cooldown_until TEXT, completed_at TEXT)`);
  db.exec(`CREATE TABLE join_risk_flags (
    event_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    account_created_at TEXT NOT NULL, joined_at TEXT NOT NULL, source TEXT NOT NULL,
    score INTEGER NOT NULL, reasons_json TEXT NOT NULL,
    bulk_join_window INTEGER NOT NULL, flagged INTEGER NOT NULL,
    created_at TEXT NOT NULL)`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

function claimRow(auditEntryId: string, overrides: Partial<ContainmentEventRow> = {}): ContainmentEventRow {
  return {
    auditEntryId,
    guildId: GUILD,
    executorId: EXECUTOR,
    action: 'member.kick',
    targetId: `target-${auditEntryId}`,
    weight: 1,
    occurredAt: new Date(NOW).toISOString(),
    state: 'observe',
    reason: 'counted toward destructive-action heat',
    ...overrides,
  };
}

// --- fake Discord transport (no sends) ----------------------------------------

interface FakeRole {
  id: string;
  position: number;
  permissions: string;
  managed?: boolean;
}

interface TransportOptions {
  memberRoles?: string[];
  botRoles?: string[];
  roles?: FakeRole[];
  memberStatus?: number;
  rolesStatus?: number;
  /** Per-role DELETE outcome; default is 204. Return 404/500 to script failures. */
  deleteStatus?: (roleId: string) => number;
  hang?: boolean;
  throwError?: unknown;
}

interface RecordedCall {
  method: string;
  path: string;
  reason: string | null;
}

function fakeTransport(options: TransportOptions = {}): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  deletes: string[];
} {
  const calls: RecordedCall[] = [];
  const deletes: string[] = [];
  const fetchImpl = (async (input: unknown, init: unknown) => {
    if (options.throwError !== undefined) throw options.throwError;
    const { method = 'GET', headers, signal } = (init ?? {}) as {
      method?: string;
      headers?: HeadersInit;
      signal?: AbortSignal | null;
    };
    if (options.hang) {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const url = new URL(String(input));
    const path = url.pathname;
    const reason = new Headers(headers as HeadersInit).get('x-audit-log-reason');
    calls.push({ method, path, reason });
    const json = (value: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...extraHeaders },
      });
    if (method === 'DELETE') {
      const roleId = path.split('/').pop() ?? '';
      deletes.push(roleId);
      const status = options.deleteStatus?.(roleId) ?? 204;
      return new Response(null, { status });
    }
    if (path.endsWith(`/members/${EXECUTOR}`)) {
      if ((options.memberStatus ?? 200) !== 200) return json({}, options.memberStatus ?? 200);
      return json({ roles: options.memberRoles ?? [] });
    }
    if (path.endsWith(`/members/${BOT}`)) {
      return json({ roles: options.botRoles ?? ['owen'] });
    }
    if (path.endsWith('/roles')) {
      if ((options.rolesStatus ?? 200) !== 200) {
        return options.rolesStatus === 429
          ? json({}, 429, { 'retry-after': '7' })
          : json({}, options.rolesStatus ?? 200);
      }
      return json(options.roles ?? []);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, deletes };
}

const ADMIN = String(1n << 3n);
const MANAGE_ROLES = String(1n << 28n);

function standardRoles(): FakeRole[] {
  return [
    { id: 'safe', position: 1, permissions: '2048' },
    { id: 'danger', position: 2, permissions: MANAGE_ROLES },
    { id: 'owen', position: 10, permissions: MANAGE_ROLES },
  ];
}

// --- claimEvent transitions ----------------------------------------------------

test('claimEvent: first claim wins, redelivery dedupes with zero heat', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    const first = await store.claimEvent(claimRow('a'), 60);
    assert.deepEqual(first, { claimed: true, heat: 1 });
    const second = await store.claimEvent(claimRow('a'), 60);
    assert.deepEqual(second, { claimed: false, heat: 0 });
  } finally {
    await db.close();
  }
});

test('claimEvent: sliding window excludes stale occurrences', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    for (let index = 0; index < 4; index++) {
      await store.claimEvent(
        claimRow(`old-${index}`, { occurredAt: new Date(NOW - 119_000 + index).toISOString() }),
        60,
      );
    }
    const fresh = await store.claimEvent(claimRow('fresh'), 60);
    assert.deepEqual(fresh, { claimed: true, heat: 1 });
  } finally {
    await db.close();
  }
});

test('claimEvent: reverse-delivered entries count heat at occurrence time', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    const newest = await store.claimEvent(
      claimRow('newest', { action: 'channel.delete', weight: 3, occurredAt: new Date(NOW - 1_000).toISOString() }),
      60,
    );
    assert.equal(newest.heat, 3);
    const middle = await store.claimEvent(
      claimRow('middle', { occurredAt: new Date(NOW - 2_000).toISOString() }),
      60,
    );
    assert.equal(middle.heat, 4);
    const oldest = await store.claimEvent(
      claimRow('oldest', { occurredAt: new Date(NOW - 3_000).toISOString() }),
      60,
    );
    assert.equal(oldest.heat, 5);
  } finally {
    await db.close();
  }
});

test('claimEvent: future entries are refused and never add heat', async () => {
  const db = openOfflineDb();
  try {
    let clock = NOW;
    const store = new ContainmentStore(db, () => clock);
    const future = await store.claimEvent(
      claimRow('future', { action: 'channel.delete', weight: 3, occurredAt: new Date(NOW + 6_000).toISOString() }),
      60,
    );
    assert.deepEqual(future, { claimed: true, heat: 0 });
    const row = await db.prepare(
      'SELECT state, reason FROM containment_events WHERE audit_entry_id = ?',
    ).get<{ state: string; reason: string }>('future');
    assert.equal(row?.state, 'ignored');
    assert.match(row?.reason ?? '', /more than 5 seconds in the future/);
    clock += 1_001;
    const fresh = await store.claimEvent(
      claimRow('fresh-a', { occurredAt: new Date(clock).toISOString() }),
      60,
    );
    assert.equal(fresh.heat, 1, 'the refused future entry contributes nothing');
  } finally {
    await db.close();
  }
});

test('claimEvent: null executor and non-observe states pass through with zero heat', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    assert.deepEqual(
      await store.claimEvent(claimRow('no-exec', { executorId: null }), 60),
      { claimed: true, heat: 0 },
    );
    assert.deepEqual(
      await store.claimEvent(claimRow('stale-row', { state: 'stale', reason: 'too old' }), 60),
      { claimed: true, heat: 0 },
    );
    const rows = await db.prepare(
      'SELECT audit_entry_id, state FROM containment_events ORDER BY audit_entry_id',
    ).all<{ audit_entry_id: string; state: string }>();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { audit_entry_id: 'no-exec', state: 'observe' },
      { audit_entry_id: 'stale-row', state: 'stale' },
    ]);
  } finally {
    await db.close();
  }
});

// --- beginIncident / completeIncident transitions -------------------------------

test('beginIncident: single winner, cooldown retry after the heat window', async () => {
  const db = openOfflineDb();
  try {
    let clock = NOW;
    const store = new ContainmentStore(db, () => clock);
    await store.claimEvent(claimRow('first'), 1);
    assert.equal(await store.beginIncident(GUILD, EXECUTOR, 'first', 3, 1), true);
    assert.equal(await store.beginIncident(GUILD, EXECUTOR, 'first', 3, 1), false);
    await store.completeIncident('first', 'contained', { removedRoleIds: ['danger'] });

    clock += 2_000;
    await store.claimEvent(claimRow('later', { occurredAt: new Date(clock).toISOString() }), 1);
    assert.equal(await store.beginIncident(GUILD, EXECUTOR, 'later', 3, 1), true);
    const trigger = await store.claimEvent(claimRow('later'), 1);
    assert.deepEqual(trigger, { claimed: false, heat: 0 });
  } finally {
    await db.close();
  }
});

test('beginIncident: an uncertain incident keeps its durable lockout past cooldown', async () => {
  const db = openOfflineDb();
  try {
    let clock = NOW;
    const store = new ContainmentStore(db, () => clock);
    await store.claimEvent(claimRow('first'), 1);
    assert.equal(await store.beginIncident(GUILD, EXECUTOR, 'first', 3, 1), true);
    await store.completeIncident('first', 'uncertain', { error: 'unknown delivery outcome' });
    clock += 2_000;
    await store.claimEvent(claimRow('later', { occurredAt: new Date(clock).toISOString() }), 1);
    assert.equal(await store.beginIncident(GUILD, EXECUTOR, 'later', 3, 1), false);
  } finally {
    await db.close();
  }
});

test('completeIncident: every terminal state persists with its result payload', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    const states = ['contained', 'dry_run', 'refused', 'uncertain', 'failed'] as const;
    for (const state of states) {
      const executor = `exec-${state}`;
      await store.claimEvent(claimRow(`trigger-${state}`, { executorId: executor }), 60);
      assert.equal(await store.beginIncident(GUILD, executor, `trigger-${state}`, 5, 60), true);
      await store.completeIncident(`trigger-${state}`, state, { marker: state });
    }
    const rows = await db.prepare(
      'SELECT id, state, result_json FROM containment_incidents ORDER BY id',
    ).all<{ id: string; state: string; result_json: string }>();
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, state: row.state, result: JSON.parse(row.result_json) })),
      [...states]
        .sort((a, b) => `trigger-${a}`.localeCompare(`trigger-${b}`))
        .map((state) => ({ id: `trigger-${state}`, state, result: { marker: state } })),
    );
  } finally {
    await db.close();
  }
});

// --- recordJoinRisk transitions --------------------------------------------------

test('recordJoinRisk: redelivery dedupes, burst scores, bulk window suppresses', async () => {
  const db = openOfflineDb();
  try {
    const store = new ContainmentStore(db, () => NOW);
    const input = {
      eventId: 'join-0',
      guildId: GUILD,
      memberId: 'member-0',
      accountCreatedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
      joinedAt: new Date(NOW).toISOString(),
      source: 'unknown',
      accountScore: 1,
      accountReasons: ['account younger than 7 days'],
      bulkJoinWindow: false,
      windowSeconds: 60,
      joinThreshold: 5,
    };
    const first = await store.recordJoinRisk(input);
    assert.deepEqual(first, {
      persisted: true,
      score: 1,
      reasons: ['account younger than 7 days'],
      flagged: false,
    });
    assert.deepEqual(
      await store.recordJoinRisk(input),
      { persisted: false, score: 0, reasons: [], flagged: false },
    );
    for (let index = 1; index < 4; index++) {
      const row = await store.recordJoinRisk({ ...input, eventId: `join-${index}`, memberId: `member-${index}` });
      assert.equal(row.flagged, false, `join ${index} stays below the burst threshold`);
    }
    const burst = await store.recordJoinRisk({ ...input, eventId: 'join-4', memberId: 'member-4' });
    assert.equal(burst.score, 3, '5th join inside the window adds the +2 burst bonus');
    assert.deepEqual(burst.reasons, ['account younger than 7 days', '5 joins inside 60s']);
    assert.equal(burst.flagged, true);

    const bulk = await store.recordJoinRisk({
      ...input,
      eventId: 'join-bulk',
      memberId: 'member-bulk',
      accountScore: 3,
      accountReasons: ['account younger than 24 hours'],
      bulkJoinWindow: true,
    });
    assert.equal(bulk.persisted, true);
    assert.equal(bulk.flagged, false, 'bulk window records risk but never flags');
  } finally {
    await db.close();
  }
});

// --- quarantine matrix on the fake transport --------------------------------------

test('quarantine removes only dangerous roles below Owen and stamps the reason', async () => {
  const { fetchImpl, calls, deletes } = fakeTransport({
    memberRoles: ['safe', 'danger'],
    botRoles: ['owen'],
    roles: standardRoles(),
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  const result = await discord.quarantine(GUILD, EXECUTOR, 'incident heat 5/3');
  assert.deepEqual(result, { removedRoleIds: ['danger'], skippedRoleIds: [] });
  assert.deepEqual(deletes, ['danger']);
  const removal = calls.find((call) => call.method === 'DELETE');
  assert.ok(removal?.reason, 'removal carries the audit-log reason');
  assert.ok(!removal?.reason?.includes(' '), 'reason is URI-encoded for the header');
});

test('quarantine removes several dangerous roles and tolerates a 404 midway', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: ['d1', 'd2'],
    botRoles: ['owen'],
    roles: [
      { id: 'd1', position: 1, permissions: MANAGE_ROLES },
      { id: 'd2', position: 2, permissions: ADMIN },
      { id: 'owen', position: 10, permissions: MANAGE_ROLES },
    ],
    deleteStatus: (roleId) => (roleId === 'd2' ? 404 : 204),
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  const result = await discord.quarantine(GUILD, EXECUTOR, 'incident');
  assert.deepEqual(result, { removedRoleIds: ['d1', 'd2'], skippedRoleIds: [] });
  assert.deepEqual(deletes, ['d1', 'd2']);
});

test('quarantine with no dangerous roles writes nothing', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: ['safe'],
    botRoles: ['owen'],
    roles: standardRoles(),
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  assert.deepEqual(await discord.quarantine(GUILD, EXECUTOR, 'incident'), {
    removedRoleIds: [],
    skippedRoleIds: [],
  });
  assert.deepEqual(deletes, []);
});

test('quarantine never touches @everyone even when it carries dangerous bits', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: [GUILD],
    botRoles: ['owen'],
    roles: [
      { id: GUILD, position: 0, permissions: ADMIN },
      { id: 'owen', position: 10, permissions: MANAGE_ROLES },
    ],
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  assert.deepEqual(await discord.quarantine(GUILD, EXECUTOR, 'incident'), {
    removedRoleIds: [],
    skippedRoleIds: [],
  });
  assert.deepEqual(deletes, []);
});

test('quarantine refuses before any write when a role is managed', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: ['managed-danger'],
    botRoles: ['owen'],
    roles: [
      { id: 'managed-danger', position: 1, permissions: MANAGE_ROLES, managed: true },
      { id: 'owen', position: 10, permissions: MANAGE_ROLES },
    ],
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  await assert.rejects(() => discord.quarantine(GUILD, EXECUTOR, 'incident'), /cannot safely remove every dangerous role/);
  assert.deepEqual(deletes, [], 'refusal happens before the first role write');
});

test('quarantine refuses before any write when a role outranks Owen', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: ['danger'],
    botRoles: ['owen'],
    roles: [
      { id: 'danger', position: 10, permissions: ADMIN },
      { id: 'owen', position: 5, permissions: MANAGE_ROLES },
    ],
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  await assert.rejects(() => discord.quarantine(GUILD, EXECUTOR, 'incident'), /cannot safely remove every dangerous role/);
  assert.deepEqual(deletes, []);
});

test('quarantine surfaces a partial removal before the failing write', async () => {
  const { fetchImpl, deletes } = fakeTransport({
    memberRoles: ['d1', 'd2'],
    botRoles: ['owen'],
    roles: [
      { id: 'd1', position: 1, permissions: MANAGE_ROLES },
      { id: 'd2', position: 2, permissions: MANAGE_ROLES },
      { id: 'owen', position: 10, permissions: MANAGE_ROLES },
    ],
    deleteStatus: (roleId) => (roleId === 'd2' ? 500 : 204),
  });
  const discord = new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl });
  const error = await discord.quarantine(GUILD, EXECUTOR, 'incident').then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(error instanceof QuarantineError);
  assert.deepEqual(error.removedRoleIds, ['d1']);
  assert.deepEqual(deletes, ['d1', 'd2']);
});

test('quarantine maps transport failures to typed ActionErrors', async () => {
  const base = 'http://fake.local/api/v10';
  const opts = { token: 'test', botUserId: BOT, base };

  const refused = fakeTransport({ memberStatus: 403 });
  await assert.rejects(
    new ContainmentDiscord({ ...opts, fetchImpl: refused.fetchImpl }).quarantine(GUILD, EXECUTOR, 'incident'),
    (err: unknown) => err instanceof ActionError && err.code === 'discord_rejected',
  );

  const limited = fakeTransport({ rolesStatus: 429 });
  const rateError = await new ContainmentDiscord({ ...opts, fetchImpl: limited.fetchImpl })
    .quarantine(GUILD, EXECUTOR, 'incident').then(
      () => null,
      (err: unknown) => err,
    );
  assert.ok(rateError instanceof ActionError && rateError.code === 'rate_limited');
  assert.equal(rateError.retryAfter, 7);

  const broken = fakeTransport({ rolesStatus: 500 });
  await assert.rejects(
    new ContainmentDiscord({ ...opts, fetchImpl: broken.fetchImpl }).quarantine(GUILD, EXECUTOR, 'incident'),
    (err: unknown) => err instanceof ActionError && err.code === 'discord_unavailable',
  );

  const hanging = fakeTransport({
    memberRoles: ['danger'],
    botRoles: ['owen'],
    roles: standardRoles(),
    hang: true,
  });
  await assert.rejects(
    new ContainmentDiscord({ ...opts, fetchImpl: hanging.fetchImpl, timeoutMs: 30 })
      .quarantine(GUILD, EXECUTOR, 'incident'),
    (err: unknown) => err instanceof ActionError && err.code === 'upstream_timeout',
  );

  const down = fakeTransport({ throwError: new Error('connection refused') });
  await assert.rejects(
    new ContainmentDiscord({ ...opts, fetchImpl: down.fetchImpl }).quarantine(GUILD, EXECUTOR, 'incident'),
    (err: unknown) => err instanceof ActionError && err.code === 'discord_unavailable',
  );
});

// --- end-to-end observe -> quarantine -> announce ----------------------------------

function e2eConfig(overrides: Partial<ContainmentConfig> = {}): ContainmentConfig {
  return {
    enabled: true,
    dryRun: false,
    guildId: GUILD,
    botUserId: BOT,
    protectedUserIds: new Set([BOT]),
    trustedUserIds: new Set(),
    alertChannelId: null,
    snapshotPath: null,
    windowSeconds: 60,
    heatThreshold: 3,
    eventMaxAgeSeconds: 120,
    joinRiskWindowSeconds: 60,
    joinRiskThreshold: 5,
    bulkJoinWindowUntil: null,
    ...overrides,
  };
}

function destructiveEvent(auditEntryId: string, action: 'member.kick' | 'channel.delete' = 'channel.delete') {
  return {
    auditEntryId,
    guildId: GUILD,
    executorId: EXECUTOR,
    action,
    targetId: `target-${auditEntryId}`,
    occurredAt: new Date(NOW).toISOString(),
    weight: action === 'channel.delete' ? 3 : 1,
  } as const;
}

test('announce path: contained incident quarantines over the fake transport', async () => {
  const db = openOfflineDb();
  try {
    const { fetchImpl, deletes } = fakeTransport({
      memberRoles: ['danger'],
      botRoles: ['owen'],
      roles: standardRoles(),
    });
    const alerts: ContainmentAlert[] = [];
    const containment = new DestructiveContainment({
      store: new ContainmentStore(db, () => NOW),
      discord: new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl }),
      config: e2eConfig(),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await containment.observe(destructiveEvent('trigger'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outcome, 'contained');
    assert.deepEqual(alerts[0].removedRoleIds, ['danger']);
    assert.deepEqual(deletes, ['danger']);
    const incident = await db.prepare(
      'SELECT state, heat FROM containment_incidents',
    ).get<{ state: string; heat: number }>();
    assert.deepEqual({ ...incident }, { state: 'contained', heat: 3 });
  } finally {
    await db.close();
  }
});

test('announce path: dry run records without touching the transport', async () => {
  const db = openOfflineDb();
  try {
    const { fetchImpl, deletes } = fakeTransport({
      memberRoles: ['danger'],
      botRoles: ['owen'],
      roles: standardRoles(),
    });
    const alerts: ContainmentAlert[] = [];
    const containment = new DestructiveContainment({
      store: new ContainmentStore(db, () => NOW),
      discord: new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl }),
      config: e2eConfig({ dryRun: true }),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await containment.observe(destructiveEvent('dry-trigger'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outcome, 'dry_run');
    assert.deepEqual(deletes, [], 'dry run never reaches the transport');
    const incident = await db.prepare(
      'SELECT state FROM containment_incidents',
    ).get<{ state: string }>();
    assert.equal(incident?.state, 'dry_run');
  } finally {
    await db.close();
  }
});

test('announce path: hierarchy refusal announces refused with zero writes', async () => {
  const db = openOfflineDb();
  try {
    const { fetchImpl, deletes } = fakeTransport({
      memberRoles: ['danger'],
      botRoles: ['owen'],
      roles: [
        { id: 'danger', position: 10, permissions: ADMIN },
        { id: 'owen', position: 5, permissions: MANAGE_ROLES },
      ],
    });
    const alerts: ContainmentAlert[] = [];
    const containment = new DestructiveContainment({
      store: new ContainmentStore(db, () => NOW),
      discord: new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl }),
      config: e2eConfig(),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await containment.observe(destructiveEvent('refused-trigger'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outcome, 'refused');
    assert.deepEqual(deletes, []);
    const incident = await db.prepare(
      'SELECT state FROM containment_incidents',
    ).get<{ state: string }>();
    assert.equal(incident?.state, 'refused');
  } finally {
    await db.close();
  }
});

test('announce path: Discord 5xx mid-quarantine announces uncertain', async () => {
  const db = openOfflineDb();
  try {
    const { fetchImpl, deletes } = fakeTransport({
      memberRoles: ['danger'],
      botRoles: ['owen'],
      roles: standardRoles(),
      deleteStatus: () => 500,
    });
    const alerts: ContainmentAlert[] = [];
    const containment = new DestructiveContainment({
      store: new ContainmentStore(db, () => NOW),
      discord: new ContainmentDiscord({ token: 'test', botUserId: BOT, base: 'http://fake.local/api/v10', fetchImpl }),
      config: e2eConfig(),
      announce: async (alert) => void alerts.push(alert),
      now: () => NOW,
    });
    await containment.observe(destructiveEvent('uncertain-trigger'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].outcome, 'uncertain');
    assert.deepEqual(deletes, ['danger'], 'the attempt reached the fake transport only');
    const incident = await db.prepare(
      'SELECT state FROM containment_incidents',
    ).get<{ state: string }>();
    assert.equal(incident?.state, 'uncertain');
  } finally {
    await db.close();
  }
});

// --- the zero-live-call pin ---------------------------------------------------------

test('offline suite made zero live network calls', () => {
  globalThis.fetch = originalFetch;
  assert.deepEqual(fetchCalls, [], 'every transport in this file is a fake');
});
