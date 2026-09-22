/** Owned local PostgreSQL for restart preparation, NOT a staging launch permit.
 * Never adopts a URL, existing data directory or PID. Trusted local PostgreSQL
 * binaries are a separate tooling prerequisite. No Discord access occurs here.
 * The caller must stop application children before closing this storage lease.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

export interface RestartStorageOptions {
  /** Existing owner-only run scratch directory; never an existing PGDATA. */
  scratchDirectory: string;
  /** Trusted, preinstalled initdb/postgres directory. No automatic download. */
  postgresBinDirectory: string;
}

export interface OwnedRestartStorage {
  /** Recheck the child and cluster identity on every restart. Contains a secret;
   * pass directly to the environment builder, never log/serialize the result. */
  bindings(): Promise<Readonly<{ databaseUrl: string; schema: string }>>;
  /** Idempotent. Stops only the child we spawned, then removes only our directory.
   * A forced shutdown is a failed cleanup, even if escalation stops the child. */
  close(): Promise<void>;
}

const error = (stage: string) => new Error(`Staging restart storage refused (${stage}); details withheld.`);
const childEnv = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });

function refuseAmbientPostgres(): void {
  // node-postgres falls back to PG* for falsy options, including empty strings.
  // Reject before effects and immediately before each synchronous construction;
  // do not mutate the caller's environment or trust a bootstrap startup option.
  if (Object.keys(process.env).some((key) => key.startsWith('PG'))) throw error('ambient PostgreSQL controls');
}

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path ||
      !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw error('private directory');
  }
}

function observe(child: ChildProcess) {
  let ended = false;
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => { /* close follows error; never surface stderr/argv. */ });
    child.once('close', (code) => { ended = true; resolve(code); });
  });
  return { closed, ended: () => ended };
}

async function freePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw error('port');
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function stop(child: ChildProcess, lifecycle: ReturnType<typeof observe>): Promise<void> {
  if (lifecycle.ended()) return;
  child.kill('SIGINT'); // PostgreSQL fast shutdown: disconnect clients, then wait.
  const wait = (ms: number) => Promise.race([lifecycle.closed.then(() => true), delay(ms, false, { ref: false })]);
  if (await wait(10_000)) return;
  child.kill('SIGQUIT');
  if (!await wait(5_000) && !lifecycle.ended() && child.exitCode === null && child.signalCode === null && child.pid) {
    // Use the retained ChildProcess handle, not a raw PID/process-group signal.
    // Escalation is failed evidence, never a successful acceptance shutdown.
    child.kill('SIGKILL');
    if (!await wait(5_000)) throw error('cleanup incomplete');
  }
  throw error('forced shutdown');
}

/** Creates a fresh cluster, authenticates its private socket and checks its
 * data_directory/postmaster PID before any SQL mutation. TCP clients receive
 * only a generated, non-superuser role credential restricted by pg_hba.conf to
 * the generated database. Port reservation races fail startup, never adopt a DB.
 */
