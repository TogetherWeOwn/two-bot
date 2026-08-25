/**
 * A node:test reporter that writes one JSON object per test point.
 *
 * The built-in summary cannot be used to prove a suite ran. A `describe` that
 * skips itself is reported like this:
 *
 *   ok 1 - backup round trip # SKIP needs TWO_TEST_DATABASE_URL
 *   # tests 0
 *   # skipped 0
 *
 * `tests 0`, `skipped 0`, exit code 0. The suite is *missing*, not skipped, as
 * far as the counters are concerned - which is precisely why three Postgres-only
 * suites were green by absence for months without anyone noticing. Asserting on
 * the printed summary would reproduce that bug one level up.
 *
 * So this reads the structured event stream instead, where the skip is still
 * visible on the individual test point, and writes it out as NDJSON for
 * scripts/require-suites.ts to check. Used as:
 *
 *   node --test --test-reporter=./scripts/test-report.ts \
 *               --test-reporter-destination=results.ndjson ...
 *
 * It emits nothing to stdout, so pair it with a second `--test-reporter=spec`
 * if a human also needs to read the run.
 */

/** One test point: a `test()`, or a `describe()` suite. */
export interface ReportedTest {
  /** Absolute path of the file the test was declared in. */
  file: string;
  name: string;
  /** 0 for a top-level test or suite, 1 for a child of one, and so on. */
  nesting: number;
  /** 'suite' for a `describe`, 'test' for a `test`. */
  type: string;
  status: 'pass' | 'fail';
  skip: boolean;
  todo: boolean;
}

interface TestEventData {
  file?: string;
  name: string;
  nesting: number;
  skip?: boolean | string;
  todo?: boolean | string;
  details?: { type?: string };
}

export default async function* reporter(
  source: AsyncIterable<{ type: string; data: TestEventData }>,
): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const line: ReportedTest = {
      file: d.file ?? '',
      name: d.name,
      nesting: d.nesting,
      // A `test()` has no `details.type`; only suites are labelled.
      type: d.details?.type ?? 'test',
      status: event.type === 'test:pass' ? 'pass' : 'fail',
      // `skip`/`todo` are `true` when bare and the reason string when given, so
      // the falsy check has to survive an empty-string reason.
      skip: d.skip !== undefined && d.skip !== false,
      todo: d.todo !== undefined && d.todo !== false,
    };
    yield `${JSON.stringify(line)}\n`;
  }
}
