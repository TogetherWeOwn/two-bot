import type {
  AutomationCommandRow,
  ScheduledMessageRow,
  StickyMessageRow,
} from '../src/automations/store.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Library: automations proof cleanup/restore helpers. Importing this file never
// reads argv and never exits; the block below only runs on direct invocation.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log('usage: node scripts/staging-automations-proof-state.ts --help');
  console.log('');
  console.log('Automations proof cleanup/restore helpers (library, no direct invocation).');
  console.log('Imported by scripts/staging-automations-proof.ts and test/unit.automations.test.ts.');
  console.log('No token, no database, no side effects on --help.');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}

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
