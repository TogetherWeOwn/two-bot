/**
 * AutoMod rule export validation (TOG-5700).
 *
 * `scripts/automod-export.ts` writes whatever Discord returns to disk. A rule
 * missing its id or name would then sit in the audit file looking like a real
 * rule with no identity - the same silent-skip failure the backfill had before
 * its `malformed` counter. Validate the whole payload before writing anything,
 * and report every bad row at once so a 50-rule export does not take 50 runs
 * to fix (the same reason `parseMee6Export` collects all problems).
 *
 * Pure and offline: no network, no token, no database.
 */

/** The fields the export must be able to name. Everything else passes through. */
export interface AutomodExportRule {
  id: string;
  name: string;
  [key: string]: unknown;
}

/**
 * Every malformed row, not just the first.
 *
 * Fixing an export one error per run is how a bad payload takes all day.
 */
export class AutomodExportError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`AutoMod export is not usable:\n  ${problems.join('\n  ')}`);
    this.name = 'AutomodExportError';
    this.problems = problems;
  }
}

/**
 * Refuse a payload that is not a list of identifiable rules.
 *
 * Returns the rules unchanged when they are all usable. Throws
 * `AutomodExportError` listing every bad row otherwise, so the caller writes
 * nothing rather than a partial file that looks complete.
 */
export function validateAutomodRules(payload: unknown): AutomodExportRule[] {
  if (!Array.isArray(payload)) {
    throw new AutomodExportError(['export must be an array of rules']);
  }
  const problems: string[] = [];
  const out: AutomodExportRule[] = [];
  payload.forEach((raw, index) => {
    const at = `row ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      problems.push(`${at} is not an object`);
      return;
    }
    const rule = raw as Record<string, unknown>;
    if (typeof rule.id !== 'string' || !/^\d{17,20}$/.test(rule.id)) {
      problems.push(`${at} has an invalid Discord rule id: ${String(rule.id)}`);
      return;
    }
    if (typeof rule.name !== 'string' || !rule.name.trim()) {
      problems.push(`${at} has no name`);
      return;
    }
    out.push(rule as AutomodExportRule);
  });
  if (problems.length > 0) throw new AutomodExportError(problems);
  return out;
}
