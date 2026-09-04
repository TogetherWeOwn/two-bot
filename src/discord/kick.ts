/**
 * The one place in this codebase that can remove a member from the server.
 *
 * WHY THIS IS A SEPARATE FILE FROM rest.ts
 *
 * `DiscordRest` exposes exactly one verb, `get()`, and read/report scripts rely
 * on that as a guarantee rather than a habit. Bolting a `delete()` onto
 * `DiscordRest` would put a destructive verb one autocomplete away from every
 * read-only script in the repo.
 *
 * So the destructive verb lives here, alone, in a class that does one thing and
 * has to be imported by name. `git grep DiscordKicker` returns every file in
 * the repo that can remove anybody.
 *
 * KICK, NOT BAN
 *
 * There is no ban method here and there should not be one. A kicked account can
 * rejoin and go through the rules gate; a banned one cannot, and un-banning 30
 * accounts by hand is not a realistic undo. TOG-411 records the Community
 * Manager's recommendation; this file is where it is enforced.
 *
 * Kick is also naturally idempotent, which is what makes a half-finished run
 * safe to repeat: `DELETE /guilds/{g}/members/{u}` on somebody who is already
 * gone returns 404, which we report as `already_gone` rather than as an error.
 * A crash between the successful call and the audit write therefore costs one
 * wasted request on the retry, never a double action.
 */
import { log } from '../core/log.ts';

const API = 'https://discord.com/api/v10';

export type KickOutcome =
  /** 204. The member was in the server and is not any more. */
  | 'kicked'
  /** 404. Not a member — already removed, or left on their own. Terminal, not a failure. */
  | 'already_gone'
  /** 403. Missing Kick Members, or the target outranks the bot. Retrying will not help. */
  | 'forbidden'
  /** 429s outlasted our retry budget. Retryable later; nothing was changed. */
  | 'rate_limited'
  /** Anything else: 401, 5xx that never cleared, a socket that never opened. */
  | 'failed';

export interface KickResult {
  outcome: KickOutcome;
  /** HTTP status, or null when the request never produced a response. */
  status: number | null;
  /** Short, non-secret reason. Goes into the audit line and the console. */
  detail: string;
  /** How many HTTP attempts this member cost, including retries. */
  attempts: number;
}

/**
 * What the removal engine needs. Narrow on purpose: the engine is tested
 * against a fake that implements this and nothing else, so no test can reach a
 * real socket even by accident.
 */
export interface MemberRemover {
  kick(memberId: string, reason: string): Promise<KickResult>;
}

export interface KickerOptions {
  token: string;
  guildId: string;
  /** Override the API host. Used by tests. */
  base?: string;
  /**
   * Minimum gap between removals, ms. Deliberately slower than the 110ms
   * rest.ts uses for reads: a burst of removals is exactly the traffic shape
   * Discord rate-limits hardest, and thirty accounts at 350ms is ten seconds.
   */
  minIntervalMs?: number;
  /** Retries per member for 429 and 5xx. Beyond this the member is reported, not retried. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Injected so tests do not spend real seconds asleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Cap on how long one 429 may park us, so a bad `retry-after` cannot hang the run. */
const MAX_RETRY_AFTER_MS = 60_000;

export class DiscordKicker implements MemberRemover {
  private token: string;
  private guildId: string;
  private base: string;
  private minInterval: number;
  private maxRetries: number;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private lastAt = 0;
  /** Requests made, so a run can report its own cost. */
  requests = 0;

  constructor(o: KickerOptions) {
    this.token = o.token;
    this.guildId = o.guildId;
    this.base = o.base ?? API;
    this.minInterval = o.minIntervalMs ?? 350;
    this.maxRetries = o.maxRetries ?? 4;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async pace(): Promise<void> {
    const wait = this.lastAt + this.minInterval - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastAt = Date.now();
  }

  /**
   * Remove one member. Never throws: every ending is a `KickResult`, because
   * the caller has an audit line to write for this member either way and an
   * exception thrown out of here would lose it.
   */
  async kick(memberId: string, reason: string): Promise<KickResult> {
    const path = `/guilds/${this.guildId}/members/${memberId}`;
    let attempts = 0;

    for (;;) {
      await this.pace();
      attempts++;
      this.requests++;

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bot ${this.token}`,
            // Discord shows this in the server's own audit log next to the
            // removal, so a moderator reading it months later sees why.
            // Header values must be latin-1; encode so a stray character
            // cannot make the whole request unsendable.
            'X-Audit-Log-Reason': encodeURIComponent(reason).slice(0, 512),
          },
        });
      } catch (err) {
        if (attempts > this.maxRetries) {
          return { outcome: 'failed', status: null, detail: `network: ${String(err)}`, attempts };
        }
        await this.sleep(500 * 2 ** (attempts - 1));
        continue;
      }

      if (res.status === 204 || res.status === 200) {
        return { outcome: 'kicked', status: res.status, detail: 'removed', attempts };
      }
      if (res.status === 404) {
        return { outcome: 'already_gone', status: 404, detail: 'not a member', attempts };
      }
      if (res.status === 403) {
        return {
          outcome: 'forbidden',
          status: 403,
          detail: 'missing Kick Members, or the target outranks the bot',
          attempts,
        };
      }
      if (res.status === 401) {
        return { outcome: 'failed', status: 401, detail: 'token rejected', attempts };
      }

      if (res.status === 429) {
        const waitMs = await retryAfterMs(res);
        log.debug('kick_rate_limited', { memberId, waitMs, attempts });
        if (attempts > this.maxRetries) {
          return {
            outcome: 'rate_limited',
            status: 429,
            detail: `still rate limited after ${attempts} attempts`,
            attempts,
          };
        }
        await this.sleep(waitMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempts > this.maxRetries) {
          return { outcome: 'failed', status: res.status, detail: 'server error', attempts };
        }
        await this.sleep(500 * 2 ** (attempts - 1));
        continue;
      }

      return { outcome: 'failed', status: res.status, detail: `unexpected status`, attempts };
    }
  }
}

/**
 * How long Discord wants us to wait. The header is in seconds; the JSON body
 * carries a more precise `retry_after`, also in seconds. Body wins when both
 * are present, and the result is clamped — a malformed `retry-after` of 86400
 * must not park an operator's terminal for a day.
 */
async function retryAfterMs(res: Response): Promise<number> {
  let seconds = Number(res.headers.get('retry-after') ?? '1');
  try {
    const body = (await res.json()) as { retry_after?: number };
    if (typeof body?.retry_after === 'number' && Number.isFinite(body.retry_after)) {
      seconds = body.retry_after;
    }
  } catch {
    // A 429 without a JSON body is normal from a proxy. The header stands.
  }
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.min(seconds * 1000 + 250, MAX_RETRY_AFTER_MS);
}
