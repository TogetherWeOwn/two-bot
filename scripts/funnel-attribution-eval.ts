/**
 * Golden eval for the ambiguous-vs-unknown attribution split (TOG-5849, the
 * prompt-quality slice of TOG-5681).
 *
 *   npm run eval:funnel-attribution
 *   node scripts/funnel-attribution-eval.ts [--json]
 *
 * Fully offline: no network, no database, no Discord token, no secrets. It
 * loads the golden cases in test/fixtures/funnel-attribution-golden.json,
 * drives the REAL attribution code in src/core/inviteTracker.ts (inviteGrowth
 * + attributeJoins for window cases, InviteTracker.attribute for the legacy
 * single-join path), and scores the fixture split: every ambiguous case must
 * come back ambiguous, every unknown case unknown, and every placed per-code
 * split must NOT read as ambiguous.
 *
 * The split is the deliverable, not just the pass count: ambiguous ("several
 * codes moved and the arithmetic does not close") and unknown ("nothing moved,
 * the invite delta is lost") are different facts about what happened
 * (docs/EVENTS.md, `source` table). A report or prompt that merges them hides
 * whether the problem is simultaneous launches or an offline bot, which ask
 * for opposite fixes.
 *
 * Exit codes: 0 every case passed - 1 a case failed or the fixture is
 * malformed - 2 usage.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attributeJoins,
  inviteGrowth,
  InviteTracker,
} from '../src/core/inviteTracker.ts';
import type { InviteState } from '../src/core/inviteTracker.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GOLDEN_FIXTURE_PATH = join(ROOT, 'test/fixtures/funnel-attribution-golden.json');
const FIXTURE_VERSION = 1;

export type GoldenCategory = 'ambiguous' | 'unknown' | 'vanity' | 'invite-exact' | 'invite-placed';
const CATEGORIES: readonly GoldenCategory[] = ['ambiguous', 'unknown', 'vanity', 'invite-exact', 'invite-placed'];

export interface WindowScenario {
  prevUses: Record<string, number>;
  currentUses: Array<{ code: string; uses: number }>;
  joinCount: number;
  guildHasVanity: boolean;
}

export interface LegacyScenario {
  grew: string[];
  guildHasVanity: boolean;
}

export interface GoldenCase {
  id: string;
  title: string;
  why: string;
  kind: 'window' | 'legacy-attribute';
  scenario: WindowScenario | LegacyScenario;
  expect: { sources: string[]; exact: boolean[] } | { source: string };
  expectCategory: GoldenCategory;
}

export interface CaseResult {
  id: string;
  title: string;
  expectCategory: GoldenCategory;
  ok: boolean;
  detail: string;
  actual: string[];
}

/** Which bucket does one attribution answer belong in? */
export function categoryOf(source: string, exact: boolean): GoldenCategory {
  if (source.startsWith('ambiguous:')) return 'ambiguous';
  if (source === 'unknown') return 'unknown';
  if (source === 'vanity') return 'vanity';
  // Exactness is a window-path property: only attributeJoins records it, so a
  // legacy single-code answer is a placement by construction.
  return exact ? 'invite-exact' : 'invite-placed';
}

function isWindowScenario(s: WindowScenario | LegacyScenario): s is WindowScenario {
  return (s as WindowScenario).joinCount !== undefined;
}

/** Parse and validate the fixture. Throws naming the first problem found. */
export function loadFixture(path: string = GOLDEN_FIXTURE_PATH): GoldenCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`cannot read golden fixture at ${path}: ${(err as Error).message}`);
  }
  const doc = raw as { version?: unknown; cases?: unknown };
  if (doc.version !== FIXTURE_VERSION) {
    throw new Error(`golden fixture version ${String(doc.version)}, expected ${FIXTURE_VERSION}`);
  }
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    throw new Error('golden fixture has no cases: the eval would pass by asserting nothing');
  }
  const seen = new Set<string>();
  for (const c of doc.cases as GoldenCase[]) {
    if (typeof c.id !== 'string' || c.id.length === 0) throw new Error('a golden case has no id');
    if (seen.has(c.id)) throw new Error(`duplicate golden case id: ${c.id}`);
    seen.add(c.id);
    if (c.kind !== 'window' && c.kind !== 'legacy-attribute') {
      throw new Error(`case ${c.id}: unknown kind ${String(c.kind)}`);
    }
    if (!CATEGORIES.includes(c.expectCategory)) {
      throw new Error(`case ${c.id}: unknown expectCategory ${String(c.expectCategory)}`);
    }
    if (c.kind === 'window' && !isWindowScenario(c.scenario)) {
      throw new Error(`case ${c.id}: window case needs prevUses/currentUses/joinCount/guildHasVanity`);
    }
    if (c.kind === 'legacy-attribute' && isWindowScenario(c.scenario)) {
      throw new Error(`case ${c.id}: legacy-attribute case needs grew/guildHasVanity`);
    }
  }
  return doc.cases as GoldenCase[];
}

