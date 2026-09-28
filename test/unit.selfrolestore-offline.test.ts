/**
 * TOG-9123: SelfRoleStore unit tests on an in-memory sqlite fake.
 *
 * Hermetic by construction: node:sqlite behind the narrow `Db` surface, with
 * a controllable clock. No Postgres, no TWO_TEST_DATABASE_URL:
 *   node --test test/unit.selfrolestore-offline.test.ts
 *
 * Pins:
 * - audit commit path (first claim wins, gateway redelivery dedupes)
 * - audit claim/recovery path (expired leases fence to generation+1 with the
 *   persisted desired/pre-mutation intent, not the redelivered row)
 * - owns/renew/finish/updateAuditEffects lease semantics
 * - panel lane exclusivity + ordering guarantees from the
 *   self_role_ordering (0020) / self_role_event_order (0021) migrations:
 *   older events supersede, newer events advance chronology without
 *   publishing an uncommitted option, the lane winner rejects older
 *   processing audits, and legacy NULL-order claims backfill from snowflakes
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SelfRoleStore } from '../src/store/selfRoleStore.ts';
import type { Db, Statement } from '../src/store/db.ts';
import type { SelfRoleAuditRow } from '../src/selfRoles/types.ts';

const GUILD = '111111111111111111';
const MEMBER = '222222222222222222';
const PANEL = 'colors';
const MSG = '333333333333333333';
const ROLE_A = '444444444444444444';
const ROLE_B = '555555555555555555';

before(() => {
  // Pin the hermetic guarantee: this suite must stay green with no database.
  delete process.env.TWO_TEST_DATABASE_URL;
});

// --- offline Db over node:sqlite -------------------------------------------
// Mirrors migrations 0018/0019/0020/0021/0022 in sqlite types. The store path
// is plain SQL with `?` placeholders and ISO-8601 lease comparisons, so the
// only Postgres-isms (TRUE literals, ON CONFLICT ... RETURNING) already run
// unmodified on modern sqlite.

function wrapStatement(db: DatabaseSync, sql: string): Statement {
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
  db.exec(`CREATE TABLE self_role_audit (
    event_id TEXT PRIMARY KEY,
    event_order TEXT,
    guild_id TEXT NOT NULL,
    panel_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    option_key TEXT,
    role_id TEXT,
    source TEXT NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    code TEXT,
    reason TEXT,
    added_role_ids TEXT NOT NULL,
    removed_role_ids TEXT NOT NULL,
    attempted_added_role_ids TEXT NOT NULL DEFAULT '[]',
    attempted_removed_role_ids TEXT NOT NULL DEFAULT '[]',
    compensated_added_role_ids TEXT NOT NULL DEFAULT '[]',
    compensated_removed_role_ids TEXT NOT NULL DEFAULT '[]',
    unresolved_added_role_ids TEXT NOT NULL DEFAULT '[]',
    unresolved_removed_role_ids TEXT NOT NULL DEFAULT '[]',
    desired_role_ids TEXT NOT NULL DEFAULT '[]',
    pre_mutation_role_ids TEXT NOT NULL DEFAULT '[]',
    claim_token TEXT,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    processing_expires_at TEXT,
    created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE self_role_panel_claims (
    guild_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    panel_id TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    claim_generation INTEGER NOT NULL,
    processing_expires_at TEXT NOT NULL,
    latest_event_id TEXT,
    latest_option_key TEXT,
    latest_event_order TEXT,
    target_committed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, member_id, panel_id))`);
  const facade: Db = {
    prepare: (sql) => wrapStatement(db, sql),
    exec: async (sql) => { db.exec(sql); },
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(facade),
    close: async () => { db.close(); },
  };
  return facade;
}

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Mirrors the store's private snowflake ordering (migration 0021). */
function orderOf(snowflake: string): string {
  const ts = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
  return `${ts.toString().padStart(13, '0')}:${snowflake.padStart(20, '0')}`;
}

