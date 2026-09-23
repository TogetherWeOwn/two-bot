/**
 * Run flows under the guard and write down what happened (TOG-3978).
 *
 * The transcript this produces is the deliverable. These cards are blocked
 * today because the only evidence anyone can offer for "a member joined and
 * the welcome fired" is a screenshot a human took; a transcript with a per-step
 * status, the gap the harness waited, and which gateway assertion matched is
 * the thing that replaces it. It is a work product, so it must be publishable
 * as-is: no token ever reaches it, and `dryRun` is a top-level field so a
 * planned run can never be mistaken for a proof.
 *
 * TWO KINDS OF FAILURE, TREATED DIFFERENTLY.
 *
 *   A failed assertion is about the BOT. The flow is recorded as `failed` and
 *   the next flow still runs, the same way one failing test does not abort the
 *   file. That is what makes a single run useful for four cards at once.
 *
 *   A halt is about the ACCOUNT - 403, 401, 429, or a budget. Everything stops
 *   immediately and the remaining flows are `skipped`, because continuing to
 *   poke Discord after it has refused us is precisely the behaviour the owner's
 *   conditions exist to prevent.
 */

import { HarnessHalt, type HarnessGuard, type TranscriptEntry } from './guard.ts';
import { FlowAssertionFailed, missingTargets, type Flow, type FlowContext } from './flows.ts';

export type FlowOutcome = 'passed' | 'failed' | 'halted' | 'skipped';

export interface FlowResult {
  key: string;
  title: string;
  /** The card this flow un-gates. Lets a board comment be generated from the transcript. */
  unblocks: string;
  outcome: FlowOutcome;
  /** Why it is not `passed`. Non-secret, one line. */
  detail: string | null;
  /** Only this flow's actions, in order. */
  steps: TranscriptEntry[];
  coverageResidual?: string;
  cleanupHandoffs?: string[];
}

export interface HarnessTranscript {
  /** True when nothing reached Discord. A dry run is never evidence. */
  dryRun: boolean;
  guildId: string;
  startedAt: string;
  finishedAt: string;
  flows: FlowResult[];
  messagesSent: number;
  actionsTaken: number;
  /** The guard's budgets, copied in so a transcript is self-describing. */
  limits: {
    minGapMs: number;
    jitterMs: number;
    maxMessagesPerRun: number;
    maxActionsPerRun: number;
  };
  halt: { reason: string; detail: string } | null;
}

export interface RunOptions {
  dryRun: boolean;
}

export async function runFlows(
  flows: ReadonlyArray<Flow>,
  ctx: FlowContext,
  o: RunOptions,
): Promise<HarnessTranscript> {
  const guard: HarnessGuard = ctx.guard;
  const startedAt = new Date().toISOString();
  const results: FlowResult[] = [];
  let halted = false;

  for (const flow of flows) {
    const from = guard.transcript.length;

    if (halted) {
      results.push(skeleton(flow, 'skipped', 'an earlier flow halted the session', []));
      continue;
    }

    if (!o.dryRun && flow.liveIneligibleReason) {
      results.push(skeleton(flow, 'skipped', `ineligible: ${flow.liveIneligibleReason}`, []));
      continue;
    }

    // Refuse up front rather than three actions in: a half-configured run that
    // fails at step four has already spent real traffic on the account.
    const missing = missingTargets(flow, ctx.targets);
    if (missing.length > 0) {
      results.push(
        skeleton(flow, 'skipped', `missing targets: ${missing.join(', ')}`, []),
      );
      continue;
    }

    const cleanupHandoffs: string[] = [];
    try {
      await flow.run({ ...ctx, noteCleanupHandoff: (handoff) => {
        if (!o.dryRun) cleanupHandoffs.splice(0, cleanupHandoffs.length, handoff);
      } });
      results.push(skeleton(flow, 'passed', null, guard.transcript.slice(from)));
    } catch (err) {
      const steps = guard.transcript.slice(from);
      if (err instanceof HarnessHalt) {
        halted = true;
        results.push(skeleton(flow, 'halted', `${err.reason}: ${err.detail}`, steps));
      } else if (err instanceof FlowAssertionFailed) {
        results.push(skeleton(flow, 'failed', err.message, steps));
      } else {
        // An unexpected throw is a harness bug, not a verdict about the bot.
        // It stops the run for the same reason a halt does: we do not know what
        // state the account is in.
        halted = true;
        results.push(skeleton(flow, 'halted', 'harness error: unexpected transport or flow failure', steps));
      }
    }
    if (cleanupHandoffs.length) results[results.length - 1].cleanupHandoffs = cleanupHandoffs;
  }

  return {
    dryRun: o.dryRun,
    guildId: ctx.targets.guildId,
    startedAt,
    finishedAt: new Date().toISOString(),
    flows: results,
    messagesSent: guard.messagesSent,
    actionsTaken: guard.actionsTaken,
    limits: {
      minGapMs: guard.minGapMs,
      jitterMs: guard.jitterMs,
      maxMessagesPerRun: guard.maxMessagesPerRun,
      maxActionsPerRun: guard.maxActionsPerRun,
    },
    halt: guard.halted ? { reason: guard.halted.reason, detail: guard.halted.detail } : null,
  };
}

function skeleton(
  flow: Flow,
  outcome: FlowOutcome,
  detail: string | null,
  steps: TranscriptEntry[],
): FlowResult {
  return { key: flow.key, title: flow.title, unblocks: flow.unblocks, outcome, detail, steps,
    ...(flow.coverageResidual ? { coverageResidual: flow.coverageResidual } : {}),
  };
}

/** Live skipped/empty coverage and unexpected halts cannot be reported as PASS. */
export function exitCodeFor(t: HarnessTranscript): number {
  if (t.halt || t.flows.some((f) => f.outcome === 'halted')) return 2;
  if (t.flows.some((f) => f.outcome === 'failed')) return 1;
  if (!t.dryRun && (!t.flows.length || t.flows.some((f) => f.outcome === 'skipped'))) return 1;
  return 0;
}
