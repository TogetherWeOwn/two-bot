// TOG-5703. Token-leak static sweep for docs/SECRETS.md rule 4.
//
// A secret never goes into a log line, a committed file, or a test fixture.
// CI's secret-scan workflow enforces that over the full history with the
// gitleaks binary; this file is the fast, dependency-free half that runs
// under plain `node --test` on every PR:
//
//   1. the logger emits no token-shaped value at any level, even with
//      DISCORD_TOKEN / DISCORD_BOT_TOKEN set in the environment;
//   2. no tracked file contains a token-shaped literal (same shapes as the
//      custom rules in .gitleaks.toml, mirrored here so there is no binary
//      to install);
//   3. no test fixture carries one either.
//
// The sentinel below is SYNTHETIC: an M-led three-segment string in the
// shape of a Discord bot token that was never issued, never stored, and
// never sent anywhere. It is built at runtime, never written as a literal,
// because a literal token-shaped string in this file would trip the very
// scanner this test parallels (and gitleaks in CI). The calibration
// assertion in each test fails first if the shape ever stops matching,
// so the sweep cannot go vacuous silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Mirror of the custom rules in .gitleaks.toml (which extends the default
// ruleset in CI). Literals here, so `npm run test:unit` needs no binary.
const PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'discord-bot-token', re: /\b[MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/i },
  { id: 'discord-mfa-token', re: /\bmfa\.[A-Za-z0-9_-]{80,100}\b/ },
  {
    id: 'discord-webhook',
    re: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,}/,
  },
];