function auditRow(eventId: string, overrides: Partial<SelfRoleAuditRow> = {}): SelfRoleAuditRow {
  return {
    eventId,
    guildId: GUILD,
    panelId: PANEL,
    memberId: MEMBER,
    sourceId: MSG,
    optionKey: 'red',
    roleId: ROLE_A,
    source: 'button',
    operation: 'add',
    outcome: 'assigned',
    code: null,
    reason: null,
    desiredRoleIds: [ROLE_A],
    preMutationRoleIds: [],
    addedRoleIds: [ROLE_A],
    removedRoleIds: [],
    attemptedAddedRoleIds: [ROLE_A],
    attemptedRemovedRoleIds: [],
    compensatedAddedRoleIds: [],
    compensatedRemovedRoleIds: [],
    unresolvedAddedRoleIds: [],
    unresolvedRemovedRoleIds: [],
    ...overrides,
  };
}

async function reset(db: Db) {
  await db.exec('DELETE FROM self_role_audit; DELETE FROM self_role_panel_claims;');
}

// --- audit commit / claim / recovery ----------------------------------------

test('audit commit: first claim wins and redelivery dedupes while the lease is live', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const first = await store.claimAudit(auditRow('evt-commit'));
    assert.ok(first);
    assert.equal(first.generation, 1);
    assert.equal(first.recovered, false);
    assert.deepEqual(first.desiredRoleIds, [ROLE_A]);
    assert.deepEqual(first.preMutationRoleIds, []);

    now = new Date('2026-09-09T00:00:00.500Z');
    assert.equal(await store.claimAudit(auditRow('evt-commit')), null);
  } finally {
    await db.close();
  }
});

test('audit recovery: an expired lease fences to generation 2 with stored intent', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const first = await store.claimAudit(auditRow('evt-recover'));
    assert.ok(first);

    now = new Date('2026-09-09T00:00:01.001Z');
    // A redelivery carrying fabricated intent must not overwrite the stored one.
    const recovered = await store.claimAudit(
      auditRow('evt-recover', { desiredRoleIds: [ROLE_B], preMutationRoleIds: [ROLE_B] }),
    );
    assert.ok(recovered);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.generation, 2);
    assert.notEqual(recovered.token, first.token);
    assert.deepEqual(recovered.desiredRoleIds, [ROLE_A]);
    assert.deepEqual(recovered.preMutationRoleIds, []);

    // A finished audit is final: no further recovery after commit.
    await store.finishAudit(auditRow('evt-recover'), recovered);
    now = new Date('2026-09-10T00:00:00.000Z');
    assert.equal(await store.claimAudit(auditRow('evt-recover')), null);
  } finally {
    await db.close();
  }
});

test('audit owns/renew: only the live fenced holder passes, renew extends the lease', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const claim = await store.claimAudit(auditRow('evt-lease'));
    assert.ok(claim);
    assert.equal(await store.ownsClaim('evt-lease', claim), true);
    assert.equal(
      await store.ownsClaim('evt-lease', { ...claim, token: 'impostor' }),
      false,
    );

    now = new Date('2026-09-09T00:00:00.900Z');
    assert.equal(await store.renewClaim('evt-lease', claim), true);
    now = new Date('2026-09-09T00:00:01.500Z');
    assert.equal(await store.ownsClaim('evt-lease', claim), true);
    assert.equal(await store.renewClaim('evt-lease', { ...claim, token: 'impostor' }), false);

    now = new Date('2026-09-09T00:00:02.000Z');
    assert.equal(await store.ownsClaim('evt-lease', claim), false);
    assert.equal(await store.renewClaim('evt-lease', claim), false);
  } finally {
    await db.close();
  }
});

