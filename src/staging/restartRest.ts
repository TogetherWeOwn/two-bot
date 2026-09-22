/** Application HTTP boundary for contained restarts, not an egress sandbox.
 * Only startup identity/gateway reads are permitted; no simulated successes.
 * Raw sockets, uninjected HTTP clients and gateway frames remain separate gates.
 */

const REFUSAL = 'Staging restart REST request refused.';
const READ_PATHS = ['/gateway/bot', '/users/@me'];
const HEADERS = new Set(['authorization', 'user-agent', 'content-type', 'accept']);

/** Exact canonical URLs only. The explicit loopback API is the existing local
 * mock fixture seam, never part of buildRestartEnvironment's allowlist.
 */
export function restartRestBase(api = 'https://discord.com/api'): string {
  try {
    const url = new URL(api);
    const discord = api === 'https://discord.com/api';
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      Boolean(url.port) && url.pathname === '/api' && url.href === api;
    if (!discord && !local) throw new Error();
    return `${api}/v10`;
  } catch { throw new Error(REFUSAL); }
}

/** One policy for discord.js's makeRequest and explicitly injected raw clients.
 * Reject Request/URL objects rather than normalize away their original spelling.
 * Copy only supported fetch options: never forward dispatcher, agent, credentials,
 * method-override headers or caller redirect policy. The delegate is a trusted
 * transport/test seam, not caller-controlled configuration.
 */
// discord.js and Node use different undici declaration versions. Treat incoming
// headers/body/method as untrusted; the native Headers constructor validates the
// header shape at runtime before the transport can be called.
type RestartRequest = { method?: unknown; headers?: unknown; body?: unknown; signal?: AbortSignal | null };

export function createRestartFetch(api?: string, transport: typeof fetch = fetch):
  (input: unknown, init?: RestartRequest) => Promise<Response> {
  const allowed = new Set(READ_PATHS.map((path) => `${restartRestBase(api)}${path}`));
  return async (input, init) => {
    try {
      if (typeof input !== 'string' || !allowed.has(input) ||
          init?.method !== undefined && init.method !== 'GET' || init?.body != null) throw new Error();
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      for (const name of headers.keys()) if (!HEADERS.has(name)) throw new Error();
      const response = await transport(input, {
        method: 'GET', headers, signal: init?.signal, redirect: 'error',
      });
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error();
      }
      return response;
    } catch {
      // URLs, headers, tokens and delegate errors must never reach diagnostics.
      throw new Error(REFUSAL);
    }
  };
}
