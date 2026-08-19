/**
 * The typed error envelope from docs/INTERNAL_ACTIONS.md §2.
 *
 * The website branches on `code` and on the `retryable` boolean, never on the
 * English in `message`. So the mapping from code to HTTP status and to
 * retryable lives here, once, and nothing else is allowed to invent a shape.
 */

export type ErrorCode =
  | 'malformed'
  | 'unauthorized'
  | 'stale_request'
  | 'action_not_allowed'
  | 'replayed'
  | 'discord_rejected'
  | 'rate_limited'
  | 'internal'
  | 'discord_unavailable'
  | 'upstream_timeout';

interface CodeSpec {
  status: number;
  retryable: boolean;
}

/** §2's table, as data. Adding a code means adding a row here and in the doc. */
const CODES: Record<ErrorCode, CodeSpec> = {
  malformed: { status: 400, retryable: false },
  unauthorized: { status: 401, retryable: false },
  stale_request: { status: 401, retryable: false },
  action_not_allowed: { status: 403, retryable: false },
  replayed: { status: 409, retryable: false },
  discord_rejected: { status: 422, retryable: false },
  rate_limited: { status: 429, retryable: true },
  internal: { status: 500, retryable: true },
  discord_unavailable: { status: 502, retryable: true },
  upstream_timeout: { status: 504, retryable: true },
};

export function statusFor(code: ErrorCode): number {
  return CODES[code].status;
}

export function retryableFor(code: ErrorCode): boolean {
  return CODES[code].retryable;
}

/**
 * The one message every auth failure returns.
 *
 * A bad signature and an unknown key id must be indistinguishable, so neither
 * path is allowed to be helpful. Anything more specific goes in our log, not
 * in the response.
 */
export const AUTH_FAILURE_MESSAGE = 'Signature verification failed';

/**
 * Thrown anywhere in the request pipeline; caught once at the top and turned
 * into the envelope. `logReason` is the detail we keep for ourselves - it is
 * written to our structured log and never to the response body.
 */
export class ActionError extends Error {
  code: ErrorCode;
  logReason: string;
  /** Seconds, for `rate_limited` only. */
  retryAfter?: number;

  constructor(code: ErrorCode, message: string, opts: { logReason?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.logReason = opts.logReason ?? code;
    this.retryAfter = opts.retryAfter;
  }
}

export function authFailure(logReason: string): ActionError {
  return new ActionError('unauthorized', AUTH_FAILURE_MESSAGE, { logReason });
}

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean };
  request_id: string;
}

export function errorBody(err: ActionError, requestId: string): ErrorBody {
  return {
    ok: false,
    error: { code: err.code, message: err.message, retryable: retryableFor(err.code) },
    request_id: requestId,
  };
}

export interface SuccessBody {
  ok: true;
  result: Record<string, unknown>;
  request_id: string;
}

export function successBody(result: Record<string, unknown>, requestId: string): SuccessBody {
  return { ok: true, result, request_id: requestId };
}
