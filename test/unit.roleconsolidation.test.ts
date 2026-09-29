/**
 * TOG-6483: `scripts/role-consolidation.ts` dry-run acceptance test on fixtures.
 *
 * The gap: as of the 2026-09-27 scan no test file referenced the script at
 * all. It plans role changes in the live guild (keep/merge/delete over ~190
 * roles), so a rubric regression — a merge target drifting, a wave rule
 * reordering, a new role slipping through unclassified — would only surface
 * when someone eyeballed the CSV against the live server.
 *
 * What this pins, with no token, no database and no live Discord:
 *
 *   1. the pure plan (`buildConsolidationPlan`) assigns the asserted verdict,
 *      group, survivor, export reason and wave to every seeded role: a keep, a
 *      merge, a dead-weight delete, a holder delete, a separator, an
 *      onboarding-granted delete, an overwrite-carrying delete, a
 *      delete-recommended decision, a keep-recommended colour decision, a
 *      managed role and @everyone;
 *   2. an unlisted, non-cosmetic role throws instead of silently keeping or
 *      deleting — the fail-loud half of the rubric;
 *   3. the real script as a subprocess with a scrubbed environment (no
 *      `DISCORD_*` credentials at all) exits 0 on `--root <fixture> --dry-run`,
 *      prints the expected plan, and writes nothing;
 *   4. the same run without `--dry-run` writes exactly
 *      `renderCsv(buildConsolidationPlan(snap))` — the dry-run plan and the
 *      written file cannot drift;
 *   5. static pin: the file holds no Discord client or network surface, and
 *      the only write sits behind the direct-invocation guard.
 *
 * Reviewer acceptance: `node scripts/role-consolidation.ts --root <fixture>
 * --dry-run` and see zero writes plus the asserted consolidation. No live
 * guild action — the script has no Discord client at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  GUILD_ID,
  MEMBER,
  buildConsolidationPlan,
  renderCsv,
  summarizePlan,
  type ConsolidationSnapshot,
  type PlanRow,
} from '../scripts/role-consolidation.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/role-consolidation.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

// --- seeded fixture ----------------------------------------------------------
// Real PLAN ids (that is the point — the rubric must fire on the ids it names)
// inside a synthetic guild: the headcounts, channels and onboarding options
// are canned, so every verdict, export reason and wave below is hand-computed.

const BOT_ROLE = '900000000000000001';
const COLOUR_ROLE = '900000000000000010';
const SUPPORT_CHANNEL = '900000000000000100';

interface FixtureRole {
  id: string;
  name: string;
  permissions: string;
  position: number;
  color: number;
  hoist: boolean;
  managed: boolean;
}

function fixtureSnapshot(): ConsolidationSnapshot {
  const roles: FixtureRole[] = [
    { id: GUILD_ID, name: '@everyone', permissions: '104324673', position: 0, color: 0, hoist: false, managed: false },
    { id: BOT_ROLE, name: 'Color-Chan', permissions: '0', position: 50, color: 0, hoist: false, managed: true },
    { id: MEMBER, name: 'Member', permissions: '104324673', position: 40, color: 0, hoist: false, managed: false },
    { id: '448584234907729940', name: 'TWO.gg Member', permissions: '968552205889', position: 39, color: 0, hoist: false, managed: false },
    { id: '448890318989819904', name: 'TWO', permissions: '6478615104', position: 38, color: 2067276, hoist: false, managed: false },
    { id: '1080508643558047754', name: 'Event Badge', permissions: '0', position: 37, color: 0, hoist: false, managed: false },
    { id: '1101315895390900295', name: 'separator pill', permissions: '0', position: 36, color: 0, hoist: false, managed: false },
    { id: '1087897935045476402', name: 'Location X', permissions: '0', position: 35, color: 0, hoist: false, managed: false },
    { id: '1051260096333750322', name: 'Supporter T1', permissions: '0', position: 34, color: 0, hoist: false, managed: false },
    { id: '1146631068787671110', name: 'Battlepass 1', permissions: '0', position: 33, color: 0, hoist: false, managed: false },
    { id: COLOUR_ROLE, name: 'neon pink', permissions: '0', position: 32, color: 16711935, hoist: false, managed: false },
    { id: '1055499052801855528', name: 'Interest Y', permissions: '0', position: 31, color: 0, hoist: false, managed: false },
  ];
  return {
    roles,
    channels: [
      {
        id: SUPPORT_CHANNEL,
        name: 'supporters',
        permission_overwrites: [{ id: '1051260096333750322', type: 0, allow: '1024', deny: '0' }],
      },
    ],
    onboarding: {
      prompts: [
        {
          title: 'Where are you located?',
          options: [{ title: 'Nowhere', role_ids: ['1087897935045476402'] }],
        },
      ],
    },
    members: {
      role_headcount: {
        [MEMBER]: 3,
        '448584234907729940': 2,
        '1080508643558047754': 5,
        '1101315895390900295': 7,
        '1146631068787671110': 4,
        '1055499052801855528': 1,
      },
    },
  };
}

const byId = (rows: PlanRow[]): Map<string, PlanRow> => new Map(rows.map((r) => [r.role_id, r]));

// --- the pure plan ------------------------------------------------------------

test('every seeded role gets its asserted verdict, group and survivor', () => {
  const rows = byId(buildConsolidationPlan(fixtureSnapshot()));
  assert.equal(rows.size, 12, 'one row per seeded role');

  assert.deepEqual(
    [rows.get(GUILD_ID)!.verdict, rows.get(GUILD_ID)!.group],
    ['keep', 'baseline'],
    '@everyone is the baseline keep',
  );
  assert.deepEqual(
    [rows.get(BOT_ROLE)!.verdict, rows.get(BOT_ROLE)!.group],
    ['untouchable', 'bot'],
    'a managed role is untouchable, never planned',
  );
  assert.deepEqual(
    [rows.get(MEMBER)!.verdict, rows.get(MEMBER)!.group, rows.get(MEMBER)!.holders],
    ['keep', 'rank', 3],
    'the survivor role itself is kept',
  );

  const merge = rows.get('448584234907729940')!;
  assert.equal(merge.verdict, 'merge');
  assert.equal(merge.merge_into_id, MEMBER, 'merge target is the named survivor, not a name match');
  assert.equal(merge.merge_into_name, 'Member', 'survivor name resolves from the same snapshot');
  assert.equal(merge.holders_move, 2, 'both holders need the survivor grant first');

  assert.equal(rows.get('448890318989819904')!.verdict, 'delete');
  assert.equal(rows.get('1146631068787671110')!.verdict, 'decision');
  assert.equal(rows.get('1146631068787671110')!.recommended, 'delete');
  assert.equal(rows.get(COLOUR_ROLE)!.verdict, 'decision');
  assert.equal(rows.get(COLOUR_ROLE)!.recommended, 'keep');
});

test('holder exports and waves follow the asserted rubric', () => {
  const rows = byId(buildConsolidationPlan(fixtureSnapshot()));

  // Dead weight: no holders, no wiring.
  assert.equal(rows.get('448890318989819904')!.needs_holder_export, 'no');
  assert.equal(rows.get('448890318989819904')!.wave, 'R1 — dead weight, no holders, no wiring');

  // Holders without wiring: export for rollback, announce, then delete.
  assert.equal(rows.get('1080508643558047754')!.needs_holder_export, 'yes — rollback');
  assert.equal(rows.get('1080508643558047754')!.wave, 'R6 — export holders, announce, then delete');
  assert.equal(rows.get('1055499052801855528')!.needs_holder_export, 'yes — rollback');
  assert.equal(rows.get('1055499052801855528')!.wave, 'R6 — export holders, announce, then delete');

  // Merge: export to verify every holder got the survivor.
  assert.equal(rows.get('448584234907729940')!.needs_holder_export, 'yes — to verify every holder got the survivor');
  assert.equal(rows.get('448584234907729940')!.wave, 'R5 — regrant survivor, verify, then delete');

  // Separators are the deliberate exception: decoration, nothing to restore.
  assert.equal(rows.get('1101315895390900295')!.needs_holder_export, 'no — decoration, nothing to restore');
  assert.equal(rows.get('1101315895390900295')!.wave, 'R4b — separator');

  // Onboarding-granted: the prompt option goes first.
  const location = rows.get('1087897935045476402')!;
  assert.equal(location.granted_by_onboarding, 'yes');
  assert.ok(location.onboarding_options.includes('Where are you located? → Nowhere'));
  assert.equal(location.wave, 'R3 — edit the onboarding option first');

  // Overwrite-carrying with no holders: confirm the overwrite is redundant first.
  const supporter = rows.get('1051260096333750322')!;
  assert.equal(supporter.overwrite_count, 1);
  assert.ok(supporter.overwrite_channels.includes('supporters'));
  assert.equal(supporter.wave, 'R2 — confirm the overwrite is redundant, then delete');

  // Decisions recommend but retire nothing on their own.
  assert.equal(rows.get(COLOUR_ROLE)!.wave, '', 'a keep-recommended decision has no wave');
  assert.equal(rows.get('1146631068787671110')!.wave, 'R6 — export holders, announce, then delete');
});

test('the summary totals match the asserted consolidation', () => {
  const lines = summarizePlan(buildConsolidationPlan(fixtureSnapshot()));
  const text = lines.join('\n');
  assert.ok(text.includes('total roles                 12'));
  assert.ok(text.includes('bot-managed (untouchable) 1'));
  assert.ok(text.includes('human-assignable          10'));
  assert.ok(text.includes('merge                   1'));
  assert.ok(text.includes('delete                  6'));
  assert.ok(text.includes('decision                2  (recommended keep 1, delete 1)'));
  assert.ok(text.includes('human-assignable roles    10 -> 2'), 'keep 1 + keep-recommended 1 survive');
  assert.ok(text.includes('roles deleted             8'), 'merge 1 + delete 6 + delete-recommended 1');
  assert.ok(text.includes('members needing a regrant 2 role-holdings'));
});

test('an unlisted non-cosmetic role throws instead of silently keeping or deleting', () => {
  const snap = fixtureSnapshot();
  snap.roles.push({
    id: '911111111111111111', name: 'Mystery', permissions: '8', position: 30, color: 0, hoist: false, managed: false,
  });
  assert.throws(() => buildConsolidationPlan(snap), /unclassified role 911111111111111111 Mystery/);
});

// --- the real script as a subprocess -------------------------------------------

/** Scrubbed environment: no credentials of any kind, so a run that exits 0
 *  with a plan proves the dry-run path needs — and uses — nothing live. */
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

