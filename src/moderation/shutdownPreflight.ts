/**
 * Refuse to switch moderation off while it still owes somebody a release.
 *
 * `TWO_MODERATION=1` turns the slice on; until TOG-3190 there was no shutdown
 * path at all, so turning it off was a single environment edit. Do that while a
 * tempban's unban job is still pending, or while a channel is still locked
 * down, and the code that would have released them stops running. A real member
 * stays banned, or a real channel stays silent, with nothing left to notice.
 * There is no undo for that in a live guild - the ban is invisible to everyone
 * who is not looking at the ban list, and nobody looks at the ban list.
 *
 * So the preflight runs at boot, on the transition it can actually observe:
 * moderation is off, and this database still holds outstanding state. It is a
 * hard refusal - the process does not start - because the alternative is a bot
 * that runs happily while quietly owing four people their accounts back.
 *
 * Two deliberate choices:
 *
 *  * **State is read from Postgres, never from Discord.** A REST call that
 *    failed would report "nothing outstanding", and that answer lets the
 *    disable through - precisely the case this exists to catch. The store reads
 *    `moderation_scheduled_unbans` and `moderation_lockdowns` directly.
 *  * **The refusal names what is outstanding.** Counts *and* ids. "Refused"
 *    with no detail sends the operator back to the database to guess, and an
 *    operator guessing at 3am is how the override gets used for no reason.
 *
 * The emergency exit is `TWO_MODERATION_DISABLE_OVERRIDE=1`. It proceeds, and
 * it logs the whole stranded set at error level so the release can be done by
 * hand from the log alone. It is not a way to skip the check; it is a way to
 * turn the check into a written record of what you are about to strand.
 */
import { log as defaultLog } from '../core/log.ts';
import type {
  ModerationStore,
  OutstandingLockdown,
  OutstandingUnban,
} from './store.ts';

export const MODERATION_DISABLE_OVERRIDE_ENV = 'TWO_MODERATION_DISABLE_OVERRIDE';
export const MODERATION_DISABLE_OVERRIDE_REASON_ENV = 'TWO_MODERATION_DISABLE_OVERRIDE_REASON';

/**
 * How many ids the refusal message and the stranded-set log will carry.
 *
 * Counts are always exact (they come from `COUNT(*)`); only the id lists are
 * capped, and a capped list says so rather than showing fewer and looking
 * complete. 500 is far above any plausible real backlog - one guild's worth of
 * tempbans is tens - and low enough that a runaway table cannot turn one log
 * line into megabytes.
 */
export const OUTSTANDING_ID_LIMIT = 500;

/** How many ids the human-readable message prints before summarising. */
const NAMED_IN_MESSAGE = 20;

export interface OutstandingModerationState {
  /** Exact, from COUNT(*). Never derived from the capped list below. */
  pendingUnbanCount: number;
  activeLockdownCount: number;
  pendingUnbans: OutstandingUnban[];
  activeLockdowns: OutstandingLockdown[];
  /** True when rows were actually cut: exact count exceeds the returned list. */
  truncated: boolean;
  total: number;
}

export type ShutdownPreflightDecision =
  /** Moderation is staying on. Nothing to check. */
  | 'enabled'
  /** Moderation is off and nothing is outstanding. The disable is allowed. */
  | 'clear'
  /** Moderation is off, something is outstanding, no override. Refused. */
  | 'refused'
  /** Refused, but `TWO_MODERATION_DISABLE_OVERRIDE=1` carried it through. */
  | 'overridden';

export interface ShutdownPreflightVerdict {
  decision: ShutdownPreflightDecision;
  /** Null only for `enabled`, where no read is performed. */
  outstanding: OutstandingModerationState | null;
  /** Human-readable, names counts and ids. Empty for `enabled`. */
  message: string;
}

export class ModerationShutdownRefusal extends Error {
  readonly outstanding: OutstandingModerationState;

  constructor(message: string, outstanding: OutstandingModerationState) {
    super(message);
    this.name = 'ModerationShutdownRefusal';
    this.outstanding = outstanding;
  }
}

/** The two tables, counted exactly and listed up to `OUTSTANDING_ID_LIMIT`. */
export async function readOutstandingModerationState(
  store: Pick<
    ModerationStore,
    'countOutstandingUnbans' | 'listOutstandingUnbans' | 'countActiveLockdowns' | 'listActiveLockdowns'
  >,
): Promise<OutstandingModerationState> {
  const [pendingUnbanCount, pendingUnbans, activeLockdownCount, activeLockdowns] = await Promise.all([
    store.countOutstandingUnbans(),
    store.listOutstandingUnbans(OUTSTANDING_ID_LIMIT),
    store.countActiveLockdowns(),
    store.listActiveLockdowns(OUTSTANDING_ID_LIMIT),
  ]);
  return {
    pendingUnbanCount,
    activeLockdownCount,
    pendingUnbans,
    activeLockdowns,
    truncated:
      pendingUnbanCount > pendingUnbans.length || activeLockdownCount > activeLockdowns.length,
    total: pendingUnbanCount + activeLockdownCount,
  };
}

/**
 * The operator-facing account of what is outstanding.
 *
 * Every line is something they can act on: the member to unban by hand, the
 * channel to unlock by hand. A refusal that only says "refused" is why this
 * function exists.
 */
