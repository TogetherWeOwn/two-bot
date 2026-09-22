import { setTimeout } from 'node:timers/promises';

/**
 * Proof-only transport: Discord 429 means the request was rejected, so it is
 * safe to retry after the advertised delay. Never retry network/5xx failures
 * (a write may already have happened), permission denials or malformed requests.
 * Does not change the production clients' retry policy or caller timeouts.
 */
export function proofDiscordFetch(options: {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  onRateLimit?: (ms: number) => void;
} = {}): typeof fetch {
  const request = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (async (ms, signal) => { await setTimeout(ms, undefined, { signal: signal ?? undefined }); });
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
      const response = await request(input, init);
      if (response.status !== 429 || attempt >= 2) return response;
      let seconds: unknown;
      try { seconds = (await response.clone().json() as { retry_after?: unknown }).retry_after; }
      catch { return response; }
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) return response;
      const ms = Math.ceil(seconds * 1000) + 250;
      options.onRateLimit?.(ms);
      await sleep(ms, signal);
    }
  };
}
