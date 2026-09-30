import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bootstrap = join(import.meta.dirname, '..', 'scripts', 'bootstrap-host.sh');
const databaseUrl = 'postgres://agent_test@agent-testdb:5432/two_bot_test_tog10235';

// Run the real command, not an extracted copy of its secrets loop. PATH contains
// only read-only utilities and stubs: no sudo, package install, network request,
// ownership change, systemd write or Discord preflight can reach the host.
const commandStub = `#!${process.execPath}
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.BOOTSTRAP_CALLS, JSON.stringify({ command, args }) + '\\n');
switch (command) {
  case 'id': console.log('0'); break;
  case 'node': console.log(args[1].includes('split') ? '24' : '24.0.0'); break;
  case 'rsync': {
    const source = args.at(-2);
    const destination = resolve(args.at(-1), 'src', 'core');
    if (!destination.startsWith(resolve(process.env.BOOTSTRAP_ROOT) + sep)) process.exit(98);
    mkdirSync(destination, { recursive: true });
    copyFileSync(join(source, 'src', 'core', 'credentials.ts'), join(destination, 'credentials.ts'));
    break;
  }
  case 'chown': case 'sudo': break;
  case 'systemctl':
    if (args.join(' ') !== 'daemon-reload') process.exit(98);
    break;
  case 'systemd-run': {
    if (!args.includes('--input-type=module')) process.exit(79); // Offline Discord preflight sentinel.
    const root = resolve(process.env.BOOTSTRAP_ROOT);
    const envFile = join(root, 'env', 'two-bot.env');
    const credentials = join(root, 'env', 'credentials');
    const app = join(root, 'app');
    for (const required of [
      '--uid=offline-fixture',
      '--property=EnvironmentFile=' + envFile,
      '--property=LoadCredential=database_url:' + join(credentials, 'database_url'),
      '--property=LoadCredential=internal_keys:' + join(credentials, 'internal_keys'),
      '--working-directory=' + app,
    ]) {
      if (!args.includes(required)) process.exit(98);
    }
    // Inject the literal fixture assignments only. This is not a systemd parser;
    // the production command delegates EnvironmentFile parsing to systemd itself.
    const result = spawnSync(process.execPath, args.slice(args.indexOf('--input-type=module')), {
      cwd: app,
      env: { ...parseEnv(readFileSync(envFile, 'utf8')), CREDENTIALS_DIRECTORY: credentials },
      encoding: 'utf8',
    });
    if (result.error) process.exit(98);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 98);
  }
  case 'install': {
    let directory = false;
    let mode = 0o755;
    const paths = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') directory = true;
      else if (args[i] === '-o' || args[i] === '-g') i++;
      else if (args[i] === '-m') mode = parseInt(args[++i], 8);
      else if (args[i].startsWith('-')) process.exit(98);
      else paths.push(args[i]);
    }
    const destination = paths.at(-1);
    // Unit installation is recorded but never writes to the real systemd tree.
    if (destination === '/etc/systemd/system/' && !directory) break;
    const root = resolve(process.env.BOOTSTRAP_ROOT) + sep;
    const targets = directory ? paths : [destination];
    for (const target of targets) {
      if (!resolve(target).startsWith(root)) process.exit(98);
      if (directory) mkdirSync(target, { recursive: true, mode });
      else if (paths[0] === '/dev/null') writeFileSync(target, '');
      else copyFileSync(paths[0], target);
      chmodSync(target, mode);
    }
    break;
  }
  default: process.exit(98);
}
`;

