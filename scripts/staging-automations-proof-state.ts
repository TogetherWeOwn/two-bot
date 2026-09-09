import type {
  AutomationCommandRow,
  ScheduledMessageRow,
  StickyMessageRow,
} from '../src/automations/store.ts';

export interface ProofState<T> {
  before: T | null;
  proof: T | null;
}

/** Restore only when the row still matches the proof's last write. */
export function cleanupDecision<T>(current: T | null, state: ProofState<T>): 'restore' | 'skip' {
  return JSON.stringify(current) === JSON.stringify(state.proof) ? 'restore' : 'skip';
}

export type AutomationProofState = {
  command: ProofState<AutomationCommandRow>;
  scheduled: ProofState<ScheduledMessageRow>;
  sticky: ProofState<StickyMessageRow>;
};

/**
 * Restore the closest coherent sticky state after the proof replaced its live
 * Discord message. A disabled sticky has no message to keep pinned, so retaining
 * the deleted pre-proof id would leave a row that points at nothing.
 */
export function restoredStickyRow(
  prior: StickyMessageRow,
  priorMessageReplaced: boolean,
  replacementMessageId: string | null,
  replacementPostedAt: string,
): StickyMessageRow {
  if (!priorMessageReplaced) return prior;
  if (!prior.enabled) {
    return {
      ...prior,
      lastMessageId: null,
      claimToken: null,
      claimedAt: null,
    };
  }
  if (!replacementMessageId) {
    throw new Error('An enabled replaced sticky needs a recreated Discord message.');
  }
  return {
    ...prior,
    lastMessageId: replacementMessageId,
    lastPostedAt: replacementPostedAt,
    claimToken: null,
    claimedAt: null,
  };
}
