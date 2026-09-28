/**
 * TOG-6489 slice: the campaigns operator CLI, driven through the real npm
 * entry on a scratch schema (never prod TWO_DATABASE_URL).
 *
 * WHY THIS EXISTS. docs/EVENTS.md tells the operator to add tracked links
 * with `npm run campaigns -- --add`, but nothing executed that path:
 * test/unit.redirect.test.ts drives CampaignStore directly, so an argv-parsing
 * typo, a swallowed exit code, or a wrong env var read in scripts/campaigns.ts
 * would all stay green. These tests spawn the real entry and assert the
 * reviewer path: --add creates the row, the bare list shows it, a duplicate
 * --add fails naming "already exists" (the ON CONFLICT DO NOTHING guard in
 * CampaignStore.add), and the new slug 302s to the invite over real loopback
 * HTTP.
 *
 * Fixture (one scratch schema, never live/staging):
 *   migrations, then the REAL npm entry `npm run campaigns` with
 *   TWO_DATABASE_URL=<TEST_PG_URL>?options=-c+search_path=<schema> (the
 *   TOG-6492 URL-options trick from test/e2e.growthreview.test.ts: URL options
 *   win over inherited PGOPTIONS, so the child cannot land anywhere but this
 *   file's schema). Store-level edges (bad slugs, repoint refusal, validators)
 *   stay in test/unit.redirect.test.ts; this file proves the CLI path only.
 *
 * Reproduce by hand (reviewer path): point TWO_TEST_DATABASE_URL at a scratch
 * DB, then run the documented sequence with TWO_DATABASE_URL pointed at the
 * same DB plus ?options=-c+search_path=<schema>:
 *   npm run campaigns -- --add reddit aB3xY9 "r/MMORPG sidebar"
 *   npm run campaigns
 *   npm run campaigns -- --add reddit otherCode "somewhere else"  # fails
 * and compare `SELECT slug, invite_code, label FROM invite_campaigns` plus a
 * `GET /reddit` 302 to https://discord.gg/aB3xY9.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openTestDb, TEST_PG_URL, type TestDb } from './helpers/testDb.ts';
import { CampaignStore } from '../src/redirect/campaigns.ts';
import { startRedirectServer, type RedirectServer } from '../src/redirect/server.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));

// The documented operator example (docs/EVENTS.md). Distinct from the slugs
// in test/unit.redirect.test.ts anyway: every file gets its own schema.
const SLUG = 'reddit';
const CODE = 'aB3xY9';
const LABEL = 'r/MMORPG sidebar';
const GUILD = '111222333444555666';

let harness: TestDb;
/** Routes the child npm entry at this file's scratch schema, and nowhere else. */
let cliEnv: NodeJS.ProcessEnv;
let server: RedirectServer;
let campaigns: CampaignStore;
const seen: Array<{ code: string; campaign?: string }> = [];

before(async () => {
  harness = await openTestDb(import.meta.filename);
  const url = new URL(TEST_PG_URL);
  // URL options win over inherited PGOPTIONS, including URLs with their own
  // options - the TOG-6492 trick. The CLI child reads TWO_DATABASE_URL, so
  // this is the one value that decides which schema it writes to.
  url.searchParams.set('options', `-c search_path=${harness.schema}`);
  cliEnv = { TWO_DATABASE_URL: url.toString() };

  campaigns = new CampaignStore(harness.db, { ttlMs: 0 }); // no caching in tests
  server = await startRedirectServer({
    host: '127.0.0.1',
    port: 0,
    guildId: GUILD,
    campaigns,
    recorder: {
      onInviteClick: async (_guildId: string, code: string, opts: { campaign?: string }) => {
        seen.push({ code, campaign: opts.campaign });
        return undefined;
      },
    },
  });
});

after(async () => {
  // Guarded: if `before` failed halfway (no database), the cleanup must not
  // throw a second error that masks the real one.
  if (typeof server !== 'undefined' && server) await server.close();
  if (typeof harness !== 'undefined' && harness) await harness.cleanup();
});

beforeEach(async () => {
  await harness.reset();
  // This campaign table is not part of the shared harness's truncate list.
  await harness.db.exec('DELETE FROM invite_campaigns');
  seen.length = 0;
});

interface CliResult {
  code: number;
  output: string;
}

async function cli(args: string[]): Promise<CliResult> {
  try {
    const result = await run('npm', ['run', 'campaigns', ...(args.length > 0 ? ['--', ...args] : [])], {
      cwd: REPO,
      env: { ...process.env, ...cliEnv },
      timeout: 60_000,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/**
 * A request, plus a wait for the click write it started.
 *
 * The server redirects first and records after - deliberately, so nobody waits
 * on a database to reach Discord - which means the 302 arrives while the
 * record is still in flight. `drain()` closes that window here without
 * weakening the property being tested (see test/unit.redirect.test.ts).
 */
const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { redirect: 'manual' });
  await server.drain();
  return res;
};

test('--add creates the campaign row and names the postable link', { timeout: 120_000 }, async () => {
  const out = await cli(['--add', SLUG, CODE, LABEL]);
  assert.equal(out.code, 0, `--add failed:\n${out.output}`);
  assert.match(out.output, new RegExp(`added ${SLUG} -> discord\\.gg/${CODE}`));

  // Read back through the schema-scoped harness: this proves the child wrote
  // to the scratch schema, not just that it printed the right words.
  const row = await campaigns.lookup(SLUG);
  assert.equal(row?.inviteCode, CODE);
  assert.equal(row?.label, LABEL);
});

test('bare list shows the new slug, code and label', { timeout: 120_000 }, async () => {
  const added = await cli(['--add', SLUG, CODE, LABEL]);
  assert.equal(added.code, 0, `--add failed:\n${added.output}`);

  const out = await cli([]);
  assert.equal(out.code, 0, `list failed:\n${out.output}`);
  assert.match(out.output, new RegExp(`${SLUG}\\s+->\\s+discord\\.gg/${CODE}\\s+${LABEL}`));
});

test('a duplicate --add fails naming "already exists" and keeps the original row', { timeout: 120_000 }, async () => {
  const first = await cli(['--add', SLUG, CODE, LABEL]);
  assert.equal(first.code, 0, `first --add failed:\n${first.output}`);

  const dup = await cli(['--add', SLUG, 'otherCode', 'somewhere else']);
  assert.notEqual(dup.code, 0, `duplicate --add must fail:\n${dup.output}`);
  // The named ON CONFLICT DO NOTHING error from CampaignStore.add - slugs are
  // never repointed, so a typo'd re-add must say so instead of rewriting
  // history.
  assert.match(dup.output, /already exists/);

  const row = await campaigns.lookup(SLUG);
  assert.equal(row?.inviteCode, CODE, 'the duplicate must not repoint the slug');
  assert.equal(row?.label, LABEL);
});

test('the CLI-added campaign 302s to the invite over real HTTP', { timeout: 120_000 }, async () => {
  const added = await cli(['--add', SLUG, CODE, LABEL]);
  assert.equal(added.code, 0, `--add failed:\n${added.output}`);

  const res = await get(`/${SLUG}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `https://discord.gg/${CODE}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.campaign, SLUG);
});
