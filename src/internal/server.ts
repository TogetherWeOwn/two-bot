/**
 * POST /internal/actions - the endpoint the website calls when it needs
 * something to happen in the TWO Discord server.
 * docs/INTERNAL_ACTIONS.md.
 *
 * The website never holds the bot token. It signs a request naming an action
 * from a fixed allowlist, and this process decides whether to do it. That is
 * the entire trust model, and it survives the website being compromised.
 *
 * Scope of this file: the whole endpoint. Listener, HMAC, skew, replay, rate
 * limit, typed errors, structured logging, all four allowlisted actions, and -
 * since TOG-44 put the durable store behind it - idempotency keys and the
 * durable audit trail.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { log } from '../core/log.ts';
import { assertPrivateBind } from './bind.ts';
import {
  ActionError,
  authFailure,
  errorBody,
  retryableFor,
  statusFor,
  successBody,
  type ErrorCode,
} from './errors.ts';
import { ACTIONS_PATH, type KeyRing } from './signing.ts';
import { NonceCache, withinSkew } from './nonce.ts';
import { ADD_MEMBER_BUCKET, DEFAULT_BUCKET, TokenBuckets } from './rateLimit.ts';
import {
  assertAllowed,
  runAction,
  NEEDS_IDEMPOTENCY_KEY,
  type ActionContext,
  type ActionOutcome,
} from './actions.ts';
import type { ActionDiscord } from './discordActions.ts';
import type { ExpectedJoins } from '../core/expectedJoins.ts';
import { requestHash, type InternalActionStore } from './store.ts';
import type { ModerationResolver } from '../moderation/resolver.ts';
import type { ModerationService } from '../moderation/service.ts';

/** Anything larger than this is a bug on the caller, not a request. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * What we accept as an Idempotency-Key. A UUID is what the doc asks for, but
 * anything opaque and bounded is safe - it is only ever compared, never
 * interpreted. The bound matters because it is a primary key column and it
 * lands in the audit trail.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export interface InternalServerOptions {
  host: string;
  port: number;
  keys: KeyRing;
  guildId: string;
  discord: ActionDiscord;
  roleKeys: Map<string, string>;
  /** Channels announcement.post and event.upsert may address, by key. */
  channelKeys?: Map<string, string>;
  /** Which implemented actions are live. See ActionContext.enabled. */
  enabled: Set<string>;
  /**
   * Durable state: nonces, idempotency keys, the audit trail.
   *
   * Optional so the auth-only tests can start a listener without a database.
   * When it is absent the replay guard falls back to the in-process cache,
   * which a restart forgets, and the two key-requiring actions refuse to run
   * at all rather than run unprotected.
   */
  store?: InternalActionStore | null;
  /**
   * Join attribution for guild.add_member - docs/INTERNAL_ACTIONS.md §7. The
   * same instance the gateway handler consumes from; src/index.ts shares it
   * between the two. Optional, and without it one-click joins are filed
   * `unknown`, exactly as before.
   */
  expectedJoins?: ExpectedJoins | null;
  moderation?: { resolver: ModerationResolver; service: ModerationService } | null;
  skewSeconds?: number;
  nonceTtlSeconds?: number;
  maxBodyBytes?: number;
}

export interface InternalServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startInternalActions(opts: InternalServerOptions): Promise<InternalServer> {
  // Before a socket exists. A config mistake should be a crash, not a quietly
  // exposed remote control for the Discord server.
  assertPrivateBind(opts.host);

  if (opts.keys.size === 0) {
    throw new Error('Refusing to start the internal actions endpoint with no signing keys.');
  }

