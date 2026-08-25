/**
 * Raid-account removal: the decisions, separated from the I/O.
 *
 * scripts/raid-list.ts produces the list. This produces the *actions*, and
 * scripts/raid-remove.ts is the thin shell that wires the two to a terminal.
 * Everything here is testable without a token, a database or a socket, which is
 * the point: the code that removes members is the last code in this repo that
 * should be exercised for the first time in production.
 *
 * FIVE PROPERTIES, EACH ENFORCED BY CONSTRUCTION
 *
 * 1. DRY RUN IS THE DEFAULT. `execute` is a boolean that defaults to false and
 *    the only branch that touches a `MemberRemover` is behind it. A dry run
 *    cannot contact Discord — not "does not", cannot: the caller is allowed to
 *    pass `remover: null`, and the script does exactly that unless --execute
 *    was typed.
 *
 * 2. THE TARGET LIST IS AN INPUT. There is no hardcoded count and no hardcoded
 *    id anywhere in this file. The authorised number is genuinely unsettled at
 *    the time of writing — the authorisation says 19 in one sentence and
 *    implies 30 in another (TOG-411, TOG-451) — and this file must not be the
 *    thing that quietly decides it. `--expect N` in the script exists so the
 *    operator states the number they believe they are authorised for and the
 *    tool refuses when the file disagrees.
 *
 * 3. ONE DURABLE AUDIT LINE PER ACCOUNT, WRITTEN BEFORE WE MOVE ON. JSONL,
 *    fsync'd per line. A run killed halfway leaves a complete, valid record of
 *    everything it did do.
 *
 * 4. RE-RUNNING THE SAME INPUT IS SAFE. Any account with a *terminal* outcome
 *    already in the audit log (`kicked` or `already_gone`) is skipped without a
 *    request. Anything else — a 403, a rate limit, a member never reached
 *    because the run aborted — is retried. And in the window this cannot
 *    cover, a crash between a successful kick and its audit line, the retry
 *    gets a 404 and records `already_gone`. There is no input to this that
 *    double-acts.
 *
 * 5. IT STOPS WHEN SOMETHING IS SYSTEMICALLY WRONG. Three consecutive failures
 *    ends the run. A missing Kick Members permission is 403 thirty times in a
 *    row; grinding through all thirty produces thirty identical audit lines and
 *    an operator who stops reading them.
 *
 * Snowflakes only. No usernames are read, fetched or written — docs/PRIVACY.md.
 */
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import type { KickOutcome, MemberRemover } from '../discord/kick.ts';

/** Bumped if the shape of an audit line ever changes. Readers check it. */
export const AUDIT_SCHEMA_VERSION = 1;

/** The only action this module can take. There is deliberately no 'ban'. */
export type RemovalAction = 'kick';

export type RemovalOutcome =
  /** Dry run: this is what --execute would have done. */
  | 'would_kick'
  /** Already terminal in the audit log. No request was made. */
  | 'skipped_done'
  | KickOutcome;

/** The terminal outcomes. Seeing one of these for an id means never act on it again. */
const TERMINAL: ReadonlySet<string> = new Set<RemovalOutcome>(['kicked', 'already_gone']);

export function isTerminal(outcome: string): boolean {
  return TERMINAL.has(outcome);
}

export interface AuditRecord {
  v: number;
  ts: string;
  runId: string;
  memberId: string;
  action: RemovalAction;
  mode: 'dry-run' | 'execute';
  outcome: RemovalOutcome;
  status: number | null;
  detail: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ParsedIds {
  ids: string[];
  /** Ids that appeared more than once. Kept once; reported so a bad paste is visible. */
  duplicates: string[];
  /** Lines that were not a snowflake, with the line number, so the operator can fix them. */
  rejected: { line: number; value: string }[];
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Read a target list. Accepts what an operator will actually have to hand:
 *
 *   - the output of `node scripts/raid-list.ts --ids`: one id per line. `#`
 *     comments and blank lines are ignored, so a list can carry its provenance.
 *   - a JSON array of ids, or of objects with `id` / `member_id`.
 *   - a JSON object with an `ids` / `memberIds` array.
 *
 * Anything else is an error with the reason in it. This never silently drops a
 * line it did not understand — a target list that quietly loses entries is the
 * failure mode that makes a removal run unreviewable.
 */
export function parseIdList(text: string, sourceName = 'input'): ParsedIds {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${sourceName} is empty.`);

  const raw =
    trimmed.startsWith('{') || trimmed.startsWith('[')
      ? idsFromJson(trimmed, sourceName)
      : trimmed.split('\n').map((line, i) => ({ line: i + 1, value: stripComment(line) }));

  const ids: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const rejected: { line: number; value: string }[] = [];

  for (const { line, value } of raw) {
    if (!value) continue;
    if (!SNOWFLAKE.test(value)) {
      rejected.push({ line, value });
      continue;
    }
    if (seen.has(value)) {
      duplicates.push(value);
      continue;
    }
    seen.add(value);
    ids.push(value);
  }

  // A file of nothing but comments parses perfectly and targets nobody, which
  // would otherwise produce a run that reports success having done nothing. If
  // there were rejected lines we say nothing here — the caller has a better
  // error to give, naming the lines it could not read.
  if (!ids.length && !rejected.length) {
    throw new Error(`${sourceName} contains no ids.`);
  }
  return { ids, duplicates, rejected };
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function idsFromJson(text: string, sourceName: string): { line: number; value: string }[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${sourceName} looks like JSON but does not parse: ${String(err)}`);
  }

