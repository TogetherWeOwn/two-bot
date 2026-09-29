// Test-only preload, installed before the entrypoint or any Discord modules.
// Restrict the Node TCP transports used by pg, ws, HTTP(S), and undici to the
// two fixture endpoints. No hostname resolution, Unix sockets, UDP, or child
// processes. This is a regression guard, not a sandbox for hostile native code.
//
// TOG-9656: the database endpoint may be any isolated test host, not only
// loopback — the sanctioned agent-testdb sandbox must pass. This file is CJS
// loaded via --require before any TS runs, so it mirrors the allowlist in
// scripts/test-db-guard.ts as a literal (kept in sync by
// test/unit.rotaprocessguard.test.ts). The Discord API endpoint stays
// loopback-only: it is always the local mock server.
const net = require('node:net');
const dgram = require('node:dgram');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const ALLOWED_TEST_DB_HOSTS = new Set(['agent-testdb', '127.0.0.1', 'localhost', '::1', '[::1]', 'postgres']);
const api = new URL(process.env.DISCORD_API_BASE);
if (api.hostname !== '127.0.0.1' || !api.port) throw new Error('fixture endpoint must be explicit IPv4 loopback');
const endpoints = [{ host: api.hostname.toLowerCase(), port: Number(api.port) }];
const db = new URL(process.env.TWO_DATABASE_URL);
const dbHost = db.hostname.toLowerCase().replace(/\.$/, '');
if (!ALLOWED_TEST_DB_HOSTS.has(dbHost) || !db.port) {
  throw new Error('fixture database endpoint must be an isolated test host with an explicit port');
}
endpoints.push({ host: dbHost, port: Number(db.port) });
function refuse() {
  process.send?.({ kind: 'egress-refused' });
  throw new Error('rota fixture refused outbound transport');
}
const normHost = (host) => String(host ?? 'localhost').toLowerCase()
  .replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node's net.connect() forwards an already-normalized [options, callback].
  // This override fires before DNS lookup, so pg's hostname string
  // (e.g. 'agent-testdb') is still intact — exact host+port matching holds.
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === 'object' ? values[0]
    : { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
  const host = normHost(options.host);
  const ok = !options.path && endpoints.some(
    (endpoint) => normHost(endpoint.host) === host && Number(options.port) === endpoint.port,
  );
  if (!ok) refuse();
  return connect.apply(this, args);
};
dgram.createSocket = refuse;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = refuse;
syncBuiltinESMExports();
