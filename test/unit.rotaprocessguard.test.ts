import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

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