export async function createRestartStorage(options: RestartStorageOptions): Promise<OwnedRestartStorage> {
  let directory: string | undefined;
  let inode: { dev: number; ino: number } | undefined;
  let child: ChildProcess | undefined;
  let lifecycle: ReturnType<typeof observe> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let forced = false;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      if (child && lifecycle) {
        try { await stop(child, lifecycle); } catch { forced = true; }
        if (!lifecycle.ended()) throw error('cleanup incomplete');
      }
      if (directory && inode) {
        // Do not delete a substituted path, even after the child has stopped.
        await privateDirectory(directory);
        const stat = await lstat(directory);
        if (stat.dev !== inode.dev || stat.ino !== inode.ino) throw error('cleanup identity');
        await rm(directory, { recursive: true });
        directory = undefined;
      }
      if (forced) throw error('forced shutdown');
    })().catch(() => {
      // A transient removal/identity failure must not prevent a later cleanup
      // attempt. Forced shutdown remains a failure even if a retry removes data.
      closing = undefined;
      throw error('cleanup');
    });
    return closing;
  };
  try {
    refuseAmbientPostgres();
    await privateDirectory(options.scratchDirectory);
    const bin = options.postgresBinDirectory;
    if (!isAbsolute(bin) || await realpath(bin) !== bin) throw error('binaries');
    for (const name of ['initdb', 'postgres']) {
      const stat = await lstat(join(bin, name));
      if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw error('binaries');
    }
    directory = await mkdtemp(join(options.scratchDirectory, 'rs-'));
    inode = await lstat(directory);
    const data = join(directory, 'data');
    const socket = join(directory, 'socket');
    // Unix socket paths are bounded by sockaddr_un on Linux. Refuse, don't move
    // socket access outside the owner-only directory to work around the limit.
    if (Buffer.byteLength(join(socket, '.s.PGSQL.65535')) >= 104) throw error('socket path');
    await mkdir(socket, { mode: 0o700 });
    const init = spawn(join(bin, 'initdb'), ['-D', data, '-U', 'restart_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'],
      { cwd: directory, env: childEnv, stdio: 'ignore', detached: true });
    child = init;
    lifecycle = observe(init);
    const initResult = await Promise.race([lifecycle.closed, delay(30_000, 'timeout', { ref: false })]);
    if (initResult !== 0) throw error('initialization');
    const port = await freePort();
    const suffix = randomBytes(12).toString('hex');
    const database = `staging_restart_${suffix}`;
    const schema = `staging_restart_${suffix}`;
    const role = `restart_${suffix}`;
    const password = randomBytes(32).toString('hex');
    // These values also enter HBA records and DDL. Keep a checked alphabet even
    // if a future entropy encoding changes; none are caller-supplied identifiers.
    if (![database, schema, role].every((name) => /^[a-z_][a-z0-9_]{0,54}$/.test(name)) || !/^[a-f0-9]{64}$/.test(password)) throw error('generated binding');
    // Private socket bootstrap only; no TCP administrator, replication, other DB,
    // IPv6, or trust connection. Logs are suppressed rather than redacted later.
    await writeFile(join(data, 'pg_hba.conf'),
      `local all restart_admin trust\nhost ${database} ${role} 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n`, { mode: 0o600 });
    child = spawn(join(bin, 'postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port), '-k', socket,
      '-c', 'unix_socket_permissions=0700', '-c', 'password_encryption=scram-sha-256',
      '-c', 'logging_collector=off', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic'],
    { cwd: directory, env: childEnv, stdio: 'ignore', detached: true });
    lifecycle = observe(child);
    const running = () => {
      if (closed || !child?.pid || lifecycle?.ended() || child.exitCode !== null || child.signalCode !== null) throw error('child not running');
    };
    const connect = async (db: string, host = socket, user = 'restart_admin', pass = '') => {
      refuseAmbientPostgres();
      const client = new pg.Client({ host, port, database: db, user, password: pass,
        ssl: false, connectionTimeoutMillis: 1_000, query_timeout: 3_000,
        options: '', application_name: 'staging-restart-storage' });
      client.on('error', () => {}); // Session errors surface through operations.
      try { await client.connect(); return client; }
      catch { await client.end().catch(() => {}); throw error('connection'); }
    };
    const identity = async (client: pg.Client): Promise<void> => {
      running();
      const pid = (await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n');
      if (pid[0] !== String(child!.pid) || pid[1] !== data || pid[3] !== String(port) || pid[4] !== socket) throw error('cluster identity');
      const result = await client.query<{ directory: string }>("SELECT current_setting('data_directory') AS directory");
      if (result.rows[0]?.directory !== data) throw error('cluster identity');
    };
    // Retry private-socket readiness only; never test a supplied or ambient URL.
    let admin: pg.Client | undefined;
    const deadline = Date.now() + 10_000;
    while (!admin && Date.now() < deadline) {
      running();
      try { admin = await connect('postgres'); } catch { await delay(50); }
    }
    if (!admin) throw error('readiness');
    try {
      await identity(admin);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
      await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      // Existing applyWebContract issues CREATE SCHEMA IF NOT EXISTS each boot;
      // PostgreSQL requires database CREATE even when the schema already exists.
      // This does not grant CREATEDB or any privilege on another database.
      await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${role}`);
      await admin.query(`ALTER ROLE ${role} IN DATABASE ${database} SET search_path TO ${schema}`);
    } finally { await admin.end(); }
    const bootstrap = await connect(database);
    try {
      await identity(bootstrap);
      await bootstrap.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await bootstrap.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
      await bootstrap.query(`CREATE SCHEMA ${schema}_web_v1 AUTHORIZATION ${role}`);
    } finally { await bootstrap.end(); }
    const databaseUrl = `postgres://${role}:${password}@127.0.0.1:${port}/${database}`;
    const bindings = async () => {
      try {
        running();
        const check = await connect(database);
        try { await identity(check); } finally { await check.end(); }
        // Prove that the loopback port leads to our restricted database, not a
        // competing listener, and that a missing schema cannot fall back public.
        const app = await connect(database, '127.0.0.1', role, password);
        try {
          const { rows } = await app.query<{ db: string; schema: string; superuser: string; public_write: boolean }>(
            "SELECT current_database() AS db, current_schema() AS schema, current_setting('is_superuser') AS superuser, has_schema_privilege(current_user, 'public', 'CREATE') AS public_write");
          if (rows[0]?.db !== database || rows[0]?.schema !== schema || rows[0]?.superuser !== 'off' || rows[0]?.public_write !== false) throw error('role isolation');
        } finally { await app.end(); }
        running();
        return Object.freeze({ databaseUrl, schema });
      } catch { throw error('lease verification'); }
    };
    await bindings();
    return Object.freeze({ bindings, close });
  } catch {
    try { await close(); } catch { throw error('setup and cleanup'); }
    throw error('setup');
  }
}
