export type DiscordJsonResult<T> = { status: number; body: T | null };

export interface DiscordRequestOptions {
  token: string;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

/**
 * Request JSON from Discord, obeying its rate-limit body without allowing one
 * bad response to park a verifier forever. `maxRetries` is retries after the
 * first request, so the default permits at most four requests. A 429 means the
 * request was not processed, so retrying is safe for every method the staging
 * verifier uses (GET plus its create/delete lifecycle probe).
 */
export async function requestDiscordJson<T>(
  url: string,
  options: DiscordRequestOptions,
): Promise<DiscordJsonResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const headers: Record<string, string> = { Authorization: `Bot ${options.token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined,
    });
    const body = (await response.json().catch(() => null)) as T | null;
    if (response.status !== 429 || attempt >= maxRetries) return { status: response.status, body };
    const retry = discordRetryAfterMs(response.headers, body, maxRetryAfterMs);
    console.log(`  ... Discord rate limited, retrying in ${retry}ms (${attempt + 1}/${maxRetries})`);
    await sleep(retry);
  }
}

export function discordRetryAfterMs(headers: Headers, body: unknown, maxRetryAfterMs: number): number {
  let seconds = Number(headers.get('retry-after') ?? '1');
  if (
    body &&
    typeof body === 'object' &&
    typeof (body as { retry_after?: unknown }).retry_after === 'number' &&
    Number.isFinite((body as { retry_after: number }).retry_after)
  ) {
    seconds = (body as { retry_after: number }).retry_after;
  }
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.min(Math.ceil(seconds * 1000) + 250, maxRetryAfterMs);
}
