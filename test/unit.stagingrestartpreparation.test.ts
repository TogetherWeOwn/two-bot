import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRestartSource, buildRestartEnvironment, type RestartEnvironmentInput } from '../src/staging/restartPreparation.ts';
import { STAGING_BOT_APPLICATION_ID, TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

const input: RestartEnvironmentInput = {
  mode: 'notice-on',
  discordToken: `${Buffer.from(STAGING_BOT_APPLICATION_ID).toString('base64')}.fixture.fixture`,
  databaseUrl: 'postgres://fixture:fixture@127.0.0.1:23456/staging_test',
  stagingDatabaseUrl: 'postgres://fixture:fixture@127.0.0.1:1/staging_binding',
  schema: 'test_restart_preparation',
  syntheticActorIds: '1545644954272137311',
  textChannelId: '1545644954272137333',
  voiceChannelId: '1545644954272137334',
  pseudonymKey: 'synthetic-only-key-for-local-preparation-tests',
  primaryActorId: '1545644954272137335',
  readerIds: '1545644954272137335',
  noticeChannelId: '1545644954272137336',
};
const refusal = { message: 'Staging restart environment refused; check explicit bindings.' };

test('restart environment has an exact allowlist, without ambient or extra-object controls', () => {
  const poison = {
    NODE_OPTIONS: '--import=secret-preload', CREDENTIALS_DIRECTORY: '/secret',
    HTTPS_PROXY: 'https://secret', HTTP_PROXY: 'http://secret', ALL_PROXY: 'http://secret',
    NODE_EXTRA_CA_CERTS: '/secret', PGHOST: 'secret', PGOPTIONS: '-c search_path=public',
    DISCORD_BOT_TOKEN: 'secret', DISCORD_API_BASE: 'https://secret',
    TWO_INTERNAL_ACTIONS: '1', PATH: '/secret', HOME: '/secret',
  };
  const before = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    const env = buildRestartEnvironment({ ...input, ...poison });
    assert.deepEqual(Object.keys(env).sort(), [
      'DISCORD_TOKEN', 'TWO_DATABASE_URL', 'TWO_STAGING_DATABASE_URL', 'PGOPTIONS',
      'DISCORD_GUILD_ID', 'DISCORD_STAGING_GUILD_ID', 'TWO_STAGING_RESTART_CONTAINMENT',
      'TWO_STAGING_RESTART_SYNTHETIC_ACTORS', 'TWO_COMMUNITY_STAGING_GUILD_IDS',
      'TWO_COMMUNITY_HUMAN_CHANNEL_IDS', 'TWO_ONBOARDING_MODE', 'DISCORD_LANDING_CHANNEL_IDS',
      'DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID', 'DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID',
      'TWO_ONBOARDING_ROTA_MEASUREMENT', 'TWO_ONBOARDING_ROTA_NOTICE',
      'TWO_ONBOARDING_ROTA_PSEUDONYM_KEY', 'TWO_ONBOARDING_ROTA_PRIMARY_ACTOR_ID',
      'TWO_ONBOARDING_ROTA_READER_IDS', 'DISCORD_STAFF_ALERT_CHANNEL_ID', 'TWO_HEALTH_PORT', 'LOG_LEVEL',
    ].sort());
    assert.ok(Object.isFrozen(env));
    assert.throws(() => Object.assign(env, { NODE_OPTIONS: '--import=secret-preload' }), TypeError);
    assert.equal(env.DISCORD_TOKEN, input.discordToken);
    assert.equal(env.PGOPTIONS, '-c search_path=test_restart_preparation');
    assert.equal(env.TWO_COMMUNITY_STAGING_GUILD_IDS, TWO_STAGING_GUILD_ID);
    assert.equal(env.TWO_STAGING_RESTART_CONTAINMENT, '1');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const [key, value] of Object.entries({
  mode: 'unknown', schema: 'public', discordToken: 'sensitive-value',
  databaseUrl: 'postgres://secret@127.0.0.1:5432/live?options=secret',
  stagingDatabaseUrl: 'sensitive-value', syntheticActorIds: 'sensitive-value',
  textChannelId: 'sensitive-value', voiceChannelId: 'sensitive-value',
  pseudonymKey: 'short-secret', primaryActorId: '', readerIds: '', noticeChannelId: 'sensitive-value',
})) {
  test(`restart environment refuses invalid ${key} without echoing input`, () => {
    assert.throws(() => buildRestartEnvironment({ ...input, [key]: value }), refusal);
  });
}

for (const schema of ['public,other', 'test_ok -c statement_timeout=0', 'test_x;DROP', 'test_']) {
  test(`restart environment refuses schema option injection ${JSON.stringify(schema)}`, () => {
    assert.throws(() => buildRestartEnvironment({ ...input, schema }), refusal);
  });
}

test('notice-off preserves measurement; master-off ignores stale rota dependencies only', () => {
  assert.equal(buildRestartEnvironment({ ...input, mode: 'notice-off' }).TWO_ONBOARDING_ROTA_MEASUREMENT, '1');
  assert.equal(buildRestartEnvironment({ ...input, mode: 'notice-off' }).TWO_ONBOARDING_ROTA_NOTICE, '0');
  const stale = { ...input, mode: 'master-off' as const, pseudonymKey: 'bad', primaryActorId: 'bad', readerIds: 'bad,bad', noticeChannelId: 'bad' };
  assert.equal(buildRestartEnvironment(stale).TWO_ONBOARDING_ROTA_MEASUREMENT, '0');
  assert.throws(() => buildRestartEnvironment({ ...stale, discordToken: 'bad' }), refusal);
  assert.throws(() => buildRestartEnvironment({ ...stale, syntheticActorIds: 'bad' }), refusal);
  assert.throws(() => buildRestartEnvironment({ ...stale, schema: 'public' }), refusal);
});

test('empty synthetic allowlist remains closed and NUL values never reach spawn', () => {
  assert.equal(buildRestartEnvironment({ ...input, syntheticActorIds: '' }).TWO_STAGING_RESTART_SYNTHETIC_ACTORS, '');
  assert.throws(() => buildRestartEnvironment({ ...input, pseudonymKey: `${input.pseudonymKey}\0` }), refusal);
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'restart-source-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString().trim();
  git('init', '--quiet');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/index.ts'), '// local fixture, not an application\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.env\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'local source fixture');
  return { root, git, sha: git('rev-parse', 'HEAD'), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('source pin accepts exact tracked bytes and excludes dependency attestation', () => {
  const repo = checkout();
  try {
    mkdirSync(join(repo.root, 'node_modules'));
    writeFileSync(join(repo.root, 'node_modules/fixture'), 'not attested by source check');
    assert.doesNotThrow(() => assertRestartSource(repo.root, repo.sha));
    for (const pin of [repo.sha.slice(0, 7), 'main', '0'.repeat(40), `${repo.sha}\n`]) {
      assert.throws(() => assertRestartSource(repo.root, pin), /source refused/);
    }
  } finally { repo.close(); }
});

for (const change of ['dirty', 'assume-unchanged', 'skip-worktree', 'staged', 'untracked', 'ignored-env', 'symlink', 'dependency-symlink', 'mode', 'extra-directory'] as const) {
  test(`source pin refuses ${change}`, () => {
    const repo = checkout();
    try {
      const entry = join(repo.root, 'src/index.ts');
      if (change === 'assume-unchanged' || change === 'skip-worktree') repo.git('update-index', `--${change}`, 'src/index.ts');
      if (['dirty', 'assume-unchanged', 'skip-worktree', 'staged'].includes(change)) writeFileSync(entry, '// changed\n');
      if (change === 'staged') repo.git('add', 'src/index.ts');
      if (change === 'untracked') writeFileSync(join(repo.root, 'src/untracked.ts'), '// extra\n');
      if (change === 'ignored-env') writeFileSync(join(repo.root, '.env'), 'PRIVATE_FIXTURE=not-a-secret\n');
      if (change === 'symlink') { rmSync(entry); symlinkSync('../package-lock.json', entry); }
      if (change === 'dependency-symlink') symlinkSync('src', join(repo.root, 'node_modules'));
      if (change === 'mode') chmodSync(entry, 0o755);
      if (change === 'extra-directory') mkdirSync(join(repo.root, 'extra'));
      assert.throws(() => assertRestartSource(repo.root, repo.sha), { message: 'Staging restart source refused; exact clean checkout required.' });
    } finally { repo.close(); }
  });
}
