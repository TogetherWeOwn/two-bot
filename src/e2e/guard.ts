/**
 * The volume fence around the end-to-end test account (TOG-3978).
 *
 * WHY A SEPARATE OBJECT INSTEAD OF RULES SPRINKLED THROUGH THE FLOWS
 *
 * The owner approved this harness on 2026-09-22 on five conditions, and two of
 * them are about traffic shape rather than about what the tests check: low,
 * human-ish volume, and a way to stop the moment Discord objects. Conditions
 * like that are only real if there is exactly one place they can be enforced
 * and exactly one place a reviewer has to read. A flow that reaches the
 * network without going through `act()` is the bug this file is shaped to make
 * obvious: `git grep 'transport\.' src/e2e` returns nothing outside
 * `flows.ts`, and everything in `flows.ts` is wrapped.
 *
 * WHAT IT ENFORCES, AND WHY EACH ONE
 *
 *   Pacing. >= 2s between actions, plus jitter. Two seconds is the owner's
 *   number. The jitter is not decoration: a client that acts on a metronome is
 *   distinguishable from a person by the variance of its inter-event gaps
 *   alone, and the whole point of the throwaway account is that it behaves
 *   like an ordinary member of a small server.
 *
 *   A message budget. Single digits per run, the owner's words, default 9.
 *   Checked BEFORE pacing so an over-budget run fails in milliseconds instead
 *   of sleeping its way to the same answer.
 *
 *   An action budget. Reactions and button clicks are not messages, so the
 *   message budget does not bound them and a flow with a loop in it could
 *   quietly make four hundred of them. This is the fence for that.
 *
 *   Halt on the first refusal. 403 is the owner's stop signal. 401 and 429 are
 *   here too because they are the other two ways Discord says "this account",
 *   and continuing after any of them converts a recoverable situation into a
 *   flagged account.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never sees the token. The credential lives in the transport and nowhere
 * else, which is what lets the transcript this object produces be attached to
 * a board card without redacting anything.
 */

/** A halt is terminal for the run. Once thrown, the same error is re-thrown forever. */
export type HaltReason =
  /** The run asked to send more messages than its budget allows. */
  | 'message_budget'
  /** The run asked for more actions of any kind than its budget allows. */
  | 'action_budget'
  /** Discord said 403. The owner's stop-on-first-403 condition. */
  | 'forbidden'
  /** Discord said 401. The credential is dead or revoked; rotation is the fix. */
  | 'unauthorized'
  /** Discord said 429. Being rate-limited is the signal we were trying not to produce. */
  | 'rate_limited'
  /** The kill switch was tripped, by an operator or by the runner. */
  | 'kill_switch';