  // The one wrong file an operator is most likely to reach for, named
  // explicitly rather than failing as "no ids found". It is the only committed
  // JSON in data/ and it is about channels and roles, not people — its own
  // `note` field says so.
  if (isRecord(doc) && 'channels' in doc && 'roles' in doc && 'summary' in doc) {
    throw new Error(
      `${sourceName} is a server audit snapshot, not a target list. It contains no ` +
        `member identities at all (see its own "note" field). Produce the list with ` +
        `\`node scripts/raid-list.ts --ids\` against a populated database instead.`,
    );
  }

  const arr = Array.isArray(doc)
    ? doc
    : isRecord(doc) && Array.isArray(doc.ids)
      ? doc.ids
      : isRecord(doc) && Array.isArray(doc.memberIds)
        ? doc.memberIds
        : null;

  if (!arr) {
    throw new Error(
      `${sourceName}: expected a JSON array of ids, or an object with an "ids" array.`,
    );
  }

  return arr.map((entry, i) => ({
    line: i + 1,
    value: String(
      typeof entry === 'string' || typeof entry === 'number'
        ? entry
        : isRecord(entry)
          ? (entry.id ?? entry.member_id ?? entry.memberId ?? '')
          : '',
    ).trim(),
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

export interface PriorState {
  /** Ids that already have a terminal outcome recorded. These are never re-attempted. */
  done: Set<string>;
  /** Lines read, and lines that did not parse — a torn last line after a kill is normal. */
  lines: number;
  unparseable: number;
}

/**
 * What a previous run already settled.
 *
 * Terminal-ever, not last-wins: once an id has been kicked it stays skipped
 * even if a later dry run appends a `would_kick` line for it. Getting that
 * backwards would let a dry run re-arm a completed removal.
 *
 * If the same accounts genuinely need removing again — a raider rejoined —
 * that is a new decision and belongs in a new audit file, not in an append to
 * the record of the old one.
 */
export function readAuditLog(path: string): PriorState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { done: new Set(), lines: 0, unparseable: 0 };
    }
    throw err;
  }

  const done = new Set<string>();
  let lines = 0;
  let unparseable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let rec: Partial<AuditRecord>;
    try {
      rec = JSON.parse(line) as Partial<AuditRecord>;
    } catch {
      // A process killed mid-write leaves a torn line. Counting it and moving
      // on is right; refusing to run because of it would strand the operator
      // exactly when they most need to resume.
      unparseable++;
      continue;
    }
    if (typeof rec.memberId === 'string' && typeof rec.outcome === 'string' && isTerminal(rec.outcome)) {
      done.add(rec.memberId);
    }
  }
  return { done, lines, unparseable };
}

export type AuditSink = (record: AuditRecord) => void;

/**
 * Append-and-fsync sink. The fsync is the difference between "we have a record
 * of what we did" and "we have a record of what we did unless the box lost
 * power", and at one call per member it costs nothing worth saving.
 */
