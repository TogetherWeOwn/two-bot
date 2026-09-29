/**
 * Mutation harness for the temp-voice delete path (TOG-3052).
 *
 *   TWO_TEST_DATABASE_URL=postgres://... node scripts/mutate-tempvoice.mjs
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

const TARGET = resolve(import.meta.dirname, '../src/tempVoice/service.ts');
const SUITE = 'test/unit.tempvoice.test.ts';
const ROOT = resolve(import.meta.dirname, '..');

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
  {
    name: 'M7 create path confers ManageRoles the bot cannot grant',
    guard: 'no create-time overwrite confers ManageRoles (TOG-9541: live 403/50013)',
    from: `    { id: botId, type: 'member', allow: ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers'] },`,
    to: `    { id: botId, type: 'member', allow: ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers', 'ManageRoles'] },`,
  },
];

const original = readFileSync(TARGET, 'utf8');
const results: Array<Mutation & { killed: boolean }> = [];

try {
  for (const m of MUTATIONS) {
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