/** Drive one golden case through the real attribution code and score it. */
export function evaluateCase(c: GoldenCase): CaseResult {
  const actual: Array<{ source: string; exact: boolean }> =
    c.kind === 'window' && isWindowScenario(c.scenario)
      ? (() => {
          const s = c.scenario;
          const current: InviteState[] = s.currentUses.map((u) => ({
            code: u.code,
            uses: u.uses,
            inviterId: null,
            channelId: null,
          }));
          const growth = inviteGrowth(new Map(Object.entries(s.prevUses)), current);
          return attributeJoins(growth, s.joinCount, s.guildHasVanity);
        })()
      : (() => {
          // The live-bot single-join path. attribute() touches no database.
          const s = c.scenario as LegacyScenario;
          const source = new InviteTracker(null as never).attribute(s.grew, s.guildHasVanity);
          return [{ source, exact: false }];
        })();

  const sources = actual.map((a) => a.source);
  const exacts = actual.map((a) => a.exact);
  const problems: string[] = [];

  const expectedSources =
    'sources' in c.expect ? c.expect.sources : [c.expect.source];
  const expectedExacts =
    'sources' in c.expect ? c.expect.exact : [false];
  if (JSON.stringify(sources) !== JSON.stringify(expectedSources)) {
    problems.push(`sources ${JSON.stringify(sources)}, expected ${JSON.stringify(expectedSources)}`);
  }
  if (JSON.stringify(exacts) !== JSON.stringify(expectedExacts)) {
    problems.push(`exact ${JSON.stringify(exacts)}, expected ${JSON.stringify(expectedExacts)}`);
  }
  // The category check is what makes this an ambiguous-vs-unknown eval rather
  // than a generic assertion file: every answer in the case must sit in the
  // case's bucket. A per-code split reading as ambiguous (or vice versa)
  // fails here even if the strings happened to match some other expectation.
  const miscategorized = actual.filter((a) => categoryOf(a.source, a.exact) !== c.expectCategory);
  if (miscategorized.length > 0) {
    problems.push(
      `${miscategorized.length} answer(s) outside bucket ${c.expectCategory}: ` +
        miscategorized.map((a) => `${a.source} (exact=${a.exact})`).join(', '),
    );
  }

  return {
    id: c.id,
    title: c.title,
    expectCategory: c.expectCategory,
    ok: problems.length === 0,
    detail: problems.join('; '),
    actual: sources,
  };
}

export interface EvalSummary {
  results: CaseResult[];
  passed: number;
  failed: number;
  /** Per-bucket score: the fixture split the task acceptance asks for. */
  byCategory: Record<GoldenCategory, { passed: number; total: number }>;
}

/** Score a whole fixture load. Pure, so the unit test drives it directly. */
export function scoreRun(cases: GoldenCase[]): EvalSummary {
  const results = cases.map(evaluateCase);
  const byCategory = Object.fromEntries(
    CATEGORIES.map((cat) => {
      const inBucket = results.filter((r) => r.expectCategory === cat);
      return [cat, { passed: inBucket.filter((r) => r.ok).length, total: inBucket.length }];
    }),
  ) as Record<GoldenCategory, { passed: number; total: number }>;
  return {
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    byCategory,
  };
}

function usage(): never {
  console.error('Usage: node scripts/funnel-attribution-eval.ts [--json]');
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  for (const a of process.argv.slice(2)) {
    if (a !== '--json') usage();
  }
  const asJson = process.argv.includes('--json');

  let cases: GoldenCase[];
  try {
    cases = loadFixture();
  } catch (err) {
    console.error(`funnel-attribution-eval: ${(err as Error).message}`);
    process.exit(1);
  }
  const summary = scoreRun(cases);

  if (asJson) {
    console.log(JSON.stringify({ fixture: 'test/fixtures/funnel-attribution-golden.json', ...summary }, null, 2));
  } else {
    for (const r of summary.results) {
      console.log(r.ok ? `ok   ${r.id} (${r.expectCategory})` : `FAIL ${r.id} (${r.expectCategory})  -  ${r.detail}`);
    }
    console.log('');
    const split = CATEGORIES.map((cat) => {
      const b = summary.byCategory[cat];
      return `${cat}: ${b.passed}/${b.total}`;
    }).join('  ');
    console.log(`funnel-attribution-eval: ${summary.passed}/${summary.results.length} golden cases passed`);
    console.log(`  fixture split  ${split}`);
    if (summary.failed > 0) {
      console.log('  Ambiguous-vs-unknown buckets disagree with the code - see FAIL lines above.');
    }
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}