/** A fixture tree on disk: <dir>/audit/raw/*.json, the only read the script does. */
function writeFixtureTree(): { dir: string; snap: ConsolidationSnapshot } {
  const dir = mkdtempSync(join(tmpdir(), 'two-role-consolidation-'));
  const snap = fixtureSnapshot();
  const raw = join(dir, 'audit', 'raw');
  mkdirSync(raw, { recursive: true });
  writeFileSync(join(raw, 'roles.json'), JSON.stringify(snap.roles));
  writeFileSync(join(raw, 'channels.json'), JSON.stringify(snap.channels));
  writeFileSync(join(raw, 'onboarding.json'), JSON.stringify(snap.onboarding));
  writeFileSync(join(raw, 'members.json'), JSON.stringify(snap.members));
  return { dir, snap };
}

/** Every file under a directory, as sorted relative paths. */
function treeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, rel: string): void => {
    for (const name of readdirSync(join(base, rel)).sort()) {
      const inner = rel ? `${rel}/${name}` : name;
      try {
        statSync(join(base, inner)).isDirectory() ? walk(base, inner) : out.push(inner);
      } catch {
        out.push(inner);
      }
    }
  };
  walk(dir, '');
  return out;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: scrubbedEnv() });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('dry-run exits 0 with no credentials, prints the plan, writes nothing', async (t) => {
  const { dir } = writeFixtureTree();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = treeFiles(dir);

  const out = await cli(['--root', dir, '--dry-run']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /DRY RUN - nothing written/);
  assert.match(out.stdout, /dry run: nothing was written\./);

  // The asserted consolidation, not just any plan.
  assert.ok(out.stdout.includes('total roles                 12'));
  assert.ok(out.stdout.includes('merge                   1'));
  assert.ok(out.stdout.includes('roles deleted             8'));
  assert.ok(out.stdout.includes('members needing a regrant 2 role-holdings'));
  assert.ok(
    out.stdout.includes('1087897935045476402 Location X  <-  Where are you located? → Nowhere'),
    'the onboarding-touching retirement is named',
  );
  assert.ok(
    out.stdout.includes('1051260096333750322 Supporter T1 (0 holders) -> 1: supporters'),
    'the overwrite-carrying deletion is named',
  );

  assert.deepEqual(treeFiles(dir), before, 'dry-run wrote nothing under the fixture root');
});

