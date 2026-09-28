/**
 * Acceptance run for POST /internal/actions against a *running* bot (TOG-463).
 *
 * This is the TOG-463 "Do" list turned into code, because it is a list with
 * numbers in it and a model re-improvising it every time is how a green tick
 * stops meaning anything. Same input, same output, forever.
 *
 * It talks to an endpoint over real HTTP and signs with a real key. It does not
 * import the bot's server, so it measures the deployed process rather than a
 * copy of its source - which is the whole point of the exercise.
 *
 *   TWO_ACCEPT_URL=http://127.0.0.1:8787/internal/actions \
 *   TWO_ACCEPT_KEY_ID=web-staging \
 *   TWO_ACCEPT_SECRET=... \
 *   TWO_ACCEPT_CHANNEL_KEY=qa-throwaway \
 *   TWO_ACCEPT_ROLE_KEY=rocketleague \
 *   TWO_ACCEPT_DISCORD_ID=900000000000009999 \
 *   TWO_ACCEPT_DB=./data/two.db \
 *   TWO_ACCEPT_SCHEMA=qa_tog463        # Postgres only; must match TWO_HOST_SCHEMA
 *   node scripts/internal-actions-acceptance.ts
 *
 * Exit codes: 0 every check passed - 1 a check failed - 2 misconfigured.
 *
 * The channel key MUST name a throwaway channel. This script posts two real
 * announcements' worth of intent at it (one of which must be absorbed by the
 * idempotency store) and has no way to delete them.
 */
import { randomBytes, createHash, createHmac } from 'node:crypto';

// First statement of the body: the import above is side-effect-free, so this
// runs before env() can exit(2) on missing TWO_ACCEPT_* vars. --help needs no
// env, no running bot, no database, no network.
if (process.argv.includes('--help')) {
  console.log('usage: TWO_ACCEPT_URL=... TWO_ACCEPT_KEY_ID=... TWO_ACCEPT_SECRET=... TWO_ACCEPT_CHANNEL_KEY=... TWO_ACCEPT_ROLE_KEY=... TWO_ACCEPT_DISCORD_ID=... [TWO_ACCEPT_DB=...] [TWO_ACCEPT_SCHEMA=...] node scripts/internal-actions-acceptance.ts');
  console.log('');
  console.log('Acceptance run for POST /internal/actions against a running bot (TOG-463).');
  console.log('Talks HTTP to a live endpoint and posts real announcements at a throwaway channel;');
  console.log('--help contacts nothing and needs no env.');
  process.exit(0);
}

const ACTIONS_PATH = '/internal/actions';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    console.error(`FATAL ${name} is not set. See the header of this file.`);
    process.exit(2);
  }
  return v;
}

const URL_ = env('TWO_ACCEPT_URL', 'http://127.0.0.1:8787/internal/actions');
const KEY_ID = env('TWO_ACCEPT_KEY_ID');
const SECRET = env('TWO_ACCEPT_SECRET');
const CHANNEL_KEY = env('TWO_ACCEPT_CHANNEL_KEY');
const ROLE_KEY = env('TWO_ACCEPT_ROLE_KEY');
const DISCORD_ID = env('TWO_ACCEPT_DISCORD_ID');
const DB_SPEC = process.env.TWO_ACCEPT_DB ?? '';
// Step 7 must read the schema the ENDPOINT writes to, not whatever `search_path`
// happens to resolve to. `internal-actions-host.ts` isolates its tables under
// TWO_HOST_SCHEMA (default `qa_tog463`), so reading the default `public` finds a
// table that exists, is empty, and reports 0/7 - a FAIL that blames the endpoint
// for a mismatch in this reader.
const DB_SCHEMA = process.env.TWO_ACCEPT_SCHEMA ?? process.env.TWO_HOST_SCHEMA ?? '';

/** Every request this run made, so step 7 can look for exactly these rows. */
const requestIds: { step: string; requestId: string; status: number }[] = [];
const failures: string[] = [];