function fixture() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'bootstrap-credentials-'));
  const bin = join(root, 'bin');
  const envDir = join(root, 'env');
  const credentials = join(envDir, 'credentials');
  const callsFile = join(root, 'calls.jsonl');
  mkdirSync(bin);
  mkdirSync(credentials, { recursive: true });
  writeFileSync(callsFile, '');
  const stub = join(bin, 'stub.mjs');
  writeFileSync(stub, commandStub, { mode: 0o755 });
  for (const name of ['id', 'node', 'rsync', 'chown', 'sudo', 'systemctl', 'systemd-run', 'install', 'curl', 'apt-get', 'useradd']) {
    symlinkSync(stub, join(bin, name));
  }
  for (const name of ['dirname', 'ls', 'grep', 'cat']) {
    symlinkSync(`/usr/bin/${name}`, join(bin, name));
  }
  const files = {
    token: join(credentials, 'discord_token'),
    database: join(credentials, 'database_url'),
    internal: join(credentials, 'internal_keys'),
    staging: join(credentials, 'discord_staging_token'),
    env: join(envDir, 'two-bot.env'),
    backup: join(envDir, 'backup.env'),
  };
  writeFileSync(files.token, 'offline-token-fixture\n');
  writeFileSync(files.database, databaseUrl + '\n');
  writeFileSync(files.internal, 'offline-signing-key-fixture\n');
  writeFileSync(files.staging, 'offline-staging-token-fixture\n');
  writeFileSync(files.env, `TWO_INTERNAL_ACTIONS=0\nTWO_DATABASE_URL=${databaseUrl}\n`);
  writeFileSync(files.backup, `TWO_DATABASE_URL=${databaseUrl}\nTWO_BACKUP_UPLOAD_CMD=/offline/upload\n`);
  return {
    files,
    run() {
      writeFileSync(callsFile, '');
      const result = spawnSync('/bin/bash', [bootstrap], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: bin,
          LC_ALL: 'C',
          BOOTSTRAP_ROOT: root,
          BOOTSTRAP_CALLS: callsFile,
          TWO_APP_USER: 'offline-fixture',
          TWO_APP_DIR: join(root, 'app'),
          TWO_ENV_DIR: envDir,
          TWO_BACKUP_DIR: join(root, 'backups'),
          TWO_UPLOAD_CMD: join(root, 'upload', 'two-backup-upload'),
        },
      });
      assert.ifError(result.error);
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map((line) =>
        JSON.parse(line) as { command: string; args: string[] });
      return { ...result, calls };
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

type BootstrapResult = ReturnType<ReturnType<typeof fixture>['run']>;

function pastSecrets(result: BootstrapResult) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /== Preflight/);
  assert.match(result.stderr, /preflight failed \(exit 79\)/);
  assert.doesNotMatch(result.stdout, /Secrets files are empty/);
  assert.equal(result.calls.filter((call) => call.command === 'systemd-run' &&
    !call.args.includes('--input-type=module')).length, 1);
  assert.ok(result.calls.filter((call) => call.command === 'systemctl').every((call) =>
    call.args.join(' ') === 'daemon-reload'), 'no service should be started');
}

function stoppedAtSecrets(result: BootstrapResult) {
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /Secrets files are empty/);
  assert.ok(!result.calls.some((call) => call.command === 'systemctl' ||
    (call.command === 'systemd-run' && !call.args.includes('--input-type=module'))));
  assert.doesNotMatch(result.stdout, /== Preflight/);
}

