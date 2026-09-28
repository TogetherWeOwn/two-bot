/**
 * The harness's own smoke probe (TOG-6497).
 *
 * `scripts/e2e-harness.ts --selftest` boots tools/mock-discord and runs one
 * canned probe against it: `GET <mock>/v10/gateway/bot` must answer 200 with a
 * gateway url. That proves the harness's dependency (the mock every staging
 * proof in docs/STAGING.md stands on) boots and speaks the REST shape the
 * probe expects, and proves nothing about live Discord.
 *
 * NO CREDENTIAL, NO LIVE DISCORD, NO WRITES. The probe is a single GET, so
 * even a `--selftest-base` pointed at the real API by mistake can only read
 * one public endpoint (which answers 401 without a token and becomes a named
 * `mock_probe_failed`, not traffic).
 *
 * A broken mock URL fails with a NAMED error, not a fetch stack: `fetch`
 * rejects on refused connections, wrong ports and unresolvable hosts alike,
 * and all of those mean the same thing here - the mock never answered - so
 * they all become `mock_unreachable`.
 */

export type SelftestErrorCode = 'mock_unreachable' | 'mock_probe_failed';

export class E2eSelftestError extends Error {
  readonly code: SelftestErrorCode;
  constructor(code: SelftestErrorCode, detail: string) {
    super(`e2e self-test failed (${code}): ${detail}`);
    this.name = 'E2eSelftestError';
    this.code = code;
  }
}

export interface SelftestProbeResult {
  /** The one canned probe this self-test runs. */
  probe: 'gateway-bot';
  apiBase: string;
  gatewayUrl: string;
}

/**
 * Run the canned probe against a mock REST base (e.g. `mock.apiBase`).
 * `fetchImpl` exists so tests can answer 500 without opening a socket.
 */
export async function runSelftestProbe(opts: {
  apiBase: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Promise<SelftestProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = `${opts.apiBase}/v10/gateway/bot`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new E2eSelftestError(
      'mock_unreachable',
      `GET ${url} never answered (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new E2eSelftestError('mock_probe_failed', `GET ${url} answered HTTP ${res.status}, want 200`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new E2eSelftestError('mock_probe_failed', `GET ${url} answered 200 with a body that is not JSON`);
  }
  const gatewayUrl = (body as { url?: unknown } | null)?.url;
  if (typeof gatewayUrl !== 'string' || gatewayUrl.length === 0) {
    throw new E2eSelftestError('mock_probe_failed', `GET ${url} answered 200 without a gateway url`);
  }
  return { probe: 'gateway-bot', apiBase: opts.apiBase, gatewayUrl };
}
