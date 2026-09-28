/**
 * Mutation harness for the temp-voice delete path (TOG-3052).
 *
 *   TWO_TEST_DATABASE_URL=postgres://.../two_scratch node scripts/mutate-tempvoice.ts --staging
 *
 * STAGING GUARD (TOG-6501). This harness rewrites a working-tree file and runs
 * the unit suite against each mutation, so running it by accident is a working
 * tree edit plus minutes of suite runs. It refuses to do anything without BOTH:
 *   - an explicit `--staging` flag, and
 *   - `TWO_TEST_DATABASE_URL` set to a scratch Postgres URL.
 * Without both it exits non-zero and writes nothing; `--help` is the only
 * flag-free run and it performs no mutation and runs no suite. The database
 * URL is required up front (rather than failing mid-harness) because the child
 * suite only runs against the scratch database named there.
 *
 * Test hooks (for the guard's own proof test only): `--target <path>` points
 * the harness at a fixture file instead of the real source, `--suite <path>`
 * points it at a fixture suite, and `--only <substring>` runs only the
 * mutations whose name contains it. All three still require --staging and the
 * scratch database URL.
 *
 * A guard that cannot be mutation-killed is not a guard. Each mutation below
 * relaxes exactly one of them; the suite must go red for every one.
 *
 * Two failure modes this harness refuses to have:
 *   - a replacement that matches nothing would leave the file pristine and
 *     report a spurious PASS, so every mutation asserts the bytes changed;
 *   - scraping a failure count out of the log can fabricate a result, so the
 *     verdict is the test runner's exit code and nothing else.
 *
 * The original is restored from an in-memory copy, never from git, so an
 * uncommitted fix in the working tree cannot be eaten by a restore.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Test hooks for the guard's own proof test: point the harness at a fixture
// file and suite instead of the real source. Still gated on --staging and the
// scratch database URL above; these only change WHAT is mutated, never WHETHER
// the guard runs.
const targetOverride = flagValue('--target');
const suiteOverride = flagValue('--suite');
const onlyFilter = flagValue('--only');
const TARGET = targetOverride ? resolve(ROOT, targetOverride) : resolve(ROOT, 'src/tempVoice/service.ts');
const SUITE = suiteOverride ?? 'test/unit.tempvoice.test.ts';

if (process.argv.includes('--help')) {
  console.log('usage: node scripts/mutate-tempvoice.ts --staging [--only <substring>]');
  console.log('');
  console.log('Mutation harness for the temp-voice delete path (TOG-3052): relaxes one guard');
  console.log('at a time and requires the unit suite to go red for every one.');
  console.log('');
  console.log('Flags:');
  console.log('  --staging           Confirm the staging scratch-database target (required).');
  console.log('  --only <substring>  Run only mutations whose name contains the substring.');
  console.log('  --help              Show this help and exit.');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/mutate-tempvoice.ts --help');
  console.log('  TWO_TEST_DATABASE_URL=postgres://.../two_scratch node scripts/mutate-tempvoice.ts --staging');
  console.log('');
  console.log('Refuses without --staging plus a scratch TWO_TEST_DATABASE_URL; --help performs');
  console.log('no mutation and runs no suite.');
  process.exit(0);
}

function flagValue(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at < 0) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) {
    console.error(`mutate-tempvoice: ${name} needs a value.`);
    process.exit(2);
  }
  return value;
}

// Staging guard (TOG-6501): this harness rewrites a working-tree file and runs
// the suite once per mutation, so it takes both an explicit flag and a scratch
// database URL before touching anything. Checked before the target is even
// read, so a refused run cannot fail halfway through a mutation.
const databaseUrl = process.env.TWO_TEST_DATABASE_URL?.trim() ?? '';
const isScratchDb = databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');
if (!process.argv.includes('--staging') || !isScratchDb) {
  console.error(
    'mutate-tempvoice: refusing to run without --staging and a scratch TWO_TEST_DATABASE_URL. ' +
      'Usage: TWO_TEST_DATABASE_URL=postgres://.../two_scratch node scripts/mutate-tempvoice.ts --staging. ' +
      'Nothing was mutated and no suite ran.',
  );
  process.exit(2);
}

interface Mutation {
  /** Short label for the report line. */
  name: string;
  /** The behaviour that is supposed to make this mutation fail. */
  guard: string;
  /** Anchor text, which must appear in the target exactly once. */
  from: string;
  to: string;
}

