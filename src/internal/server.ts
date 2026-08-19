/**
 * POST /internal/actions - the endpoint the website calls when it needs
 * something to happen in the TWO Discord server.
 * docs/INTERNAL_ACTIONS.md.
 *
 * The website never holds the bot token. It signs a request naming an action
 * from a fixed allowlist, and this process decides whether to do it. That is
 * the entire trust model, and it survives the website being compromised.
 *
 * Scope of this file (TWO-59): the pre-Postgres slice. Listener, HMAC, skew,
 * replay, rate limit, typed errors, structured logging, and the two naturally
 * idempotent actions. The durable idempotency-key store and the durable audit
 * trail are TWO-24, behind TWO-18.
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
import { assertAllowed, runAction, type ActionContext } from './actions.ts';
import type { ActionDiscord } from './discordActions.ts';

/** Anything larger than this is a bug on the caller, not a request. */
const MAX_BODY_BYTES = 64 * 1024;

export interface InternalServerOptions {
  host: string;
  port: number;
  keys: KeyRing;
  guildId: string;
  discord: ActionDiscord;
  roleKeys: Map<string, string>;
  /** Which implemented actions are live. See ActionContext.enabled. */
  enabled: Set<string>;
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
  const seen: { keyId: string | null; action: string | null } = { keyId: null, action: null };

  try {
    // Any route but ours is a 404. Rejecting before reading a body means a
    // stray scanner cannot make us allocate anything.
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== ACTIONS_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'malformed', message: 'Unknown route', retryable: false }, request_id: requestId }));
      logLine({ requestId, seen, outcome: 'rejected', code: 'malformed', status: 404, reason: 'unknown_route', startedAt });
      return;
    }

    const raw = await readBody(req, maxBody);
    const result = await authoriseAndRun(req, raw, opts, nonces, buckets, seen);

    respond(res, 200, successBody(result.result, requestId));
    logLine({ requestId, seen, outcome: result.outcome, code: null, status: 200, reason: null, startedAt });
  } catch (err) {
    const actionErr = toActionError(err);
    const status = statusFor(actionErr.code);
    const headers = actionErr.retryAfter ? { 'retry-after': String(actionErr.retryAfter) } : undefined;
    respond(res, status, errorBody(actionErr, requestId), headers);
    logLine({
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
  seen: { keyId: string | null; action: string | null },
) {
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

  if (!nonces.offer(nonce)) {
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

  assertAllowed(action, opts.enabled);

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
    enabled: opts.enabled,
  };
  return runAction(action, body, ctx);
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

interface LogArgs {
  requestId: string;
  seen: { keyId: string | null; action: string | null };
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