test('finishAudit commits the outcome and clears the lease; a stale claim throws', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const claim = await store.claimAudit(auditRow('evt-finish'));
    assert.ok(claim);
    await store.finishAudit(auditRow('evt-finish'), claim);
    const stored = await db.prepare(
      `SELECT outcome, processing_expires_at FROM self_role_audit WHERE event_id = ?`,
    ).get<{ outcome: string; processing_expires_at: string | null }>('evt-finish');
    assert.equal(stored?.outcome, 'assigned');
    assert.equal(stored?.processing_expires_at, null);

    await assert.rejects(store.finishAudit(auditRow('evt-finish'), claim), /claim is stale/);
    await assert.rejects(
      store.finishAudit(auditRow('evt-finish'), { ...claim, token: 'impostor' }),
      /claim is stale/,
    );
  } finally {
    await db.close();
  }
});

test('finishAudit without a claim resolves the live holder; an unclaimed row throws', async () => {
  const db = openOfflineDb();
  try {
    const store = new SelfRoleStore(db);
    const claim = await store.claimAudit(auditRow('evt-implicit'));
    assert.ok(claim);
    await store.finishAudit(auditRow('evt-implicit'));
    const stored = await db.prepare(
      `SELECT outcome FROM self_role_audit WHERE event_id = ?`,
    ).get<{ outcome: string }>('evt-implicit');
    assert.equal(stored?.outcome, 'assigned');

    await assert.rejects(store.finishAudit(auditRow('evt-never-claimed')), /was not claimed/);
  } finally {
    await db.close();
  }
});

test('updateAuditEffects persists effect columns under the live claim only', async () => {
  const db = openOfflineDb();
  try {
    const store = new SelfRoleStore(db);
    const claim = await store.claimAudit(auditRow('evt-effects'));
    assert.ok(claim);
    assert.equal(
      await store.updateAuditEffects(
        auditRow('evt-effects', {
          addedRoleIds: [ROLE_A],
          attemptedAddedRoleIds: [ROLE_A, ROLE_B],
          unresolvedRemovedRoleIds: [ROLE_B],
        }),
        claim,
      ),
      true,
    );
    const stored = await db.prepare(
      `SELECT added_role_ids, attempted_added_role_ids, unresolved_removed_role_ids
         FROM self_role_audit WHERE event_id = ?`,
    ).get<Record<string, string>>('evt-effects');
    assert.deepEqual({ ...stored }, {
      added_role_ids: JSON.stringify([ROLE_A]),
      attempted_added_role_ids: JSON.stringify([ROLE_A, ROLE_B]),
      unresolved_removed_role_ids: JSON.stringify([ROLE_B]),
    });
    assert.equal(
      await store.updateAuditEffects(auditRow('evt-effects'), { ...claim, token: 'impostor' }),
      false,
    );
  } finally {
    await db.close();
  }
});

// --- panel lane exclusivity + ordering (0020/0021) ---------------------------

test('panel lane: exclusive claim blocks rivals until expiry, then fences generation', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const first = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-p1', '0000000000001:000001');
    assert.ok(first && !first.superseded);
    assert.equal(first.generation, 1);
    assert.equal(await store.ownsPanelClaim(first), true);

    now = new Date('2026-09-09T00:00:00.500Z');
    assert.equal(await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-p2', '0000000000002:000001'), null);

    now = new Date('2026-09-09T00:00:01.001Z');
    const recovered = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-p2', '0000000000002:000001');
    assert.ok(recovered && !recovered.superseded);
    assert.equal(recovered.generation, 2);
    assert.equal(await store.ownsPanelClaim(first), false);
    assert.equal(await store.ownsPanelClaim(recovered), true);

    now = new Date('2026-09-09T00:00:01.500Z');
    assert.equal(await store.renewPanelClaim(recovered), true);
    assert.equal(await store.renewPanelClaim(first), false);
  } finally {
    await db.close();
  }
});