export function describeOutstanding(state: OutstandingModerationState): string {
  const lines: string[] = [];
  if (state.pendingUnbanCount > 0) {
    lines.push(
      `  ${state.pendingUnbanCount} pending unban(s) - members who are banned and expecting release:`,
    );
    for (const job of state.pendingUnbans.slice(0, NAMED_IN_MESSAGE)) {
      lines.push(
        `    guild ${job.guildId} user ${job.userId} due ${job.executeAt} [${job.state}] ${job.requestId}`,
      );
    }
    const restUnbans = state.pendingUnbanCount - Math.min(state.pendingUnbans.length, NAMED_IN_MESSAGE);
    if (restUnbans > 0) lines.push(`    ... and ${restUnbans} more`);
  }
  if (state.activeLockdownCount > 0) {
    lines.push(`  ${state.activeLockdownCount} active lockdown(s) - channels still denied SendMessages:`);
    for (const lock of state.activeLockdowns.slice(0, NAMED_IN_MESSAGE)) {
      lines.push(`    guild ${lock.guildId} channel ${lock.channelId} locked ${lock.lockedAt}`);
    }
    const restLocks = state.activeLockdownCount - Math.min(state.activeLockdowns.length, NAMED_IN_MESSAGE);
    if (restLocks > 0) lines.push(`    ... and ${restLocks} more`);
  }
  if (state.truncated) {
    lines.push(`  (id lists capped at ${OUTSTANDING_ID_LIMIT}; the counts above are exact)`);
  }
  return lines.join('\n');
}

function refusalMessage(state: OutstandingModerationState): string {
  return [
    `TWO_MODERATION is off but moderation still owes ${state.total} release(s). Refusing to start.`,
    describeOutstanding(state),
    '',
    'Do one of these:',
    '  * set TWO_MODERATION=1 again and let the unban poller and /unlock drain the backlog; or',
    '  * release the members and channels named above by hand, then start again; or',
    `  * set ${MODERATION_DISABLE_OVERRIDE_ENV}=1 to proceed anyway. That strands everything`,
    '    named above until somebody releases it by hand. The full set is logged as',
    '    `moderation_disable_stranded` when you do.',
  ].join('\n');
}

export function isOverrideSet(env: NodeJS.ProcessEnv): boolean {
  return env[MODERATION_DISABLE_OVERRIDE_ENV] === '1';
}

/**
 * Decide, without acting. `enabled === true` short-circuits before any read:
 * moderation staying on is not a shutdown, and there is nothing to preflight.
 */
export async function evaluateModerationShutdown(options: {
  enabled: boolean;
  store: Parameters<typeof readOutstandingModerationState>[0];
  env?: NodeJS.ProcessEnv;
}): Promise<ShutdownPreflightVerdict> {
  if (options.enabled) return { decision: 'enabled', outstanding: null, message: '' };

  const outstanding = await readOutstandingModerationState(options.store);
  if (outstanding.total === 0) {
    return {
      decision: 'clear',
      outstanding,
      message: 'TWO_MODERATION is off and nothing is outstanding: no pending unbans, no active lockdowns.',
    };
  }

  const message = refusalMessage(outstanding);
  return {
    decision: isOverrideSet(options.env ?? process.env) ? 'overridden' : 'refused',
    outstanding,
    message,
  };
}

/** The full stranded set, flat enough to act on straight out of the log. */
function strandedFields(state: OutstandingModerationState): Record<string, unknown> {
  return {
    pendingUnbanCount: state.pendingUnbanCount,
    activeLockdownCount: state.activeLockdownCount,
    truncated: state.truncated,
    strandedUnbans: state.pendingUnbans.map((job) => ({
      requestId: job.requestId,
      guildId: job.guildId,
      userId: job.userId,
      state: job.state,
      executeAt: job.executeAt,
    })),
    strandedLockdowns: state.activeLockdowns.map((lock) => ({
      channelId: lock.channelId,
      guildId: lock.guildId,
      lockedAt: lock.lockedAt,
    })),
  };
}

/**
 * Decide and act: log the verdict, and throw on a refusal.
 *
 * Called from boot. `enabled` is `loadModerationConfig().enabled`, so the only
 * path that reads the database is the one where moderation is off.
 */
export async function enforceModerationShutdownPreflight(options: {
  enabled: boolean;
  store: Parameters<typeof readOutstandingModerationState>[0];
  env?: NodeJS.ProcessEnv;
  log?: Pick<typeof defaultLog, 'info' | 'error'>;
}): Promise<ShutdownPreflightVerdict> {
  const env = options.env ?? process.env;
  const logger = options.log ?? defaultLog;
  const verdict = await evaluateModerationShutdown({ enabled: options.enabled, store: options.store, env });

  switch (verdict.decision) {
    case 'enabled':
      break;
    case 'clear':
      logger.info('moderation_disable_preflight_clear', {
        pendingUnbans: 0,
        activeLockdowns: 0,
      });
      break;
    case 'overridden':
      // Error level on purpose: this is the only record that these members and
      // channels exist. It must survive a log level set to errors only.
      logger.error('moderation_disable_stranded', {
        override: MODERATION_DISABLE_OVERRIDE_ENV,
        reason: env[MODERATION_DISABLE_OVERRIDE_REASON_ENV] ?? '(none given)',
        hint: 'these releases will not happen on their own; do them by hand',
        ...strandedFields(verdict.outstanding!),
      });
      break;
    case 'refused':
      logger.error('moderation_disable_refused', {
        pendingUnbans: verdict.outstanding!.pendingUnbanCount,
        activeLockdowns: verdict.outstanding!.activeLockdownCount,
        override: `${MODERATION_DISABLE_OVERRIDE_ENV}=1`,
        ...strandedFields(verdict.outstanding!),
      });
      throw new ModerationShutdownRefusal(verdict.message, verdict.outstanding!);
  }
  return verdict;
}
