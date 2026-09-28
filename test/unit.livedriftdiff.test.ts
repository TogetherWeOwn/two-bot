/**
 * TOG-6494: `scripts/live-cleanup-drift-diff.ts` (`npm run cleanup:drift-diff`)
 * fixture acceptance test.
 *
 * The gap (2026-09-27 scan): the drift-diff script had no npm entry and zero
 * test-file references, so the operator tool that answers "would a drift gate
 * accept this capture" was itself unwatched. The entry has since been
 * registered (`cleanup:drift-diff`, booted offline by
 * `test/unit.scriptregistryhelp-batch1.test.ts`), but nothing still pins the
 * verdict: a script that always exited 0 — or that refused without naming the
 * field — would stay green while operators trusted it before a live apply.
 *
 * So this runs the real script as a subprocess against two small snapshot
 * fixtures written to a fresh mkdtemp dir and asserts end to end:
 *
 *   identical snapshots -> exit 0, DRIFT-EQUAL;
 *   one channel field moved (topic on chan-two) -> exit 1 naming
 *     `channel field drift: topic` with the channel id;
 *   only `last_message_id` moved -> exit 0 (ordinary message traffic must not
 *     strand a phase), while the raw comparison still names the field;
 *   one guild field moved -> exit 1 naming `guild field drift: <field>`;
 *   no argv -> exit 2 with usage.
 *
 * The reviewer acceptance is literal: change one field in the second fixture
 * and the run names the drifted object. Fixtures only: no token, no database,
 * no network, no live Discord, no live guild writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  withSemanticHash,
  type Channel,
  type LiveCleanupSnapshot,
} from '../src/redesign/live-cleanup.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/live-cleanup-drift-diff.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

type SnapshotInput = Omit<LiveCleanupSnapshot, 'semanticHash'>;

const CHAN_ONE = '6494-chan-one';
const CHAN_TWO = '6494-chan-two';

function channel(id: string, topic: string | null): Channel {
  return {
    id,
    name: `name-${id}`,
    type: 0,
    parent_id: null,
    position: 1,
    topic,
    permission_overwrites: [],
  };
}

function baseInput(): SnapshotInput {
  return {
    version: 1,
    generatedAt: '2026-09-28T00:00:00.000Z',
    applicationId: '6494-app',
    guildId: '6494-guild',
    guild: { id: '6494-guild', name: 'Fixture', owner_id: '6494-owner', features: [] },
    roles: [],
    channels: [channel(CHAN_ONE, 'one'), channel(CHAN_TWO, 'two')],
    members: [],
    integrations: [],
    references: {},
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'drift-diff-6494-'));
}

function writePair(dir: string, a: SnapshotInput, b: SnapshotInput): [string, string] {
  const pathA = join(dir, 'a.json');
  const pathB = join(dir, 'b.json');
  writeFileSync(pathA, JSON.stringify(withSemanticHash(a)));
  writeFileSync(pathB, JSON.stringify(withSemanticHash(b)));
  return [pathA, pathB];
}

async function diff(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run('node', [SCRIPT, ...args], { cwd: REPO });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('identical snapshots diff clean with DRIFT-EQUAL', async () => {
  const [pathA, pathB] = writePair(freshDir(), baseInput(), baseInput());
  const out = await diff([pathA, pathB]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes('DRIFT-EQUAL'), 'verdict should accept the second capture');
});

test('one drifted channel field names the drifted object', async () => {
  const a = baseInput();
  const b = baseInput();
  b.channels = [channel(CHAN_ONE, 'one'), channel(CHAN_TWO, 'moved')];
  const [pathA, pathB] = writePair(freshDir(), a, b);
  const out = await diff([pathA, pathB]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.ok(
    out.stdout.includes(`channel field drift: topic on 1 channel(s): ${CHAN_TWO}`),
    `should name topic and ${CHAN_TWO}. output:\n${out.stdout}`,
  );
  assert.ok(out.stdout.includes('DRIFT: a drift gate would refuse'), 'verdict should refuse');
});

test('a lone last_message_id move still accepts, with the field named', async () => {
  // The TOG-3141 class: an ordinary message posted between captures moves only
  // this volatile field. The hash forgives it (exit 0) while the raw
  // comparison still shows the pairing, so a new volatile field is visible.
  const a = baseInput();
  const b = baseInput();
  b.channels = [
    channel(CHAN_ONE, 'one'),
    { ...channel(CHAN_TWO, 'two'), last_message_id: '6494-msg' } as Channel,
  ];
  const [pathA, pathB] = writePair(freshDir(), a, b);
  const out = await diff([pathA, pathB]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes('DRIFT-EQUAL'), 'volatile-only move should accept');
  assert.ok(
    out.stdout.includes(`channel field drift: last_message_id on 1 channel(s): ${CHAN_TWO}`),
    `raw comparison should still name the field. output:\n${out.stdout}`,
  );
});

test('one drifted guild field names the field', async () => {
  const a = baseInput();
  const b = baseInput();
  b.guild = { ...a.guild, system_channel_id: '6494-sys' };
  const [pathA, pathB] = writePair(freshDir(), a, b);
  const out = await diff([pathA, pathB]);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.ok(out.stdout.includes('non-channel drift: guild'), 'should flag the guild body');
  assert.ok(
    out.stdout.includes('guild field drift: system_channel_id'),
    `should name the moved guild field. output:\n${out.stdout}`,
  );
});

test('missing argv exits 2 with usage', async () => {
  const out = await diff([]);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.ok(/usage:/i.test(out.stderr), 'should print usage to stderr');
});
