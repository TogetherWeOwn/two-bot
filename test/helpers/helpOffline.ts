/** Preloaded only by the help-catalog test: no sockets or subprocesses. */
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

let attemptedIO = false;
function refuse(): never {
  attemptedIO = true;
  throw new Error('--help must not open a connection or run a subprocess');
}

const refuseCallback = Object.assign(refuse, { __promisify__: refuse });

net.Socket.prototype.connect = refuse;
net.Server.prototype.listen = refuse;
tls.connect = refuse;
dgram.Socket.prototype.connect = refuse;
dgram.Socket.prototype.send = refuse;
// bind() on an owned loopback listener succeeds without connect/send, and
// createSocket alone hands out a live socket, so refuse both as well.
dgram.createSocket = refuse;
dgram.Socket.prototype.bind = refuse;
// c-ares resolution does not go through the net/dgram JavaScript methods.
// Cover record-specific APIs and both Resolver classes, not just resolve().
const dnsQueries = [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
];
for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const method of dnsQueries) {
    if (typeof Reflect.get(api, method) === 'function') Reflect.set(api, method, refuseCallback);
  }
}
http.request = refuse;
http.get = refuse;
https.request = refuse;
https.get = refuse;
globalThis.fetch = refuse;
childProcess.spawn = refuse;
childProcess.spawnSync = refuse;
childProcess.exec = refuseCallback;
childProcess.execSync = refuse;
childProcess.execFile = refuseCallback;
childProcess.execFileSync = refuse;
childProcess.fork = refuse;
syncBuiltinESMExports();

// A script must not turn a caught I/O refusal into a successful help response.
process.once('exit', () => {
  if (attemptedIO) process.exitCode = 97;
});
