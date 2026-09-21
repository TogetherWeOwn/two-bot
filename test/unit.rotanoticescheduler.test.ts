import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROTA_NOTICE_TICK_MS, startRotaNoticeScheduler } from '../src/discord/rotaNoticeScheduler.ts';
import type { RotaNoticeDelivery, RotaNoticeOutcome } from '../src/discord/rotaNoticeDelivery.ts';

function delivery(runDue: (now: string) => Promise<RotaNoticeOutcome[]>): RotaNoticeDelivery {
  return { runDue } as unknown as RotaNoticeDelivery;
}

test('tick passes the clock through and returns outcomes', async () => {
  const seen: string[] = [];
  const handle = startRotaNoticeScheduler(
    delivery(async (now) => { seen.push(now); return [{ status: 'sent', entryId: 'e', messageId: 'm' }]; }),
    { now: () => '2026-09-01T23:35:00.000Z', intervalMs: 60_000 },
  );
  try {
    const outcomes = await handle.tick();
    assert.deepEqual(outcomes, [{ status: 'sent', entryId: 'e', messageId: 'm' }]);
    assert.deepEqual(seen, ['2026-09-01T23:35:00.000Z']);
  } finally {
    handle.stop();
  }
});

test('overlapping ticks do not stack; failures resolve to an empty sweep', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handle = startRotaNoticeScheduler(
    delivery(async () => { calls++; await gate; return []; }),
    { intervalMs: 60_000 },
  );
  try {
    const first = handle.tick();
    const second = await handle.tick();
    assert.deepEqual(second, [], 'a slow sweep is skipped, not queued');
    release();
    assert.deepEqual(await first, []);
    assert.equal(calls, 1);
  } finally {
    handle.stop();
  }

  const failing = startRotaNoticeScheduler(
    delivery(async () => { throw new Error('store down'); }),
    { intervalMs: 60_000 },
  );
  try {
    assert.deepEqual(await failing.tick(), []);
  } finally {
    failing.stop();
  }
});

test('default tick interval is one minute', () => {
  assert.equal(ROTA_NOTICE_TICK_MS, 60_000);
});
