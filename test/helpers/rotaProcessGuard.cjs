// Test-only preload, installed before the entrypoint or any Discord modules.
// Restrict the Node TCP transports used by pg, ws, HTTP(S), and undici to the
// two fixture endpoints. No hostname resolution, Unix sockets, UDP, or child
// processes. This is a regression guard, not a sandbox for hostile native code.
const net = require('node:net');
const dgram = require('node:dgram');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const endpoints = [process.env.DISCORD_API_BASE, process.env.TWO_DATABASE_URL].map((raw) => {
  const url = new URL(raw);
  if (url.hostname !== '127.0.0.1' || !url.port) throw new Error('fixture endpoint must be explicit IPv4 loopback');
  return Number(url.port);
});
function refuse() {
  process.send?.({ kind: 'egress-refused' });
  throw new Error('rota fixture refused outbound transport');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node's net.connect() forwards an already-normalized [options, callback].
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === 'object' ? values[0]
    : { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
  if (options.path || options.host !== '127.0.0.1' || !endpoints.includes(Number(options.port))) refuse();
  return connect.apply(this, args);
};
dgram.createSocket = refuse;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = refuse;
syncBuiltinESMExports();
