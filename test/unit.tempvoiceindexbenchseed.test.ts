/** Offline benchmark seed regression (TOG-10237): no DB, migrations or Discord. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { TempVoiceAuditInput, TempVoiceRow, TempVoiceStore } from '../src/tempVoice/store.ts';
import { seedTempVoiceBenchmark } from '../scripts/temp-voice-index-bench-seed.ts';

class FakeSeedStore {
  rows: TempVoiceRow[] = [];
  audits: Array<TempVoiceAuditInput & { createdAt: string }> = [];

  async reserveIfUnderCaps(input: Parameters<TempVoiceStore['reserveIfUnderCaps']>[0]) {
    assert.equal(typeof input.createdAt, 'string');
    const createdAt = input.createdAt as string;
    const row: TempVoiceRow = {
      id: `row-${this.rows.length}`, guildId: input.guildId, channelId: null,
      generatorId: input.generatorId, categoryId: input.categoryId,
      ownerId: input.ownerId, pendingOwnerId: null, createdBy: input.ownerId,
      name: input.name, createdAt, lastRenamedAt: null, emptySince: null,
    };
    this.rows.push(row);
    // The real store journals every accepted reservation, not just explicit audits.
    await this.audit({ guildId: input.guildId, actorId: input.ownerId, channelId: null, action: 'create_reservation', outcome: 'accepted' }, createdAt);
    return { ok: true as const, row };
  }

  async attach(id: string, channelId: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || (row.channelId !== null && row.channelId !== channelId)) return false;
    row.channelId = channelId;
    return true;
  }

  async beginOwnerChange(id: string, oldOwnerId: string, newOwnerId: string) {
    const row = this.rows.find((r) => r.id === id);
    assert.ok(row?.channelId, 'pending intent must belong to an attached channel');
    if (row.ownerId !== oldOwnerId || row.pendingOwnerId !== null) return false;
    row.pendingOwnerId = newOwnerId;
    return true;
  }

  async audit(input: TempVoiceAuditInput, at: string) {
    this.audits.push({ ...input, createdAt: at });
  }
}

for (const guilds of [1, 2, 100]) {
  test(`benchmark seed stores and reports normal, reserved and interrupted states for ${guilds} guilds`, async () => {
    const store = new FakeSeedStore();
    const result = await seedTempVoiceBenchmark(store, guilds);
    const live = store.rows.filter((r) => r.channelId !== null);
    const reservations = store.rows.filter((r) => r.channelId === null);
    const interrupted = store.rows.filter((r) => r.pendingOwnerId !== null);
    const pendingAudits = store.audits.filter((a) => a.action === 'owner_change' && a.outcome === 'pending');
    assert.equal(store.rows.length, 40 * guilds);
    assert.equal(live.length, 38 * guilds);
    assert.equal(reservations.length, 2 * guilds);
    assert.equal(interrupted.length, guilds, 'one reachable interrupted transition per guild');
    assert.equal(pendingAudits.length, guilds);
    assert.equal(store.audits.length, 81 * guilds, 'reservation, create and pending audits all count');
    assert.equal(result.channels, live.length);
    assert.equal(result.reservations, reservations.length);
    assert.equal(result.interruptedTransitions, interrupted.length);
    assert.equal(result.audits, store.audits.length);
    assert.deepEqual(result.probe, { guild: 'bench-guild-0', channel: 'chan-0-1' });
    assert.ok(live.some((r) => r.guildId === result.probe.guild && r.channelId === result.probe.channel && r.pendingOwnerId === null));
    for (let g = 0; g < guilds; g++) {
      const guild = `bench-guild-${g}`;
      assert.equal(live.filter((r) => r.guildId === guild && r.pendingOwnerId === null).length, 37);
      const rows = interrupted.filter((r) => r.guildId === guild);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.ok(row.channelId);
      assert.equal(row.pendingOwnerId, `user-${g}-next`);
      assert.notEqual(row.ownerId, row.pendingOwnerId, 'old owner remains until recovery completes');
      assert.equal(pendingAudits.filter((a) => a.guildId === guild && a.channelId === row.channelId && a.createdAt === row.createdAt).length, 1);
    }
    assert.ok(reservations.every((r) => r.pendingOwnerId === null));
  });
}

test('real benchmark report agrees with the offline stored fixture', () => {
  const storeSource = `
    import assert from 'node:assert/strict';
    ${FakeSeedStore.toString()}
    export const fixtures = [];
    export class TempVoiceStore extends FakeSeedStore {
      constructor() { super(); fixtures.push(this); }
    }
  `;
  const dbSource = `
    export async function openDb() {
      return {
        async exec() {}, async close() {},
        prepare(sql) {
          return { async all() {
            return sql.startsWith('EXPLAIN ') ? [{ 'QUERY PLAN': 'Index Scan on temp_voice_channels' }] : [];
          } };
        },
      };
    }
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    const storeUrl = new URL('./src/tempVoice/store.ts', import.meta.url).href;
    const dbUrl = new URL('./src/store/db.ts', import.meta.url).href;
    registerHooks({ load(url, context, nextLoad) {
      if (url === storeUrl || url === dbUrl) return {
        format: 'module', shortCircuit: true,
        source: url === storeUrl ? ${JSON.stringify(storeSource)} : ${JSON.stringify(dbSource)},
      };
      return nextLoad(url, context);
    } });
    process.argv[2] = '1';
    await import('./scripts/temp-voice-index-bench.ts');
    const { fixtures } = await import('./src/tempVoice/store.ts');
    const store = fixtures[0];
    console.log('fixture:' + JSON.stringify({
      channels: store.rows.filter(r => r.channelId !== null).length,
      reservations: store.rows.filter(r => r.channelId === null).length,
      interrupted: store.rows.filter(r => r.pendingOwnerId !== null).length,
      audits: store.audits.length,
    }));
  `], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH, TWO_DATABASE_URL: 'postgres://agent_test@agent-testdb:5432/two_bot_test_tog10237' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(run.stdout.split('\n').find((l) => l.startsWith('fixture:'))!.slice('fixture:'.length));
  assert.deepEqual(fixture, { channels: 38, reservations: 2, interrupted: 1, audits: 81 });
  assert.ok(run.stdout.includes(`${fixture.channels} live channels, ${fixture.reservations} reservations, ${fixture.interrupted} interrupted transitions, ${fixture.audits} audit rows`));
  assert.match(run.stdout, /write path\s+121 rows/);
});

test('benchmark seed fails loudly on a refused reservation', async () => {
  const store = new FakeSeedStore();
  await assert.rejects(seedTempVoiceBenchmark({
    ...store,
    reserveIfUnderCaps: async () => ({ ok: false, reason: 'guild_cap' }),
    attach: store.attach.bind(store), beginOwnerChange: store.beginOwnerChange.bind(store), audit: store.audit.bind(store),
  }, 1), /bench seed refused: guild_cap/);
  assert.equal(store.audits.length, 0);
});

for (const method of ['attach', 'beginOwnerChange'] as const) {
  test(`benchmark seed fails loudly rather than reporting a refused ${method}`, async () => {
    const store = new FakeSeedStore();
    store[method] = async () => false;
    await assert.rejects(seedTempVoiceBenchmark(store, 1), /bench seed (attach|owner change) refused/);
    assert.equal(store.audits.filter((a) => a.action === 'owner_change').length, 0);
  });
}