describe('bootstrap optional credentials (offline command harness)', () => {
  for (const optional of ['internal', 'database'] as const) {
    test(`existing empty ${optional} credential passes the secrets gate on repeated runs`, () => {
      const f = fixture();
      try {
        writeFileSync(f.files[optional], '');
        const before = statSync(f.files[optional]);
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = f.run();
          pastSecrets(result);
          assert.ok(!result.calls.some((call) => call.command === 'install' && call.args.includes(f.files[optional])));
          assert.equal(readFileSync(f.files[optional], 'utf8'), '');
          assert.equal(statSync(f.files[optional]).mtimeMs, before.mtimeMs);
        }
      } finally { f.close(); }
    });
  }

  test('both optional credentials may stay empty with internal actions disabled and an env-backed DB', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.internal, '');
      writeFileSync(f.files.database, '');
      const envBefore = readFileSync(f.files.env);
      pastSecrets(f.run());
      assert.deepEqual(readFileSync(f.files.env), envBefore);
    } finally { f.close(); }
  });

  test('empty database credential without an env fallback still stops before preflight', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.database, '');
      writeFileSync(f.files.env, 'TWO_INTERNAL_ACTIONS=0\n');
      stoppedAtSecrets(f.run());
      stoppedAtSecrets(f.run());
      assert.equal(readFileSync(f.files.database, 'utf8'), '');
    } finally { f.close(); }
  });

  test('empty signing credential with internal actions enabled and no fallback still stops before preflight', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.internal, '');
      writeFileSync(f.files.env, `TWO_INTERNAL_ACTIONS=1\nTWO_DATABASE_URL=${databaseUrl}\n`);
      stoppedAtSecrets(f.run());
      stoppedAtSecrets(f.run());
      assert.equal(readFileSync(f.files.internal, 'utf8'), '');
    } finally { f.close(); }
  });

  test('empty signing credential can use signing-key fallback when actions are enabled', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.internal, '');
      writeFileSync(f.files.env, `TWO_INTERNAL_ACTIONS=1\nTWO_INTERNAL_KEYS=offline:${'x'.repeat(32)}\n`);
      pastSecrets(f.run());
      pastSecrets(f.run());
      assert.equal(readFileSync(f.files.internal, 'utf8'), '');
    } finally { f.close(); }
  });

  test('populated credentials do not require env fallbacks when actions are enabled', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.internal, `offline:${'x'.repeat(32)}\n`);
      writeFileSync(f.files.env, 'TWO_INTERNAL_ACTIONS=1\n');
      const before = readFileSync(f.files.internal);
      pastSecrets(f.run());
      assert.deepEqual(readFileSync(f.files.internal), before);
    } finally { f.close(); }
  });

  test('a quoted empty database fallback still stops before preflight', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.database, '');
      writeFileSync(f.files.env, 'TWO_INTERNAL_ACTIONS=0\nTWO_DATABASE_URL=""\n');
      stoppedAtSecrets(f.run());
    } finally { f.close(); }
  });

  test('a quoted enabled flag with empty signing-key fallback still stops before preflight', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.internal, '');
      writeFileSync(f.files.env, 'TWO_INTERNAL_ACTIONS="1"\nTWO_INTERNAL_KEYS=""\n');
      stoppedAtSecrets(f.run());
    } finally { f.close(); }
  });

  for (const state of ['missing', 'empty'] as const) {
    test(`${state} mandatory token still stops before preflight`, () => {
      const f = fixture();
      try {
        if (state === 'missing') rmSync(f.files.token);
        else writeFileSync(f.files.token, '');
        stoppedAtSecrets(f.run());
        stoppedAtSecrets(f.run());
      } finally { f.close(); }
    });
  }

  test('empty required backup.env still stops before preflight', () => {
    const f = fixture();
    try {
      writeFileSync(f.files.backup, '');
      stoppedAtSecrets(f.run());
      stoppedAtSecrets(f.run());
    } finally { f.close(); }
  });

  test('a missing optional file is created once and keeps the first-run setup stop', () => {
    const f = fixture();
    try {
      rmSync(f.files.database);
      rmSync(f.files.internal);
      stoppedAtSecrets(f.run());
      for (const name of ['database', 'internal'] as const) {
        assert.equal(readFileSync(f.files[name], 'utf8'), '');
        assert.equal(statSync(f.files[name]).mode & 0o777, 0o600);
      }
      pastSecrets(f.run());
    } finally { f.close(); }
  });

  test('nonempty existing credential and configuration files remain byte-identical', () => {
    const f = fixture();
    try {
      const before = Object.values(f.files).map((path) => ({ path, bytes: readFileSync(path) }));
      pastSecrets(f.run());
      for (const file of before) assert.deepEqual(readFileSync(file.path), file.bytes, file.path);
    } finally { f.close(); }
  });
});
