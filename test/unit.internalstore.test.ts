/**
 * InternalActionStore: the parts the end-to-end tests cannot reach.
 *
 * Everything here is a clock problem - a nonce ageing out, a claim going
 * stale, the sweep - and driving those over HTTP would mean either sleeping
 * for four minutes or trusting that the code does what its comment says. The
 * store takes an injectable clock precisely so these are assertions instead.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type TestDb } from './helpers/testDb.ts';
import {
  InternalActionStore,
  requestHash,
  NONCE_TTL_SECONDS,
  CLAIM_STALE_SECONDS,
} from '../src/internal/store.ts';

const KEY = 'web-prod';
const HASH = requestHash(Buffer.from('{"action":"announcement.post"}'));
const OTHER_HASH = requestHash(Buffer.from('{"action":"announcement.post","body":"different"}'));

let testDb: TestDb;
/** Milliseconds, moved by hand. Every store below reads this. */
let clock = Date.parse('2026-08-25T12:00:00.000Z');

before(async () => {
  testDb = await openTestDb(import.meta.filename);
});
after(async () => {
  await testDb.cleanup();
});
beforeEach(async () => {
  clock = Date.parse('2026-08-25T12:00:00.000Z');
  for (const t of ['internal_nonces', 'internal_idempotency', 'internal_action_log', 'internal_discord_events']) {
    await testDb.db.exec(`DELETE FROM ${t}`);
  }
});

function store(): InternalActionStore {
  return new InternalActionStore(testDb.db, { now: () => clock });
}

const advance = (seconds: number) => {
  clock += seconds * 1000;
};

// --- nonces ------------------------------------------------------------------

test('a nonce is accepted once and refused while it is still live', async () => {
  const s = store();
  assert.equal(await s.offerNonce(KEY, 'n1'), true);
  assert.equal(await s.offerNonce(KEY, 'n1'), false);

  // One second short of the TTL is still a replay.
  advance(NONCE_TTL_SECONDS - 1);
  assert.equal(await s.offerNonce(KEY, 'n1'), false);
});

test('a nonce is usable again once it has aged past the TTL', async () => {
  // Not a weakening: the skew window is half the TTL, so a request old enough
  // for its nonce to have expired is already rejected as stale_request before
  // the replay guard is consulted.
  const s = store();
  assert.equal(await s.offerNonce(KEY, 'n1'), true);
  advance(NONCE_TTL_SECONDS + 1);
  assert.equal(await s.offerNonce(KEY, 'n1'), true, 'an expired row must not reject a fresh nonce');
});

test('nonces are scoped per caller, so one key cannot burn another key nonces', async () => {
  const s = store();
  assert.equal(await s.offerNonce('web-prod', 'shared'), true);
  assert.equal(await s.offerNonce('web-staging', 'shared'), true);
  assert.equal(await s.offerNonce('web-staging', 'shared'), false);
});

test('the table stays bounded: offering a nonce sweeps the expired ones', async () => {
  const s = store();
  await s.offerNonce(KEY, 'old');
  advance(NONCE_TTL_SECONDS + 1);
  // This offer is past the throttle interval, so it sweeps before inserting.
  await s.offerNonce(KEY, 'new');

  const rows = await testDb.db.prepare(`SELECT nonce FROM internal_nonces`).all<{ nonce: string }>();
  assert.deepEqual(rows.map((r) => r.nonce), ['new'], 'the expired row went with the ordinary traffic');

  // And a forced sweep with nothing expired removes nothing.
  assert.equal(await s.sweepNonces(clock, true), 0);
});

test('the sweep is throttled, so it is not a write on every single request', async () => {
  const s = store();
  await s.offerNonce(KEY, 'old');
  advance(NONCE_TTL_SECONDS + 1);

  // A second offer inside a quarter-TTL of the last sweep must not sweep.
  // 'old' is expired but still present, which is why offerNonce checks the
  // row's age itself rather than trusting the sweep to have run.
  await s.offerNonce(KEY, 'a');
  await s.offerNonce(KEY, 'b');
  const removed = await s.sweepNonces(clock, false);
  assert.equal(removed, 0, 'throttled out');

  assert.equal(await s.offerNonce(KEY, 'old'), true, 'an expired row is still not a replay');
});

// --- idempotency -------------------------------------------------------------

test('the first claim wins and a second one is told it is in flight', async () => {
  const s = store();
  assert.deepEqual(await s.claim(KEY, 'k1', 'announcement.post', HASH), { state: 'claimed' });
  assert.deepEqual(await s.claim(KEY, 'k1', 'announcement.post', HASH), { state: 'in_flight' });
});

