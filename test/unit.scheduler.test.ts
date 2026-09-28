/**
 * Scheduler unit tests (TOG-8669): schedule/add/remove plus the double-fire
 * guard, on fixtures.
 *
 * Hermetic by construction: a real AutomationService and the real
 * startScheduler ticker run against an in-memory store fake (the same
 * `as unknown as AutomationStore` seam the disable suite already uses) and a
 * recording Discord fake. No Postgres, no token, no live guild writes:
 *   node --test test/unit.scheduler.test.ts
 *
 * The Postgres-backed `unit.automations` suite covers the same service
 * against the real driver in CI; this file covers the scheduler ticker and
 * the schedule/add/remove paths a reviewer must be able to run offline.
 * Every export of src/automations/scheduler.ts has a case:
 * startScheduler, SchedulerHandle.tick, SchedulerHandle.stop, and
 * SCHEDULER_TICK_MS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationService, type AutomationDiscord } from '../src/automations/service.ts';
import type { AutomationAuditInput, AutomationStore, ScheduledMessageRow } from '../src/automations/store.ts';
import { SCHEDULER_TICK_MS, startScheduler } from '../src/automations/scheduler.ts';

const GUILD = '1545644954272137297';
const CHANNEL = '100000000000000001';
const ACTOR = '900000000000000001';
const NOW = '2026-09-08T10:00:00.000Z';
const DUE = '2026-09-08T09:59:00.000Z';
const LATER = '2026-09-08T12:00:00.000Z';

function row(partial: Partial<ScheduledMessageRow> & { id: string }): ScheduledMessageRow {
  return {
    guildId: GUILD,
    channelId: CHANNEL,
    body: 'hello',
    nextRunAt: DUE,
    intervalSeconds: null,
    enabled: true,
    lastRunAt: null,
    lastMessageId: null,
    createdBy: ACTOR,
    createdAt: NOW,
    updatedBy: ACTOR,
    updatedAt: NOW,
    claimToken: null,
    claimedAt: null,
    occurrenceNonce: null,
    ...partial,
  };
}

/**
 * Minimal in-memory scheduled-message store. Only the scheduled/audit
 * surface the service touches; it mirrors the real driver's claim semantics
 * (due, enabled and unclaimed rows lease exactly once) so the double-fire
 * test means something.
 */
function fakeStore() {
  const rows = new Map<string, ScheduledMessageRow>();
  const audits: AutomationAuditInput[] = [];
  let failClaimTimes = 0;
  return {
    rows,
    audits,
    failNextClaims(n: number) {
      failClaimTimes = n;
    },
    async getScheduled(guildId: string, id: string) {
      const r = rows.get(id);
      return r && r.guildId === guildId ? { ...r } : null;
    },
    async putScheduled(next: ScheduledMessageRow) {
      rows.set(next.id, { ...next });
      return true;
    },
    async deleteScheduled(guildId: string, id: string) {
      const r = rows.get(id);
      if (!r || r.guildId !== guildId) return false;
      rows.delete(id);
      return true;
    },
    async claimDueScheduled(
      guildId: string,
      nowIso: string,
      claimToken: string,
      leaseUntilIso: string,
      limit = 10,
      occurrenceNonce = claimToken,
    ) {
      if (failClaimTimes > 0) {
        failClaimTimes--;
        throw new Error('store down');
      }
      const due = [...rows.values()]
        .filter((r) => r.guildId === guildId && r.enabled && r.claimToken === null && r.nextRunAt <= nowIso)
        .sort((a, b) => (a.nextRunAt < b.nextRunAt ? -1 : 1))
        .slice(0, limit);
      return due.map((r) => {
        const claimed: ScheduledMessageRow = {
          ...r,
          nextRunAt: leaseUntilIso,
          claimToken,
          claimedAt: nowIso,
          occurrenceNonce: r.occurrenceNonce ?? occurrenceNonce,
        };
        rows.set(r.id, claimed);
        return { ...claimed };
      });
    },
    async markScheduledRun(
      guildId: string,
      id: string,
      ranAtIso: string,
      messageId: string | null,
      claimToken: string,
    ) {
      const r = rows.get(id);
      if (!r || r.guildId !== guildId || r.claimToken !== claimToken) return null;
      const done: ScheduledMessageRow = {
        ...r,
        lastRunAt: ranAtIso,
        lastMessageId: messageId,
        enabled: r.intervalSeconds !== null,
        nextRunAt: r.intervalSeconds
          ? new Date(Date.parse(ranAtIso) + r.intervalSeconds * 1000).toISOString()
          : r.nextRunAt,
        claimToken: null,
        claimedAt: null,
        occurrenceNonce: null,
      };
      rows.set(id, done);
      return { ...done };
    },
    async retryScheduled(guildId: string, id: string, claimToken: string, nextRunAtIso: string) {
      const r = rows.get(id);
      if (!r || r.guildId !== guildId || r.claimToken !== claimToken) return false;
      rows.set(id, { ...r, nextRunAt: nextRunAtIso, claimToken: null, claimedAt: null });
      return true;
    },
    async audit(input: AutomationAuditInput) {
      audits.push(input);
    },
  };
}

