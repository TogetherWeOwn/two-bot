/**
 * TOG-6493: `scripts/audit-collect.ts` / `audit-report.ts` fixture acceptance.
 *
 * The gap: as of the 2026-09-27 scan no test file referenced the audit-collect,
 * audit-report or audit-switch scripts, and audit mode gates the TOG-2801
 * logging-sink activation. The switch half (halt stops collection, resume
 * restarts it, status reports honestly) needs a database and lives in
 * test/e2e.auditswitch.test.ts; this file is the half that runs anywhere.
 *
 * What this pins, with no token, no database and no live Discord:
 *
 *   1. audit-collect refuses without credentials (exit 2, names the need) and
 *      writes nothing — the refusal fires before the first mkdir;
 *   2. audit-collect is read-only by construction: one `fetch(`, one
 *      `method: 'GET'` and no other method literal, no `.content` read, one
 *      `writeFileSync(` whose value passes through `stripUsers` from
 *      `./audit-scrub.ts`;
 *   3. audit-report renders the golden sample: `--root` at a copy of the
 *      scrubbed `test/fixtures/audit-raw` dump (TOG-8963; member ids
 *      remapped, structure identical) reproduces every kept table byte for
 *      byte (channels/roles/invites/categories CSVs, summary.json,
 *      new-member-walkthrough.txt, data/server-audit-2026-08-19.csv) and
 *      the same stdout;
 *   4. the golden verdicts themselves: the one merge, the two rewrite-topics,
 *      the 109 archives, the A1/A3 headcounts and the dead-air ratio;
 *   5. the probe is live, not hardcoded: giving the Lobby fixture a topic
 *      flips exactly its verdict (rewrite-topic -> merge) and moves the merge
 *      count, so a rubric regression reds here instead of shipping;
 *   6. audit-switch refuses without TWO_DATABASE_URL (exit 1) and refuses
 *      --halt + --resume together (exit 2) before touching any database.
 *
 * Reviewer acceptance: corrupt any pinned row or verdict below and the run
 * names the failure; give the Lobby a topic in a fixture copy and watch the
 * probe flip. No prod activation — the collector subprocess never sees a
 * token and the report never calls Discord.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runAuditReport } from '../scripts/audit-report.ts';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COLLECT = join(ROOT, 'scripts', 'audit-collect.ts');
const REPORT = join(ROOT, 'scripts', 'audit-report.ts');
const SWITCH = join(ROOT, 'scripts', 'audit-switch.ts');

/**
 * Enough environment for node to boot, nothing else. In particular no
 * DISCORD_*, TWO_*, DATABASE_*, TOKEN, SECRET or KEY variables survive, so a
 * script that touches credentials before its refusal fails its case. Same
 * shape as the role-consolidation acceptance (TOG-6483).
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const k of ['HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'TZ']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const k of Object.keys(env)) {
    assert.ok(
      !/TOKEN|SECRET|KEY|DATABASE|DISCORD|STAGING|E2E|PASSWORD/i.test(`${k}=${env[k]}`),
      `scrubbed env leaked a credential-looking variable: ${k}`,
    );
  }
  return env;
}

async function cli(
  script: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [script, ...args], { cwd, env: scrubbedEnv() });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// --- audit-collect: refusal + read-only construction ----------------------------

test('audit-collect refuses without credentials and writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-audit-collect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await cli(COLLECT, [], dir);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /need DISCORD_TOKEN/);
  assert.deepEqual(readdirSync(dir), [], 'the refusal fires before the first mkdir');
});

test('audit-collect is GET-only with no message-content read and one scrubbed write', () => {
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const src = strip(readFileSync(COLLECT, 'utf8'));

  assert.equal(
    (src.match(/fetch\s*\(/g) ?? []).length, 1,
    'one HTTP door in the whole collector',
  );
  assert.deepEqual(
    [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]),
    ['GET'],
    'the single door hardcodes GET; there is no post/patch/delete to reach for',
  );
  assert.ok(!/\.\bcontent\b/.test(src), 'message content is never read, stored or logged');
  assert.equal(
    (src.match(/writeFileSync\s*\(/g) ?? []).length, 1,
    'exactly one file-write call — the guarded raw-dump save',
  );
  assert.ok(src.includes('stripUsers(data)'), 'the save passes through the PII scrubber');
  assert.ok(
    src.includes("from './audit-scrub.ts'"),
    'scrubbing lives in the tested scrub module, not inline',
  );
});

// --- audit-report: the golden sample ----------------------------------------------

/**
 * A fixture tree on disk: <dir>/audit/raw/*.json, the only read the report does.
 *
 * The fixture is `test/fixtures/audit-raw/` — the 2026-08-19 dump with every
 * community member user id remapped into the synthetic 9000000000000000xx
 * block (TOG-8963 removed the real dump from HEAD). Structure, counts and
 * verdicts are byte-identical to the live run; only user-id positions
 * (thread owner_ids, automod creator_ids, guild owner_id, invite inviters,
 * integration users) differ. Structural ids (guild, channels, roles,
 * overwrites) are untouched.
 */
function writeFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'two-audit-report-'));
  cpSync(join(ROOT, 'test', 'fixtures', 'audit-raw'), join(dir, 'audit', 'raw'), {
    recursive: true,
  });
  return dir;
}