test('once complete, the same key replays the stored result', async () => {
  const s = store();
  await s.claim(KEY, 'k1', 'announcement.post', HASH);
  await s.complete(KEY, 'k1', { outcome: 'posted', result: { outcome: 'posted', message_id: 'm-1' } });

  const again = await s.claim(KEY, 'k1', 'announcement.post', HASH);
  assert.equal(again.state, 'replayed');
  assert.deepEqual(again.state === 'replayed' ? again.stored : null, {
    outcome: 'posted',
    result: { outcome: 'posted', message_id: 'm-1' },
  });
});

test('the same key with a different body is a mismatch, in either state', async () => {
  const s = store();
  await s.claim(KEY, 'k1', 'announcement.post', HASH);
  assert.deepEqual(await s.claim(KEY, 'k1', 'announcement.post', OTHER_HASH), { state: 'mismatch' });

  await s.complete(KEY, 'k1', { outcome: 'posted', result: {} });
  assert.deepEqual(
    await s.claim(KEY, 'k1', 'announcement.post', OTHER_HASH),
    { state: 'mismatch' },
    'a completed operation must not hand its result to a different request',
  );
});

test('releasing a failed attempt makes the key usable again', async () => {
  const s = store();
  await s.claim(KEY, 'k1', 'announcement.post', HASH);
  await s.release(KEY, 'k1');
  assert.deepEqual(await s.claim(KEY, 'k1', 'announcement.post', HASH), { state: 'claimed' });
});

test('release cannot erase a completed operation', async () => {
  // release() only ever fires on the failure path, but it must be incapable of
  // deleting a `done` row even so - that would turn one crash into a duplicate
  // announcement.
  const s = store();
  await s.claim(KEY, 'k1', 'announcement.post', HASH);
  await s.complete(KEY, 'k1', { outcome: 'posted', result: { message_id: 'm-1' } });
  await s.release(KEY, 'k1');

  assert.equal((await s.claim(KEY, 'k1', 'announcement.post', HASH)).state, 'replayed');
});

test('a claim abandoned by a crashed process is reclaimable, but not before', async () => {
  const s = store();
  await s.claim(KEY, 'k1', 'announcement.post', HASH);

  advance(CLAIM_STALE_SECONDS - 1);
  assert.deepEqual(
    await s.claim(KEY, 'k1', 'announcement.post', HASH),
    { state: 'in_flight' },
    'a live request must never have its claim stolen',
  );

  advance(2);
  assert.deepEqual(
    await s.claim(KEY, 'k1', 'announcement.post', HASH),
    { state: 'claimed' },
    'otherwise a crash would pin this operation as in-flight forever',
  );
});

test('idempotency keys are scoped per caller', async () => {
  const s = store();
  await s.claim('web-prod', 'k1', 'announcement.post', HASH);
  assert.deepEqual(await s.claim('web-staging', 'k1', 'announcement.post', HASH), { state: 'claimed' });
});

// --- audit -------------------------------------------------------------------

test('an audit row is written once and a repeat request id does not throw', async () => {
  const s = store();
  const row = {
    requestId: 'req-1',
    keyId: KEY,
    action: 'role.assign',
    idempotencyKey: null,
    outcome: 'assigned',
    code: null,
    status: 200,
    reason: null,
    durationMs: 4,
  };
  await s.recordAudit(row);
  await s.recordAudit(row);

  const rows = await testDb.db.prepare(`SELECT * FROM internal_action_log`).all<Record<string, unknown>>();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'assigned');
  assert.equal(rows[0].created_at, '2026-08-25T12:00:00.000Z');
});

// --- event_key mapping -------------------------------------------------------

test('an event key remembers its Discord event and is scoped per guild', async () => {
  const s = store();
  assert.equal(await s.discordEventId('g1', 'launch-night'), null);

  await s.rememberDiscordEvent('g1', 'launch-night', 'evt-1');
  assert.equal(await s.discordEventId('g1', 'launch-night'), 'evt-1');
  assert.equal(await s.discordEventId('g2', 'launch-night'), null);

  // Re-remembering is an update, not a duplicate row.
  await s.rememberDiscordEvent('g1', 'launch-night', 'evt-2');
  assert.equal(await s.discordEventId('g1', 'launch-night'), 'evt-2');
  const rows = await testDb.db.prepare(`SELECT * FROM internal_discord_events`).all();
  assert.equal(rows.length, 1);
});
