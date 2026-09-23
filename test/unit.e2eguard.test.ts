/**
 * The fence around the end-to-end test account (TOG-3978).
 *
 * The owner approved a throwaway Discord account on five conditions, three of
 * which are enforced by `HarnessGuard` and one by `tripKillSwitch`. This file
 * is the reason anybody should believe those conditions hold, so every test
 * here is written as "the guard REFUSES x", not "the guard can do y".
 *
 * Nothing here opens a socket. The clock is injected and advances only when the
 * guard sleeps, which is what makes the >= 2s condition assertable as a number
 * rather than as a wall-clock hope: `atMs` in the transcript is exactly the
 * time the guard chose to wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MIN_GAP_MS,
  HarnessGuard,
  HarnessHalt,
  type Acted,
  type HarnessClock,
} from '../src/e2e/guard.ts';
import { tripKillSwitch } from '../src/e2e/killSwitch.ts';
import type { KickResult } from '../src/discord/kick.ts';
import { LIVE_GUILD_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

/** A clock that only moves when something sleeps, so sleeps are the only time. */
function fakeClock(): HarnessClock & { slept: number[] } {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

const ok = <T>(value: T, status = 200): Promise<Acted<T>> => Promise.resolve({ status, value });

test('paces every action at or above the 2s floor, and jitters above it', async () => {
  const clock = fakeClock();
  // random() is pinned so the jitter is a known number; the floor is the part
  // under test and must hold for every value random() can return.
  const guard = new HarnessGuard({ clock, random: () => 0.5 });

  for (let i = 0; i < 4; i++) {
    await guard.act('reaction', `act-${i}`, () => ok(null));
  }

  assert.equal(guard.transcript.length, 4);
  // The first action is free; every later one waited.
  assert.equal(guard.transcript[0]!.waitedMs, 0);
  for (const entry of guard.transcript.slice(1)) {
    assert.ok(
      entry.waitedMs >= DEFAULT_MIN_GAP_MS,
      `${entry.label} waited ${entry.waitedMs}ms, floor is ${DEFAULT_MIN_GAP_MS}`,
    );
  }
  assert.deepEqual(clock.slept, [2750, 2750, 2750]);
});

test('the jitter is real: different random draws produce different gaps', async () => {
  const gaps: number[] = [];
  for (const draw of [0, 0.25, 0.75, 0.99]) {
    const clock = fakeClock();
    const guard = new HarnessGuard({ clock, random: () => draw });
    await guard.act('reaction', 'a', () => ok(null));
    await guard.act('reaction', 'b', () => ok(null));
    gaps.push(guard.transcript[1]!.waitedMs);
  }
  assert.equal(new Set(gaps).size, gaps.length, `gaps were not distinct: ${gaps.join(',')}`);
  for (const g of gaps) assert.ok(g >= DEFAULT_MIN_GAP_MS, `${g} is below the floor`);
});

test('refuses the tenth message of a run, and never calls the transport for it', async () => {
  const clock = fakeClock();
  const guard = new HarnessGuard({ clock, random: () => 0 });
  let calls = 0;
  const send = () => {
    calls++;
    return ok({ id: 'm' });
  };

  for (let i = 0; i < DEFAULT_MAX_MESSAGES; i++) {
    await guard.act('message', `msg-${i}`, send);
  }
  assert.equal(calls, DEFAULT_MAX_MESSAGES);
  assert.equal(guard.messagesSent, DEFAULT_MAX_MESSAGES);
  assert.ok(DEFAULT_MAX_MESSAGES < 10, 'the owner condition is a single digit');

  const before = clock.slept.length;
  await assert.rejects(
    () => guard.act('message', 'msg-over', send),
    (err: unknown) => err instanceof HarnessHalt && err.reason === 'message_budget',
  );
  assert.equal(calls, DEFAULT_MAX_MESSAGES, 'the over-budget message reached the transport');
  assert.equal(clock.slept.length, before, 'an over-budget refusal must not cost a 2s sleep');
});

test('non-message actions do not consume the message budget, but are bounded too', async () => {
  const guard = new HarnessGuard({ clock: fakeClock(), random: () => 0, maxActionsPerRun: 3 });

  await guard.act('reaction', 'r', () => ok(null));
  await guard.act('button', 'b', () => ok(null));
  await guard.act('observe', 'o', () => ok(null));
  assert.equal(guard.messagesSent, 0, 'reactions and clicks are not messages');

  await assert.rejects(
    () => guard.act('reaction', 'r2', () => ok(null)),
    (err: unknown) => err instanceof HarnessHalt && err.reason === 'action_budget',
  );
});

test('halts on the first 403 and makes no further calls', async () => {
  const guard = new HarnessGuard({ clock: fakeClock(), random: () => 0 });
  let calls = 0;
  const call = (status: number) => () => {
    calls++;
    return ok(null, status);
  };

  await guard.act('reaction', 'fine', call(200));
  await assert.rejects(
    () => guard.act('reaction', 'refused', call(403)),
    (err: unknown) => err instanceof HarnessHalt && err.reason === 'forbidden',
  );
  assert.equal(calls, 2);

  // Every later action re-throws the SAME halt rather than trying again.
  const again = await guard.act('reaction', 'after', call(200)).catch((e: unknown) => e);
  assert.ok(again instanceof HarnessHalt);
  assert.equal(again.reason, 'forbidden');
  assert.equal(calls, 2, 'the guard called Discord again after a 403');
});

test('401 and 429 halt too, each with its own reason', async () => {
  for (const [status, reason] of [
    [401, 'unauthorized'],
    [429, 'rate_limited'],
  ] as const) {
    const guard = new HarnessGuard({ clock: fakeClock(), random: () => 0 });
    await assert.rejects(
      () => guard.act('reaction', 'x', () => ok(null, status)),
      (err: unknown) => err instanceof HarnessHalt && err.reason === reason,
    );
  }
});

test('the first halt wins; a later one does not overwrite the cause', async () => {
  const guard = new HarnessGuard({ clock: fakeClock(), random: () => 0, maxActionsPerRun: 1 });
  await assert.rejects(() => guard.act('reaction', 'a', () => ok(null, 403)));
  assert.equal(guard.halted?.reason, 'forbidden');
  await assert.rejects(() => guard.act('reaction', 'b', () => ok(null)));
  assert.equal(guard.halted?.reason, 'forbidden', 'the action_budget halt overwrote the 403');
});

test('the transcript carries no credential and is JSON-safe', async () => {
  const guard = new HarnessGuard({ clock: fakeClock(), random: () => 0 });
  const secret = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.not-a-real-token';
  // The transport holds the token; the guard is handed a closure, never a value.
  await guard.act('message', 'send', () => ok({ id: 'm', echoed: secret.length }));

  const json = JSON.stringify(guard.transcript);
  assert.ok(!json.includes(secret), 'the transcript contained the credential');
  assert.deepEqual(Object.keys(guard.transcript[0]!).sort(), [
    'atMs',
    'kind',
    'label',
    'status',
    'waitedMs',
  ]);
});

// --- kill switch -------------------------------------------------------------

function fakeRemover(outcome: KickResult['outcome']) {
  const kicks: { memberId: string; reason: string }[] = [];
  return {
    kicks,
    kick: async (memberId: string, reason: string): Promise<KickResult> => {
      kicks.push({ memberId, reason });
      return { outcome, status: outcome === 'kicked' ? 204 : 403, detail: outcome, attempts: 1 };
    },
  };
}

test('the kill switch kicks the account and demands rotation', async () => {
  const remover = fakeRemover('kicked');
  const result = await tripKillSwitch({
    guildId: TWO_STAGING_GUILD_ID,
    accountId: 'test-account',
    reason: 'Discord flagged it',
    remover,
  });

  assert.equal(result.kick, 'kicked');
  assert.equal(result.rotationRequired, true);
  assert.equal(result.complete, true);
  assert.equal(remover.kicks.length, 1);
  assert.match(remover.kicks[0]!.reason, /kill switch/);
});

test('a second trip is idempotent: already_gone still completes', async () => {
  const result = await tripKillSwitch({
    guildId: TWO_STAGING_GUILD_ID,
    accountId: 'test-account',
    reason: 'again',
    remover: fakeRemover('already_gone'),
  });
  assert.equal(result.complete, true);
});

test('a failed kick is reported incomplete, and still demands rotation', async () => {
  const result = await tripKillSwitch({
    guildId: TWO_STAGING_GUILD_ID,
    accountId: 'test-account',
    reason: 'x',
    remover: fakeRemover('forbidden'),
  });
  assert.equal(result.complete, false);
  assert.equal(result.rotationRequired, true);
  assert.match(result.summary, /by hand/);
});

test('the kill switch refuses the live guild, and any guild that is not staging', async () => {
  const remover = fakeRemover('kicked');
  await assert.rejects(
    () =>
      tripKillSwitch({
        guildId: LIVE_GUILD_ID,
        accountId: 'a',
        reason: 'r',
        remover,
      }),
    /live guild/,
  );
  await assert.rejects(
    () =>
      tripKillSwitch({
        guildId: '999999999999999999',
        accountId: 'a',
        reason: 'r',
        remover,
      }),
    /not the staging guild/,
  );
  assert.equal(remover.kicks.length, 0, 'a refused kill switch still called Discord');
});
