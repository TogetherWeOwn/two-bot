import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALLOWED_TEST_DATABASE_HOSTS } from '../scripts/test-db-guard.ts';

const ROOT = resolve(import.meta.dirname, '..');

test('process guard intercepts all bot transports before socket I/O', { timeout: 10_000 }, async () => {
  // Replace the final socket connect first: even a broken guard cannot send a
  // probe outside this fixture. Client libraries must still traverse the guard.
  const source = String.raw`
    const assert = require('node:assert/strict');
    const net = require('node:net');
    let delegated = 0;
    net.Socket.prototype.connect = function () { delegated++; return this; };
    require('./test/helpers/rotaProcessGuard.cjs');
    const denied = /rota fixture refused outbound transport/;
    const options = { host: '203.0.113.1', port: 443 };
    assert.throws(() => net.connect(options), denied);
    assert.throws(() => new net.Socket().connect(443, '203.0.113.1'), denied);
    assert.throws(() => net.connect('/synthetic/socket'), denied);
    assert.throws(() => net.connect({ host: 'localhost', port: 32101 }), denied);
    assert.throws(() => net.connect({ host: '127.0.0.1', port: 32199 }), denied);
    assert.throws(() => require('node:tls').connect(options), denied);
    assert.throws(() => require('node:http').request('http://203.0.113.1/'), denied);
    assert.throws(() => require('node:https').request('https://203.0.113.1/'), denied);
    assert.throws(() => require('node:dgram').createSocket('udp4'), denied);
    assert.throws(() => require('node:child_process').spawn('synthetic-command'), denied);
    (async () => {
      await assert.rejects(new Promise((resolve, reject) => {
        const socket = new (require('ws'))('ws://203.0.113.1/');
        socket.on('error', reject);
        socket.on('open', resolve);
      }), denied);
      await assert.rejects(fetch('http://203.0.113.1/'), (error) => denied.test(String(error.cause)));
      await assert.rejects(require('undici').request('https://203.0.113.1/'), denied);
      assert.equal(delegated, 0, 'no forbidden client reached socket I/O');
      net.connect({ host: '127.0.0.1', port: 32101 });
      net.connect({ host: '127.0.0.1', port: 32102 });
      assert.equal(delegated, 2, 'only explicit fixture endpoints delegate');
      console.log('transport containment proved');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', source], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      DISCORD_API_BASE: 'http://127.0.0.1:32101/api',
      TWO_DATABASE_URL: 'postgres://synthetic@127.0.0.1:32102/fixture',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 7_000);
  try {
    const code = await new Promise<number | null>((res, rej) => {
      child.on('error', rej);
      child.on('close', res);
    });
    assert.equal(code, 0, output);
    assert.match(output, /transport containment proved/);
  } finally {
    clearTimeout(timer);
  }
});

test('TOG-9656: the preload database mirror matches the guard allowlist', () => {
  // The preload is CJS loaded via --require before any TS runs, so it carries
  // the allowlist as a literal. Parse that literal out of the source and pin
  // it against the single source of truth, so a drift fails here, not in a
  // hung e2e hours later.
  const source = readFileSync(join(ROOT, 'test/helpers/rotaProcessGuard.cjs'), 'utf8');
  const match = source.match(/ALLOWED_TEST_DB_HOSTS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'preload must declare its mirrored allowlist as ALLOWED_TEST_DB_HOSTS');
  const mirrored = new Set(
    [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  assert.deepEqual(mirrored, new Set(ALLOWED_TEST_DATABASE_HOSTS));
});

for (const dbHost of ['agent-testdb', 'postgres']) {
  test(`TOG-9656: the preload admits the isolated database host ${dbHost}`, () => {
    const run = spawnSync(
      process.execPath,
      ['-e', 'require("./test/helpers/rotaProcessGuard.cjs"); console.log("preload accepted")'],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          DISCORD_API_BASE: 'http://127.0.0.1:32101/api',
          TWO_DATABASE_URL: `postgres://synthetic@${dbHost}:32102/fixture`,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /preload accepted/);
  });
}

test('TOG-9656: the preload refuses a production database host', () => {
  const run = spawnSync(
    process.execPath,
    ['-e', 'require("./test/helpers/rotaProcessGuard.cjs")'],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        DISCORD_API_BASE: 'http://127.0.0.1:32101/api',
        TWO_DATABASE_URL: 'postgres://synthetic@db.internal:5432/fixture',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.status, 0, `preload exited 0: ${output.slice(0, 1000)}`);
  assert.match(output, /isolated test host/);
});

test('TOG-9740: the preload refuses a query-param host override on an allowlisted host', () => {
  // node-postgres promotes ?host= over the hostname, so the hostname check
  // alone would admit this URL. Only the query-string refusal can catch it.
  const run = spawnSync(
    process.execPath,
    ['-e', 'require("./test/helpers/rotaProcessGuard.cjs")'],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        DISCORD_API_BASE: 'http://127.0.0.1:32101/api',
        TWO_DATABASE_URL: 'postgres://synthetic@127.0.0.1:32102/fixture?host=db.internal',
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.notEqual(run.status, 0, `preload exited 0: ${output.slice(0, 1000)}`);
  assert.match(output, /query string/);
});
