/**
 * The container health endpoint (TOG-13).
 *
 * Coolify, like every container platform, decides whether a deploy succeeded by
 * polling an HTTP endpoint. The bot had nothing to poll: it is a gateway client
 * with no inbound surface, and the one listener it does have - the internal
 * actions endpoint - is a signed POST-only route bound to loopback, which is
 * exactly what a health probe must not be asked to authenticate against.
 *
 * So this is a second, deliberately tiny server. It answers two questions and
 * nothing else:
 *
 *   GET /healthz  liveness  - the process is up and the event loop turns.
 *   GET /readyz   readiness - the gateway is logged in AND the database answers.
 *
 * The split matters on a restart. A bot that is booting has a live process and
 * no gateway session; if the platform kills it for failing readiness during
 * that window it never finishes connecting, and Discord's identify budget pays
 * for the loop. Liveness must therefore stay dumb - it checks nothing it could
 * fail transiently - and readiness carries the real signal.
 *
 * Unlike the internal actions endpoint this DOES bind a routable address by
 * default, because the health check comes from outside the container. That is
 * safe only because the responses carry no configuration and no counts: `ok`,
 * or a reason string from a fixed set. Nothing here reads a secret, and no
 * response varies with one. See docs/DEPLOY.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from './log.ts';

/** Why readiness is refusing. A closed set - never an error string from below. */
export type NotReadyReason = 'gateway_disconnected' | 'database_unreachable';

export interface HealthProbes {
  /** True once discord.js holds a live gateway session. */
  gatewayReady(): boolean;
  /** Resolves true if the database answered. Must not throw. */
  databaseReady(): Promise<boolean>;
}

export interface HealthServerOptions extends HealthProbes {
  /** Default `0.0.0.0`: the probe arrives from outside the container. */
  host?: string;
  /** Default `8080`. */
  port?: number;
}

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

export interface ReadyResult {
  ready: boolean;
  reason?: NotReadyReason;
}

/**
 * Readiness in one place so it can be tested without a socket.
 *
 * The gateway is checked first and short-circuits: when the bot is not logged
 * in, the database question is noise, and on a cold start it would put a query
 * on the pool once a second for no reason.
 */
export async function evaluateReadiness(probes: HealthProbes): Promise<ReadyResult> {
  if (!probes.gatewayReady()) return { ready: false, reason: 'gateway_disconnected' };
  // databaseReady owns its own error handling and returns false rather than
  // throwing. Belt and braces here: an exception escaping this function would
  // become a 500, which reads to the platform as "broken" rather than "not
  // ready yet", and those are answered differently.
  let dbOk = false;
  try {
    dbOk = await probes.databaseReady();
  } catch {
    dbOk = false;
  }
  if (!dbOk) return { ready: false, reason: 'database_unreachable' };
  return { ready: true };
}

function send(res: ServerResponse, status: number, body: string): void {
  res
    .writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    .end(`${body}\n`);
}

async function handle(req: IncomingMessage, res: ServerResponse, probes: HealthProbes): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  const path = (req.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    send(res, 200, 'ok');
    return;
  }

  if (path === '/readyz') {
    const result = await evaluateReadiness(probes);
    // 503, not 500: this is "ask again shortly", which is what a rolling
    // deploy and a restart both need it to mean.
    if (result.ready) send(res, 200, 'ok');
    else send(res, 503, result.reason ?? 'not ready');
    return;
  }

  send(res, 404, 'not found');
}

export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port ?? 8080;

  const server: Server = createServer((req, res) => {
    void handle(req, res, opts).catch((err: unknown) => {
      // A probe that throws must not take the process down with it.
      log.error('health_request_failed', { err: String(err) });
      if (!res.headersSent) send(res, 500, 'error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  log.info('health_listening', { host, port: addr.port });

  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