test('the writing run produces exactly the dry-run plan as CSV', async (t) => {
  const { dir, snap } = writeFixtureTree();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await cli(['--root', dir]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.ok(!out.stdout.includes('DRY RUN'), 'the writing run says nothing about a dry run');

  const written = readFileSync(join(dir, 'audit', 'role-consolidation.csv'), 'utf8');
  assert.equal(
    written,
    renderCsv(buildConsolidationPlan(snap)),
    'the written CSV is the exported plan, byte for byte — the two cannot drift',
  );
});

// --- the static pin: no client, one guarded write --------------------------------

test('the script has no Discord or network surface; the only write sits behind the CLI guard', () => {
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const src = strip(readFileSync(new URL('../scripts/role-consolidation.ts', import.meta.url), 'utf8'));

  for (const pat of [
    /fetch\s*\(/, /discord\.com/i, /DiscordRest/, /discord\.js/i, /\.send\s*\(/,
    /createDM/, /Webhook/, /\.post\s*\(/, /\.put\s*\(/, /\.patch\s*\(/, /\.delete\s*\(/,
  ]) {
    assert.ok(!pat.test(src), `scripts/role-consolidation.ts touches client/network surface: ${pat}`);
  }
  assert.ok(src.includes('invokedDirectly'), 'file reads and the CSV write must sit behind the direct-invocation guard');
  assert.equal(
    (src.match(/writeFileSync\s*\(/g) ?? []).length, 1,
    'exactly one file-write call in the whole script — the guarded CSV write',
  );
});