export function fileAuditSink(path: string): AuditSink {
  return (record) => {
    const fd = openSync(path, 'a');
    try {
      appendFileSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface RemovalOptions {
  ids: string[];
  /** False — the default everywhere — means contact nobody and change nothing. */
  execute: boolean;
  /** Required when `execute` is true. Ignored, and normally null, when it is false. */
  remover: MemberRemover | null;
  sink: AuditSink;
  prior: PriorState;
  /** Shown in the server's own audit log next to each removal. */
  reason: string;
  runId: string;
  now?: () => string;
  /** Consecutive failures that end the run. Default 3. */
  maxConsecutiveFailures?: number;
  onRecord?: (record: AuditRecord) => void;
}

export interface RemovalSummary {
  total: number;
  skippedDone: number;
  attempted: number;
  counts: Record<string, number>;
  aborted: boolean;
  abortReason: string | null;
  /** Ids the run never reached, because it aborted. A re-run picks these up. */
  notAttempted: string[];
}

export async function removeAccounts(o: RemovalOptions): Promise<RemovalSummary> {
  const now = o.now ?? (() => new Date().toISOString());
  const maxConsecutive = o.maxConsecutiveFailures ?? 3;
  const mode = o.execute ? 'execute' : 'dry-run';

  if (o.execute && !o.remover) {
    throw new Error('execute requires a MemberRemover. Refusing to run.');
  }

  const counts: Record<string, number> = {};
  const bump = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };

  let skippedDone = 0;
  let attempted = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let abortReason: string | null = null;
  const notAttempted: string[] = [];

  for (let i = 0; i < o.ids.length; i++) {
    const memberId = o.ids[i]!;

    if (aborted) {
      notAttempted.push(memberId);
      continue;
    }

    // Settled by an earlier run. No request, and no new audit line either: the
    // terminal line is already in this file, and re-stamping it every run would
    // turn the log into mostly noise.
    if (o.prior.done.has(memberId)) {
      skippedDone++;
      bump('skipped_done');
      o.onRecord?.({
        v: AUDIT_SCHEMA_VERSION,
        ts: now(),
        runId: o.runId,
        memberId,
        action: 'kick',
        mode,
        outcome: 'skipped_done',
        status: null,
        detail: 'terminal outcome already in the audit log',
        attempts: 0,
      });
      continue;
    }

    let outcome: RemovalOutcome;
    let status: number | null = null;
    let detail: string;
    let attempts = 0;

    if (!o.execute) {
      outcome = 'would_kick';
      detail = 'dry run: no request was made';
    } else {
      const result = await o.remover!.kick(memberId, o.reason);
      outcome = result.outcome;
      status = result.status;
      detail = result.detail;
      attempts = result.attempts;
      attempted++;

      if (isTerminal(result.outcome)) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    }

    const record: AuditRecord = {
      v: AUDIT_SCHEMA_VERSION,
      ts: now(),
      runId: o.runId,
      memberId,
      action: 'kick',
      mode,
      outcome,
      status,
      detail,
      attempts,
    };
    o.sink(record);
    o.onRecord?.(record);
    bump(outcome);

    if (consecutiveFailures >= maxConsecutive) {
      aborted = true;
      abortReason =
        `${consecutiveFailures} consecutive failures (last: ${outcome}, ${detail}). ` +
        `Stopping rather than repeating it down the whole list. ` +
        `Fix the cause and re-run the same command — everything already done is skipped.`;
    }
  }

  return {
    total: o.ids.length,
    skippedDone,
    attempted,
    counts,
    aborted,
    abortReason,
    notAttempted,
  };
}

// ---------------------------------------------------------------------------
// Cross-check against the committed server audit
// ---------------------------------------------------------------------------

export interface AuditContext {
  collectedAt: string;
  guildId: string;
  humanMembers: number;
  stuckAtRulesScreening: number;
}

/**
 * The committed `data/server-audit-2026-08-19.json` carries no member roster —
 * it says so itself — so it can never *be* the target list. What it can do is
 * bound one: it recorded 84 human members and 31 of them stuck at the rules
 * gate, and every raid account confirmed on 2026-08-19 was one of those 31.
 */
export function readAuditContext(path: string): AuditContext | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const summary = isRecord(doc.summary) ? doc.summary : null;
  const members = summary && isRecord(summary.members) ? summary.members : null;
  const guild = summary && isRecord(summary.guild) ? summary.guild : null;
  if (!members || !guild) return null;
  return {
    collectedAt: String(doc.collected_at ?? ''),
    guildId: String(guild.id ?? ''),
    humanMembers: Number(members.human_members ?? 0),
    stuckAtRulesScreening: Number(members.stuck_at_rules_screening ?? 0),
  };
}

/**
 * Warnings, not refusals. This evidence is six days old by the time anyone runs
 * the removal and it is aggregate; it is good enough to say "that number looks
 * wrong", never good enough to be the last word on who goes.
 */
export function crossCheck(ctx: AuditContext, count: number, guildId?: string): string[] {
  const out: string[] = [];
  if (guildId && ctx.guildId && guildId !== ctx.guildId) {
    out.push(
      `the target guild (${guildId}) is not the guild this audit describes (${ctx.guildId}). ` +
        `Check --guild before going further.`,
    );
  }
  if (count > ctx.humanMembers) {
    out.push(
      `the list has ${count} accounts but the audit counted only ${ctx.humanMembers} human ` +
        `members in the whole server. The list cannot be right.`,
    );
  } else if (count > ctx.stuckAtRulesScreening) {
    out.push(
      `the list has ${count} accounts but the audit found ${ctx.stuckAtRulesScreening} members ` +
        `stuck at the rules gate. Every confirmed raid account was pending at that gate, so at ` +
        `least ${count - ctx.stuckAtRulesScreening} of these are not explained by that evidence.`,
    );
  }
  return out;
}