  const nonces = new NonceCache({ ttlSeconds: opts.nonceTtlSeconds ?? 240 });
  const buckets = new TokenBuckets();
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  const server: Server = createServer((req, res) => {
    void handle(req, res, opts, nonces, buckets, maxBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  log.info('internal_actions_listening', {
    host: opts.host,
    port: addr.port,
    keyIds: opts.keys.size,
    enabled: [...opts.enabled].sort(),
    // False means the replay guard is in-process and a restart re-opens a
    // ≤240s window. Said out loud at boot so it is a known state.
    durable: Boolean(opts.store),
    channelKeys: opts.channelKeys?.size ?? 0,
  });

  return {
    port: addr.port,
    url: `http://${opts.host}:${addr.port}${ACTIONS_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: InternalServerOptions,
  nonces: NonceCache,
  buckets: TokenBuckets,
  maxBody: number,
): Promise<void> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  // Filled in as we learn them, so the log line is useful even when we reject
  // early. Nothing from the request body is ever added here.
  const seen: Seen = { keyId: null, action: null, idempotencyKey: null };

  try {
    // Any route but ours is a 404. Rejecting before reading a body means a
    // stray scanner cannot make us allocate anything.
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== ACTIONS_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'malformed', message: 'Unknown route', retryable: false }, request_id: requestId }));
      await finish(opts, { requestId, seen, outcome: 'rejected', code: 'malformed', status: 404, reason: 'unknown_route', startedAt });
      return;
    }

    const raw = await readBody(req, maxBody);
    const result = await authoriseAndRun(req, raw, opts, nonces, buckets, seen);

    // A replayed result is a success and looks like one, because the operation
    // really did happen. The header is how a caller tells "I posted that" from
    // "you already posted that" without the result shape changing under it.
    respond(res, 200, successBody(result.result, requestId), result.replayed ? { 'idempotent-replay': 'true' } : undefined);
    await finish(opts, {
      requestId,
      seen,
      outcome: result.replayed ? `replayed:${result.outcome}` : result.outcome,
      code: null,
      status: 200,
      reason: result.replayed ? 'idempotent_replay' : null,
      startedAt,
    });
  } catch (err) {
    const actionErr = toActionError(err);
    const status = statusFor(actionErr.code);
    const headers = actionErr.retryAfter ? { 'retry-after': String(actionErr.retryAfter) } : undefined;
    respond(res, status, errorBody(actionErr, requestId), headers);
    await finish(opts, {
      requestId,
      seen,
      outcome: 'rejected',
      code: actionErr.code,
      status,
      reason: actionErr.logReason,
      startedAt,
      extra: actionErr.code === 'internal' ? safeErrorFields(err) : undefined,
    });
  }
}

/**
 * The two records of a request: the structured stdout line and the durable
 * audit row. Both, always, for every request.
 *
 * The audit write is best-effort *by design*. The response has already been
 * sent by the time we get here, so throwing would only produce an unhandled
 * rejection - and if the database is down we would rather lose an audit row
 * than have the endpoint start failing requests it has already carried out.
 * The failure is itself logged, so a silent gap in the trail is not possible.
 */
async function finish(opts: InternalServerOptions, a: LogArgs): Promise<void> {
  logLine(a);
  if (!opts.store) return;
  try {
    await opts.store.recordAudit({
      requestId: a.requestId,
      keyId: a.seen.keyId,
      action: a.seen.action,
      idempotencyKey: a.seen.idempotencyKey,
      outcome: a.outcome,
      code: a.code,
      status: a.status,
      reason: a.reason,
      durationMs: Date.now() - a.startedAt,
    });
  } catch (err) {
    log.error('internal_audit_write_failed', { requestId: a.requestId, err: String(err) });
  }
}

/**
 * The order of these checks is load-bearing.
 *
 * Signature first, because everything after it trusts the key id - including
 * the rate limiter, which would otherwise let anyone lock out a real caller by
 * spamming its key id. Then freshness, then replay, then the limit. The nonce
 * is burned before we look at the body at all, so a replayed request cannot
 * reach Discord no matter what it contains.
 */
async function authoriseAndRun(
  req: IncomingMessage,
  raw: Buffer,
  opts: InternalServerOptions,
  nonces: NonceCache,
  buckets: TokenBuckets,
  seen: Seen,
): Promise<ActionOutcome & { replayed: boolean }> {
  const keyId = header(req, 'x-two-key-id');
  const timestamp = header(req, 'x-two-timestamp');
  const nonce = header(req, 'x-two-nonce');
  const signature = header(req, 'x-two-signature');
  seen.keyId = keyId ? keyId.slice(0, 64) : null;

  if (!keyId || !timestamp || !nonce || !signature) throw authFailure('missing_auth_headers');
  if (!/^[0-9a-f]{32}$/i.test(nonce)) throw authFailure('bad_nonce_format');

  // Unknown key id and wrong signature are one branch and one message, by
  // design - the caller cannot probe which key ids exist.
  if (!opts.keys.verify(keyId, signature, timestamp, nonce, raw)) throw authFailure('bad_signature');

  if (!withinSkew(timestamp, opts.skewSeconds ?? 120)) {
    throw new ActionError('stale_request', 'Timestamp is outside the ±120s window', {
      logReason: 'stale_timestamp',
    });
  }

  // Durable when there is a store, in-process otherwise. The difference is
  // what a restart forgets: with the table, nothing.
  const fresh = opts.store ? await opts.store.offerNonce(keyId, nonce) : nonces.offer(nonce);
  if (!fresh) {
    throw new ActionError('replayed', 'This nonce has already been used', { logReason: 'replayed_nonce' });
  }

  const perKey = buckets.take(`key:${keyId}`, DEFAULT_BUCKET);
  if (!perKey.allowed) {
    throw new ActionError('rate_limited', 'Rate limit exceeded for this key', {
      logReason: 'rate_limited_key',
      retryAfter: perKey.retryAfter,
    });
  }

  const body = parseBody(req, raw);
  const action = body.action;
  if (typeof action !== 'string' || action.length === 0) {
    throw new ActionError('malformed', '"action" must be a string', { logReason: 'missing_action' });
  }
  seen.action = action.slice(0, 64);

  const store = opts.store ?? null;
  assertAllowed(action, { enabled: opts.enabled, store });

  // The tighter bucket on the one action that touches membership.
  if (action === 'guild.add_member') {
    const perAction = buckets.take(`key:${keyId}:add_member`, ADD_MEMBER_BUCKET);
    if (!perAction.allowed) {
      throw new ActionError('rate_limited', 'Rate limit exceeded for guild.add_member', {
        logReason: 'rate_limited_add_member',
        retryAfter: perAction.retryAfter,
      });
    }
  }

  const ctx: ActionContext = {
    guildId: opts.guildId,
    discord: opts.discord,
    roleKeys: opts.roleKeys,
    channelKeys: opts.channelKeys ?? new Map(),
    expectedJoins: opts.expectedJoins ?? null,
    enabled: opts.enabled,
    store,
    moderation: opts.moderation ?? null,
    idempotencyKey: null,
  };

  if (!NEEDS_IDEMPOTENCY_KEY.has(action)) {
    return { ...(await runAction(action, body, ctx)), replayed: false };
  }
  return runIdempotently(req, raw, action, body, ctx, store!, keyId, seen);
}

/**
 * The retry-safe path, for the actions where a repeat would post a second
 * announcement or create a duplicate event.
 *
 * The claim is taken BEFORE the Discord call and the result is written AFTER
 * it, so the window in which a crash loses the record is exactly the Discord
 * call itself. A crash there leaves an `in_flight` row that another request
 * may take over once it is stale (store.ts, CLAIM_STALE_SECONDS) - which can
 * re-post, and that is the honest trade: we cannot both guarantee at-most-once
 * across a process death and stay unstuck. At-most-once inside a living
 * process, and a bounded, logged window across a crash.
 */
async function runIdempotently(
  req: IncomingMessage,
  raw: Buffer,
  action: Parameters<typeof runAction>[0],
  body: Record<string, unknown>,
  ctx: ActionContext,
  store: InternalActionStore,
  keyId: string,
  seen: Seen,
): Promise<ActionOutcome & { replayed: boolean }> {
  const idempotencyKey = header(req, 'idempotency-key').trim();
  if (!idempotencyKey) {
    throw new ActionError('malformed', `"${action}" requires an Idempotency-Key header`, {
      logReason: 'missing_idempotency_key',
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new ActionError('malformed', 'Idempotency-Key must be 8-200 characters of [A-Za-z0-9._:-]', {
      logReason: 'bad_idempotency_key',
    });
  }
  seen.idempotencyKey = idempotencyKey;

  const claim = await store.claim(keyId, idempotencyKey, action, requestHash(raw));

  if (claim.state === 'replayed') {
    return { result: claim.stored.result, outcome: claim.stored.outcome, replayed: true };
  }
  if (claim.state === 'in_flight') {
    throw new ActionError('in_progress', 'An earlier attempt at this operation is still running', {
      logReason: 'idempotency_in_flight',
    });
  }
  if (claim.state === 'mismatch') {
    // Same key, different body. Handing back the other operation's result
    // would hide a caller bug; a 400 names it on the first occurrence.
    throw new ActionError('malformed', 'This Idempotency-Key was used for a different request', {
      logReason: 'idempotency_key_reused',
    });
  }

  try {
    ctx.idempotencyKey = idempotencyKey;
    const outcome = await runAction(action, body, ctx);
    await store.complete(keyId, idempotencyKey, { outcome: outcome.outcome, result: outcome.result });
    return { ...outcome, replayed: false };
  } catch (err) {
    // Give the key back, so a retry of a retryable failure is a real second
    // attempt rather than a cached error. See store.release().
    await store.release(keyId, idempotencyKey).catch((releaseErr: unknown) => {
      log.error('internal_idempotency_release_failed', { err: String(releaseErr) });
    });
    throw err;
  }
}

function parseBody(req: IncomingMessage, raw: Buffer): Record<string, unknown> {
  const ct = (req.headers['content-type'] ?? '').toString().toLowerCase();
  if (!ct.startsWith('application/json')) {
    throw new ActionError('malformed', 'Content-Type must be application/json', {
      logReason: 'bad_content_type',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ActionError('malformed', 'Body is not valid JSON', { logReason: 'bad_json' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ActionError('malformed', 'Body must be a JSON object', { logReason: 'body_not_object' });
  }
  return parsed as Record<string, unknown>;
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        reject(new ActionError('malformed', 'Body is too large', { logReason: 'body_too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new ActionError('malformed', 'Could not read the body', { logReason: 'body_read_failed' })));
  });
}

function respond(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
    ...extraHeaders,
  });
  res.end(s);
}

function toActionError(err: unknown): ActionError {
  if (err instanceof ActionError) return err;
  return new ActionError('internal', 'The bot failed to handle this request', { logReason: 'unhandled' });
}

/**
 * What we keep from an error we did not throw ourselves: its class and where
 * it came from. **Never its message.**
 *
 * A message can quote the request that produced it, and one of our request
 * bodies carries a live member credential. Logging where it broke is enough to
 * debug from; logging what it said is how an access_token ends up on disk.
 */
function safeErrorFields(err: unknown): Record<string, unknown> {
  const e = err as { name?: string; stack?: string };
  const frame = (e?.stack ?? '')
    .split('\n')
    .find((l) => l.trimStart().startsWith('at '))
    ?.trim();
  return { errName: typeof e?.name === 'string' ? e.name : typeof err, errAt: frame ?? null };
}

/**
 * What we have learned about a request so far. Deliberately three scalars and
 * not the request: nothing from the body may be added here, because one of our
 * bodies carries a live member OAuth token and this struct reaches both the
 * log line and the audit table.
 */
interface Seen {
  keyId: string | null;
  action: string | null;
  idempotencyKey: string | null;
}

interface LogArgs {
  requestId: string;
  seen: Seen;
  outcome: string;
  code: ErrorCode | null;
  status: number;
  reason: string | null;
  startedAt: number;
  extra?: Record<string, unknown>;
}

/**
 * One structured line per request, accepted or rejected. §4.
 *
 * Fields are listed explicitly. There is no spread of the request body here
 * and there must never be one: a run of `stale_request` should be visibly a
 * clock problem, and nothing in this line should ever be a secret.
 */
function logLine(a: LogArgs): void {
  log.info('internal_action', {
    requestId: a.requestId,
    keyId: a.seen.keyId,
    action: a.seen.action,
    idempotencyKey: a.seen.idempotencyKey,
    outcome: a.outcome,
    code: a.code,
    status: a.status,
    reason: a.reason,
    retryable: a.code ? retryableFor(a.code) : undefined,
    durationMs: Date.now() - a.startedAt,
    ...a.extra,
  });
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID-ish request id: time-ordered, so a grep of the log sorts naturally,
 * and random enough not to collide. It is the join key between the website's
 * logs and ours, so it goes in every response including the failures.
 */
function newRequestId(): string {
  let t = Date.now();
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (const b of randomBytes(16)) out += CROCKFORD[b % 32];
  return out;
}
