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
dns.lookup = refuseCallback;
dns.resolve = refuseCallback;
dns.promises.lookup = refuse;
dns.promises.resolve = refuse;
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