test('panel ordering: an older event supersedes while the lane stays on the newer one', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 60_000 });
    const first = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-newer', '0000000000002:000001');
    assert.ok(first && !first.superseded);

    const older = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-older', '0000000000001:000001');
    assert.ok(older?.superseded);
    assert.equal(older.latestEventId, 'evt-newer');
    assert.equal(older.latestEventOrder, '0000000000002:000001');

    const stored = await db.prepare(
      `SELECT latest_event_id, latest_event_order, claim_generation
         FROM self_role_panel_claims WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
    ).get<Record<string, unknown>>(GUILD, MEMBER, PANEL);
    assert.deepEqual({ ...stored }, {
      latest_event_id: 'evt-newer',
      latest_event_order: '0000000000002:000001',
      claim_generation: 1,
    });
  } finally {
    await db.close();
  }
});

test('panel ordering: a newer event advances chronology without publishing its option', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const first = await store.claimPanel(GUILD, MEMBER, PANEL, 'first-red', '0000000000001:000001');
    assert.ok(first && !first.superseded);
    assert.equal(await store.setPanelClaimOption(first, 'red'), true);
    await store.releasePanelClaim(first);

    now = new Date('2026-09-09T00:00:00.001Z');
    const second = await store.claimPanel(GUILD, MEMBER, PANEL, 'second-blue', '0000000000002:000001');
    assert.ok(second && !second.superseded);
    assert.equal(second.latestEventId, 'second-blue');
    // Chronology moved on, but the committed target is still red until blue commits.
    assert.equal(second.latestOptionKey, 'red');
    assert.equal(second.targetCommitted, true);

    // The released first holder can no longer publish.
    assert.equal(await store.setPanelClaimOption(first, 'blue'), false);
    assert.equal(await store.setPanelClaimOption(second, 'blue'), true);
  } finally {
    await db.close();
  }
});

test('panel winner rejects older in-flight processing audits and nulls their leases', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 60_000 });
    assert.ok(await store.claimAudit(auditRow('older-processing', { eventOrder: '0000000000001:000001' })));

    const winner = await store.claimPanel(GUILD, MEMBER, PANEL, 'newer-wins', '0000000000002:000001');
    assert.ok(winner && !winner.superseded);

    const older = await db.prepare(
      `SELECT outcome, code, processing_expires_at FROM self_role_audit WHERE event_id = ?`,
    ).get<Record<string, unknown>>('older-processing');
    assert.deepEqual({ ...older }, {
      outcome: 'rejected',
      code: 'superseded_by_later_event',
      processing_expires_at: null,
    });
  } finally {
    await db.close();
  }
});

test('legacy NULL-order claim backfills event order from the snowflake and rejects older events', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 1_000 });
    const newerEventId = '222222222222222222';
    await db.prepare(
      `INSERT INTO self_role_panel_claims
         (guild_id, member_id, panel_id, claim_token, claim_generation, processing_expires_at,
          latest_event_id, latest_option_key, latest_event_order)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
    ).run(GUILD, MEMBER, PANEL, 'legacy', now.toISOString(), newerEventId, 'blue');

    now = new Date('2026-09-09T00:00:01.001Z');
    const olderEventId = '111111111111111111';
    const claim = await store.claimPanel(GUILD, MEMBER, PANEL, olderEventId, orderOf(olderEventId));
    assert.ok(claim?.superseded);
    assert.equal(claim.latestEventId, newerEventId);
    assert.equal(claim.latestOptionKey, 'blue');

    const stored = await db.prepare(
      `SELECT latest_event_id, latest_option_key, latest_event_order
         FROM self_role_panel_claims WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
    ).get<Record<string, unknown>>(GUILD, MEMBER, PANEL);
    assert.deepEqual({ ...stored }, {
      latest_event_id: newerEventId,
      latest_option_key: 'blue',
      latest_event_order: orderOf(newerEventId),
    });
  } finally {
    await db.close();
  }
});

test('ordering migration columns exist on both tables', async () => {
  const db = openOfflineDb();
  try {
    const auditCols = await db.prepare(`SELECT name FROM pragma_table_info('self_role_audit')`).all<{ name: string }>();
    const claimCols = await db.prepare(`SELECT name FROM pragma_table_info('self_role_panel_claims')`).all<{ name: string }>();
    const auditNames = new Set(auditCols.map((c) => c.name));
    const claimNames = new Set(claimCols.map((c) => c.name));
    assert.ok(auditNames.has('event_order'), '0021 event_order on self_role_audit');
    assert.ok(claimNames.has('latest_event_id'), '0020 latest_event_id on panel claims');
    assert.ok(claimNames.has('latest_event_order'), '0021 latest_event_order on panel claims');
    assert.ok(claimNames.has('target_committed'), '0022 target_committed on panel claims');
  } finally {
    await db.close();
  }
});

// --- combined commit ---------------------------------------------------------

test('finishAuditAndSetPanelOption commits the panel target and audit together', async () => {
  const db = openOfflineDb();
  try {
    const store = new SelfRoleStore(db);
    const auditClaim = await store.claimAudit(auditRow('evt-joint'));
    assert.ok(auditClaim);
    const panelClaim = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-joint', '0000000000001:000001');
    assert.ok(panelClaim && !panelClaim.superseded);

    assert.equal(await store.finishAuditAndSetPanelOption(auditRow('evt-joint'), auditClaim, panelClaim, 'red'), true);
    assert.equal(panelClaim.latestOptionKey, 'red');
    assert.equal(panelClaim.targetCommitted, true);
    const panel = await db.prepare(
      `SELECT latest_option_key, target_committed FROM self_role_panel_claims
        WHERE guild_id = ? AND member_id = ? AND panel_id = ?`,
    ).get<{ latest_option_key: string | null; target_committed: number }>(GUILD, MEMBER, PANEL);
    assert.equal(panel?.latest_option_key, 'red');
    assert.equal(Boolean(panel?.target_committed), true);
    const audit = await db.prepare(
      `SELECT outcome, processing_expires_at FROM self_role_audit WHERE event_id = ?`,
    ).get<{ outcome: string; processing_expires_at: string | null }>('evt-joint');
    assert.equal(audit?.outcome, 'assigned');
    assert.equal(audit?.processing_expires_at, null);

    // A stale panel holder refuses before touching the audit row.
    const auditClaim2 = await store.claimAudit(auditRow('evt-joint-2'));
    assert.ok(auditClaim2);
    assert.equal(
      await store.finishAuditAndSetPanelOption(
        auditRow('evt-joint-2'), auditClaim2, { ...panelClaim, token: 'impostor' }, 'blue',
      ),
      false,
    );
    const untouched = await db.prepare(
      `SELECT outcome FROM self_role_audit WHERE event_id = ?`,
    ).get<{ outcome: string }>('evt-joint-2');
    assert.equal(untouched?.outcome, 'processing');

    // A stale audit claim throws.
    await assert.rejects(
      store.finishAuditAndSetPanelOption(
        auditRow('evt-joint-2'), { ...auditClaim2, token: 'impostor' }, panelClaim, 'blue',
      ),
      /claim is stale/,
    );
  } finally {
    await db.close();
  }
});

test('releasePanelClaim expires the lane so a rival recovers it', async () => {
  const db = openOfflineDb();
  try {
    let now = new Date('2026-09-09T00:00:00.000Z');
    const store = new SelfRoleStore(db, { now: () => now, leaseMs: 60_000 });
    const first = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-rel-1', '0000000000001:000001');
    assert.ok(first && !first.superseded);
    await store.releasePanelClaim(first);

    now = new Date('2026-09-09T00:00:00.001Z');
    const second = await store.claimPanel(GUILD, MEMBER, PANEL, 'evt-rel-2', '0000000000002:000001');
    assert.ok(second && !second.superseded);
    assert.equal(second.generation, 2);
  } finally {
    await db.close();
  }
});

test('offline suite ran with no test database configured', async () => {
  assert.equal(process.env.TWO_TEST_DATABASE_URL, undefined);
  const db = openOfflineDb();
  try {
    await reset(db);
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM self_role_audit`).get<{ n: number }>();
    assert.equal(Number(count?.n), 0);
  } finally {
    await db.close();
  }
});