// Same allowlist as .gitleaks.toml: read-only snapshots of public server
// metadata (invite codes are public by definition) and the local Discord
// stand-in whose tokens are literally the string "mock".
const SWEEP_SKIP: ReadonlyArray<RegExp> = [/^audit\/raw\//, /^audit\/invites\.csv$/, /^tools\/mock-discord\//];

/** A synthetic token-shaped value. Never a credential; see the header. */
function sentinelToken(): string {
  return `M${'A'.repeat(23)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;
}

/** Name the first rule whose shape appears in `text`, or null. */
function leakIn(text: string): string | null {
  for (const { id, re } of PATTERNS) {
    if (re.test(text)) return id;
  }
  return null;
}

function isGitWorkTree(): boolean {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true';
  } catch {
    return false;
  }
}

/** Every tracked file not on the allowlist, as { path, body }. */
function trackedTextFiles(): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  const paths = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const path of paths) {
    if (SWEEP_SKIP.some((re) => re.test(path))) continue;
    let body: string;
    try {
      body = readFileSync(join(REPO, path), 'utf8');
    } catch {
      continue;
    }
    // Binary blobs are not log output, fixtures, or readable config.
    if (body.includes('\0')) continue;
    out.push({ path, body });
  }
  return out;
}

test('the leak detector fires on a token-shaped string (else the sweep below proves nothing)', () => {
  const token = sentinelToken();
  // Calibration: the sentinel must match the bot-token shape, or every
  // absence assertion in this file is vacuous.
  assert.match(token, PATTERNS[0]!.re, 'synthetic sentinel no longer matches discord-bot-token shape');
  assert.equal(leakIn(`prefix ${token} suffix`), 'discord-bot-token');
  assert.equal(leakIn('nothing secret here: mock-token, ... placeholders, 1234'), null);
});

test('logger emits no token value or token-shaped pattern at any level', async () => {
  const token = sentinelToken();
  assert.match(token, PATTERNS[0]!.re, 'synthetic sentinel no longer matches discord-bot-token shape');

  const savedToken = process.env.DISCORD_TOKEN;
  const savedBotToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_TOKEN = token;
  process.env.DISCORD_BOT_TOKEN = token;

  const { log, setLogLevel } = await import('../src/core/log.ts');
  setLogLevel('debug'); // every level must be checked, not just the default
  let out = '';
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    log.debug('tokenleak probe debug', { where: 'unit.tokenleak' });
    log.info('tokenleak probe info', { where: 'unit.tokenleak' });
    log.error('tokenleak probe error', { where: 'unit.tokenleak' });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    setLogLevel('info');
    if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = savedToken;
    if (savedBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedBotToken;
  }

  assert.ok(out.length > 0, 'expected the three probe lines to be captured');
  assert.ok(!out.includes(token), 'DISCORD_TOKEN value reached log output');
  assert.equal(leakIn(out), null, 'token-shaped pattern reached log output');
});

test(
  'no committed file contains a token-shaped literal',
  { skip: !isGitWorkTree() },
  () => {
    // Findings name the file and the rule, never the value -- same as
    // `gitleaks ... --redact` in secret-scan.yml.
    const hits: string[] = [];
    for (const { path, body } of trackedTextFiles()) {
      const rule = leakIn(body);
      if (rule) hits.push(`${path} (${rule})`);
    }
    assert.deepEqual(hits, [], `token-shaped literals in committed files: ${hits.join(', ')}`);
  },
);

test(
  'no test fixture contains a token-shaped literal',
  { skip: !isGitWorkTree() },
  () => {
    const hits: string[] = [];
    for (const { path, body } of trackedTextFiles()) {
      if (!path.startsWith('test/')) continue;
      const rule = leakIn(body);
      if (rule) hits.push(`${path} (${rule})`);
    }
    assert.deepEqual(hits, [], `token-shaped literals in test fixtures: ${hits.join(', ')}`);
  },
);

// ---------------------------------------------------------------------------
// TOG-7217: explicit script-dir coverage. The sweep above walks every tracked
// file, so a new script file is covered from the day it lands — but nothing
// proved it, and nothing stopped a fixture under scripts/ or tools/ from
// carrying a live guild id. The three tests below close both gaps: an explicit
// inventory of every script-bearing dir, token shapes over those dirs with no
// allowlist applied, and a live-id guard over their fixture files.
// ---------------------------------------------------------------------------

/** Every directory that holds operator scripts, their harnesses, or the
 * deployment definitions around them. `.github/` rides on the repo-wide sweep
 * (workflows, not scripts) and needs no per-dir pin.
 *
 * This list is a ratchet, not documentation: the coverage test derives the
 * real closure from `git ls-files` and fails on any difference, so a new
 * script dir without a line here is a red test, not a silent gap. */
const SCRIPT_DIRS: ReadonlyArray<string> = [
  'ci',
  'ops',
  'ops/auto-voice',
  'ops/tog-4104',
  'ops/tog-4230',
  'ops/two-web-bootstrap',
  'ops/two-web-bootstrap/githooks',
  'scripts',
  'scripts/ci',
  'scripts/ci/fixtures',
  'scripts/ci/fixtures/fork-policy',
  'scripts/ci/fixtures/fork-policy/.github',
  'scripts/ci/fixtures/fork-policy/.github/workflows',
  'scripts/ci/postgres-bin',
  'tools',
  'tools/mock-discord',
  'tools/onboarding-picker-preview',
  'tools/reward-role-readback-panel',
  'tools/reward-role-readback-preview',
];

const SCRIPT_ROOTS: ReadonlyArray<string> = ['ci', 'ops', 'scripts', 'tools'];

/** Tracked files under the script roots, plus their ancestor-dir closure. */
function scriptInventory(): { files: string[]; dirs: string[] } {
  const raw = execFileSync('git', ['-C', REPO, 'ls-files', '--', ...SCRIPT_ROOTS], { encoding: 'utf8' });
  const files = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs: [...dirs].sort() };
}

test(
  'every current script dir is inside the sweep (else a new dir is a silent gap)',
  { skip: !isGitWorkTree() },
  () => {
    const { files, dirs } = scriptInventory();
    assert.deepEqual(dirs, SCRIPT_DIRS, `script-dir inventory changed: got [${dirs.join(', ')}]`);
    // No dir may be swallowed whole by the skip allowlist: each one must
    // contribute at least one file the repo-wide sweep actually reads.
    const swept = (path: string): boolean => !SWEEP_SKIP.some((re) => re.test(path));
    const fullySkipped = dirs.filter(
      (dir) => !files.some((file) => file.startsWith(`${dir}/`) && swept(file)),
    );
    // The single documented exception: the local Discord stand-in is skipped
    // repo-wide (its tokens are literally "mock") and gets its own sweep below.
    assert.deepEqual(
      fullySkipped,
      ['tools/mock-discord'],
      `fully-skipped script dirs: [${fullySkipped.join(', ')}]`,
    );
  },
);

test(
  'no token-shaped literal in any script-dir file, skipped or not',
  { skip: !isGitWorkTree() },
  () => {
    const token = sentinelToken();
    assert.match(token, PATTERNS[0]!.re, 'synthetic sentinel no longer matches discord-bot-token shape');
    const { files } = scriptInventory();
    const hits: string[] = [];
    for (const path of files) {
      let body: string;
      try {
        body = readFileSync(join(REPO, path), 'utf8');
      } catch {
        continue;
      }
      if (body.includes('\0')) continue;
      const rule = leakIn(body);
      if (rule) hits.push(`${path} (${rule})`);
    }
    assert.deepEqual(hits, [], `token-shaped literals in script dirs: ${hits.join(', ')}`);
  },
);

test(
  'no script-dir fixture carries a live or staging environment id',
  { skip: !isGitWorkTree() },
  async () => {
    // Source of truth, not a copy: if staging gains a new environment id, the
    // guard picks it up. spec.ts is side-effect-free consts (no imports).
    const spec = await import('../src/staging/spec.ts');
    const ENV_IDS: ReadonlyArray<{ name: string; id: string }> = [
      { name: 'LIVE_GUILD_ID', id: spec.LIVE_GUILD_ID },
      { name: 'LIVE_BOT_APPLICATION_ID', id: spec.LIVE_BOT_APPLICATION_ID },
      { name: 'STAGING_BOT_APPLICATION_ID', id: spec.STAGING_BOT_APPLICATION_ID },
      { name: 'TWO_STAGING_GUILD_ID', id: spec.TWO_STAGING_GUILD_ID },
      { name: 'FORMER_STAGING_BOT_APPLICATION_ID', id: spec.FORMER_STAGING_BOT_APPLICATION_ID },
    ];
    // Calibration, same discipline as the sentinel above: a non-snowflake id
    // would make every absence assertion below vacuous.
    for (const { name, id } of ENV_IDS) {
      assert.match(id, /^[0-9]{17,20}$/, `${name} is no longer a snowflake; the fixture guard below proves nothing`);
    }
    // Data files a script can be pointed at. Scripts (.ts/.sh) and docs (.md)
    // may legitimately name the ids they target or guard against — fixtures may
    // not, because a fixture is what turns "points at live" from a code-review
    // finding into a runtime fact.
    const isFixtureLike = (path: string): boolean =>
      path.includes('/fixtures/') || /\.(json|csv|ya?ml)$/.test(path);
    // The one intentional exception: the operator-owned AVC deployment
    // definition names the live guild it deploys into (see ops/auto-voice
    // README §6). Everything else under the script roots must be synthetic.
    const FIXTURE_LIVE_SKIP: ReadonlyArray<RegExp> = [/^ops\/auto-voice\/avc-config-.*\.json$/];
    const { files } = scriptInventory();
    const hits: string[] = [];
    for (const path of files) {
      if (!isFixtureLike(path)) continue;
      if (FIXTURE_LIVE_SKIP.some((re) => re.test(path))) continue;
      let body: string;
      try {
        body = readFileSync(join(REPO, path), 'utf8');
      } catch {
        continue;
      }
      if (body.includes('\0')) continue;
      const hit = ENV_IDS.find(({ id }) => body.includes(id));
      if (hit) hits.push(`${path} (${hit.name})`);
    }
    assert.deepEqual(hits, [], `live/staging ids in script-dir fixtures: ${hits.join(', ')}`);
  },
);