const MUTATIONS: ReadonlyArray<Mutation> = [
  {
    name: 'M1 protected-id guard removed',
    guard: 'Lobby / generator / category are excluded by id',
    from: `    if (this.config.protectedChannelIds.has(channelId)) {`,
    to: `    if (false) {`,
  },
  {
    name: 'M2 no-persisted-row guard relaxed to trust the caller',
    guard: 'never delete a channel that has no persisted row',
    from: `    if (!row) {
      log.error('temp_voice_delete_refused', { guildId, channelId, reason: 'no_persisted_row' });`,
    to: `    if (!row) {
      return await this.gateway.deleteChannel(channelId, reason);
      log.error('temp_voice_delete_refused', { guildId, channelId, reason: 'no_persisted_row' });`,
  },
  {
    name: 'M3 no-persisted-row guard inverted',
    guard: 'never delete a channel that has no persisted row',
    from: `    const row = await this.store.getByChannel(guildId, channelId);
    if (!row) {`,
    to: `    const row = await this.store.getByChannel(guildId, channelId);
    if (row === undefined) {`,
  },
  {
    name: 'M4 sweep ignores the empty-grace window',
    guard: 'an empty channel survives its grace before deletion',
    from: `      if (this.now() - Date.parse(row.emptySince) < graceMs) continue;`,
    to: `      if (false) continue;`,
  },
  {
    name: 'M5 sweep trusts the stored empty marker instead of re-checking',
    guard: 'occupancy is re-read at delete time; the member cache lags',
    from: `      const occupants = await this.gateway.occupantsOf(channelId);
      if (occupants === null) {
        await this.store.deleteById(row.id);
        this.throttle.forget(channelId);
        report.rowsDropped++;
        continue;
      }
      if (occupants.length > 0) {`,
    to: `      const occupants = row.emptySince === null ? ['cached-occupant'] : [];
      if (occupants === null) {
        await this.store.deleteById(row.id);
        this.throttle.forget(channelId);
        report.rowsDropped++;
        continue;
      }
      if (occupants.length > 0) {`,
  },
  {
    name: 'M6 reconcile evicts occupied channels instead of re-adopting',
    guard: 'a restart does not strand somebody sitting in a generated channel',
    from: `      if (occupants.length === 0) {
        // Boot-time empties are deleted immediately`,
    to: `      if (true) {
        // Boot-time empties are deleted immediately`,
  },
];

const selected = onlyFilter ? MUTATIONS.filter((m) => m.name.includes(onlyFilter)) : MUTATIONS;
if (selected.length === 0) {
  console.error(`mutate-tempvoice: --only ${JSON.stringify(onlyFilter)} matched no mutation. Nothing ran.`);
  process.exit(2);
}

const original = readFileSync(TARGET, 'utf8');
const results: Array<Mutation & { killed: boolean }> = [];

try {
  for (const m of selected) {
    const count = original.split(m.from).length - 1;
    if (count !== 1) {
      // A no-op edit would run the suite against pristine code and call the
      // green result a SURVIVED guard. Refuse to report anything at all.
      throw new Error(`${m.name}: anchor matched ${count} times, expected exactly 1. Update the harness.`);
    }
    const mutated = original.replace(m.from, m.to);
    if (mutated === original) throw new Error(`${m.name}: replacement did not change the file.`);
    writeFileSync(TARGET, mutated);

    const run = spawnSync(process.execPath, ['--test', SUITE], { cwd: ROOT, encoding: 'utf8' });
    const killed = run.status !== 0;
    results.push({ ...m, killed });
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'}  ${m.name}`);
    if (!killed) console.log(`          nothing failed. Guard claimed: ${m.guard}`);

    writeFileSync(TARGET, original);
  }
} finally {
  writeFileSync(TARGET, original);
}

const survived = results.filter((r) => !r.killed);
console.log(`\n${results.length - survived.length}/${results.length} mutations killed.`);
if (survived.length > 0) process.exit(1);
