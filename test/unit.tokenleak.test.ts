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