function bodyHash(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}
function sign(secret: string, timestamp: string, nonce: string, raw: Buffer): string {
  const canonical = ['POST', ACTIONS_PATH, timestamp, nonce, bodyHash(raw)].join('\n');
  return `sha256=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

interface Sent {
  status: number;
  body: any;
  replayHeader: string | null;
  requestId: string;
}

/**
 * One signed request. `mutate` lets a case break exactly one thing after the
 * signature is computed - that is how step 5 tampers a byte without also
 * changing what was signed.
 */
async function send(
  step: string,
  payload: unknown,
  opts: {
    nonce?: string;
    idempotencyKey?: string;
    timestamp?: string;
    tamperBody?: boolean;
  } = {},
): Promise<Sent> {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = sign(SECRET, timestamp, nonce, raw);

  // Flip one byte of the body AFTER signing: the signature is now valid for a
  // body we are not sending, which is exactly the attack shape.
  let wire = raw;
  if (opts.tamperBody) {
    wire = Buffer.from(raw);
    const i = wire.indexOf(0x7b) + 1; // just inside the opening brace
    wire[i] = wire[i] ^ 0x01;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-two-key-id': KEY_ID,
    'x-two-timestamp': timestamp,
    'x-two-nonce': nonce,
    'x-two-signature': signature,
  };
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await fetch(URL_, { method: 'POST', headers, body: wire });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparseable: text.slice(0, 200) };
  }
  const requestId = body?.request_id ?? '(none)';
  requestIds.push({ step, requestId, status: res.status });
  return {
    status: res.status,
    body,
    replayHeader: res.headers.get('idempotent-replay'),
    requestId,
  };
}

function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

console.log(`\ninternal actions acceptance (TOG-463)\n  target ${URL_}\n  key id ${KEY_ID}\n`);

// -- Step 3: all three live actions answer ok:true --------------------------
console.log('step 3  the three live actions');

const roleRes = await send('3.role.assign', {
  action: 'role.assign',
  discord_id: DISCORD_ID,
  role_key: ROLE_KEY,
});
check(
  'role.assign',
  roleRes.status === 200 && roleRes.body?.ok === true,
  `HTTP ${roleRes.status} ok=${roleRes.body?.ok} outcome=${roleRes.body?.result?.outcome} request_id=${roleRes.requestId}`,
);

// The announcement's idempotency key is reused verbatim by step 4.
const annKey = `tog463-ann-${randomBytes(8).toString('hex')}`;
const annBody = `TOG-463 acceptance run. Ignore. ${new Date().toISOString()}`;
const annPayload = { action: 'announcement.post', channel_key: CHANNEL_KEY, body: annBody };
const annRes = await send('3.announcement.post', annPayload, { idempotencyKey: annKey });
check(
  'announcement.post',
  annRes.status === 200 && annRes.body?.ok === true,
  `HTTP ${annRes.status} ok=${annRes.body?.ok} message_id=${annRes.body?.result?.message_id} request_id=${annRes.requestId}`,
);

const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const endsAt = new Date(Date.now() + 90_000_000).toISOString();
const evtRes = await send(
  '3.event.upsert',
  {
    action: 'event.upsert',
    event_key: `tog463-${randomBytes(6).toString('hex')}`,
    name: 'TOG-463 acceptance event',
    starts_at: startsAt,
    ends_at: endsAt,
    location: 'Acceptance run - ignore',
    description: 'Created by scripts/internal-actions-acceptance.ts',
  },
  { idempotencyKey: `tog463-evt-${randomBytes(8).toString('hex')}` },
);
check(
  'event.upsert',
  evtRes.status === 200 && evtRes.body?.ok === true,
  `HTTP ${evtRes.status} ok=${evtRes.body?.ok} outcome=${evtRes.body?.result?.outcome} event_id=${evtRes.body?.result?.event_id} request_id=${evtRes.requestId}`,
);

// -- Step 4: same Idempotency-Key, fresh nonce -> replayed, not re-posted ----
console.log('\nstep 4  idempotent retry of the announcement');
const replay = await send('4.announcement.replay', annPayload, { idempotencyKey: annKey });
check(
  'retry is 200',
  replay.status === 200,
  `HTTP ${replay.status} request_id=${replay.requestId}`,
);
check(
  'Idempotent-Replay: true',
  replay.replayHeader === 'true',
  `header=${replay.replayHeader ?? '(absent)'}`,
);
check(
  'same message_id as the original',
  Boolean(annRes.body?.result?.message_id) &&
    replay.body?.result?.message_id === annRes.body?.result?.message_id,
  `first=${annRes.body?.result?.message_id} retry=${replay.body?.result?.message_id}`,
);

// -- Step 5: tampered body -> 401 -------------------------------------------
console.log('\nstep 5  tampered body');
const tampered = await send(
  '5.tampered',
  { action: 'role.assign', discord_id: DISCORD_ID, role_key: ROLE_KEY },
  { tamperBody: true },
);
check(
  'tampered body is 401 unauthorized',
  tampered.status === 401 && tampered.body?.error?.code === 'unauthorized',
  `HTTP ${tampered.status} code=${tampered.body?.error?.code} request_id=${tampered.requestId}`,
);

// -- Step 6: verbatim replay (same nonce) -> 409 replayed --------------------
console.log('\nstep 6  verbatim replay, same nonce');
const fixedNonce = randomBytes(16).toString('hex');
const first = await send(
  '6.first',
  { action: 'role.assign', discord_id: DISCORD_ID, role_key: ROLE_KEY },
  { nonce: fixedNonce },
);
check('priming request is 200', first.status === 200, `HTTP ${first.status} request_id=${first.requestId}`);
const verbatim = await send(
  '6.verbatim-replay',
  { action: 'role.assign', discord_id: DISCORD_ID, role_key: ROLE_KEY },
  { nonce: fixedNonce },
);
check(
  'verbatim replay is 409 replayed',
  verbatim.status === 409 && verbatim.body?.error?.code === 'replayed',
  `HTTP ${verbatim.status} code=${verbatim.body?.error?.code} request_id=${verbatim.requestId}`,
);

// -- Step 7: every request above is a row in internal_action_log -------------
console.log('\nstep 7  the audit trail');
if (!DB_SPEC) {
  console.log('  SKIP  TWO_ACCEPT_DB not set - cannot read internal_action_log from here.');
  failures.push('step 7: not run (TWO_ACCEPT_DB unset)');
} else {
  const { openDb } = await import('../src/store/db.ts');
  const db = await openDb(DB_SPEC, DB_SCHEMA ? { schema: DB_SCHEMA } : {});
  console.log(`  reading internal_action_log from schema ${DB_SCHEMA || '(driver default)'}`);
  // `?` is the house placeholder style; the Postgres driver rewrites it, so
  // this same statement works against staging's Postgres unchanged.
  const lookup = db.prepare('SELECT status, outcome FROM internal_action_log WHERE request_id = ?');
  let found = 0;
  for (const r of requestIds) {
    if (r.requestId === '(none)') continue;
    const row = await lookup.get<{ status: number; outcome: string }>(r.requestId);
    if (row) {
      found += 1;
      const statusMatches = Number(row.status) === r.status;
      if (!statusMatches) {
        failures.push(`step 7: ${r.step} logged status ${row.status}, HTTP said ${r.status}`);
      }
      console.log(
        `  row   ${r.step.padEnd(24)} ${r.requestId}  status=${row.status} outcome=${row.outcome}` +
          (statusMatches ? '' : '   <-- MISMATCH'),
      );
    } else {
      failures.push(`step 7: no internal_action_log row for ${r.step} ${r.requestId}`);
      console.log(`  MISS  ${r.step.padEnd(24)} ${r.requestId}`);
    }
  }
  check(
    'every request has an audit row',
    found === requestIds.length,
    `${found}/${requestIds.length} rows present`,
  );
  await db.close();
}

// -- Summary ----------------------------------------------------------------
console.log('\nrequest ids');
for (const r of requestIds) console.log(`  ${r.step.padEnd(24)} HTTP ${r.status}  ${r.requestId}`);

console.log(`\n${requestIds.length} requests, ${failures.length} failure(s)`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log('\nNEEDS WORK');
  process.exit(1);
}
console.log('\nPASS');