function setup(now: () => string = () => NOW) {
  const store = fakeStore();
  const posts: { channelId: string; content: string; nonce?: string }[] = [];
  const deletes: { channelId: string; messageId: string }[] = [];
  let n = 0;
  const discord: AutomationDiscord = {
    async postMessage(channelId: string, content: string, nonce?: string) {
      posts.push({ channelId, content, nonce });
      return `msg${++n}`;
    },
    async deleteMessage(channelId: string, messageId: string) {
      deletes.push({ channelId, messageId });
    },
  };
  const service = new AutomationService(store as unknown as AutomationStore, discord, now);
  return { store, posts, deletes, discord, service };
}

async function schedule(
  service: AutomationService,
  partial: { id?: string; body?: string; nextRunAt?: string; intervalSeconds?: number | null } = {},
) {
  return service.putScheduled({
    guildId: GUILD,
    id: partial.id ?? 'sched-one',
    channelId: CHANNEL,
    body: partial.body ?? 'hello',
    nextRunAt: partial.nextRunAt ?? DUE,
    intervalSeconds: partial.intervalSeconds ?? null,
    actorId: ACTOR,
  });
}

test('schedule: add creates a due row the scheduler tick fires exactly once', async () => {
  const { store, posts, service } = setup();
  const created = await schedule(service);
  assert.deepEqual(created, { created: true });

  const handle = startScheduler(service, GUILD, { intervalMs: 60_000, now: () => NOW });
  try {
    assert.equal(await handle.tick(), 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.channelId, CHANNEL);
    assert.equal(posts[0]?.content, 'hello');
    // One-shot rows disable themselves: a second tick has nothing due.
    assert.equal(await handle.tick(), 0);
    assert.equal(posts.length, 1);
    assert.equal(store.rows.get('sched-one')?.enabled, false);
  } finally {
    handle.stop();
  }
});

test('schedule: add replaces the body of an existing id', async () => {
  const { posts, service } = setup();
  await schedule(service, { body: 'first' });
  const updated = await schedule(service, { body: 'second' });
  assert.deepEqual(updated, { created: false });

  const handle = startScheduler(service, GUILD, { intervalMs: 60_000, now: () => NOW });
  try {
    assert.equal(await handle.tick(), 1);
    assert.equal(posts[0]?.content, 'second');
  } finally {
    handle.stop();
  }
});

test('remove: deleteScheduled cancels a due row before the tick reaches it', async () => {
  const { posts, service } = setup();
  await schedule(service);
  assert.equal(await service.deleteScheduled(GUILD, 'sched-one', ACTOR), true);

  const handle = startScheduler(service, GUILD, { intervalMs: 60_000, now: () => NOW });
  try {
    assert.equal(await handle.tick(), 0);
    assert.equal(posts.length, 0);
  } finally {
    handle.stop();
  }
  assert.equal(await service.deleteScheduled(GUILD, 'sched-one', ACTOR), false);
});

test('tick passes the injected clock through to runDueScheduled', async () => {
  const { store, service } = setup();
  await schedule(service);
  // Observe via the store fake's claim args through a wrapper.
  const origClaim = store.claimDueScheduled.bind(store);
  let claimedAt = '';
  store.claimDueScheduled = async (guildId, nowIso, claimToken, leaseUntilIso, limit, nonce) => {
    claimedAt = nowIso;
    return origClaim(guildId, nowIso, claimToken, leaseUntilIso, limit, nonce);
  };
  const handle = startScheduler(service, GUILD, { intervalMs: 60_000, now: () => LATER });
  try {
    assert.equal(await handle.tick(), 1);
    assert.equal(claimedAt, LATER);
  } finally {
    handle.stop();
  }
});

test('double-fire guard: overlapping ticks do not stack; failures resolve to 0', async () => {
  const { store, discord } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Gate the outbound post so the first sweep stays in flight.
  let posts = 0;
  const gatedDiscord: AutomationDiscord = {
    postMessage: async (channelId, content, nonce) => {
      await gate;
      posts++;
      return discord.postMessage(channelId, content, nonce);
    },
    deleteMessage: (channelId, messageId) => discord.deleteMessage(channelId, messageId),
  };
  const gatedService = new AutomationService(store as unknown as AutomationStore, gatedDiscord, () => NOW);
  await schedule(gatedService);
  const handle = startScheduler(gatedService, GUILD, { intervalMs: 60_000, now: () => NOW });
  try {
    const first = handle.tick();
    const second = await handle.tick();
    assert.equal(second, 0, 'a slow sweep is skipped, not queued');
    release();
    assert.equal(await first, 1);
    assert.equal(posts, 1);
  } finally {
    handle.stop();
  }

  const failingStore = fakeStore();
  failingStore.failNextClaims(1);
  const failingService = new AutomationService(
    failingStore as unknown as AutomationStore,
    {
      postMessage: async () => 'msg1',
      deleteMessage: async () => {},
    },
    () => NOW,
  );
  const failing = startScheduler(failingService, GUILD, { intervalMs: 60_000, now: () => NOW });
  try {
    assert.equal(await failing.tick(), 0);
  } finally {
    failing.stop();
  }
});

test('stop clears the interval but leaves manual ticks available for ops', async () => {
  const { posts, service } = setup();
  await schedule(service);
  const handle = startScheduler(service, GUILD, { intervalMs: 60_000, now: () => NOW });
  handle.stop();
  assert.equal(await handle.tick(), 1);
  assert.equal(posts.length, 1);
});

test('default tick interval is fifteen seconds', () => {
  assert.equal(SCHEDULER_TICK_MS, 15_000);
});