export class HarnessHalt extends Error {
  readonly reason: HaltReason;
  /** Short and non-secret. Goes into the transcript and the console. */
  readonly detail: string;
  constructor(reason: HaltReason, detail: string) {
    super(`e2e harness halted (${reason}): ${detail}`);
    this.name = 'HarnessHalt';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Injected so tests do not spend real seconds asleep, and gaps are assertable. */
export interface HarnessClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: HarnessClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * What an action costs. Only `message` counts against the message budget;
 * everything counts against the action budget.
 */
export type ActionKind = 'message' | 'reaction' | 'button' | 'voice' | 'observe';

/**
 * What the transport hands back. The status is the whole reason this is not
 * just `Promise<T>`: the guard cannot enforce stop-on-first-403 unless every
 * call reports the HTTP status it got, including the successful ones.
 */
export interface Acted<T> {
  status: number;
  value: T;
}

/** One line of the evidence a run produces. Contains no credential, by construction. */
export interface TranscriptEntry {
  label: string;
  kind: ActionKind;
  status: number;
  /** ms since the guard was created, so a transcript is readable without wall clocks. */
  atMs: number;
  /** ms the guard slept before this action. Proves the pacing condition per action. */
  waitedMs: number;
}

export interface GuardOptions {
  /** Floor on the gap between two actions, ms. The owner's condition is 2000. */
  minGapMs?: number;
  /** Extra uniform-random delay on top of the floor, ms. Breaks the metronome. */
  jitterMs?: number;
  /** Messages this run may send. The owner's condition is a single digit. */
  maxMessagesPerRun?: number;
  /** Actions of any kind this run may take. Bounds a flow with a loop in it. */
  maxActionsPerRun?: number;
  clock?: HarnessClock;
  /** Injected so a test can pin the jitter and still assert the floor holds. */
  random?: () => number;
}

export const DEFAULT_MIN_GAP_MS = 2_000;
export const DEFAULT_JITTER_MS = 1_500;
export const DEFAULT_MAX_MESSAGES = 9;
export const DEFAULT_MAX_ACTIONS = 30;

export class HarnessGuard {
  readonly minGapMs: number;
  readonly jitterMs: number;
  readonly maxMessagesPerRun: number;
  readonly maxActionsPerRun: number;
  private clock: HarnessClock;
  private random: () => number;
  private startedAt: number;
  private lastActionAt: number | null = null;

  messagesSent = 0;
  actionsTaken = 0;
  /** Set once, by the first halt. Every later call re-throws it unchanged. */
  halted: HarnessHalt | null = null;
  readonly transcript: TranscriptEntry[] = [];

  constructor(o: GuardOptions = {}) {
    this.minGapMs = o.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.jitterMs = o.jitterMs ?? DEFAULT_JITTER_MS;
    this.maxMessagesPerRun = o.maxMessagesPerRun ?? DEFAULT_MAX_MESSAGES;
    this.maxActionsPerRun = o.maxActionsPerRun ?? DEFAULT_MAX_ACTIONS;
    this.clock = o.clock ?? systemClock;
    this.random = o.random ?? Math.random;
    this.startedAt = this.clock.now();
  }

  /**
   * Halt the run. Idempotent: the first reason wins, because the second halt is
   * usually a consequence of the first and overwriting it loses the cause.
   */
  halt(reason: HaltReason, detail: string): HarnessHalt {
    if (!this.halted) this.halted = new HarnessHalt(reason, detail);
    return this.halted;
  }

  /**
   * Run one action against Discord, under every rule above.
   *
   * Order matters and is the tested part: budget first (cheap refusal), then
   * pacing (expensive), then the call, then the status check. A budget failure
   * must not cost two seconds, and a call must never happen after a halt.
   */
  async act<T>(kind: ActionKind, label: string, fn: () => Promise<Acted<T>>): Promise<T> {
    if (this.halted) throw this.halted;

    if (this.actionsTaken + 1 > this.maxActionsPerRun) {
      throw this.halt(
        'action_budget',
        `${label}: ${this.actionsTaken} actions already taken, budget is ${this.maxActionsPerRun}`,
      );
    }
    if (kind === 'message' && this.messagesSent + 1 > this.maxMessagesPerRun) {
      throw this.halt(
        'message_budget',
        `${label}: ${this.messagesSent} messages already sent, budget is ${this.maxMessagesPerRun}`,
      );
    }

    const waitedMs = await this.pace();

    // Counted before the call, not after: a request that threw still reached
    // Discord as far as anyone watching the account is concerned.
    this.actionsTaken++;
    if (kind === 'message') this.messagesSent++;

    const acted = await fn();
    this.lastActionAt = this.clock.now();
    this.transcript.push({
      label,
      kind,
      status: acted.status,
      atMs: this.lastActionAt - this.startedAt,
      waitedMs,
    });

    if (acted.status === 403) throw this.halt('forbidden', `${label}: Discord returned 403`);
    if (acted.status === 401) throw this.halt('unauthorized', `${label}: Discord returned 401`);
    if (acted.status === 429) throw this.halt('rate_limited', `${label}: Discord returned 429`);

    return acted.value;
  }

  /** Sleep until the floor plus jitter has elapsed since the last action. Returns ms slept. */
  private async pace(): Promise<number> {
    if (this.lastActionAt === null) return 0;
    const target = this.minGapMs + Math.floor(this.random() * this.jitterMs);
    const elapsed = this.clock.now() - this.lastActionAt;
    const wait = target - elapsed;
    if (wait <= 0) return 0;
    await this.clock.sleep(wait);
    return wait;
  }
}