/**
 * Every committed render output, as repo-relative paths.
 *
 * `data/server-audit-2026-08-19.json` is NOT in this list: TOG-8963 removed
 * the full JSON snapshot from HEAD (member user IDs), so there is no
 * committed file to compare against. The report still writes it (rollback
 * source for operators with a local raw/ dump); the byte-identity pin covers
 * the kept tables plus the spec-shaped CSV.
 */
const GOLDEN_FILES = [
  'audit/channels.csv',
  'audit/roles.csv',
  'audit/invites.csv',
  'audit/categories.csv',
  'audit/summary.json',
  'audit/new-member-walkthrough.txt',
  'data/server-audit-2026-08-19.csv',
];

test('audit-report renders the golden sample byte for byte', async (t) => {
  const dir = writeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await cli(REPORT, ['--root', dir], ROOT);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  for (const rel of GOLDEN_FILES) {
    assert.equal(
      readFileSync(join(dir, rel), 'utf8'),
      readFileSync(join(ROOT, rel), 'utf8'),
      `${rel} differs from the committed golden output`,
    );
  }

  // Stdout is the walkthrough plus the summary, exactly as the files hold them.
  assert.equal(
    out.stdout,
    readFileSync(join(ROOT, 'audit', 'new-member-walkthrough.txt'), 'utf8')
      + '\n'
      + readFileSync(join(ROOT, 'audit', 'summary.json'), 'utf8'),
    'stdout is the walkthrough plus the summary, byte for byte',
  );
});

test('the exported report function renders the golden summary without a subprocess', async (t) => {
  // Proves the export the CLI runs is the code under test — library and CLI
  // cannot drift. Aims at a copy of the scrubbed fixture (the repo itself
  // holds no audit/raw/ since TOG-8963); importing is already the
  // side-effect pin — every file read sits inside runAuditReport, so a stray
  // top-level read would exit or throw at import.
  const dir = writeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { summaryJson, walk } = runAuditReport(dir);
  assert.equal(summaryJson, readFileSync(join(ROOT, 'audit', 'summary.json'), 'utf8'));
  assert.equal(walk, readFileSync(join(ROOT, 'audit', 'new-member-walkthrough.txt'), 'utf8'));
});

test('the golden verdicts are the asserted rubric, not just any output', () => {
  const summary = JSON.parse(readFileSync(join(ROOT, 'audit', 'summary.json'), 'utf8')) as {
    counts: { channels_total: number; channels_visible_to_everyone: number };
    verdicts: Record<string, number>;
    A_unique_human_authors_30d: number;
    A_unique_human_authors_90d: number;
    server_level: { dead_air_ratio: number; dead_air_numerator: number; dead_air_denominator: number };
  };
  assert.equal(summary.counts.channels_total, 112);
  assert.equal(summary.counts.channels_visible_to_everyone, 27);
  assert.deepEqual(summary.verdicts, {
    keep: 0,
    merge: 1,
    archive: 109,
    'rewrite-topic': 2,
    'gate-behind-role': 0,
  });
  assert.equal(summary.A_unique_human_authors_30d, 1);
  assert.equal(summary.A_unique_human_authors_90d, 3);
  assert.deepEqual(
    [summary.server_level.dead_air_ratio, summary.server_level.dead_air_numerator, summary.server_level.dead_air_denominator],
    [0.963, 26, 27],
  );
});

test('a fixture topic flips exactly one verdict, proving the probe is live', async (t) => {
  const dir = writeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const channelsPath = join(dir, 'audit', 'raw', 'channels.json');
  const channels = JSON.parse(readFileSync(channelsPath, 'utf8')) as Array<{
    id: string;
    name: string;
    topic?: string | null;
  }>;
  const lobby = channels.find((c) => c.id === '1175127344072118405');
  assert.ok(lobby, 'the Lobby voice fixture exists');
  lobby.topic = 'reviewer probe: a topic where there was none';
  writeFileSync(channelsPath, JSON.stringify(channels));

  const out = await cli(REPORT, ['--root', dir], ROOT);
  assert.equal(out.code, 0, out.stdout + out.stderr);

  const rendered = readFileSync(join(dir, 'audit', 'channels.csv'), 'utf8');
  const golden = readFileSync(join(ROOT, 'audit', 'channels.csv'), 'utf8');
  assert.notEqual(rendered, golden, 'a changed rubric input must change the render');
  const summary = JSON.parse(readFileSync(join(dir, 'audit', 'summary.json'), 'utf8')) as {
    verdicts: Record<string, number>;
  };
  assert.equal(summary.verdicts['rewrite-topic'], 1, 'the Lobby left rewrite-topic');
  assert.equal(summary.verdicts.merge, 2, 'the Lobby joined the merge set');
});

// --- audit-switch: offline refusals ---------------------------------------------

test('audit-switch refuses without TWO_DATABASE_URL before touching anything', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-audit-switch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await cli(SWITCH, ['--status'], dir);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /TWO_DATABASE_URL is not set/);
  assert.deepEqual(readdirSync(dir), [], 'the refusal fires before any database is opened');
});

test('audit-switch refuses --halt with --resume before touching any database', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'two-audit-switch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await cli(SWITCH, ['--halt', '--resume'], dir);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /exactly one of --halt or --resume/);
});
